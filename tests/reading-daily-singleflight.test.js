// ============================================================
// tests/reading-daily-singleflight.test.js · 每日统计重放：客户端不放大请求 + 服务端兜底
//
// 背景（2026-10-16 两轮修复）：
//   第一轮：发现云端 addRead 的判重「先查后写」非原子、幂等窗口过小
//     → 先用客户端单飞锁 + 放大窗口缓解（当时只能如此）。
//   第二轮（本次）：把幂等性真正落到**服务端** —— addRead 的「判重 + 累加
//     readProgress + 累加 books.minutes」整体跑在一个数据库事务里
//     （快照隔离 + 写锁 + 冲突自动重试）。
//   ⇒ 单飞锁与窗口**都不再承担正确性**：
//       · 单飞锁只负责「少发无用请求」（S1–S3、S7 验证这一点）
//       · 幂等窗口只负责「键数组有界」（S6 的跨文件不变量）
//       · 正确性由服务端事务保证 → tests/daily-record-atomic.test.js
//         以及 tests/reading-daily-idempotency.test.js 的 E2E_* 用例
//         （后者**故意清掉单飞锁**，让同一条待补报被并发提交两次，仍然只累计一次）
//
// 本文件真实执行 pages/reading/reading.js + utils/readingSession.js
// + utils/readingDailyPending.js，并配一个「非原子 + 有窗口」的云函数替身 ——
// 这个替身刻意保留改造前的并发缺陷，用来证明客户端单飞确实在减少重复提交
// （S0 就是它的阴性对照）。
// ============================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const lb = require('../utils/localBooks')
const dp = require('../utils/readingDailyPending')
const { createReadingHarness } = require('./reading-page-harness')

const MINUTE_MS = 60000

// 云端幂等窗口：同样从真实源码解析，避免测试与实现脱钩
const WINDOW = (() => {
  const src = fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/dailyRecord/index.js'), 'utf8')
  const m = /MAX_READ_REQUEST_IDS\s*=\s*(\d+)/.exec(src)
  if (!m) throw new Error('无法从云函数源码解析 MAX_READ_REQUEST_IDS')
  return Number(m[1])
})()

function harness(t, options) {
  dp.resetFlushLock()
  const h = createReadingHarness(options)
  t.after(() => {
    dp.resetFlushLock()
    h.dispose()
  })
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

function pendingList(h) {
  return pendingRaw(h) || []
}

function flush() {
  let p = Promise.resolve()
  for (let i = 0; i < 10; i++) p = p.then(() => new Promise(r => setImmediate(r)))
  return p
}

async function importBook(h, page, name, size) {
  h.ctx.pushFile(h.seedTempFile(name, size || 4096))
  await page.importBook()
  return page.data.localBooks[0]
}

async function readForMinutes(h, page, target, minutes, reason) {
  h.useClock(1700000000000)
  page.startReadingSession(target)
  h.advanceClock(minutes * MINUTE_MS)
  return page.settleSession(reason || 'TEST_HIDE')
}

// 云端替身：忠实模拟 dailyRecord/addRead 的两个关键性质
//   a) 判重跨一次 IO（先查、后写，中间有真实空隙）→ 并发同一 id 会双记
//   b) 窗口是**基于陈旧快照整份重写**的数组 → 并发写入会互相覆盖
function makeWindowedCloud(windowSize) {
  const state = { readProgress: 0, window: [], calls: [] }
  const tick = () => new Promise(r => setImmediate(r))
  return {
    state,
    async call(data) {
      state.calls.push(Object.assign({}, data))
      if (!data || !data.date || !(data.minutes > 0)) {
        return { result: { ok: true, skipped: true } }
      }
      const id = data.requestId ? String(data.requestId) : ''
      const snapshot = state.window.slice() // 先查
      const seen = id ? snapshot.indexOf(id) !== -1 : false
      await tick() // 真云：这里跨了一次数据库读
      if (id && seen) {
        return { result: { ok: true, idempotent: true, readProgress: state.readProgress } }
      }
      state.readProgress += data.minutes // 后写
      if (id) state.window = snapshot.concat([id]).slice(-windowSize)
      return { result: { ok: true } }
    }
  }
}

function routeCloud(h, cloud) {
  h.wx.cloud.callFunction = o => {
    h.calls.callFunction += 1
    h.calls.callFunctionData.push(o && o.data)
    return cloud.call(o && o.data)
  }
}

// 两个页面共享同一份底层存储（真实小程序只有一个 wx storage）
function makeSharedStorage() {
  const map = new Map()
  return {
    read: k => (map.has(k) ? map.get(k) : ''),
    write: (k, v) => { map.set(k, v) },
    remove: k => { map.delete(k) },
    peek: k => map.get(k)
  }
}

// ---------------- 1. 云函数替身的自证：它真的会因并发而双记 ----------------

test('S0 云函数替身自证：同一 requestId 并发提交会重复累计', async () => {
  // 这条用例是下面几条的「阴性对照」：先证明**这个替身**确实具备双记能力，
  // 否则 S1 的「只提交一次」可能是替身太宽容造成的假绿。
  // 注意：替身模拟的是**改造前**的云端行为（判重先查后写、非原子）。
  // 真实云函数现在用数据库事务保证原子幂等（见 tests/daily-record-atomic.test.js，
  // 其中 N4 是同款阴性对照）；本文件用这个「会双记」的替身，是为了让
  // 「客户端单飞减少了重复提交」这件事可被观测。
  const cloud = makeWindowedCloud(WINDOW)
  await Promise.all([
    cloud.call({ action: 'addRead', date: '2026-08-26', minutes: 5, requestId: 'rd_race' }),
    cloud.call({ action: 'addRead', date: '2026-08-26', minutes: 5, requestId: 'rd_race' })
  ])
  assert.strictEqual(cloud.state.readProgress, 10, '并发同一 requestId → 双记（与 A12 在真实云函数上的观察一致）')
  assert.strictEqual(cloud.state.calls.length, 2)
})

// ---------------- 2. 单飞：并发触发不得重复提交 ----------------

test('S1 并发触发重放 → 单飞，每个 requestId 只提交一次', async t => {
  const h = harness(t)
  const page = h.load()
  const cloud = makeWindowedCloud(WINDOW)
  routeCloud(h, cloud)

  // 队列里两条「已提交但未确认」（模拟响应丢失后网络恢复）
  h.storage.write(dp.PENDING_KEY, JSON.stringify([
    { date: '2026-08-26', minutes: 3, localId: 'lb_a', requestId: 'rd_a', at: 1 },
    { date: '2026-08-26', minutes: 4, localId: 'lb_b', requestId: 'rd_b', at: 2 }
  ]))

  // 真实可达的并发形状：书架页 onShow 的重放还在飞行中，
  // 用户点开本机 TXT → reading-txt 的 onLoad 又发起一次重放
  const p1 = page.flushDailyPendingQuietly()
  const p2 = page.flushDailyPendingQuietly()
  const [r1, r2] = await Promise.all([p1, p2])

  assert.strictEqual(dp.flushStats().joined, 1, '第二次触发必须 join 在飞链，而不是另起一条')
  assert.strictEqual(r2, r1, '两个触发点必须拿到同一个结算结果对象')
  assert.strictEqual(cloud.state.calls.filter(c => c.requestId === 'rd_a').length, 1, 'rd_a 恰好提交一次')
  assert.strictEqual(cloud.state.calls.filter(c => c.requestId === 'rd_b').length, 1, 'rd_b 恰好提交一次')
  assert.strictEqual(cloud.state.readProgress, 7, '并发场景下绝不重复累计')
  assert.strictEqual(pendingList(h).length, 0, '云端确认后队列必须排空')
  assert.strictEqual(dp.isFlushing(), false, '结算完成后必须释放锁')
})

test('S2 单飞链上并发三条触发 → 仍然只提交一轮', async t => {
  const h = harness(t)
  const page = h.load()
  const cloud = makeWindowedCloud(WINDOW)
  routeCloud(h, cloud)

  h.storage.write(dp.PENDING_KEY, JSON.stringify([
    { date: '2026-08-26', minutes: 2, localId: 'lb_a', requestId: 'rd_only', at: 1 }
  ]))

  const results = await Promise.all([
    page.flushDailyPendingQuietly(),
    page.flushDailyPendingQuietly(),
    page.flushDailyPendingQuietly()
  ])

  assert.strictEqual(results[1], results[0])
  assert.strictEqual(results[2], results[0])
  assert.strictEqual(cloud.state.calls.length, 1, '三次触发只产生一次提交')
  assert.strictEqual(cloud.state.readProgress, 2)
  assert.strictEqual(dp.flushStats().joined, 2)
})

test('S3 两个页面各自的 store 共享同一把锁（锁不绑在 store 实例上）', async () => {
  dp.resetFlushLock()
  try {
    const shared = makeSharedStorage()
    const storeA = dp.createDailyPendingStore(shared)
    const storeB = dp.createDailyPendingStore(shared)
    storeA.push({ date: '2026-08-26', minutes: 3, localId: 'lb_a', requestId: 'rd_shared', at: 1 })

    const cloud = makeWindowedCloud(WINDOW)
    const callDailyRead = data => cloud.call(data)

    const p1 = dp.flushDailyPending({ store: storeA, callDailyRead })
    const p2 = dp.flushDailyPending({ store: storeB, callDailyRead })
    const [r1, r2] = await Promise.all([p1, p2])

    assert.strictEqual(r2, r1, '第二个 store 的调用必须 join 第一个在飞链')
    assert.strictEqual(cloud.state.calls.length, 1, '即使 store 实例不同，也不得重复提交')
    assert.strictEqual(cloud.state.readProgress, 3)
    assert.deepStrictEqual(storeA.read(), [])
    assert.strictEqual(dp.flushStats().joined, 1)
  } finally {
    dp.resetFlushLock()
  }
})

// ---------------- 3. 结算成功即顺手补报（不依赖 onShow） ----------------

test('S4 云端刚被确认可达 → 顺手重放待补报，无需 onShow', async t => {
  // 修复前的危险链：失败入队 → 网络恢复但用户没离开阅读页（onShow 不触发）
  // → 期间不断成功结算、窗口可能挤掉入队的那条 → 下次 onShow 重放时重复累计。
  const h = harness(t, { callFunctionFailTimes: 1 })
  const page = h.load()
  const b = await importBook(h, page, '顺手补报.pdf', 4096)

  const first = await readForMinutes(h, page, { localId: b.localId }, 2)
  assert.strictEqual(first.dailyFailed, true, '第一次结算云端失败')
  const queued = pendingList(h)
  assert.strictEqual(queued.length, 1)
  const queuedId = queued[0].requestId

  const callsBefore = h.calls.callFunctionData.length
  const second = await readForMinutes(h, page, { localId: b.localId }, 3)
  assert.strictEqual(second.dailySynced, true, '第二次结算成功')
  await flush()

  const replayed = h.calls.callFunctionData.slice(callsBefore).filter(d => d.requestId === queuedId)
  assert.strictEqual(replayed.length, 1, '成功结算必须顺手重放队列里那条（不依赖 onShow）')
  assert.strictEqual(replayed[0].minutes, 2, '重放必须沿用原分钟数')
  assert.strictEqual(pendingList(h).length, 0, '重放成功后队列排空')
  assert.strictEqual(entryOf(h, b.localId).minutes, 5, '本机单书分钟 = 2 + 3')
})

test('S5 结算失败（离线）不得触发重放，不放大失败调用', async t => {
  const h = harness(t, { callFunctionFails: true })
  const page = h.load()
  const b = await importBook(h, page, '离线.pdf', 4096)

  await readForMinutes(h, page, { localId: b.localId }, 2)
  assert.strictEqual(pendingList(h).length, 1)

  const before = h.calls.callFunctionData.length
  await readForMinutes(h, page, { localId: b.localId }, 2)
  await flush()

  assert.strictEqual(h.calls.callFunctionData.length, before + 1,
    '云端不可达时只允许发起结算本身那一次调用，绝不额外发起重放')
  // 两次失败的结算各自入队一条（各自独立 requestId）：失败事实一条都不许丢
  const queued = pendingList(h)
  assert.strictEqual(queued.length, 2, '每次失败结算都必须留下自己的待补报条目')
  assert.notStrictEqual(queued[0].requestId, queued[1].requestId, '两条条目必须是不同的 requestId')
  assert.strictEqual(queued[0].minutes, 2)
  assert.strictEqual(queued[1].minutes, 2)
  assert.strictEqual(entryOf(h, b.localId).minutes, 4, '本地分钟继续累计，不回滚')
})

// ---------------- 4. 跨文件不变量：窗口 ≥ 队列上限 ----------------

test('S6 云端幂等窗口必须 ≥ 单日物理上界（跨文件不变量）', () => {
  assert.ok(WINDOW > 0, '窗口常量必须可解析')
  assert.ok(WINDOW >= dp.MAX_ENTRIES * 2,
    `云端幂等窗口(${WINDOW}) 必须 ≥ 客户端队列上限(${dp.MAX_ENTRIES}) 的 2 倍`)
  // 新不变量（2026-10-16）：窗口必须大于「一天物理可能的结算条数」。
  // 每条幂等键都对应一次 minutes > 0 的结算 ⇒ 至少代表 1 个已累计分钟，
  // 而一天只有 1440 分钟 ⇒ 单日键数不可能超过 1440。窗口大于它，
  // 真实数据下就**不可能发生淘汰**（窗口因此不再是一道靠容量赌大小的闸门）。
  assert.ok(WINDOW > 1440,
    `云端幂等窗口(${WINDOW}) 必须 > 1440（单日物理上界）：否则「已提交但未确认」的 key 仍可能被挤掉`)
  assert.ok(WINDOW <= 5000, `窗口(${WINDOW}) 不应无意义膨胀（超出单日上界即可，再多只是白占文档空间）`)
})

// ---------------- 5. 锁的释放：成功、异常、空队列 ----------------

test('S7 锁在空队列/成功/异常后都会释放（不会永久卡死重放）', async () => {
  dp.resetFlushLock()
  try {
    // 空队列：直接返回，不占锁
    const empty = dp.createDailyPendingStore(makeSharedStorage())
    const r0 = await dp.flushDailyPending({ store: empty, callDailyRead: () => Promise.resolve({ ok: true }) })
    assert.strictEqual(r0.attempted, 0)
    assert.strictEqual(dp.isFlushing(), false)

    // 成功路径
    const okStore = dp.createDailyPendingStore(makeSharedStorage())
    okStore.push({ date: '2026-08-26', minutes: 2, localId: 'lb', requestId: 'rd_ok', at: 1 })
    const r1 = await dp.flushDailyPending({ store: okStore, callDailyRead: () => Promise.resolve({ ok: true }) })
    assert.strictEqual(r1.applied, 1)
    assert.strictEqual(dp.isFlushing(), false)

    // 异常路径：remove 抛错 → 整条链 reject，锁必须照样释放
    const boom = {
      read: () => [{ date: '2026-08-26', minutes: 2, localId: 'lb', bookId: null, requestId: 'rd_boom', at: 1 }],
      remove: () => { throw new Error('remove boom') },
      size: () => 1
    }
    await assert.rejects(
      () => dp.flushDailyPending({ store: boom, callDailyRead: () => Promise.resolve({ ok: true }), logWarn: () => {} }),
      /remove boom/
    )
    assert.strictEqual(dp.isFlushing(), false, '异常后锁必须释放，否则后续补报永久失效')

    // 释放后仍能正常重放（页面侧对 reject 有 catch，不会打断用户）
    const after = dp.createDailyPendingStore(makeSharedStorage())
    after.push({ date: '2026-08-26', minutes: 2, localId: 'lb', requestId: 'rd_after', at: 2 })
    const r2 = await dp.flushDailyPending({ store: after, callDailyRead: () => Promise.resolve({ ok: true }) })
    assert.strictEqual(r2.applied, 1, '锁释放后重放必须恢复正常')
  } finally {
    dp.resetFlushLock()
  }
})
