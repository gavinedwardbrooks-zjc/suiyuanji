// ============================================================
// utils/txtReader.js · 本机 TXT 分页阅读（S5）
//
// 第一约束是内存：绝不把整个文件读进内存，更不把整个文件 setData。
// 做法是「按字节区间分页」：每一页只读自己那一段，读完即丢，
// 因此无论文件是 8KB 还是 80MB，任意时刻内存占用都是常数级。
//
// 第二约束是正确性：UTF-8 中文字符占 1~4 字节，按字节切分很容易切在
// 多字节字符中间。官方 readFile 遇到半个字符会产出替换字符 U+FFFD，
// 中文书会因此出现乱码。因此本模块在切页前先用 binary 探测字节做
// 「字符起点对齐」，保证每一页的边界都落在合法字符起点上：
//   - 页 i 的区间 = [alignUp(i*pageBytes), alignUp((i+1)*pageBytes))
//     最后一页的右端固定为文件大小，因此各页区间不重叠且不漏字节
//
// 官方约束（决定了实现方式）：
//   1. FileSystemManager.readFile 支持 position / length（单位：字节），
//      encoding 合法值含 utf8 与 binary；不传 encoding 时返回 ArrayBuffer
//   2. binary 编码下每个字符即 1 字节，charCodeAt 可直接取到字节值
//      → 用来做字符起点探测，探测窗口固定 4 字节（UTF-8 续字节最多 3 个）
//
// 本模块是纯逻辑 + 注入式读取，不直接依赖 wx，因此可在 Node 下真实单测。
// ============================================================

const DEFAULT_PAGE_BYTES = 8 * 1024 // 每页 8KB ≈ 2700 汉字
const PROBE_BYTES = 4 // UTF-8 续字节最多 3 个，4 字节窗口足够找到下一个字符起点
// 分段读取（position/length）在极少数真机/基础库版本上可能不被支持。
// 这时可退化为「整文件读取 + 内存分页」，但**仅限这个大小以内**，
// 因此内存占用依然有界，不存在几十 MB 文本一次性进内存的路径。
const DEFAULT_FALLBACK_BYTES = 2 * 1024 * 1024
const BOM_CHAR = '\uFEFF'
const REPLACEMENT_CHAR = '\uFFFD'

// ---------------- 纯函数 ----------------

// UTF-8 续字节形如 10xxxxxx；非续字节即为字符起点（含 ASCII）
function isContinuationByte(code) {
  return (code & 0xc0) === 0x80
}

// 在 binary 字符串中，从 from 起找第一个字符起点；找不到返回 -1
function findCharStart(bin, from) {
  const s = typeof bin === 'string' ? bin : ''
  const start = Math.max(0, Number(from) || 0)
  for (let i = start; i < s.length; i++) {
    if (!isContinuationByte(s.charCodeAt(i))) return i
  }
  return -1
}

// 首页去除 UTF-8 BOM（U+FEFF）。只去一次、只去头部，不动正文。
function stripBom(text) {
  const s = typeof text === 'string' ? text : ''
  return s.charAt(0) === BOM_CHAR ? s.slice(1) : s
}

// 边界对齐后仍出现替换字符 → 文件不是合法 UTF-8（例如 GBK 文件）。
// 只上报，不修复、不改写文件。
function hasEncodingIssue(text) {
  return String(typeof text === 'string' ? text : '').indexOf(REPLACEMENT_CHAR) !== -1
}

function pageCountOf(size, pageBytes) {
  const n = Number(size)
  const p = Number(pageBytes)
  if (!Number.isFinite(n) || n <= 0) return 0
  if (!Number.isFinite(p) || p <= 0) return 0
  return Math.ceil(n / p)
}

function clampPageIndex(index, count) {
  const i = Math.floor(Number(index))
  const c = Math.floor(Number(count))
  if (!Number.isFinite(i) || !Number.isFinite(c) || c <= 0) return -1
  if (i < 0) return 0
  if (i > c - 1) return c - 1
  return i
}

// 有效页数 = ceil(size/pageBytes)，但若末页只承载 ≤3 字节（装不下一个完整的
// 多字节字符），就把它并入上一页。原因：页边界要吸附到字符起点，末页起点可能
// 被吸附到文件末尾，从而变成「空页」——那会让读者翻到最后一页时看到一片空白，
// 甚至被判成读取失败。合并后末页原始长度 ≥ pageBytes，对齐也只会让它更短，
// 因此「空页」在 pageBytes ≥ 4 时不可能出现。
function effectivePageCount(size, pageBytes) {
  const n = Number(size)
  const p = Number(pageBytes)
  if (!Number.isFinite(n) || n <= 0) return 0
  if (!Number.isFinite(p) || p <= 0) return 0
  let count = Math.ceil(n / p)
  while (count > 1 && n - (count - 1) * p <= 3) count -= 1
  return count
}

// 分页算式：给定页序号与总大小，算出「未对齐」的原始字节区间
function rawRange(index, size, pageBytes) {
  const count = effectivePageCount(size, pageBytes)
  const i = clampPageIndex(index, count)
  if (i < 0) return null
  const start = i * pageBytes
  const end = i === count - 1 ? Number(size) : Math.min(Number(size), (i + 1) * pageBytes)
  return { index: i, start, end, isLast: i === count - 1 }
}

// ---------------- 读取器 ----------------

// deps:
//   size              文件总字节数（来自 stat，权威）
//   readRange(o)      o = { offset, length, encoding } -> { ok, data } | { ok:false, reason }
//   readAll()         可选。返回整文件文本（有界兜底入口），仅当分段读取不可用时使用
//   pageBytes         可选，默认 8KB
//   maxFallbackBytes  可选，兜底整读的大小上限，默认 2MB
//   onWarn(tag, info) 可选，边界探测失败等非致命情况如实上报
function createTxtReader(deps) {
  const d = deps || {}
  const size = Number(d.size) > 0 ? Number(d.size) : 0
  const pageBytes = Number(d.pageBytes) > 0 ? Number(d.pageBytes) : DEFAULT_PAGE_BYTES
  const readRange = typeof d.readRange === 'function' ? d.readRange : () => Promise.resolve({ ok: false, reason: 'NO_READER' })
  const readAll = typeof d.readAll === 'function' ? d.readAll : null
  const onWarn = typeof d.onWarn === 'function' ? d.onWarn : () => undefined
  const maxFallbackBytes = Number(d.maxFallbackBytes) > 0 ? Number(d.maxFallbackBytes) : DEFAULT_FALLBACK_BYTES
  const count = effectivePageCount(size, pageBytes)

  // 兜底模式状态：null = 未启用（正常分段读取）；string = 已整读入内存
  let wholeText = null
  let fallbackTried = false
  let fallbackOutcome = null // null | 'engaged' | 'unavailable' | 'too_large' | 'failed'

  function charPageCount(text) {
    const len = String(text || '').length
    if (len <= 0) return 0
    return Math.ceil(len / pageBytes)
  }

  // 只在「分段读取确实不可用」且有界（≤ maxFallbackBytes）时才整读
  function ensureWholeText(reason) {
    if (wholeText !== null) return Promise.resolve(wholeText)
    if (fallbackTried) return Promise.resolve(null)
    fallbackTried = true
    if (!readAll) {
      fallbackOutcome = 'unavailable'
      onWarn('READ_FALLBACK_UNAVAILABLE', { reason })
      return Promise.resolve(null)
    }
    if (size > maxFallbackBytes) {
      fallbackOutcome = 'too_large'
      onWarn('READ_FALLBACK_TOO_LARGE', { reason, size, maxFallbackBytes })
      return Promise.resolve(null)
    }
    return Promise.resolve()
      .then(() => readAll())
      .then(res => {
        if (!res || res.ok !== true || typeof res.data !== 'string') {
          fallbackOutcome = (res && res.reason === 'READ_TOO_LARGE') ? 'too_large' : 'failed'
          onWarn('READ_FALLBACK_FAILED', { reason: (res && res.reason) || 'NO_DATA' })
          return null
        }
        wholeText = res.data
        fallbackOutcome = 'engaged'
        onWarn('READ_FALLBACK_ENGAGED', { reason, size })
        return wholeText
      })
      .catch(err => {
        fallbackOutcome = 'failed'
        onWarn('READ_FALLBACK_THREW', { reason: err && (err.errMsg || err.message) })
        return null
      })
  }

  function readWholePage(index) {
    const c = charPageCount(wholeText)
    const i = clampPageIndex(index, c)
    if (i < 0) return { ok: false, reason: 'PAGE_OUT_OF_RANGE', index }
    const start = i * pageBytes
    const end = i === c - 1 ? wholeText.length : Math.min(wholeText.length, (i + 1) * pageBytes)
    const raw = wholeText.slice(start, end)
    const text = i === 0 ? stripBom(raw) : raw
    return {
      ok: true,
      index: i,
      start,
      end,
      bytes: end - start,
      text,
      encodingIssue: hasEncodingIssue(text),
      fallback: true
    }
  }

  // 对齐：把任意字节偏移吸附到「不早于它」的字符起点
  function alignUp(offset) {
    const off = Number(offset)
    if (!Number.isFinite(off) || off <= 0) return Promise.resolve(0)
    if (off >= size) return Promise.resolve(size)
    const window = Math.min(PROBE_BYTES, size - off)
    return readRange({ offset: off, length: window, encoding: 'binary' }).then(res => {
      if (!res || res.ok !== true || typeof res.data !== 'string') {
        // 探测失败不阻断阅读：退回原始偏移（可能产生替换字符，但由 hasEncodingIssue 如实上报）
        onWarn('ALIGN_PROBE_FAILED', { offset: off, reason: (res && res.reason) || 'NO_DATA' })
        return off
      }
      const i = findCharStart(res.data, 0)
      if (i < 0) return off
      return off + i
    })
  }

  function byteRange(index) {
    const raw = rawRange(index, size, pageBytes)
    if (!raw) return Promise.resolve(null)
    return alignUp(raw.start).then(start => {
      if (raw.isLast) return { index: raw.index, start, end: size, isLast: true }
      return alignUp(raw.end).then(end => ({ index: raw.index, start, end, isLast: false }))
    })
  }

  function readBytePage(index) {
    return byteRange(index).then(range => {
      if (!range) return { ok: false, reason: 'PAGE_OUT_OF_RANGE', index }
      let { start, end } = range
      if (end <= start) {
        // 对齐后出现空区间（只可能出现在异常字节流上）：退化为定长区间，绝不返回空白页
        end = Math.min(size, start + pageBytes)
      }
      if (end <= start) return { ok: false, reason: 'PAGE_OUT_OF_RANGE', index }
      const length = end - start
      return readRange({ offset: start, length, encoding: 'utf8' }).then(res => {
        if (!res || res.ok !== true) {
          return {
            ok: false,
            reason: (res && res.reason) || 'READ_FAILED',
            errCode: res && res.errCode,
            index: range.index,
            start,
            end
          }
        }
        const raw = typeof res.data === 'string' ? res.data : ''
        const text = range.index === 0 ? stripBom(raw) : raw
        return {
          ok: true,
          index: range.index,
          start,
          end,
          bytes: length,
          text,
          encodingIssue: hasEncodingIssue(text)
        }
      })
    })
  }

  function readPage(index) {
    if (wholeText !== null) return Promise.resolve(readWholePage(index))
    return readBytePage(index).then(res => {
      if (res && res.ok === true) return res
      // 只有「读取方式不可用」才兜底；文件不存在/索引损坏绝不触发整读
      const reason = res && res.reason
      if (reason === 'FILE_MISSING' || reason === 'INDEX_CORRUPT' || reason === 'NOT_FOUND' || reason === 'NO_FILE_ENTRY') {
        return res
      }
      return ensureWholeText(reason).then(text => (text === null ? res : readWholePage(index)))
    })
  }

  return {
    size,
    pageBytes,
    maxFallbackBytes,
    get pageCount() { return wholeText !== null ? charPageCount(wholeText) : count },
    get bytePageCount() { return count },
    get usingFallback() { return wholeText !== null },
    get fallbackAttempted() { return fallbackTried },
    get fallbackOutcome() { return fallbackOutcome },
    isEmpty: size <= 0,
    alignUp,
    byteRange,
    readPage,
    ensureWholeText
  }
}

module.exports = {
  DEFAULT_PAGE_BYTES,
  PROBE_BYTES,
  DEFAULT_FALLBACK_BYTES,
  BOM_CHAR,
  REPLACEMENT_CHAR,
  isContinuationByte,
  findCharStart,
  stripBom,
  hasEncodingIssue,
  pageCountOf,
  effectivePageCount,
  clampPageIndex,
  rawRange,
  createTxtReader
}
