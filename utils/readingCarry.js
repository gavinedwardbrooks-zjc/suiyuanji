// ============================================================
// utils/readingCarry.js · 阅读计时「余量」存储（最终版）
//
// 解决的问题：一次会话往往不足一分钟（打开 PDF 看两眼就走、
// 切后台接个电话回来接着读）。旧实现把不足一分钟强行记成 1 分钟，
// 既虚构了时长，又让「本地单书分钟」与「每日阅读分钟」出现偏差。
//
// 现在的策略是**余量结转**：
//   - 每次结算只记「整分钟」，不足一分钟的部分（余量）原样存下来
//   - 下次读同一本书时，余量先并入，攒够一分钟才真正记 1 分钟
//   - 因此既不丢弃真实阅读时长，也绝不虚构时长
//
// 设计边界：
//   1. 余量恒 < 60000ms，键值天然有界
//   2. 键有数量上限，超出时按「最近使用」保留，不无限增长
//   3. 纯本地、无身份字段、不触网
//   4. storage 读写失败一律静默降级为 0（余量是优化，绝不阻断阅读/结算）
// ============================================================

const CARRY_KEY = 'readingCarry_v1'
const MAX_ENTRIES = 50
const MAX_CARRY_MS = 59999

function normalizeCarryMs(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(MAX_CARRY_MS, Math.floor(n))
}

function normalizeKey(key) {
  const k = key == null ? '' : String(key)
  return k
}

// 归一化整张余量表：只接受合法键 + 正数毫秒；按 at 保留最近 MAX_ENTRIES 条
function normalizeCarryMap(raw) {
  let data = raw
  if (typeof data === 'string') {
    if (!data.trim()) return {}
    try {
      data = JSON.parse(data)
    } catch (e) {
      return {}
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
  const rows = []
  for (const key of Object.keys(data)) {
    if (!key) continue
    const rec = data[key]
    const ms = normalizeCarryMs(rec && typeof rec === 'object' ? rec.ms : rec)
    if (!ms) continue
    const at = rec && typeof rec === 'object' && Number.isFinite(Number(rec.at)) ? Number(rec.at) : 0
    rows.push({ key, ms, at })
  }
  rows.sort((a, b) => b.at - a.at)
  const kept = rows.length > MAX_ENTRIES ? rows.slice(0, MAX_ENTRIES) : rows
  const out = {}
  for (const r of kept) out[r.key] = { ms: r.ms, at: r.at }
  return out
}

// 计时目标的余量键：本机书与云端书分别命名空间，绝不互相污染
function carryKeyFor(localId, bookId) {
  if (localId) return 'L:' + String(localId)
  if (bookId) return 'C:' + String(bookId)
  return ''
}

function createCarryStore(storage) {
  const st = storage

  function readMap() {
    try {
      return normalizeCarryMap(st.read(CARRY_KEY))
    } catch (err) {
      return {}
    }
  }

  function writeMap(map) {
    try {
      st.write(CARRY_KEY, JSON.stringify(map))
      return true
    } catch (err) {
      return false
    }
  }

  function get(key) {
    const k = normalizeKey(key)
    if (!k) return 0
    const rec = readMap()[k]
    return rec ? normalizeCarryMs(rec.ms) : 0
  }

  // 累加余量；返回写入后的余量（写失败也返回内存值，调用方据 persisted 判断）
  function add(key, ms, at) {
    const k = normalizeKey(key)
    const delta = Number(ms)
    if (!k || !Number.isFinite(delta) || delta <= 0) return { ms: get(k), persisted: true }
    const map = readMap()
    const next = normalizeCarryMs((map[k] ? map[k].ms : 0) + delta)
    map[k] = { ms: next, at: Number.isFinite(Number(at)) ? Number(at) : Date.now() }
    return { ms: next, persisted: writeMap(map) }
  }

  // 覆盖余量（结算后写入「不足一分钟」的余数，0 则删除该键）
  function set(key, ms, at) {
    const k = normalizeKey(key)
    if (!k) return { ms: 0, persisted: true }
    const next = normalizeCarryMs(ms)
    const map = readMap()
    if (!next) {
      if (!Object.prototype.hasOwnProperty.call(map, k)) return { ms: 0, persisted: true }
      delete map[k]
    } else {
      map[k] = { ms: next, at: Number.isFinite(Number(at)) ? Number(at) : Date.now() }
    }
    return { ms: next, persisted: writeMap(map) }
  }

  function clear(key) {
    const k = normalizeKey(key)
    if (!k) return { cleared: true }
    const map = readMap()
    if (!Object.prototype.hasOwnProperty.call(map, k)) return { cleared: true }
    delete map[k]
    return { cleared: writeMap(map) }
  }

  // 只读快照，便于测试与诊断
  function snapshot() {
    const map = readMap()
    const out = {}
    for (const key of Object.keys(map)) out[key] = map[key].ms
    return out
  }

  return { get, add, set, clear, snapshot }
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
function getCarryStore() {
  if (!_default) _default = createCarryStore(createWxStorage())
  return _default
}

module.exports = {
  CARRY_KEY,
  MAX_ENTRIES,
  MAX_CARRY_MS,
  normalizeCarryMs,
  normalizeCarryMap,
  carryKeyFor,
  createCarryStore,
  createWxStorage,
  getCarryStore
}
