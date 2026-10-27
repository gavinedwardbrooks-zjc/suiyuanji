// ============================================================
// tests/daily-record-atomic.test.js · addRead 服务端原子幂等
//
// 跑的是**真实云函数代码**（cloudfunctions/dailyRecord/index.js），
// 只把 wx-server-sdk 换成带事务语义（快照隔离 + 写锁 + 提交期版本校验 +
// 冲突自动重试）的数据库替身 tests/mock-cloud-db.js。
//
// 覆盖：
//   · 并发同一 requestId（并发真正重叠，有闸门保证 + 冲突计数自证）
//   · 并发不同 requestId（不丢、不重；失败的可在重放后收敛到精确一次）
//   · 当天第一条结算的并发创建（只能有一条当日记录）
//   · 失败注入（事务中途失败、提交失败、读失败）→ 不留中间态
//   · 成功写入但响应丢失后重试 / 连续重放 → 不重复累计
//   · 跨实例（两个独立云函数实例共享一个数据库）→ 仍然精确一次
//   · 旧客户端不传 requestId 的兼容性（V1 写入面逐字段一致）
//   · books.minutes 与 readProgress 同事务、幂等、只写一次
//   · 幂等窗口 ≥ 单日物理上界（窗口不再是幂等性的依靠）
// ============================================================
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')

const { AtomicMockDB } = require('./mock-cloud-db')
const { FN_PATH, loadInstance, loadInstances } = require('./mock-cloud-function')

const OPENID = 'her_001'
const DATE = '2026-08-26'

// 幂等窗口 / 单日上界都从**真实云函数源码**解析，测试不硬编码可能过期的数字
const SRC = fs.readFileSync(FN_PATH, 'utf8')
const WINDOW = Number(/MAX_READ_REQUEST_IDS\s*=\s*(\d+)/.exec(SRC)[1])
const MINUTES_PER_DAY = Number(/MINUTES_PER_DAY\s*=\s*(\d+)/.exec(SRC)[1])

function seed(extra) {
  return Object.assign({ daily_records: [], wishes: [], books: [] }, extra || {})
}

function recOf(db, date) {
  const list = db.dump().daily_records.filter(d => d.date === (date || DATE))
  return list
}

function bookOf(db, id) {
  return db.dump().books.filter(b => b._id === id)[0]
}

function addReadEvent(over) {
  return Object.assign({ action: 'addRead', date: DATE, minutes: 5, requestId: 'rd_x' }, over || {})
}

// 冲突计数自证：即使断言全过，如果没有发生过任何写冲突，
// 说明两个调用其实是串行执行的 —— 那就是「假绿」，必须让用例失败。
function assertRealOverlap(db, label) {
  const conflicts = db.stats.conflicts
  const retries = db.stats.retries
  assert.ok(
    conflicts >= 1 || retries >= 1,
    (label || '并发用例') + ' 没有发生任何事务冲突（conflicts=' + conflicts + '），说明两个调用被串行化了，用例不能算通过'
  )
}

function assertNoLeak(db, label) {
  assert.strictEqual(db.liveLockCount(), 0, (label || '') + ' 结束时不应有未释放的事务锁')
  assert.strictEqual(db.waiterCount(), 0, (label || '') + ' 结束时不应有未被唤醒的锁等待者')
}

// 闸门必须真的被进入，否则用例会静默挂住
function enteredOrFail(gate, label) {
  return Promise.race([
    gate.entered(),
    new Promise((_, rej) => setTimeout(
      () => rej(new Error('闸门未被进入：' + (label || '') + ' 代码路径没有走到预期的写操作')),
      2000
    ))
  ])
}

// ------------------------------------------------------------
// 一、替身可信度（这两条保证后面的并发结论不是假绿）
// ------------------------------------------------------------

test('N1 阴性对照：非原子的「先查后写」在并发下必然双记', async () => {
  const db = new AtomicMockDB(seed({
    daily_records: [{ _id: 'r1', _openid: OPENID, date: DATE, readProgress: 0, readRequestIds: [] }]
  }))
  const rid = 'rd_same'
  // 复刻改动前的实现：事务外读、事务外写（正是本次要消灭的竞态）
  const naive = async () => {
    const ex = (await db.collection('daily_records').where({ _openid: OPENID, date: DATE }).get()).data
    const rec = ex[0]
    const applied = Array.isArray(rec.readRequestIds) ? rec.readRequestIds : []
    if (applied.indexOf(rid) !== -1) return 'idempotent'
    await db.collection('daily_records').doc(rec._id).update({
      data: { readProgress: db.command.inc(3), readRequestIds: applied.concat([rid]) }
    })
    return 'applied'
  }
  const gate = db.gateOn('daily_records', 'update', 1)
  const p1 = naive()
  const p2 = naive()
  await enteredOrFail(gate, 'N1')
  gate.release()
  const results = await Promise.all([p1, p2])
  const rec = recOf(db)[0]
  assert.strictEqual(results.filter(r => r === 'applied').length, 2, '两个调用都以为自己写入成功了')
  assert.strictEqual(rec.readProgress, 6, '非原子实现下同一 requestId 被累计了两次 —— 这正是必须消除的缺陷')
  assertNoLeak(db, 'N1')
})

test('N2 替身保真：事务内使用 where 批量操作会像真机一样失败', async () => {
  const db = new AtomicMockDB(seed())
  await assert.rejects(
    () => db.runTransaction(async t => {
      t.collection('daily_records').where({ a: 1 })
    }),
    /BATCH_OP_IN_TRANSACTION/
  )
  assert.strictEqual(db.dump().daily_records.length, 0, '失败的事务不得留下任何数据')
  assertNoLeak(db, 'N2')
})

test('N3 替身保真：并发事务写同一文档必然冲突（写锁生效）', async () => {
  const db = new AtomicMockDB(seed({
    daily_records: [{ _id: 'r1', _openid: OPENID, date: DATE, readProgress: 0 }]
  }))
  const gate = db.gateOn('daily_records', 'update', 1)
  const p1 = db.runTransaction(async t => {
    await t.collection('daily_records').doc('r1').update({ data: { readProgress: db.command.inc(1) } })
  }, 3)
  const p2 = db.runTransaction(async t => {
    await t.collection('daily_records').doc('r1').update({ data: { readProgress: db.command.inc(100) } })
  }, 3)
  await enteredOrFail(gate, 'N3')
  gate.release()
  await Promise.all([p1, p2])
  assert.ok(db.stats.conflicts >= 1, '两个事务写同一条文档必须产生冲突')
  assert.strictEqual(recOf(db)[0].readProgress, 101, '冲突后重试必须补上，不能丢写')
  assertNoLeak(db, 'N3')
})

// ------------------------------------------------------------
// 二、并发同一 requestId：只累计一次
// ------------------------------------------------------------

test('N4 阴性对照：同一份云函数代码，把事务换成「普通查询 + 更新」后并发必然双记', async () => {
  const raw = new AtomicMockDB(seed({
    daily_records: [{ _id: 'r1', _openid: OPENID, date: DATE, readProgress: 0, readRequestIds: [] }]
  }))
  // 同一个数据库，但 runTransaction 被换成「直接执行回调」：
  // 没有写锁、没有快照校验、没有冲突重试 —— 也就是「普通查询加更新」。
  const naiveHandle = {
    collection: n => raw.collection(n),
    command: raw.command,
    runTransaction: async fn => fn({ collection: n => raw.collection(n), rollback: async () => {} })
  }
  const inst = loadInstance(naiveHandle)
  const ev = addReadEvent({ requestId: 'rd_naive', minutes: 5 })
  const gate = raw.gateOn('daily_records', 'update', 1)
  const p1 = inst.main(ev)
  const p2 = inst.main(ev)
  try {
    await enteredOrFail(gate, 'N4')
  } finally {
    gate.release()
  }
  const rs = await Promise.all([p1, p2])
  assert.strictEqual(raw.stats.transactions, 0, '这个对照组里没有真正的事务')
  assert.strictEqual(rs.filter(r => r.ok === true).length, 2, '两个调用都会「成功」')
  assert.strictEqual(
    recOf(raw)[0].readProgress, 10,
    '没有事务时，同一 requestId 并发提交会累计两次 —— 这正是原子实现必须挡住的结果，' +
    '也说明前面的并发用例不是因为「碰巧串行」才通过的'
  )
  assertNoLeak(raw, 'N4')
})

test('A1 并发同一 requestId（有闸门，真实重叠）：只累计一次', async () => {
  const db = new AtomicMockDB(seed({
    daily_records: [{
      _id: 'r1', _openid: OPENID, date: DATE, readProgress: 10, readRequestIds: ['rd_old']
    }]
  }))
  const inst = loadInstance(db)
  const ev = addReadEvent({ requestId: 'rd_x', minutes: 5 })
  const gate = db.gateOn('daily_records', 'update', 1)
  const p1 = inst.main(ev)
  const p2 = inst.main(ev)
  try {
    await enteredOrFail(gate, 'A1')
  } finally {
    gate.release()
  }
  const [r1, r2] = await Promise.all([p1, p2])
  const rec = recOf(db)[0]
  assert.strictEqual(rec.readProgress, 15, '同一 requestId 并发提交只能累计一次（10 + 5）')
  assert.strictEqual(rec.readRequestIds.filter(x => x === 'rd_x').length, 1, '幂等键只能出现一次')
  assert.strictEqual([r1, r2].filter(r => r && r.ok === true).length, 2, '两个请求都应当成功返回')
  assert.strictEqual([r1, r2].filter(r => r && r.idempotent === true).length, 1, '恰好一个被判定为幂等重放')
  assertRealOverlap(db, 'A1')
  assertNoLeak(db, 'A1')
})

test('A2 自然并发 5 个同一 requestId：仍然只累计一次', async () => {
  const db = new AtomicMockDB(seed({
    daily_records: [{ _id: 'r1', _openid: OPENID, date: DATE, readProgress: 0, readRequestIds: [] }]
  }))
  const inst = loadInstance(db)
  const ev = addReadEvent({ requestId: 'rd_dup', minutes: 4 })
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => inst.main(ev)))
  const rec = recOf(db)[0]
  assert.strictEqual(rec.readProgress, 4, '5 个并发同 requestId 只能记 1 次')
  assert.strictEqual(rec.readRequestIds.filter(x => x === 'rd_dup').length, 1)
  assert.strictEqual(results.filter(r => r.ok === true).length, 5, '每一个调用都必须拿到成功结果')
  assertNoLeak(db, 'A2')
})

test('A3 并发不同 requestId：两个都记，不丢不重（含冲突自证）', async () => {
  const db = new AtomicMockDB(seed({
    daily_records: [{ _id: 'r1', _openid: OPENID, date: DATE, readProgress: 10, readRequestIds: [] }]
  }))
  const inst = loadInstance(db)
  const gate = db.gateOn('daily_records', 'update', 1)
  const p1 = inst.main(addReadEvent({ requestId: 'rd_a', minutes: 5 }))
  const p2 = inst.main(addReadEvent({ requestId: 'rd_b', minutes: 7 }))
  try {
    await enteredOrFail(gate, 'A3')
  } finally {
    gate.release()
  }
  const rs = await Promise.all([p1, p2])
  const rec = recOf(db)[0]
  assert.strictEqual(rs.filter(r => r.ok === true).length, 2)
  assert.strictEqual(rec.readProgress, 22, '两个不同 requestId 都必须累计（10 + 5 + 7）')
  assert.strictEqual(rec.readRequestIds.filter(x => x === 'rd_a').length, 1)
  assert.strictEqual(rec.readRequestIds.filter(x => x === 'rd_b').length, 1)
  assertRealOverlap(db, 'A3')
  assertNoLeak(db, 'A3')
})

test('A4 5 个并发不同 requestId：无丢写、无重复；失败项重放后收敛到恰好一次', async () => {
  const db = new AtomicMockDB(seed({
    daily_records: [{ _id: 'r1', _openid: OPENID, date: DATE, readProgress: 0, readRequestIds: [] }]
  }))
  const inst = loadInstance(db)
  const ids = ['rd_1', 'rd_2', 'rd_3', 'rd_4', 'rd_5']
  const rs = await Promise.all(ids.map(id => inst.main(addReadEvent({ requestId: id, minutes: 3 }))))
  const okCount = rs.filter(r => r && r.ok === true).length
  let rec = recOf(db)[0]
  assert.strictEqual(rec.readProgress, okCount * 3, '成功的调用必须都被累计，且一个不重复')

  // 「成功但响应丢失 / 冲突耗尽重试」的条目会由客户端重放；重放必须补齐且不翻倍
  for (const id of ids) {
    const again = await inst.main(addReadEvent({ requestId: id, minutes: 3 }))
    assert.strictEqual(again.ok, true, '重放必须成功：' + id)
  }
  rec = recOf(db)[0]
  assert.strictEqual(rec.readProgress, 15, '5 个 requestId 最终必须精确对应 15 分钟')
  for (const id of ids) {
    assert.strictEqual(rec.readRequestIds.filter(x => x === id).length, 1, '幂等键必须唯一：' + id)
  }
  assertNoLeak(db, 'A4')
})

// ------------------------------------------------------------
// 三、当天第一条结算的并发创建
// ------------------------------------------------------------

test('A5 当天第一条结算并发（同一 requestId）：只创建一条记录、只记一次', async () => {
  const db = new AtomicMockDB(seed())
  const inst = loadInstance(db)
  const ev = addReadEvent({ requestId: 'rd_first', minutes: 4 })
  const gate = db.gateOn('daily_records', 'add', 1)
  const p1 = inst.main(ev)
  const p2 = inst.main(ev)
  try {
    await enteredOrFail(gate, 'A5')
  } finally {
    gate.release()
  }
  const rs = await Promise.all([p1, p2])
  assert.strictEqual(recOf(db).length, 1, '同一天只能有一条当日记录')
  const rec = recOf(db)[0]
  assert.strictEqual(rec.readProgress, 4)
  assert.strictEqual(rec.readRequestIds.filter(x => x === 'rd_first').length, 1)
  assert.strictEqual(rs.filter(r => r.ok === true).length, 2)
  assertNoLeak(db, 'A5')
})

test('A6 当天第一条结算并发（不同 requestId）：一条记录、两笔都记', async () => {
  const db = new AtomicMockDB(seed())
  const inst = loadInstance(db)
  const gate = db.gateOn('daily_records', 'add', 1)
  const p1 = inst.main(addReadEvent({ requestId: 'rd_p', minutes: 4 }))
  const p2 = inst.main(addReadEvent({ requestId: 'rd_q', minutes: 6 }))
  try {
    await enteredOrFail(gate, 'A6')
  } finally {
    gate.release()
  }
  const rs = await Promise.all([p1, p2])
  assert.strictEqual(recOf(db).length, 1, '并发创建不得产生两条当日记录')
  const rec = recOf(db)[0]
  assert.strictEqual(rs.filter(r => r.ok === true).length, 2)
  assert.strictEqual(rec.readProgress, 10, '两笔不同结算都必须记上（4 + 6）')
  assert.strictEqual(rec.readRequestIds.length, 2)
  assertNoLeak(db, 'A6')
})

// ------------------------------------------------------------
// 四、失败注入：不留中间态、可安全重试
// ------------------------------------------------------------

test('B1 事务中途失败（books 写入失败）→ 整体回滚，无中间态；重试后恰好一次', async () => {
  const db = new AtomicMockDB(seed({
    daily_records: [{
      _id: 'r1', _openid: OPENID, date: DATE, readProgress: 10, readRequestIds: ['rd_a']
    }],
    books: [{ _id: 'b1', minutes: 100 }]
  }))
  const inst = loadInstance(db)
  const ev = addReadEvent({ requestId: 'rd_b', minutes: 5, bookId: 'b1' })
  db.failOn('books', 'update', 1)
  const bad = await inst.main(ev)
  assert.strictEqual(bad.ok, false, '中途失败必须如实返回失败（好让客户端留在待补报里）')
  assert.strictEqual(bad.code, 'TX_FAILED')
  assert.strictEqual(bad.retryable, true)

  let rec = recOf(db)[0]
  assert.strictEqual(rec.readProgress, 10, '失败事务不得留下 readProgress 的中间态')
  assert.strictEqual(rec.readRequestIds.indexOf('rd_b'), -1, '失败事务不得留下幂等键')
  assert.strictEqual(bookOf(db, 'b1').minutes, 100, '失败事务不得留下 books.minutes 的中间态')

  const okRes = await inst.main(ev)
  assert.strictEqual(okRes.ok, true)
  rec = recOf(db)[0]
  assert.strictEqual(rec.readProgress, 15)
  assert.strictEqual(rec.readRequestIds.filter(x => x === 'rd_b').length, 1)
  assert.strictEqual(bookOf(db, 'b1').minutes, 105, 'books.minutes 与 readProgress 必须同事务、都只记一次')

  const replay = await inst.main(ev)
  assert.strictEqual(replay.idempotent, true)
  assert.strictEqual(recOf(db)[0].readProgress, 15)
  assert.strictEqual(bookOf(db, 'b1').minutes, 105, '重放不得重复累加 books.minutes')
  assertNoLeak(db, 'B1')
})

test('B2 提交失败 → 无中间态；重试成功', async () => {
  const db = new AtomicMockDB(seed({
    daily_records: [{ _id: 'r1', _openid: OPENID, date: DATE, readProgress: 3, readRequestIds: [] }]
  }))
  const inst = loadInstance(db)
  const ev = addReadEvent({ requestId: 'rd_c', minutes: 2 })
  db.failCommitTimes = 1
  const bad = await inst.main(ev)
  assert.strictEqual(bad.ok, false)
  assert.strictEqual(recOf(db)[0].readProgress, 3, '提交失败不得写入任何字段')
  assert.strictEqual(recOf(db)[0].readRequestIds.length, 0)

  const okRes = await inst.main(ev)
  assert.strictEqual(okRes.ok, true)
  assert.strictEqual(recOf(db)[0].readProgress, 5)
  assert.strictEqual(recOf(db)[0].readRequestIds.filter(x => x === 'rd_c').length, 1)
  assertNoLeak(db, 'B2')
})

test('B3 事务内读取失败不会被当成「文档不存在」吞掉', async () => {
  const db = new AtomicMockDB(seed({
    daily_records: [{ _id: 'r1', _openid: OPENID, date: DATE, readProgress: 8, readRequestIds: [] }]
  }))
  const inst = loadInstance(db)
  const ev = addReadEvent({ requestId: 'rd_d', minutes: 2 })
  db.failOn('daily_records', 'get', 1)
  const bad = await inst.main(ev)
  assert.strictEqual(bad.ok, false, '读失败必须上抛为失败，绝不能凭空当成「不存在」而新建/覆盖')
  assert.strictEqual(recOf(db).length, 1, '不得新建第二条当日记录')
  assert.strictEqual(recOf(db)[0].readProgress, 8)
  assertNoLeak(db, 'B3')
})

test('B4 环境不支持事务 → 明确失败且一个字都不写（不以非原子方式冒充幂等）', async () => {
  const db = new AtomicMockDB(seed())
  // 模拟不支持事务的句柄（只有 collection / command）
  const legacyHandle = { collection: name => db.collection(name), command: db.command }
  const inst = loadInstance(legacyHandle)
  const res = await inst.main(addReadEvent({ requestId: 'rd_e', minutes: 5 }))
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.code, 'TX_UNSUPPORTED')
  assert.strictEqual(res.retryable, true)
  assert.strictEqual(db.dump().daily_records.length, 0, '不支持事务时必须什么都不写')
  assert.strictEqual(db.stats.transactions, 0)
  assertNoLeak(db, 'B4')
})

// ------------------------------------------------------------
// 五、响应丢失 / 连续重放
// ------------------------------------------------------------

test('C1 成功写入但响应丢失 → 重试不重复累计', async () => {
  const db = new AtomicMockDB(seed({
    daily_records: [{ _id: 'r1', _openid: OPENID, date: DATE, readProgress: 1, readRequestIds: ['rd_seed'] }],
    books: [{ _id: 'b9', minutes: 0 }]
  }))
  const inst = loadInstance(db)
  const ev = addReadEvent({ requestId: 'rd_lost', minutes: 6, bookId: 'b9' })
  const first = await inst.main(ev) // 云端已提交，但客户端没收到响应
  assert.strictEqual(first.ok, true)
  assert.strictEqual(recOf(db)[0].readProgress, 7)

  const retry = await inst.main(ev) // 客户端重放同一条
  assert.strictEqual(retry.ok, true)
  assert.strictEqual(retry.idempotent, true, '重放必须被识别为幂等')
  assert.strictEqual(recOf(db)[0].readProgress, 7, '重放不得重复累计')
  assert.strictEqual(bookOf(db, 'b9').minutes, 6, '重放不得重复累计 books.minutes')
  assertNoLeak(db, 'C1')
})

test('C2 连续 5 次重放同一 requestId：仍然只累计一次', async () => {
  const db = new AtomicMockDB(seed({
    daily_records: [{ _id: 'r1', _openid: OPENID, date: DATE, readProgress: 0, readRequestIds: [] }]
  }))
  const inst = loadInstance(db)
  const ev = addReadEvent({ requestId: 'rd_repeat', minutes: 9 })
  for (let i = 0; i < 5; i++) {
    const r = await inst.main(ev)
    assert.strictEqual(r.ok, true, '第 ' + (i + 1) + ' 次调用必须成功')
  }
  assert.strictEqual(recOf(db)[0].readProgress, 9)
  assert.strictEqual(recOf(db)[0].readRequestIds.filter(x => x === 'rd_repeat').length, 1)
  assertNoLeak(db, 'C2')
})

// ------------------------------------------------------------
// 六、跨实例（幂等必须落在数据库上，不能落在进程内存里）
// ------------------------------------------------------------

test('D1 跨实例并发同一 requestId（共享同一数据库）：只累计一次', async () => {
  const db = new AtomicMockDB(seed({
    daily_records: [{ _id: 'r1', _openid: OPENID, date: DATE, readProgress: 20, readRequestIds: [] }]
  }))
  const [i1, i2] = loadInstances(db, 2)
  assert.notStrictEqual(i1, i2)
  const ev = addReadEvent({ requestId: 'rd_cross', minutes: 5 })
  const gate = db.gateOn('daily_records', 'update', 1)
  const p1 = i1.main(ev)
  const p2 = i2.main(ev)
  try {
    await enteredOrFail(gate, 'D1')
  } finally {
    gate.release()
  }
  const rs = await Promise.all([p1, p2])
  assert.strictEqual(recOf(db)[0].readProgress, 25, '两份独立实例并发提交同一 requestId 也只能记一次')
  assert.strictEqual(recOf(db)[0].readRequestIds.filter(x => x === 'rd_cross').length, 1)
  assert.strictEqual(rs.filter(r => r.ok === true).length, 2)
  assertRealOverlap(db, 'D1')
  assertNoLeak(db, 'D1')
})

test('D2 跨实例自然并发（同一 requestId ×4，两份实例交替）：仍然只累计一次', async () => {
  const db = new AtomicMockDB(seed({
    daily_records: [{ _id: 'r1', _openid: OPENID, date: DATE, readProgress: 0, readRequestIds: [] }]
  }))
  const [i1, i2] = loadInstances(db, 2)
  const ev = addReadEvent({ requestId: 'rd_multi', minutes: 2 })
  const rs = await Promise.all([i1.main(ev), i2.main(ev), i1.main(ev), i2.main(ev)])
  assert.strictEqual(recOf(db)[0].readProgress, 2)
  assert.strictEqual(rs.filter(r => r.ok === true).length, 4)
  assertNoLeak(db, 'D2')
})

// ------------------------------------------------------------
// 七、旧客户端兼容（不传 requestId）
// ------------------------------------------------------------

test('E1 旧调用方（无 requestId）仍然每次都累加，写入面与 V1 一致', async () => {
  const db = new AtomicMockDB(seed({
    daily_records: [{ _id: 'r1', _openid: OPENID, date: DATE, readProgress: 1, schemaVersion: 2, readRequestIds: ['rd_keep'] }]
  }))
  const inst = loadInstance(db)
  const r1 = await inst.main({ action: 'addRead', date: DATE, minutes: 3 })
  const r2 = await inst.main({ action: 'addRead', date: DATE, minutes: 3 })
  assert.strictEqual(r1.ok, true)
  assert.strictEqual(r1.idempotent, undefined, '旧调用方不应收到幂等标记')
  assert.strictEqual(r2.ok, true)
  const rec = recOf(db)[0]
  assert.strictEqual(rec.readProgress, 7, '无 requestId 时保持 V1 语义：每次都累加（1+3+3）')
  assert.deepStrictEqual(rec.readRequestIds, ['rd_keep'], '旧调用方不得触碰幂等键数组')
  assertNoLeak(db, 'E1')
})

test('E2 旧调用方在空库上创建当日记录：readRequestIds 为空数组（与 V1 一致）', async () => {
  const db = new AtomicMockDB(seed())
  const inst = loadInstance(db)
  const r = await inst.main({ action: 'addRead', date: DATE, minutes: 7 })
  assert.strictEqual(r.ok, true)
  const rec = recOf(db)[0]
  assert.strictEqual(rec.readProgress, 7)
  assert.deepStrictEqual(rec.readRequestIds, [])
  assert.strictEqual(rec.schemaVersion, 2)
  assertNoLeak(db, 'E2')
})

test('E3 minutes 非正数 → 跳过且一个字都不写', async () => {
  const db = new AtomicMockDB(seed({
    daily_records: [{ _id: 'r1', _openid: OPENID, date: DATE, readProgress: 5, readRequestIds: [] }]
  }))
  const inst = loadInstance(db)
  const r = await inst.main({ action: 'addRead', date: DATE, minutes: 0, requestId: 'rd_zero' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.skipped, true)
  assert.strictEqual(db.stats.transactions, 0, '跳过路径不应开事务')
  assert.strictEqual(recOf(db)[0].readProgress, 5)
  assert.strictEqual(recOf(db)[0].readRequestIds.length, 0)
})

test('E4 缺少 date → BAD_ARGS', async () => {
  const db = new AtomicMockDB(seed())
  const inst = loadInstance(db)
  const r = await inst.main({ action: 'addRead', minutes: 5, requestId: 'rd_x' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'BAD_ARGS')
  assert.strictEqual(db.stats.transactions, 0)
})

test('E5 旧调用方带 bookId：books.minutes 在一次结算里只加一次（不是两次）', async () => {
  const db = new AtomicMockDB(seed({
    daily_records: [{ _id: 'r1', _openid: OPENID, date: DATE, readProgress: 0, readRequestIds: [] }],
    books: [{ _id: 'b1', minutes: 100 }]
  }))
  const inst = loadInstance(db)
  const r = await inst.main({ action: 'addRead', date: DATE, minutes: 3, bookId: 'b1' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(bookOf(db, 'b1').minutes, 103, 'books.minutes 只能 +3；加两次是历史缺陷')
  assertNoLeak(db, 'E5')
})

// ------------------------------------------------------------
// 八、幂等窗口（不再承担幂等责任，只负责内存有界）
// ------------------------------------------------------------

test('F1 幂等窗口 ≥ 单日物理上界（真实数据下不可能淘汰）', () => {
  assert.ok(MINUTES_PER_DAY === 1440, '一天 1440 分钟')
  assert.ok(
    WINDOW > MINUTES_PER_DAY,
    '窗口(' + WINDOW + ') 必须大于单日物理上界(' + MINUTES_PER_DAY + ')：每条幂等键至少代表 1 个已累计分钟，' +
    '因此单日幂等键数量不可能超过 1440 —— 窗口大于它就意味着真实数据下永不淘汰'
  )
})

test('F2 窗口被撑满时，已写入的 requestId 依然被判重（不因淘汰而双记）', async () => {
  const full = []
  full.push('rd_head') // 最早写入的那条，位于数组头部（最容易被淘汰的位置）
  for (let i = 0; i < WINDOW - 1; i++) full.push('rd_fill_' + i)
  const db = new AtomicMockDB(seed({
    daily_records: [{ _id: 'r1', _openid: OPENID, date: DATE, readProgress: 9, readRequestIds: full }]
  }))
  const inst = loadInstance(db)
  const r = await inst.main(addReadEvent({ requestId: 'rd_head', minutes: 5 }))
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.idempotent, true, '即使在窗口满员的情况下，已写入的 requestId 仍必须被判重')
  assert.strictEqual(recOf(db)[0].readProgress, 9, '不得重复累计')
  assertNoLeak(db, 'F2')
})

test('F3 窗口满员时写入新 key：数组保持有界，新 key 不会被立刻挤掉', async () => {
  const full = []
  for (let i = 0; i < WINDOW; i++) full.push('rd_fill_' + i)
  const db = new AtomicMockDB(seed({
    daily_records: [{ _id: 'r1', _openid: OPENID, date: DATE, readProgress: 0, readRequestIds: full }]
  }))
  const inst = loadInstance(db)
  const r = await inst.main(addReadEvent({ requestId: 'rd_newest', minutes: 5 }))
  assert.strictEqual(r.ok, true)
  const ids = recOf(db)[0].readRequestIds
  assert.strictEqual(ids.length, WINDOW, '幂等键数组必须有界')
  assert.strictEqual(ids[ids.length - 1], 'rd_newest', '最新写入的 key 必须留在窗口里')
  const replay = await inst.main(addReadEvent({ requestId: 'rd_newest', minutes: 5 }))
  assert.strictEqual(replay.idempotent, true, '刚写入的 key 必须能被判重')
  assert.strictEqual(recOf(db)[0].readProgress, 5)
  assertNoLeak(db, 'F3')
})

// ------------------------------------------------------------
// 九、其它 action 不受影响
// ------------------------------------------------------------

test('G1 save/get 在事务化实现下行为不变，且不覆盖幂等键', async () => {
  const db = new AtomicMockDB(seed({
    daily_records: [{
      _id: 'r1', _openid: OPENID, date: DATE, readProgress: 12,
      readRequestIds: ['rd_a', 'rd_b'], schemaVersion: 2, revision: 1, lastRequestId: 'req_prev'
    }]
  }))
  const inst = loadInstance(db)
  const got = await inst.main({ action: 'get', date: DATE })
  assert.strictEqual(got.ok, true)
  assert.strictEqual(got.record.readProgress, 12)

  const saved = await inst.main({
    action: 'save', date: DATE, requestId: 'req_new', revision: 1,
    goals: [], todos: [], segments: { life: '', work: '', growth: '' },
    mood: { type: 'calm', weather: 'sunny' }, wishes: [], score: 5, readProgress: 12
  })
  assert.strictEqual(saved.ok, true)
  assert.strictEqual(saved.revision, 2)
  assert.deepStrictEqual(recOf(db)[0].readRequestIds, ['rd_a', 'rd_b'], 'save 不得清掉幂等键')
  assert.strictEqual(recOf(db)[0].readProgress, 12)

  const idem = await inst.main({
    action: 'save', date: DATE, requestId: 'req_new', revision: 1,
    goals: [], todos: [], segments: { life: '', work: '', growth: '' },
    mood: { type: 'calm', weather: 'sunny' }, wishes: [], score: 5, readProgress: 12
  })
  assert.strictEqual(idem.idempotent, true, 'save 的 requestId 幂等契约未受影响')
  assert.strictEqual(db.stats.transactions, 0, 'save/get 不应当使用事务')
  assertNoLeak(db, 'G1')
})
