// ============================================================
// tests/reading-session.test.js · 阅读计时唯一结算控制器行为测试
//
// 本文件验证全项目**唯一**的计时结算实现（utils/readingSession.js）：
//   - 单一结算：onHide + onUnload + 重复调用最多一次
//   - 余量结转：不足一分钟保留下来、攒够才记，绝不丢弃也绝不强行记 1 分钟
//   - 本地单书分钟与每日阅读分钟同源同值
//   - 本机书绝不带 bookId / 绝不写云端 books
//   - 每日统计失败不静默：错误日志 + 带幂等 requestId 的待补报队列 + 提示
//   - settle 永不 reject
// ============================================================
const test = require('node:test')
const assert = require('node:assert/strict')

const S = require('../utils/readingSession')
const C = require('../utils/readingCarry')
const dp = require('../utils/readingDailyPending')

function makeDeps(over) {
  const o = over || {}
  const state = {
    clock: Number.isFinite(o.startClock) ? o.startClock : 1000000,
    localCalls: [],
    dailyCalls: [],
    pendingCalls: [],
    cloudCalls: [],
    toasts: [],
    errors: [],
    warns: [],
    carry: Object.assign({}, o.carry || {})
  }
  const deps = {
    now: () => state.clock,
    addLocalMinutes: (localId, minutes) => {
      state.localCalls.push({ localId, minutes })
      if (o.localFails) return Promise.reject(Object.assign(new Error('x'), { code: 'META_WRITE_FAILED' }))
      return Promise.resolve({ ok: true })
    },
    callDailyRead: data => {
      state.dailyCalls.push(data)
      if (o.dailyFails === 'reject') return Promise.reject(Object.assign(new Error('net'), { errMsg: 'callFunction:fail' }))
      if (o.dailyFails === 'notok') return Promise.resolve({ result: { ok: false, code: 'DAILY_DOC_MISSING' } })
      return Promise.resolve({ result: { ok: true } })
    },
    addCloudBookMinutes: (bookId, minutes) => {
      state.cloudCalls.push({ bookId, minutes })
      if (o.cloudFails) return Promise.reject(Object.assign(new Error('cloud'), { errCode: -1 }))
      return Promise.resolve({ ok: true })
    },
    bufferDailyPending: entry => {
      state.pendingCalls.push(entry)
      if (o.bufferFails) return { ok: false, reason: 'PENDING_WRITE_FAILED' }
      return { ok: true, count: 1 }
    },
    getCarry: key => state.carry[key] || 0,
    setCarry: (key, ms) => {
      if (o.carryFails) return { ms, persisted: false }
      if (ms > 0) state.carry[key] = ms
      else delete state.carry[key]
      return { ms, persisted: true }
    },
    showToast: t => state.toasts.push(t),
    logError: (tag, info) => state.errors.push({ tag, info }),
    logWarn: (tag, info) => state.warns.push({ tag, info })
  }
  return { state, deps }
}

function advance(state, ms) { state.clock += ms }

// ---------------- 基本结算 ----------------

test('NO_ACTIVE_SESSION_SETTLES_NOTHING', async () => {
  const { state, deps } = makeDeps()
  const s = S.createReadingSession(deps)
  const res = await s.settle('HIDE')
  assert.deepStrictEqual(res, { settled: false, reason: 'NO_ACTIVE_SESSION' })
  assert.strictEqual(state.localCalls.length, 0)
  assert.strictEqual(state.dailyCalls.length, 0)
})

test('SUB_MINUTE_SETTLES_WITHOUT_MINUTES_AND_KEEPS_CARRY', async () => {
  const { state, deps } = makeDeps()
  const s = S.createReadingSession(deps)
  s.begin({ localId: 'lb_1' })
  advance(state, 5 * 1000) // 5 秒
  const res = await s.settle('UNLOAD')
  assert.strictEqual(res.settled, true)
  assert.strictEqual(res.minutes, 0, '不足一分钟绝不允许强行记成 1 分钟')
  assert.strictEqual(res.recorded, false)
  assert.strictEqual(res.carryMs, 5000, '余量必须保留')
  assert.strictEqual(state.localCalls.length, 0, '没有记账就不得写本机分钟')
  assert.strictEqual(state.dailyCalls.length, 0, '没有记账就不得调每日统计')
  assert.strictEqual(state.toasts.length, 0, '没有失败就不得提示')
  assert.deepStrictEqual(state.carry, { 'L:lb_1': 5000 })
})

test('CARRY_ACCUMULATES_UNTIL_A_FULL_MINUTE', async () => {
  const { state, deps } = makeDeps()
  const s = S.createReadingSession(deps)
  const expected = [0, 0, 1, 0]
  for (let i = 0; i < 4; i++) {
    s.begin({ localId: 'lb_1' })
    advance(state, 20000)
    const res = await s.settle('UNLOAD')
    assert.strictEqual(res.minutes, expected[i], '第 ' + (i + 1) + ' 段分钟数错误')
  }
  // 20+20+20+20 = 80 秒 → 1 分钟 + 20 秒余量
  assert.strictEqual(state.localCalls.length, 1, '只有满一分钟那次才写本机')
  assert.strictEqual(state.localCalls[0].minutes, 1)
  assert.deepStrictEqual(state.carry, { 'L:lb_1': 20000 })
})

test('CARRY_IS_NAMESPACED_PER_TARGET', async () => {
  const { state, deps } = makeDeps()
  const s = S.createReadingSession(deps)
  s.begin({ localId: 'lb_a' })
  advance(state, 30000)
  await s.settle('UNLOAD')

  s.begin({ bookId: 'cloud_a' })
  advance(state, 30000)
  await s.settle('UNLOAD')

  assert.deepStrictEqual(state.carry, { 'L:lb_a': 30000, 'C:cloud_a': 30000 }, '本机书与云端书的余量绝不互相污染')
  assert.strictEqual(state.localCalls.length, 0)
})

test('MINUTES_ARE_WHOLE_MINUTES_FROM_REAL_ELAPSED_TIME', async () => {
  const { state, deps } = makeDeps()
  const s = S.createReadingSession(deps)
  s.begin({ localId: 'lb_1' })
  advance(state, 4 * 60000 + 20000) // 4分20秒
  const res = await s.settle('UNLOAD')
  assert.strictEqual(res.minutes, 4, '只记整分钟，不四舍五入')
  assert.strictEqual(res.carryMs, 20000)
})

test('DOUBLE_SETTLE_COUNTS_ONCE', async () => {
  const { state, deps } = makeDeps()
  const s = S.createReadingSession(deps)
  s.begin({ localId: 'lb_1' })
  advance(state, 2 * 60000)
  const first = await s.settle('HIDE')
  const second = await s.settle('UNLOAD')
  const third = await s.settle('UNLOAD')
  assert.strictEqual(first.settled, true)
  assert.strictEqual(first.minutes, 2)
  assert.deepStrictEqual(second, { settled: false, reason: 'NO_ACTIVE_SESSION' })
  assert.deepStrictEqual(third, { settled: false, reason: 'NO_ACTIVE_SESSION' })
  assert.strictEqual(state.localCalls.length, 1, '本机分钟只允许写一次')
  assert.strictEqual(state.dailyCalls.length, 1, '每日统计只允许调一次')
})

test('STATE_CLEARED_SYNCHRONOUSLY_BEFORE_ANY_ASYNC_WORK', () => {
  const { deps } = makeDeps()
  const s = S.createReadingSession(deps)
  s.begin({ localId: 'lb_1' })
  const p1 = s.settle('HIDE')
  assert.strictEqual(s.active(), false, 'settle 第一步必须同步清空会话')
  const p2 = s.settle('UNLOAD')
  return Promise.all([p1, p2]).then(([a, b]) => {
    assert.strictEqual(a.settled, true)
    assert.strictEqual(b.settled, false)
  })
})

test('BEGIN_WHILE_ACTIVE_DOES_NOT_LOSE_MINUTES', async () => {
  const { state, deps } = makeDeps()
  const s = S.createReadingSession(deps)
  const first = s.begin({ localId: 'lb_1' })
  advance(state, 3 * 60000)
  const second = s.begin({ localId: 'lb_2' })
  assert.strictEqual(first.began, true)
  assert.strictEqual(first.carryMs, 0)
  assert.strictEqual(second.began, false)
  assert.strictEqual(second.reason, 'ALREADY_ACTIVE')
  const res = await s.settle('HIDE')
  assert.strictEqual(res.localId, 'lb_1', '不得被后来的 begin 顶掉')
  assert.strictEqual(res.minutes, 3)
  assert.strictEqual(state.localCalls.length, 1)
})

test('ABORT_KEEPS_ELAPSED_TIME_AS_CARRY_WITHOUT_RECORDING', async () => {
  const { state, deps } = makeDeps()
  const s = S.createReadingSession(deps)
  s.begin({ localId: 'lb_1' })
  advance(state, 45000)
  const res = await s.abort('PAGE_LEFT')
  assert.strictEqual(res.aborted, true)
  assert.strictEqual(res.minutes, 0)
  assert.strictEqual(res.carryMs, 45000)
  assert.strictEqual(state.localCalls.length, 0)
  assert.strictEqual(state.dailyCalls.length, 0)
  assert.deepStrictEqual(state.carry, { 'L:lb_1': 45000 })
})

// ---------------- 每日统计 ----------------

test('LOCAL_BOOK_DAILY_CALL_CARRIES_REQUEST_ID_AND_NO_BOOK_ID', async () => {
  const { state, deps } = makeDeps()
  const s = S.createReadingSession(deps)
  s.begin({ localId: 'lb_1', bookId: null })
  advance(state, 7 * 60000)
  const res = await s.settle('UNLOAD')
  assert.strictEqual(state.dailyCalls.length, 1)
  const data = state.dailyCalls[0]
  assert.strictEqual(data.action, 'addRead')
  assert.strictEqual(data.minutes, 7)
  assert.match(data.date, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(data.requestId, '必须带稳定 requestId')
  assert.strictEqual(Object.prototype.hasOwnProperty.call(data, 'bookId'), false, '本机书绝不允许带 bookId')
  assert.strictEqual(res.dailySynced, true)
  assert.strictEqual(res.dailyFailed, false)
  assert.strictEqual(res.requestId, data.requestId)
})

test('LOCAL_AND_DAILY_MINUTES_ARE_ALWAYS_THE_SAME_NUMBER', async () => {
  const { state, deps } = makeDeps()
  const s = S.createReadingSession(deps)
  for (let i = 1; i <= 3; i++) {
    s.begin({ localId: 'lb_1' })
    advance(state, 3 * 60000 + 1000 * i)
    await s.settle('UNLOAD')
  }
  assert.strictEqual(state.localCalls.length, 3)
  assert.strictEqual(state.dailyCalls.length, 3)
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(state.localCalls[i].minutes, state.dailyCalls[i].minutes, '本地与每日必须同值')
    assert.strictEqual(state.localCalls[i].minutes, 3)
  }
})

test('CLOUD_LEGACY_SESSION_STILL_CARRIES_BOOK_ID_AND_WRITES_BOOKS_MINUTES', async () => {
  const { state, deps } = makeDeps()
  const s = S.createReadingSession(deps)
  s.begin({ localId: null, bookId: 'cloud_9' })
  advance(state, 2 * 60000)
  const res = await s.settle('UNLOAD')
  assert.strictEqual(state.dailyCalls[0].bookId, 'cloud_9')
  assert.strictEqual(res.localId, null)
  assert.strictEqual(state.localCalls.length, 0, '云端会话不得写本机分钟')
  assert.deepStrictEqual(state.cloudCalls, [{ bookId: 'cloud_9', minutes: 2 }], '旧云端 books.minutes 必须继续累加')
  assert.strictEqual(res.cloudBookMinutesOk, true)
})

test('CLOUD_BOOK_MINUTES_FAILURE_DOES_NOT_BREAK_DAILY_STATS', async () => {
  const { state, deps } = makeDeps({ cloudFails: true })
  const s = S.createReadingSession(deps)
  s.begin({ localId: null, bookId: 'cloud_9' })
  advance(state, 60000)
  const res = await s.settle('UNLOAD')
  assert.strictEqual(res.settled, true)
  assert.strictEqual(res.dailySynced, true)
  assert.strictEqual(res.cloudBookMinutesOk, false, '失败必须如实回报')
  assert.ok(state.errors.some(e => e.tag === 'CLOUD_BOOK_MINUTES_FAILED'))
})

test('DAILY_REJECT_BUFFERS_PENDING_AND_TOASTS', async () => {
  const { state, deps } = makeDeps({ dailyFails: 'reject' })
  const s = S.createReadingSession(deps)
  s.begin({ localId: 'lb_1' })
  advance(state, 5 * 60000)
  const res = await s.settle('HIDE')
  assert.strictEqual(res.settled, true)
  assert.strictEqual(res.dailyFailed, true)
  assert.strictEqual(res.dailySynced, false)
  assert.strictEqual(state.localCalls.length, 1, '每日失败不得回滚已写入的本机分钟')
  assert.strictEqual(state.pendingCalls.length, 1, '失败事实必须落待补报队列')
  assert.strictEqual(state.pendingCalls[0].minutes, 5)
  assert.strictEqual(state.pendingCalls[0].localId, 'lb_1')
  assert.match(state.pendingCalls[0].date, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(state.pendingCalls[0].requestId, '待补报条目必须带幂等 requestId')
  assert.strictEqual(state.pendingCalls[0].requestId, state.dailyCalls[0].requestId, '重放必须复用同一个 requestId')
  assert.strictEqual(state.toasts.length, 1)
  assert.match(state.toasts[0].title, /待补报/)
  assert.ok(state.errors.some(e => e.tag === 'DAILY_READ_SYNC_FAILED'))
})

test('DAILY_RESULT_NOT_OK_COUNTS_AS_FAILURE', async () => {
  const { state, deps } = makeDeps({ dailyFails: 'notok' })
  const s = S.createReadingSession(deps)
  s.begin({ localId: 'lb_1' })
  advance(state, 60000)
  const res = await s.settle('HIDE')
  assert.strictEqual(res.dailyFailed, true)
  assert.strictEqual(state.pendingCalls.length, 1)
  assert.ok(state.errors.some(e => e.tag === 'DAILY_READ_SYNC_FAILED' && e.info.code === 'DAILY_DOC_MISSING'))
})

test('PENDING_SINK_FAILURE_IS_REPORTED_NOT_SWALLOWED', async () => {
  const { state, deps } = makeDeps({ dailyFails: 'reject', bufferFails: true })
  const s = S.createReadingSession(deps)
  s.begin({ localId: 'lb_1' })
  advance(state, 60000)
  await s.settle('HIDE')
  assert.ok(state.errors.some(e => e.tag === 'DAILY_PENDING_WRITE_FAILED'))
})

// ---------------- 失败与异常 ----------------

test('LOCAL_MINUTES_FAILURE_DOES_NOT_BLOCK_DAILY_STATS', async () => {
  const { state, deps } = makeDeps({ localFails: true })
  const s = S.createReadingSession(deps)
  s.begin({ localId: 'lb_1' })
  advance(state, 3 * 60000)
  const res = await s.settle('HIDE')
  assert.strictEqual(res.settled, true)
  assert.strictEqual(res.dailySynced, true, '本机写失败不得连带丢掉每日统计')
  assert.strictEqual(state.dailyCalls.length, 1)
  assert.ok(state.errors.some(e => e.tag === 'LOCAL_MINUTES_WRITE_FAILED'))
})

test('SKIPPED_LOCAL_WRITE_IS_WARNED_NOT_ERRORED', async () => {
  const { state, deps } = makeDeps()
  deps.addLocalMinutes = (localId, minutes) => {
    state.localCalls.push({ localId, minutes })
    return Promise.resolve({ ok: false, skipped: true, reason: 'ENTRY_GONE' })
  }
  const s = S.createReadingSession(deps)
  s.begin({ localId: 'lb_deleted' })
  advance(state, 2 * 60000)
  const res = await s.settle('HIDE')
  assert.strictEqual(res.settled, true)
  assert.strictEqual(res.dailySynced, true, '书被删了，但当日阅读统计仍应记上')
  assert.strictEqual(state.dailyCalls.length, 1)
  assert.ok(state.warns.some(w => w.tag === 'LOCAL_MINUTES_SKIPPED' && w.info.reason === 'ENTRY_GONE'))
})

test('CARRY_PERSIST_FAILURE_IS_REPORTED_NOT_SILENT', async () => {
  const { state, deps } = makeDeps({ carryFails: true })
  const s = S.createReadingSession(deps)
  s.begin({ localId: 'lb_1' })
  advance(state, 5 * 60000 + 30000)
  const res = await s.settle('HIDE')
  assert.strictEqual(res.minutes, 5, '余量写失败不得影响已经确认的整分钟')
  assert.ok(state.errors.some(e => e.tag === 'READ_CARRY_WRITE_FAILED'))
})

test('SETTLE_NEVER_REJECTS_EVEN_IF_DEP_THROWS', async () => {
  const { deps } = makeDeps()
  deps.addLocalMinutes = () => { throw new Error('sync boom') }
  const s = S.createReadingSession(deps)
  s.begin({ localId: 'lb_1' })
  const res = await s.settle('HIDE')
  assert.strictEqual(res.settled, true)
  assert.strictEqual(res.localId, 'lb_1')
})

test('RESET_AND_PEEK', async () => {
  const { deps } = makeDeps()
  const s = S.createReadingSession(deps)
  s.begin({ localId: 'lb_1', bookId: null })
  assert.strictEqual(s.active(), true)
  assert.strictEqual(s.isFor('lb_1'), true)
  assert.strictEqual(s.isFor('lb_2'), false)
  assert.strictEqual(s.peek().localId, 'lb_1')
  s.reset()
  assert.strictEqual(s.active(), false)
  const res = await s.settle('HIDE')
  assert.strictEqual(res.settled, false)
})

test('DEFAULT_DEPS_ARE_SAFE_NO_OPS', async () => {
  // 1) 零时长（默认 now 走真实时间，begin 与 settle 之间几乎为 0）→ 不记账、不触网
  const s = S.createReadingSession()
  s.begin({ localId: 'lb_1' })
  const instant = await s.settle('HIDE')
  assert.strictEqual(instant.settled, true)
  assert.strictEqual(instant.minutes, 0)
  assert.strictEqual(instant.recorded, false)
  assert.strictEqual(instant.dailySynced, null, '没有记账就不存在同步结果，绝不谎报成功')

  // 2) 确实记账但没注入每日统计实现 → 必须如实上报失败
  const state = { clock: 0 }
  const s2 = S.createReadingSession({ now: () => state.clock })
  s2.begin({ localId: 'lb_1' })
  state.clock += 60000
  const res = await s2.settle('HIDE')
  assert.strictEqual(res.settled, true)
  assert.strictEqual(res.minutes, 1)
  assert.strictEqual(res.dailySynced, false, '没有注入每日统计时必须如实上报失败而不是假装成功')
  assert.strictEqual(res.dailyFailed, true)
})

test('DEFAULT_DATE_FORMAT_IS_LOCAL_YYYY_MM_DD', () => {
  assert.strictEqual(S.fmtDate(new Date(2026, 9, 16)), '2026-10-16')
  assert.strictEqual(S.pad2(3), '03')
})

test('REQUEST_ID_IS_UNIQUE_PER_SETTLEMENT', () => {
  const seen = new Set()
  for (let i = 0; i < 200; i++) seen.add(S.newRequestId())
  assert.strictEqual(seen.size, 200, 'requestId 必须唯一，否则幂等会把不同结算误判为重复')
})

// ---------------- 余量存储本身 ----------------

test('CARRY_STORE_ROUND_TRIP_AND_CAPPING', () => {
  const store = C.createCarryStore(require('./mock-fs').createMockStorage())
  assert.strictEqual(store.get('L:a'), 0)
  assert.strictEqual(store.add('L:a', 20000).ms, 20000)
  assert.strictEqual(store.add('L:a', 20000).ms, 40000)
  assert.strictEqual(store.get('L:a'), 40000)
  // 余量恒 < 1 分钟（余数语义）
  assert.strictEqual(C.normalizeCarryMs(60000), C.MAX_CARRY_MS)
  assert.strictEqual(C.normalizeCarryMs(-5), 0)
  store.set('L:a', 0)
  assert.strictEqual(store.get('L:a'), 0, 'set 0 必须清掉该键')
  assert.deepStrictEqual(store.snapshot(), {})

  // 键数量有上限，不无限增长
  for (let i = 0; i < C.MAX_ENTRIES + 10; i++) store.set('L:k' + i, 1000, 1000 + i)
  assert.ok(Object.keys(store.snapshot()).length <= C.MAX_ENTRIES)
})

test('CARRY_KEY_NAMESPACE_HELPER', () => {
  assert.strictEqual(C.carryKeyFor('lb_1', null), 'L:lb_1')
  assert.strictEqual(C.carryKeyFor(null, 'c1'), 'C:c1')
  assert.strictEqual(C.carryKeyFor(null, null), '')
})

// ---------------- 待补报队列：幂等重放 ----------------

test('PENDING_QUEUE_EXPOSES_IDEMPOTENT_REPLAY_API', () => {
  const api = Object.keys(dp.createDailyPendingStore({ read: () => '', write: () => undefined }))
  assert.deepStrictEqual(api.sort(), ['clear', 'push', 'read', 'remove', 'size'])
})

test('LEGACY_PENDING_ENTRIES_GET_A_DETERMINISTIC_REQUEST_ID', () => {
  const a = dp.normalizeEntry({ date: '2026-10-15', minutes: 3, localId: 'lb_1', at: 1 })
  const b = dp.normalizeEntry({ date: '2026-10-15', minutes: 3, localId: 'lb_1', at: 1 })
  assert.strictEqual(a.requestId, b.requestId, '同一条目的多次读取必须得到同一个 requestId，重放才幂等')
  const c = dp.normalizeEntry({ date: '2026-10-15', minutes: 3, localId: 'lb_1', at: 2 })
  assert.notStrictEqual(a.requestId, c.requestId)
})

test('FLUSH_REPLAYS_ONLY_CONFIRMED_ENTRIES_AND_IS_IDEMPOTENT', async () => {
  const storage = require('./mock-fs').createMockStorage()
  const store = dp.createDailyPendingStore(storage)
  store.push({ date: '2026-10-15', minutes: 3, localId: 'lb_1', requestId: 'r1' })
  store.push({ date: '2026-10-15', minutes: 4, requestId: 'r2' })

  const seen = new Set()
  const applied = { total: 0 }
  const callDailyRead = data => {
    if (seen.has(data.requestId)) return Promise.resolve({ result: { ok: true, idempotent: true } })
    seen.add(data.requestId)
    applied.total += Number(data.minutes) || 0
    return Promise.resolve({ result: { ok: true } })
  }

  const r1 = await dp.flushDailyPending({ store, callDailyRead })
  assert.strictEqual(r1.attempted, 2)
  assert.strictEqual(r1.applied, 2)
  assert.strictEqual(r1.remaining, 0, '全部成功必须清空队列')
  assert.strictEqual(applied.total, 7)

  const r2 = await dp.flushDailyPending({ store, callDailyRead })
  assert.strictEqual(r2.attempted, 0, '第二次重放无事可做')
  assert.strictEqual(applied.total, 7, '绝不允许重复累计')
})

test('FLUSH_KEEPS_FAILED_ENTRIES_AND_NEVER_DROPS_THEM_SILENTLY', async () => {
  const storage = require('./mock-fs').createMockStorage()
  const store = dp.createDailyPendingStore(storage)
  store.push({ date: '2026-10-15', minutes: 3, requestId: 'ok1' })
  store.push({ date: '2026-10-15', minutes: 4, requestId: 'bad1' })

  const res = await dp.flushDailyPending({
    store,
    callDailyRead: data => (data.requestId === 'bad1'
      ? Promise.reject(Object.assign(new Error('net'), { errMsg: 'fail' }))
      : Promise.resolve({ result: { ok: true } }))
  })
  assert.strictEqual(res.applied, 1)
  assert.strictEqual(res.failed, 1)
  assert.strictEqual(res.remaining, 1, '失败条目必须保留等下次')
  assert.deepStrictEqual(store.read().map(e => e.requestId), ['bad1'])
})

test('FLUSH_NEVER_SENDS_BOOK_ID_FOR_LOCAL_ENTRIES', async () => {
  const storage = require('./mock-fs').createMockStorage()
  const store = dp.createDailyPendingStore(storage)
  store.push({ date: '2026-10-15', minutes: 3, localId: 'lb_1', bookId: 'should_be_ignored', requestId: 'r1' })
  const sent = []
  await dp.flushDailyPending({ store, callDailyRead: d => { sent.push(d); return Promise.resolve({ result: { ok: true } }) } })
  assert.strictEqual(sent.length, 1)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(sent[0], 'bookId'), false, '本机书重放也绝不允许带 bookId')
})

test('FLUSH_ON_UNAVAILABLE_STORE_IS_SAFE', async () => {
  const res = await dp.flushDailyPending({})
  assert.strictEqual(res.unavailable, true)
  assert.strictEqual(res.attempted, 0)
})
