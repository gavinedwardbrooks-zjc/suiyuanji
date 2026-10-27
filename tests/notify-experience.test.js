// ============================================================
// tests/notify-experience.test.js · 通知体验优化（阶段 8）
//
// 本轮不是重做通知系统，只修「体验与合规」上的四处真实缺口：
//   1. 订阅结果只认 accept，把 ban / filter / fail 一律说成「已取消」（U、V 组）
//   2. 心愿通知借用「聊天消息通知」模板，用途未确认 → 默认 fail-closed（W 组）
//   3. 「我们」页只给 her 标记已读，him 侧未读角标永远清不掉（X 组）
//   4. 次数文案声称「可收 N 次」，在微信没有余额查询接口的前提下过于确定（V9）
//
// 分组：
//   U · 订阅结果矩阵与话术（纯模块 utils/subscribe-feedback.js）
//   V · 「我们」页运行时：授权结果处理、文案、一次性语义
//   W · 心愿 / 悄悄话服务端：用途闸门、幂等、额度、失败降级
//   X · 站内未读：服务端真值、身份校验、与微信通知解耦
//   Y · 经期提醒：09:00、0~2 天窗口、同日一次、dryRun 默认只读
//   Z · 兼容与静态约束（旧客户端 / 旧云函数 / 无自动弹窗 / 无私自改集合）
//
// 红线：不使用真实微信账号、不发送真实推送、不触碰真实数据库。
//
// 运行：node tests/notify-experience.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const fs = require('fs')
const { MockDB } = require('./mock-db')

const ROOT = path.resolve(__dirname, '..')
const NOTIFY_PATH = path.join(ROOT, 'cloudfunctions/getPartnerView/notify.js')
const SUBUI_PATH = path.join(ROOT, 'utils/subscribe-feedback.js')
const OURS_PATH = path.join(ROOT, 'pages/ours/ours.js')
const CAL_PATH = path.join(ROOT, 'pages/calendar/calendar.js')

const SUBUI = require(SUBUI_PATH)
const NOTIFY = require(NOTIFY_PATH)
const TPL_CHAT = NOTIFY.DEFAULT_TEMPLATES.chat
const TPL_PERIOD = NOTIFY.DEFAULT_TEMPLATES.period

let passed = 0, failed = 0
const failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++
    console.log('  PASS  ' + name)
  }).catch(e => {
    failed++
    failures.push(name + ': ' + e.message)
    console.log('  FAIL  ' + name + '  -> ' + e.message)
  })
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a))
}
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }
function assertNo(hay, needle, msg) {
  if (String(hay).indexOf(needle) !== -1) throw new Error((msg || '') + ' 不应包含 ' + needle)
}

function quota(chat, period) {
  return { chat: chat || 0, period: period || 0, tpl: { chat: TPL_CHAT, period: TPL_PERIOD } }
}

function seed(extra) {
  return new MockDB(Object.assign({
    users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', nickName: '安安', subQuota: quota(0, 1) },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', subQuota: quota(2, 1) }
    ],
    couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'active', anniversary: null }],
    daily_records: [],
    wishes: [],
    messages: [],
    menstrual: []
  }, extra))
}

function mockCloud(opts) {
  const o = opts || {}
  const calls = []
  return {
    calls,
    openapi: {
      subscribeMessage: {
        send: async (params) => {
          calls.push(params)
          if (o.throwErr) {
            const e = new Error(o.throwErr.errMsg || 'send failed')
            e.errCode = o.throwErr.errCode
            throw e
          }
          return { errCode: 0 }
        }
      }
    }
  }
}

function loadCloudFn(name, db, state) {
  const origLoad = Module._load
  Module._load = function (request) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test',
        init() {},
        database: () => db,
        getWXContext: () => ({ OPENID: state.openid }),
        openapi: state.cloud.openapi
      }
    }
    return origLoad.apply(this, arguments)
  }
  const fnPath = path.join(ROOT, 'cloudfunctions', name, 'index.js')
  delete require.cache[fnPath]
  let mod
  try {
    mod = require(fnPath)
  } finally {
    Module._load = origLoad
  }
  return mod
}

function clearEnv() {
  delete process.env.TPL_CHAT
  delete process.env.TPL_PERIOD
  delete process.env.WISH_NOTIFY
  delete process.env.NOTIFY_NAME
  delete process.env.MP_STATE
}

// ------------------------------------------------------------
// 页面运行时替身（ours / calendar 共用）
// ------------------------------------------------------------
function loadPage(opts) {
  const o = opts || {}
  let pageDef = null
  const toasts = []
  const modals = []
  const subs = []
  const cloudCalls = []
  let subHandler = null

  const cfgPath = path.join(ROOT, 'config.js')
  delete require.cache[cfgPath]
  const CONFIG = require(cfgPath)
  const savedChat = CONFIG.SUB_TPL_CHAT
  const savedPeriod = CONFIG.SUB_TPL_PERIOD
  CONFIG.SUB_TPL_CHAT = o.tplChat === undefined ? 'TPL_CHAT_T' : o.tplChat
  CONFIG.SUB_TPL_PERIOD = o.tplPeriod === undefined ? 'TPL_PERIOD_T' : o.tplPeriod

  global.getApp = () => ({
    globalData: { openid: 'A', role: o.role || 'him', bindCode: null },
    whenReady: (cb) => cb({ openid: 'A' }),
    silentLogin() {}
  })
  global.Page = (def) => { pageDef = def }
  global.wx = global.wx || {}
  global.wx.getStorageSync = () => o.storageSeen || 0
  global.wx.setStorageSync = () => {}
  global.wx.removeStorageSync = () => {}
  global.wx.showToast = (x) => toasts.push(x.title)
  global.wx.showModal = (x) => modals.push(x)
  global.wx.requestSubscribeMessage = (x) => { subs.push(x.tmplIds); if (subHandler) subHandler(x) }
  global.wx.switchTab = () => {}
  global.wx.navigateTo = () => {}
  global.wx.cloud = {
    callFunction({ name, data }) {
      cloudCalls.push({ name, data })
      if (o.onCall) {
        const r = o.onCall(name, data)
        if (r !== undefined) return Promise.resolve(r)
      }
      return Promise.resolve({ result: { ok: true, quota: { chat: 1, period: 1 } } })
    }
  }

  const pagePath = o.page === 'calendar' ? CAL_PATH : OURS_PATH
  delete require.cache[pagePath]
  delete require.cache[SUBUI_PATH]
  require(pagePath)

  const p = Object.create(pageDef)
  p.data = JSON.parse(JSON.stringify(pageDef.data))
  p.setData = function (patch) { Object.assign(this.data, patch) }

  return {
    page: p,
    toasts,
    modals,
    subs,
    cloudCalls,
    setSubHandler(fn) { subHandler = fn },
    cleanup() {
      CONFIG.SUB_TPL_CHAT = savedChat
      CONFIG.SUB_TPL_PERIOD = savedPeriod
    }
  }
}

// ==================== U. 订阅结果矩阵 ====================
async function runMatrixTests() {
  console.log('\n=== U · 订阅结果矩阵与话术 ===\n')

  await testCase('U1 accept → 「已记 1 次提醒」，不出现「永久」', async () => {
    const f = SUBUI.subFeedback('accept')
    assertEq(f.type, 'toast')
    assertOk(/1\s*次/.test(f.title), '应明确是 1 次额度: ' + f.title)
    assertNo(f.title, '永久')
    assertNo(f.title, '已开启')
  })

  await testCase('U2 reject → 明确「不影响」，且不发请求记账（页面侧另测）', async () => {
    const f = SUBUI.subFeedback('reject')
    assertEq(f.type, 'toast')
    assertOk(f.title.indexOf('不影响') !== -1, '用户需要知道拒绝没有副作用: ' + f.title)
  })

  await testCase('U3 ban → 弹窗指路去设置，不当作「已取消」', async () => {
    const f = SUBUI.subFeedback('ban')
    assertEq(f.type, 'modal', 'ban 需要解释，不能用一句 toast 打发')
    assertOk(/设置/.test(f.content), '必须告诉用户去哪里改: ' + f.content)
    assertNo(f.content, '永久')
  })

  await testCase('U4 filter → 说明是模板被平台过滤，不是用户的选择', async () => {
    const f = SUBUI.subFeedback('filter')
    assertEq(f.type, 'modal')
    assertOk(/模板/.test(f.content), '应指出是模板问题: ' + f.content)
    assertNo(f.title, '取消')
  })

  await testCase('U5 未知值 / 缺字段 → 「没有开启成功」，绝不乐观当成 accept', async () => {
    assertEq(SUBUI.subResultOf({}, TPL_CHAT), 'unknown')
    assertEq(SUBUI.subResultOf(null, TPL_CHAT), 'unknown')
    assertEq(SUBUI.subResultOf({ [TPL_CHAT]: 'whatever' }, TPL_CHAT), 'unknown')
    assertEq(SUBUI.subResultOf({ other: 'accept' }, TPL_CHAT), 'unknown')
    const f = SUBUI.subFeedback('unknown')
    assertEq(f.type, 'toast')
    assertOk(f.title.indexOf('没有开启成功') !== -1, '不得暗示成功: ' + f.title)
  })

  await testCase('U6 四种结果的文案两两不同（不允许塌缩成一句话）', async () => {
    const seen = {}
    for (const k of ['accept', 'reject', 'ban', 'filter']) {
      const f = SUBUI.subFeedback(k)
      const key = f.type + '|' + f.title
      assertOk(!seen[key], '文案重复: ' + k + ' 与 ' + seen[key])
      seen[key] = k
    }
  })

  await testCase('U7 fail 20004 → 指向微信「消息通知」总开关', async () => {
    const f = SUBUI.subFailFeedback('requestSubscribeMessage:fail 20004')
    assertEq(f.type, 'modal')
    assertOk(/消息通知/.test(f.content), '应指路: ' + f.content)
  })

  await testCase('U8 fail 10003 / 20001~20003 → 模板配置问题，不甩锅给用户', async () => {
    for (const code of [10003, 20001, 20002, 20003]) {
      const f = SUBUI.subFailFeedback('fail errCode: ' + code)
      assertEq(f.type, 'modal', code + ' 应弹窗')
      assertOk(/模板/.test(f.content), code + ' 应指出模板问题: ' + f.content)
    }
  })

  await testCase('U9 fail 10002 → 网络问题；其余 → 通用', async () => {
    assertOk(/网络/.test(SUBUI.subFailFeedback('fail 10002').title), '10002 应为网络提示')
    const g = SUBUI.subFailFeedback('fail -1')
    assertEq(g.type, 'toast')
    assertOk(g.title.indexOf('没有开启成功') !== -1)
    assertEq(SUBUI.subFailFeedback('').type, 'toast')
  })

  await testCase('U10 所有话术里都没有「永久」「每月自动」这类做不到的承诺', async () => {
    const pool = ['accept', 'reject', 'ban', 'filter', 'unknown']
      .map(k => SUBUI.subFeedback(k))
      .concat([20004, 10003, 10002, -1, 0].map(c => SUBUI.subFailFeedback('fail ' + c)))
    const text = pool.map(f => (f.title || '') + ' ' + (f.content || '')).join(' | ')
    assertNo(text, '永久')
    assertNo(text, '每月自动')
  })
}

// ==================== V. 「我们」页运行时 ====================
async function runOursRuntimeTests() {
  console.log('\n=== V · 「我们」页：授权结果处理与文案 ===\n')

  await testCase('V1 accept → 上报 chat 一次，额度 +1', async () => {
    const h = loadPage({ role: 'him' })
    h.setSubHandler(o => o.success({ TPL_CHAT_T: 'accept' }))
    h.page.notifySub()
    await new Promise(r => setTimeout(r, 10))
    const sub = h.cloudCalls.filter(c => c.data && c.data.action === 'sub')
    assertEq(sub.length, 1)
    assertEq(JSON.stringify(sub[0].data.granted), JSON.stringify(['chat']))
    assertEq(h.page.data.myQuotaTotal, 1)
    h.cleanup()
  })

  await testCase('V2 reject → 不记账，提示不影响', async () => {
    const h = loadPage({ role: 'him' })
    h.setSubHandler(o => o.success({ TPL_CHAT_T: 'reject' }))
    h.page.notifySub()
    await new Promise(r => setTimeout(r, 10))
    assertEq(h.cloudCalls.filter(c => c.data && c.data.action === 'sub').length, 0)
    assertOk(h.toasts.some(t => t.indexOf('不影响') !== -1), '应说明不影响')
    h.cleanup()
  })

  await testCase('V3 ban → 不记账 + 弹窗（旧实现会误报「已取消」）', async () => {
    const h = loadPage({ role: 'him' })
    h.setSubHandler(o => o.success({ TPL_CHAT_T: 'ban' }))
    h.page.notifySub()
    await new Promise(r => setTimeout(r, 10))
    assertEq(h.cloudCalls.filter(c => c.data && c.data.action === 'sub').length, 0, 'ban 不应记账')
    assertEq(h.modals.length, 1, 'ban 必须弹窗解释')
    assertOk(/设置/.test(h.modals[0].content))
    h.cleanup()
  })

  await testCase('V4 filter → 不记账 + 弹窗说明模板被过滤', async () => {
    const h = loadPage({ role: 'him' })
    h.setSubHandler(o => o.success({ TPL_CHAT_T: 'filter' }))
    h.page.notifySub()
    await new Promise(r => setTimeout(r, 10))
    assertEq(h.cloudCalls.filter(c => c.data && c.data.action === 'sub').length, 0)
    assertEq(h.modals.length, 1)
    assertOk(/模板/.test(h.modals[0].content))
    h.cleanup()
  })

  await testCase('V5 fail 20004 → 不记账 + 弹窗指路', async () => {
    const h = loadPage({ role: 'him' })
    h.setSubHandler(o => o.fail({ errMsg: 'requestSubscribeMessage:fail 20004' }))
    h.page.notifySub()
    assertEq(h.modals.length, 1)
    assertOk(/消息通知/.test(h.modals[0].content))
    h.cleanup()
  })

  await testCase('V6 accept 但服务端未记账（旧云函数）→ 不谎报，额度仍为 0', async () => {
    const h = loadPage({
      role: 'him',
      onCall: (name, data) => (data && data.action === 'sub' ? { result: { ok: false, code: 'BAD_ACTION' } } : undefined)
    })
    h.setSubHandler(o => o.success({ TPL_CHAT_T: 'accept' }))
    h.page.notifySub()
    await new Promise(r => setTimeout(r, 10))
    assertEq(h.page.data.myQuotaTotal, 0, '服务端没记账就不能显示额度')
    assertOk(h.toasts.some(t => t.indexOf('未成功') !== -1), '必须如实说记录未成功: ' + h.toasts.join('/'))
    h.cleanup()
  })

  await testCase('V7 连续点击只申请一次（_subbing 挡住并发）', async () => {
    const h = loadPage({ role: 'him' })
    h.setSubHandler(() => {})
    h.page.notifySub()
    h.page.notifySub()
    assertEq(h.subs.length, 1)
    h.cleanup()
  })

  await testCase('V8 「总是保持以上选择」语义：两次 accept = 2 次额度，不是永久授权', async () => {
    const h = loadPage({ role: 'him' })
    let n = 0
    // 勾选「总是保持」后微信不再弹窗，直接返回 accept —— 但仍是一次性额度
    h.setSubHandler(o => { n++; o.success({ TPL_CHAT_T: 'accept' }) })
    h.setSubHandler(o => { n++; o.success({ TPL_CHAT_T: 'accept' }) })
    h.page.notifySub()
    await new Promise(r => setTimeout(r, 10))
    h.page.notifySub()
    await new Promise(r => setTimeout(r, 10))
    const subs = h.cloudCalls.filter(c => c.data && c.data.action === 'sub')
    assertEq(subs.length, 2, '每次 accept 都要各自记账（一次授权只能发一条）')
    assertOk(h.page.data.notifyHint.indexOf('永久') === -1, '不得声称永久')
    h.cleanup()
  })

  await testCase('V9 次数文案：说明是服务端记账，不声称微信给出的剩余额度', async () => {
    const h = loadPage({ role: 'him' })
    const hint = h.page.buildNotifyHint({ chat: 3 })
    assertOk(hint.indexOf('3') !== -1, '应显示记账次数: ' + hint)
    assertOk(/服务端记账/.test(hint), '必须说明次数来源: ' + hint)
    // V1.1 UI 精简：一次性 / 用完再开启 的说明收拢到卡片底部唯一那一行，
    // 保证点从 hint 移到静态文案上（仍是「页面必须告诉用户还要再开启一次」）。
    const wxml = fs.readFileSync(path.join(ROOT, 'pages/ours/ours.wxml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    assertOk(/再次开启|再点一次/.test(wxml), '页面必须说明用完要重新开启')
    assertNo(hint, '可收', '不得声称「可收 N 次」这种像微信余额的说法')
    assertNo(hint, '永久', '不得承诺永久')
    h.cleanup()
  })

  await testCase('V10 心愿未开闸时，文案不承诺「加心愿也会提醒你」', async () => {
    const on = loadPage({ role: 'him' })
    on.page.setData({ wishNotify: true })
    const withWish = on.page.buildNotifyHint({ chat: 0 })
    assertOk(withWish.indexOf('心愿') !== -1, '开闸后可以承诺: ' + withWish)
    on.cleanup()

    const off = loadPage({ role: 'him' })
    off.page.setData({ wishNotify: false })
    const noWish = off.page.buildNotifyHint({ chat: 0 })
    assertOk(noWish.indexOf('悄悄话') !== -1, '未开闸时只承诺悄悄话: ' + noWish)
    assertNo(noWish, '心愿', '未开闸却承诺心愿会被提醒，就是假承诺')
    off.cleanup()
  })
}

// ==================== W. 心愿 / 悄悄话服务端 ====================
async function runServerNoticeTests() {
  console.log('\n=== W · 心愿 / 悄悄话：用途闸门、幂等、额度、降级 ===\n')
  clearEnv()

  await testCase('W1 心愿通知默认被「模板用途闸门」拦下：不发、不扣额度、写 skipped', async () => {
    const db = seed()
    const cloud = mockCloud()
    const mod = loadCloudFn('dailyRecord', db, { openid: 'A', cloud })
    const r = await mod.main({ action: 'save', date: '2026-10-17', revision: 0, requestId: 'r1', wishes: [{ type: 'eat', text: '火锅' }] })
    assertEq(r.ok, true, '业务必须成功')
    assertEq(r.wishNotifySent, false)
    assertEq(r.wishNotifyReason, 'wish_template_purpose_unverified')
    assertEq(cloud.calls.length, 0, '用途未确认时绝不能触碰微信接口')
    const w = db.dump().wishes[0]
    assertEq(w.createdNotifySkipped, true, '必须留下「没发」的痕迹，不能无痕')
    assertEq(db.dump().users[1].subQuota.chat, 2, '没发就不能扣接收者额度')
  })

  await testCase('W2 WISH_NOTIFY=on 也不能绕过闸门（环境变量不是合规证明）', async () => {
    for (const v of ['on', 'ON', 'true', '1', 'yes']) {
      process.env.WISH_NOTIFY = v
      const db = seed()
      const cloud = mockCloud()
      const mod = loadCloudFn('dailyRecord', db, { openid: 'A', cloud })
      const r = await mod.main({ action: 'save', date: '2026-10-17', revision: 0, requestId: 'r2-' + v, wishes: [{ type: 'eat', text: '火锅' }] })
      assertEq(r.ok, true, v + ' 业务仍要成功')
      assertEq(r.wishNotifySent, false, 'WISH_NOTIFY=' + v + ' 必须仍然被拦下')
      assertEq(r.wishNotifyReason, 'wish_template_purpose_unverified', 'WISH_NOTIFY=' + v)
      assertEq(cloud.calls.length, 0, 'WISH_NOTIFY=' + v + ' 不得触碰微信接口')
    }
    delete process.env.WISH_NOTIFY
  })

  await testCase('W3 悄悄话不受用途闸门影响（它本来就是聊天消息）', async () => {
    delete process.env.WISH_NOTIFY
    const db = seed()
    const cloud = mockCloud()
    const mod = loadCloudFn('getPartnerView', db, { openid: 'A', cloud })
    const r = await mod.main({ action: 'msg', text: '想你了', requestId: 'q1' })
    assertEq(r.ok, true)
    assertEq(r.notifySent, true, 'reason=' + r.notifyReason)
    assertEq(cloud.calls.length, 1)
    assertEq(cloud.calls[0].touser, 'B')
  })

  await testCase('W4 两个业务都真的调用了通知逻辑（静态守卫，防止只修一个）', async () => {
    const dr = fs.readFileSync(path.join(ROOT, 'cloudfunctions/dailyRecord/index.js'), 'utf8')
    const gp = fs.readFileSync(path.join(ROOT, 'cloudfunctions/getPartnerView/index.js'), 'utf8')
    assertOk(/notifyNewWishes\(/.test(dr), 'dailyRecord 必须调用心愿通知')
    assertOk(/sendCoupleNotice\(\{[\s\S]*?kind:\s*'wish'/.test(dr), '心愿事件必须以 kind=wish 走通知')
    assertOk(/sendCoupleNotice\(\{[\s\S]*?kind:\s*'msg'/.test(gp), '悄悄话事件必须以 kind=msg 走通知')
  })

  await testCase('W5 心愿重复保存 → 只落一条，且不会重复尝试通知', async () => {
    const db = seed()
    const cloud = mockCloud()
    const mod = loadCloudFn('dailyRecord', db, { openid: 'A', cloud })
    await mod.main({ action: 'save', date: '2026-10-17', revision: 0, requestId: 'a1', wishes: [{ type: 'eat', text: '火锅' }] })
    await mod.main({ action: 'save', date: '2026-10-17', revision: 1, requestId: 'a2', wishes: [{ type: 'eat', text: '火锅' }] })
    assertEq(db.dump().wishes.length, 1, '不得重复建心愿')
    assertEq(cloud.calls.length, 0, '心愿通知被闸门拦下，任何时候都不该有微信调用')
  })

  await testCase('W6 悄悄话同 requestId 重试 → 只落一条、只通知一次', async () => {
    const db = seed()
    const cloud = mockCloud()
    const mod = loadCloudFn('getPartnerView', db, { openid: 'A', cloud })
    await mod.main({ action: 'msg', text: '晚安', requestId: 'same' })
    const r2 = await mod.main({ action: 'msg', text: '晚安', requestId: 'same' })
    assertEq(r2.idempotent, true)
    assertEq(db.dump().messages.length, 1)
    assertEq(cloud.calls.length, 1, '重试不得再发一条')
  })

  await testCase('W7 接收方没有额度 → 不调用微信接口（no_quota）', async () => {
    const db = seed({ users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', subQuota: quota(0, 0) },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', subQuota: quota(0, 0) }
    ] })
    const cloud = mockCloud()
    const mod = loadCloudFn('getPartnerView', db, { openid: 'A', cloud })
    const r = await mod.main({ action: 'msg', text: '在吗', requestId: 'nq' })
    assertEq(r.ok, true, '业务照常成功')
    assertEq(r.notifySent, false)
    assertEq(r.notifyReason, 'no_quota')
    assertEq(cloud.calls.length, 0)
  })

  await testCase('W8 发送报 43101（未授权/已用完）→ 额度归零，业务不失败', async () => {
    const db = seed()
    const cloud = mockCloud({ throwErr: { errCode: 43101, errMsg: 'user refuse to accept the msg' } })
    const mod = loadCloudFn('getPartnerView', db, { openid: 'A', cloud })
    const r = await mod.main({ action: 'msg', text: '在吗', requestId: 'np' })
    assertEq(r.ok, true)
    assertEq(r.notifySent, false)
    assertEq(r.notifyReason, 'no_permission')
    assertEq(db.dump().users[1].subQuota.chat, 0, '微信说没授权就该归零，避免继续无效尝试')
    assertEq(db.dump().messages.length, 1, '留言必须已保存')
  })

  await testCase('W9 解绑（couples 非 active）→ 业务与通知一起停，不发给旧伴侣', async () => {
    const db = seed({ couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'superseded' }] })
    const cloud = mockCloud()
    const mod = loadCloudFn('getPartnerView', db, { openid: 'A', cloud })
    const r = await mod.main({ action: 'msg', text: '还在吗', requestId: 'ub' })
    assertEq(r.ok, false)
    assertEq(r.code, 'NOT_ACTIVE', '关系失效后前端一律拿到 NOT_ACTIVE')
    assertEq(cloud.calls.length, 0, '不得给旧伴侣发通知')
  })

  await testCase('W10 发送抛异常 → 悄悄话照常保存成功（通知是旁路）', async () => {
    const db = seed()
    const cloud = mockCloud({ throwErr: { errCode: -1, errMsg: 'system busy' } })
    const mod = loadCloudFn('getPartnerView', db, { openid: 'A', cloud })
    let threw = false
    let r
    try { r = await mod.main({ action: 'msg', text: '在吗', requestId: 'ex' }) } catch (e) { threw = true }
    assertOk(!threw, '通知异常不得冒泡')
    assertEq(r.ok, true)
    assertEq(r.notifySent, false)
    assertEq(db.dump().messages.length, 1, '留言必须已保存')
  })

  await testCase('W11 通知内容不含心愿/悄悄话原文（隐私）', async () => {
    const db = seed()
    const cloud = mockCloud()
    const mod = loadCloudFn('getPartnerView', db, { openid: 'A', cloud })
    await mod.main({ action: 'msg', text: '这是不该出现在通知里的原文', requestId: 'pv' })
    const payload = JSON.stringify(cloud.calls[0].data)
    assertNo(payload, '这是不该出现在通知里的原文')
    delete process.env.WISH_NOTIFY
  })
}

// ==================== X. 站内未读 ====================
async function runUnreadTests() {
  console.log('\n=== X · 站内未读：服务端真值 + 身份校验 ===\n')
  clearEnv()

  await testCase('X1 未读条数来自服务端真值（不是本地存储）', async () => {
    const db = seed({ messages: [
      { _id: 'm1', coupleId: 'CZ-1', fromOpenid: 'A', fromRole: 'her', text: '在吗', readAt: null, createdAt: 1 },
      { _id: 'm2', coupleId: 'CZ-1', fromOpenid: 'B', fromRole: 'him', text: '在', readAt: null, createdAt: 2 }
    ] })
    const mod = loadCloudFn('getPartnerView', db, { openid: 'B', cloud: mockCloud() })
    const r = await mod.main({})
    assertEq(r.unreadMsgs, 1, '只算「对方发给我且我没读」的那条')
  })

  await testCase('X2 发送者不能把自己的消息标成已读（updated=0）', async () => {
    const db = seed({ messages: [
      { _id: 'm1', coupleId: 'CZ-1', fromOpenid: 'A', fromRole: 'her', text: '在吗', readAt: null, createdAt: 1 }
    ] })
    const mod = loadCloudFn('getPartnerView', db, { openid: 'A', cloud: mockCloud() })
    const r = await mod.main({ action: 'readMsg', msgId: 'm1' })
    assertEq(r.updated, 0, '自己发的消息不该被自己标记已读')
    assertEq(db.dump().messages[0].readAt, null)
  })

  await testCase('X3 接收方标记已读是一次性原子写（重复标记 updated=0）', async () => {
    const db = seed({ messages: [
      { _id: 'm1', coupleId: 'CZ-1', fromOpenid: 'A', fromRole: 'her', text: '在吗', readAt: null, createdAt: 1 }
    ] })
    const mod = loadCloudFn('getPartnerView', db, { openid: 'B', cloud: mockCloud() })
    const r1 = await mod.main({ action: 'readMsg', msgId: 'm1' })
    assertEq(r1.updated, 1)
    const r2 = await mod.main({ action: 'readMsg', msgId: 'm1' })
    assertEq(r2.updated, 0, '已读只能写第一次')
  })

  await testCase('X4 跨情侣不能标记别人的消息（coupleId 隔离）', async () => {
    const db = seed({
      couples: [
        { _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'active' },
        { _id: 'c2', coupleId: 'CZ-2', herOpenid: 'C', himOpenid: 'D', status: 'active' }
      ],
      users: [
        { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1' },
        { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1' },
        { _id: 'u_c', _openid: 'C', role: 'her', coupleId: 'CZ-2' },
        { _id: 'u_d', _openid: 'D', role: 'him', coupleId: 'CZ-2' }
      ],
      messages: [{ _id: 'm9', coupleId: 'CZ-2', fromOpenid: 'C', fromRole: 'her', text: '别人的悄悄话', readAt: null, createdAt: 1 }]
    })
    const mod = loadCloudFn('getPartnerView', db, { openid: 'B', cloud: mockCloud() })
    const r = await mod.main({ action: 'readMsg', msgId: 'm9' })
    assertEq(r.updated, 0)
    assertEq(db.dump().messages[0].readAt, null, '不得碰到别的情侣的数据')
  })

  await testCase('X5 未读状态与微信通知成功与否完全解耦', async () => {
    // 通知失败（没额度），但留言已落库 → 对方进页面仍能看到未读角标
    const db = seed({ users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', subQuota: quota(0, 0) },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', subQuota: quota(0, 0) }
    ] })
    const cloud = mockCloud()
    const mod = loadCloudFn('getPartnerView', db, { openid: 'A', cloud })
    const w = await mod.main({ action: 'msg', text: '在吗', requestId: 'dc' })
    assertEq(w.notifySent, false)
    const view = await mod.main({})
    assertEq(view.unreadMsgs, 0, '发送者自己看不到未读')
    const bView = loadCloudFn('getPartnerView', db, { openid: 'B', cloud })
    const r = await bView.main({})
    assertEq(r.unreadMsgs, 1, '接收方必须看到未读，不依赖微信通知')
  })

  await testCase('X6 him 打开页面也会标记已读（旧实现只给 her 做，角标永远清不掉）', async () => {
    const h = loadPage({
      role: 'him',
      onCall: (name, data) => {
        if (data && data.action === 'readMsg') return { result: { ok: true, updated: 1 } }
        if (name === 'getPartnerView' && (!data || !data.action)) {
          return {
            result: {
              ok: true,
              role: 'him',
              wishes: [],
              messages: [{ _id: 'm1', role: 'her', text: '在吗', createdAt: 1, readAt: null, mine: false }],
              unreadMsgs: 1, myQuota: { chat: 0, period: 0 }, partnerQuota: { chat: 0, period: 0 }
            }
          }
        }
        if (name === 'bindCouple') return { result: { ok: true, bound: true } }
        return undefined
      }
    })
    h.page.loadPartner('A')
    await new Promise(r => setTimeout(r, 10))
    const reads = h.cloudCalls.filter(c => c.data && c.data.action === 'readMsg')
    assertEq(reads.length, 1, 'him 侧也必须把对方发来的悄悄话标为已读')
    assertEq(h.page.data.unreadMsgs, 1, '本次会话仍显示进入时的未读数（不清零展示）')
    h.cleanup()
  })

  await testCase('X7 新心愿提示只对 him 有意义（her 看自己的心愿不算新）', async () => {
    const h = loadPage({ role: 'her', storageSeen: 0 })
    const list = [{ _id: 'w1', type: 'eat', text: '火锅', createdAt: 100 }]
    assertEq(h.page.countNewWishes(list, 'A', 'her'), 0)
    const h2 = loadPage({ role: 'him', storageSeen: 0 })
    assertEq(h2.page.countNewWishes(list, 'B', 'him'), 1)
    h.cleanup(); h2.cleanup()
  })
}

// ==================== Y. 经期提醒 ====================
async function runPeriodTests() {
  console.log('\n=== Y · 经期提醒：窗口、幂等、dryRun ===\n')
  clearEnv()

  const TODAY = '2026-10-17'

  function menSeed(lastStart, extra) {
    return seed(Object.assign({
      menstrual: [{ _id: 'men1', _openid: 'A', lastStart, cycle: 28, periodLen: 5, revision: 1 }]
    }, extra))
  }

  await testCase('Y1 定时器每天 09:00，且必须是 Timer 触发（无 OPENID）', async () => {
    const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloudfunctions/menstrual/config.json'), 'utf8'))
    const t = (conf.triggers || [])[0]
    assertOk(t, '必须配置定时触发器')
    assertEq(t.type, 'timer')
    assertEq(t.config, '0 0 9 * * * *', '每天 09:00')
  })

  await testCase('Y2 提醒窗口 0~2 天：第 3 天不发，0 天发', async () => {
    const notDue = loadCloudFn('menstrual', menSeed('2026-09-22'), { openid: undefined, cloud: mockCloud() })
    const r1 = await notDue.main({ action: 'remindTick', today: TODAY, dryRun: true })
    assertEq(r1.wouldSend, 0, '预计日期 10-20（3 天后）不该提醒')

    const due = loadCloudFn('menstrual', menSeed('2026-09-19'), { openid: undefined, cloud: mockCloud() })
    const r2 = await due.main({ action: 'remindTick', today: TODAY, dryRun: true })
    assertEq(r2.wouldSend, 1, '预计日期 10-17（今天）应提醒')
  })

  await testCase('Y3 手动 remindTick 默认只读：零发送 / 零扣减 / 零写入', async () => {
    const db = menSeed('2026-09-19')
    const cloud = mockCloud()
    const before = JSON.stringify(db.dump())
    const mod = loadCloudFn('menstrual', db, { openid: undefined, cloud })
    const r = await mod.main({ action: 'remindTick', today: TODAY })
    assertEq(r.dryRun, true, '默认必须是 dryRun')
    assertEq(r.wouldSend, 1)
    assertEq(cloud.calls.length, 0, '演练不得真的发消息')
    assertEq(JSON.stringify(db.dump()), before, '演练不得写库')
  })

  await testCase('Y4 真发一次后同一预计日期不再发（幂等标记）', async () => {
    const db = menSeed('2026-09-19')
    const cloud = mockCloud()
    const mod = loadCloudFn('menstrual', db, { openid: undefined, cloud })
    const r1 = await mod.main({ action: 'remindTick', today: TODAY, dryRun: false })
    assertEq(r1.sent, 1, JSON.stringify(r1))
    const r2 = await mod.main({ action: 'remindTick', today: TODAY, dryRun: false })
    assertEq(r2.sent, 0, '同一预计日期只能成功提醒一次')
    assertEq(cloud.calls.length, 1)
  })

  await testCase('Y5 没有额度 → 不发、不扣额度、不写标记', async () => {
    const db = menSeed('2026-09-19', { users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', subQuota: quota(0, 0) },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', subQuota: quota(0, 0) }
    ] })
    const cloud = mockCloud()
    const mod = loadCloudFn('menstrual', db, { openid: undefined, cloud })
    const r = await mod.main({ action: 'remindTick', today: TODAY, dryRun: false })
    assertEq(r.sent, 0)
    assertEq(cloud.calls.length, 0, '没额度不得反复调用微信接口')
    assertEq(db.dump().menstrual[0].remindSentFor, undefined, '没发就不该写已发标记')
  })

  await testCase('Y6 客户端伪造 Type=Timer 被拒（有 OPENID 一律拒绝）', async () => {
    const db = menSeed('2026-09-19')
    const cloud = mockCloud()
    const mod = loadCloudFn('menstrual', db, { openid: 'A', cloud })
    const r1 = await mod.main({ Type: 'Timer' })
    assertEq(r1.code, 'FORBIDDEN')
    const r2 = await mod.main({ action: 'remindTick', dryRun: false })
    assertEq(r2.code, 'FORBIDDEN', '客户端不能自己触发真实发送')
    assertEq(cloud.calls.length, 0)
  })

  await testCase('Y7 预计日期已过去 → 不发（prediction_passed），不擅自预测下一周期', async () => {
    const db = menSeed('2026-08-01')
    const cloud = mockCloud()
    const mod = loadCloudFn('menstrual', db, { openid: undefined, cloud })
    const r = await mod.main({ action: 'remindTick', today: TODAY, dryRun: false })
    assertEq(r.sent, 0)
    assertEq(r.skipped.prediction_passed, 1)
    assertEq(cloud.calls.length, 0)
  })

  await testCase('Y8 日历页订阅入口同样按四态处理（ban 不当成取消）', async () => {
    const h = loadPage({ page: 'calendar' })
    h.setSubHandler(o => o.success({ TPL_PERIOD_T: 'ban' }))
    h.page.subscribeRemind()
    await new Promise(r => setTimeout(r, 10))
    assertEq(h.cloudCalls.filter(c => c.data && c.data.action === 'subPeriod').length, 0)
    assertEq(h.modals.length, 1, 'ban 必须弹窗')
    assertOk(/设置/.test(h.modals[0].content))
    h.cleanup()
  })

  await testCase('Y9 日历页 accept → 记一次 period，文案说「已记录 1 次」', async () => {
    const h = loadPage({
      page: 'calendar',
      onCall: (name, data) => (data && data.action === 'subPeriod' ? { result: { ok: true, quota: { chat: 0, period: 1 } } } : undefined)
    })
    h.setSubHandler(o => o.success({ TPL_PERIOD_T: 'accept' }))
    h.page.subscribeRemind()
    await new Promise(r => setTimeout(r, 10))
    assertEq(h.page.data.remindQuota, 1)
    assertOk(h.toasts.some(t => t.indexOf('1 次') !== -1), '应如实提示 1 次: ' + h.toasts.join('/'))
    assertOk(h.page.data.remindHint.indexOf('永久') === -1, '不得承诺永久')
    h.cleanup()
  })
}

// ==================== Z. 兼容与静态约束 ====================
async function runCompatTests() {
  console.log('\n=== Z · 兼容性与静态约束 ===\n')
  clearEnv()

  await testCase('Z1 旧客户端（不带 granted）仍能记账 chat（不破坏已发布版本）', async () => {
    const db = seed({ users: [{ _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', subQuota: quota(0, 0) }] })
    const mod = loadCloudFn('getPartnerView', db, { openid: 'A', cloud: mockCloud() })
    const r1 = await mod.main({ action: 'sub' }) // 老前端不传 granted
    assertEq(r1.ok, false, '没有 granted 不能瞎记账')
    const r2 = await mod.main({ action: 'sub', channels: ['chat'] })
    assertEq(r2.ok, true, '老字段 channels 仍兼容')
    assertEq(r2.quota.chat, 1)
  })

  await testCase('Z2 新客户端 + 旧云函数（不认识 sub）→ 如实提示，不谎报', async () => {
    const h = loadPage({
      role: 'him',
      onCall: (name, data) => (data && data.action === 'sub' ? { result: { ok: false, code: 'BAD_ACTION' } } : undefined)
    })
    h.setSubHandler(o => o.success({ TPL_CHAT_T: 'accept' }))
    h.page.notifySub()
    await new Promise(r => setTimeout(r, 10))
    assertEq(h.page.data.myQuotaTotal, 0)
    assertOk(h.toasts.length > 0, '必须有提示')
    assertOk(h.toasts.every(t => t.indexOf('已开启') === -1), '不得出现「已开启」: ' + h.toasts.join('/'))
    h.cleanup()
  })

  await testCase('Z3 不会自动弹授权：onLoad / onShow 不调用 requestSubscribeMessage', async () => {
    const a = loadPage({ role: 'him' })
    a.page.onShow()
    await new Promise(r => setTimeout(r, 10))
    assertEq(a.subs.length, 0, '「我们」页不得自动弹窗')
    a.cleanup()

    const b = loadPage({ page: 'calendar' })
    if (b.page.onLoad) b.page.onLoad()
    if (b.page.onShow) b.page.onShow()
    await new Promise(r => setTimeout(r, 10))
    assertEq(b.subs.length, 0, '日历页不得自动弹窗')
    b.cleanup()
  })

  await testCase('Z4 两个页面共用同一份订阅话术（防止两边漂移）', async () => {
    for (const p of [OURS_PATH, CAL_PATH]) {
      const src = fs.readFileSync(p, 'utf8')
      assertOk(src.indexOf("utils/subscribe-feedback") !== -1, p + ' 未复用共享话术模块')
      assertOk(src.indexOf('subFeedback') !== -1)
      assertOk(src.indexOf('subFailFeedback') !== -1)
    }
  })

  await testCase('Z5 前端不出现 touser / 不硬编码 openid（接收者只能服务端推导）', async () => {
    for (const p of [OURS_PATH, CAL_PATH]) {
      const src = fs.readFileSync(p, 'utf8')
      assertNo(src, 'touser')
      assertOk(!/openid:\s*['"]o[A-Za-z0-9_-]{10,}/.test(src), p + ' 出现硬编码 openid')
    }
  })

  await testCase('Z6 本轮没有删除/清空任何集合（无 drop / 全量 remove）', async () => {
    const files = [
      'cloudfunctions/getPartnerView/index.js',
      'cloudfunctions/dailyRecord/index.js',
      'cloudfunctions/menstrual/index.js',
      'cloudfunctions/menstrual/remind.js'
    ]
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
      assertNo(src, '.drop(')
      assertOk(!/where\(\s*\{\s*\}\s*\)\.remove/.test(src), f + ' 出现全量删除')
      // V1.1 补充：共同待办需要「删除单条」，实现是 where({ _id, coupleId }).remove()。
      // 这条红线原本是「不许清空集合」，因此允许**带 coupleId 限定**的单文档删除，
      // 但任何不带 coupleId 的 remove() 仍然一律禁止（等价于可能跨情侣 / 全量删除）。
      if (src.indexOf('remove()') !== -1) {
        assertOk(/\.where\(\s*\{[^}]*coupleId[^}]*\}\s*\)\s*\.remove\(\)/.test(src),
          f + ' 出现未按 coupleId 限定的 remove()')
      }
    }
  })

  await testCase('Z7 三份 notify.js 逐字节一致（云函数独立打包的前提）', async () => {
    const a = fs.readFileSync(path.join(ROOT, 'cloudfunctions/getPartnerView/notify.js'), 'utf8')
    const b = fs.readFileSync(path.join(ROOT, 'cloudfunctions/dailyRecord/notify.js'), 'utf8')
    const c = fs.readFileSync(path.join(ROOT, 'cloudfunctions/menstrual/notify.js'), 'utf8')
    assertOk(a === b && a === c, '副本已漂移')
  })

  await testCase('Z8 模板 ID 在客户端与云端一致（占位符，部署前替换为同一真实 ID）', async () => {
    delete require.cache[path.join(ROOT, 'config.js')]
    const CONFIG = require(path.join(ROOT, 'config.js'))
    assertEq(CONFIG.SUB_TPL_CHAT, TPL_CHAT)
    assertEq(CONFIG.SUB_TPL_PERIOD, TPL_PERIOD)
    assertEq(CONFIG.SUB_TPL_CHAT, 'TEMPLATE_ID_HERE')
    assertEq(CONFIG.SUB_TPL_PERIOD, 'TEMPLATE_ID_HERE')
    assertEq(CONFIG.isTplReady(CONFIG.SUB_TPL_CHAT), false)
    assertEq(CONFIG.isTplReady(CONFIG.SUB_TPL_PERIOD), false)
  })

  await testCase('Z9 模板用途闸门已锁死：任何环境变量取值都无法开启', async () => {
    for (const v of ['', 'off', '0', 'maybe', 'no', 'on', 'ON', 'true', '1', 'yes']) {
      assertEq(NOTIFY.isWishNotifyAllowed({ WISH_NOTIFY: v }), false, JSON.stringify(v) + ' 不得开启心愿通知')
    }
    assertEq(NOTIFY.WISH_NOTIFY_ENABLED, false, '代码级常量必须是 false')
    // 静态守卫：闸门函数体内不得再读取任何环境变量 / 入参（否则等于留了后门）
    const src = fs.readFileSync(NOTIFY_PATH, 'utf8')
    const body = src.slice(src.indexOf('function isWishNotifyAllowed'), src.indexOf('// errCode 分类'))
    assertOk(/return\s+WISH_NOTIFY_ENABLED/.test(body), '闸门必须直接返回代码级常量')
    assertNo(body, 'process.env', '闸门不得读取 process.env')
    assertNo(body, 'WISH_NOTIFY_ALLOWED', '白名单开关必须已被删除')
    assertNo(body, 'toLowerCase', '闸门不得再解析字符串配置')
  })
}

// ==================== 主流程 ====================
;(async () => {
  console.log('========================================')
  console.log(' 通知体验优化 · 测试')
  console.log('========================================')
  await runMatrixTests()
  await runOursRuntimeTests()
  await runServerNoticeTests()
  await runUnreadTests()
  await runPeriodTests()
  await runCompatTests()

  console.log('\n========================================')
  console.log(' 结果: ' + passed + ' PASS / ' + failed + ' FAIL')
  if (failures.length) {
    console.log(' 失败项:')
    failures.forEach(f => console.log('   · ' + f))
  }
  console.log('========================================')
  process.exit(failed === 0 ? 0 : 1)
})()
