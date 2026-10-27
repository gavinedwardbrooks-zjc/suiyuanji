// ============================================================
// tests/wish-integration.test.js · M2→M5 心愿集成链路回归
// 记录页 save → dailyRecord syncWishes → wishes collection → getPartnerView → ours
// 覆盖：同步/去重/已安排保护/requestId 幂等/her-him 双视角
// 运行：node tests/wish-integration.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const { MockDB } = require('./mock-db')

const ROOT = path.resolve(__dirname, '..')
let passed = 0, failed = 0, failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name) })
    .catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message) })
}
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)) }
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }

let OPENID = 'A'

// 加载指定云函数（mock sdk 注入）
function loadFn(name, db) {
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test', init() {},
        database: () => db, getWXContext: () => ({ OPENID }),
        openapi: { subscribeMessage: { send: async () => ({ errCode: 0 }) } }
      }
    }
    return origLoad.apply(this, arguments)
  }
  const fnPath = path.resolve(__dirname, '../cloudfunctions/' + name + '/index.js')
  delete require.cache[fnPath]
  const mod = require(fnPath)
  Module._load = origLoad
  return mod
}

function seed() {
  return new MockDB({
    users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', schemaVersion: 2 },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', schemaVersion: 2 }
    ],
    couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'active', anniversary: null }],
    daily_records: [], wishes: [], messages: [], menstrual: []
  })
}
function saveEvent(wishes, over) {
  return Object.assign({
    action: 'save', date: '2026-08-27', requestId: 'req-1', revision: 0,
    goals: [], todos: [], segments: { life: '', work: '', growth: '' },
    mood: { type: 'calm', weather: 'sunny' },
    wishes,
    score: 4, readProgress: 0
  }, over || {})
}

async function runAll() {
  console.log('\n=== M2→M5 心愿集成链路 ===\n')

  await testCase('I1 record save（想吃螺蛳粉）→ wishes 出现 1 条 pending', async () => {
    const db = seed()
    const daily = loadFn('dailyRecord', db)
    const r = await daily.main(saveEvent([{ type: 'eat', text: '螺蛳粉' }]))
    assertOk(r.ok)
    const w = db.dump().wishes
    assertEq(w.length, 1)
    assertEq(w[0].type, 'eat')
    assertEq(w[0].text, '螺蛳粉')
    assertEq(w[0].status, 'pending')
  })

  await testCase('I2 getPartnerView her view → 能读到自己的心愿', async () => {
    const db = seed()
    await loadFn('dailyRecord', db).main(saveEvent([{ type: 'eat', text: '螺蛳粉' }]))
    OPENID = 'A'
    const pv = loadFn('getPartnerView', db)
    const r = await pv.main({})
    assertOk(r.ok)
    assertEq(r.wishes.length, 1, 'her 视角应读到自己的心愿')
    assertEq(r.wishes[0].text, '螺蛳粉')
  })

  await testCase('I3 him view → 读到 her 心愿并可「已安排」', async () => {
    const db = seed()
    await loadFn('dailyRecord', db).main(saveEvent([{ type: 'eat', text: '螺蛳粉' }]))
    OPENID = 'B'
    const pv = loadFn('getPartnerView', db)
    const r = await pv.main({})
    assertOk(r.ok)
    assertEq(r.wishes.length, 1)
    const mark = await pv.main({ action: 'mark', wishId: r.wishes[0]._id })
    assertOk(mark.ok)
    assertEq(db.dump().wishes[0].status, 'done_by_partner')
    OPENID = 'A' // 恢复（防后续用例视角泄漏）
  })

  await testCase('I4 同一天重复保存相同心愿 → 不重复', async () => {
    const db = seed()
    const daily = loadFn('dailyRecord', db)
    await daily.main(saveEvent([{ type: 'eat', text: '螺蛳粉' }]))
    await daily.main(saveEvent([{ type: 'eat', text: '螺蛳粉' }], { requestId: 'req-2', revision: 1 }))
    assertEq(db.dump().wishes.length, 1, '第二次保存不新增')
  })

  await testCase('I5 「螺蛳粉」与「 螺蛳粉 」同类型 → 不重复（trim 全等）', async () => {
    const db = seed()
    const daily = loadFn('dailyRecord', db)
    await daily.main(saveEvent([{ type: 'eat', text: '螺蛳粉' }]))
    await daily.main(saveEvent([{ type: 'eat', text: '  螺蛳粉  ' }], { requestId: 'req-2', revision: 1 }))
    assertEq(db.dump().wishes.length, 1, 'trim 后相同不重复')
    assertEq(db.dump().wishes[0].text, '螺蛳粉')
  })

  await testCase('I6 想吃螺蛳粉 + 想做螺蛳粉（不同类型）→ 可同时存在', async () => {
    const db = seed()
    const daily = loadFn('dailyRecord', db)
    await daily.main(saveEvent([{ type: 'eat', text: '螺蛳粉' }, { type: 'do', text: '螺蛳粉' }]))
    assertEq(db.dump().wishes.length, 2, '不同类型各自独立')
  })

  await testCase('I7 已 done_by_partner 心愿再次保存 record → 不重置为 pending、不重复创建', async () => {
    const db = seed()
    const daily = loadFn('dailyRecord', db)
    await daily.main(saveEvent([{ type: 'eat', text: '螺蛳粉' }]))
    // him 已安排
    OPENID = 'B'
    const pv = loadFn('getPartnerView', db)
    const v = await pv.main({})
    await pv.main({ action: 'mark', wishId: v.wishes[0]._id })
    OPENID = 'A'
    // her 再次保存当天记录（心愿仍含螺蛳粉）
    await daily.main(saveEvent([{ type: 'eat', text: '螺蛳粉' }], { requestId: 'req-2', revision: 1 }))
    assertEq(db.dump().wishes.length, 1, '不重复创建 pending 副本')
    assertEq(db.dump().wishes[0].status, 'done_by_partner', '已安排状态不被重置')
  })

  await testCase('I8 保存重试（requestId 重复）→ 不产生第二条 wish', async () => {
    const db = seed()
    const daily = loadFn('dailyRecord', db)
    await daily.main(saveEvent([{ type: 'eat', text: '螺蛳粉' }]))
    const r2 = await daily.main(saveEvent([{ type: 'eat', text: '螺蛳粉' }], { requestId: 'req-1' })) // 同 requestId
    assertOk(r2.ok)
    assertEq(r2.idempotent, true)
    assertEq(db.dump().wishes.length, 1, '幂等重试不新增 wish')
  })

  await testCase('I10 syncWishes 写失败 → 不得无痕：save 返回 wishSyncFailed 且主记录仍成功', async () => {
    const db = seed()
    db.injectFail('wishes', 'add') // 模拟真云 wishes add 失败
    const daily = loadFn('dailyRecord', db)
    const r = await daily.main(saveEvent([{ type: 'eat', text: '螺蛳粉' }]))
    assertOk(r.ok, '主记录保存仍成功')
    assertEq(r.wishSyncFailed, true, '必须返回明确错误标志（不静默）')
    assertEq(db.dump().daily_records.length, 1, '主记录已落库')
    assertEq((db.dump().wishes || []).length, 0, 'wishes 未写入（故障注入生效）')
  })

  await testCase('I9 her view 经期预计读自己的（不与 him 错位）', async () => {
    const db = seed()
    await db.collection('menstrual').add({ data: { _openid: 'A', lastStart: '2026-08-10', cycle: 28, periodLen: 5, revision: 1 } })
    OPENID = 'A'
    const pv = loadFn('getPartnerView', db)
    const r = await pv.main({})
    assertOk(r.ok)
    assertOk(r.nextLabel && r.nextLabel.includes('月'), 'her 侧应显示自己的经期预计: ' + JSON.stringify(r))
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
  console.log('Wish Integration: ALL GREEN')
}

runAll().catch(e => { console.error('测试执行异常:', e); process.exit(1) })
