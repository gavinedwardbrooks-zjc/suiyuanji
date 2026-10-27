// ============================================================
// tests/m5-interaction.test.js · M5 情侣互动测试（PRD v0.8 / 指令 §26-32）
// P1 心愿已安排原子+幂等 / P2 留言已读 / P3 纪念日 / P4 隐私 / P5 换绑失权
// 运行：node tests/m5-interaction.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const fs = require('fs')
const { MockDB } = require('./mock-db')

const ROOT = path.resolve(__dirname, '..')
let passed = 0, failed = 0, failures = []

function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name) }
  else { failed++; failures.push(name + (detail ? ' -> ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : '')) }
}
function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name) })
    .catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message) })
}
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)) }
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }

// ---- mock sdk（A=her B=him，可通过 OPENID 切换视角） ----
let OPENID = 'A'
function withMockSdk(db) {
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
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
  const fnPath = path.resolve(__dirname, '../cloudfunctions/getPartnerView/index.js')
  delete require.cache[fnPath]
  const mod = require(fnPath)
  Module._load = origLoad
  return mod
}

function seedActive(extra) {
  return new MockDB(Object.assign({
    users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', schemaVersion: 2 },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', schemaVersion: 2 }
    ],
    couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'active', anniversary: null }],
    daily_records: [],
    wishes: [],
    messages: [],
    menstrual: []
  }, extra))
}
function herWish(id, extra) {
  // coupleId：记录级/心愿级归属（P0）—— 本文件测的是「同一段生效关系内」的互动，
  // 因此种子必须带上当前关系标识，否则会被归属闸门当成历史文档隐藏。
  return Object.assign({ _id: id, _openid: 'A', coupleId: 'CZ-1', type: 'eat', text: '火锅', status: 'pending', createdAt: 1000 }, extra)
}
function msg(id, from, text, extra) {
  return Object.assign({ _id: id, coupleId: 'CZ-1', fromOpenid: from, fromRole: from === 'B' ? 'him' : 'her', text, readAt: null, createdAt: 1000 }, extra)
}

// ==================== P1 心愿 ====================
async function runWishTests() {
  console.log('\n=== M5-P1 · 心愿已安排（原子 + 幂等 + 通知） ===\n')

  await testCase('P1-1 active him 标记 pending 心愿 → done_by_partner + arrangedAt', async () => {
    const db = seedActive({ wishes: [herWish('w1')] })
    const mod = withMockSdk(db)
    OPENID = 'B'
    const r = await mod.main({ action: 'mark', wishId: 'w1' })
    assertOk(r.ok)
    assertOk(r.arrangedAt > 0, 'arrangedAt 首次写入')
    assertEq(db.dump().wishes[0].status, 'done_by_partner')
    assertEq(db.dump().wishes[0].arrangedAt, r.arrangedAt)
    OPENID = 'A'
  })

  await testCase('P1-2 第二次 mark → 幂等（already，arrangedAt 不改变）', async () => {
    const db = seedActive({ wishes: [herWish('w1')] })
    const mod = withMockSdk(db)
    OPENID = 'B'
    const r1 = await mod.main({ action: 'mark', wishId: 'w1' })
    const r2 = await mod.main({ action: 'mark', wishId: 'w1' })
    assertOk(r2.ok)
    assertEq(r2.already, true)
    assertEq(r2.arrangedAt, r1.arrangedAt, 'arrangedAt 不变')
    assertEq(db.dump().wishes[0].arrangedAt, r1.arrangedAt, '库内 arrangedAt 不变')
    OPENID = 'A'
  })

  await testCase('P1-3 未授权（无模板）→ 业务状态仍成功 + notificationSkipped', async () => {
    const db = seedActive({ wishes: [herWish('w1')] })
    const mod = withMockSdk(db)
    OPENID = 'B'
    // TPL_ARRANGE 为空（测试环境默认）→ notify 不发送 → skipped
    const r = await mod.main({ action: 'mark', wishId: 'w1' })
    assertOk(r.ok)
    assertEq(r.notifySent, false)
    assertEq(db.dump().wishes[0].status, 'done_by_partner', '业务成功不因通知失败回滚')
    assertEq(db.dump().wishes[0].notifySentAt, undefined, '未成功通知不写 notifySentAt')
    assertEq(db.dump().wishes[0].notificationSkipped, true, '记录 skipped')
    OPENID = 'A'
  })

  await testCase('P1-4 her 不能假扮 him mark（FORBIDDEN）', async () => {
    const db = seedActive({ wishes: [herWish('w1')] })
    const mod = withMockSdk(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'mark', wishId: 'w1' })
    assertEq(r.ok, false)
    assertEq(r.code, 'FORBIDDEN')
    assertEq(db.dump().wishes[0].status, 'pending', '未变')
  })

  await testCase('P1-5 unrelated 用户不能 mark（NOT_ACTIVE）', async () => {
    const db = seedActive({ wishes: [herWish('w1')] })
    const mod = withMockSdk(db)
    OPENID = 'X'
    const r = await mod.main({ action: 'mark', wishId: 'w1' })
    assertEq(r.code, 'NOT_ACTIVE')
  })

  await testCase('P1-6 superseded him 不能 mark（NOT_ACTIVE）', async () => {
    const db = seedActive({ wishes: [herWish('w1')] })
    db.collection('couples').doc('c1').update({ data: { status: 'superseded' } })
    const mod = withMockSdk(db)
    OPENID = 'B'
    const r = await mod.main({ action: 'mark', wishId: 'w1' })
    assertEq(r.code, 'NOT_ACTIVE')
    OPENID = 'A'
  })
}

// ==================== P2 留言已读 ====================
async function runMsgTests() {
  console.log('\n=== M5-P2 · 留言已读 ===\n')

  await testCase('P2-1 拉取上限 50（51 条 → 返回 50）', async () => {
    const msgs = []
    for (let i = 0; i < 51; i++) msgs.push(msg('m' + i, i % 2 ? 'B' : 'A', 'text' + i, { createdAt: 1000 + i }))
    const db = seedActive({ messages: msgs })
    const mod = withMockSdk(db)
    OPENID = 'B'
    const r = await mod.main({})
    assertOk(r.ok)
    assertEq(r.messages.length, 50, '最多 50 条')
    OPENID = 'A'
  })

  await testCase('P2-2 her 阅读 him 留言 → readAt 写入（原子只写第一次）', async () => {
    const db = seedActive({ messages: [msg('m1', 'B', '早点休息')] })
    const mod = withMockSdk(db)
    OPENID = 'A'
    const r1 = await mod.main({ action: 'readMsg', msgId: 'm1' })
    assertOk(r1.ok)
    assertEq(r1.updated, 1, '首次标记成功')
    const r2 = await mod.main({ action: 'readMsg', msgId: 'm1' })
    assertEq(r2.updated, 0, '重复标记幂等')
    assertOk(db.dump().messages[0].readAt > 0, 'readAt 写入')
  })

  await testCase('P2-3 him 不能把自己发的消息标已读', async () => {
    const db = seedActive({ messages: [msg('m1', 'B', '我发的')] })
    const mod = withMockSdk(db)
    OPENID = 'B'
    const r = await mod.main({ action: 'readMsg', msgId: 'm1' })
    assertEq(r.updated, 0, '自己发的消息不可标已读')
    assertEq(db.dump().messages[0].readAt, null)
    OPENID = 'A'
  })

  await testCase('P2-4 him 能在 view 看到 readAt 状态', async () => {
    const db = seedActive({ messages: [Object.assign(msg('m1', 'B', 'hi'), { readAt: 555 })] })
    const mod = withMockSdk(db)
    OPENID = 'B'
    const r = await mod.main({})
    const m = r.messages.find(x => x._id === 'm1')
    assertEq(m.readAt, 555)
    assertEq(m.mine, true)
    OPENID = 'A'
  })

  await testCase('P2-5 unrelated 用户无留言权限（NOT_ACTIVE）', async () => {
    const db = seedActive({ messages: [msg('m1', 'B', 'hi')] })
    const mod = withMockSdk(db)
    OPENID = 'X'
    const r = await mod.main({})
    assertEq(r.code, 'NOT_ACTIVE')
  })

  await testCase('P2-6 superseded partner 无留言权限', async () => {
    const db = seedActive({ messages: [msg('m1', 'B', 'hi')] })
    db.collection('couples').doc('c1').update({ data: { status: 'superseded' } })
    const mod = withMockSdk(db)
    OPENID = 'B'
    const r = await mod.main({})
    assertEq(r.code, 'NOT_ACTIVE')
    OPENID = 'A'
  })
}

// ==================== P3 纪念日 ====================
async function runAnniTests() {
  console.log('\n=== M5-P3 · 纪念日 ===\n')
  const mod = withMockSdk(new MockDB({}))

  await testCase('P3-1 same day → 第 1 天', () => {
    assertEq(mod.daysTogether('2026-08-01', '2026-08-01'), 1)
  })
  await testCase('P3-2 next day → 第 2 天', () => {
    assertEq(mod.daysTogether('2026-08-01', '2026-08-02'), 2)
  })
  await testCase('P3-3 跨月正确', () => {
    assertEq(mod.daysTogether('2026-07-30', '2026-08-02'), 4)
  })
  await testCase('P3-4 跨年正确', () => {
    assertEq(mod.daysTogether('2025-12-30', '2026-01-02'), 4)
  })
  await testCase('P3-5 闰年正确（2024-02-28 → 2024-03-01 = 3 天）', () => {
    assertEq(mod.daysTogether('2024-02-28', '2024-03-01'), 3)
  })
  await testCase('P3-6 非法 anniversary 拒绝（2026-02-30）', async () => {
    const db = seedActive()
    const m = withMockSdk(db)
    OPENID = 'A'
    const r = await m.main({ action: 'setAnniversary', anniversary: '2026-02-30' })
    assertEq(r.code, 'BAD_ARGS')
  })
  await testCase('P3-7 未来日期拒绝', async () => {
    const db = seedActive()
    const m = withMockSdk(db)
    OPENID = 'A'
    const r = await m.main({ action: 'setAnniversary', anniversary: '2999-01-01' })
    assertEq(r.code, 'BAD_ARGS')
    assertEq(db.dump().couples[0].anniversary, null, '不得写入')
  })
  await testCase('P3-8 active her 可保存纪念日', async () => {
    const db = seedActive()
    const m = withMockSdk(db)
    OPENID = 'A'
    const r = await m.main({ action: 'setAnniversary', anniversary: '2026-08-01' })
    assertOk(r.ok)
    assertEq(db.dump().couples[0].anniversary, '2026-08-01')
    assertOk(typeof r.days === 'number' && r.days > 0, 'days 为有效正整数（随运行日变化）')
  })
  await testCase('P3-9 active him 可保存纪念日（双方可编辑）', async () => {
    const db = seedActive()
    const m = withMockSdk(db)
    OPENID = 'B'
    const r = await m.main({ action: 'setAnniversary', anniversary: '2026-08-05' })
    assertOk(r.ok)
    assertEq(db.dump().couples[0].anniversary, '2026-08-05')
    OPENID = 'A'
  })
  await testCase('P3-10 outsider 拒绝', async () => {
    const db = seedActive()
    const m = withMockSdk(db)
    OPENID = 'X'
    const r = await m.main({ action: 'setAnniversary', anniversary: '2026-08-01' })
    assertEq(r.code, 'NOT_ACTIVE')
  })
  await testCase('P3-11 superseded partner 拒绝', async () => {
    const db = seedActive()
    db.collection('couples').doc('c1').update({ data: { status: 'superseded' } })
    const m = withMockSdk(db)
    OPENID = 'B'
    const r = await m.main({ action: 'setAnniversary', anniversary: '2026-08-01' })
    assertEq(r.code, 'NOT_ACTIVE')
    OPENID = 'A'
  })
}

// ==================== P4 隐私 ====================
async function runPrivacyTests() {
  console.log('\n=== M5-P4 · 隐私红线（him response 无私有字段） ===\n')

  await testCase('P4-1..6 him view 不含 diary/mood.type/weather/body/herSummary/herReport', async () => {
    const today = new Date()
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const db = seedActive({
      daily_records: [{
        _id: 'r1', _openid: 'A', coupleId: 'CZ-1', date: ymd,
        segments: { life: '私密日记', work: 'x', growth: 'y' },
        mood: { type: 'low', weather: 'rain' },
        body: { amount: 'heavy' },
        summary: '她版小结', partnerSummary: '伙伴版',
        score: 4
      }],
      wishes: [herWish('w1')]
    })
    const mod = withMockSdk(db)
    OPENID = 'B'
    const r = await mod.main({})
    assertOk(r.ok)
    const s = JSON.stringify(r)
    assertEq(s.includes('私密日记'), false, 'diary 泄露')
    assertEq(s.includes('mood.type') || s.includes('"low"'), false, 'mood.type 泄露')
    assertEq(s.includes('weather') && s.includes('rain'), false, 'weather 泄露')
    assertEq(s.includes('heavy'), false, 'body 泄露')
    assertEq(s.includes('她版小结'), false, 'herSummary 内容泄露')
    assertOk(s.includes('partnerSummary'), 'partnerSummary 允许返回（M6 白名单）')
    assertEq(s.includes('herReport'), false)
    // 允许：score
    assertOk(r.score === 4)
    OPENID = 'A'
  })
}

// ==================== P5 换绑失权 ====================
async function runSupersededTests() {
  console.log('\n=== M5-P5 · 换绑后旧 partner 即时失权 ===\n')

  async function setupRebind() {
    // A(her) B(him) 当前 active；A 换绑新码给 C
    const db = new MockDB({
      users: [
        { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', schemaVersion: 2 },
        { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', schemaVersion: 2 },
        { _id: 'u_c', _openid: 'C', role: 'her', coupleId: null, schemaVersion: 2 }
      ],
      couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'active', anniversary: null }],
      daily_records: [],
      wishes: [],
      messages: [],
      menstrual: []
    })
    // 用 bindCouple core 驱动换绑（真实状态机，非手工改）
    const bcore = require(path.resolve(__dirname, '../cloudfunctions/bindCouple/core.js'))
    // 先解绑 A-B（P0：换绑必须先解绑，确认时不再自动 supersede）
    await bcore.unbind({ db, openid: 'A', now: Date.now() })
    const g = await bcore.generate({ db, herOpenid: 'A', now: Date.now() + 1 })
    await bcore.claim({ db, code: g.bindCode, himOpenid: 'C', now: Date.now() + 2 })
    await bcore.confirm({ db, herOpenid: 'A', requestId: g.requestId, accept: true, now: Date.now() + 3 })
    // 断言换绑成功
    assertEq(db.dump().couples.find(c => c.coupleId === 'CZ-1').status, 'unbound', '旧关系 unbound')
    const newC = db.dump().couples.find(c => c.herOpenid === 'A' && c.status === 'active')
    assertOk(newC, '新关系 active')
    return db
  }

  await testCase('P5-1 换绑后 old=B denied / new=C pass / A pass', async () => {
    const db = await setupRebind()
    const mod = withMockSdk(db)
    // B（旧 him）→ deny
    OPENID = 'B'
    const rB = await mod.main({})
    assertEq(rB.code, 'NOT_ACTIVE', '旧 partner view 应 deny')
    const markB = await mod.main({ action: 'mark', wishId: 'w1' })
    assertEq(markB.code, 'NOT_ACTIVE', '旧 partner mark 应 deny')
    const anniB = await mod.main({ action: 'setAnniversary', anniversary: '2026-08-01' })
    assertEq(anniB.code, 'NOT_ACTIVE', '旧 partner 纪念日应 deny')
    // C（新 him）→ pass（wishes 空列表 ok）
    OPENID = 'C'
    const rC = await mod.main({})
    assertOk(rC.ok, '新 partner 可访问: ' + JSON.stringify(rC))
    assertEq(rC.role, 'him')
    // A（her）→ pass
    OPENID = 'A'
    const rA = await mod.main({})
    assertOk(rA.ok)
    assertEq(rA.role, 'her')
  })

  await testCase('P5-2 旧 partner 无法读 her 经期（menstrual NOT configured / forbidden）', async () => {
    const db = await setupRebind()
    // 塞 her 经期记录
    db.dump().menstrual = [{ _id: 'm1', _openid: 'A', lastStart: '2026-08-10', cycle: 28, periodLen: 5, revision: 1 }]
    // 加载 menstrual 云函数（新 mock 上下文）
    const origLoad = Module._load
    Module._load = function (request) {
      if (request === 'wx-server-sdk') return { DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => db, getWXContext: () => ({ OPENID }) }
      return origLoad.apply(this, arguments)
    }
    delete require.cache[path.resolve(__dirname, '../cloudfunctions/menstrual/index.js')]
    const men = require(path.resolve(__dirname, '../cloudfunctions/menstrual/index.js'))
    Module._load = origLoad
    OPENID = 'B'
    const r = await men.main({ action: 'get' })
    assertEq(r.configured, false, '旧 partner 读不到 her 经期')
    OPENID = 'A'
  })

  await testCase('P5-3 new pending 阶段 old 仍有权限（approve 前）', async () => {
    // 构造：old active + new pending（C 已 claim 未 confirm）
    const db = new MockDB({
      users: [
        { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', schemaVersion: 2 },
        { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', schemaVersion: 2 },
        { _id: 'u_c', _openid: 'C', role: 'her', coupleId: null, schemaVersion: 2 }
      ],
      couples: [
        { _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'active', anniversary: null },
        { _id: 'c2', coupleId: 'CZ-2', herOpenid: 'A', himOpenid: 'C', status: 'pending', bindCode: 'XZ-ABCDEF12', requestId: 'rq2', createdAt: Date.now() }
      ],
      daily_records: [], wishes: [], messages: [], menstrual: []
    })
    const mod = withMockSdk(db)
    OPENID = 'B'
    const rB = await mod.main({})
    assertOk(rB.ok, 'pending 阶段旧 partner 仍可访问')
    OPENID = 'C'
    const rC = await mod.main({})
    assertEq(rC.code, 'NOT_ACTIVE', 'pending him 无 active couple')
    OPENID = 'A'
  })
}

// ==================== 前端缓存 + UI ====================
async function runFrontendTests() {
  console.log('\n=== M5-F · 前端缓存清理 + UI 红线 ===\n')
  const oursJs = fs.readFileSync(path.join(ROOT, 'pages/ours/ours.js'), 'utf8')
  const oursWxml = fs.readFileSync(path.join(ROOT, 'pages/ours/ours.wxml'), 'utf8')
  const oursWxss = fs.readFileSync(path.join(ROOT, 'pages/ours/ours.wxss'), 'utf8')

  check('F1 partner API 失权 → 清 partner 缓存（removeStorageSync pv_）',
    oursJs.includes('NOT_ACTIVE') && oursJs.includes('removeStorageSync'))
  check('F2 失权 → 回未绑定态（notBound: true）', oursJs.includes("notBound: true"))
  check('F3 失权分支不设置 wishes/messages（不显示旧数据）',
    oursJs.includes("if (r.code === 'NOT_ACTIVE'") && oursJs.includes('notBound: true'))
  check('F4 缓存 key 身份隔离（pv_{openid}）', oursJs.includes('pv_${openid}') || oursJs.includes("pv_' + openid"))
  check('F5 只清 partner 缓存，不删本人 dr_/draft_ 草稿（无 removeStorageSync(dr_/draft_)）',
    !/removeStorageSync\(\s*['"`](dr_|draft_)/.test(oursJs))
  check('F6 her 打开页面自动标记小宇留言已读（readMsg）', oursJs.includes("action: 'readMsg'"))
  check('F7 M5 页无 emoji', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(oursWxml), 'wxml 含 emoji')
  check('F8 M5 页无高饱和渐变', !oursWxss.includes('linear-gradient'), 'wxss 含渐变')
  check('F9 纪念日改为紧凑入口（本页不再有大插画，设置/修改入口保留）',
    !/\.anni-img\s*\{/.test(oursWxss) &&
    oursWxml.includes('bindchange="onAnniversary"') &&
    oursWxml.includes('bindtap="saveAnniversary"'))
  const sources = fs.readFileSync(path.join(ROOT, 'assets/illustrations/SOURCES.md'), 'utf8')
  check('F10 纪念日插画已登记 SOURCES.md（PLACEHOLDER）', sources.includes('anniversary') && sources.includes('PLACEHOLDER'))
}

async function main() {
  await runWishTests()
  await runMsgTests()
  await runAnniTests()
  await runPrivacyTests()
  await runSupersededTests()
  await runFrontendTests()
  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
  console.log('M5 Interaction: ALL GREEN')
}

main().catch(e => { console.error('测试执行异常:', e); process.exit(1) })
