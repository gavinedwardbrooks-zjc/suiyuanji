// ============================================================
// tests/reading-progress.test.js · 阅读进度 / 位置 / 有界兜底
//
// 契约（用户明确要求）：
//   - TXT 能保存并恢复上次阅读位置
//   - PDF 若无法可靠取得原生阅读器页码 → **绝不伪造阅读百分比**
//   - 本地进度显示与实际数据含义一致（PDF 只显示分钟，TXT 才显示百分比）
//   - 真机 API 不支持分段读取时要有**有界**的安全替代方案
//
// 本文件真实执行 pages/reading-txt/reading-txt.js、pages/reading/reading.js、
// utils/txtReader.js、utils/localBooks.js。
// ============================================================
const test = require('node:test')
const assert = require('node:assert/strict')

const lb = require('../utils/localBooks')
const pos = require('../utils/readingPositions')
const { createTxtHarness, createReadingHarness } = require('./reading-page-harness')

const MB = 1024 * 1024

function txtHarness(t, options) {
  const h = createTxtHarness(options)
  t.after(() => h.dispose())
  return h
}

function readingHarness(t, options) {
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

function readPos(h, localId) {
  return pos.createPositionStore({
    read: k => h.storage.read(k),
    write: (k, v) => h.storage.write(k, v)
  }).get(localId)
}

function writePos(h, localId, value) {
  pos.createPositionStore({
    read: k => h.storage.read(k),
    write: (k, v) => h.storage.write(k, v)
  }).set(localId, value)
}

function flush(times) {
  const n = times || 10
  let p = Promise.resolve()
  for (let i = 0; i < n; i++) p = p.then(() => new Promise(r => setImmediate(r)))
  return p
}

// 造一本多页 TXT：每页 8KB，故意用中文让页边界落在多字节字符中间
function seedMultiPageTxt(h, opts) {
  const o = opts || {}
  const pages = o.pages || 3
  const pageBytes = 8 * 1024
  const chunk = o.chunk || ('这是一段用于验证分页的中文文本。'.repeat(400)) // 约 5.6KB
  let text = ''
  while (Buffer.byteLength(text, 'utf8') < pages * pageBytes) text += chunk + '\n'
  return h.seedLocalBook({ localId: o.localId || 'lb_txt', name: '长篇.txt', ext: 'txt', text })
}

// ---------------- 1. 位置保存 ----------------

test('TXT_POSITION_IS_SAVED_ON_EVERY_PAGE_TURN', async t => {
  const h = txtHarness(t)
  const seed = seedMultiPageTxt(h, { pages: 3 })
  const page = h.open({ localId: seed.localId })
  await page.__openResult
  await flush()

  assert.strictEqual(page.data.mode, 'reader')
  const count = page.data.pageCount
  assert.ok(count >= 3, '必须真的有多页，否则这条测试没有意义')

  const p0 = readPos(h, seed.localId)
  assert.ok(p0, '第一页渲染后必须已保存位置')
  assert.strictEqual(p0.page, 0)
  assert.strictEqual(p0.pageCount, count)

  await page.nextPage()
  const p1 = readPos(h, seed.localId)
  assert.strictEqual(p1.page, 1, '翻页必须更新位置')
  assert.strictEqual(p1.pageCount, count)
})

test('TXT_POSITION_IS_RESTORED_ON_REOPEN', async t => {
  const h = txtHarness(t)
  const seed = seedMultiPageTxt(h, { pages: 4 })
  const first = h.open({ localId: seed.localId })
  await first.__openResult
  await first.nextPage()
  await first.nextPage()
  const saved = readPos(h, seed.localId)
  assert.strictEqual(saved.page, 2)

  // 「离开 → 重新进入」
  const second = h.open({ localId: seed.localId })
  const res = await second.__openResult
  await flush()

  assert.strictEqual(second.data.mode, 'reader')
  assert.strictEqual(second.data.pageIndex, 2, '必须回到上次读到的页')
  assert.strictEqual(second.data.restored, true)
  assert.strictEqual(res.ok, true)
  assert.strictEqual(readPos(h, seed.localId).page, 2, '恢复后位置保持')
})

test('TXT_RESUMED_HINT_IS_RENDERED_IN_WXML', () => {
  const fsSync = require('node:fs')
  const pathMod = require('node:path')
  const wxml = fsSync.readFileSync(pathMod.join(__dirname, '..', 'pages', 'reading-txt', 'reading-txt.wxml'), 'utf8')
  assert.match(wxml, /wx:if="\{\{restored\}\}"/)
  assert.match(wxml, /已回到上次读到的位置/)
})

test('TXT_STALE_POSITION_IS_DROPPED_WHEN_PAGE_COUNT_CHANGES', async t => {
  const h = txtHarness(t)
  const seed = seedMultiPageTxt(h, { pages: 3 })
  const page = h.open({ localId: seed.localId })
  await page.__openResult
  const count = page.data.pageCount

  // 文件被替换（页数变了）→ 旧位置必须丢弃，绝不跳到不存在的位置
  writePos(h, seed.localId, { page: 2, pageCount: count + 7 })

  const again = h.open({ localId: seed.localId })
  await again.__openResult
  await flush()

  assert.strictEqual(again.data.pageIndex, 0, '页数不一致时从第一页开始')
  assert.strictEqual(again.data.restored, false)
  assert.ok(
    h.warns.some(a => String(a[0]).indexOf('TXT_POSITION_STALE_DROPPED') !== -1),
    '丢弃陈旧位置必须有明确日志'
  )
})

test('TXT_POSITION_IS_CLAMPED_INTO_RANGE', async t => {
  const h = txtHarness(t)
  const seed = seedMultiPageTxt(h, { pages: 2 })
  const page = h.open({ localId: seed.localId })
  await page.__openResult
  const count = page.data.pageCount

  writePos(h, seed.localId, { page: 9999, pageCount: count })
  const again = h.open({ localId: seed.localId })
  await again.__openResult

  assert.strictEqual(again.data.pageIndex, count - 1, '越界位置必须夹紧到最后一页，而不是报错或空白')
})

test('TXT_POSITION_ZERO_IS_NOT_TREATED_AS_RESUME', async t => {
  const h = txtHarness(t)
  const seed = seedMultiPageTxt(h, { pages: 2 })
  writePos(h, seed.localId, { page: 0, pageCount: 0 })
  const page = h.open({ localId: seed.localId })
  await page.__openResult

  assert.strictEqual(page.data.pageIndex, 0)
  assert.strictEqual(page.data.restored, false, '第 0 页不算「回到上次位置」')
})

test('TXT_POSITION_STORE_IS_BOUNDED', () => {
  const map = {}
  const store = pos.createPositionStore({
    read: k => (map[k] === undefined ? '' : map[k]),
    write: (k, v) => { map[k] = v }
  })
  for (let i = 0; i < 80; i++) store.set('lb_' + i, { page: 1, pageCount: 3 }, 1000 + i)
  const snap = store.snapshot()
  assert.strictEqual(Object.keys(snap).length, pos.MAX_ENTRIES, '位置条目必须有上限')
  assert.ok(snap.lb_79, '保留最近使用的')
  assert.strictEqual(snap.lb_0, undefined, '最旧的被淘汰')
})

test('TXT_POSITION_STORE_WRITE_FAILURE_DOES_NOT_BLOCK_READING', async t => {
  const h = txtHarness(t)
  const seed = seedMultiPageTxt(h, { pages: 2 })
  h.storage.failWriteFor(pos.POSITIONS_KEY)

  const page = h.open({ localId: seed.localId })
  await page.__openResult
  await flush()

  assert.strictEqual(page.data.mode, 'reader', '位置写失败绝不能阻断阅读')
  assert.ok(h.warns.some(a => String(a[0]).indexOf('TXT_POSITION_SAVE_FAILED') !== -1))
})

// ---------------- 2. progressPercent 真实同步 ----------------

test('TXT_PROGRESS_PERCENT_MATCHES_THE_REAL_PAGE', async t => {
  const h = txtHarness(t)
  const seed = seedMultiPageTxt(h, { pages: 4 })
  const page = h.open({ localId: seed.localId })
  await page.__openResult
  await flush()
  const count = page.data.pageCount

  const expect = i => Math.max(0, Math.min(100, Math.round(((i + 1) / count) * 100)))
  assert.strictEqual(entryOf(h, seed.localId).progressPercent, expect(0), '首屏进度必须等于真实页位')

  await page.nextPage()
  await flush()
  assert.strictEqual(entryOf(h, seed.localId).progressPercent, expect(1))

  await page.nextPage()
  await flush()
  assert.strictEqual(entryOf(h, seed.localId).progressPercent, expect(2))
})

test('TXT_PROGRESS_PERCENT_IS_SYNCED_BY_JUMP', async t => {
  const h = txtHarness(t)
  const seed = seedMultiPageTxt(h, { pages: 5 })
  const page = h.open({ localId: seed.localId })
  await page.__openResult
  await flush()
  const count = page.data.pageCount

  page.setData({ jumpValue: String(count) })
  await page.jumpToPage()
  await flush()

  assert.strictEqual(page.data.pageIndex, count - 1)
  assert.strictEqual(entryOf(h, seed.localId).progressPercent, 100, '最后一页必须真的是 100%')
})

test('TXT_PROGRESS_PERCENT_UNCHANGED_PAGE_IS_NOT_REWRITTEN', async t => {
  const h = txtHarness(t)
  const seed = seedMultiPageTxt(h, { pages: 3 })
  const page = h.open({ localId: seed.localId })
  await page.__openResult
  await flush()

  const before = entryOf(h, seed.localId).updatedAt
  // 再读同一页：进度没变化 → 不应重复写索引
  await page.readPage(page.data.pageIndex)
  await flush()
  assert.strictEqual(entryOf(h, seed.localId).updatedAt, before, '进度未变化时不得重复写索引')
})

// ---------------- 3. PDF 绝不伪造百分比 ----------------

test('PDF_LOCAL_META_HAS_NO_PERCENT', async t => {
  const h = readingHarness(t)
  const page = h.load()
  h.ctx.pushFile(h.seedTempFile('paper.pdf', 4096))
  await page.importBook()
  await page.loadLocalBooks()

  const row = page.data.localBooks[0]
  assert.strictEqual(row.ext, 'pdf')
  assert.doesNotMatch(row.localMeta, /进度/, 'PDF 拿不到原生阅读器页码 → 绝不显示进度百分比')
  assert.match(row.localMeta, /还没开始读/)
})

test('PDF_IGNORES_STORED_PERCENT_EVEN_IF_PRESENT', async t => {
  const h = readingHarness(t)
  const page = h.load()
  h.ctx.pushFile(h.seedTempFile('paper2.pdf', 4096))
  await page.importBook()

  // 人为在索引里塞一个百分比：界面层依然不得为 PDF 展示它
  const idx = parseIndex(h.storage)
  idx.books[0].progressPercent = 55
  h.storage.write(lb.STORAGE_KEY, JSON.stringify(idx))
  await page.loadLocalBooks()

  const row = page.data.localBooks[0]
  assert.doesNotMatch(row.localMeta, /55/)
  assert.doesNotMatch(row.localMeta, /进度/)
})

test('TXT_LOCAL_META_SHOWS_REAL_PERCENT_ONLY_WHEN_POSITIVE', async t => {
  const h = readingHarness(t)
  const page = h.load()
  h.ctx.pushFile(h.seedTempFile('novel.txt', 4096))
  await page.importBook()

  await page.loadLocalBooks()
  assert.doesNotMatch(page.data.localBooks[0].localMeta, /进度/, '0% 时不显示进度')

  const idx = parseIndex(h.storage)
  idx.books[0].progressPercent = 40
  idx.books[0].minutes = 12
  h.storage.write(lb.STORAGE_KEY, JSON.stringify(idx))
  await page.loadLocalBooks()

  const meta = page.data.localBooks[0].localMeta
  assert.match(meta, /已读 12 分钟/)
  assert.match(meta, /进度 40%/, 'TXT 有可靠页数 → 显示真实进度')
})

test('MISSING_LOCAL_BOOK_HINT_REPLACES_PROGRESS', async t => {
  const h = readingHarness(t)
  const page = h.load()
  h.ctx.pushFile(h.seedTempFile('gone.pdf', 1024))
  await page.importBook()
  const localId = page.data.localBooks[0].localId

  // 文件被系统清掉
  const idx = parseIndex(h.storage)
  h.fs.deleteFileRaw(idx.books[0].filePath)
  await page.loadLocalBooks()

  const row = page.data.localBooks.find(b => b.localId === localId)
  assert.strictEqual(row.missing, true)
  assert.match(row.localMeta, /文件已丢失/)
  assert.doesNotMatch(row.localMeta, /进度/, '文件丢失时不得再展示进度')
})

// ---------------- 4. 有界兜底（真机不支持分段读取） ----------------

test('READ_WHOLE_TEXT_ACCEPTS_SMALL_FILE', async t => {
  const h = readingHarness(t)
  h.load() // 绑定 wx 替身（本用例直接使用仓库接口，不需要页面链路）
  const text = '小小的文本 🎉\n第二行'
  const path = h.fs.userDataPath + '/books/small.txt'
  h.fs.seedFileBytes(path, Buffer.from(text, 'utf8'))
  const idx = {
    version: 1,
    updatedAt: 0,
    pendingApplied: {},
    books: [lb.normalizeEntry({
      localId: 'lb_small', name: '小.txt', ext: 'txt', fileName: 'small.txt',
      filePath: path, size: Buffer.byteLength(text, 'utf8'), createdAt: 1, updatedAt: 1
    })]
  }
  h.storage.write(lb.STORAGE_KEY, JSON.stringify(idx))

  const res = await lb.getLocalBooks().readWholeText('lb_small')
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.data, text)
})

test('READ_WHOLE_TEXT_REJECTS_OVER_LIMIT_WITHOUT_READING_ANY_BYTE', async t => {
  const h = readingHarness(t)
  h.load()
  const path = h.fs.userDataPath + '/books/huge.txt'
  h.fs.seedFile(path, lb.MAX_WHOLE_READ_BYTES + 1)
  const idx = {
    version: 1,
    updatedAt: 0,
    pendingApplied: {},
    books: [lb.normalizeEntry({
      localId: 'lb_huge', name: '大.txt', ext: 'txt', fileName: 'huge.txt',
      filePath: path, size: lb.MAX_WHOLE_READ_BYTES + 1, createdAt: 1, updatedAt: 1
    })]
  }
  h.storage.write(lb.STORAGE_KEY, JSON.stringify(idx))

  const before = h.calls.readFile
  const res = await lb.getLocalBooks().readWholeText('lb_huge')

  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.reason, 'READ_TOO_LARGE')
  assert.strictEqual(res.maxBytes, lb.MAX_WHOLE_READ_BYTES)
  assert.strictEqual(h.calls.readFile, before, '超限必须在不读一个字节的前提下被拒绝')
})

test('READ_WHOLE_TEXT_REPORTS_MISSING_AND_UNKNOWN_ID', async t => {
  const h = readingHarness(t)
  h.load()
  const repo = lb.getLocalBooks()

  const notFound = await repo.readWholeText('lb_nope')
  assert.strictEqual(notFound.ok, false)
  assert.strictEqual(notFound.reason, 'NOT_FOUND')
})

test('TXT_READER_FALLS_BACK_TO_BOUNDED_WHOLE_READ', async t => {
  // 真机不支持 position/length 分段读取 → 必须仍然能读，且有界
  const h = txtHarness(t, { rangeReadFails: true })
  const text = '兜底读取的第一页内容。'.repeat(60)
  const seed = h.seedLocalBook({ localId: 'lb_fb', name: '兜底.txt', ext: 'txt', text })

  const page = h.open({ localId: seed.localId })
  await page.__openResult
  await flush()

  assert.strictEqual(page.data.mode, 'reader', '分段读取不可用时必须能兜底，而不是直接失败')
  assert.strictEqual(page.data.pageIndex, 0)
  assert.ok(page.data.pageText.length > 0)
  assert.ok(page.data.pageText.indexOf('兜底读取的第一页内容') === 0, '兜底后内容必须从头开始，不丢字')
  assert.strictEqual(page._reader.usingFallback, true)
  assert.strictEqual(page._reader.fallbackOutcome, 'engaged')
  assert.ok(h.warns.some(a => String(a[0]).indexOf('READ_FALLBACK_ENGAGED') !== -1))
})

test('TXT_READER_WHOLE_READ_FALLBACK_IS_BOUNDED_BY_SIZE', async t => {
  // 文件 > 2MB（超过整读上限）→ 明确报「不支持」，绝不让整个文件进内存
  const h = txtHarness(t, { rangeReadFails: true })
  const seed = h.seedLocalBook({
    localId: 'lb_toobig',
    name: '太大.txt',
    ext: 'txt',
    size: lb.MAX_WHOLE_READ_BYTES + 1
  })

  const page = h.open({ localId: seed.localId })
  await page.__openResult
  await flush()

  assert.strictEqual(page.data.mode, 'error')
  assert.strictEqual(page.data.errorCode, 'READ_UNSUPPORTED')
  assert.match(page.data.errorText, /不支持分段读取/)
  assert.strictEqual(page._reader.usingFallback, false)
  assert.strictEqual(page._reader.fallbackOutcome, 'too_large')
  assert.ok(h.warns.some(a => String(a[0]).indexOf('READ_FALLBACK_TOO_LARGE') !== -1))
})

test('TXT_READER_NEVER_FALLS_BACK_FOR_MISSING_FILE', async t => {
  const h = txtHarness(t)
  const seed = h.seedLocalBook({
    localId: 'lb_miss',
    name: '丢了.txt',
    ext: 'txt',
    text: '内容'
  })
  h.fs.deleteFileRaw(seed.path)

  const page = h.open({ localId: seed.localId })
  await page.__openResult
  await flush()

  assert.strictEqual(page.data.mode, 'error')
  assert.strictEqual(page.data.errorCode, 'FILE_MISSING')
  assert.strictEqual(page._reader, null, '文件不存在时连读取器都不应该建立')
  assert.strictEqual(entryOf(h, seed.localId).missing, true, '只标丢失，绝不删记录')
  assert.ok(h.fs.hasFile(seed.path) === false)
})

test('TXT_READER_FALLBACK_IS_LAZY_AND_ONLY_ONCE', async t => {
  const h = txtHarness(t, { rangeReadFails: true })
  const text = '只整读一次。'.repeat(200)
  const seed = h.seedLocalBook({ localId: 'lb_once', name: '一次.txt', ext: 'txt', text })
  const page = h.open({ localId: seed.localId })
  await page.__openResult
  await flush()

  const wholeReads = h.calls.readFileLog.filter(x => x.length === undefined).length
  assert.strictEqual(wholeReads, 1, '整读只允许发生一次，后续翻页必须走内存分页')

  await page.nextPage()
  await flush()
  const after = h.calls.readFileLog.filter(x => x.length === undefined).length
  assert.strictEqual(after, 1, '翻页不得再次整读文件')
})

// ---------------- 5. 分页不丢字 / 不重字 ----------------

test('TXT_PAGES_COVER_THE_WHOLE_FILE_EXACTLY_ONCE', async t => {
  const h = txtHarness(t)
  const seed = seedMultiPageTxt(h, { pages: 3 })
  const page = h.open({ localId: seed.localId })
  await page.__openResult
  await flush()

  const count = page.data.pageCount
  let acc = ''
  for (let i = 0; i < count; i++) {
    const r = await page.readPage(i)
    assert.ok(r && r.ok === true)
    acc += r.text
    await flush(2)
  }

  const whole = await lb.getLocalBooks().readWholeText(seed.localId)
  assert.strictEqual(whole.ok, true)
  assert.strictEqual(acc, whole.data, '逐页拼接必须与原文逐字相等（不丢字、不重字、不乱码）')
  assert.strictEqual(acc.indexOf('\uFFFD'), -1, '对齐正确时不应出现替换字符')
})

test('TXT_BOM_IS_STRIPPED_ONLY_ON_FIRST_PAGE', async t => {
  const h = txtHarness(t)
  const text = '正文开头。'.repeat(700)
  const seed = h.seedLocalBook({
    localId: 'lb_bom',
    name: 'BOM.txt',
    ext: 'txt',
    bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
  })
  const page = h.open({ localId: seed.localId })
  await page.__openResult
  await flush()

  assert.strictEqual(page.data.pageText.charAt(0), '正', '第一页必须去掉 BOM')
  assert.strictEqual(page.data.encodingWarning, false)
})
