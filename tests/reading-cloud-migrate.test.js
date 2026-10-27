// ============================================================
// tests/reading-cloud-migrate.test.js · 旧云端书籍「保存到本机」行为测试
//
// 覆盖（全部真实执行 pages/reading/reading.js，不做源码字符串假验证）：
//   - 用户主动点击才触发；没有 fileID 的手动书单没有入口
//   - 检查云端文件存在 → 取临时地址 → 下载临时目录 → 落 USER_DATA_PATH
//   - 书名 / 类型 / 作者 / 阅读元数据一并迁移，migratedFrom 记录原云端 ID
//   - 防重复迁移、防并发重复点击
//   - 失败（地址失效 / 下载失败 / 非 200 / 类型不符 / 超限 / 空间不足 /
//     空文件 / 重名 / 索引损坏）必须显式失败且不留残留
//   - 原云端记录与云存储文件始终保留（deleteFile / books.update / add 全 0）
// ============================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fsSync = require('node:fs')
const pathMod = require('node:path')

const lb = require('../utils/localBooks')
const { createReadingHarness } = require('./reading-page-harness')

const READING_SRC = fsSync.readFileSync(
  pathMod.join(__dirname, '..', 'pages', 'reading', 'reading.js'), 'utf8'
)
const READING_WXML = fsSync.readFileSync(
  pathMod.join(__dirname, '..', 'pages', 'reading', 'reading.wxml'), 'utf8'
)

const MB = 1024 * 1024

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

function bookDir(h) {
  return h.fs.userDataPath + '/' + lb.SUB_DIR
}

function bookFiles(h) {
  const prefix = bookDir(h) + '/'
  return h.fs.listFiles().filter(p => String(p).indexOf(prefix) === 0)
}

function tempFiles(h) {
  return h.fs.listFiles().filter(p => String(p).indexOf(h.fs.userDataPath + '/tmp/') === 0)
}

// 造一本「已在本机」的书：索引里一条记录 + 磁盘上真实字节
function seedLocalBook(h, o) {
  const opts = o || {}
  const ext = opts.ext || 'txt'
  const localId = opts.localId || 'lb_seed_1'
  const fileName = opts.fileName || (localId + '.' + ext)
  const p = bookDir(h) + '/' + fileName
  const declared = Number.isFinite(Number(opts.size)) ? Number(opts.size) : 4096
  if (opts.bytes !== undefined) h.fs.seedFileBytes(p, opts.bytes)
  else h.fs.seedFile(p, declared)
  const size = h.fs.sizeOf(p) || declared
  const idx = parseIndex(h.storage) || { version: 1, updatedAt: 0, pendingApplied: {}, books: [] }
  idx.books = (idx.books || []).filter(b => b.localId !== localId)
  idx.books.push(lb.normalizeEntry(Object.assign({
    localId,
    name: opts.name || '测试本机书',
    ext,
    source: 'local',
    fileName,
    filePath: p,
    size,
    status: 'reading',
    progressPercent: 0,
    minutes: 0,
    missing: false,
    createdAt: 1000,
    updatedAt: 1000
  }, opts.extra || {})))
  h.storage.write(lb.STORAGE_KEY, JSON.stringify(idx))
  return { localId, fileName, path: p, size }
}

function migrate(page, book) {
  return page.migrateCloudBook({ currentTarget: { dataset: { b: book } } })
}

// 让 Promise 链全部落地
function flush(times) {
  const n = times || 10
  let p = Promise.resolve()
  for (let i = 0; i < n; i++) p = p.then(() => new Promise(r => setImmediate(r)))
  return p
}

const CLOUD_PDF = {
  _id: 'cloud_book_1',
  name: '云端的书',
  ext: 'pdf',
  fileID: 'cloud://env.bucket/books/cloud_book_1.pdf',
  author: '某作者',
  status: 'reading',
  progressPercent: 42,
  minutes: 37,
  note: '一句话笔记',
  coverColor: '#BFE3F2'
}

const CLOUD_TXT = {
  _id: 'cloud_book_2',
  name: '云端笔记',
  ext: 'txt',
  fileID: 'cloud://env.bucket/books/cloud_book_2.txt',
  minutes: 5
}

// ---------------- 1. 正常路径 ----------------

test('MIGRATE_CLOUD_PDF_SAVES_TO_LOCAL_WITH_METADATA', async t => {
  const pdfBytes = Buffer.from('%PDF-1.4 fake pdf body', 'utf8')
  const h = harness(t, { downloadBytes: pdfBytes })
  const page = h.load()

  const res = await migrate(page, CLOUD_PDF)

  assert.strictEqual(res.migrated, true)
  assert.strictEqual(res.cloudId, 'cloud_book_1')
  assert.strictEqual(res.cloudKept, true)
  assert.strictEqual(h.calls.getTempFileURL, 1)
  assert.strictEqual(h.calls.downloadFile, 1)
  assert.strictEqual(h.calls.downloadFileData[0].url, 'https://example.invalid/cloud.pdf')

  const entry = entryOf(h, res.localId)
  assert.ok(entry, '本机索引里必须有迁移后的条目')
  assert.strictEqual(entry.migratedFrom, 'cloud_book_1', 'migratedFrom 必须记录原云端书籍 ID')
  assert.strictEqual(entry.name, '云端的书')
  assert.strictEqual(entry.ext, 'pdf')
  assert.strictEqual(entry.author, '某作者')
  assert.strictEqual(entry.status, 'reading')
  assert.strictEqual(entry.progressPercent, 42)
  assert.strictEqual(entry.minutes, 37)
  assert.strictEqual(entry.note, '一句话笔记')
  assert.strictEqual(entry.coverColor, '#BFE3F2')
  assert.strictEqual(entry.size, pdfBytes.length, 'size 必须来自真实 stat，不依赖任何声明值')

  // 文件真实落在 USER_DATA_PATH/books/
  assert.strictEqual(entry.filePath, bookDir(h) + '/' + entry.fileName)
  assert.ok(h.fs.hasFile(entry.filePath), '本机必须真的有这个文件')
  assert.strictEqual(bookFiles(h).length, 1)
  assert.deepStrictEqual(tempFiles(h), [], '迁移成功后不得留下临时文件')

  // 列表已刷新
  assert.strictEqual(page.data.localBooks.length, 1)
  assert.strictEqual(page.data.localBooks[0].localId, res.localId)
  assert.ok(h.toastTitles().includes('已保存到本机'))
})

test('MIGRATE_NEVER_DELETES_OR_MUTATES_CLOUD_DATA', async t => {
  const h = harness(t, { downloadBytes: Buffer.from('cloud bytes', 'utf8') })
  const page = h.load()

  await migrate(page, CLOUD_PDF)

  assert.strictEqual(h.calls.deleteFile, 0, '绝不调用 deleteFile')
  assert.strictEqual(h.calls.uploadFile, 0, '迁移是下载方向，绝不 uploadFile')
  assert.deepStrictEqual(h.calls.booksUpdate, [], '绝不写云端 books 记录')
  assert.strictEqual(h.calls.booksAdd, 0, '绝不新增云端 books 记录')
  assert.strictEqual(h.calls.booksQuery, 0, '迁移不依赖云端读，回列表后由 loadBooks 负责')
  // 源码级兜底：迁移链路里不得出现任何云端删除/写入口
  const from = READING_SRC.indexOf('migrateCloudBook(e) {')
  const to = READING_SRC.indexOf('openBook(e) {')
  assert.ok(from > 0 && to > from, '必须能定位迁移实现')
  const seg = READING_SRC.slice(from, to)
  assert.doesNotMatch(seg, /deleteFile/)
  assert.doesNotMatch(seg, /\.remove\(/)
  assert.doesNotMatch(seg, /\.update\(/)
  assert.doesNotMatch(seg, /\.add\(/)
})

test('MIGRATE_TXT_BYTES_ARE_READABLE_AFTER_SAVE', async t => {
  const text = '第一章\n中文内容 🎉\n第二行\n'
  const h = harness(t, { downloadBytes: Buffer.from(text, 'utf8') })
  const page = h.load()

  const res = await migrate(page, CLOUD_TXT)
  assert.strictEqual(res.migrated, true)

  const entry = entryOf(h, res.localId)
  assert.strictEqual(entry.ext, 'txt')
  assert.strictEqual(entry.size, Buffer.byteLength(text, 'utf8'))
  assert.strictEqual(entry.migratedFrom, 'cloud_book_2')
  assert.strictEqual(entry.minutes, 5)

  const repo = lb.getLocalBooks()
  const whole = await repo.readWholeText(res.localId)
  assert.strictEqual(whole.ok, true)
  assert.strictEqual(whole.data, text, '保存到本机的 TXT 必须能被真实读回，内容一字不差')
})

test('MIGRATE_DERIVES_EXT_FROM_FILEID_WHEN_RECORD_LACKS_EXT', async t => {
  const h = harness(t, { downloadBytes: Buffer.from('x', 'utf8') })
  const page = h.load()

  const res = await migrate(page, Object.assign({}, CLOUD_PDF, { ext: undefined, name: '没有扩展名' }))
  assert.strictEqual(res.migrated, true)
  assert.strictEqual(entryOf(h, res.localId).ext, 'pdf', 'ext 缺失时按 fileID 后缀推导')
})

// ---------------- 2. 防重复 / 防并发 ----------------

test('MIGRATE_ALREADY_MIGRATED_NEVER_DOWNLOADS_AGAIN', async t => {
  const h = harness(t, { downloadBytes: Buffer.from('x', 'utf8') })
  const page = h.load()
  seedLocalBook(h, {
    localId: 'lb_done',
    name: '云端的书',
    ext: 'pdf',
    bytes: Buffer.from('x', 'utf8'),
    extra: { migratedFrom: 'cloud_book_1' }
  })

  const res = await migrate(page, CLOUD_PDF)

  assert.strictEqual(res.migrated, false)
  assert.strictEqual(res.reason, 'ALREADY_MIGRATED')
  assert.strictEqual(res.localId, 'lb_done')
  assert.strictEqual(h.calls.getTempFileURL, 0, '已迁移不得再取临时地址')
  assert.strictEqual(h.calls.downloadFile, 0, '已迁移不得再下载')
  assert.strictEqual(bookFiles(h).length, 1, '不得重复落盘')
  assert.ok(h.toastTitles().includes('这本书已经在本机书架了'))
})

test('MIGRATE_SECOND_CLICK_AFTER_SUCCESS_STILL_REJECTS', async t => {
  const h = harness(t, { downloadBytes: Buffer.from('x', 'utf8') })
  const page = h.load()

  const first = await migrate(page, CLOUD_PDF)
  assert.strictEqual(first.migrated, true)
  const second = await migrate(page, CLOUD_PDF)

  assert.strictEqual(second.migrated, false)
  assert.strictEqual(second.reason, 'ALREADY_MIGRATED')
  assert.strictEqual(h.calls.downloadFile, 1, '整条链路只允许下载一次')
  assert.strictEqual(bookFiles(h).length, 1)
})

test('MIGRATE_CONCURRENT_TAP_IS_IGNORED', async t => {
  const h = harness(t, { downloadBytes: Buffer.from('x', 'utf8') })
  const page = h.load()

  const p1 = migrate(page, CLOUD_PDF)
  const p2 = migrate(page, CLOUD_PDF)

  const r2 = await p2
  assert.strictEqual(r2.migrated, false)
  assert.strictEqual(r2.reason, 'MIGRATE_IN_FLIGHT')

  const r1 = await p1
  assert.strictEqual(r1.migrated, true)
  assert.strictEqual(h.calls.downloadFile, 1, '并发点击只能触发一次下载')
  assert.strictEqual(bookFiles(h).length, 1)
})

test('MIGRATE_IN_FLIGHT_FLAG_IS_RELEASED_AFTER_FAILURE', async t => {
  const h = harness(t, { downloadFails: true })
  const page = h.load()

  const r1 = await migrate(page, CLOUD_PDF)
  assert.strictEqual(r1.migrated, false)
  assert.strictEqual(r1.reason, 'DOWNLOAD_FAILED')
  assert.strictEqual(page._migratingId, null, '失败后必须释放并发锁，允许用户重试')
})

// ---------------- 3. 入口与手动书单 ----------------

test('MANUAL_BOOK_WITHOUT_FILEID_HAS_NO_MIGRATE_ENTRY', async t => {
  const h = harness(t)
  const page = h.load()

  const res = await migrate(page, { _id: 'cloud_manual_1', name: '手动书单', ext: 'pdf' })

  assert.strictEqual(res.migrated, false)
  assert.strictEqual(res.reason, 'NO_CLOUD_FILE')
  assert.strictEqual(h.calls.getTempFileURL, 0)
  assert.strictEqual(h.calls.downloadFile, 0, '手动书单绝不能被伪装成可下载文件')
  assert.strictEqual(bookFiles(h).length, 0)
  assert.ok(h.toastTitles().includes('这条记录没有云端文件'))
  // UI 层：入口本身只对带 fileID 的行渲染
  assert.match(READING_WXML, /wx:if="\{\{item\.fileID\}\}"[^>]*catchtap="migrateCloudBook"/)
})

test('MIGRATE_ENTRY_USES_CATCHTAP_AND_HAS_DONE_STATE', () => {
  const m = READING_WXML.match(/<view[^>]*catchtap="migrateCloudBook"[^>]*>/)
  assert.ok(m, '必须有迁移入口')
  assert.match(m[0], /data-b="\{\{item\}\}"/, '入口必须把整条云端记录带出来')
  assert.doesNotMatch(m[0], /bindtap=/, '必须是 catchtap，不能触发 openBook')
  assert.match(READING_WXML, /item\.migratedLocalId \? '已存' : '存本机'/)
})

test('MIGRATE_WITHOUT_BOOK_ID_FAILS_LOUDLY', async t => {
  const h = harness(t)
  const page = h.load()

  const res = await migrate(page, { name: '没有 id' })

  assert.strictEqual(res.migrated, false)
  assert.strictEqual(res.reason, 'NO_BOOK_ID')
  assert.strictEqual(h.calls.downloadFile, 0)
})

// ---------------- 4. 失败路径：显式失败 + 无残留 ----------------

test('MIGRATE_TEMP_URL_FAILURE_IS_EXPLICIT', async t => {
  const h = harness(t, { tempUrlFails: true })
  const page = h.load()

  const res = await migrate(page, CLOUD_PDF)

  assert.strictEqual(res.migrated, false)
  assert.strictEqual(res.reason, 'TEMP_URL_FAILED')
  assert.strictEqual(h.calls.downloadFile, 0, '地址拿不到就不该发起下载')
  assert.strictEqual(bookFiles(h).length, 0)
  assert.strictEqual(parseIndex(h.storage), null, '失败不得写任何本机索引')
  assert.ok(h.toastTitles().includes('云端文件不可用，请稍后再试'))
})

test('MIGRATE_TEMP_URL_NETWORK_REJECTION_IS_EXPLICIT', async t => {
  const h = harness(t, { tempUrlRejects: true })
  const page = h.load()

  const res = await migrate(page, CLOUD_PDF)

  assert.strictEqual(res.migrated, false)
  assert.strictEqual(res.reason, 'TEMP_URL_FAILED')
  assert.strictEqual(h.calls.downloadFile, 0)
  assert.strictEqual(bookFiles(h).length, 0)
})

test('MIGRATE_DOWNLOAD_FAILURE_IS_EXPLICIT_AND_LEAVES_NOTHING', async t => {
  const h = harness(t, { downloadFails: true })
  const page = h.load()

  const res = await migrate(page, CLOUD_PDF)

  assert.strictEqual(res.migrated, false)
  assert.strictEqual(res.reason, 'DOWNLOAD_FAILED')
  assert.strictEqual(bookFiles(h).length, 0)
  assert.deepStrictEqual(tempFiles(h), [])
  assert.strictEqual(parseIndex(h.storage), null)
  assert.ok(h.toastTitles().includes('下载失败，请检查网络后重试'))
})

test('MIGRATE_NON_200_DOWNLOAD_IS_EXPLICIT', async t => {
  const h = harness(t, { downloadStatusCode: 403 })
  const page = h.load()

  const res = await migrate(page, CLOUD_PDF)

  assert.strictEqual(res.migrated, false)
  assert.strictEqual(res.reason, 'DOWNLOAD_FAILED')
  assert.strictEqual(bookFiles(h).length, 0)
})

test('MIGRATE_UNSUPPORTED_TYPE_IS_REJECTED_BEFORE_NETWORK', async t => {
  const h = harness(t)
  const page = h.load()

  const res = await migrate(page, {
    _id: 'cloud_docx',
    name: '文档',
    ext: 'docx',
    fileID: 'cloud://env.bucket/books/x.docx'
  })

  assert.strictEqual(res.migrated, false)
  assert.strictEqual(res.reason, 'UNSUPPORTED_TYPE')
  assert.strictEqual(h.calls.getTempFileURL, 0)
  assert.strictEqual(h.calls.downloadFile, 0)
  assert.ok(h.toastTitles().includes('只支持 PDF / TXT 文件'))
})

test('MIGRATE_REJECTS_FILE_OVER_100MB_AND_CLEANS_TEMP', async t => {
  const h = harness(t, { downloadSize: 100 * MB + 1 })
  const page = h.load()

  const res = await migrate(page, CLOUD_PDF)

  assert.strictEqual(res.migrated, false)
  assert.strictEqual(res.reason, 'FILE_TOO_LARGE')
  assert.strictEqual(bookFiles(h).length, 0, '超限文件不得落进 books 目录')
  assert.deepStrictEqual(tempFiles(h), [], '失败必须回滚本次下载的临时文件')
  assert.strictEqual(parseIndex(h.storage), null)
  assert.ok(h.toastTitles().includes('单个文件超过 100MB'))
})

test('MIGRATE_REJECTS_STORAGE_FULL', async t => {
  const h = harness(t, { downloadBytes: Buffer.from('0123456789', 'utf8') })
  const page = h.load()
  // 本机已占 200MB - 4 字节：再落 10 字节就越过 200MB 上限
  seedLocalBook(h, { localId: 'lb_big', name: '很大的书', ext: 'pdf', size: 200 * MB - 4 })

  const res = await migrate(page, CLOUD_PDF)

  assert.strictEqual(res.migrated, false)
  assert.strictEqual(res.reason, 'STORAGE_FULL')
  assert.strictEqual(bookFiles(h).length, 1, '只能保留原来那一本')
  assert.deepStrictEqual(tempFiles(h), [])
  assert.ok(h.toastTitles().includes('本机存储空间不足'))
  // 原有条目一字未改
  const idx = parseIndex(h.storage)
  assert.strictEqual(idx.books.length, 1)
  assert.strictEqual(idx.books[0].localId, 'lb_big')
  assert.strictEqual(idx.books[0].migratedFrom, null)
})

test('MIGRATE_REJECTS_EMPTY_DOWNLOAD', async t => {
  const h = harness(t, { downloadSize: 0 })
  const page = h.load()

  const res = await migrate(page, CLOUD_PDF)

  assert.strictEqual(res.migrated, false)
  assert.strictEqual(res.reason, 'EMPTY_FILE')
  assert.strictEqual(bookFiles(h).length, 0)
  assert.deepStrictEqual(tempFiles(h), [])
})

test('MIGRATE_REJECTS_DUPLICATE_NAME_AND_SIZE', async t => {
  const bytes = Buffer.from('same bytes', 'utf8')
  const h = harness(t, { downloadBytes: bytes })
  const page = h.load()
  seedLocalBook(h, { localId: 'lb_same', name: '云端的书', ext: 'pdf', bytes })

  const res = await migrate(page, CLOUD_PDF)

  assert.strictEqual(res.migrated, false)
  assert.strictEqual(res.reason, 'DUPLICATE')
  assert.strictEqual(bookFiles(h).length, 1, '不得改名重复落盘')
  assert.deepStrictEqual(tempFiles(h), [])
  assert.ok(h.toastTitles().includes('本机已有同名文件，无需重复保存'))
})

test('MIGRATE_IS_LOCKED_WHEN_LOCAL_INDEX_IS_CORRUPT', async t => {
  const h = harness(t, { downloadBytes: Buffer.from('x', 'utf8') })
  const page = h.load()
  h.storage.write(lb.STORAGE_KEY, '{not json')

  const res = await migrate(page, CLOUD_PDF)

  assert.strictEqual(res.migrated, false)
  assert.strictEqual(res.reason, 'INDEX_CORRUPT_LOCKED')
  assert.strictEqual(bookFiles(h).length, 0)
  assert.deepStrictEqual(tempFiles(h), [])
  assert.strictEqual(h.storage.read(lb.STORAGE_KEY), '{not json', '损坏索引绝不被覆盖')
  assert.ok(h.toastTitles().includes('本机书单异常，已暂停保存'))
})

// ---------------- 5. 「已存到本机」标记 ----------------

test('APPLY_CLOUD_MIGRATION_FLAGS_MARKS_ROWS_FROM_LOCAL_INDEX', async t => {
  const h = harness(t, {
    cloudBooks: [
      Object.assign({}, CLOUD_PDF),
      { _id: 'cloud_book_9', name: '另一本', ext: 'pdf', fileID: 'cloud://env.bucket/9.pdf' },
      { _id: 'cloud_manual_1', name: '手动书单' }
    ]
  })
  const page = h.load()

  // 先造一条已迁移的本机记录，再让云端列表落地
  seedLocalBook(h, {
    localId: 'lb_done',
    name: '云端的书',
    ext: 'pdf',
    bytes: Buffer.from('x', 'utf8'),
    extra: { migratedFrom: 'cloud_book_1' }
  })

  await page.loadBooks()
  await flush()
  await page.loadLocalBooks()

  const rows = page.data.books
  assert.strictEqual(rows.length, 3)
  assert.strictEqual(rows.find(b => b._id === 'cloud_book_1').migratedLocalId, 'lb_done')
  assert.strictEqual(rows.find(b => b._id === 'cloud_book_9').migratedLocalId, null)
  assert.strictEqual(rows.find(b => b._id === 'cloud_manual_1').migratedLocalId, null)
  // 该标记纯由本机索引推导 → 不得回头写云端
  assert.deepStrictEqual(h.calls.booksUpdate, [])
})

test('MIGRATE_REFRESHES_LIST_AND_WXML_CAN_RENDER_DONE_STATE', async t => {
  const h = harness(t, { downloadBytes: Buffer.from('x', 'utf8') })
  const page = h.load()

  const res = await migrate(page, CLOUD_PDF)
  assert.strictEqual(page.data.localBooks.length, 1)
  assert.strictEqual(page.data.localBooks[0].migratedFrom, 'cloud_book_1')
  assert.strictEqual(res.localId, page.data.localBooks[0].localId)
})

// ---------------- 6. 与本机导入互不干扰 ----------------

test('MIGRATE_DOES_NOT_TOUCH_EXISTING_LOCAL_BOOKS', async t => {
  const h = harness(t, { downloadBytes: Buffer.from('cloud bytes', 'utf8') })
  const page = h.load()
  const keep = seedLocalBook(h, {
    localId: 'lb_keep',
    name: '我自己的书',
    ext: 'txt',
    bytes: Buffer.from('我的内容', 'utf8'),
    extra: { minutes: 12, progressPercent: 30 }
  })
  const before = parseIndex(h.storage).books.find(b => b.localId === keep.localId)

  await migrate(page, CLOUD_PDF)

  const after = parseIndex(h.storage).books.find(b => b.localId === keep.localId)
  assert.deepStrictEqual(after, before, '迁移不得改动任何已有本机条目')
  assert.strictEqual(parseIndex(h.storage).books.length, 2)
})
