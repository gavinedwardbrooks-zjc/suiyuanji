// ============================================================
// tests/reading-daily-idempotency.test.js · 每日阅读统计幂等与补报
//
// 契约（用户明确要求）：
//   - 每次结算使用稳定 requestId
//   - 同 requestId 重复提交不重复累计
//   - 超时 / 响应丢失后可安全重试
//   - 重进小程序可恢复待补报
//   - 本地分钟不因云端失败回滚
//   - 云端成功后才安全移出队列
//   - 本地书更新绝不写云端 books.minutes
//
// 本文件真实执行 pages/reading/reading.js + utils/readingSession.js
// + utils/readingDailyPending.js + cloudfunctions/dailyRecord（幂等模型）。
// ============================================================
const test = require('node:test')
const assert = require('node:assert/strict')

const lb = require('../utils/localBooks')
const dp = require('../utils/readingDailyPending')
const { createReadingHarness } = require('./reading-page-harness')

const MINUTE_MS = 60000

function harness(t, options) {
  const h = createReadingHarness(options)
  t.after(() => h.dispose())
  return h
}

function parseIndex(storage) {
  const raw = storage.read(lb.STORAGE_KEY)
  return raw ? JSON.parse(raw) : null
}

function entryOf(h, localId) {
  const idx = parseIndex(h.storage)
  return ((idx && idx.books) || []).find(b => b.localId === localId) || null
}

function pendingRaw(h) {
  const raw = h.storage.read(dp.PENDING_KEY)
  return raw ? JSON.parse(raw) : null
}

function flush(times) {
  const n = times || 10
  let p = Promise.resolve()
  for (let i = 0; i < n; i++) p = p.then(() => new Promise(r => setImmediate(r)))
  return p
}

async function importBook(h, page, name, size) {
  h.ctx.pushFile(h.seedTempFile(name, size || 4096))
  await page.importBook()
  return page.data.localBooks[0]
}

// 让页面以确定时长完成一次「打开 → 后台结算」
async function readForMinutes(h, page, target, minutes, reason) {
  h.useClock(1700000000000)
  page.startReadingSession(target)
  h.advanceClock(minutes * MINUTE_MS)
  return page.settleSession(reason || 'TEST_HIDE')
}

// 一个「真实云函数行为」的替身：按 requestId 去重后再累加
function makeIdempotentCloud() {
  const state = { readProgress: 0, applied: [], calls: [] }
  return {
    state,
    call(data) {
      state.calls.push(Object.assign({}, data))
      if (data.date && data.minutes > 0 && data.requestId) {
        if (state.applied.indexOf(data.requestId) === -1) {
          state.applied.push(data.requestId)
          state.readProgress += data.minutes
          return Promise.resolve({ result: { ok: true } })
        }
        return Promise.resolve({ result: { ok: true, idempotent: true, readProgress: state.readProgress } })
      }
      return Promise.resolve({ result: { ok: true, skipped: true } })
    }
  }
}

// ---------------- 1. 云端失败 → 待补报，本地不回滚 ----------------

test('DAILY_FAILURE_BUFFERS_PENDING_AND_KEEPS_LOCAL_MINUTES', async t => {
  const h = harness(t, { callFunctionFails: true })
  const page = h.load()
  const b = await importBook(h, page, '本地书.pdf', 4096)

  const res = await readForMinutes(h, page, { localId: b.localId }, 2)

  assert.strictEqual(res.settled, true)
  assert.strictEqual(res.minutes, 2)
  assert.strictEqual(res.dailySynced, false)
  assert.strictEqual(res.dailyFailed, true)
  assert.strictEqual(typeof res.requestId, 'string')
  assert.ok(res.requestId.length > 0, '每次结算必须有稳定 requestId')

  // 本地分钟已落地，且不因云端失败回滚
  assert.strictEqual(entryOf(h, b.localId).minutes, 2)

  // 失败事实必须落地到待补报队列
  const q = pendingRaw(h)
  assert.strictEqual(q.length, 1)
  assert.strictEqual(q[0].requestId, res.requestId, '队列必须复用同一次结算的 requestId')
  assert.strictEqual(q[0].minutes, 2)
  assert.strictEqual(q[0].localId, b.localId)
  assert.strictEqual(q[0].bookId, null, '本机书绝不允许在队列里带 bookId')
  assert.match(q[0].date, /^\d{4}-\d{2}-\d{2}$/)

  assert.ok(h.toastTitles().includes('今日阅读统计未同步，已记为待补报'))
  assert.ok(h.errors.some(a => String(a[0]).indexOf('DAILY_READ_SYNC_FAILED') !== -1),
    '失败必须有明确错误日志，绝不静默')
})

test('LOCAL_BOOK_SESSION_NEVER_SENDS_BOOK_ID_TO_CLOUD', async t => {
  const h = harness(t)
  const page = h.load()
  const b = await importBook(h, page, '本地书.txt', 4096)

  await readForMinutes(h, page, { localId: b.localId }, 1)

  const sent = h.calls.callFunctionData[0]
  assert.strictEqual(sent.action, 'addRead')
  assert.strictEqual(sent.minutes, 1)
  assert.strictEqual(sent.bookId, undefined, '本机书的每日统计不得携带 bookId')
  assert.deepStrictEqual(h.calls.booksUpdate, [], '本机书绝不允许写云端 books')
})

test('CLOUD_BOOK_SESSION_KEEPS_BOOK_ID_AND_CLOUD_MINUTES', async t => {
  // 单一写入方（2026-10-16）：books.minutes 由云函数 addRead 在**同一个事务**里
  // 与 readProgress 一起累加；客户端不再直写云端 books。
  // 改动前客户端和云函数各写一次 ⇒ 每次结算 books.minutes 累计两次（V1 起的历史缺陷）。
  const h = harness(t, { cloudDb: true, cloudBooks: [{ _id: 'cloud_b1', name: '云端旧书', minutes: 0 }] })
  const page = h.load()

  const res = await readForMinutes(h, page, { bookId: 'cloud_b1' }, 3)

  assert.strictEqual(res.minutes, 3)
  assert.strictEqual(h.calls.callFunctionData[0].bookId, 'cloud_b1', '云端书继续带 bookId')
  assert.deepStrictEqual(h.calls.booksUpdate, [], '客户端不得直写云端 books（否则又是两个写入方）')
  assert.strictEqual(h.cloud.book('cloud_b1').minutes, 3, '云函数在同一事务里恰好累加一次')
  const rec = h.cloud.record()
  assert.strictEqual(rec.readProgress, 3, 'readProgress 与 books.minutes 同事务、都只记一次')
  assert.strictEqual(rec.readRequestIds.length, 1)
})

test('DAILY_SUCCESS_LEAVES_QUEUE_EMPTY', async t => {
  const h = harness(t)
  const page = h.load()
  const b = await importBook(h, page, '成功.pdf', 2048)

  const res = await readForMinutes(h, page, { localId: b.localId }, 4)

  assert.strictEqual(res.dailySynced, true)
  assert.strictEqual(pendingRaw(h), null, '成功时不得写待补报')
  assert.strictEqual(h.toastTitles().filter(x => x.indexOf('未同步') !== -1).length, 0)
})

// ---------------- 2. 重放：同一 requestId，成功后才出队 ----------------

test('REPLAY_REUSES_SAME_REQUEST_ID_AND_DRAINS_ON_SUCCESS', async t => {
  const h = harness(t, { callFunctionFailTimes: 1 })
  const page = h.load()
  const b = await importBook(h, page, '重放.pdf', 4096)

  const first = await readForMinutes(h, page, { localId: b.localId }, 2)
  assert.strictEqual(first.dailyFailed, true)
  const queuedId = pendingRaw(h)[0].requestId

  // 网络恢复 → 重进页面触发补报
  const replay = await page.flushDailyPendingQuietly()

  assert.strictEqual(replay.attempted, 1)
  assert.strictEqual(replay.applied, 1)
  assert.strictEqual(replay.remaining, 0, '云端确认成功后才能出队')
  const sent = h.calls.callFunctionData[h.calls.callFunctionData.length - 1]
  assert.strictEqual(sent.requestId, queuedId, '重放必须复用同一个 requestId')
  assert.strictEqual(sent.minutes, 2)
  assert.strictEqual(sent.bookId, undefined)
})

test('REPLAY_KEEPS_ENTRY_WHEN_CLOUD_STILL_FAILS', async t => {
  const h = harness(t, { callFunctionFails: true })
  const page = h.load()
  const b = await importBook(h, page, '一直失败.pdf', 4096)

  await readForMinutes(h, page, { localId: b.localId }, 2)
  const before = pendingRaw(h)

  const replay = await page.flushDailyPendingQuietly()

  assert.strictEqual(replay.attempted, 1)
  assert.strictEqual(replay.applied, 0)
  assert.strictEqual(replay.failed, 1)
  assert.strictEqual(replay.remaining, 1, '失败条目必须留在队列里等下次')
  assert.deepStrictEqual(pendingRaw(h), before, '重放失败不得改动队列内容')
  assert.strictEqual(entryOf(h, b.localId).minutes, 2, '本地分钟依然不被回滚')
})

test('REPLAY_IS_IDEMPOTENT_WHEN_CLOUD_ALREADY_APPLIED', async t => {
  // 场景：请求已到达云端并成功写入，但响应在回程丢失 → 本地以为失败并入了队列。
  // 重放时云端按 requestId 判重，因此绝不能二次累计。
  const h = harness(t)
  const page = h.load()
  const cloud = makeIdempotentCloud()
  h.wx.cloud.callFunction = o => {
    h.calls.callFunction += 1
    h.calls.callFunctionData.push(o && o.data)
    return cloud.call(o && o.data)
  }

  const b = await importBook(h, page, '丢响应.pdf', 4096)
  const res = await readForMinutes(h, page, { localId: b.localId }, 5)
  assert.strictEqual(res.dailySynced, true)
  assert.strictEqual(cloud.state.readProgress, 5)

  // 人为把这次已成功的结算塞进待补报（模拟「响应丢失」）
  dp.getDailyPending().push({
    date: h.calls.callFunctionData[0].date,
    minutes: 5,
    localId: b.localId,
    requestId: res.requestId,
    at: Date.now()
  })

  const replay = await page.flushDailyPendingQuietly()
  assert.strictEqual(replay.applied, 1)
  assert.strictEqual(replay.remaining, 0)
  assert.strictEqual(cloud.state.readProgress, 5, '重放绝不重复累计（云端按 requestId 判重）')
  assert.strictEqual(cloud.state.applied.length, 1)
})

test('REPLAY_TWICE_WITH_SAME_REQUEST_ID_NEVER_DOUBLES', async t => {
  const h = harness(t)
  const page = h.load()
  const cloud = makeIdempotentCloud()
  h.wx.cloud.callFunction = o => {
    h.calls.callFunction += 1
    h.calls.callFunctionData.push(o && o.data)
    return cloud.call(o && o.data)
  }

  const b = await importBook(h, page, '两次重放.pdf', 4096)
  const res = await readForMinutes(h, page, { localId: b.localId }, 6)

  // 同一 requestId 连播两次
  const date = h.calls.callFunctionData[0].date
  dp.getDailyPending().push({ date, minutes: 6, localId: b.localId, requestId: res.requestId, at: 1 })
  await page.flushDailyPendingQuietly()
  const progressAfterFirst = cloud.state.readProgress
  dp.getDailyPending().push({ date, minutes: 6, localId: b.localId, requestId: res.requestId, at: 2 })
  await page.flushDailyPendingQuietly()

  assert.strictEqual(cloud.state.readProgress, progressAfterFirst)
  assert.strictEqual(cloud.state.readProgress, 6)
})

// ---------------- 3. 重进小程序恢复待补报 ----------------

test('REENTERING_PAGE_RECOVERS_PENDING_FROM_STORAGE', async t => {
  const h = harness(t, { callFunctionFailTimes: 1 })
  const page = h.load()
  const b = await importBook(h, page, '重进恢复.pdf', 4096)

  const res = await readForMinutes(h, page, { localId: b.localId }, 3)
  assert.strictEqual(res.dailyFailed, true)
  assert.strictEqual(pendingRaw(h).length, 1)

  // 模拟「退出小程序 → 重新进入」：同一存储/文件系统上新建页面实例
  const page2 = h.reload()
  const rec = await page2.flushDailyPendingQuietly()

  assert.strictEqual(rec.attempted, 1)
  assert.strictEqual(rec.applied, 1)
  assert.strictEqual((pendingRaw(h) || []).length, 0, '恢复后队列必须清空')
  const sent = h.calls.callFunctionData[h.calls.callFunctionData.length - 1]
  assert.strictEqual(sent.requestId, res.requestId, '恢复重放必须沿用原 requestId')
})

test('ONSHOW_FLUSHES_PENDING_QUIETLY', async t => {
  const h = harness(t, { callFunctionFailTimes: 1 })
  const page = h.load()
  const b = await importBook(h, page, 'onShow.pdf', 4096)

  await readForMinutes(h, page, { localId: b.localId }, 2)
  assert.strictEqual(pendingRaw(h).length, 1)

  await page.onShow()
  await flush()

  assert.strictEqual((pendingRaw(h) || []).length, 0, 'onShow 必须顺带把待补报安全重放')
})

// ---------------- 4. 历史条目（无 requestId）也要幂等 ----------------

test('LEGACY_PENDING_ENTRY_GETS_DETERMINISTIC_REQUEST_ID', async t => {
  const h = harness(t)
  const page = h.load()
  const cloud = makeIdempotentCloud()
  h.wx.cloud.callFunction = o => {
    h.calls.callFunction += 1
    h.calls.callFunctionData.push(o && o.data)
    return cloud.call(o && o.data)
  }

  // 本版之前写入的历史条目：没有 requestId
  const legacy = { date: '2026-08-26', minutes: 7, localId: 'lb_legacy', at: 1000 }
  h.storage.write(dp.PENDING_KEY, JSON.stringify([legacy]))

  const expected = dp.deriveRequestId(legacy)
  const r1 = await page.flushDailyPendingQuietly()
  assert.strictEqual(r1.applied, 1)
  assert.strictEqual(h.calls.callFunctionData[0].requestId, expected, '历史条目必须派生确定性 id')

  // 同一条历史条目再次出现（例如写入被回滚）：派生 id 相同 → 云端判重
  h.storage.write(dp.PENDING_KEY, JSON.stringify([legacy]))
  await page.flushDailyPendingQuietly()
  assert.strictEqual(cloud.state.readProgress, 7, '同一条历史条目多次重放不得重复累计')
})

test('QUEUE_DEDUPES_SAME_REQUEST_ID', async t => {
  const h = harness(t)
  const store = dp.createDailyPendingStore({
    read: k => h.storage.read(k),
    write: (k, v) => h.storage.write(k, v)
  })

  store.push({ date: '2026-08-26', minutes: 2, localId: 'lb1', requestId: 'same', at: 1 })
  store.push({ date: '2026-08-26', minutes: 2, localId: 'lb1', requestId: 'same', at: 2 })

  assert.strictEqual(store.read().length, 1, '同 requestId 只保留一条，避免重复重放')
})

// ---------------- 5. 队列写入失败不得静默 ----------------

test('PENDING_WRITE_FAILURE_IS_LOGGED_NOT_SILENT', async t => {
  const h = harness(t, { callFunctionFails: true })
  const page = h.load()
  const b = await importBook(h, page, '队列写失败.pdf', 4096)

  h.storage.failWriteFor(dp.PENDING_KEY)
  const res = await readForMinutes(h, page, { localId: b.localId }, 2)

  assert.strictEqual(res.dailyFailed, true)
  assert.strictEqual(entryOf(h, b.localId).minutes, 2, '队列写失败也不得回滚本地分钟')
  assert.ok(
    h.errors.some(a => String(a[0]).indexOf('DAILY_PENDING_WRITE_FAILED') !== -1),
    '待补报写失败必须留日志，绝不静默丢弃'
  )
  assert.ok(h.toastTitles().includes('今日阅读统计未同步，已记为待补报'))
})

// ---------------- 6. 与云端 books / 其他业务字段零串扰 ----------------

test('LOCAL_MINUTES_AND_DAILY_MINUTES_ARE_THE_SAME_VALUE', async t => {
  const h = harness(t)
  const page = h.load()
  const b = await importBook(h, page, '同源同值.pdf', 4096)

  const res = await readForMinutes(h, page, { localId: b.localId }, 9)

  assert.strictEqual(res.minutes, 9)
  assert.strictEqual(entryOf(h, b.localId).minutes, 9, '本地单书分钟')
  assert.strictEqual(h.calls.callFunctionData[0].minutes, 9, '每日阅读分钟')
  assert.strictEqual(h.calls.callFunctionData[0].minutes, res.minutes, '两者必须同源同值')
})

test('ZERO_MINUTE_SETTLE_NEVER_CALLS_CLOUD', async t => {
  const h = harness(t)
  const page = h.load()
  const b = await importBook(h, page, '不足一分钟.pdf', 4096)

  const res = await readForMinutes(h, page, { localId: b.localId }, 0.75)

  assert.strictEqual(res.minutes, 0)
  assert.strictEqual(res.recorded, false)
  assert.strictEqual(h.calls.callFunction, 0, '不足一分钟绝不调云端（不虚构、不浪费一次幂等键）')
  assert.strictEqual(h.calls.booksUpdate.length, 0)
  assert.strictEqual(pendingRaw(h), null)
  assert.strictEqual(entryOf(h, b.localId).minutes, 0)
})

test('DAILY_READ_SENDS_EXACT_DATE_AND_ACTION', async t => {
  const h = harness(t)
  const page = h.load()
  const b = await importBook(h, page, '字段.pdf', 4096)

  await readForMinutes(h, page, { localId: b.localId }, 1)

  const sent = h.calls.callFunctionData[0]
  assert.deepStrictEqual(Object.keys(sent).sort(), ['action', 'date', 'minutes', 'requestId'])
  assert.strictEqual(sent.action, 'addRead')
  assert.match(sent.date, /^\d{4}-\d{2}-\d{2}$/)
})

test('MIGRATED_LOCAL_BOOK_USES_LOCAL_PATH_ONLY', async t => {
  // 从云端迁移过来的书：本机文件 + migratedFrom，但计时必须走本机链路
  const h = harness(t)
  const page = h.load()
  const b = await importBook(h, page, '迁移来的.pdf', 4096)

  const idx = parseIndex(h.storage)
  idx.books[0].migratedFrom = 'cloud_book_1'
  h.storage.write(lb.STORAGE_KEY, JSON.stringify(idx))

  await readForMinutes(h, page, { localId: b.localId }, 2)

  assert.strictEqual(h.calls.callFunctionData[0].bookId, undefined)
  assert.deepStrictEqual(h.calls.booksUpdate, [], '迁移后的本机书不得再写云端 books')
  assert.strictEqual(entryOf(h, b.localId).minutes, 2)
})

// ============================================================
// 端到端：客户端账本 + **真实云函数**（事务原子幂等）
// 上面各用例用空壳云返回验证客户端自己的账本；这里把 dailyRecord 换成真实
// 云函数代码（{ cloudDb: true }），验证「重放 / 并发重放」在服务端也精确一次。
// ============================================================

test('E2E_REPLAY_AFTER_LOST_RESPONSE_COUNTS_ONCE_ON_REAL_CLOUD_FUNCTION', async t => {
  const h = harness(t, { cloudDb: true })
  const page = h.load()
  const b = await importBook(h, page, '丢响应.pdf', 4096)

  const res = await readForMinutes(h, page, { localId: b.localId }, 3)
  assert.strictEqual(res.dailySynced, true)
  const sent = h.calls.callFunctionData[0]
  assert.strictEqual(h.cloud.record().readProgress, 3, '服务端已累计')

  // 模拟「云端已提交但响应丢失」：客户端并不知道成功，把同一条塞回待补报
  h.storage.write(dp.PENDING_KEY, JSON.stringify([
    { date: sent.date, minutes: sent.minutes, localId: b.localId, requestId: sent.requestId, at: 2 }
  ]))

  await page.flushDailyPendingQuietly()
  await flush()

  assert.strictEqual(h.cloud.record().readProgress, 3, '重放同一 requestId 不得重复累计')
  assert.strictEqual(h.cloud.record().readRequestIds.filter(x => x === sent.requestId).length, 1)
  assert.strictEqual((pendingRaw(h) || []).length, 0, '服务端确认幂等后队列必须排空')
  assert.strictEqual(entryOf(h, b.localId).minutes, 3, '本机分钟不因重放翻倍')
})

test('E2E_CONCURRENT_REPLAY_WITHOUT_SINGLEFLIGHT_IS_EXACTLY_ONCE', async t => {
  // 单飞锁只是「少发无用请求」的优化，**不是**幂等性的依据：
  // 这里主动把锁清掉（等价于两个进程各持一把锁 / 锁被重置），让同一条
  // 待补报被并发提交两次，服务端仍必须只累计一次。
  dp.resetFlushLock()
  t.after(() => dp.resetFlushLock())
  const h = harness(t, { cloudDb: true })
  const page = h.load()

  h.storage.write(dp.PENDING_KEY, JSON.stringify([
    { date: '2026-08-26', minutes: 4, localId: 'lb_x', requestId: 'rd_bypass', at: 1 }
  ]))

  const p1 = page.flushDailyPendingQuietly()
  dp.resetFlushLock() // 摧毁单飞锁：第二次触发不再 join 在飞链
  const p2 = page.flushDailyPendingQuietly()
  const [r1, r2] = await Promise.all([p1, p2])
  await flush()

  assert.ok(r1, '第一次触发的链必须正常结束')
  assert.ok(r2, '第二次触发的链必须正常结束')
  const rec = h.cloud.record()
  assert.strictEqual(h.cloud.records().length, 1, '只能有一条当日记录')
  assert.strictEqual(rec.readProgress, 4, '单飞失效也绝不重复累计（服务端事务是唯一保障）')
  assert.strictEqual(rec.readRequestIds.filter(x => x === 'rd_bypass').length, 1)
  const overlapped = h.cloud.stats.conflicts >= 1 || h.cloud.stats.retries >= 1
  assert.ok(overlapped,
    '两次提交必须真的并发重叠过（conflicts/retries > 0）；否则本用例没有验证到「不依赖单飞锁」这件事')
  assert.strictEqual((pendingRaw(h) || []).length, 0, '重放成功后队列排空')
})

test('E2E_REPEATED_LOCK_BYPASS_REPLAY_ROUNDS_STAY_EXACTLY_ONCE', async t => {
  dp.resetFlushLock()
  t.after(() => dp.resetFlushLock())
  const h = harness(t, { cloudDb: true })
  const page = h.load()

  for (let round = 0; round < 3; round++) {
    h.storage.write(dp.PENDING_KEY, JSON.stringify([
      { date: '2026-08-26', minutes: 5, localId: 'lb_y', requestId: 'rd_round', at: round + 1 }
    ]))
    const p1 = page.flushDailyPendingQuietly()
    dp.resetFlushLock()
    const p2 = page.flushDailyPendingQuietly()
    await Promise.all([p1, p2])
    await flush()
    assert.strictEqual(h.cloud.record().readProgress, 5, '第 ' + (round + 1) + ' 轮重放后仍只累计一次')
  }
  assert.strictEqual(h.cloud.record().readRequestIds.filter(x => x === 'rd_round').length, 1)
})
