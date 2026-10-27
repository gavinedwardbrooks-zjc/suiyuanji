// ============================================================
// tests/m4-menstrual.test.js · M4 经期记录测试（PRD v0.8 / 指令 §13-14）
// A. 纯日期函数（addDays/parseDate/validateCycle）
// B. 云函数 get/save（revision+requestId 契约 / 权限 / V1 兼容）
// C. BUG 回归（calendar 不直写 DB / payload 无 _openid / 身份来自 WXContext）
// D. 范围红线（无排卵/安全期/症状/三色/emoji）
// 运行：node tests/m4-menstrual.test.js
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
  return Promise.resolve().then(fn).then(() => {
    passed++; console.log('  PASS  ' + name)
  }).catch(e => {
    failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message)
  })
}
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)) }
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }

// ---- mock sdk ----
let OPENID = 'her_001'
function withMockSdk(db) {
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test',
        init() {},
        database: () => db,
        getWXContext: () => ({ OPENID })
      }
    }
    return origLoad.apply(this, arguments)
  }
  const fnPath = path.resolve(__dirname, '../cloudfunctions/menstrual/index.js')
  delete require.cache[fnPath]
  const mod = require(fnPath)
  Module._load = origLoad
  return mod
}

function seed(dbExtra) {
  return new MockDB(Object.assign({ users: [], couples: [], daily_records: [], wishes: [] }, dbExtra))
}
function herUser() {
  return { _id: 'u_her', _openid: 'her_001', role: 'her', coupleId: null, schemaVersion: 2 }
}

// ==================== A. 纯日期函数 ====================
async function runDateTests() {
  console.log('\n=== M4-A · 纯日期函数 ===\n')
  const mod = withMockSdk(new MockDB({}))

  await testCase('A1 跨月：2026-08-10 + 28 → 2026-09-07', () => {
    assertEq(mod.addDays('2026-08-10', 28), '2026-09-07')
  })
  await testCase('A2 跨年：2026-12-20 + 28 → 2027-01-17', () => {
    assertEq(mod.addDays('2026-12-20', 28), '2027-01-17')
  })
  await testCase('A3 闰年：2028-02-10 + 28 → 2028-03-09', () => {
    assertEq(mod.addDays('2028-02-10', 28), '2028-03-09')
  })
  await testCase('A4 非法日期拒绝：2026-02-30 → null', () => {
    assertEq(mod.parseDate('2026-02-30'), null)
    assertEq(mod.parseDate('2026-13-01'), null)
    assertEq(mod.parseDate('abc'), null)
  })
  await testCase('A5 合法日期通过', () => {
    assertOk(mod.parseDate('2026-02-28'))
    assertOk(mod.parseDate('2024-02-29')) // 闰年 2/29 合法
  })
  await testCase('A6 cycle 校验：28/15/60 PASS', () => {
    assertOk(mod.validateCycle(28))
    assertOk(mod.validateCycle(15))
    assertOk(mod.validateCycle(60))
  })
  await testCase('A7 cycle 校验：14/61/28.5/字符串/NaN FAIL', () => {
    assertEq(mod.validateCycle(14), false)
    assertEq(mod.validateCycle(61), false)
    assertEq(mod.validateCycle(28.5), false)
    assertEq(mod.validateCycle('28'), false)
    assertEq(mod.validateCycle(NaN), false)
  })
  await testCase('A8 periodLen 校验：5/1/10 PASS，0/11/2.5/字符串 FAIL', () => {
    assertOk(mod.validatePeriodLen(5))
    assertOk(mod.validatePeriodLen(1))
    assertOk(mod.validatePeriodLen(10))
    assertEq(mod.validatePeriodLen(0), false)
    assertEq(mod.validatePeriodLen(11), false)
    assertEq(mod.validatePeriodLen(2.5), false)
    assertEq(mod.validatePeriodLen('5'), false)
  })
}

// ==================== B. 云函数 get/save ====================
async function runCloudTests() {
  console.log('\n=== M4-B · menstrual 云函数 get/save ===\n')

  await testCase('B1 无记录 get → configured=false, record=null（不返回假默认）', async () => {
    const db = seed({ users: [herUser()] })
    const mod = withMockSdk(db)
    const r = await mod.main({ action: 'get' })
    assertOk(r.ok)
    assertEq(r.configured, false)
    assertEq(r.record, null)
    assertEq((db.dump().menstrual || []).length, 0, '不得制造云端记录')
  })

  await testCase('B2 保存成功：revision 0→1，nextStart 正确', async () => {
    const db = seed({ users: [herUser()] })
    const mod = withMockSdk(db)
    const r = await mod.main({ action: 'save', lastStart: '2026-08-10', cycle: 28, requestId: 'r1', revision: 0 })
    assertOk(r.ok)
    assertEq(r.revision, 1)
    assertEq(r.nextStart, '2026-09-07')
    const m = db.dump().menstrual[0]
    assertEq(m.lastStart, '2026-08-10')
    assertEq(m.cycle, 28)
    assertEq(m._openid, 'her_001', 'openid 由服务端注入')
  })

  await testCase('B3 连续修改 revision 1→2→3', async () => {
    const db = seed({ users: [herUser()] })
    const mod = withMockSdk(db)
    await mod.main({ action: 'save', lastStart: '2026-08-10', cycle: 28, requestId: 'a', revision: 0 })
    const r2 = await mod.main({ action: 'save', lastStart: '2026-08-12', cycle: 30, requestId: 'b', revision: 1 })
    assertEq(r2.revision, 2)
    assertEq(r2.nextStart, '2026-09-11')
    const r3 = await mod.main({ action: 'save', lastStart: '2026-08-12', cycle: 30, requestId: 'c', revision: 2 })
    assertEq(r3.revision, 3)
  })

  await testCase('B4 旧 revision 冲突拒绝且数据不变', async () => {
    const db = seed({ users: [herUser()] })
    const mod = withMockSdk(db)
    await mod.main({ action: 'save', lastStart: '2026-08-10', cycle: 28, requestId: 'a', revision: 0 })
    await mod.main({ action: 'save', lastStart: '2026-08-10', cycle: 30, requestId: 'b', revision: 1 })
    const c = await mod.main({ action: 'save', lastStart: '2026-08-20', cycle: 28, requestId: 'c', revision: 1 })
    assertEq(c.ok, false)
    assertEq(c.code, 'REV_CONFLICT')
    assertEq(db.dump().menstrual[0].cycle, 30, '冲突时数据不变')
  })

  await testCase('B5 重复 requestId 幂等（不重复写、revision 不 +1）', async () => {
    const db = seed({ users: [herUser()] })
    const mod = withMockSdk(db)
    await mod.main({ action: 'save', lastStart: '2026-08-10', cycle: 28, requestId: 'dup', revision: 0 })
    const r2 = await mod.main({ action: 'save', lastStart: '2026-08-10', cycle: 28, requestId: 'dup', revision: 0 })
    assertOk(r2.ok)
    assertEq(r2.idempotent, true)
    assertEq(r2.revision, 1, '幂等返回当前 revision 不 +1')
    assertEq(db.dump().menstrual.length, 1, '不得产生第二条记录')
  })

  await testCase('B6 get 返回真实数据（him 视角看到 her 记录）', async () => {
    const db = seed({
      users: [{ _id: 'u_her', _openid: 'her_001', role: 'her', coupleId: 'CZ-1', schemaVersion: 2 },
              { _id: 'u_him', _openid: 'him_001', role: 'him', coupleId: 'CZ-1', schemaVersion: 2 }],
      couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'her_001', himOpenid: 'him_001', status: 'active' }],
      menstrual: [{ _id: 'm1', _openid: 'her_001', lastStart: '2026-08-10', cycle: 28, revision: 3, sharePeriod: true }]
    })
    const mod = withMockSdk(db)
    OPENID = 'him_001'
    const r = await mod.main({ action: 'get' })
    assertOk(r.ok)
    assertEq(r.configured, true)
    assertEq(r.record.lastStart, '2026-08-10')
    assertEq(r.record.nextStart, '2026-09-07')
    assertEq(r.record.revision, 3)
    OPENID = 'her_001'
  })

  await testCase('B7 him 尝试保存 → FORBIDDEN（仅她可写）', async () => {
    const db = seed({
      users: [{ _id: 'u_her', _openid: 'her_001', role: 'her', coupleId: 'CZ-1', schemaVersion: 2 },
              { _id: 'u_him', _openid: 'him_001', role: 'him', coupleId: 'CZ-1', schemaVersion: 2 }],
      couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'her_001', himOpenid: 'him_001', status: 'active' }]
    })
    const mod = withMockSdk(db)
    OPENID = 'him_001'
    const r = await mod.main({ action: 'save', lastStart: '2026-08-10', cycle: 28, requestId: 'x', revision: 0 })
    assertEq(r.ok, false)
    assertEq(r.code, 'FORBIDDEN')
    assertEq((db.dump().menstrual || []).length, 0, 'him 不得写入')
    OPENID = 'her_001'
  })

  await testCase('B8 非法/未来日期与周期拒绝', async () => {
    const db = seed({ users: [herUser()] })
    const mod = withMockSdk(db)
    const bad = await mod.main({ action: 'save', lastStart: '2026-02-30', cycle: 28, requestId: 'x', revision: 0 })
    assertEq(bad.code, 'BAD_ARGS')
    const future = await mod.main({ action: 'save', lastStart: '2999-01-01', cycle: 28, requestId: 'x', revision: 0 })
    assertEq(future.code, 'BAD_ARGS')
    const badCycle = await mod.main({ action: 'save', lastStart: '2026-08-10', cycle: 14, requestId: 'x', revision: 0 })
    assertEq(badCycle.code, 'BAD_ARGS')
  })

  await testCase('B9 V1 兼容：旧记录（cycleLen 无 revision）首次保存成功', async () => {
    const db = seed({
      users: [herUser()],
      menstrual: [{ _id: 'm1', _openid: 'her_001', lastStart: '2026-08-01', cycleLen: 30 }]
    })
    const mod = withMockSdk(db)
    const r = await mod.main({ action: 'save', lastStart: '2026-08-05', cycle: 30, requestId: 'v1up', revision: 0 })
    assertOk(r.ok, 'V1 记录首次保存应成功: ' + JSON.stringify(r))
    assertEq(r.revision, 1)
    assertEq(db.dump().menstrual[0].cycle, 30)
  })

  await testCase('B10 month 视图：仅经期日 + 阅读标记，无排卵/易孕', async () => {
    const db = seed({
      users: [herUser()],
      menstrual: [{ _id: 'm1', _openid: 'her_001', lastStart: '2026-08-10', cycle: 28, revision: 1 }],
      daily_records: [{ _openid: 'her_001', date: '2026-08-15', readProgress: 10 }]
    })
    const mod = withMockSdk(db)
    const r = await mod.main({ action: 'month', year: 2026, month: 8 })
    assertOk(r.ok)
    assertEq(r.configured, true)
    const types = new Set(r.days.filter(d => d.type).map(d => d.type))
    assertEq([...types].join(','), 'period', '只允许 period 标记')
    assertEq(r.days.find(d => d.date === '2026-08-15').read, true, '阅读标记保留')
    assertEq(r.days.filter(d => d.date === '2026-09-07').length, 0, '9 月不在 8 月视图')
  })

  await testCase('B11 无 periodLen 旧记录 get → 读为 5（不写库）', async () => {
    const db = seed({
      users: [herUser()],
      menstrual: [{ _id: 'm1', _openid: 'her_001', lastStart: '2026-08-10', cycle: 28, revision: 1 }]
    })
    const mod = withMockSdk(db)
    const r = await mod.main({ action: 'get' })
    assertOk(r.ok)
    assertEq(r.record.periodLen, 5, '旧记录无 periodLen 读为 5')
    assertEq(r.record.nextPeriodEnd, '2026-09-11', 'nextStart 9/7 + 5-1 = 9/11')
    // 兼容读取不得偷偷写库
    assertEq(db.dump().menstrual[0].periodLen, undefined, '不得因读取而写库')
  })

  await testCase('B12 periodLen=5 → 日历 5 天粉色经期（lastStart 起 5 天）', async () => {
    const db = seed({
      users: [herUser()],
      menstrual: [{ _id: 'm1', _openid: 'her_001', lastStart: '2026-08-10', cycle: 28, periodLen: 5, revision: 1 }]
    })
    const mod = withMockSdk(db)
    const r = await mod.main({ action: 'month', year: 2026, month: 8 })
    const periodDates = r.days.filter(d => d.type === 'period').map(d => d.date)
    assertEq(periodDates.length, 5, '5 天经期日')
    assertEq(periodDates[0], '2026-08-10')
    assertEq(periodDates[4], '2026-08-14', '[lastStart, lastStart+periodLen-1]')
  })

  await testCase('B13 periodLen=1 与 10 均合法可保存', async () => {
    const db = seed({ users: [herUser()] })
    const mod = withMockSdk(db)
    const r1 = await mod.main({ action: 'save', lastStart: '2026-08-10', cycle: 28, periodLen: 1, requestId: 'a', revision: 0 })
    assertOk(r1.ok)
    assertEq(r1.periodLen, 1)
    assertEq(db.dump().menstrual[0].periodLen, 1)
    const r10 = await mod.main({ action: 'save', lastStart: '2026-08-10', cycle: 28, periodLen: 10, requestId: 'b', revision: 1 })
    assertOk(r10.ok)
    assertEq(r10.periodLen, 10)
    assertEq(db.dump().menstrual[0].periodLen, 10)
  })

  await testCase('B14 periodLen=0 / 11 拒绝（BAD_ARGS）', async () => {
    const db = seed({ users: [herUser()] })
    const mod = withMockSdk(db)
    const r0 = await mod.main({ action: 'save', lastStart: '2026-08-10', cycle: 28, periodLen: 0, requestId: 'a', revision: 0 })
    assertEq(r0.code, 'BAD_ARGS')
    const r11 = await mod.main({ action: 'save', lastStart: '2026-08-10', cycle: 28, periodLen: 11, requestId: 'b', revision: 0 })
    assertEq(r11.code, 'BAD_ARGS')
    assertEq((db.dump().menstrual || []).length, 0, '非法请求不得写入')
  })

  await testCase('B15 修改 periodLen 5→6 后 revision+1', async () => {
    const db = seed({ users: [herUser()] })
    const mod = withMockSdk(db)
    await mod.main({ action: 'save', lastStart: '2026-08-10', cycle: 28, periodLen: 5, requestId: 'a', revision: 0 })
    const r2 = await mod.main({ action: 'save', lastStart: '2026-08-10', cycle: 28, periodLen: 6, requestId: 'b', revision: 1 })
    assertOk(r2.ok)
    assertEq(r2.revision, 2)
    assertEq(r2.periodLen, 6)
    assertEq(db.dump().menstrual[0].periodLen, 6)
    assertEq(db.dump().menstrual[0].revision, 2)
  })

  await testCase('B16 periodLen 未传（旧前端兼容）→ 默认 5 保存', async () => {
    const db = seed({ users: [herUser()] })
    const mod = withMockSdk(db)
    const r = await mod.main({ action: 'save', lastStart: '2026-08-10', cycle: 28, requestId: 'legacy', revision: 0 })
    assertOk(r.ok)
    assertEq(r.periodLen, 5, '未传 periodLen 默认 5')
    assertEq(db.dump().menstrual[0].periodLen, 5, '持久化为 5')
  })
}

// ==================== E. 经期共享授权（sharePeriod，Task B5） ====================
async function runShareTests() {
  console.log('\n=== M4-E · 经期共享授权（sharePeriod） ===\n')

  function shareSeed() {
    return seed({
      users: [
        { _id: 'u_her', _openid: 'her_001', role: 'her', coupleId: 'CZ-1', schemaVersion: 2 },
        { _id: 'u_him', _openid: 'him_001', role: 'him', coupleId: 'CZ-1', schemaVersion: 2 }
      ],
      couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'her_001', himOpenid: 'him_001', status: 'active' }],
      menstrual: [{ _id: 'm1', _openid: 'her_001', lastStart: '2026-08-10', cycle: 28, periodLen: 5, revision: 1 }]
    })
  }

  await testCase('E1 默认未授权：him get → shareDenied，record=null', async () => {
    const db = shareSeed() // menstrual 无 sharePeriod 字段 → 默认关
    const mod = withMockSdk(db)
    OPENID = 'him_001'
    const r = await mod.main({ action: 'get' })
    assertOk(r.ok)
    assertEq(r.shareDenied, true)
    assertEq(r.record, null, '未授权不得返回经期数据')
    OPENID = 'her_001'
  })

  await testCase('E2 her 本人读取不受 sharePeriod 影响', async () => {
    const db = shareSeed()
    const mod = withMockSdk(db)
    OPENID = 'her_001'
    const r = await mod.main({ action: 'get' })
    assertOk(r.ok)
    assertEq(r.configured, true)
    assertEq(r.record.lastStart, '2026-08-10')
  })

  await testCase('E3 her 开 sharePeriod → him 可读', async () => {
    const db = shareSeed()
    const mod = withMockSdk(db)
    OPENID = 'her_001'
    const on = await mod.main({ action: 'sharePeriod', share: true })
    assertOk(on.ok)
    assertEq(on.sharePeriod, true)
    assertEq(db.dump().menstrual[0].sharePeriod, true)
    OPENID = 'him_001'
    const r = await mod.main({ action: 'get' })
    assertEq(r.configured, true)
    assertEq(r.record.lastStart, '2026-08-10')
    OPENID = 'her_001'
  })

  await testCase('E4 her 关闭 sharePeriod → him 再次读不到', async () => {
    const db = shareSeed()
    db._data.menstrual[0].sharePeriod = true // 先处于已授权状态
    const mod = withMockSdk(db)
    OPENID = 'her_001'
    await mod.main({ action: 'sharePeriod', share: false })
    assertEq(db.dump().menstrual[0].sharePeriod, false)
    OPENID = 'him_001'
    const r = await mod.main({ action: 'get' })
    assertEq(r.shareDenied, true)
    assertEq(r.record, null)
    OPENID = 'her_001'
  })

  await testCase('E5 him 尝试设置 sharePeriod → FORBIDDEN（仅她可设）', async () => {
    const db = shareSeed()
    const mod = withMockSdk(db)
    OPENID = 'him_001'
    const r = await mod.main({ action: 'sharePeriod', share: true })
    assertEq(r.code, 'FORBIDDEN')
    assertEq(db.dump().menstrual[0].sharePeriod, undefined, 'him 不得写入授权')
    OPENID = 'her_001'
  })

  await testCase('E6 未记录经期 → 不能开 sharePeriod（NOT_CONFIGURED）', async () => {
    const db = shareSeed()
    db._data.menstrual = [] // 无经期记录
    const mod = withMockSdk(db)
    OPENID = 'her_001'
    const r = await mod.main({ action: 'sharePeriod', share: true })
    assertEq(r.code, 'NOT_CONFIGURED')
  })

  await testCase('E7 关系失效（非 active）→ him 读不到（shareDenied）', async () => {
    const db = shareSeed()
    db._data.menstrual[0].sharePeriod = true
    db._data.couples[0].status = 'superseded'
    const mod = withMockSdk(db)
    OPENID = 'him_001'
    const r = await mod.main({ action: 'get' })
    assertEq(r.shareDenied, true)
    assertEq(r.record, null)
    OPENID = 'her_001'
  })
}

// ==================== C. BUG 回归 ====================
async function runBugRegression() {
  console.log('\n=== M4-C · 真实保存 Bug 回归 ===\n')
  const calendarJs = fs.readFileSync(path.join(ROOT, 'pages/calendar/calendar.js'), 'utf8')

  await testCase('BUG-1 calendar 不再直接写 menstrual DB（无 db.collection menstrual）', () => {
    assertEq(calendarJs.includes("db.collection('menstrual')"), false, '不得直接写库')
    assertEq(/collection\(['"]menstrual['"]\)\s*\.\s*(add|update|set)/.test(calendarJs), false)
  })
  await testCase('BUG-2 calendar 保存走 wx.cloud.callFunction → menstrual', () => {
    assertOk(calendarJs.includes("wx.cloud.callFunction({ name: 'menstrual'"))
    assertOk(calendarJs.includes("action: 'save'"))
  })
  await testCase('BUG-3 客户端 save payload 不含 _openid/openid 手写身份', () => {
    assertEq(/action:\s*'save'[\s\S]{0,400}?_openid/.test(calendarJs), false, 'save payload 含 _openid')
    assertEq(/data:\s*\{[\s\S]*?openid\s*:/.test(calendarJs), false, 'save 传 openid')
  })
  await testCase('BUG-4 云函数身份来自 cloud.getWXContext().OPENID', () => {
    const mj = fs.readFileSync(path.join(ROOT, 'cloudfunctions/menstrual/index.js'), 'utf8')
    assertOk(mj.includes('cloud.getWXContext()'))
    assertOk(mj.includes('OPENID'))
  })
  await testCase('BUG-5 保存失败有用户可见反馈（wx.showToast 非仅 console.error）', () => {
    assertOk(calendarJs.includes("wx.showToast({ title: '网络异常，请重试'"))
    assertOk(calendarJs.includes("r.msg || '保存失败'"))
  })
  await testCase('BUG-6 保存成功 nextStart 更新（页面 setData nextLabel）', () => {
    assertOk(calendarJs.includes('nextLabel'))
    assertOk(calendarJs.includes('nextStart'))
  })
}

// ==================== D. 范围红线 ====================
async function runScopeChecks() {
  console.log('\n=== M4-D · 范围红线（无排卵/安全期/症状/三色/emoji） ===\n')

  const calendarWxml = fs.readFileSync(path.join(ROOT, 'pages/calendar/calendar.wxml'), 'utf8')
  const calendarWxss = fs.readFileSync(path.join(ROOT, 'pages/calendar/calendar.wxss'), 'utf8')
  const menstrualJs = fs.readFileSync(path.join(ROOT, 'cloudfunctions/menstrual/index.js'), 'utf8')

  check('D1 云函数无 ovulation/fertile/safePeriod', !/ovulation|fertile|safe/i.test(menstrualJs))
  check('D2 云函数无 symptom/body/flow/pain', !/symptom|body|flow|pain/i.test(menstrualJs))
  check('D3 calendar.wxml 无三色/排卵 UI（fertile/ovu/易孕/安全期）',
    !/fertile|ovu|易孕|安全期|排卵/i.test(calendarWxml))
  check('D4 calendar.wxml 无经期长度 periodLen 输入', !calendarWxml.includes('经期长度'))
  check('D5 calendar.wxml 无 emoji', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(calendarWxml), 'wxml 含 emoji')
  check('D6 calendar.wxml 含预计下次（next-label/next-val）', calendarWxml.includes('next-label') && calendarWxml.includes('next-val'))
  check('D7 calendar.wxml 已移除估算轻提示文案（UI 文案精简）', !calendarWxml.includes('仅根据你填写的周期估算'))
  check('D8 小宇视角仅显示预计日期', calendarWxml.includes('TA 预计下次姨妈'))
  check('D9 wxss 无 fertile/ovu 三色样式', !/\.fertile|\.ovu/.test(calendarWxss))
  check('D10 M4 输入为 lastStart + cycle + periodLen（无排卵/易孕/安全期）',
    calendarJsFile().includes('periodLen') && !/ovulation|fertile|safe|易孕|安全期|排卵/i.test(calendarJsFile()))
  function calendarJsFile() { return fs.readFileSync(path.join(ROOT, 'pages/calendar/calendar.js'), 'utf8') }
}

async function main() {
  await runDateTests()
  await runCloudTests()
  await runShareTests()
  await runBugRegression()
  await runScopeChecks()
  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
  console.log('M4 Menstrual: ALL GREEN')
}

main().catch(e => { console.error('测试执行异常:', e); process.exit(1) })
