// ============================================================
// tests/reading-local-import.test.js · S2 本机导入的真实行为测试
//
// 这些用例真实 require 并执行 pages/reading/reading.js，
// 通过注入的 wx 替身在 Node 下跑完整导入链路（chooseMessageFile →
// utils/localBooks.importFile → 落盘 → 元数据 → 页面回填），
// 而不是只做源码字符串断言。
// ============================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const lb = require('../utils/localBooks')
const { createReadingHarness } = require('./reading-page-harness')

const read = p => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8')

function harness(t, options) {
  const h = createReadingHarness(options)
  t.after(() => h.dispose())
  return h
}

function parseIndex(storage) {
  const raw = storage.read(lb.STORAGE_KEY)
  return raw ? JSON.parse(raw) : null
}

function booksDirFiles(h) {
  return h.fs.listFiles().filter(p => p.indexOf('/books/') !== -1)
}

function flush() {
  return new Promise(resolve => setImmediate(resolve))
}

// ---------------- 导入成功 ----------------

test('PAGE_IMPORT_PDF_TO_LOCAL_AND_LISTED', async t => {
  const h = harness(t)
  const page = h.load()
  h.ctx.pushFile(h.seedTempFile('人类简史.pdf', 2048))

  await page.importBook()

  assert.strictEqual(h.calls.chooseMessageFile, 1)
  assert.strictEqual(h.calls.uploadFile, 0, '不得上传云存储')
  assert.strictEqual(h.calls.booksAdd, 0, '不得写 books 集合')
  assert.strictEqual(page.data.localBooks.length, 1)

  const b = page.data.localBooks[0]
  assert.strictEqual(b.name, '人类简史')
  assert.strictEqual(b.ext, 'pdf')
  assert.strictEqual(b.source, 'local')
  assert.strictEqual(b.missing, false)
  assert.ok(b.fileName.endsWith('.pdf'))
  assert.ok(h.fs.hasFile(h.fs.userDataPath + '/books/' + b.fileName), '文件必须落在本机 books 目录')
  assert.strictEqual(h.fs.sizeOf(h.fs.userDataPath + '/books/' + b.fileName), 2048)

  assert.strictEqual(parseIndex(h.storage).books.length, 1)
  assert.strictEqual(h.lastToast().title, '已存到本机书架')
  assert.strictEqual(page.data.uploading, false)
})

test('PAGE_IMPORT_TXT_TO_LOCAL', async t => {
  const h = harness(t)
  const page = h.load()
  h.ctx.pushFile(h.seedTempFile('随笔.txt', 512))

  await page.importBook()

  assert.strictEqual(page.data.localBooks.length, 1)
  assert.strictEqual(page.data.localBooks[0].ext, 'txt')
  assert.ok(page.data.localBooks[0].fileName.endsWith('.txt'))
  assert.strictEqual(h.calls.uploadFile, 0)
  assert.strictEqual(h.calls.booksAdd, 0)
})

test('PAGE_SHOWS_LOCAL_CAPACITY', async t => {
  const h = harness(t)
  const page = h.load()
  h.ctx.pushFile(h.seedTempFile('容量.pdf', 3 * 1024 * 1024))

  await page.importBook()

  assert.match(page.data.localUsageText, /1 个文件/)
  assert.match(page.data.localUsageText, /3\.0 MB/)
  assert.match(page.data.localUsageText, /200\.0 MB/)
  assert.ok(page.data.localUsagePercent > 0)
  assert.strictEqual(page.data.localUsageWarning, false)
})

// ---------------- 导入失败必须失败 ----------------

test('PAGE_REJECTS_UNSUPPORTED_TYPE_WITHOUT_SUCCESS_TOAST', async t => {
  const h = harness(t)
  const page = h.load()
  h.ctx.pushFile(h.seedTempFile('笔记.docx', 100))

  await page.importBook()

  assert.deepStrictEqual(page.data.localBooks, [])
  assert.strictEqual(h.lastToast().title, '只支持 PDF / TXT 文件')
  assert.strictEqual(h.toastTitles().includes('已存到本机书架'), false)
  assert.strictEqual(page.data.uploading, false)
  assert.strictEqual(h.calls.uploadFile, 0)
  assert.strictEqual(h.calls.booksAdd, 0)
  assert.strictEqual(booksDirFiles(h).length, 0)
})

test('PAGE_HANDLES_CHOOSE_CANCEL_WITHOUT_SUCCESS_TOAST', async t => {
  const h = harness(t)
  const page = h.load()
  h.ctx.failChoose(true)

  await page.importBook()

  assert.strictEqual(h.lastToast().title, '导入失败，请重试')
  assert.strictEqual(h.toastTitles().includes('已存到本机书架'), false)
  assert.deepStrictEqual(page.data.localBooks, [])
})

test('PAGE_HANDLES_EMPTY_SELECTION', async t => {
  const h = harness(t)
  const page = h.load()
  // 未 push 任何文件 → tempFiles 为空
  await page.importBook()
  assert.strictEqual(h.lastToast().title, '没有选中文件')
  assert.strictEqual(h.toastTitles().includes('已存到本机书架'), false)
})

test('PAGE_IMPORT_LOCAL_WRITE_FAILURE_ROLLS_BACK', async t => {
  const h = harness(t)
  const page = h.load()
  h.ctx.pushFile(h.seedTempFile('rollback.pdf', 2048))
  h.storage.failWriteFor(lb.STORAGE_KEY)

  await page.importBook()

  assert.strictEqual(h.calls.uploadFile, 0)
  assert.strictEqual(h.calls.booksAdd, 0)
  assert.strictEqual(page.data.localBooks.length, 0)
  assert.strictEqual(parseIndex(h.storage), null, '元数据写失败不得留下半成品')
  assert.strictEqual(booksDirFiles(h).length, 0, '元数据写失败必须回滚已落盘文件')
  assert.strictEqual(page.data.uploading, false)
  assert.strictEqual(h.toastTitles().includes('已存到本机书架'), false)
})

test('PAGE_REJECTS_IMPORT_WHEN_LOCAL_STORAGE_FULL', async t => {
  const seed = {
    version: 1,
    updatedAt: 0,
    books: [{ localId: 'lb_big', name: 'big', ext: 'pdf', fileName: 'lb_big.pdf', size: 199 * 1024 * 1024, createdAt: 1 }]
  }
  const h = harness(t, { storage: { [lb.STORAGE_KEY]: JSON.stringify(seed) } })
  const page = h.load()
  await page.loadLocalBooks()

  h.ctx.pushFile(h.seedTempFile('more.pdf', 2 * 1024 * 1024))
  await page.importBook()

  assert.strictEqual(h.lastToast().title, '本机存储空间不足')
  assert.strictEqual(page.data.localBooks.length, 1, '容量不足不得新增记录')
  assert.strictEqual(h.calls.uploadFile, 0)
  assert.strictEqual(booksDirFiles(h).length, 0)
})

// ---------------- 重复导入 ----------------

test('PAGE_DUPLICATE_IMPORT_ASKS_THEN_REPLACES_KEEPING_PROGRESS', async t => {
  const h = harness(t)
  const page = h.load()
  h.ctx.pushFile(h.seedTempFile('dup.pdf', 1500))
  await page.importBook()
  const firstId = page.data.localBooks[0].localId

  const repo = lb.getLocalBooks()
  await repo.addMinutes(firstId, 30)

  h.ctx.pushFile(h.seedTempFile('dup.pdf', 1500))
  await page.importBook()

  assert.strictEqual(h.modals.length, 1, '必须先二次确认')
  assert.strictEqual(page.data.localBooks.length, 1)
  assert.strictEqual(page.data.localBooks[0].localId, firstId)
  assert.strictEqual(page.data.localBooks[0].minutes, 30, '替换必须保留阅读进度')
  assert.strictEqual(booksDirFiles(h).length, 1, '替换后不得残留旧文件')
  assert.strictEqual(h.calls.uploadFile, 0)
  assert.strictEqual(h.calls.booksAdd, 0)
})

test('PAGE_DUPLICATE_IMPORT_CANCELLED_CHANGES_NOTHING', async t => {
  const h = harness(t, { modalConfirm: false })
  const page = h.load()
  h.ctx.pushFile(h.seedTempFile('keep.pdf', 800))
  await page.importBook()
  const before = JSON.parse(JSON.stringify(page.data.localBooks[0]))
  const toastMark = h.toasts.length

  h.ctx.pushFile(h.seedTempFile('keep.pdf', 800))
  await page.importBook()

  assert.strictEqual(h.modals.length, 1)
  assert.strictEqual(page.data.localBooks.length, 1)
  assert.strictEqual(page.data.localBooks[0].localId, before.localId)
  assert.strictEqual(page.data.localBooks[0].size, before.size)
  const afterToasts = h.toasts.slice(toastMark).map(x => x.title)
  assert.strictEqual(afterToasts.includes('已存到本机书架'), false, '取消替换不得显示成功提示')
  assert.strictEqual(page.data.uploading, false)
})

// ---------------- 重新进入页面 ----------------

test('PAGE_RELOAD_RESTORES_LOCAL_BOOKS', async t => {
  const h = harness(t)
  const page1 = h.load()
  h.ctx.pushFile(h.seedTempFile('persist.pdf', 4096))
  await page1.importBook()
  const id = page1.data.localBooks[0].localId

  const page2 = h.reload()
  await page2.loadLocalBooks()

  assert.strictEqual(page2.data.localBooks.length, 1, '重新进入页面记录必须仍在')
  assert.strictEqual(page2.data.localBooks[0].localId, id)
  assert.strictEqual(page2.data.localBooks[0].name, 'persist')
  assert.strictEqual(page2.data.localBooks[0].missing, false)
  assert.strictEqual(page2.data.localBooks[0].localHint, '本机文件 · 点击打开')
  assert.strictEqual(h.calls.uploadFile, 0)
})

test('PAGE_SHOWS_LOCAL_AND_LEGACY_CLOUD_TOGETHER', async t => {
  const cloudBooks = [
    { _id: 'c1', name: '云端旧书', fileID: 'cloud://old', ext: 'pdf', coverColor: '#FFC9D4', createdAt: 1, minutes: 5, totalMin: 10 }
  ]
  const h = harness(t, { cloudBooks })
  const page = h.load()
  h.ctx.pushFile(h.seedTempFile('local.pdf', 1024))

  await page.importBook()
  await page.loadBooks()

  assert.strictEqual(page.data.localBooks.length, 1, '本机记录必须显示')
  assert.strictEqual(page.data.books.length, 1, '旧云端书籍必须继续显示')
  assert.strictEqual(page.data.books[0]._id, 'c1')
  assert.strictEqual(page.data.books[0].pct, 50)
  assert.strictEqual(h.calls.booksQuery, 1)
  assert.strictEqual(h.calls.booksAdd, 0, '读云端可以，写云端不行')
})

// ---------------- 异常恢复 ----------------

test('PAGE_SURFACES_CORRUPT_LOCAL_INDEX_WITHOUT_SUCCESS', async t => {
  const h = harness(t, { storage: { [lb.STORAGE_KEY]: '{not json' } })
  const page = h.load()
  await page.loadLocalBooks()
  assert.strictEqual(page.data.localIndexCorrupted, true)
  assert.strictEqual(page.data.localBooks.length, 0)

  h.ctx.pushFile(h.seedTempFile('x.pdf', 512))
  await page.importBook()

  assert.strictEqual(h.lastToast().title, '本机书单异常，请勿清理小程序数据')
  assert.strictEqual(h.toastTitles().includes('已存到本机书架'), false)
  assert.strictEqual(h.storage.read(lb.STORAGE_KEY), '{not json', '损坏索引不得被覆盖')
  assert.strictEqual(booksDirFiles(h).length, 0, '损坏索引下不得落盘')
})

test('PAGE_LOAD_FLUSHES_PENDING_MINUTES_WITHOUT_DOUBLE_COUNT', async t => {
  const h = harness(t)
  const page = h.load()
  h.ctx.pushFile(h.seedTempFile('pending.pdf', 1024))
  await page.importBook()
  const id = page.data.localBooks[0].localId

  const repo = lb.getLocalBooks()
  h.storage.failWriteFor(lb.STORAGE_KEY)
  const buffered = await repo.addMinutes(id, 12)
  assert.strictEqual(buffered.buffered, true, '增量必须进待补写键，不得静默丢失')
  h.storage.allowWriteFor(lb.STORAGE_KEY)

  const page2 = h.reload()
  await page2.loadLocalBooks()
  assert.strictEqual(page2.data.localBooks[0].minutes, 12, '重新进入页面必须补写回来')
  assert.deepStrictEqual(JSON.parse(h.storage.read(lb.PENDING_KEY) || '{}'), {}, '补写后必须清空待补写键')

  const page3 = h.reload()
  await page3.loadLocalBooks()
  assert.strictEqual(page3.data.localBooks[0].minutes, 12, '再次进入不得重复累计')
})

// ---------------- S3 边界：本地 PDF 走本机路径，且绝不回落云端 ----------------

test('OPEN_LOCAL_BOOK_NEVER_FALLS_BACK_TO_CLOUD', async t => {
  const h = harness(t)
  const page = h.load()
  h.ctx.pushFile(h.seedTempFile('open.pdf', 1024))
  await page.importBook()
  const localId = page.data.localBooks[0].localId

  await page.openLocalBook({ currentTarget: { dataset: { id: localId } } })
  await flush()

  assert.strictEqual(h.calls.getTempFileURL, 0, '不得回落 getTempFileURL')
  assert.strictEqual(h.calls.downloadFile, 0, '不得回落 downloadFile')
  assert.strictEqual(h.calls.openDocument, 1, '本地 PDF 必须真正打开')
  assert.strictEqual(
    h.calls.openDocumentData[0].filePath,
    h.fs.userDataPath + '/books/' + page.data.localBooks[0].fileName
  )
  assert.strictEqual(h.calls.openDocumentData[0].fileType, 'pdf')
  assert.strictEqual(h.toastTitles().some(x => /失败|损坏/.test(String(x))), false, '不得误报失败或损坏')
})

test('OPEN_LOCAL_BOOK_WITHOUT_ID_REFUSES_WITHOUT_CLOUD', async t => {
  const h = harness(t)
  const page = h.load()
  h.ctx.pushFile(h.seedTempFile('noid.pdf', 1024))
  await page.importBook()

  const res = await page.openLocalBook()
  await flush()

  assert.strictEqual(res.opened, false)
  assert.strictEqual(res.reason, 'NO_LOCAL_ID')
  assert.strictEqual(h.calls.openDocument, 0)
  assert.strictEqual(h.calls.getTempFileURL, 0)
  assert.strictEqual(h.calls.downloadFile, 0)
})

test('OPEN_CLOUD_BOOK_STILL_WORKS_UNCHANGED', async t => {
  const h = harness(t)
  const page = h.load()
  const cloudBook = { _id: 'c9', name: '云书', fileID: 'cloud://x', ext: 'pdf' }

  page.openBook({ currentTarget: { dataset: { b: cloudBook } } })
  await flush()
  await flush()

  assert.strictEqual(h.calls.getTempFileURL, 1, '云端书仍走云端打开链路')
  assert.strictEqual(h.calls.downloadFile, 1)
  assert.strictEqual(h.calls.openDocument, 1)
  assert.strictEqual(page._bookId, 'c9')
})

// ---------------- 界面必须明确区分本机来源 ----------------

test('WXML_SHOWS_LOCAL_SOURCE_CAPACITY_AND_LOSS_NOTICE', () => {
  const wxml = read('pages/reading/reading.wxml')
  assert.match(wxml, /导入 PDF \/ TXT 到本机/)
  assert.match(wxml, /本机文件 \{\{localUsageText\}\}/)
  assert.match(wxml, /localUsagePercent/)
  assert.match(wxml, /清理小程序数据或换机后会丢失/)
  assert.match(wxml, /bindtap="openLocalBook"/)
  assert.match(wxml, /data-id="\{\{item\.localId\}\}"/)
  assert.match(wxml, /本机/)
  assert.match(wxml, /localIndexCorrupted/)
  // 旧云端记录渲染必须保留
  assert.match(wxml, /旧版文件记录/)
  assert.match(wxml, /bindtap="openBook"/)
  assert.match(wxml, /importBook/)
})
