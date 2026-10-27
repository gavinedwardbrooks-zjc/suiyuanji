// ============================================================
// tests/reading-cloud-delete.test.js · 旧云端书籍「删除」行为测试
//
// 覆盖（全部真实执行 pages/reading/reading.js，不做源码字符串假验证）：
//   - 旧云端行同时显示「存本机」与「删除」两个按钮，事件互不串联
//   - 删除前必须二次确认（标题/正文/按钮文案），取消 = 零副作用
//   - 只删当前这一条 books 记录：其他书籍、云存储文件、本机副本一律不动
//   - 不写任何其它字段、不碰 daily_records 与待补报队列（分钟不丢）
//   - 删除失败必须显式提示，绝不谎报成功（含「返回成功但没删掉」的替身）
//   - 正在阅读中拒绝删除（避免结算写向已消失的书）
//   - 归属复核：记录属于他人 → 拒绝；查不到记录 → 拒绝
//   - 本机删除功能不回归
// ============================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fsSync = require('node:fs')
const pathMod = require('node:path')

const lb = require('../utils/localBooks')
const dp = require('../utils/readingDailyPending')
const { createReadingHarness } = require('./reading-page-harness')

const READING_SRC = fsSync.readFileSync(
  pathMod.join(__dirname, '..', 'pages', 'reading', 'reading.js'), 'utf8'
)
const READING_WXML = fsSync.readFileSync(
  pathMod.join(__dirname, '..', 'pages', 'reading', 'reading.wxml'), 'utf8'
)
const READING_WXSS = fsSync.readFileSync(
  pathMod.join(__dirname, '..', 'pages', 'reading', 'reading.wxss'), 'utf8'
)

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

function bookDir(h) {
  return h.fs.userDataPath + '/' + lb.SUB_DIR
}

function bookFiles(h) {
  const prefix = bookDir(h) + '/'
  return h.fs.listFiles().filter(p => String(p).indexOf(prefix) === 0)
}

// 造一本「已迁移到本机」的书：索引一条记录 + 磁盘真实字节
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

function tapDelete(page, id) {
  return page.deleteCloudBook({ currentTarget: { dataset: { id } } })
}

function flush(times) {
  const n = times || 10
  let p = Promise.resolve()
  for (let i = 0; i < n; i++) p = p.then(() => new Promise(r => setImmediate(r)))
  return p
}

const CLOUD_A = {
  _id: 'cloud_book_1',
  name: '新概念4 1-24课',
  ext: 'pdf',
  fileID: 'cloud://env.bucket/books/cloud_book_1.pdf',
  minutes: 37,
  progressPercent: 20,
  status: 'reading'
}
const CLOUD_B = {
  _id: 'cloud_book_2',
  name: '另一本云书',
  ext: 'txt',
  fileID: 'cloud://env.bucket/books/cloud_book_2.txt',
  minutes: 5
}
const CLOUD_MANUAL = { _id: 'cloud_manual_1', name: '手动书单', ext: 'pdf' }

function threeBooks() {
  return [
    Object.assign({}, CLOUD_A),
    Object.assign({}, CLOUD_B),
    Object.assign({}, CLOUD_MANUAL)
  ]
}

async function openPage(h) {
  const page = h.load()
  await page.loadBooks()
  await flush()
  return page
}

// ============================================================
// 1. 入口：两个按钮并存、事件互不串联
// ============================================================

test('CLOUD_ROW_SHOWS_BOTH_BUTTONS_WITH_ISOLATED_EVENTS', () => {
  const cloudBlock = READING_WXML.slice(
    READING_WXML.indexOf('wx:for="{{books}}"'),
    READING_WXML.indexOf('writing-section')
  )
  assert.ok(cloudBlock.length > 0, '云端书籍行区块必须存在')

  // 「存本机」：保持原逻辑与原有条件（只有存在云端文件的行才渲染）
  assert.match(cloudBlock, /wx:if="\{\{item\.fileID\}\}"[^>]*class="b-get/)
  assert.match(cloudBlock, /catchtap="migrateCloudBook"/)
  assert.match(cloudBlock, /data-b="\{\{item\}\}"/)

  // 「删除」：独立按钮、独立事件、只带 _id（不带整条记录，避免条件被放大）
  assert.match(cloudBlock, /class="b-remove"[^>]*catchtap="deleteCloudBook"/)
  assert.match(cloudBlock, /catchtap="deleteCloudBook"[^>]*data-id="\{\{item\._id\}\}"/)

  // 两个按钮都必须是 catchtap：点它们不得冒泡到整行 openBook
  const getTag = cloudBlock.match(/<view[^>]*catchtap="migrateCloudBook"[^>]*>/)
  const delTag = cloudBlock.match(/<view[^>]*catchtap="deleteCloudBook"[^>]*>/)
  assert.ok(getTag && delTag, '两个按钮必须都存在')
  assert.doesNotMatch(getTag[0], /bindtap=/)
  assert.doesNotMatch(delTag[0], /bindtap=/)

  // 点击书籍主体仍走打开逻辑
  assert.match(cloudBlock, /bindtap="openBook"/)
  // 云端行不得使用本机删除入口（两条删除链路必须分开）
  assert.doesNotMatch(cloudBlock, /deleteLocalBook/)
  assert.doesNotMatch(cloudBlock, /b-del/)
})

test('CLOUD_DELETE_BUTTON_STYLE_IS_TAP_TARGET_SAFE', () => {
  const block = READING_WXSS.match(/\.b-remove\s*\{[^}]*\}/)
  assert.ok(block, '.b-remove 样式必须存在')
  const css = block[0]
  assert.match(css, /width:\s*88rpx/)
  assert.match(css, /height:\s*88rpx/, '点击区域必须达到 88rpx（44px）')
  assert.match(css, /flex-shrink:\s*0/, '窄屏下按钮不得被压缩变形（防重叠/溢出）')
  assert.match(css, /border-radius:\s*24rpx/)
  assert.match(css, /var\(--notebook-line\)/)
  assert.match(css, /var\(--pink-deep\)/)
})

test('CLOUD_DELETE_SOURCE_USES_ONLY_SCOPED_DOC_REMOVE', () => {
  const from = READING_SRC.indexOf('// ============ S6：旧云端书籍删除 ============')
  const to = READING_SRC.indexOf('// ============ 旧云端书籍：逐本「保存到本机」 ============')
  assert.ok(from > 0 && to > from, '必须能定位云端删除实现')
  const seg = READING_SRC.slice(from, to)
  // 只看真实代码行：注释里出现的 API 名称不算调用
  const code = seg.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

  // 唯一的删除调用点，且必须是 doc(_id).remove()（一次只影响一条文档）
  assert.match(code, /\.doc\(bookId\)\.remove\(\)/)
  assert.strictEqual((code.match(/\.remove\(/g) || []).length, 1, '只允许一个删除调用点')
  // 绝不出现 where(...).remove() 这种「条件删除」写法
  assert.doesNotMatch(code, /\.where\([^)]*\)\s*\.remove\(/)
  // 不碰云存储文件、不写其它字段
  assert.doesNotMatch(code, /deleteFile/)
  assert.doesNotMatch(code, /\.update\(/)
  assert.doesNotMatch(code, /\.add\(/)
  assert.doesNotMatch(code, /uploadFile/)
})

// ============================================================
// 2. 二次确认
// ============================================================

test('CLOUD_DELETE_REQUIRES_CONFIRMATION_WITH_EXACT_COPY', async t => {
  const h = harness(t, { cloudBooks: threeBooks() })
  const page = await openPage(h)

  const res = await tapDelete(page, 'cloud_book_1')
  await flush()

  assert.strictEqual(h.modals.length, 1, '必须先弹二次确认')
  const m = h.modals[0]
  assert.strictEqual(m.title, '删除书籍')
  assert.strictEqual(m.content, '确定将《新概念4 1-24课》从阅读清单中删除吗？此操作无法撤销。')
  assert.strictEqual(m.confirmText, '删除')
  assert.strictEqual(m.cancelText, '取消')
  assert.strictEqual(res.deleted, true)
})

test('CLOUD_DELETE_CANCEL_IS_ZERO_SIDE_EFFECT', async t => {
  const h = harness(t, { cloudBooks: threeBooks(), modalConfirm: false })
  const page = await openPage(h)
  seedLocalBook(h, { localId: 'lb_keep', name: '本机书', extra: { minutes: 9 } })
  const idxBefore = h.storage.read(lb.STORAGE_KEY)

  const res = await tapDelete(page, 'cloud_book_1')
  await flush()

  assert.strictEqual(res.deleted, false)
  assert.strictEqual(res.reason, 'USER_CANCELLED')
  assert.strictEqual(h.modals.length, 1, '取消也必须先经过确认框')
  assert.strictEqual(h.calls.booksRemove, 0, '取消不得产生任何删除')
  assert.strictEqual(h.calls.booksWhere, 0, '取消不得发起任何读取')
  assert.strictEqual(h.calls.booksUpdate.length, 0)
  assert.strictEqual(h.calls.booksAdd, 0)
  assert.strictEqual(h.calls.deleteFile, 0)
  assert.strictEqual(h.calls.callFunction, 0, '取消不得触发任何云端补报')
  assert.strictEqual(h.cloudBooksNow().length, 3, '云端记录一条都不能少')
  assert.strictEqual(page.data.books.length, 3)
  assert.strictEqual(h.storage.read(lb.STORAGE_KEY), idxBefore, '本机索引一字未改')
  assert.ok(!h.toastTitles().includes('已删除'))
})

// ============================================================
// 3. 确认后：只删目标记录，其余一律不动
// ============================================================

test('CLOUD_DELETE_REMOVES_ONLY_THE_TARGET_RECORD', async t => {
  const h = harness(t, { cloudBooks: threeBooks() })
  const page = await openPage(h)

  const res = await tapDelete(page, 'cloud_book_2')
  await flush()

  assert.strictEqual(res.deleted, true)
  assert.strictEqual(res.reason, null)
  assert.strictEqual(h.calls.booksRemove, 1, '只允许一次删除调用')
  assert.deepStrictEqual(h.calls.booksRemoveData, [{ id: 'cloud_book_2' }], '只允许删目标那一条')
  const left = h.cloudBooksNow().map(b => b._id)
  assert.deepStrictEqual(left, ['cloud_book_1', 'cloud_manual_1'], '其他书籍必须原样保留')
  // 立即刷新清单
  assert.strictEqual(page.data.books.length, 2)
  assert.deepStrictEqual(page.data.books.map(b => b._id), ['cloud_book_1', 'cloud_manual_1'])
  assert.ok(h.toastTitles().includes('已删除'))
})

test('CLOUD_DELETE_KEEPS_CLOUD_STORAGE_FILE_AND_WRITES_NOTHING_ELSE', async t => {
  const h = harness(t, { cloudBooks: threeBooks() })
  const page = await openPage(h)

  await tapDelete(page, 'cloud_book_1')
  await flush()

  assert.strictEqual(h.calls.deleteFile, 0, '不得调用 deleteFile：云存储原始文件始终保留')
  assert.strictEqual(h.calls.uploadFile, 0)
  assert.strictEqual(h.calls.getTempFileURL, 0, '删除不涉及取临时地址')
  assert.strictEqual(h.calls.downloadFile, 0)
  assert.strictEqual(h.calls.openDocument, 0)
  assert.deepStrictEqual(h.calls.booksUpdate, [], '不得改写任何其它字段')
  assert.strictEqual(h.calls.booksAdd, 0)
  const kept = h.cloudBooksNow().find(b => b._id === 'cloud_book_1')
  assert.strictEqual(kept, undefined, '目标记录已删除')
  assert.strictEqual(h.cloudBooksNow().length, 2)
})

test('CLOUD_DELETE_KEEPS_MIGRATED_LOCAL_COPY_AND_FILES', async t => {
  const h = harness(t, { cloudBooks: threeBooks() })
  const page = await openPage(h)
  const seeded = seedLocalBook(h, {
    localId: 'lb_migrated',
    name: '新概念4 1-24课',
    ext: 'pdf',
    bytes: Buffer.from('%PDF-1.4 local copy', 'utf8'),
    extra: { migratedFrom: 'cloud_book_1', minutes: 12 }
  })
  const before = entryOf(h, seeded.localId)
  await page.loadLocalBooks()
  await flush()

  await tapDelete(page, 'cloud_book_1')
  await flush()
  await page.loadLocalBooks()
  await flush()

  assert.strictEqual(h.calls.unlink, 0, '删除云端记录绝不动本机文件')
  assert.ok(h.fs.hasFile(seeded.path), '已迁移的本机副本必须还在')
  assert.deepStrictEqual(entryOf(h, seeded.localId), before, '本机条目一字未改')
  assert.strictEqual(page.data.localBooks.length, 1)
  assert.strictEqual(bookFiles(h).length, 1)
})

test('CLOUD_DELETE_LEAVES_DAILY_STATS_AND_OTHER_BOOKS_UNTIL_CLOUD_CALL', async t => {
  const h = harness(t, { cloudBooks: threeBooks(), callFunctionFails: true })
  const page = await openPage(h)
  h.storage.write(dp.PENDING_KEY, JSON.stringify([
    { date: '2026-08-26', minutes: 3, bookId: 'cloud_book_1', requestId: 'rd_a', at: 1 },
    { date: '2026-08-26', minutes: 5, bookId: 'cloud_book_2', requestId: 'rd_b', at: 2 }
  ]))

  const res = await tapDelete(page, 'cloud_book_1')
  await flush()

  assert.strictEqual(res.deleted, true, '补报失败不得阻断删除本身')
  const left = pendingRaw(h)
  assert.strictEqual(left.length, 2, '不得因为删一本书就清空全局补报队列')
  assert.deepStrictEqual(left.map(e => e.requestId).sort(), ['rd_a', 'rd_b'])
  assert.deepStrictEqual(left.map(e => e.minutes).sort((a, b) => a - b), [3, 5], '分钟一条都不能丢')
  assert.strictEqual(h.calls.callFunctionData.length, 2, '两次补报尝试，一次不多')
  assert.ok(h.calls.callFunctionData.every(d => d.action === 'addRead'), '删除链路只允许 addRead')
  // 删除本身仍然只影响目标那一条
  assert.strictEqual(h.calls.booksRemove, 1)
  assert.deepStrictEqual(h.cloudBooksNow().map(b => b._id), ['cloud_book_2', 'cloud_manual_1'])
})

test('CLOUD_DELETE_FLUSHES_PENDING_FIRST_SO_MINUTES_ARE_RECORDED', async t => {
  // 真实云函数（事务版 addRead）：删除前先把待补报落地，分钟不会因为删书而丢
  const h = harness(t, { cloudBooks: threeBooks(), cloudDb: true })
  const page = await openPage(h)
  h.storage.write(dp.PENDING_KEY, JSON.stringify([
    { date: '2026-08-26', minutes: 3, bookId: 'cloud_book_1', requestId: 'rd_a', at: 1 },
    { date: '2026-08-26', minutes: 5, bookId: 'cloud_book_2', requestId: 'rd_b', at: 2 }
  ]))

  const res = await tapDelete(page, 'cloud_book_1')
  await flush()

  assert.strictEqual(res.deleted, true)
  const rec = h.cloud.record('2026-08-26')
  assert.ok(rec, '当日记录必须被建出来')
  assert.strictEqual(rec.readProgress, 8, '被删书籍的那 3 分钟必须先落地，绝不能丢')
  assert.strictEqual((pendingRaw(h) || []).length, 0, '云端确认成功后才出队')
  assert.strictEqual(h.calls.booksRemove, 1)
})

// ============================================================
// 4. 失败必须显式，绝不谎报成功
// ============================================================

test('CLOUD_DELETE_FAILURE_IS_EXPLICIT_AND_NOT_FAKE_SUCCESS', async t => {
  const h = harness(t, { cloudBooks: threeBooks(), booksRemoveFails: true })
  const page = await openPage(h)

  const res = await tapDelete(page, 'cloud_book_1')
  await flush()

  assert.strictEqual(res.deleted, false)
  assert.strictEqual(res.reason, 'DELETE_FAILED')
  assert.ok(!h.toastTitles().includes('已删除'), '失败绝不能提示「已删除」')
  assert.ok(h.toastTitles().includes('删除失败，请重试'))
  assert.strictEqual(h.cloudBooksNow().length, 3, '记录必须还在')
  assert.strictEqual(page.data.books.length, 3, '列表必须保持真实状态')
  assert.strictEqual(page._deletingCloudId, null, '失败后必须释放并发锁，允许重试')
})

test('CLOUD_DELETE_REJECTS_SILENT_NOOP_BY_VERIFYING_REFRESHED_LIST', async t => {
  // 替身「返回 removed:1 但一条都没删」：客户端只能靠刷新后的列表核验
  const h = harness(t, { cloudBooks: threeBooks(), booksRemoveNoop: true })
  const page = await openPage(h)

  const res = await tapDelete(page, 'cloud_book_1')
  await flush()

  assert.strictEqual(res.deleted, false, '删不掉就不能报成功')
  assert.strictEqual(res.reason, 'DELETE_NOT_APPLIED')
  assert.ok(!h.toastTitles().includes('已删除'))
  assert.ok(h.toastTitles().includes('云端记录未删除成功，请重试'))
  assert.strictEqual(h.cloudBooksNow().length, 3)
})

test('CLOUD_DELETE_ACCEPTS_OPAQUE_REMOVE_RESULT_WHEN_ROW_IS_GONE', async t => {
  // 某些 SDK 版本可能不返回 stats —— 不得据此臆造「删失败」
  const h = harness(t, { cloudBooks: threeBooks(), booksRemoveOpaque: true })
  const page = await openPage(h)

  const res = await tapDelete(page, 'cloud_book_1')
  await flush()

  assert.strictEqual(res.deleted, true)
  assert.strictEqual(h.cloudBooksNow().length, 2)
  assert.ok(h.toastTitles().includes('已删除'))
})

test('CLOUD_DELETE_FETCH_FAILURE_IS_EXPLICIT', async t => {
  const h = harness(t, { cloudBooks: threeBooks(), booksWhereFails: true })
  const page = await openPage(h)

  const res = await tapDelete(page, 'cloud_book_1')
  await flush()

  assert.strictEqual(res.deleted, false)
  assert.strictEqual(res.reason, 'FETCH_FAILED')
  assert.strictEqual(h.calls.booksRemove, 0, '记录都没读到就不能删')
  assert.strictEqual(h.cloudBooksNow().length, 3)
  assert.ok(h.toastTitles().includes('读取云端记录失败，请检查网络后重试'))
})

// ============================================================
// 5. 归属 / 参数 / 并发 / 会话
// ============================================================

test('CLOUD_DELETE_REFUSES_RECORD_BELONGING_TO_ANOTHER_USER', async t => {
  const h = harness(t, {
    appOpenid: 'her_001',
    cloudBooks: [Object.assign({}, CLOUD_A, { _openid: 'him_999' })]
  })
  const page = await openPage(h)

  const res = await tapDelete(page, 'cloud_book_1')
  await flush()

  assert.strictEqual(res.deleted, false)
  assert.strictEqual(res.reason, 'NOT_OWNER')
  assert.strictEqual(h.calls.booksRemove, 0, '归属不符绝不删除')
  assert.strictEqual(h.cloudBooksNow().length, 1)
  assert.ok(h.toastTitles().includes('这本书不属于当前账号，无法删除'))
})

test('CLOUD_DELETE_PROCEEDS_WHEN_OWNER_MATCHES', async t => {
  const h = harness(t, {
    appOpenid: 'her_001',
    cloudBooks: [Object.assign({}, CLOUD_A, { _openid: 'her_001' })]
  })
  const page = await openPage(h)

  const res = await tapDelete(page, 'cloud_book_1')
  await flush()

  assert.strictEqual(res.deleted, true)
  assert.strictEqual(h.calls.booksRemove, 1)
})

test('CLOUD_DELETE_UNKNOWN_RECORD_REFUSES_WITHOUT_MODAL', async t => {
  const h = harness(t, { cloudBooks: threeBooks() })
  const page = await openPage(h)

  const res = await tapDelete(page, 'cloud_book_missing')
  await flush()

  assert.strictEqual(res.deleted, false)
  assert.strictEqual(res.reason, 'ENTRY_NOT_FOUND')
  assert.strictEqual(h.modals.length, 0, '列表里没有的记录不必弹确认')
  assert.strictEqual(h.calls.booksRemove, 0)
  assert.ok(h.toastTitles().includes('这本书已不在阅读清单里'))
})

test('CLOUD_DELETE_REJECTS_NON_STRING_ID', async t => {
  const h = harness(t, { cloudBooks: threeBooks() })
  const page = await openPage(h)

  const noId = await page.deleteCloudBook({ currentTarget: { dataset: {} } })
  const objId = await page.deleteCloudBook({ currentTarget: { dataset: { id: { $gt: '' } } } })
  const noEvent = await page.deleteCloudBook()
  await flush()

  assert.deepStrictEqual([noId.reason, objId.reason, noEvent.reason],
    ['NO_BOOK_ID', 'NO_BOOK_ID', 'NO_BOOK_ID'])
  assert.strictEqual(h.modals.length, 0)
  assert.strictEqual(h.calls.booksRemove, 0, '非字符串 id 绝不能被放大成范围条件')
  assert.strictEqual(h.cloudBooksNow().length, 3)
})

test('CLOUD_DELETE_CONCURRENT_TAP_IS_IGNORED_AND_LOCK_RELEASES', async t => {
  const h = harness(t, { cloudBooks: threeBooks() })
  const page = await openPage(h)

  const p1 = tapDelete(page, 'cloud_book_1')
  const p2 = tapDelete(page, 'cloud_book_1')
  const [r1, r2] = await Promise.all([p1, p2])
  await flush()

  assert.strictEqual(r1.deleted, true)
  assert.strictEqual(r2.deleted, false)
  assert.strictEqual(r2.reason, 'DELETE_IN_FLIGHT')
  assert.strictEqual(h.modals.length, 1, '重复点击只允许一次确认')
  assert.strictEqual(h.calls.booksRemove, 1, '重复点击只允许一次删除')
  assert.strictEqual(page._deletingCloudId, null, '结束后必须释放锁')
})

test('CLOUD_DELETE_REFUSES_WHILE_THAT_BOOK_IS_BEING_READ', async t => {
  const h = harness(t, { cloudBooks: threeBooks() })
  h.useClock()
  const page = await openPage(h)
  const began = page.startReadingSession({ bookId: 'cloud_book_1', localId: null })
  assert.strictEqual(began.began, true, '前置条件：这本书必须正在计时')

  const res = await tapDelete(page, 'cloud_book_1')
  await flush()

  assert.strictEqual(res.deleted, false)
  assert.strictEqual(res.reason, 'SESSION_ACTIVE')
  assert.strictEqual(h.modals.length, 0, '会话未结束就不进入确认流程')
  assert.strictEqual(h.calls.booksRemove, 0)
  assert.ok(h.toastTitles().includes('这本书正在阅读中，请先结束阅读再删除'))
  // 别的书不受影响
  const other = await tapDelete(page, 'cloud_book_2')
  await flush()
  assert.strictEqual(other.deleted, true)
})

test('CLOUD_DELETE_TAP_NEVER_OPENS_BOOK_OR_MIGRATES', async t => {
  const h = harness(t, { cloudBooks: threeBooks(), downloadBytes: Buffer.from('x', 'utf8') })
  const page = await openPage(h)

  let opens = 0
  let migrations = 0
  const origOpen = page.openBook
  const origMigrate = page.migrateCloudBook
  page.openBook = function (...a) { opens += 1; return origOpen.apply(this, a) }
  page.migrateCloudBook = function (...a) { migrations += 1; return origMigrate.apply(this, a) }

  await tapDelete(page, 'cloud_book_1')
  await flush()

  assert.strictEqual(opens, 0, '点删除不得触发 openBook')
  assert.strictEqual(migrations, 0, '点删除不得触发存本机')
  assert.strictEqual(h.calls.getTempFileURL, 0)
  assert.strictEqual(h.calls.downloadFile, 0)
  assert.ok(!page._start, '删除不得启动阅读计时')
  assert.ok(!page._migratingId, '迁移锁不得被删除流程占用')
})

test('MIGRATE_TAP_NEVER_DELETES', async t => {
  const h = harness(t, { cloudBooks: threeBooks(), downloadBytes: Buffer.from('x', 'utf8') })
  const page = await openPage(h)

  const res = await page.migrateCloudBook({ currentTarget: { dataset: { b: CLOUD_A } } })
  await flush()

  assert.strictEqual(res.migrated, true)
  assert.strictEqual(h.calls.booksRemove, 0, '点存本机绝不得触发删除')
  assert.strictEqual(h.modals.length, 0)
  assert.strictEqual(h.cloudBooksNow().length, 3, '存本机不减少任何云端记录')
})

// ============================================================
// 6. 与本机删除互不干扰（不回归）
// ============================================================

test('LOCAL_DELETE_NOT_REGRESSED_BY_CLOUD_DELETE', async t => {
  const h = harness(t, { cloudBooks: threeBooks() })
  const page = await openPage(h)
  const seeded = seedLocalBook(h, {
    localId: 'lb_local',
    name: '我的本机书',
    ext: 'pdf',
    bytes: Buffer.from('local pdf bytes', 'utf8')
  })
  await page.loadLocalBooks()
  await flush()
  const cloudBefore = h.cloudBooksNow()

  const res = await page.deleteLocalBook({ currentTarget: { dataset: { id: seeded.localId } } })
  await flush()

  assert.strictEqual(res.deleted, true)
  assert.strictEqual(entryOf(h, seeded.localId), null, '本机记录必须被删除')
  assert.strictEqual(h.fs.hasFile(seeded.path), false, '本机文件必须被删除')
  assert.strictEqual(h.calls.booksRemove, 0, '本机删除绝不碰云端 books')
  assert.strictEqual(h.calls.deleteFile, 0, '本机删除绝不碰云存储')
  assert.deepStrictEqual(h.cloudBooksNow(), cloudBefore, '云端记录一字未改')
})
