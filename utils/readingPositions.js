// ============================================================
// utils/readingPositions.js · 阅读位置存储（最终版）
//
// 只服务本机 TXT 阅读页：记住「上次读到第几页」，下次打开直接续读。
//
// 为什么单独存一份，而不是写进 localBooks 索引：
//   1. 位置是高频写入（每翻一页一次），写 localBooks 索引会连带整表重写
//   2. 索引是「书籍元数据」的权威来源，位置属于「阅读器状态」，
//      两者职责不同；混在一起会让索引损坏的影响面扩大到阅读器
//   3. 位置数据损坏不应影响书籍元数据，反之亦然
//
// 设计边界：
//   - 只存 localId / page / pageCount / at，无身份字段、不触网
//   - 条目数量有上限，按最近使用保留
//   - 读写失败一律静默降级（位置是体验优化，绝不阻断阅读）
// ============================================================

const POSITIONS_KEY = 'readingPositions_v1'
const MAX_ENTRIES = 50

function normalizePosition(raw) {
  const r = raw && typeof raw === 'object' ? raw : null
  if (!r) return null
  const page = Number(r.page)
  if (!Number.isFinite(page) || page < 0) return null
  const pageCount = Number(r.pageCount)
  return {
    page: Math.floor(page),
    pageCount: Number.isFinite(pageCount) && pageCount > 0 ? Math.floor(pageCount) : 0,
    at: Number.isFinite(Number(r.at)) ? Number(r.at) : 0
  }
}

function normalizePositionsMap(raw) {
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
    const pos = normalizePosition(data[key])
    if (!pos) continue
    rows.push({ key, pos })
  }
  rows.sort((a, b) => b.pos.at - a.pos.at)
  const kept = rows.length > MAX_ENTRIES ? rows.slice(0, MAX_ENTRIES) : rows
  const out = {}
  for (const r of kept) out[r.key] = r.pos
  return out
}

function createPositionStore(storage) {
  const st = storage

  function readMap() {
    try {
      return normalizePositionsMap(st.read(POSITIONS_KEY))
    } catch (err) {
      return {}
    }
  }

  function writeMap(map) {
    try {
      st.write(POSITIONS_KEY, JSON.stringify(map))
      return true
    } catch (err) {
      return false
    }
  }

  function get(localId) {
    const k = localId == null ? '' : String(localId)
    if (!k) return null
    const pos = readMap()[k]
    return pos ? Object.assign({}, pos) : null
  }

  function set(localId, pos, at) {
    const k = localId == null ? '' : String(localId)
    if (!k) return { ok: false, reason: 'BAD_ID' }
    const normalized = normalizePosition(Object.assign({}, pos, {
      at: Number.isFinite(Number(at)) ? Number(at) : Date.now()
    }))
    if (!normalized) return { ok: false, reason: 'BAD_POSITION' }
    const map = readMap()
    map[k] = normalized
    return { ok: writeMap(map), position: normalized }
  }

  function clear(localId) {
    const k = localId == null ? '' : String(localId)
    if (!k) return { cleared: true }
    const map = readMap()
    if (!Object.prototype.hasOwnProperty.call(map, k)) return { cleared: true }
    delete map[k]
    return { cleared: writeMap(map) }
  }

  function snapshot() {
    return readMap()
  }

  return { get, set, clear, snapshot }
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
function getPositionStore() {
  if (!_default) _default = createPositionStore(createWxStorage())
  return _default
}

module.exports = {
  POSITIONS_KEY,
  MAX_ENTRIES,
  normalizePosition,
  normalizePositionsMap,
  createPositionStore,
  createWxStorage,
  getPositionStore
}
