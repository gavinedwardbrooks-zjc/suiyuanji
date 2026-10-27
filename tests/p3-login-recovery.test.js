// ============================================================
// tests/p3-login-recovery.test.js · V1.1 P3.0 登录异常恢复
//
// 旧缺陷：whenReady 轮询 openid，8 秒后只 clearInterval，回调永远不执行，
//         页面永久停在 pending，用户没有任何自救入口。
//
// 覆盖：
//   A 成功 / 失败 / 超时的状态机与快照
//   B whenReady 语义不变（只在拿到 openid 时回调）与等待者上限
//   C 重试：新请求、成功后等待者可被唤醒、失败不会自动循环
//   D 并发与乱序：并发只发一次；旧请求晚到不得覆盖新身份
//   E 页面接线：pending 错误态 + 重试入口 + 无 setInterval 轮询
//
// 运行：node tests/p3-login-recovery.test.js
// ============================================================
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const APP_PATH = path.join(ROOT, 'app.js')

let passed = 0, failed = 0, failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name) })
    .catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message) })
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a))
}
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8') }
// 去注释后再做「不得出现」断言：注释里提到旧实现不算残留代码
function codeOf(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

// ---------------- 假定时器（只替换 setTimeout，用于触发 8s 超时）----------------
const realSetTimeout = global.setTimeout
const realClearTimeout = global.clearTimeout
let timers = []

function fakeTimersOn() {
  timers = []
  global.setTimeout = (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t }
  global.clearTimeout = (t) => { if (t) t.cleared = true }
}
function fakeTimersOff() {
  global.setTimeout = realSetTimeout
  global.clearTimeout = realClearTimeout
}
function firePendingTimers() {
  const list = timers.filter(t => !t.cleared)
  for (const t of list) { t.cleared = true; t.fn() }
}
const tick = () => new Promise(r => realSetTimeout(r, 0))

// ---------------- 载入 app.js 配置 ----------------
let appCfg = null
function loadAppConfig() {
  if (appCfg) return appCfg
  global.App = (cfg) => { appCfg = cfg }
  delete require.cache[APP_PATH]
  require(APP_PATH)
  return appCfg
}

function makeApp(handler) {
  const cfg = loadAppConfig()
  const inst = {}
  for (const k of Object.keys(cfg)) inst[k] = cfg[k]
  inst.globalData = Object.assign({}, cfg.globalData)
  inst._loginState = 'idle'
  inst._loginError = ''
  inst._loginEpoch = 0
  inst._loginTimer = null
  inst._loginInflight = null
  inst._loginWaiters = []
  const calls = []
  global.wx = {
    cloud: {
      init() {},
      callFunction: (args) => { calls.push(args); return handler(args, calls.length) }
    }
  }
  inst.__calls = calls
  return inst
}

function deferred() {
  let resolve, reject
  const p = new Promise((res, rej) => { resolve = res; reject = rej })
  return { p, resolve, reject }
}

async function main() {
  console.log('\n=== P3.0 登录异常恢复 ===\n')
  fakeTimersOn()

  // ---------------- A. 状态机 ----------------
  await testCase('A1 登录成功 → ready + openid 落地 + 等待者被唤醒', async () => {
    const app = makeApp(() => Promise.resolve({
      result: { openid: 'OPENID_A', role: 'her', coupleId: 'CZ-1', nickName: '她', partnerName: '小胖', avatarUrl: '' }
    }))
    let fired = null
    app.whenReady(g => { fired = g })
    await app.silentLogin()
    assertEq(app.loginSnapshot().state, 'ready')
    assertEq(app.loginSnapshot().ok, true)
    assertEq(app.globalData.openid, 'OPENID_A')
    assertEq(app.globalData.role, 'her')
    assertEq(app.globalData.coupleId, 'CZ-1')
    assertEq(app.globalData.partnerName, '小胖')
    assertOk(fired, 'whenReady 必须被唤醒')
    assertEq(fired.openid, 'OPENID_A')
    assertEq(app.__calls.length, 1)
  })

  await testCase('A2 登录明确失败（网络异常）→ failed + 不伪造身份 + 不回调等待者', async () => {
    const app = makeApp(() => Promise.reject(new Error('network down')))
    let fired = false
    app.whenReady(() => { fired = true })
    await app.silentLogin()
    const snap = app.loginSnapshot()
    assertEq(snap.state, 'failed')
    assertEq(snap.error, 'network')
    assertEq(snap.canRetry, true)
    assertEq(app.globalData.openid, null, '失败不得伪造 openid')
    assertEq(fired, false, '失败时 whenReady 不应回调（页面走错误态）')
  })

  await testCase('A3 返回里没有 openid → 视为失败（no_openid），不进入 ready', async () => {
    const app = makeApp(() => Promise.resolve({ result: { ok: false, role: 'her' } }))
    await app.silentLogin()
    assertEq(app.loginSnapshot().state, 'failed')
    assertEq(app.loginSnapshot().error, 'no_openid')
    assertEq(app.globalData.openid, null)
  })

  await testCase('A4 超时 → timeout 态（可重试），openid 仍为空、等待者不回调', async () => {
    const d = deferred()
    const app = makeApp(() => d.p)
    let fired = false
    app.whenReady(() => { fired = true })
    app.silentLogin()
    await tick()
    assertEq(app.loginSnapshot().state, 'loading')
    firePendingTimers()       // 触发 8s 超时
    const snap = app.loginSnapshot()
    assertEq(snap.state, 'timeout')
    assertEq(snap.canRetry, true)
    assertEq(snap.ok, false)
    assertEq(app.globalData.openid, null)
    assertEq(fired, false)
  })

  await testCase('A5 超时后那次请求其实成功了 → 升级为 ready（真实结果，不是延时兜底）', async () => {
    const d = deferred()
    const app = makeApp(() => d.p)
    let fired = 0
    app.whenReady(() => { fired++ })
    app.silentLogin()
    await tick()
    firePendingTimers()
    assertEq(app.loginSnapshot().state, 'timeout')
    d.resolve({ result: { openid: 'LATE_OK', role: 'her', coupleId: null } })
    await tick()
    await tick()
    assertEq(app.loginSnapshot().state, 'ready')
    assertEq(app.globalData.openid, 'LATE_OK')
    assertEq(fired, 1, '迟到的真实成功仍应唤醒等待者')
  })

  await testCase('A6 没有云能力（wx.cloud 缺失）→ 直接进入可重试的失败态', async () => {
    const app = makeApp(() => Promise.resolve({ result: {} }))
    global.wx = {}
    app.onLaunch()
    assertEq(app.loginSnapshot().state, 'failed')
    assertEq(app.loginSnapshot().error, 'no_cloud')
  })

  // ---------------- B. whenReady 语义 ----------------
  await testCase('B1 已登录时 whenReady 立即同步回调（既有页面行为不变）', async () => {
    const app = makeApp(() => Promise.resolve({ result: { openid: 'X', role: 'her', coupleId: null } }))
    await app.silentLogin()
    let called = 0
    app.whenReady(g => { called++; assertEq(g.openid, 'X') })
    assertEq(called, 1)
  })

  await testCase('B2 等待者上限 20：超出的按「丢弃最早」处理，不会无限堆积', async () => {
    const app = makeApp(() => Promise.resolve({ result: { openid: 'Y', role: 'her', coupleId: null } }))
    const called = []
    for (let i = 0; i < 25; i++) app.whenReady(() => called.push(i))
    assertEq(app._loginWaiters.length, 20)
    await app.silentLogin()
    assertEq(called.length, 20)
    assertEq(called[0], 5, '最早的 5 个被丢弃')
    assertEq(app._loginWaiters.length, 0, '唤醒后必须清空，避免重复回调')
  })

  await testCase('B3 单个等待者抛错不影响其他等待者', async () => {
    const app = makeApp(() => Promise.resolve({ result: { openid: 'Z', role: 'her', coupleId: null } }))
    let second = false
    app.whenReady(() => { throw new Error('boom') })
    app.whenReady(() => { second = true })
    await app.silentLogin()
    assertEq(second, true)
  })

  // ---------------- C. 重试 ----------------
  await testCase('C1 失败后重试成功 → ready，且此前登记的等待者被唤醒一次', async () => {
    let n = 0
    const app = makeApp(() => {
      n++
      if (n === 1) return Promise.reject(new Error('fail once'))
      return Promise.resolve({ result: { openid: 'RETRY_OK', role: 'him', coupleId: 'CZ-9' } })
    })
    let fired = 0
    app.whenReady(() => { fired++ })
    await app.silentLogin()
    assertEq(app.loginSnapshot().state, 'failed')
    await app.retryLogin()
    assertEq(app.loginSnapshot().state, 'ready')
    assertEq(app.globalData.openid, 'RETRY_OK')
    assertEq(app.globalData.coupleId, 'CZ-9')
    assertEq(fired, 1, '重试成功后旧等待者应被唤醒一次（不重复）')
    assertEq(app.__calls.length, 2)
  })

  await testCase('C2 重试失败 → 仍是 failed，不自动再次发起（没有无限重试）', async () => {
    const app = makeApp(() => Promise.reject(new Error('still down')))
    app.silentLogin()
    await tick(); await tick()
    app.retryLogin()
    await tick(); await tick()
    await tick()
    assertEq(app.loginSnapshot().state, 'failed')
    assertEq(app.__calls.length, 2, '只能有「初次 + 一次手动重试」，不得自行循环')
  })

  await testCase('C3 已登录后再调用 silentLogin = 主动刷新（不会被去重逻辑吞掉）', async () => {
    let n = 0
    const app = makeApp(() => {
      n++
      return Promise.resolve({ result: { openid: 'SAME', role: 'her', coupleId: n === 1 ? 'CZ-1' : 'CZ-2' } })
    })
    await app.silentLogin()
    assertEq(app.globalData.coupleId, 'CZ-1')
    await app.silentLogin()
    assertEq(app.__calls.length, 2, '刷新必须真的重新请求身份')
    assertEq(app.globalData.coupleId, 'CZ-2')
  })

  // ---------------- D. 并发与乱序 ----------------
  await testCase('D1 并发调用只发一次请求，两个调用方拿到同一个结果', async () => {
    const d = deferred()
    const app = makeApp(() => d.p)
    const p1 = app.silentLogin()
    const p2 = app.silentLogin()
    await tick()
    assertEq(app.__calls.length, 1, '并发登录必须复用同一个在途请求')
    d.resolve({ result: { openid: 'ONE', role: 'her', coupleId: null } })
    const [r1, r2] = await Promise.all([p1, p2])
    assertEq(r1.state, 'ready')
    assertEq(r2.state, 'ready')
  })

  await testCase('D2 旧请求晚于新请求返回 → 丢弃旧身份，绝不覆盖', async () => {
    const d1 = deferred()
    const d2 = deferred()
    const app = makeApp((args, n) => (n === 1 ? d1.p : d2.p))
    app.silentLogin()          // 第 1 次（旧）
    await tick()
    app.retryLogin()           // 第 2 次（新）
    await tick()
    assertEq(app.__calls.length, 2)

    d2.resolve({ result: { openid: 'NEW_IDENTITY', role: 'him', coupleId: 'CZ-NEW' } })
    await tick(); await tick()
    assertEq(app.globalData.openid, 'NEW_IDENTITY')

    d1.resolve({ result: { openid: 'OLD_IDENTITY', role: 'her', coupleId: 'CZ-OLD' } })
    await tick(); await tick()
    assertEq(app.globalData.openid, 'NEW_IDENTITY', '旧请求不得覆盖新身份')
    assertEq(app.globalData.role, 'him')
    assertEq(app.globalData.coupleId, 'CZ-NEW')
    assertEq(app.loginSnapshot().state, 'ready')
  })

  await testCase('D3 旧请求的失败晚到 → 不得把已经是 ready 的状态改成 failed', async () => {
    const d1 = deferred()
    const d2 = deferred()
    const app = makeApp((args, n) => (n === 1 ? d1.p : d2.p))
    app.silentLogin()
    await tick()
    app.retryLogin()
    await tick()
    d2.resolve({ result: { openid: 'WINNER', role: 'her', coupleId: null } })
    await tick(); await tick()
    d1.reject(new Error('late failure'))
    await tick(); await tick()
    assertEq(app.loginSnapshot().state, 'ready')
    assertEq(app.globalData.openid, 'WINNER')
  })

  await testCase('D4 旧超时定时器不会把新一次尝试判死（定时器按 epoch 对齐）', async () => {
    const d1 = deferred()
    const d2 = deferred()
    const app = makeApp((args, n) => (n === 1 ? d1.p : d2.p))
    app.silentLogin()
    await tick()
    const firstTimer = timers.filter(t => !t.cleared)[0]
    app.retryLogin()                 // 新尝试：旧定时器应被清掉
    await tick()
    assertOk(firstTimer && firstTimer.cleared, '开始新尝试时必须清掉旧超时定时器')
    firePendingTimers()              // 只可能触发新尝试的定时器
    assertEq(app.loginSnapshot().state, 'timeout', '新尝试自己超时')
    d2.resolve({ result: { openid: 'AFTER', role: 'her', coupleId: null } })
    await tick(); await tick()
    assertEq(app.loginSnapshot().state, 'ready')
  })

  // ---------------- E. 静态接线 ----------------
  await testCase('E1 app.js 不再用 setInterval 轮询、不再只清定时器不回调', async () => {
    const src = codeOf(read('app.js'))
    assertEq(src.indexOf('setInterval'), -1, '旧轮询实现必须彻底移除')
    assertOk(src.indexOf('LOGIN_TIMEOUT') !== -1, '必须有明确的超时状态')
    assertOk(src.indexOf('_flushLoginWaiters') !== -1, '必须有唤醒等待者的实现')
    assertOk(src.indexOf('retryLogin') !== -1)
  })

  await testCase('E2 首页 / 记录页：pending 里给出失败文案 + 重试入口（不用定时器伪装成功）', async () => {
    for (const [js, wxml] of [['pages/home/home.js', 'pages/home/home.wxml'], ['pages/record/record.js', 'pages/record/record.wxml']]) {
      const j = read(js)
      const w = read(wxml)
      assertOk(j.indexOf('onLoginRetry') !== -1, js + ' 缺重试处理')
      assertOk(j.indexOf('loginSnapshot') !== -1, js + ' 缺登录状态快照')
      assertOk(w.indexOf('onLoginRetry') !== -1, wxml + ' 缺重试入口')
      assertOk(w.indexOf("loginState === 'timeout'") !== -1, wxml + ' 未区分超时态')
      // 重试必须唯一，且只能由用户点击触发（不得放进定时器里自动循环）
      assertEq(j.split('app.retryLogin()').length - 1, 1, js + ' 重试调用应唯一（用户触发）')
      assertOk(!/setTimeout\s*\((?:(?!\).*setTimeout)[\s\S]){0,160}retryLogin/.test(j),
        js + ' 不得把重试放进定时器（不能靠延时反复自动重试）')
    }
  })

  await testCase('E3 其他依赖 whenReady 的页面仍然可用（语义未被破坏）', async () => {
    for (const rel of ['pages/mine/mine.js', 'pages/ours/ours.js']) {
      const src = read(rel)
      assertOk(src.indexOf('app.whenReady(') !== -1, rel + ' 仍应使用 whenReady')
    }
    const app = makeApp(() => Promise.resolve({ result: { openid: 'OTHER', role: 'her', coupleId: null } }))
    let got = null
    app.whenReady(g => { got = g })   // 模拟 ours/mine 的用法（只传一个回调）
    await app.silentLogin()
    assertEq(got.openid, 'OTHER')
  })

  fakeTimersOff()
  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    console.log('\n失败用例:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('P3 Login Recovery: ALL GREEN')
}

main().catch(e => { fakeTimersOff(); console.error(e); process.exit(1) })
