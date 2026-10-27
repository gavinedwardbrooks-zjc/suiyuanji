// ============================================================
// tests/v1-compat.test.js · M2 收尾 V1 daily_records 兼容测试
// 覆盖指令"必须复核"：
//   1. 旧 daily_records 数据可正常读取
//   2. 旧字段不丢失（summary/summaryAt 等）
//   3. 保存 payload 不删除未知/旧字段
//   4. 已有目标/小事数据仍能显示
//   5. 历史记录能打开
//   6. 不因 schemaVersion 缺失而报错
// 数据源：tests/v1-fixture.json 的真实结构 V1 daily_records
// 运行：node tests/v1-compat.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const { MockDB } = require('./mock-db')
const v1Fixture = require('./v1-fixture.json')

const OPENID = 'v1_user_001'

let passed = 0
let failed = 0
const failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++
    console.log('  PASS  ' + name)
  }).catch(e => {
    failed++
    failures.push({ name, error: e.message })
    console.log('  FAIL  ' + name + '  -> ' + e.message)
  })
}

// 拦截 wx-server-sdk，返回注入 MockDB 的假 sdk
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
  const fnPath = path.resolve(__dirname, '../cloudfunctions/dailyRecord/index.js')
  delete require.cache[fnPath]
  const mod = require(fnPath)
  Module._load = origLoad
  return mod
}

// 从 V1 fixture 取第一条 daily_records（真实 V1 结构，无 schemaVersion / revision）
// 补 _id：真实库中自动生成，mock 的 doc().update 需要
function v1Record(id) {
  const r = JSON.parse(JSON.stringify(v1Fixture.daily_records[0]))
  r._id = id || 'v1_daily_rec_1'
  return r
}

async function runAll() {
  console.log('\n=== M2 收尾 · V1 daily_records 兼容测试 ===\n')

  await testCase('V1-1 get 正常读取 V1 记录（无 schemaVersion 不报错）', async () => {
    const db = new MockDB({ daily_records: [v1Record()], wishes: [] })
    const mod = withMockSdk(db)
    const g = await mod.main({ action: 'get', date: '2026-08-20' })
    assertEq(g.ok, true)
    assertEq(g.record.schemaVersion, 2, '惰性迁移补 schemaVersion')
    assertEq(g.record.goals.length, 3, 'V1 goals 完整返回')
    assertEq(g.record.todos.length, 2, 'V1 todos 完整返回')
  })

  await testCase('V1-2 get 后旧字段不丢失（summary/summaryAt/createdAt 保留）', async () => {
    const db = new MockDB({ daily_records: [v1Record()], wishes: [] })
    const mod = withMockSdk(db)
    const g = await mod.main({ action: 'get', date: '2026-08-20' })
    assertEq(g.record.summary, '又度过平静的一天。', 'V1 summary 保留')
    assertEq(g.record.summaryAt, '8月20日', 'V1 summaryAt 保留')
    assertEq(g.record.createdAt, 1700002000000, 'V1 createdAt 保留')
    assertEq(g.record.mood.type, 'calm', 'V1 mood 保留')
    assertEq(g.record.score, 4, 'V1 score 保留')
    assertEq(g.record.readProgress, 30, 'V1 readProgress 保留')
  })

  await testCase('V1-3 V1 记录首次 save（revision 缺失按 0）→ revision 0→1，旧字段不丢失', async () => {
    const db = new MockDB({ daily_records: [v1Record()], wishes: [] })
    const mod = withMockSdk(db)
    const res = await mod.main({
      action: 'save',
      date: '2026-08-20',
      requestId: 'v1_save_1',
      revision: 0,
      goals: v1Record().goals,
      todos: v1Record().todos,
      segments: { life: '更新后的生活段', work: v1Record().segments.work, growth: v1Record().segments.growth },
      mood: { type: 'happy', weather: 'sunny' },
      wishes: [],
      score: 5,
      readProgress: 30
    })
    assertEq(res.ok, true, 'V1 记录首次 save 应成功')
    assertEq(res.revision, 1, 'V1 无 revision → 首次更新应为 1，不得为 NaN')
    const rec = db.dump().daily_records[0]
    assertEq(rec.revision, 1)
    assertEq(rec.summary, '又度过平静的一天。', '旧字段 summary 不得被删除')
    assertEq(rec.summaryAt, '8月20日', '旧字段 summaryAt 不得被删除')
    assertEq(rec.createdAt, 1700002000000, '旧字段 createdAt 不得被删除')
    assertEq(rec.mood.type, 'happy', '新字段正常写入')
    assertEq(rec.score, 5, '新 score 写入')
  })

  await testCase('V1-4 V1 记录连续 save：revision 1→2，仍保留旧字段', async () => {
    const db = new MockDB({ daily_records: [v1Record()], wishes: [] })
    const mod = withMockSdk(db)
    await mod.main({ action: 'save', date: '2026-08-20', requestId: 'a', revision: 0, goals: v1Record().goals, todos: v1Record().todos, segments: v1Record().segments, mood: v1Record().mood, wishes: [], score: 4, readProgress: 30 })
    const r2 = await mod.main({ action: 'save', date: '2026-08-20', requestId: 'b', revision: 1, goals: v1Record().goals, todos: v1Record().todos, segments: v1Record().segments, mood: v1Record().mood, wishes: [], score: 3, readProgress: 30 })
    assertEq(r2.ok, true)
    assertEq(r2.revision, 2)
    const rec = db.dump().daily_records[0]
    assertEq(rec.revision, 2)
    assertEq(rec.summary, '又度过平静的一天。', '二次保存后旧字段仍保留')
    assertEq(rec.score, 3)
  })

  await testCase('V1-5 历史记录能打开（不同 date 的 V1 记录独立 get）', async () => {
    const r1 = v1Record('v1_rec_a')
    const r2 = v1Record('v1_rec_b')
    r2.date = '2026-08-19'
    r2.segments = { life: '昨天的生活', work: '', growth: '' }
    const db = new MockDB({ daily_records: [r1, r2], wishes: [] })
    const mod = withMockSdk(db)
    const g = await mod.main({ action: 'get', date: '2026-08-19' })
    assertEq(g.ok, true)
    assertEq(g.record.date, '2026-08-19')
    assertEq(g.record.segments.life, '昨天的生活', '历史记录内容正确')
    assertEq(g.record.schemaVersion, 2)
  })

  await testCase('V1-6 V1 记录冲突保护仍生效（旧 revision 拒绝覆盖）', async () => {
    const db = new MockDB({ daily_records: [v1Record()], wishes: [] })
    const mod = withMockSdk(db)
    await mod.main({ action: 'save', date: '2026-08-20', requestId: 'a', revision: 0, goals: [], todos: [], segments: { life: 'x', work: '', growth: '' }, mood: { type: 'calm', weather: 'sunny' }, wishes: [], score: 1, readProgress: 0 })
    // 再用 revision=0 提交（另一个请求）→ 冲突
    const conflict = await mod.main({ action: 'save', date: '2026-08-20', requestId: 'c', revision: 0, goals: [], todos: [], segments: { life: 'y', work: '', growth: '' }, mood: { type: 'low', weather: 'rainy' }, wishes: [], score: 9, readProgress: 0 })
    assertEq(conflict.ok, false)
    assertEq(conflict.code, 'REV_CONFLICT')
    assertEq(db.dump().daily_records[0].score, 1, '冲突时数据不得被覆盖')
    assertEq(db.dump().daily_records[0].summary, '又度过平静的一天。', '冲突时旧字段仍保留')
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failures.length) {
    failures.forEach(f => console.log('  - ' + f.name + ': ' + f.error))
    process.exit(1)
  }
  console.log('M2 V1 compatibility: ALL GREEN')
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || '') + ' 期望 ' + JSON.stringify(expected) + ' 实际 ' + JSON.stringify(actual))
  }
}

runAll().catch(e => { console.error('测试执行异常:', e); process.exit(1) })
