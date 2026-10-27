// ============================================================
// utils/localBooks.js · 本地书籍仓库（S1 · 契约冻结版）
//
// 定位：阅读清单从「云端文件模型」迁移为「本机文件模型」。
//   - 新导入 PDF / TXT 只落在 wx.env.USER_DATA_PATH，绝不上传 CloudBase
//   - 手动书单（无文件）同样存本地
//   - 每日阅读分钟仍走 dailyRecord/addRead（云端），与本模块解耦
//
// 官方文档核验结论（决定了本文件的写法）：
//   1. FileSystemManager.saveFile / unlink / stat / access / mkdir / readdir
//      「以 Promise 风格调用：不支持」→ 全部走回调，本模块统一 Promise 化
//   2. saveFile 会「移动」临时文件，成功后原 tempFilePath 失效
//   3. saveFile 错误码 1300202：存储空间不足，或文件大小超出上限（上限 100M）
//   4. unlink 目标不存在 → 1300002 no such file or directory → 删除必须幂等
//   5. 用户文件目录 + 缓存文件目录合计上限 200MB
//   6. readFile 单文件上限 100M；encoding 合法值无 GBK（第一版只承诺 utf-8）
//   7. 本地路径协议真机与开发者工具不同（真机 wxfile 协议、工具 http 协议）
//      → 不硬编码协议，一律用 wx.env.USER_DATA_PATH 运行时拼接
// ============================================================

const STORAGE_KEY = 'localBooks_v1'
const PENDING_KEY = 'localBooks_pending_v1'
// 索引损坏保护：损坏原文写一次备份，永不覆盖；用户确认前不写主索引键
const CORRUPT_BACKUP_KEY = 'localBooks_v1_corrupt_backup'
const INDEX_VERSION = 1
const SUB_DIR = 'books'

const SUPPORTED_EXT = ['pdf', 'txt']
const STATUS_SET = ['want', 'reading', 'finished']
const COVER_COLORS = ['#FFC9D4', '#FFE9A8', '#BFE3F2', '#C7E7C2']

const MAX_FILE_BYTES = 100 * 1024 * 1024 // 官方单文件上限 100M
const MAX_TOTAL_BYTES = 200 * 1024 * 1024 // 用户文件目录上限 200MB
const SAFE_TOTAL_BYTES = 180 * 1024 * 1024 // 预警水位
// S5：单次读取的硬上限。TXT 阅读按页读取（每页 8KB 级），
// 这个上限是「绝不允许整文件读入内存」在数据层的结构性保证：
// 任何调用方忘传 length 或算错长度都会被拒绝，而不是悄悄读空内存。
const MAX_READ_BYTES = 1 * 1024 * 1024
// 整文件读取（分段读取在真机不被支持时的安全替代）的硬上限。
// 只有「分段读取不可用 + 文件不超过这个大小」时才允许整读，
// 因此它仍然是有界的：绝不存在「几十 MB 文本一次性进内存」的路径。
const MAX_WHOLE_READ_BYTES = 2 * 1024 * 1024

// importFile 可接受的迁移元数据白名单（云端书籍保存到本机时携带）
const IMPORT_META_FIELDS = ['author', 'status', 'progressPercent', 'minutes', 'note', 'coverColor', 'migratedFrom']

// 可写字段白名单：本地仓库不接受任何身份字段
const WRITABLE_FIELDS = ['name', 'author', 'status', 'progressPercent', 'minutes', 'note', 'coverColor']
const FORBIDDEN_FIELDS = ['_openid', 'openid', 'user_uid', 'uid', 'coupleId', 'role', 'ownerOpenid']

// 错误 stage（沿用项目既有 err.stage 约定）
const STAGE = {
  VALIDATE: 'VALIDATE',
  DIR: 'LOCAL_DIR_FAILED',
  SAVE_FILE: 'LOCAL_SAVE_FILE_FAILED',
  VERIFY: 'LOCAL_VERIFY_FAILED',
  META: 'LOCAL_META_FAILED',
  DELETE_FILE: 'LOCAL_DELETE_FILE_FAILED',
  DELETE_META: 'LOCAL_DELETE_META_FAILED',
  READ: 'LOCAL_INDEX_READ_FAILED',
  CORRUPT: 'LOCAL_INDEX_CORRUPT',
  LOCKED: 'LOCAL_INDEX_LOCKED'
}

function fail(stage, code, extra) {
  return Object.assign(new Error(code), Object.assign({ stage, code }, extra || {}))
}

// ---------------- 纯函数（无副作用，便于单测） ----------------

function normalizeExt(input) {
  const raw = String(input == null ? '' : input).trim().toLowerCase()
  if (!raw) return ''
  const parts = raw.split('.')
  const last = parts[parts.length - 1].trim()
  return last.replace(/[^a-z0-9]/g, '')
}

function stripExt(name) {
  return String(name == null ? '' : name).replace(/\.[^.\/\\]+$/, '')
}

function sanitizeName(name) {
  const base = stripExt(String(name == null ? '' : name)).trim()
  const cleaned = base.replace(/[\/\\:*?"<>|]/g, '').trim()
  return cleaned || '未命名'
}

function makeLocalId(now, random) {
  const t = Number(now)
  const r = Math.floor(Math.abs(Number(random)) * 1e9).toString(36)
  return 'lb_' + t.toString(36) + '_' + r
}

function makeFileName(localId, ext) {
  const e = normalizeExt(ext)
  return e ? localId + '.' + e : localId
}

function pickCoverColor(random) {
  const r = Math.abs(Number(random))
  const idx = Math.floor((Number.isFinite(r) ? r : 0) * COVER_COLORS.length) % COVER_COLORS.length
  return COVER_COLORS[idx]
}

function clampPercent(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(100, Math.round(v)))
}

function isFileEntry(entry) {
  return !!(entry && entry.fileName)
}

function dedupeKey(entry) {
  const e = entry || {}
  return [String(e.name || '').toLowerCase(), normalizeExt(e.ext), Number(e.size) || 0].join('::')
}

function sortBooks(books) {
  return (Array.isArray(books) ? books.slice() : []).sort((a, b) => {
    const ca = Number(a && a.createdAt) || 0
    const cb = Number(b && b.createdAt) || 0
    if (cb !== ca) return cb - ca
    const la = String((a && a.localId) || '')
    const lb = String((b && b.localId) || '')
    return la < lb ? -1 : (la > lb ? 1 : 0)
  })
}

function computeUsage(books) {
  const list = Array.isArray(books) ? books : []
  let bytes = 0
  let fileCount = 0
  for (const b of list) {
    if (!isFileEntry(b)) continue
    fileCount += 1
    const s = Number(b.size)
    if (Number.isFinite(s) && s > 0) bytes += s
  }
  const percent = Math.min(100, Math.round((bytes / MAX_TOTAL_BYTES) * 1000) / 10)
  return {
    bytes,
    fileCount,
    entryCount: list.length,
    limitBytes: MAX_TOTAL_BYTES,
    percent,
    warning: bytes >= SAFE_TOTAL_BYTES
  }
}

function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

function normalizeEntry(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const fileName = r.fileName ? String(r.fileName) : null
  const ext = r.ext ? normalizeExt(r.ext) : (fileName ? normalizeExt(fileName) : '')
  const status = STATUS_SET.includes(r.status) ? r.status : (fileName ? 'reading' : 'want')
  return {
    localId: String(r.localId || ''),
    name: sanitizeName(r.name),
    ext,
    // 本机索引里的条目默认就是本地来源；但若原始数据显式带了非 local 的来源，
    // 必须如实保留 —— 否则「只允许删除 source='local'」这条 fail-closed 守卫
    // 会被归一化悄悄抹平而失去作用（S4 删除入口据此拒绝）。
    source: r.source ? String(r.source) : 'local',
    fileName,
    filePath: r.filePath ? String(r.filePath) : null,
    size: Number.isFinite(Number(r.size)) ? Math.max(0, Number(r.size)) : 0,
    author: r.author ? String(r.author) : '',
    status,
    progressPercent: clampPercent(r.progressPercent),
    minutes: Number.isFinite(Number(r.minutes)) && Number(r.minutes) > 0 ? Math.round(Number(r.minutes)) : 0,
    note: r.note ? String(r.note) : '',
    coverColor: r.coverColor ? String(r.coverColor) : COVER_COLORS[0],
    migratedFrom: r.migratedFrom ? String(r.migratedFrom) : null,
    missing: r.missing === true,
    createdAt: Number.isFinite(Number(r.createdAt)) ? Number(r.createdAt) : 0,
    updatedAt: Number.isFinite(Number(r.updatedAt)) ? Number(r.updatedAt) : 0
  }
}

function emptyIndex() {
  return { version: INDEX_VERSION, updatedAt: 0, pendingApplied: {}, books: [] }
}

// 待补写增量表的净化：只接受「正数分钟」的 localId 映射
function sanitizePendingMap(raw) {
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
  const out = {}
  for (const key of Object.keys(data)) {
    const v = Number(data[key])
    if (key && Number.isFinite(v) && v > 0) out[key] = Math.round(v)
  }
  return out
}

// 幂等判据：两份待补写快照是否逐键相等
function pendingMapsEqual(a, b) {
  const x = a && typeof a === 'object' ? a : {}
  const y = b && typeof b === 'object' ? b : {}
  const kx = Object.keys(x)
  const ky = Object.keys(y)
  if (kx.length !== ky.length) return false
  for (const k of kx) {
    if (!Object.prototype.hasOwnProperty.call(y, k)) return false
    if (Number(x[k]) !== Number(y[k])) return false
  }
  return true
}

// 索引体检：区分「首次使用(empty)」「正常(ok)」「损坏(corrupt)」
// normalizeIndex 保持宽容（损坏时给空 books），本函数才是权威判定，
// 由 writeIndex 据此 fail-closed，避免把损坏索引当首次使用直接覆盖。
function inspectIndex(raw) {
  if (raw === '' || raw === undefined || raw === null) {
    return { status: 'empty', reason: null }
  }
  let data = raw
  if (typeof data === 'string') {
    if (!data.trim()) return { status: 'empty', reason: null }
    try {
      data = JSON.parse(data)
    } catch (e) {
      return { status: 'corrupt', reason: 'JSON_PARSE_FAILED' }
    }
  }
  if (Array.isArray(data)) return { status: 'ok', reason: null }
  if (!data || typeof data !== 'object') {
    return { status: 'corrupt', reason: 'INDEX_NOT_OBJECT' }
  }
  if (data.books !== undefined && data.books !== null && !Array.isArray(data.books)) {
    return { status: 'corrupt', reason: 'BOOKS_NOT_ARRAY' }
  }
  return { status: 'ok', reason: null }
}

function normalizeIndex(raw) {
  let data = raw
  if (typeof data === 'string') {
    if (!data.trim()) return emptyIndex()
    try {
      data = JSON.parse(data)
    } catch (e) {
      return emptyIndex()
    }
  }
  if (!data || typeof data !== 'object') return emptyIndex()
  const list = Array.isArray(data.books) ? data.books : (Array.isArray(data) ? data : [])
  const books = list
    .map(normalizeEntry)
    .filter(b => !!b.localId)
  return {
    version: INDEX_VERSION,
    updatedAt: Number.isFinite(Number(data.updatedAt)) ? Number(data.updatedAt) : 0,
    pendingApplied: Array.isArray(data) ? {} : sanitizePendingMap(data.pendingApplied),
    books: sortBooks(books)
  }
}

function hasForbiddenField(obj) {
  if (!obj || typeof obj !== 'object') return false
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_FIELDS.includes(key)) return true
  }
  return false
}

function findDuplicate(books, candidate) {
  const key = dedupeKey(candidate)
  const list = Array.isArray(books) ? books : []
  for (const b of list) {
    if (dedupeKey(b) === key) return b
  }
  return null
}

function validateImport(input, books) {
  const name = sanitizeName(input && (input.name || input.fileName))
  const ext = normalizeExt(input && (input.ext || input.name || input.fileName))
  const rawSize = Number(input && input.size)
  // size 允许未知（例如云端迁移：downloadFile 不返回大小，真实大小由 stat 决定）。
  // 未知时这里只做类型与配额的可判部分，大小校验交给 stat 之后的 validateSize。
  const sizeKnown = Number.isFinite(rawSize) && rawSize > 0
  if (!SUPPORTED_EXT.includes(ext)) {
    return { ok: false, code: 'UNSUPPORTED_TYPE', stage: STAGE.VALIDATE, ext, supported: SUPPORTED_EXT.slice() }
  }
  if (sizeKnown) {
    if (rawSize > MAX_FILE_BYTES) {
      return { ok: false, code: 'FILE_TOO_LARGE', stage: STAGE.VALIDATE, size: rawSize, maxBytes: MAX_FILE_BYTES }
    }
    const usage = computeUsage(books)
    if (usage.bytes + rawSize > MAX_TOTAL_BYTES) {
      return { ok: false, code: 'STORAGE_FULL', stage: STAGE.VALIDATE, size: rawSize, usedBytes: usage.bytes, limitBytes: MAX_TOTAL_BYTES }
    }
  } else if (!(input && (input.tempFilePath || input.path))) {
    return { ok: false, code: 'EMPTY_FILE', stage: STAGE.VALIDATE, size: rawSize }
  }
  return { ok: true, name, ext, size: sizeKnown ? rawSize : 0, sizeKnown }
}

// stat 之后的权威大小校验：无论 declared 是否可信，落盘前必须过这一关
function validateSize(size, books) {
  const n = Number(size)
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, code: 'EMPTY_FILE', stage: STAGE.VALIDATE, size: n }
  }
  if (n > MAX_FILE_BYTES) {
    return { ok: false, code: 'FILE_TOO_LARGE', stage: STAGE.VALIDATE, size: n, maxBytes: MAX_FILE_BYTES }
  }
  const usage = computeUsage(books)
  if (usage.bytes + n > MAX_TOTAL_BYTES) {
    return { ok: false, code: 'STORAGE_FULL', stage: STAGE.VALIDATE, size: n, usedBytes: usage.bytes, limitBytes: MAX_TOTAL_BYTES }
  }
  return { ok: true, size: n }
}

// 迁移元数据净化：只接受白名单字段，绝不接受身份字段
function sanitizeImportMeta(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  if (hasForbiddenField(r)) return {}
  const out = {}
  for (const key of IMPORT_META_FIELDS) {
    if (r[key] !== undefined && r[key] !== null && r[key] !== '') out[key] = r[key]
  }
  return out
}

function collectOrphans(dirFiles, books) {
  const referenced = new Set()
  for (const b of (Array.isArray(books) ? books : [])) {
    if (isFileEntry(b)) referenced.add(String(b.fileName))
  }
  return (Array.isArray(dirFiles) ? dirFiles : []).filter(f => !referenced.has(String(f)))
}

function applyMissing(books, missingFileNames) {
  const missing = missingFileNames instanceof Set ? missingFileNames : new Set(missingFileNames || [])
  return (Array.isArray(books) ? books : []).map(b => {
    if (!isFileEntry(b)) return Object.assign({}, b, { missing: false })
    return Object.assign({}, b, { missing: missing.has(String(b.fileName)) })
  })
}

// ---------------- 运行环境适配 ----------------

function getWx() {
  if (typeof wx === 'undefined' || !wx) throw fail(STAGE.DIR, 'WX_UNAVAILABLE')
  return wx
}

function callFs(method, options) {
  return new Promise((resolve, reject) => {
    const fsm = getWx().getFileSystemManager()
    fsm[method](Object.assign({}, options, {
      success: res => resolve(res || {}),
      fail: e => reject(Object.assign(
        new Error((e && e.errMsg) || (method + ' failed')),
        { errCode: e && e.errCode, errMsg: e && e.errMsg }
      ))
    }))
  })
}

function isNotExistError(e) {
  const code = e && e.errCode
  const msg = String((e && (e.errMsg || e.message)) || '')
  if (code === 1300002 || code === 1300005) return true
  return /no such file or directory|not exist|ENOENT/i.test(msg)
}

function createWxEnv() {
  return {
    fs: {
      getUserDataPath() { return getWx().env.USER_DATA_PATH },
      ensureDir(dirPath) {
        return callFs('access', { path: dirPath }).then(
          () => undefined,
          () => callFs('mkdir', { dirPath, recursive: true }).then(() => undefined, e => {
            // 1301005：目录已存在（并发创建）→ 视为成功
            if (e && e.errCode === 1301005) return undefined
            return callFs('access', { path: dirPath }).then(() => undefined, () => { throw e })
          })
        )
      },
      access(path) {
        return callFs('access', { path }).then(() => true, e => {
          if (isNotExistError(e)) return false
          return false
        })
      },
      stat(path) {
        return callFs('stat', { path }).then(res => {
          const s = res.stats || {}
          return {
            size: Number.isFinite(Number(s.size)) ? Number(s.size) : 0,
            isDirectory: typeof s.isDirectory === 'function' ? !!s.isDirectory() : !!s.isDirectory,
            isFile: typeof s.isFile === 'function' ? !!s.isFile() : (s.isFile === undefined ? !(s.isDirectory) : !!s.isFile)
          }
        })
      },
      saveFile(options) {
        return callFs('saveFile', { tempFilePath: options.tempFilePath, filePath: options.filePath })
          .then(res => ({ savedFilePath: res.savedFilePath || options.filePath }))
      },
      unlink(options) {
        return callFs('unlink', { filePath: options.filePath }).then(() => undefined)
      },
      // S5：按字节区间读取。position / length 一律显式传入，
      // 绝不提供「不传 length 就读全文件」的用法（见 MAX_READ_BYTES）。
      readFile(options) {
        const o = options || {}
        const payload = { filePath: o.filePath }
        if (o.encoding) payload.encoding = o.encoding
        if (Number.isFinite(Number(o.position))) payload.position = Number(o.position)
        if (Number.isFinite(Number(o.length))) payload.length = Number(o.length)
        return callFs('readFile', payload).then(res => ({ data: res.data }))
      },
      readdir(dirPath) {
        return callFs('readdir', { dirPath }).then(res => (Array.isArray(res.files) ? res.files : []))
      }
    },
    storage: {
      read(key) {
        try {
          return getWx().getStorageSync(key)
        } catch (e) {
          return ''
        }
      },
      write(key, value) {
        getWx().setStorageSync(key, value)
      }
    },
    now: () => Date.now(),
    random: () => Math.random()
  }
}

// ---------------- 仓库 ----------------

function createLocalBooks(env) {
  const e = env || createWxEnv()
  const fs = e.fs
  const storage = e.storage
  const now = e.now || (() => Date.now())
  const random = e.random || (() => Math.random())

  function dir() {
    return fs.getUserDataPath() + '/' + SUB_DIR
  }

  function resolvePath(entry) {
    if (!isFileEntry(entry)) return null
    return dir() + '/' + entry.fileName
  }

  function rawIndex() {
    try {
      return storage.read(STORAGE_KEY)
    } catch (err) {
      return ''
    }
  }

  // 损坏原文只备份一次，绝不覆盖既有备份（可恢复数据必须留下）
  function backupCorruptIndex(raw) {
    try {
      const existing = storage.read(CORRUPT_BACKUP_KEY)
      if (existing && String(existing).trim()) return CORRUPT_BACKUP_KEY
      storage.write(CORRUPT_BACKUP_KEY, JSON.stringify({ at: now(), raw: String(raw == null ? '' : raw) }))
      return CORRUPT_BACKUP_KEY
    } catch (err) {
      return null
    }
  }

  // 唯一权威读取口：返回判定状态 + 索引 + 备份键
  function readIndexResult() {
    const raw = rawIndex()
    const info = inspectIndex(raw)
    if (info.status === 'corrupt') {
      return {
        status: 'corrupt',
        reason: info.reason,
        index: emptyIndex(),
        raw,
        backupKey: backupCorruptIndex(raw)
      }
    }
    return { status: info.status, reason: null, index: normalizeIndex(raw), raw, backupKey: null }
  }

  function readIndex() {
    return readIndexResult().index
  }

  function writeIndex(books, pendingAppliedOverride, options) {
    const force = !!(options && options.force)
    const raw = rawIndex()
    const info = inspectIndex(raw)
    if (info.status === 'corrupt' && !force) {
      // fail-closed：损坏索引不得被当成首次使用而覆盖
      throw fail(STAGE.LOCKED, 'INDEX_CORRUPT_LOCKED', { reason: info.reason })
    }
    const prevApplied = sanitizePendingMap(normalizeIndex(raw).pendingApplied)
    const payload = {
      version: INDEX_VERSION,
      updatedAt: now(),
      pendingApplied: pendingAppliedOverride === undefined ? prevApplied : sanitizePendingMap(pendingAppliedOverride),
      books: sortBooks((Array.isArray(books) ? books : []).map(normalizeEntry))
    }
    try {
      storage.write(STORAGE_KEY, JSON.stringify(payload))
    } catch (err) {
      throw fail(STAGE.META, 'META_WRITE_FAILED', { errMsg: err && (err.errMsg || err.message) })
    }
    return payload
  }

  // 用户确认后的显式修复入口：原文先备份，再写空索引
  function repairIndex(options) {
    const opts = options || {}
    if (opts.confirm !== true) {
      return Promise.reject(fail(STAGE.CORRUPT, 'REPAIR_REQUIRES_CONFIRM'))
    }
    const raw = rawIndex()
    const info = inspectIndex(raw)
    if (info.status !== 'corrupt') {
      return Promise.resolve({ repaired: false, reason: info.status, backupKey: null, books: readIndex().books })
    }
    const backupKey = backupCorruptIndex(raw)
    try {
      writeIndex([], {}, { force: true })
    } catch (err) {
      return Promise.reject(fail(STAGE.META, 'REPAIR_WRITE_FAILED', { errMsg: err && err.errMsg }))
    }
    return Promise.resolve({ repaired: true, reason: info.reason, backupKey, books: [] })
  }

  function list() {
    const read = readIndexResult()
    const idx = read.index
    const warnings = []
    if (read.status === 'corrupt') {
      // 不删文件、不覆盖索引：只上报明确错误状态，等用户决定
      warnings.push({ stage: STAGE.CORRUPT, code: 'INDEX_CORRUPT', reason: read.reason, backupKey: read.backupKey })
      return Promise.resolve({
        books: [],
        warnings,
        indexStatus: 'corrupt',
        corrupted: true,
        backupKey: read.backupKey
      })
    }
    const fileEntries = idx.books.filter(isFileEntry)
    if (!fileEntries.length) {
      return Promise.resolve({
        books: applyMissing(idx.books, []),
        warnings,
        indexStatus: read.status,
        corrupted: false
      })
    }
    return Promise.all(fileEntries.map(b => fs.access(resolvePath(b)).then(ok => ({ name: b.fileName, ok }))))
      .then(results => {
        const missing = new Set(results.filter(r => !r.ok).map(r => r.name))
        const books = applyMissing(idx.books, missing)
        const changed = books.some((b, i) => b.missing !== idx.books[i].missing)
        if (changed) {
          try {
            writeIndex(books)
          } catch (err) {
            warnings.push({ stage: STAGE.META, code: 'MISSING_FLAG_PERSIST_FAILED' })
          }
        }
        return { books, warnings, indexStatus: read.status, corrupted: false }
      })
  }

  // ---- S3：本机 PDF 直开所需的读侧能力（只读 / 存在性 / 丢失标记）----
  // 设计约束：
  //   - get 返回权威记录副本，页面不得依赖列表里的陈旧快照
  //   - verifyFile 只做存在性判定，路径一律运行时由 USER_DATA_PATH 派生，
  //     绝不使用 entry.filePath（导入时快照，协议可能与当前运行环境不同）
  //   - markMissing 只改 missing 标记，绝不删除条目、绝不删除文件
  //   - missing 不进 WRITABLE_FIELDS，避免 update() 被用来任意改丢失状态

  function get(localId) {
    const idx = readIndex()
    const found = idx.books.find(b => b.localId === localId)
    return found ? Object.assign({}, found) : null
  }

  function verifyFile(localId) {
    const read = readIndexResult()
    if (read.status === 'corrupt') {
      return Promise.resolve({ exists: false, reason: 'INDEX_CORRUPT', localId, path: null, entry: null })
    }
    const entry = read.index.books.find(b => b.localId === localId)
    if (!entry) {
      return Promise.resolve({ exists: false, reason: 'NOT_FOUND', localId, path: null, entry: null })
    }
    const p = resolvePath(entry)
    if (!p) {
      return Promise.resolve({ exists: false, reason: 'NO_FILE_ENTRY', localId, path: null, entry })
    }
    return fs.access(p)
      .then(ok => ({ exists: !!ok, reason: ok ? null : 'FILE_MISSING', localId, path: p, entry }))
      .catch(() => ({ exists: false, reason: 'ACCESS_FAILED', localId, path: p, entry }))
  }

  function markMissing(localId, missing) {
    const read = readIndexResult()
    if (read.status === 'corrupt') {
      return Promise.reject(fail(STAGE.CORRUPT, 'INDEX_CORRUPT_LOCKED', { reason: read.reason }))
    }
    const idx = read.index
    const i = idx.books.findIndex(b => b.localId === localId)
    if (i === -1) return Promise.reject(fail(STAGE.META, 'NOT_FOUND', { localId }))
    const flag = missing !== false
    const books = idx.books.slice()
    books[i] = normalizeEntry(Object.assign({}, idx.books[i], { missing: flag, updatedAt: now() }))
    try {
      const payload = writeIndex(books)
      return Promise.resolve({
        entry: payload.books.find(b => b.localId === localId),
        books: payload.books,
        missing: flag,
        persisted: true
      })
    } catch (err) {
      // 标记不落盘不阻断打开流程（页面仍会给出丢失提示），但必须显式回报 persisted:false
      return Promise.resolve({
        entry: books[i],
        books: idx.books,
        missing: flag,
        persisted: false,
        reason: (err && err.code) || 'META_WRITE_FAILED'
      })
    }
  }

  // ---- S5：本机 TXT 阅读所需的读侧能力（只读 / 有界读取 / 权威大小）----
  // 设计约束：
  //   - 路径一律运行时由 USER_DATA_PATH 派生，绝不使用 entry.filePath 快照
  //   - 读取一律「有界」：length 必填且有硬上限，不存在整文件读入内存的入口
  //   - 失败以结果对象返回、不抛异常炸页面；任何失败都绝不修改数据
  //   - 索引损坏时拒绝读取（fail-closed），绝不自动 repairIndex

  function statFile(localId) {
    const read = readIndexResult()
    if (read.status === 'corrupt') {
      return Promise.resolve({ exists: false, size: 0, path: null, entry: null, reason: 'INDEX_CORRUPT', localId })
    }
    const entry = read.index.books.find(b => b.localId === localId)
    if (!entry) {
      return Promise.resolve({ exists: false, size: 0, path: null, entry: null, reason: 'NOT_FOUND', localId })
    }
    const p = resolvePath(entry)
    if (!p) {
      return Promise.resolve({ exists: false, size: 0, path: null, entry, reason: 'NO_FILE_ENTRY', localId })
    }
    return fs.stat(p).then(
      stats => ({
        exists: true,
        size: Number.isFinite(Number(stats && stats.size)) ? Number(stats.size) : 0,
        path: p,
        entry,
        reason: null,
        localId
      }),
      err => {
        if (isNotExistError(err)) return { exists: false, size: 0, path: p, entry, reason: 'FILE_MISSING', localId }
        return {
          exists: false,
          size: 0,
          path: p,
          entry,
          reason: 'STAT_FAILED',
          errCode: err && err.errCode,
          localId
        }
      }
    )
  }

  function readRange(localId, options) {
    const o = options || {}
    const offset = Number(o.offset)
    const length = Number(o.length)
    const encoding = o.encoding ? String(o.encoding) : 'utf8'
    if (!Number.isFinite(offset) || offset < 0) {
      return Promise.resolve({ ok: false, reason: 'BAD_RANGE', localId })
    }
    // length 必填：没有「不传就读全文件」的退化路径
    if (!Number.isFinite(length) || length <= 0) {
      return Promise.resolve({ ok: false, reason: 'BAD_RANGE', localId })
    }
    if (length > MAX_READ_BYTES) {
      return Promise.resolve({ ok: false, reason: 'READ_TOO_LARGE', localId, maxBytes: MAX_READ_BYTES, length })
    }
    const read = readIndexResult()
    if (read.status === 'corrupt') {
      return Promise.resolve({ ok: false, reason: 'INDEX_CORRUPT', localId })
    }
    const entry = read.index.books.find(b => b.localId === localId)
    if (!entry) return Promise.resolve({ ok: false, reason: 'NOT_FOUND', localId })
    const p = resolvePath(entry)
    if (!p) return Promise.resolve({ ok: false, reason: 'NO_FILE_ENTRY', localId })
    return fs.readFile({ filePath: p, encoding, position: offset, length }).then(
      res => ({
        ok: true,
        data: res && res.data,
        offset,
        length,
        encoding,
        path: p,
        localId
      }),
      err => ({
        ok: false,
        reason: isNotExistError(err) ? 'FILE_MISSING' : 'READ_FAILED',
        errCode: err && err.errCode,
        errMsg: err && err.errMsg,
        path: p,
        localId
      })
    )
  }

  // 整文件读取：**仅**作为「分段读取（position/length）在真机不被支持」时的
  // 安全替代，且有硬上限。绝不允许被当成常规读取入口 ——
  //   - 超过 MAX_WHOLE_READ_BYTES 直接拒绝（READ_TOO_LARGE）
  //   - 拒绝时不读一个字节，返回结果对象而不是抛异常
  function readWholeText(localId) {
    const read = readIndexResult()
    if (read.status === 'corrupt') {
      return Promise.resolve({ ok: false, reason: 'INDEX_CORRUPT', localId })
    }
    const entry = read.index.books.find(b => b.localId === localId)
    if (!entry) return Promise.resolve({ ok: false, reason: 'NOT_FOUND', localId })
    const p = resolvePath(entry)
    if (!p) return Promise.resolve({ ok: false, reason: 'NO_FILE_ENTRY', localId })
    return fs.stat(p).then(
      stats => {
        const size = stats && Number.isFinite(Number(stats.size)) ? Number(stats.size) : 0
        if (size > MAX_WHOLE_READ_BYTES) {
          return { ok: false, reason: 'READ_TOO_LARGE', size, maxBytes: MAX_WHOLE_READ_BYTES, path: p, localId }
        }
        return fs.readFile({ filePath: p, encoding: 'utf8' }).then(
          res => ({ ok: true, data: res && res.data, size, path: p, localId }),
          err => ({
            ok: false,
            reason: isNotExistError(err) ? 'FILE_MISSING' : 'READ_FAILED',
            errCode: err && err.errCode,
            errMsg: err && err.errMsg,
            path: p,
            localId
          })
        )
      },
      err => ({
        ok: false,
        reason: isNotExistError(err) ? 'FILE_MISSING' : 'STAT_FAILED',
        errCode: err && err.errCode,
        path: p,
        localId
      })
    )
  }

  function importFile(input, options) {
    const opts = options || {}
    const source = input || {}
    const tempFilePath = source.tempFilePath || source.path
    const read = readIndexResult()
    if (read.status === 'corrupt') {
      // 损坏索引下 fail-closed：不落任何文件、不覆盖元数据
      return Promise.reject(fail(STAGE.CORRUPT, 'INDEX_CORRUPT_LOCKED', { reason: read.reason, backupKey: read.backupKey }))
    }
    const idx = read.index
    const checked = validateImport(source, idx.books)
    if (!checked.ok) return Promise.reject(fail(checked.stage, checked.code, checked))
    if (!tempFilePath) return Promise.reject(fail(STAGE.VALIDATE, 'MISSING_TEMP_PATH'))

    const meta = sanitizeImportMeta(opts.meta)
    const ts = now()
    let savedPath = null

    return fs.ensureDir(dir())
      .catch(err => { throw fail(STAGE.DIR, 'DIR_ENSURE_FAILED', { errCode: err && err.errCode, errMsg: err && err.errMsg }) })
      // 先落到「权威大小」再决定是否写入：declared size 可能缺失（云端迁移）
      // 也可能不准，因此落盘前的最后一道校验必须基于 stat 的真实字节数。
      .then(() => fs.stat(tempFilePath).catch(() => null))
      .then(stats => {
        const actual = stats && Number.isFinite(Number(stats.size)) && Number(stats.size) > 0 ? Number(stats.size) : 0
        const declared = checked.sizeKnown ? Number(checked.size) : 0
        const effective = actual > 0 ? actual : declared
        const sizeCheck = validateSize(effective, idx.books)
        if (!sizeCheck.ok) throw fail(sizeCheck.stage, sizeCheck.code, sizeCheck)
        return sizeCheck.size
      })
      .then(size => {
        // 重名判定用真实大小，避免「同一份文件因声明大小不同而漏判重复」
        const dup = findDuplicate(idx.books, { name: checked.name, ext: checked.ext, size })
        let target = null
        if (dup) {
          if (opts.onDuplicate !== 'replace') {
            throw fail(STAGE.VALIDATE, 'DUPLICATE', { duplicateLocalId: dup.localId })
          }
          target = dup
        }
        const localId = target ? target.localId : makeLocalId(now(), random())
        const fileName = target && normalizeExt(target.ext) === checked.ext
          ? target.fileName
          : makeFileName(localId, checked.ext)
        const destPath = dir() + '/' + fileName
        return { size, target, localId, fileName, destPath }
      })
      .then(plan => {
        const { target } = plan
        const cleanup = target
          ? fs.unlink({ filePath: resolvePath(target) }).catch(() => undefined)
          : Promise.resolve()
        return cleanup
          .then(() => fs.saveFile({ tempFilePath, filePath: plan.destPath }))
          .catch(err => {
            if (err && err.stage) throw err
            throw fail(STAGE.SAVE_FILE, 'SAVE_FILE_FAILED', { errCode: err && err.errCode, errMsg: err && err.errMsg })
          })
          .then(res => {
            savedPath = (res && res.savedFilePath) || plan.destPath
            return plan
          })
      })
      .then(plan => fs.stat(savedPath).catch(() => null).then(stats => ({ plan, stats })))
      .then(({ plan, stats }) => {
        const size = stats && Number.isFinite(Number(stats.size)) ? Number(stats.size) : plan.size
        if (!stats || size <= 0) {
          // 落盘校验失败也必须回滚，避免留一个孤儿空文件
          return fs.unlink({ filePath: savedPath })
            .catch(() => undefined)
            .then(() => { throw fail(STAGE.VERIFY, 'SAVED_FILE_EMPTY', { savedPath }) })
        }
        return { plan, size }
      })
      .then(({ plan, size }) => {
        const base = plan.target || {}
        const entry = normalizeEntry({
          localId: plan.localId,
          name: checked.name,
          ext: checked.ext,
          fileName: plan.fileName,
          filePath: savedPath,
          size,
          author: meta.author !== undefined ? meta.author : (base.author || ''),
          status: meta.status !== undefined
            ? meta.status
            : (plan.target ? (base.status || 'reading') : 'reading'),
          progressPercent: meta.progressPercent !== undefined
            ? meta.progressPercent
            : (plan.target ? base.progressPercent : 0),
          minutes: meta.minutes !== undefined
            ? meta.minutes
            : (plan.target ? base.minutes : 0),
          note: meta.note !== undefined ? meta.note : (base.note || ''),
          coverColor: meta.coverColor !== undefined
            ? meta.coverColor
            : (base.coverColor || pickCoverColor(random())),
          migratedFrom: meta.migratedFrom !== undefined ? meta.migratedFrom : (base.migratedFrom || null),
          createdAt: plan.target ? base.createdAt : ts,
          updatedAt: ts
        })
        const books = idx.books.filter(b => b.localId !== plan.localId).concat([entry])
        let payload
        try {
          payload = writeIndex(books)
        } catch (metaErr) {
          // 导入必须可回滚：元数据写失败 → 删除刚落盘的文件，不留有文件无记录
          return fs.unlink({ filePath: savedPath })
            .catch(() => undefined)
            .then(() => { throw fail(STAGE.META, 'META_WRITE_FAILED_ROLLED_BACK', { errMsg: metaErr && metaErr.errMsg }) })
        }
        return { entry, books: payload.books }
      })
  }

  function update(localId, patch) {
    const read = readIndexResult()
    if (read.status === 'corrupt') {
      return Promise.reject(fail(STAGE.CORRUPT, 'INDEX_CORRUPT_LOCKED', { reason: read.reason }))
    }
    const idx = read.index
    const i = idx.books.findIndex(b => b.localId === localId)
    if (i === -1) return Promise.reject(fail(STAGE.META, 'NOT_FOUND', { localId }))
    const p = patch && typeof patch === 'object' ? patch : {}
    if (hasForbiddenField(p)) {
      return Promise.reject(fail(STAGE.VALIDATE, 'FORBIDDEN_FIELD', { fields: Object.keys(p).filter(k => FORBIDDEN_FIELDS.includes(k)) }))
    }
    const next = Object.assign({}, idx.books[i])
    for (const key of WRITABLE_FIELDS) {
      if (p[key] !== undefined) next[key] = p[key]
    }
    next.updatedAt = now()
    const books = idx.books.slice()
    books[i] = normalizeEntry(next)
    let payload
    try {
      payload = writeIndex(books)
    } catch (err) {
      return Promise.reject(err)
    }
    return Promise.resolve({ entry: payload.books.find(b => b.localId === localId), books: payload.books })
  }

  function addMinutes(localId, minutes) {
    const delta = Number(minutes)
    if (!Number.isFinite(delta) || delta <= 0) {
      return Promise.reject(fail(STAGE.VALIDATE, 'BAD_MINUTES', { minutes }))
    }
    const read = readIndexResult()
    if (read.status === 'corrupt') {
      return Promise.reject(fail(STAGE.CORRUPT, 'INDEX_CORRUPT_LOCKED', { reason: read.reason }))
    }
    const idx = read.index
    const i = idx.books.findIndex(b => b.localId === localId)
    if (i === -1) return Promise.reject(fail(STAGE.META, 'NOT_FOUND', { localId }))
    const cur = idx.books[i]
    const next = Object.assign({}, cur, {
      minutes: (Number(cur.minutes) || 0) + Math.round(delta),
      updatedAt: now()
    })
    const books = idx.books.slice()
    books[i] = normalizeEntry(next)
    try {
      const payload = writeIndex(books)
      return Promise.resolve({ entry: payload.books.find(b => b.localId === localId), books: payload.books, buffered: false })
    } catch (err) {
      if (err && err.code === 'INDEX_CORRUPT_LOCKED') return Promise.reject(err)
      // 不允许静默丢进度：写失败时把增量落到独立的待补写键
      const buf = bufferPending(localId, Math.round(delta))
      return Promise.resolve({
        entry: cur,
        books: idx.books,
        buffered: buf.buffered === true,
        pendingWriteFailed: buf.buffered !== true,
        pendingReason: buf.reason
      })
    }
  }

  function readPending() {
    let raw
    try {
      raw = storage.read(PENDING_KEY)
    } catch (err) {
      return {}
    }
    return sanitizePendingMap(raw)
  }

  // 幂等核心：先看索引里记录的「已应用快照」。
  // 若待补写键与已应用快照相同，说明这批增量早就进了索引（上次清 pending 失败），
  // 必须先丢弃旧快照再叠新增量，否则下次 flush 会重复累计。
  function bufferPending(localId, delta) {
    const idx = readIndex()
    let pending = readPending()
    if (Object.keys(pending).length && pendingMapsEqual(pending, idx.pendingApplied)) {
      try {
        storage.write(PENDING_KEY, '{}')
      } catch (err) {
        // 连清空都写不进去 → 不能假装已缓冲，否则新增量会静默丢失
        return { buffered: false, reason: 'PENDING_RESET_FAILED' }
      }
      pending = {}
    }
    pending[localId] = (Number(pending[localId]) || 0) + delta
    try {
      storage.write(PENDING_KEY, JSON.stringify(pending))
      return { buffered: true, reason: null }
    } catch (err) {
      return { buffered: false, reason: 'PENDING_WRITE_FAILED' }
    }
  }

  function flushPending() {
    const read = readIndexResult()
    if (read.status === 'corrupt') {
      // 索引不可用时不消费待补写键，等恢复后再合并
      return Promise.resolve({
        flushed: 0, dropped: 0, alreadyApplied: false, corrupted: true, books: read.index.books
      })
    }
    const idx = read.index
    const pending = readPending()
    const ids = Object.keys(pending)
    if (!ids.length) {
      return Promise.resolve({ flushed: 0, dropped: 0, alreadyApplied: false, corrupted: false, books: idx.books })
    }

    // 幂等分支：这批增量已经写在索引里了 → 只清理待补写键，绝不再次相加
    if (pendingMapsEqual(pending, idx.pendingApplied)) {
      let cleared = true
      try {
        storage.write(PENDING_KEY, '{}')
      } catch (err) {
        cleared = false
      }
      return Promise.resolve({
        flushed: 0, dropped: 0, alreadyApplied: true, cleared, corrupted: false, books: idx.books
      })
    }

    const known = new Set(idx.books.map(b => b.localId))
    let dropped = 0
    for (const id of ids) {
      if (!known.has(id)) dropped += 1
    }
    let flushed = 0
    const books = idx.books.map(b => {
      const delta = Number(pending[b.localId])
      if (!delta || delta <= 0) return b
      flushed += 1
      return normalizeEntry(Object.assign({}, b, { minutes: (Number(b.minutes) || 0) + Math.round(delta) }))
    })

    if (!flushed) {
      // 全部指向已不存在的条目 → 清理，避免待补写键永久残留；丢弃数量显式回报
      try {
        storage.write(PENDING_KEY, '{}')
      } catch (err) { /* 下次再试 */ }
      return Promise.resolve({ flushed: 0, dropped, alreadyApplied: false, corrupted: false, books: idx.books })
    }

    let payload
    try {
      // 关键：把本次已应用快照写进索引，再清 pending —— 中途失败也不会重复累计
      payload = writeIndex(books, pending)
    } catch (err) {
      return Promise.resolve({
        flushed: 0, dropped, alreadyApplied: false, corrupted: false, writeFailed: true, books: idx.books
      })
    }
    let cleared = true
    try {
      storage.write(PENDING_KEY, '{}')
    } catch (err) {
      cleared = false
    }
    return Promise.resolve({ flushed, dropped, alreadyApplied: false, cleared, corrupted: false, books: payload.books })
  }

  // S4：删除该书时同步清理它的「本机单书分钟」待补写增量，避免 pending 键永久残留。
  // 关键边界：
  //   - 只清 localBooks_pending_v1 中该 localId 的键，不动其他书、不动整个键
  //   - 绝不触碰 readingDailyPending_v1（每日阅读统计与单书是否被删除无关，
  //     删除书籍不得导致已失败待补报的每日统计被丢弃）
  //   - 清理失败也不影响删除结果：flushPending 对「已不存在的 localId」只计数丢弃，
  //     绝不重建条目，因此不会把已删除的书复活
  function dropPendingFor(localId) {
    const pending = readPending()
    if (!Object.prototype.hasOwnProperty.call(pending, localId)) {
      return { droppedPendingMinutes: 0, pendingCleared: true, pendingReason: null }
    }
    const dropped = Number(pending[localId]) || 0
    const next = Object.assign({}, pending)
    delete next[localId]
    try {
      storage.write(PENDING_KEY, JSON.stringify(next))
      return { droppedPendingMinutes: dropped, pendingCleared: true, pendingReason: null }
    } catch (err) {
      return { droppedPendingMinutes: 0, pendingCleared: false, pendingReason: 'PENDING_CLEAR_FAILED' }
    }
  }

  function remove(localId) {
    const read = readIndexResult()
    if (read.status === 'corrupt') {
      return Promise.reject(fail(STAGE.CORRUPT, 'INDEX_CORRUPT_LOCKED', { reason: read.reason }))
    }
    const idx = read.index
    const entry = idx.books.find(b => b.localId === localId)
    if (!entry) return Promise.resolve({ removed: false, reason: 'NOT_FOUND', books: idx.books })
    const targetPath = resolvePath(entry)
    const removeFileStep = targetPath
      ? fs.unlink({ filePath: targetPath }).catch(err => {
        if (isNotExistError(err)) return undefined // 幂等：文件本就不在 → 视为成功
        throw fail(STAGE.DELETE_FILE, 'DELETE_FILE_FAILED', { errCode: err && err.errCode, errMsg: err && err.errMsg })
      })
      : Promise.resolve()

    return removeFileStep.then(() => {
      // 只移除该条目，其他书籍的 minutes / progressPercent / status 一字不动
      const books = idx.books.filter(b => b.localId !== localId)
      let payload
      try {
        payload = writeIndex(books)
      } catch (err) {
        if (err && err.code === 'INDEX_CORRUPT_LOCKED') throw err
        // 文件已删、元数据未清：下次 list 会把它标 missing，不会产生幽灵条目
        throw fail(STAGE.DELETE_META, 'DELETE_META_FAILED', { localId })
      }
      const pending = dropPendingFor(localId)
      return Object.assign({ removed: true, books: payload.books }, pending)
    })
  }

  function usage() {
    return computeUsage(readIndex().books)
  }

  function scanOrphans() {
    const read = readIndexResult()
    const idx = read.index
    return fs.ensureDir(dir())
      .then(() => fs.readdir(dir()))
      .then(files => ({ orphans: collectOrphans(files, idx.books), books: idx.books, indexStatus: read.status }))
      .catch(err => ({
        orphans: [],
        books: idx.books,
        indexStatus: read.status,
        error: (err && err.errMsg) || String(err)
      }))
  }

  return {
    dir,
    resolvePath,
    readIndex,
    readIndexResult,
    writeIndex,
    repairIndex,
    list,
    get,
    verifyFile,
    markMissing,
    statFile,
    readRange,
    readWholeText,
    importFile,
    update,
    addMinutes,
    flushPending,
    readPending,
    remove,
    dropPendingFor,
    usage,
    scanOrphans
  }
}

let _default = null
function getLocalBooks() {
  if (!_default) _default = createLocalBooks(createWxEnv())
  return _default
}

module.exports = {
  STORAGE_KEY,
  PENDING_KEY,
  CORRUPT_BACKUP_KEY,
  INDEX_VERSION,
  SUB_DIR,
  SUPPORTED_EXT,
  STATUS_SET,
  COVER_COLORS,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  SAFE_TOTAL_BYTES,
  MAX_READ_BYTES,
  MAX_WHOLE_READ_BYTES,
  IMPORT_META_FIELDS,
  WRITABLE_FIELDS,
  FORBIDDEN_FIELDS,
  STAGE,
  normalizeExt,
  stripExt,
  sanitizeName,
  makeLocalId,
  makeFileName,
  pickCoverColor,
  clampPercent,
  isFileEntry,
  dedupeKey,
  sortBooks,
  computeUsage,
  formatBytes,
  normalizeEntry,
  normalizeIndex,
  emptyIndex,
  inspectIndex,
  sanitizePendingMap,
  pendingMapsEqual,
  hasForbiddenField,
  findDuplicate,
  validateImport,
  validateSize,
  sanitizeImportMeta,
  collectOrphans,
  applyMissing,
  createWxEnv,
  createLocalBooks,
  getLocalBooks
}
