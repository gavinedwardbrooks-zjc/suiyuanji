// ============================================================
// tests/record-restore.test.js · 记录页状态恢复（M5 心愿同步修复）
// A. draft 含 eats/dos → 恢复保持
// B. draft 1 eat + 1 do → save payload wishCount=2
// C. 恢复→保存→wishes collection 同步 2 条（mock db 全链路）
// D. 旧 draft 仅 wishes → fallback 兼容
// E. 云端 record.wishes 恢复不受影响
// 运行：node tests/record-restore.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const { MockDB } = require('./mock-db')
const { fromDraft, fromRecordWishes } = require('../utils/record-restore')

const ROOT = path.resolve(__dirname, '..')
let passed = 0, failed = 0, failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name) })
    .catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message) })
}
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)) }
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }

// 模拟 record.js 的 save payload 构建（与前端 save() 同源）
function buildWishes(eats, dos) {
  return [...eats.map(t => ({ type: 'eat', text: t })), ...dos.map(t => ({ type: 'do', text: t }))]
}

let OPENID = 'A'
function loadDaily(db) {
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return { DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => db, getWXContext: () => ({ OPENID }) }
    }
    return origLoad.apply(this, arguments)
  }
  const fnPath = path.resolve(__dirname, '../cloudfunctions/dailyRecord/index.js')
  delete require.cache[fnPath]
  const mod = require(fnPath)
  Module._load = origLoad
  return mod
}

async function runAll() {
  console.log('\n=== 记录页状态恢复（草稿 schema 修复） ===\n')

  await testCase('A 草稿含 eats/dos → fromDraft 恢复保持', () => {
    const r = fromDraft({ eats: ['螺蛳粉', '火锅'], dos: ['烤肉'] })
    assertEq(r.eats.length, 2)
    assertEq(r.dos.length, 1)
    assertEq(r.eats[0], '螺蛳粉')
    assertEq(r.dos[0], '烤肉')
  })

  await testCase('B 草稿 1 eat + 1 do → save payload wishCount=2', () => {
    const { eats, dos } = fromDraft({ eats: ['螺蛳粉'], dos: ['烤肉'] })
    const wishes = buildWishes(eats, dos)
    assertEq(wishes.length, 2)
    assertEq(wishes[0].type, 'eat')
    assertEq(wishes[1].type, 'do')
  })

  await testCase('C 恢复→保存→wishes collection 同步 2 条（全链路）', async () => {
    const db = new MockDB({
      users: [{ _id: 'u_a', _openid: 'A', role: 'her', coupleId: null, schemaVersion: 2 }],
      couples: [], daily_records: [], wishes: [], messages: [], menstrual: []
    })
    // 1) 模拟草稿恢复（切页回来场景）
    const { eats, dos } = fromDraft({ eats: ['螺蛳粉'], dos: ['烤肉'] })
    // 2) 保存
    const daily = loadDaily(db)
    const r = await daily.main({
      action: 'save', date: '2026-08-27', requestId: 'req-c1', revision: 0,
      goals: [], todos: [], segments: {}, mood: {},
      wishes: buildWishes(eats, dos), score: 4, readProgress: 0
    })
    assertOk(r.ok)
    // 3) wishes collection 应有 2 条
    assertEq(db.dump().wishes.length, 2, '同步 2 条')
    assertEq(db.dump().wishes.filter(w => w.type === 'eat').length, 1)
    assertEq(db.dump().wishes.filter(w => w.type === 'do').length, 1)
  })

  await testCase('D 旧草稿仅 wishes → fallback 兼容恢复', () => {
    const r = fromDraft({ wishes: [{ type: 'eat', text: '螺蛳粉' }, { type: 'do', text: '烤肉' }] })
    assertEq(r.eats.join(','), '螺蛳粉')
    assertEq(r.dos.join(','), '烤肉')
  })

  await testCase('D2 草稿同时有 eats 与 wishes → 优先 eats/dos', () => {
    const r = fromDraft({ eats: ['A'], wishes: [{ type: 'eat', text: 'B' }] })
    assertEq(r.eats.join(','), 'A', '优先 eats 数组')
  })

  await testCase('E 云端 record.wishes 恢复不受影响', () => {
    const r = fromRecordWishes({ wishes: [{ type: 'eat', text: '螺蛳粉' }, { type: 'do', text: '烤肉' }] })
    assertEq(r.eats.join(','), '螺蛳粉')
    assertEq(r.dos.join(','), '烤肉')
  })

  await testCase('E2 云端 record 无 wishes → 空数组', () => {
    const r = fromRecordWishes({ score: 4 })
    assertEq(r.eats.length, 0)
    assertEq(r.dos.length, 0)
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
  console.log('Record Restore: ALL GREEN')
}

runAll().catch(e => { console.error('测试执行异常:', e); process.exit(1) })
