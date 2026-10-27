// ============================================================
// tests/p3-3-privacy.test.js · V1.1 收尾后：分享接口的标识不外泄
//
// 来源：P3.3 任务 A（消除 OPENID 泄露）。原用例覆盖留言 / 点赞响应，
// 记录级互动已在 V1.1 收尾移除，本文件只保留仍然存在的分享接口：
//   · view(him) / view(her) / shareStatus / shareSet：响应任何层级都不含 openid
//   · 错误响应（BAD_ARGS / FORBIDDEN / NO_RECORD / DB_ERROR / NOT_ACTIVE）同样不泄露
//   · 已移除的 action（like / comment）不得复活：返回 BAD_ACTION，不写库
//
// 运行：node tests/p3-3-privacy.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const { MockDB } = require('./mock-db')

const ROOT = path.resolve(__dirname, '..')
const D1 = '2026-10-20'
const HER_A = 'A_her_openid'
const HIM_B = 'B_him_openid'
const HER_C = 'C_her_openid'
const HIM_D = 'D_him_openid'
const SECRETS = [HER_A, HIM_B, HER_C, HIM_D]

// 响应里**任何层级**都不允许出现的字段名
const FORBIDDEN_KEYS = [
  '_openid', 'openid', 'OPENID', 'actorOpenid', 'ownerOpenid',
  'fromOpenid', 'herOpenid', 'himOpenid', 'requestId'
]

let OPENID = HER_A
let passed = 0, failed = 0, failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name) })
    .catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message) })
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a))
}
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }

// 递归收集所有 key（含数组元素、嵌套对象）
function collectKeys(v, out) {
  if (Array.isArray(v)) { for (const x of v) collectKeys(x, out); return out }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) { out.add(k); collectKeys(v[k], out) }
  }
  return out
}

// 一条断言覆盖「值泄露」与「字段泄露」两件事
function assertNoSecrets(res, label, extraSecrets) {
  const json = JSON.stringify(res)
  assertOk(json !== undefined, label + ' 响应不可序列化')
  for (const s of SECRETS.concat(extraSecrets || [])) {
    assertOk(json.indexOf(s) === -1, label + ' 响应含 openid 值：' + s)
  }
  const keys = collectKeys(res, new Set())
  for (const k of FORBIDDEN_KEYS) {
    assertOk(!keys.has(k), label + ' 响应含敏感字段名：' + k)
  }
}

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

function seed() {
  return {
    users: [
      { _id: 'uA', _openid: HER_A, role: 'her', coupleId: 'CZ-1', partnerName: '' },
      { _id: 'uB', _openid: HIM_B, role: 'him', coupleId: 'CZ-1', partnerName: '' },
      { _id: 'uC', _openid: HER_C, role: 'her', coupleId: 'CZ-2', partnerName: '' },
      { _id: 'uD', _openid: HIM_D, role: 'him', coupleId: 'CZ-2', partnerName: '' }
    ],
    couples: [
      { _id: 'c1', coupleId: 'CZ-1', status: 'active', herOpenid: HER_A, himOpenid: HIM_B, anniversary: null },
      { _id: 'c2', coupleId: 'CZ-2', status: 'active', herOpenid: HER_C, himOpenid: HIM_D, anniversary: null }
    ],
    daily_records: [{
      _openid: HER_A, date: D1, coupleId: 'CZ-1', revision: 2,
      goals: [], todos: [], segments: { life: '生活', work: '工作', growth: '成长' },
      mood: { type: 'calm', weather: 'sunny' }, score: 3, wishes: []
    }, {
      _openid: HER_C, date: D1, coupleId: 'CZ-2', revision: 2,
      goals: [], todos: [], segments: { life: 'C 的生活', work: '', growth: '' },
      mood: { type: 'calm', weather: 'sunny' }, score: 3, wishes: []
    }],
    record_shares: [{
      _id: 'sh_' + HER_A + '_' + D1, _openid: HER_A, date: D1,
      coupleId: 'CZ-1', himOpenid: HIM_B, enabled: true, rev: 3, createdAt: 1, updatedAt: 1
    }]
  }
}

// P3.3-R1（D2）：shareSet 需要客户端已确认的版本号 → 统一按库内当前版本提交
function curRevOf(db, openid, date) {
  const d = (db.dump().record_shares || []).find(x => x._openid === openid && x.date === date)
  if (!d) return 0
  return typeof d.rev === 'number' && d.rev >= 0 ? d.rev : 0
}
function setShare(fn, db, date, enabled, expectedRev) {
  const rev = expectedRev === undefined ? curRevOf(db, OPENID, date) : expectedRev
  return fn.main({ action: 'shareSet', date, enabled, expectedRev: rev })
}

async function main() {
  console.log('\n=== 分享接口不泄露 openid ===\n')

  await testCase('A1 view(him) 已共享：响应不含任何 openid，且只含白名单内容', async () => {
    const db = new MockDB(seed())
    const fn = loadFn(db)
    OPENID = HIM_B
    const v = await fn.main({ action: 'view', date: D1 })
    assertNoSecrets(v, 'view(him)')
    assertOk(v.shared, '已共享时应有 shared')
    assertEq(Object.keys(v.shared).sort().join(','), 'mood,segments')
    assertEq(Object.keys(v.shared.mood).sort().join(','), 'type,weather')
    assertEq(Object.keys(v.shared.segments).sort().join(','), 'growth,life,work')
  })

  await testCase('A2 view(her)：自己的视图同样不含 openid 字段', async () => {
    const db = new MockDB(seed())
    const fn = loadFn(db)
    OPENID = HER_A
    assertNoSecrets(await fn.main({ action: 'view', date: D1 }), 'view(her)')
  })

  await testCase('A3 shareStatus：不含 openid，也不含已移除的 interactions 字段', async () => {
    const db = new MockDB(seed())
    const fn = loadFn(db)
    OPENID = HER_A
    const s = await fn.main({ action: 'shareStatus', date: D1 })
    assertNoSecrets(s, 'shareStatus')
    assertEq(Object.keys(s).sort().join(','), 'canShare,date,enabled,hasRecord,ok,rev',
      'shareStatus 字段集合固定（互动字段已移除）')
  })

  await testCase('A4 shareSet（开 / 关）：不泄露 openid，且只回状态与版本号', async () => {
    const db = new MockDB(seed())
    const fn = loadFn(db)
    OPENID = HER_A
    const off = await setShare(fn, db, D1, false)
    assertNoSecrets(off, 'shareSet(off)')
    const on = await setShare(fn, db, D1, true)
    assertNoSecrets(on, 'shareSet(on)')
    assertEq(Object.keys(on).sort().join(','), 'date,enabled,ok,rev')
  })

  await testCase('A5 错误响应同样不泄露（BAD_ARGS / FORBIDDEN / NO_RECORD / DB_ERROR / CONFLICT）', async () => {
    const db = new MockDB(seed())
    const fn = loadFn(db)

    OPENID = HER_A
    assertNoSecrets(await fn.main({ action: 'shareSet', date: '2026-02-30', enabled: true, expectedRev: 3 }), 'BAD_ARGS(date)')
    assertNoSecrets(await fn.main({ action: 'shareSet', date: D1, enabled: 'true', expectedRev: 3 }), 'BAD_ARGS(enabled)')
    assertNoSecrets(await fn.main({ action: 'shareSet', date: D1, enabled: true, expectedRev: '3' }), 'BAD_ARGS(expectedRev)')
    assertNoSecrets(await fn.main({ action: 'shareSet', date: D1, enabled: true }), 'CONFLICT(缺少版本号)')
    assertNoSecrets(await fn.main({ action: 'shareStatus', date: '2026-02-30' }), 'BAD_ARGS(shareStatus)')

    // 没有记录的那一天
    assertNoSecrets(await fn.main({ action: 'shareSet', date: '2026-10-19', enabled: true, expectedRev: 0 }), 'NO_RECORD')

    // him 不能操作分享
    OPENID = HIM_B
    assertNoSecrets(await fn.main({ action: 'shareSet', date: D1, enabled: true, expectedRev: 3 }), 'FORBIDDEN')

    // 写入失败
    OPENID = HER_A
    db.injectFail('record_shares', 'update')
    const dbErr = await fn.main({ action: 'shareSet', date: D1, enabled: false, expectedRev: 3 })
    assertEq(dbErr.ok, false)
    assertEq(dbErr.code, 'DB_ERROR', '写入失败必须明确失败')
    assertNoSecrets(dbErr, 'DB_ERROR')
  })

  await testCase('A6 已移除的互动 action 不得复活：like / comment → BAD_ACTION，零写入', async () => {
    const db = new MockDB(seed())
    const fn = loadFn(db)
    OPENID = HIM_B
    for (const action of ['like', 'comment']) {
      const r = await fn.main({ action, date: D1, liked: true, text: 'x', requestId: 'req_1' })
      assertEq(r.ok, false, action + ' 必须不可用')
      assertEq(r.code, 'BAD_ACTION')
      assertNoSecrets(r, action)
    }
    assertEq((db.dump().record_interactions || []).length, 0, '不得写任何互动文档')
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    console.log('\n失败用例:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('P3.3 Privacy (share-only): ALL GREEN')
}

main()
