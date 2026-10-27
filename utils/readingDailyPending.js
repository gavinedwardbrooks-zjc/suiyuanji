// ============================================================
// utils/readingDailyPending.js · 每日阅读统计「待补报」队列（最终版）
//
// 背景：本机书籍的阅读分钟先写本机（localBooks），再通过既有
// dailyRecord/addRead 链路累加当日 daily_records.readProgress。
// 云端调用失败时**不允许静默丢弃**，因此落一个显式的待补报队列，
// 并在下次进入阅读页时安全重放。
//
// 安全重放的三个前提（本版已满足）：
//   1. 每条待补报都带**稳定 requestId**（结算时生成、随条目持久化，
//      重放永远复用同一个 id）
//   2. 云端 addRead 的幂等是**原子的**：判重 + 累加 readProgress +
//      累加 books.minutes 跑在同一个数据库事务里（快照隔离 + 写锁 + 冲突重试，
//      见 cloudfunctions/dailyRecord/index.js）
//      → 「网络超时但实际已成功」「单飞失效导致并发提交」都不会重复累计。
//        正确性**不依赖本模块**，本模块只负责「少发无用请求」。
//   3. 重放**单飞** + 结算成功即顺手补报一次：
//      这是**性能与时效**优化（避免重复提交、把「未确认」条目尽快落地），
//      不是幂等性的依据 —— 单飞被绕过时服务端仍然只累计一次
//      （回归：tests/reading-daily-idempotency.test.js 的 E2E_* 用例
//        会主动清掉单飞锁并发提交同一条）。
//      队列上限 MAX_ENTRIES 与云端窗口的关系：窗口已开大到
//      > 单日物理上界(1440 分钟)，真实数据下不可能淘汰（见 tests 跨文件不变量）。
//
// 兼容边界：
//   - 历史条目（本版之前写入、没有 requestId）在读取时按内容派生一个
//     确定性 id：这样**同一条目的多次重放**彼此幂等，不会因重放本身
//     而重复累计。
//   - 队列条目只含 date / minutes / localId / bookId / requestId / at，
//     无任何身份字段。
//   - 队列容量有上限，超出时保留最新条目。
// ============================================================

const PENDING_KEY = 'readingDailyPending_v1'
const MAX_ENTRIES = 50

function isDateString(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
}

// 历史条目的确定性 id：同一份内容永远得到同一个 id
function deriveRequestId(entry) {
  const e = entry || {}
  const scope = e.localId ? 'L:' + e.localId : (e.bookId ? 'C:' + e.bookId : 'N')
  return ['legacy', e.date, e.minutes, scope, Number(e.at) || 0].join('|')
}

function normalizeEntry(raw) {
  const r = raw && typeof raw === 'object' ? raw : null
  if (!r) return null
  const date = isDateString(r.date) ? r.date : ''
  if (!date) return null
  const minutes = Number(r.minutes)
  if (!Number.isFinite(minutes) || minutes <= 0) return null
  const localId = r.localId ? String(r.localId) : null
  const entry = {
    date,
    minutes: Math.max(1, Math.round(minutes)),
    localId,
    // 本机书籍绝不允许带 bookId（会把分钟写进云端 books）
    bookId: (!localId && r.bookId) ? String(r.bookId) : null,
    at: Number.isFinite(Number(r.at)) ? Number(r.at) : 0
  }
  const requestId = r.requestId ? String(r.requestId) : ''
  entry.requestId = requestId || deriveRequestId(entry)
  return entry
}

function normalizeQueue(raw) {
  let data = raw
  if (typeof data === 'string') {
    if (!data.trim()) return []
    try {
      data = JSON.parse(data)
    } catch (e) {
      return []
    }
  }
  if (!Array.isArray(data)) return []
  const out = []
  const seen = new Set()
  for (const item of data) {
    const e = normalizeEntry(item)
    if (!e) continue
    // 同一 requestId 只保留一条，避免重复条目导致重复重放
    if (seen.has(e.requestId)) continue
    seen.add(e.requestId)
    out.push(e)
  }
  return out.length > MAX_ENTRIES ? out.slice(out.length - MAX_ENTRIES) : out
}

function createDailyPendingStore(storage) {
  const st = storage

  function read() {
    try {
      return normalizeQueue(st.read(PENDING_KEY))
    } catch (err) {
      return []
    }
  }

  function write(list) {
    const trimmed = list.length > MAX_ENTRIES ? list.slice(list.length - MAX_ENTRIES) : list
    try {
      st.write(PENDING_KEY, JSON.stringify(trimmed))
      return { ok: true, list: trimmed }
    } catch (err) {
      return { ok: false, list }
    }
  }

  function push(entry) {
    const e = normalizeEntry(entry)
    if (!e) return { ok: false, reason: 'BAD_ENTRY', count: read().length }
    const list = read()
    const idx = list.findIndex(x => x.requestId === e.requestId)
    if (idx >= 0) list[idx] = e
    else list.push(e)
    const res = write(list)
    return { ok: res.ok, reason: res.ok ? null : 'PENDING_WRITE_FAILED', count: res.list.length, entry: e }
  }

  // 云端确认成功后才移除；返回实际移除条数
  function remove(requestIds) {
    const ids = Array.isArray(requestIds) ? requestIds.map(String) : [String(requestIds || '')]
    const drop = new Set(ids.filter(Boolean))
    if (!drop.size) return { ok: true, removed: 0, remaining: read().length }
    const list = read()
    const kept = list.filter(x => !drop.has(x.requestId))
    if (kept.length === list.length) return { ok: true, removed: 0, remaining: list.length }
    const res = write(kept)
    return { ok: res.ok, removed: list.length - kept.length, remaining: res.list.length }
  }

  function clear() {
    const res = write([])
    return { ok: res.ok, reason: res.ok ? null : 'PENDING_CLEAR_FAILED' }
  }

  function size() {
    return read().length
  }

  return { read, push, remove, clear, size }
}

// ------------------------------------------------------------
// 安全重放驱动
// ------------------------------------------------------------
// callDailyRead(data) -> Promise<{ ok } | { result: { ok } }>
// 逐条串行提交（并发重放在云端会放大写入压力，且串行更易定位失败）。
// 只有云端明确 ok:true 的条目才会从队列移除。
//
// ⚠️ 单飞（single-flight）：同一时刻全应用只允许**一条**重放链在跑。
// 目的（2026-10-16 起）：**少发无用请求 + 让失败定位更简单**，不是幂等性的依据。
// 单飞要解决的问题仍然真实存在：重放链把整份队列读进内存、到链尾才移除成功
// 条目，所以并发的两个触发点会读到同一份队列、把同一个 requestId 各提交一次
//   （书架页 onShow 的重放还在飞 → 用户马上点开本机 TXT → reading-txt 的
//    onLoad 又发起一次重放）。
// 但现在**并发提交同一 requestId 已经不会重复累计** —— 服务端 addRead 的
// 「判重 + 累加」在同一个数据库事务里完成（快照隔离 + 写锁 + 冲突自动重试）。
// 单飞被绕过（两个进程 / 锁被重置）时的回归见
// tests/reading-daily-idempotency.test.js 的 E2E_CONCURRENT_REPLAY_WITHOUT_SINGLEFLIGHT_IS_EXACTLY_ONCE。
// 结论：并发进入的调用一律复用同一条在飞链，绝不另起第二条。
let _flushInFlight = null
let _flushJoined = 0

// 是否有重放链在飞（云端刚被证明可达时的「顺手补报」据此避免叠加）
function isFlushing() {
  return !!_flushInFlight
}

// 仅供测试与排障：清空在飞标记（生产代码不应调用）
function resetFlushLock() {
  _flushInFlight = null
  _flushJoined = 0
}

function flushStats() {
  return { inFlight: !!_flushInFlight, joined: _flushJoined }
}

function flushDailyPending(deps) {
  if (_flushInFlight) {
    _flushJoined += 1
    return _flushInFlight
  }
  const p = runFlush(deps)
  // 清理必须挂在**返回给调用方的同一个 promise** 上：join 的调用方因此拿到与
  // 首个调用方完全一致的结算结果，且无论成功失败锁都会释放。
  _flushInFlight = p.then(
    res => { _flushInFlight = null; return res },
    err => { _flushInFlight = null; throw err }
  )
  return _flushInFlight
}

function runFlush(deps) {
  const d = deps || {}
  const store = d.store
  const callDailyRead = typeof d.callDailyRead === 'function'
    ? d.callDailyRead
    : () => Promise.resolve({ ok: false, code: 'NO_DAILY_SINK' })
  const logError = typeof d.logError === 'function' ? d.logError : () => undefined
  const logWarn = typeof d.logWarn === 'function' ? d.logWarn : () => undefined
  if (!store || typeof store.read !== 'function') {
    return Promise.resolve({ attempted: 0, applied: 0, failed: 0, remaining: 0, unavailable: true })
  }

  let list
  try {
    list = store.read()
  } catch (err) {
    return Promise.resolve({ attempted: 0, applied: 0, failed: 0, remaining: 0, readFailed: true })
  }
  if (!list.length) {
    return Promise.resolve({ attempted: 0, applied: 0, failed: 0, remaining: 0 })
  }

  const applied = []
  const failures = []
  let chain = Promise.resolve()
  for (const entry of list) {
    chain = chain.then(() => {
      const data = { action: 'addRead', date: entry.date, minutes: entry.minutes, requestId: entry.requestId }
      if (entry.bookId) data.bookId = entry.bookId
      return Promise.resolve()
        .then(() => callDailyRead(data))
        .then(res => {
          const r = res && res.result !== undefined ? res.result : res
          if (r && r.ok === true) applied.push(entry.requestId)
          else failures.push({ requestId: entry.requestId, code: (r && r.code) || 'NOT_OK' })
        })
        .catch(err => {
          failures.push({ requestId: entry.requestId, code: 'CALL_FAILED', errMsg: err && (err.errMsg || err.message) })
        })
    })
  }

  return chain.then(() => {
    if (failures.length) {
      logWarn('DAILY_PENDING_REPLAY_INCOMPLETE', { failed: failures.length, total: list.length })
    }
    let removed = 0
    if (applied.length) {
      const res = store.remove(applied)
      if (!res || res.ok !== true) {
        logError('DAILY_PENDING_REMOVE_FAILED', { applied: applied.length })
      } else {
        removed = res.removed
      }
    }
    const remaining = store.size()
    return {
      attempted: list.length,
      applied: applied.length,
      removed,
      failed: failures.length,
      failures,
      remaining
    }
  })
}

function createWxStorage() {
  return {
    read(key) {
      if (typeof wx === 'undefined' || !wx) return ''
      try {
        return wx.getStorageSync(key)
      } catch (err) {
        return ''
      }
    },
    write(key, value) {
      if (typeof wx === 'undefined' || !wx) throw new Error('wx unavailable')
      wx.setStorageSync(key, value)
    }
  }
}

let _default = null
function getDailyPending() {
  if (!_default) _default = createDailyPendingStore(createWxStorage())
  return _default
}

module.exports = {
  PENDING_KEY,
  MAX_ENTRIES,
  isDateString,
  deriveRequestId,
  normalizeEntry,
  normalizeQueue,
  createDailyPendingStore,
  flushDailyPending,
  isFlushing,
  resetFlushLock,
  flushStats,
  createWxStorage,
  getDailyPending
}
