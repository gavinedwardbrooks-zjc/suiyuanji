// ============================================================
// tests/account-deletion.test.js · V1.0 数据删除与账号注销（Task E）
// 覆盖：身份验证 / preview 影响范围 / execute 个人数据删除 /
//       共享数据保留 / 越权防护 / 幂等 / preview 只读不删
// 运行：node tests/account-deletion.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const { MockDB } = require('./mock-db')

const ROOT = path.resolve(__dirname, '..')
let passed = 0, failed = 0, failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++; console.log('  PASS  ' + name)
  }).catch(e => {
    failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message)
  })
}
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)) }
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }

let OPENID = 'A'
function loadFn(db) {
  const origLoad = Module._load
  Module._load = function (request) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => db,
        getWXContext: () => ({ OPENID })
      }
    }
    return origLoad.apply(this, arguments)
  }
  const fnPath = path.resolve(__dirname, '../cloudfunctions/deleteAccount/index.js')
  delete require.cache[fnPath]
  const mod = require(fnPath)
  Module._load = origLoad
  return mod
}

function seed() {
  return new MockDB({
    users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', schemaVersion: 2, partnerName: '小胖', bindCode: 'XZ-AAAA' },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', schemaVersion: 2, partnerName: '宝宝', bindCode: 'XZ-BBBB' }
    ],
    couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'active', boundAt: 1000 }],
    daily_records: [
      { _id: 'dr_a', _openid: 'A', coupleId: 'CZ-1', date: '2026-10-18', score: 5 },
      { _id: 'dr_b', _openid: 'B', coupleId: 'CZ-1', date: '2026-10-18', score: 4 }
    ],
    wishes: [
      { _id: 'w_a', _openid: 'A', coupleId: 'CZ-1', text: 'A的心愿' },
      { _id: 'w_b', _openid: 'B', coupleId: 'CZ-1', text: 'B的心愿' }
    ],
    menstrual: [{ _id: 'm_a', _openid: 'A', lastStart: '2026-10-01' }],
    profiles: [{ _id: 'p_a', _openid: 'A' }],
    books: [{ _id: 'bk_a', _openid: 'A', title: 'A的书' }],
    messages: [
      { _id: 'msg_a', coupleId: 'CZ-1', fromOpenid: 'A', text: 'A发的' },
      { _id: 'msg_b', coupleId: 'CZ-1', fromOpenid: 'B', text: 'B发的' }
    ],
    weekly_reports: [{ _id: 'wr_1', coupleId: 'CZ-1', dateRange: '2026-10-12_2026-10-18' }]
  })
}

function dump(db) { return db.dump() }

async function runAll() {
  console.log('\n=== U · 身份验证 ===\n')

  await testCase('U1 无 OPENID → UNAUTHORIZED（preview 与 execute 均拒绝）', async () => {
    const db = seed()
    const mod = loadFn(db)
    OPENID = undefined
    const p = await mod.main({ action: 'preview' })
    const e = await mod.main({ action: 'execute' })
    assertEq(p.code, 'UNAUTHORIZED')
    assertEq(e.code, 'UNAUTHORIZED')
    OPENID = 'A'
  })

  await testCase('U2 未知 action → BAD_ACTION', async () => {
    const db = seed()
    const mod = loadFn(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'nope' })
    assertEq(r.code, 'BAD_ACTION')
  })

  console.log('\n=== P · preview 影响范围 ===\n')

  await testCase('P1 preview 返回个人数据计数 + 绑定状态', async () => {
    const db = seed()
    const mod = loadFn(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'preview' })
    assertOk(r.ok)
    assertEq(r.bound, true)
    assertEq(r.willUnbind, true)
    assertEq(r.willDelete.daily_records, 1)
    assertEq(r.willDelete.wishes, 1)
    assertEq(r.willDelete.menstrual, 1)
    assertEq(r.willDelete.profiles, 1)
    assertEq(r.willDelete.books, 1)
    assertEq(r.willDelete.messages, 1, '只统计自己发的留言')
    assertEq(r.willDelete.users, 1)
    assertOk(r.sharedKept && r.sharedKept.couples, '应说明共享数据的保留方式')
  })

  await testCase('P2 preview 只读不删：数据原样保留', async () => {
    const db = seed()
    const mod = loadFn(db)
    OPENID = 'A'
    await mod.main({ action: 'preview' })
    const d = dump(db)
    assertEq(d.daily_records.length, 2)
    assertEq(d.users.length, 2)
    assertEq(d.messages.length, 2)
    assertEq(d.couples[0].status, 'active')
  })

  console.log('\n=== E · execute 注销删除 ===\n')

  await testCase('E1 execute 删除本人个人数据 + 解绑对方', async () => {
    const db = seed()
    const mod = loadFn(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'execute' })
    assertOk(r.ok, JSON.stringify(r))
    const d = dump(db)
    // 个人数据：只删 A 的
    assertEq(d.daily_records.length, 1)
    assertEq(d.daily_records[0]._openid, 'B', 'A 的记录被删，B 保留')
    assertEq(d.wishes.length, 1)
    assertEq(d.wishes[0]._openid, 'B')
    assertEq(d.menstrual.length, 0)
    assertEq(d.profiles.length, 0)
    assertEq(d.books.length, 0)
    assertEq(d.messages.length, 1)
    assertEq(d.messages[0].fromOpenid, 'B', 'A 发的留言被删，B 发的保留')
    // 用户档案：A 被删，B 保留
    assertEq(d.users.length, 1)
    assertEq(d.users[0]._openid, 'B')
    // 解绑：couples → unbound，B 的 coupleId/bindCode/partnerName 清空
    assertEq(d.couples[0].status, 'unbound')
    assertEq(d.users[0].coupleId, null, 'B 的 coupleId 清空')
    assertEq(d.users[0].partnerName, '', 'B 的称呼清空（不跨关系继承）')
    assertEq(d.users[0].bindCode, undefined, 'B 的 bindCode 清空')
  })

  await testCase('E2 共享数据保留：couples 文档与周报不物理删除', async () => {
    const db = seed()
    const mod = loadFn(db)
    OPENID = 'A'
    await mod.main({ action: 'execute' })
    const d = dump(db)
    assertEq(d.couples.length, 1, 'couples 文档保留（仅置 unbound）')
    assertEq(d.weekly_reports.length, 1, '周报保留')
  })

  await testCase('E3 越权防护：不能删除对方数据', async () => {
    const db = seed()
    const mod = loadFn(db)
    OPENID = 'A'
    await mod.main({ action: 'execute' })
    const d = dump(db)
    // B 的数据完整保留
    assertEq(d.daily_records.filter(x => x._openid === 'B').length, 1)
    assertEq(d.wishes.filter(x => x._openid === 'B').length, 1)
    assertEq(d.messages.filter(x => x.fromOpenid === 'B').length, 1)
  })

  await testCase('E4 未绑定用户 execute：无解绑，正常删个人数据', async () => {
    const db = seed()
    db._data.users.find(u => u._openid === 'A').coupleId = null
    db._data.couples = [] // 无 active 关系
    const mod = loadFn(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'execute' })
    assertOk(r.ok)
    const d = dump(db)
    assertEq(d.users.length, 1)
    assertEq(d.users[0]._openid, 'B')
    assertEq(d.daily_records.length, 1)
  })

  await testCase('E5 幂等：重复 execute 无数据可删仍 ok', async () => {
    const db = seed()
    const mod = loadFn(db)
    OPENID = 'A'
    await mod.main({ action: 'execute' })
    const r2 = await mod.main({ action: 'execute' })
    assertOk(r2.ok)
    assertEq(r2.deleted.users, 0, '第二次用户档案已不存在')
    assertEq(r2.deleted.daily_records, 0)
    assertEq(dump(db).daily_records.filter(x => x._openid === 'B').length, 1, 'B 数据始终保留')
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
  console.log('Account Deletion: ALL GREEN')
}

runAll().catch(e => { console.error('测试执行异常:', e); process.exit(1) })
