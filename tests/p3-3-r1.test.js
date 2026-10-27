// ============================================================
// tests/p3-3-r1.test.js · V1.1 P3.3-R1 Phase 2 定点修复回归
//
// 覆盖两项仍保留的确定性修复 + 分享开关 CAS：
//   A. R1-1 分享失效状态可恢复（显式开关清除 invalidated）
//   B. R1-2 补偿严格绑定「本次提交的版本 + 情侣关系」，不误伤后续提交
//   D. MockDB 保真性（惰性匹配 / get 故障注入 / 第 n 次钩子）
//   E. 客户端 CAS 接线（rev 归一、expectedRev 上送、冲突后回读权威状态）
//
// 记录级互动已在 V1.1 收尾移除：原 C 段（R1-3 留言不可变）与 E5（REQUEST_ID_REUSED 文案）
// 一并删除 —— 相关服务端判定与客户端方法已不存在。
//
// 语义边界（必须先读）：
//   本文件用**单进程可控调度点**（MockDB.injectHook）制造交错，断言的是
//   服务端业务逻辑在明确交错下的判定与补偿行为；
//   它**不**证明生产数据库的事务隔离 / 行锁语义（真实云环境未验证）。
//   每条并发用例都显式说明「谁先提交」。
//
// 运行：node tests/p3-3-r1.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const fs = require('fs')
const { MockDB } = require('./mock-db')

const ROOT = path.resolve(__dirname, '..')
const D1 = '2026-10-20'
const HER_A = 'A_her_openid'
const HIM_B = 'B_him_openid'
const HIM_C = 'C_him_openid'
const RECORD_PAGE = path.join(ROOT, 'pages/record/record.js')

let OPENID = HER_A
let passed = 0, failed = 0, failures = []

const shareApi = require('../utils/record-share')

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name) })
    .catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message) })
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a))
}
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8') }

function deferred() {
  let resolve, reject
  const p = new Promise((res, rej) => { resolve = res; reject = rej })
  return { p, resolve, reject }
}

// ---------------- mock wx-server-sdk ----------------
function loadFn(db) {
  const origLoad = Module._load
  Module._load = function (request) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test',
        init() {},
        database: () => db,
        getWXContext: () => ({ OPENID }),
        openapi: { subscribeMessage: { send: async () => ({ errCode: 0 }) } }
      }
    }
    return origLoad.apply(this, arguments)
  }
  const fnPath = path.join(ROOT, 'cloudfunctions/getPartnerView/index.js')
  delete require.cache[fnPath]
  const mod = require(fnPath)
  Module._load = origLoad
  return mod
}

function seed(shareExtra) {
  return {
    users: [
      { _id: 'uA', _openid: HER_A, role: 'her', coupleId: 'CZ-1', partnerName: '' },
      { _id: 'uB', _openid: HIM_B, role: 'him', coupleId: 'CZ-1', partnerName: '' },
      { _id: 'uC', _openid: HIM_C, role: 'him', coupleId: null, partnerName: '' }
    ],
    couples: [
      { _id: 'c1', coupleId: 'CZ-1', status: 'active', herOpenid: HER_A, himOpenid: HIM_B, anniversary: null }
    ],
    daily_records: [{
      _openid: HER_A, date: D1, coupleId: 'CZ-1', revision: 2,
      goals: [], todos: [], segments: { life: '生活', work: '工作', growth: '成长' },
      mood: { type: 'calm', weather: 'sunny' }, score: 3, wishes: []
    }],
    record_shares: [Object.assign({
      _id: 'sh_' + HER_A + '_' + D1, _openid: HER_A, date: D1,
      coupleId: 'CZ-1', himOpenid: HIM_B, enabled: true, rev: 1, createdAt: 1, updatedAt: 1
    }, shareExtra || {})]
  }
}
const withoutShare = extra => {
  const d = seed(extra)
  d.record_shares = []
  return d
}

const shareOf = db => (db.dump().record_shares || [])[0] || null
function switchOpenid(id) { OPENID = id }

function rebindTo(db, coupleId, himOpenid) {
  db._data.couples[0] = {
    _id: 'c1', coupleId, status: 'active',
    herOpenid: HER_A, himOpenid, anniversary: null
  }
  db._data.users[0].coupleId = coupleId
  db._data.users[1].coupleId = coupleId
  db._data.users[2].coupleId = coupleId
  db._data.daily_records[0].coupleId = coupleId
}

// ---------------- 记录页 harness（发请求 / 记录 toast） ----------------
function mountPage(handlers) {
  const calls = []
  const toasts = []
  global.wx = {
    cloud: {
      callFunction: (args) => {
        calls.push(args)
        const action = args.data && args.data.action
        const h = (handlers || {})[action]
        if (!h) return Promise.resolve({ result: { ok: true } })
        return Promise.resolve(h(args.data)).then(result => ({ result }))
      }
    },
    getStorageSync: () => '',
    setStorageSync: () => {},
    removeStorageSync: () => {},
    showToast: (o) => { toasts.push(o && o.title) },
    showModal: () => {},
    requestSubscribeMessage: () => {}
  }
  global.getApp = () => ({
    whenReady: (cb) => cb({ openid: HER_A, role: 'her', coupleId: 'CZ-1' }),
    globalData: { openid: HER_A, role: 'her', coupleId: 'CZ-1', partnerName: '' },
    silentLogin: () => Promise.resolve(),
    loginSnapshot: () => ({ state: 'ready', ok: true, canRetry: false })
  })
  let cfg = null
  global.Page = (c) => { cfg = c }
  delete require.cache[RECORD_PAGE]
  require(RECORD_PAGE)
  const page = Object.assign({}, cfg)
  page.data = JSON.parse(JSON.stringify(cfg.data))
  page.setData = function (patch, cb) {
    for (const k of Object.keys(patch || {})) page.data[k] = patch[k]
    if (cb) cb()
  }
  return { page, calls, toasts }
}

const flushTick = () => new Promise(r => setTimeout(r, 0))

async function main() {
  console.log('\n=== P3.3-R1 定点修复 ===\n')

  // ============================================================
  // A. R1-1 分享失效状态可恢复
  // ============================================================
  console.log('--- A. R1-1 失效状态恢复 ---\n')

  await testCase('A1 异常失效 → 她重新开启 → him 能读到（修复前：永远读不到）', async () => {
    // 复现前置：一条被补偿标记过 invalidated 的分享文档（enabled 仍为 true）
    const db = new MockDB(seed({ enabled: false, invalidated: true, rev: 5 }))
    const fn = loadFn(db)

    // 修复前的症状：him 读不到
    switchOpenid(HIM_B)
    assertEq((await fn.main({ action: 'view', date: D1 })).shared, null, '失效状态下 him 读不到（前置成立）')

    switchOpenid(HER_A)
    const on = await fn.main({ action: 'shareSet', date: D1, enabled: true, expectedRev: 5 })
    assertEq(on.ok, true)
    assertEq(on.rev, 6)

    // 关键断言：显式开关必须清除补偿留下的失效标记
    assertEq(shareOf(db).invalidated, false, '开启后 invalidated 必须为 false')
    assertEq(shareOf(db).invalidatedAt, null, 'invalidatedAt 必须清空')
    assertEq(shareOf(db).enabled, true)

    // 完整链路：她自己读得到，him 也读得到
    const st = await fn.main({ action: 'shareStatus', date: D1 })
    assertEq(st.enabled, true, 'shareStatus 必须如实反映已开启')

    switchOpenid(HIM_B)
    const v = await fn.main({ action: 'view', date: D1 })
    assertOk(v.shared, '重新开启后 him 必须能读到内容')
    assertEq(v.shared.segments.life, '生活')
  })

  await testCase('A2 关闭分享同样清除失效标记（不再留「矛盾态」文档）', async () => {
    const db = new MockDB(seed({ enabled: true, invalidated: true, rev: 2 }))
    const fn = loadFn(db)
    switchOpenid(HER_A)
    const off = await fn.main({ action: 'shareSet', date: D1, enabled: false, expectedRev: 2 })
    assertEq(off.ok, true)
    assertEq(shareOf(db).enabled, false)
    assertEq(shareOf(db).invalidated, false, '关闭也是显式用户操作 → 必须清除失效标记')
    assertEq(shareOf(db).rev, 3)
  })

  await testCase('A3 从未分享过的一天：rev=0 / enabled=false（版本号与状态一致）', async () => {
    const db = new MockDB(withoutShare())
    const fn = loadFn(db)
    switchOpenid(HER_A)
    const st = await fn.main({ action: 'shareStatus', date: D1 })
    assertEq(st.ok, true)
    assertEq(st.enabled, false)
    assertEq(st.rev, 0, '没有文档 → 版本 0')
    assertEq(shareOf(db), null, '查询不得产生文档')
  })

  // ============================================================
  // B. R1-2 补偿严格绑定本次提交的版本
  // ============================================================
  console.log('\n--- B. R1-2 补偿版本绑定 ---\n')

  await testCase('B1 旧关系开启 → 换绑 → 新关系开启 → 旧请求补偿：不得动新版本', async () => {
    const db = new MockDB(seed({ enabled: false, rev: 1 }))
    const fn = loadFn(db)
    switchOpenid(HER_A)

    const reached = deferred()
    const gate = deferred()
    // 暂停点：p1 写完 rev2 之后的「写后关系复检」。
    // users.get 的调用序：①函数入口鉴权 ②循环内写前复核 ③写后复检 → 取第 3 次
    db.injectHookN('users', 'get', 3, async () => { reached.resolve(); await gate.p })

    const p1 = fn.main({ action: 'shareSet', date: D1, enabled: true, expectedRev: 1 })
    await reached.p
    // 明确记录：p1 已提交 rev2（enabled=true, CZ-1），此刻尚未做关系复检
    assertEq(shareOf(db).rev, 2, 'p1 已提交 rev2')
    assertEq(shareOf(db).coupleId, 'CZ-1')

    // 换绑到 C（新关系），并由新关系提交一次开启（rev2 → rev3）
    rebindTo(db, 'CZ-9', HIM_C)
    const p2 = await fn.main({ action: 'shareSet', date: D1, enabled: true, expectedRev: 2 })
    assertEq(p2.ok, true, '新关系基于 rev2 提交成功（先于 p1 的补偿）')
    assertEq(p2.rev, 3)

    gate.resolve()
    const r1 = await p1

    assertEq(r1.ok, false)
    assertEq(r1.code, 'STALE_RELATION')
    assertEq(r1.rollback, 'skipped', 'rev 已被推进 → 补偿必须跳过，不得动别人的版本')
    // 最终状态 = 新关系那次提交，原样保留
    assertEq(shareOf(db).rev, 3, '旧请求的补偿不得改动新版本')
    assertEq(shareOf(db).enabled, true, '新关系的授权不得被旧请求关掉')
    assertEq(shareOf(db).coupleId, 'CZ-9')
    assertEq(shareOf(db).himOpenid, HIM_C)
    assertEq(shareOf(db).invalidated, false)

    switchOpenid(HIM_C)
    const vc = await fn.main({ action: 'view', date: D1 })
    assertOk(vc.shared, '新 him 的授权必须仍然有效')

    switchOpenid(HIM_B)
    const vb = await fn.main({ action: 'view', date: D1 })
    assertEq(vb.ok, false, '旧 him 已被移出有效关系 → 直接拒绝')
    assertEq(vb.code, 'NOT_ACTIVE')
    assertOk(vb.shared === undefined || vb.shared === null, '无论走哪条分支都不得带出 shared')
  })

  await testCase('B2 补偿确实生效时只影响自己那一版（rollback=applied）', async () => {
    const db = new MockDB(seed({ enabled: false, rev: 1 }))
    const fn = loadFn(db)
    switchOpenid(HER_A)
    const reached = deferred()
    const gate = deferred()
    db.injectHook('record_shares', 'get', async () => { reached.resolve(); await gate.p })

    const p1 = fn.main({ action: 'shareSet', date: D1, enabled: true, expectedRev: 1 })
    await reached.p
    db._data.couples[0].status = 'superseded'
    gate.resolve()
    const r1 = await p1

    assertEq(r1.code, 'STALE_RELATION')
    assertEq(r1.rollback, 'applied')
    assertEq(shareOf(db).rev, 3, '写入 rev2 + 补偿 rev3')
    assertEq(shareOf(db).enabled, false)
    assertEq(shareOf(db).invalidated, true)
    assertEq(shareOf(db).invalidatedAt !== null && shareOf(db).invalidatedAt !== undefined, true)
  })

  await testCase('B3 补偿写入失败 → rollback=failed，不谎报已回滚；授权仍因关系不符失效', async () => {
    const db = new MockDB(seed({ enabled: false, rev: 1 }))
    const fn = loadFn(db)
    switchOpenid(HER_A)
    const reached = deferred()
    const gate = deferred()
    // users.get 调用序：①入口鉴权 ②写前复核 ③写后复检 → 第 3 次是复检
    db.injectHookN('users', 'get', 3, async () => { reached.resolve(); await gate.p })

    const p1 = fn.main({ action: 'shareSet', date: D1, enabled: true, expectedRev: 1 })
    await reached.p
    // 此时 p1 已提交 rev2；换绑 + 让补偿那次 update 失败
    assertEq(shareOf(db).rev, 2, '前置：p1 已提交')
    rebindTo(db, 'CZ-9', HIM_C)
    db.injectFail('record_shares', 'update')
    gate.resolve()
    const r1 = await p1

    assertEq(r1.ok, false)
    assertEq(r1.code, 'STALE_RELATION')
    assertEq(r1.rollback, 'failed', '补偿失败必须如实上报，不能声称已回滚')
    // 即便补偿失败，旧文档仍带旧 coupleId/himOpenid → 判定层照样拒绝
    assertEq(shareOf(db).coupleId, 'CZ-1', '补偿没生效：文档仍是旧关系')
    switchOpenid(HIM_C)
    const vc = await fn.main({ action: 'view', date: D1 })
    assertEq(vc.shared, null, '新 him 不能读到（coupleId/himOpenid 不匹配 → fail-closed）')
    switchOpenid(HIM_B)
    const vb = await fn.main({ action: 'view', date: D1 })
    assertEq(vb.ok, false, '旧 him 已不在有效关系里')
    assertEq(vb.code, 'NOT_ACTIVE')
    assertOk(vb.shared === undefined || vb.shared === null, '任何情况下都不得带出 shared')
  })

  // ============================================================
  // D. MockDB 保真性（本轮修正过早快照）
  // ============================================================
  console.log('\n--- D. MockDB 保真性 ---\n')

  await testCase('D1 where().get() 在执行时求值：构造之后写入的文档也能读到', async () => {
    const db = new MockDB({ items: [] })
    const q = db.collection('items').where({ k: 'x' })   // 此时没有匹配
    await db.collection('items').add({ data: { k: 'x', v: 1 } })  // 读取之前写入
    const r = await q.get()
    assertEq(r.data.length, 1, '真实数据库语义：读取时才求值，不能是构造时的快照')
    assertEq(r.data[0].v, 1)
  })

  await testCase('D2 injectFail 支持 get：读取失败可被模拟', async () => {
    const db = new MockDB({ items: [{ _id: 'a', k: 'x' }] })
    db.injectFail('items', 'get')
    let threw = false
    try { await db.collection('items').where({ k: 'x' }).get() } catch (e) { threw = true }
    assertOk(threw, 'get 故障注入必须生效（否则「复核读失败」分支无法测试）')
    // 一次性：之后恢复正常
    const r = await db.collection('items').where({ k: 'x' }).get()
    assertEq(r.data.length, 1)
  })

  await testCase('D3 injectHookN 第 n 次调用才触发', async () => {
    const db = new MockDB({ items: [{ _id: 'a', k: 'x' }] })
    let hits = 0
    let fired = 0
    db.injectHookN('items', 'get', 2, async () => { fired++ })
    await db.collection('items').where({ k: 'x' }).get()
    hits++
    assertEq(fired, 0, '第 1 次不触发')
    await db.collection('items').where({ k: 'x' }).get()
    hits++
    assertEq(fired, 1, '第 2 次触发')
    await db.collection('items').where({ k: 'x' }).get()
    assertEq(fired, 1, '一次性：第 3 次不再触发')
    assertEq(hits, 2)
  })

  // ============================================================
  // E. 客户端 CAS 接线
  // ============================================================
  console.log('\n--- E. 客户端 CAS ---\n')

  await testCase('E1 normalizeShareStatus：rev 只认非负整数，缺失 → 0', async () => {
    const okRes = extra => ({ result: Object.assign({ ok: true, enabled: false, canShare: true, hasRecord: true }, extra) })
    assertEq(shareApi.normalizeShareStatus(okRes({ rev: 3 })).rev, 3)
    assertEq(shareApi.normalizeShareStatus(okRes({})).rev, 0, '缺失 → 0')
    assertEq(shareApi.normalizeShareStatus(okRes({ rev: '3' })).rev, 0, '字符串不得当版本号')
    assertEq(shareApi.normalizeShareStatus(okRes({ rev: -1 })).rev, 0, '负数不合法')
    assertEq(shareApi.normalizeShareStatus({ result: { ok: false, code: 'CONFLICT' } }).rev, 0, '失败响应不得带版本')
    // casSupported：只有服务端真的回了数字 rev 才为 true（用于识别旧云函数）
    assertEq(shareApi.normalizeShareStatus(okRes({ rev: 0 })).casSupported, true, 'rev=0 也是合法版本（= 没有文档）')
    assertEq(shareApi.normalizeShareStatus(okRes({})).casSupported, false, '没有 rev → 视为不支持 CAS')
  })

  await testCase('E2 requestShareSet 把 expectedRev 原样上送', async () => {
    let payload = null
    const call = args => { payload = args.data; return Promise.resolve({ result: { ok: true, enabled: true, rev: 5 } }) }
    const r = await shareApi.requestShareSet(D1, true, 4, call)
    assertEq(r.ok, true)
    assertEq(payload.action, 'shareSet')
    assertEq(payload.expectedRev, 4, '必须上送客户端确认过的版本')
    assertEq(r.rev, 5, '成功后采用服务端返回的新版本')
  })

  await testCase('E3 旧的三参调用不带 expectedRev（服务端会 CONFLICT，不会退化成无条件覆盖）', async () => {
    let payload = null
    const call = args => { payload = args.data; return Promise.resolve({ result: { ok: false, code: 'CONFLICT', needRefresh: true } }) }
    const r = await shareApi.requestShareSet(D1, true, call)
    assertEq(Object.prototype.hasOwnProperty.call(payload, 'expectedRev'), false, '旧调用不得凭空补一个版本号')
    assertEq(r.ok, false)
    assertEq(r.code, 'CONFLICT')
    assertEq(r.needRefresh, true)
  })

  await testCase('E4 CONFLICT → 页面立刻回读权威状态，且不把开关显示成「已关闭」', async () => {
    const h = mountPage({
      // 每次读取都返回「服务端权威状态」= 已开启
      shareStatus: () => ({ ok: true, enabled: true, canShare: true, hasRecord: true, rev: 1 }),
      shareSet: () => ({ ok: false, code: 'CONFLICT', rev: 1 })
    })
    h.page.onLoad()
    await flushTick()
    assertEq(h.page.data.shareState, 'ready')
    assertEq(h.page.data.shareRev, 1)
    const before = h.calls.filter(c => c.data.action === 'shareStatus').length

    h.page._setShare(false)   // 想关闭，但服务端说版本冲突
    await flushTick()

    const after = h.calls.filter(c => c.data.action === 'shareStatus').length
    assertEq(after, before + 1, '冲突后必须重新回读权威状态')
    assertEq(h.page.data.shareEnabled, true, '不得把开关留在失败后的旧假设上')
    assertEq(h.page.data.shareRev, 1, '版本号以服务端为准')
    assertEq(h.page.data.shareBusy, false)
    assertOk(h.toasts.indexOf(shareApi.hintOf('CONFLICT')) !== -1, '必须给出可读提示')
  })

  await testCase('E4b 新客户端 + 旧云函数（shareStatus 不回 rev）→ 禁用开关，一个写请求都不发', async () => {
    const h = mountPage({
      // 旧服务端：ok 但没有 rev，也不认识 expectedRev
      shareStatus: () => ({ ok: true, enabled: false, canShare: true, hasRecord: true })
    })
    h.page.onLoad()
    await flushTick()
    assertEq(h.page.data.shareState, 'error', '无法确认版本 → 必须 fail-closed')
    assertEq(h.page.data.shareEnabled, false)
    assertEq(h.page.data.shareRev, 0, '没有版本号就不能写')
    assertOk(String(h.page.data.shareNote).indexOf('更新小程序') !== -1, '必须明确告知需要更新')

    h.page.onShareToggle()          // 用户点开关
    await flushTick()
    const writes = h.calls.filter(c => c.data.action === 'shareSet')
    assertEq(writes.length, 0, '旧服务端下绝不允许发出「无条件覆盖」的写入')
  })

  await testCase('E5 页面源码：写入必须带版本号，冲突必须回读（静态契约）', async () => {
    const js = read('pages/record/record.js')
    assertOk(js.indexOf('requestShareSet(date, enabled, expectedRev') !== -1, '必须上送 expectedRev')
    assertOk(js.indexOf('shareRev: res.rev') !== -1, '必须采用服务端返回的新版本')
    assertOk(/res\.code === shareApi\.CODE\.CONFLICT\) this\._loadShare\(date\)/.test(js), '冲突后必须回读权威状态')
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    console.log('\n失败用例:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('P3.3-R1: ALL GREEN')
}

main()
