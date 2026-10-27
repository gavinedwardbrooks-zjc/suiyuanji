// ============================================================
// tests/daily-record.test.js · M2 revision 幂等契约测试
// 通过 Module._load 拦截 wx-server-sdk，用 MockDB 驱动真实云函数代码
// 运行：node tests/daily-record.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const fs = require('fs')
const { MockDB } = require('./mock-db')

const OPENID = 'her_001'
const DATE = '2026-08-26'

// 幂等窗口容量直接从**真实云函数源码**解析：测试绝不硬编码一个可能与实现
// 不一致的数字（改动常量后边界用例会自动跟着走，不会假绿）。
const WINDOW = (() => {
  const src = fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/dailyRecord/index.js'), 'utf8')
  const m = /MAX_READ_REQUEST_IDS\s*=\s*(\d+)/.exec(src)
  if (!m) throw new Error('无法从云函数源码解析 MAX_READ_REQUEST_IDS')
  return Number(m[1])
})()

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
function withMockSdk(db, fn) {
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

function baseEvent(overrides) {
  return {
    action: 'save',
    date: DATE,
    requestId: 'req_1',
    revision: 0,
    goals: [{ text: '读书', done: false }],
    todos: [],
    segments: { life: '散步', work: '', growth: '' },
    mood: { type: 'calm', weather: 'sunny' },
    wishes: [],
    score: 4,
    readProgress: 0,
    ...overrides
  }
}

async function runAll() {
  console.log('\n=== M2 revision 幂等契约测试 ===\n')

  await testCase('R1 新记录：revision 0 → 落库 1，响应返回 1', async () => {
    const db = new MockDB({ daily_records: [], wishes: [] })
    const mod = withMockSdk(db, null)
    const res = await mod.main(baseEvent({ requestId: 'req_new' }))
    assertEq(res.ok, true)
    assertEq(res.revision, 1)
    const rec = db.dump().daily_records[0]
    assertEq(rec.revision, 1)
    assertEq(rec.lastRequestId, 'req_new')
  })

  await testCase('R2 连续成功修改：revision 1→2→3', async () => {
    const db = new MockDB({ daily_records: [], wishes: [] })
    const mod = withMockSdk(db, null)
    await mod.main(baseEvent({ requestId: 'a', revision: 0, score: 3 }))
    const r2 = await mod.main(baseEvent({ requestId: 'b', revision: 1, score: 4 }))
    assertEq(r2.revision, 2)
    const r3 = await mod.main(baseEvent({ requestId: 'c', revision: 2, score: 5 }))
    assertEq(r3.revision, 3)
    assertEq(db.dump().daily_records[0].revision, 3)
    assertEq(db.dump().daily_records[0].score, 5)
  })

  await testCase('R3 旧 revision 请求 → REV_CONFLICT 且数据不变', async () => {
    const db = new MockDB({ daily_records: [], wishes: [] })
    const mod = withMockSdk(db, null)
    await mod.main(baseEvent({ requestId: 'a', revision: 0, score: 3 }))
    await mod.main(baseEvent({ requestId: 'b', revision: 1, score: 4 }))
    // 旧 revision=1 再次提交（不同 requestId）→ 冲突
    const conflict = await mod.main(baseEvent({ requestId: 'c', revision: 1, score: 9 }))
    assertEq(conflict.ok, false)
    assertEq(conflict.code, 'REV_CONFLICT')
    assertEq(conflict.revision, 2)
    assertEq(db.dump().daily_records[0].score, 4, '冲突时数据不得被覆盖')
    assertEq(db.dump().daily_records[0].revision, 2)
  })

  await testCase('R4 双击保存（同 requestId）→ 幂等不重复写', async () => {
    const db = new MockDB({ daily_records: [], wishes: [] })
    const mod = withMockSdk(db, null)
    const r1 = await mod.main(baseEvent({ requestId: 'dup', revision: 0, score: 3 }))
    const r2 = await mod.main(baseEvent({ requestId: 'dup', revision: 0, score: 3 }))
    assertEq(r1.ok, true)
    assertEq(r2.ok, true)
    assertEq(r2.idempotent, true, '重复 requestId 应标记幂等')
    assertEq(r2.revision, 1, '幂等返回当前 revision')
    assertEq(db.dump().daily_records.length, 1, '不得产生第二条记录')
  })

  await testCase('R5 双端并发同 revision → 一个成功一个冲突', async () => {
    const db = new MockDB({ daily_records: [], wishes: [] })
    const mod = withMockSdk(db, null)
    await mod.main(baseEvent({ requestId: 'a', revision: 0, score: 3 }))
    const [rA, rB] = await Promise.all([
      mod.main(baseEvent({ requestId: 'b', revision: 1, score: 8 })),
      mod.main(baseEvent({ requestId: 'c', revision: 1, score: 9 }))
    ])
    const okCount = [rA, rB].filter(r => r.ok).length
    assertEq(okCount, 1, '同 revision 并发应恰好 1 个成功')
    const conflictCount = [rA, rB].filter(r => !r.ok && r.code === 'REV_CONFLICT').length
    assertEq(conflictCount, 1, '另一个应返回 REV_CONFLICT')
    // 最终数据 = 成功那个的写入，revision=2
    assertEq(db.dump().daily_records[0].revision, 2)
  })

  await testCase('R6 get 返回带 revision 的记录', async () => {
    const db = new MockDB({ daily_records: [], wishes: [] })
    const mod = withMockSdk(db, null)
    await mod.main(baseEvent({ requestId: 'a', revision: 0, score: 3 }))
    const g = await mod.main({ action: 'get', date: DATE })
    assertEq(g.ok, true)
    assertEq(g.record.revision, 1)
    assertEq(g.record.score, 3)
  })

  await testCase('R7 惰性迁移：无 schemaVersion 的 V1 文档 get 后带 schemaVersion=2', async () => {
    const db = new MockDB({
      daily_records: [{ _openid: OPENID, date: DATE, score: 4, segments: { life: '旧数据' } }],
      wishes: []
    })
    const mod = withMockSdk(db, null)
    const g = await mod.main({ action: 'get', date: DATE })
    assertEq(g.record.schemaVersion, 2)
    assertEq(g.record.score, 4, '迁移不改变业务字段')
    assertEq(g.record.segments.life, '旧数据')
  })

  await testCase('R8 缺少 requestId → BAD_ARGS 拒绝', async () => {
    const db = new MockDB({ daily_records: [], wishes: [] })
    const mod = withMockSdk(db, null)
    const res = await mod.main(baseEvent({ requestId: undefined }))
    assertEq(res.ok, false)
    assertEq(res.code, 'BAD_ARGS')
    assertEq(db.dump().daily_records.length, 0, '非法请求不得写入')
  })

  // ============================================================
  // addRead · 阅读结算幂等契约（阅读模块补报依赖这一段）
  // ============================================================

  await testCase('A1 addRead 首次：新建当日记录并累计 readProgress', async () => {
    const db = new MockDB({ daily_records: [], wishes: [] })
    const mod = withMockSdk(db, null)
    const res = await mod.main({ action: 'addRead', date: DATE, minutes: 7, requestId: 'rd_a' })
    assertEq(res.ok, true)
    const rec = db.dump().daily_records[0]
    assertEq(rec.readProgress, 7)
    assertEq(rec.date, DATE)
    assertEq(rec.schemaVersion, 2)
    assertEq(JSON.stringify(rec.readRequestIds), JSON.stringify(['rd_a']))
  })

  await testCase('A2 同 requestId 重复提交：不重复累计，返回 idempotent', async () => {
    const db = new MockDB({ daily_records: [], wishes: [] })
    const mod = withMockSdk(db, null)
    await mod.main({ action: 'addRead', date: DATE, minutes: 7, requestId: 'rd_a' })
    const res = await mod.main({ action: 'addRead', date: DATE, minutes: 7, requestId: 'rd_a' })
    assertEq(res.ok, true)
    assertEq(res.idempotent, true, '重复 requestId 必须显式回报幂等')
    const rec = db.dump().daily_records[0]
    assertEq(rec.readProgress, 7, '重复提交绝不能重复累计')
    assertEq(rec.readRequestIds.length, 1, 'requestId 不得重复入册')
  })

  await testCase('A3 不同 requestId：正常累加', async () => {
    const db = new MockDB({ daily_records: [], wishes: [] })
    const mod = withMockSdk(db, null)
    await mod.main({ action: 'addRead', date: DATE, minutes: 3, requestId: 'rd_1' })
    await mod.main({ action: 'addRead', date: DATE, minutes: 4, requestId: 'rd_2' })
    const rec = db.dump().daily_records[0]
    assertEq(rec.readProgress, 7)
    assertEq(JSON.stringify(rec.readRequestIds), JSON.stringify(['rd_1', 'rd_2']))
  })

  await testCase('A4 addRead 缺少 date → BAD_ARGS 且不写入', async () => {
    const db = new MockDB({ daily_records: [], wishes: [] })
    const mod = withMockSdk(db, null)
    const res = await mod.main({ action: 'addRead', minutes: 5, requestId: 'rd_x' })
    assertEq(res.ok, false)
    assertEq(res.code, 'BAD_ARGS')
    assertEq(db.dump().daily_records.length, 0)
  })

  await testCase('A5 addRead minutes 非正数 → skipped 且不写入', async () => {
    const db = new MockDB({ daily_records: [], wishes: [] })
    const mod = withMockSdk(db, null)
    const zero = await mod.main({ action: 'addRead', date: DATE, minutes: 0, requestId: 'rd_0' })
    const neg = await mod.main({ action: 'addRead', date: DATE, minutes: -3, requestId: 'rd_n' })
    assertEq(zero.ok, true)
    assertEq(zero.skipped, true)
    assertEq(neg.skipped, true)
    assertEq(db.dump().daily_records.length, 0, '非正数不得写出无意义的记录')
  })

  await testCase('A6 不带 requestId 的旧调用方：行为与 V1 一致（每次都累加）', async () => {
    const db = new MockDB({ daily_records: [], wishes: [] })
    const mod = withMockSdk(db, null)
    await mod.main({ action: 'addRead', date: DATE, minutes: 2 })
    await mod.main({ action: 'addRead', date: DATE, minutes: 2 })
    const rec = db.dump().daily_records[0]
    assertEq(rec.readProgress, 4, '无 requestId 时每次调用都累加（向后兼容）')
    assertEq(rec.readRequestIds.length, 0, '无 requestId 不写幂等键')
  })

  await testCase('A7 readRequestIds 边界精确：恰好 ' + WINDOW + ' 条不淘汰，第 ' + (WINDOW + 1) + ' 条才淘汰最旧', async () => {
    const db = new MockDB({ daily_records: [], wishes: [] })
    const mod = withMockSdk(db, null)
    for (let i = 1; i <= WINDOW; i++) {
      await mod.main({ action: 'addRead', date: DATE, minutes: 1, requestId: 'rd_' + i })
    }
    let rec = db.dump().daily_records[0]
    assertEq(rec.readRequestIds.length, WINDOW, '窗口满员时长度 = 容量')
    assertEq(rec.readRequestIds[0], 'rd_1', '窗口未满时最早的一条绝不能被淘汰')
    assertEq(rec.readRequestIds[WINDOW - 1], 'rd_' + WINDOW, '最新的排在末尾')

    // 第 WINDOW+1 条：只淘汰最旧的一条，其余全部保留
    await mod.main({ action: 'addRead', date: DATE, minutes: 1, requestId: 'rd_' + (WINDOW + 1) })
    rec = db.dump().daily_records[0]
    assertEq(rec.readRequestIds.length, WINDOW, '幂等键必须有界，不能无限增长')
    assertEq(rec.readRequestIds.indexOf('rd_1'), -1, '此时 rd_1 才被淘汰')
    assertEq(rec.readRequestIds.indexOf('rd_2'), 0, '只淘汰最旧一条，rd_2 仍在窗口内')
    assertEq(rec.readProgress, WINDOW + 1, '淘汰不影响累计')
  })

  await testCase('A8 窗口内重复提交：任一条都幂等（含最早的一条）', async () => {
    const db = new MockDB({ daily_records: [], wishes: [] })
    const mod = withMockSdk(db, null)
    for (let i = 1; i <= WINDOW; i++) {
      await mod.main({ action: 'addRead', date: DATE, minutes: 1, requestId: 'rd_' + i })
    }
    const oldest = await mod.main({ action: 'addRead', date: DATE, minutes: 1, requestId: 'rd_1' })
    const newest = await mod.main({ action: 'addRead', date: DATE, minutes: 1, requestId: 'rd_' + WINDOW })
    assertEq(oldest.ok, true)
    assertEq(oldest.idempotent, true, '窗口内最早的一条也必须被判重')
    assertEq(newest.idempotent, true, '窗口内最新的一条也必须被判重')
    assertEq(db.dump().daily_records[0].readProgress, WINDOW, '窗口内重放绝不重复累计')
  })

  await testCase('A8b 窗口被撑爆后旧 requestId 重放会重复累计（机制边界，真实数据不可达）', async () => {
    const db = new MockDB({ daily_records: [], wishes: [] })
    const mod = withMockSdk(db, null)
    for (let i = 1; i <= WINDOW + 1; i++) {
      await mod.main({ action: 'addRead', date: DATE, minutes: 1, requestId: 'rd_' + i })
    }
    const replay = await mod.main({ action: 'addRead', date: DATE, minutes: 1, requestId: 'rd_1' })
    assertEq(replay.ok, true)
    assertEq(replay.idempotent, undefined, 'rd_1 已不在窗口内 → 不再被判重')
    assertEq(db.dump().daily_records[0].readProgress, WINDOW + 2,
      '窗口被撑爆后确实会认不出旧 key（这是机制边界本身）。但窗口 ' + WINDOW +
      ' > 单日物理上界 1440 分钟：每条幂等键至少代表 1 个已累计分钟，' +
      '而一天只有 1440 分钟 ⇒ 真实数据下这个边界**不可达**。' +
      '本用例只用来确认「有界」这件事，不再作为幂等性的依靠（原子性由事务保证）。')
  })

  await testCase('A12 addRead 必须走数据库事务（禁止「先查后写」的非原子实现）', async () => {
    // 2026-10-16：同一 requestId 并发提交曾会重复累计（判重与累加跨了两次 IO）。
    // 现在由服务端事务保证原子（快照隔离 + 写锁 + 冲突自动重试）。
    // 行为验证在 tests/daily-record-atomic.test.js（带写锁/冲突重试的数据库替身）：
    //   A1/A2/A5/D1/D2 并发同一 requestId 只累计一次
    //   N4 阴性对照 —— 同一份云函数代码，把事务换成普通查询+更新就会双记
    // 这里用静态约束锁住实现方式：addRead 的累加路径必须经过 runTransaction，
    // 否则「并发只记一次」将重新退化为依赖客户端单飞锁。
    const src = fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/dailyRecord/index.js'), 'utf8')
    const block = src.slice(src.indexOf("event.action === 'addRead'"), src.indexOf('// ---- save'))
    assertEq((src.match(/db\.runTransaction\(/g) || []).length >= 2, true,
      'addRead 的「累加」与「新建」两条路径都必须走事务')
    assertEq(/function addReadToExisting/.test(src), true, '已存在文档的原子累加路径必须存在')
    assertEq(/function addReadNewRecord/.test(src), true, '新建文档的原子路径必须存在')
    assertEq(
      /where\([^)]*\)\s*\.update\(/.test(block),
      false,
      'addRead 不得使用 where().update 这类非原子写（那是「普通查询加更新冒充原子幂等」）'
    )
    assertEq(/TX_UNSUPPORTED/.test(block), true, '事务不可用时必须明确失败，不得静默退回非原子写')
  })

  await testCase('A13 save 不触碰 readRequestIds（跨调用方零串扰）', async () => {
    const db = new MockDB({ daily_records: [], wishes: [] })
    const mod = withMockSdk(db, null)
    await mod.main({ action: 'addRead', date: DATE, minutes: 3, requestId: 'rd_keep' })
    await mod.main(baseEvent({ requestId: 'req_save_after_read', readProgress: 3 }))
    const rec = db.dump().daily_records[0]
    assertEq(JSON.stringify(rec.readRequestIds), JSON.stringify(['rd_keep']),
      '日记保存只写白名单字段，绝不能清掉幂等键（否则后续重放会重复累计）')
    assertEq(rec.lastRequestId, 'req_save_after_read', 'save 的幂等键正常更新')
    assertEq(rec.score, 4, 'save 业务字段正常写入')
  })

  await testCase('A9 addRead 不影响既有记录的业务字段', async () => {
    const db = new MockDB({ daily_records: [], wishes: [] })
    const mod = withMockSdk(db, null)
    await mod.main(baseEvent({ score: 5 }))
    await mod.main({ action: 'addRead', date: DATE, minutes: 9, requestId: 'rd_biz' })
    const rec = db.dump().daily_records[0]
    assertEq(rec.readProgress, 9)
    assertEq(rec.score, 5, '日记评分一字未改')
    assertEq(rec.revision, 1, 'revision 不受 addRead 影响')
    assertEq(rec.segments.life, '散步', '分段内容一字未改')
    assertEq(JSON.stringify(rec.goals), JSON.stringify([{ text: '读书', done: false }]))
    assertEq(rec.lastRequestId, 'req_1', 'save 的幂等键不受影响')
  })

  await testCase('A10 老记录无 readRequestIds 字段：首次带 requestId 提交不崩且正确写入', async () => {
    const db = new MockDB({
      // 真实云端文档必然带 _id；V1 老记录只是缺 readRequestIds
      daily_records: [{ _id: 'dr_old', _openid: OPENID, date: DATE, readProgress: 4, score: 3 }],
      wishes: []
    })
    const mod = withMockSdk(db, null)
    const res = await mod.main({ action: 'addRead', date: DATE, minutes: 6, requestId: 'rd_old' })
    assertEq(res.ok, true)
    const rec = db.dump().daily_records[0]
    assertEq(rec.readProgress, 10, 'V1 已有分钟必须被保留并继续累加')
    assertEq(JSON.stringify(rec.readRequestIds), JSON.stringify(['rd_old']))
    assertEq(rec.score, 3, '老记录业务字段不受影响')
  })

  await testCase('A11 addRead 带 bookId：旧云端书籍 minutes 累加（V1 语义保留）', async () => {
    const db = new MockDB({
      daily_records: [],
      wishes: [],
      books: [{ _id: 'cloud_b1', name: '云端书', minutes: 10 }]
    })
    const mod = withMockSdk(db, null)
    await mod.main({ action: 'addRead', date: DATE, minutes: 5, requestId: 'rd_c', bookId: 'cloud_b1' })
    assertEq(db.dump().books[0].minutes, 15, '云端书籍累计语义必须保持')
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failures.length) {
    failures.forEach(f => console.log('  - ' + f.name + ': ' + f.error))
    process.exit(1)
  }
  console.log('M2 dailyRecord: ALL GREEN')
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || '') + ' 期望 ' + JSON.stringify(expected) + ' 实际 ' + JSON.stringify(actual))
  }
}

runAll().catch(e => { console.error('测试执行异常:', e); process.exit(1) })
