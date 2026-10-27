// ============================================================
// tests/reading-local-delete.test.js · S4 本机书籍删除 行为测试
//
// 全部用例真实 require 并执行 pages/reading/reading.js + utils/localBooks.js，
// 通过注入的 wx 替身跑完整删除链路（点击删除 → 二次确认 → remove() →
// 文件 unlink → 元数据写入 → 待补写清理 → 列表刷新），
// 不做「只断言源码字符串」的假验证。
//
// 旧云端兼容断言保留在 tests/pdf-open-download-api.test.js 与
// tests/pdf-book-db-write.test.js，本文件不放宽任何既有断言。
// ============================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const lb = require('../utils/localBooks')
const dp = require('../utils/readingDailyPending')
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

function entryOf(h, localId) {
  const idx = parseIndex(h.storage)
  return (idx && idx.books || []).find(b => b.localId === localId) || null
}

function seedIndex(h, books) {
  h.storage.write(lb.STORAGE_KEY, JSON.stringify({
    version: 1, updatedAt: 0, pendingApplied: {}, books
  }))
}

function booksDirFiles(h) {
  return h.fs.listFiles().filter(p => p.indexOf('/books/') !== -1)
}

function unlinkCalls(h) {
  return h.fs.calls.filter(c => c.op === 'unlink')
}

async function importOne(h, page, name, size) {
  h.ctx.pushFile(h.seedTempFile(name, size))
  await page.importBook()
  // 按名称定位刚导入的那本：同毫秒内连续导入时 createdAt 会打平，
  // list()[0] 不稳，必须显式按 name 取，否则测试会取到同一本书。
  const base = String(name).replace(/\.[^.]+$/, '')
  const found = page.data.localBooks.find(b => b.name === base)
  assert.ok(found, '导入后必须能在本机清单里按名称找到 ' + base)
  return found
}

function tapDelete(page, localId) {
  return page.deleteLocalBook({ currentTarget: { dataset: { id: localId } } })
}

function flush(times) {
  const n = times || 8
  let p = Promise.resolve()
  for (let i = 0; i < n; i++) p = p.then(() => new Promise(r => setImmediate(r)))
  return p
}

// ---------------- 1. 删除图标存在（且只在本地行） ----------------

test('DELETE_ICON_ON_LOCAL_ROWS_ONLY', () => {
  const wxml = read('pages/reading/reading.wxml')
  const wxss = read('pages/reading/reading.wxss')
  const localBlock = wxml.slice(wxml.indexOf('wx:for="{{localBooks}}"'), wxml.indexOf('wx:for="{{books}}"'))
  const cloudBlock = wxml.slice(wxml.indexOf('wx:for="{{books}}"'), wxml.indexOf('writing-section'))

  assert.ok(localBlock.length > 0, '本地书籍行区块必须存在')
  assert.match(localBlock, /class="b-del"/)
  // catchtap 而非 bindtap：微信小程序中才阻止冒泡，避免同时触发 openLocalBook
  assert.match(localBlock, /catchtap="deleteLocalBook"/)
  assert.doesNotMatch(localBlock, /bindtap="deleteLocalBook"/)
  assert.match(localBlock, /data-id="\{\{item\.localId\}\}"/)
  // 点击书籍主体仍走原打开逻辑
  assert.match(localBlock, /bindtap="openLocalBook"/)

  // 历史云端行不得复用本机删除入口（它有自己独立的云端删除链路
  // deleteCloudBook，见 tests/reading-cloud-delete.test.js）
  assert.ok(cloudBlock.length > 0, '云端书籍行区块必须存在')
  assert.doesNotMatch(cloudBlock, /deleteLocalBook/)
  assert.doesNotMatch(cloudBlock, /b-del/)
  assert.match(cloudBlock, /bindtap="openBook"/)

  // 样式复用既有设计语言（主题变量 + 圆角 + 足够点击区域）
  assert.match(wxss, /\.b-del\b/)
  assert.match(wxss, /width: 88rpx; height: 88rpx/, '点击区域必须达到 88rpx（44px）')
  assert.match(wxss, /border-radius: 24rpx/)
  assert.match(wxss, /var\(--notebook-line\)/)
  assert.match(wxss, /var\(--pink-deep\)/)
  // 不得高于封面（88rpx），否则会撑高卡片
  assert.match(wxss, /\.cover \{\s*width: 88rpx; height: 88rpx;/)
})

// ---------------- 2. 点击删除不触发打开 ----------------

test('DELETE_TAP_NEVER_OPENS_BOOK', async t => {
  const h = harness(t)
  const page = h.load()
  const b = await importOne(h, page, '删我不开.pdf', 1024)

  let localOpens = 0
  let cloudOpens = 0
  const origLocal = page.openLocalBook
  const origCloud = page.openBook
  page.openLocalBook = function (...a) { localOpens += 1; return origLocal.apply(this, a) }
  page.openBook = function (...a) { cloudOpens += 1; return origCloud.apply(this, a) }

  const res = await tapDelete(page, b.localId)
  await flush()

  assert.strictEqual(res.deleted, true)
  assert.strictEqual(localOpens, 0, '删除不得触发 openLocalBook')
  assert.strictEqual(cloudOpens, 0, '删除不得触发 openBook')
  assert.strictEqual(h.calls.openDocument, 0)
  assert.strictEqual(h.calls.getTempFileURL, 0)
  assert.strictEqual(h.calls.downloadFile, 0)
  assert.ok(!page._start, '删除不得启动阅读计时')
})

test('DELETE_WITHOUT_ID_REFUSES_WITHOUT_SIDE_EFFECT', async t => {
  const h = harness(t)
  const page = h.load()
  const b = await importOne(h, page, 'noid.pdf', 1024)

  const res = await page.deleteLocalBook()
  await flush()

  assert.strictEqual(res.deleted, false)
  assert.strictEqual(res.reason, 'NO_LOCAL_ID')
  assert.strictEqual(h.modals.length, 0)
  assert.ok(entryOf(h, b.localId), '记录必须保留')
  assert.strictEqual(unlinkCalls(h).length, 0)
})

test('REPEATED_DELETE_TAP_IS_IGNORED', async t => {
  const h = harness(t)
  const page = h.load()
  const b = await importOne(h, page, 'double-del.pdf', 1024)

  const p1 = tapDelete(page, b.localId)
  const p2 = tapDelete(page, b.localId)
  const [r1, r2] = await Promise.all([p1, p2])
  await flush()

  assert.strictEqual(r1.deleted, true)
  assert.strictEqual(r2.deleted, false)
  assert.strictEqual(r2.reason, 'DELETE_IN_FLIGHT')
  assert.strictEqual(h.modals.length, 1, '重复点击只允许一次确认')
})

// ---------------- 3. 取消确认不删除 ----------------

test('CANCEL_CONFIRM_DELETES_NOTHING', async t => {
  const h = harness(t, { modalConfirm: false })
  const page = h.load()
  const b = await importOne(h, page, '保留我.pdf', 2048)
  const filePath = h.fs.userDataPath + '/books/' + b.fileName
  const before = h.storage.read(lb.STORAGE_KEY)

  const res = await tapDelete(page, b.localId)
  await flush()

  assert.strictEqual(res.deleted, false)
  assert.strictEqual(res.reason, 'USER_CANCELLED')
  assert.strictEqual(h.modals.length, 1, '必须先弹二次确认')
  assert.match(h.modals[0].content, /确定删除《保留我》吗？本机文件和阅读记录将一起删除，无法撤销。/)
  assert.strictEqual(h.modals[0].cancelText, '取消')

  assert.ok(entryOf(h, b.localId), '取消后记录必须保留')
  assert.strictEqual(h.fs.hasFile(filePath), true, '取消后文件必须保留')
  assert.strictEqual(h.storage.read(lb.STORAGE_KEY), before, '取消后索引必须一字未改')
  assert.strictEqual(unlinkCalls(h).length, 0, '取消不得触发 unlink')
  assert.strictEqual(h.toastTitles().includes('已删除'), false, '取消不得显示成功提示')
  assert.strictEqual(page.data.localBooks.length, 1)
})

// ---------------- 4 & 5. 确认删除成功 / 重新加载不再出现 ----------------

test('CONFIRM_DELETES_BOOK_AND_RELOADS_WITHOUT_IT', async t => {
  const h = harness(t)
  const page = h.load()
  const b = await importOne(h, page, '删掉我.pdf', 4096)

  const res = await tapDelete(page, b.localId)
  await flush()

  assert.strictEqual(res.deleted, true)
  assert.strictEqual(h.modals.length, 1)
  assert.strictEqual(h.modals[0].confirmText, '删除')
  assert.strictEqual(h.lastToast().title, '已删除', '成功必须有成功提示')

  assert.strictEqual(entryOf(h, b.localId), null, '元数据必须被删除')
  assert.strictEqual(page.data.localBooks.length, 0, '删除后必须刷新书架')
  assert.strictEqual(parseIndex(h.storage).books.length, 0)

  // 重新进入页面不再出现
  const page2 = h.reload()
  await page2.loadLocalBooks()
  assert.strictEqual(page2.data.localBooks.length, 0, '重新加载不得再出现该书')
})

// ---------------- 6. 本地文件实际被删除 ----------------

test('DELETE_ACTUALLY_UNLINKS_LOCAL_FILE', async t => {
  const h = harness(t)
  const page = h.load()
  const b = await importOne(h, page, '真删文件.pdf', 8192)
  const filePath = h.fs.userDataPath + '/books/' + b.fileName

  assert.strictEqual(h.fs.hasFile(filePath), true)
  const beforeCount = booksDirFiles(h).length

  await tapDelete(page, b.localId)
  await flush()

  assert.strictEqual(h.fs.hasFile(filePath), false, '本机文件必须真的被删除')
  assert.strictEqual(booksDirFiles(h).length, beforeCount - 1)
  assert.deepStrictEqual(unlinkCalls(h).map(c => c.filePath), [filePath])
})

// ---------------- 7. 手动书单只删除元数据 ----------------

test('MANUAL_BOOK_DELETES_METADATA_ONLY', async t => {
  const h = harness(t)
  const page = h.load()
  seedIndex(h, [{
    localId: 'lb_manual_1', name: '手记', ext: '', source: 'local', fileName: null,
    size: 0, status: 'want', progressPercent: 0, minutes: 0, createdAt: 1000
  }])
  await page.loadLocalBooks()
  assert.strictEqual(page.data.localBooks.length, 1)
  assert.strictEqual(page.data.localBooks[0].fileName, null)

  const res = await tapDelete(page, 'lb_manual_1')
  await flush()

  assert.strictEqual(res.deleted, true)
  assert.match(h.modals[0].content, /确定从阅读清单中删除《手记》吗？/)
  assert.doesNotMatch(h.modals[0].content, /本机文件和阅读记录/)
  assert.strictEqual(unlinkCalls(h).length, 0, '手动书单没有文件，不得调用 unlink')
  assert.strictEqual(entryOf(h, 'lb_manual_1'), null)
  assert.strictEqual(h.lastToast().title, '已删除')
  assert.strictEqual(booksDirFiles(h).length, 0)
})

// ---------------- 8. 文件已丢失时允许清理 ----------------

test('MISSING_FILE_STILL_ALLOWS_METADATA_CLEANUP', async t => {
  const h = harness(t)
  const page = h.load()
  const b = await importOne(h, page, '文件已丢.pdf', 1024)
  h.fs.deleteFileRaw(h.fs.userDataPath + '/books/' + b.fileName)
  await page.loadLocalBooks()
  assert.strictEqual(page.data.localBooks[0].missing, true)

  const res = await tapDelete(page, b.localId)
  await flush()

  assert.strictEqual(res.deleted, true, '文件已丢失仍允许清理元数据')
  assert.strictEqual(entryOf(h, b.localId), null)
  assert.strictEqual(h.lastToast().title, '已删除')
  // 幂等：unlink 返回 1300002 必须被当成成功
  assert.strictEqual(unlinkCalls(h).length, 1)
})

// ---------------- 9. 文件删除失败保留元数据 ----------------

test('UNLINK_FAILURE_KEEPS_METADATA_AND_FILE', async t => {
  const h = harness(t, { fsFails: ['unlink'] })
  const page = h.load()
  const b = await importOne(h, page, '删不掉.pdf', 1024)
  const filePath = h.fs.userDataPath + '/books/' + b.fileName
  const before = parseIndex(h.storage)

  const res = await tapDelete(page, b.localId)
  await flush()

  assert.strictEqual(res.deleted, false)
  assert.strictEqual(res.reason, 'DELETE_FILE_FAILED')
  assert.ok(entryOf(h, b.localId), '文件删除失败必须保留元数据')
  assert.strictEqual(h.fs.hasFile(filePath), true, '文件删除失败文件必须还在')
  assert.strictEqual(parseIndex(h.storage).books.length, before.books.length)
  assert.strictEqual(h.lastToast().title, '文件删除失败，记录已保留')
  assert.strictEqual(h.toastTitles().includes('已删除'), false, '失败不得伪装成功')
  assert.strictEqual(page.data.localBooks.length, 1, '失败后书架仍能看到该书')
})

test('UNLINK_FAILURE_NEVER_TOUCHES_OTHER_BOOKS', async t => {
  const h = harness(t, { fsFails: ['unlink'] })
  const page = h.load()
  const a = await importOne(h, page, 'a.pdf', 1024)
  const b = await importOne(h, page, 'b.pdf', 2048)
  await page.loadLocalBooks()

  await tapDelete(page, a.localId)
  await flush()

  assert.ok(entryOf(h, a.localId), 'a 保留')
  assert.ok(entryOf(h, b.localId), 'b 不受影响')
  assert.strictEqual(h.fs.hasFile(h.fs.userDataPath + '/books/' + b.fileName), true)
})

// ---------------- 10. 元数据删除失败可恢复 ----------------

test('META_WRITE_FAILURE_IS_RECOVERABLE_BY_RETRY', async t => {
  const h = harness(t)
  const page = h.load()
  const b = await importOne(h, page, '元数据失败.pdf', 1024)
  const filePath = h.fs.userDataPath + '/books/' + b.fileName

  h.storage.failWriteFor(lb.STORAGE_KEY)
  const res = await tapDelete(page, b.localId)
  await flush()

  assert.strictEqual(res.deleted, false)
  assert.strictEqual(res.reason, 'DELETE_META_FAILED')
  assert.strictEqual(h.fs.hasFile(filePath), false, '文件先删（顺序：文件 → 元数据）')
  assert.ok(entryOf(h, b.localId), '元数据写失败必须保留可恢复状态')
  assert.strictEqual(h.lastToast().title, '文件已删除，记录清理失败，请重试')
  assert.strictEqual(h.toastTitles().includes('已删除'), false)

  // 恢复后可重试成功（不会产生幽灵条目）
  h.storage.allowWriteFor(lb.STORAGE_KEY)
  const page2 = h.reload()
  await page2.loadLocalBooks()
  assert.strictEqual(page2.data.localBooks.length, 1)
  assert.strictEqual(page2.data.localBooks[0].missing, true, '文件已不在 → 应标为已丢失')

  const retry = await tapDelete(page2, b.localId)
  await flush()
  assert.strictEqual(retry.deleted, true)
  assert.strictEqual(entryOf(h, b.localId), null)
  assert.strictEqual(h.lastToast().title, '已删除')
})

test('META_WRITE_FAILURE_NEVER_CLEARS_WHOLE_INDEX', async t => {
  const h = harness(t)
  const page = h.load()
  const a = await importOne(h, page, 'x.pdf', 1024)
  const b = await importOne(h, page, 'y.pdf', 1024)
  await page.loadLocalBooks()

  h.storage.failWriteFor(lb.STORAGE_KEY)
  await tapDelete(page, a.localId)
  await flush()
  h.storage.allowWriteFor(lb.STORAGE_KEY)

  const idx = parseIndex(h.storage)
  assert.strictEqual(idx.books.length, 2, '索引写失败不得清空整个 localBooks_v1')
  assert.ok(idx.books.some(x => x.localId === b.localId), '其他书籍必须保留')
  assert.ok((idx.books.find(x => x.localId === b.localId).minutes) === 0)
})

// ---------------- 11. 索引损坏时拒绝删除 ----------------

test('CORRUPT_INDEX_REFUSES_DELETE_WITHOUT_REPAIR', async t => {
  const raw = '{not json'
  const h = harness(t, { storage: { [lb.STORAGE_KEY]: raw } })
  const page = h.load()
  await page.loadLocalBooks()
  assert.strictEqual(page.data.localIndexCorrupted, true)
  assert.strictEqual(page.data.localBooks.length, 0, '损坏索引下不展示任何本机书籍')

  const res = await tapDelete(page, 'lb_ghost')
  await flush()

  assert.strictEqual(res.deleted, false)
  assert.strictEqual(h.storage.read(lb.STORAGE_KEY), raw, '损坏索引一字不得改（不得自动 repair）')
  assert.strictEqual(unlinkCalls(h).length, 0)
  assert.strictEqual(h.toastTitles().includes('已删除'), false)

  // 能力层同样必须 fail-closed
  await assert.rejects(
    () => lb.getLocalBooks().remove('lb_ghost'),
    err => err && err.code === 'INDEX_CORRUPT_LOCKED'
  )
  assert.strictEqual(h.storage.read(lb.STORAGE_KEY), raw, 'remove 被拒后索引仍不得被覆盖')
})

// ---------------- 12. 旧云端书籍不受影响 ----------------

test('CLOUD_LEGACY_BOOKS_ARE_UNTOUCHED', async t => {
  const cloudBooks = [
    { _id: 'c1', name: '云端旧书', fileID: 'cloud://old', ext: 'pdf', coverColor: '#FFC9D4', createdAt: 1, minutes: 5, totalMin: 10 }
  ]
  const h = harness(t, { cloudBooks })
  const page = h.load()
  const b = await importOne(h, page, 'local-only.pdf', 1024)
  await page.loadBooks()

  const res = await tapDelete(page, b.localId)
  await flush()

  assert.strictEqual(res.deleted, true)
  assert.strictEqual(h.calls.deleteFile, 0, '不得调用 wx.cloud.deleteFile')
  assert.strictEqual(h.calls.booksUpdate.length, 0, '不得 update 云端 books')
  assert.strictEqual(h.calls.uploadFile, 0)

  const page2 = h.reload()
  await page2.loadBooks()
  assert.strictEqual(page2.data.books.length, 1, '云端历史记录必须继续存在')
  assert.strictEqual(page2.data.books[0]._id, 'c1')
  assert.strictEqual(page2.data.books[0].minutes, 5, '云端书籍分钟不得被改动')
})

test('NON_LOCAL_SOURCE_ENTRY_IS_REFUSED', async t => {
  const h = harness(t)
  const page = h.load()
  seedIndex(h, [{
    localId: 'lb_cloudish', name: '伪装云端', ext: 'pdf', source: 'cloud',
    fileName: 'lb_cloudish.pdf', size: 10, createdAt: 1
  }])
  h.fs.seedFile(h.fs.userDataPath + '/books/lb_cloudish.pdf', 10)

  const res = await tapDelete(page, 'lb_cloudish')
  await flush()

  assert.strictEqual(res.deleted, false)
  assert.strictEqual(res.reason, 'NOT_LOCAL_SOURCE')
  assert.strictEqual(h.modals.length, 0, '非本地来源不进入确认流程')
  assert.strictEqual(unlinkCalls(h).length, 0)
  assert.strictEqual(h.lastToast().title, '历史云端书籍暂不支持删除')
})

// ---------------- 13. 删除一本书不影响其他书 ----------------

test('DELETING_ONE_BOOK_KEEPS_OTHERS_INTACT', async t => {
  const h = harness(t)
  const page = h.load()
  const a = await importOne(h, page, 'a.pdf', 1024)
  const b = await importOne(h, page, 'b.pdf', 2048)
  await page.loadLocalBooks()

  const repo = lb.getLocalBooks()
  await repo.update(b.localId, { progressPercent: 42, status: 'finished', minutes: 7 })
  const before = entryOf(h, b.localId)

  const res = await tapDelete(page, a.localId)
  await flush()

  assert.strictEqual(res.deleted, true)
  const after = entryOf(h, b.localId)
  assert.ok(after, '另一本书必须保留')
  assert.deepStrictEqual(after, before, '另一本书的分钟/进度/状态必须一字未改')
  assert.strictEqual(h.fs.hasFile(h.fs.userDataPath + '/books/' + b.fileName), true, '另一本书的文件必须保留')
  assert.strictEqual(parseIndex(h.storage).books.length, 1)

  // 不得顺手清理孤儿文件
  assert.strictEqual(h.fs.listFiles().indexOf(h.fs.userDataPath + '/books/' + a.fileName), -1)
  assert.strictEqual(h.fs.hasFile(h.fs.userDataPath + '/books/' + b.fileName), true)
})

// ---------------- 14. 正在阅读时阻止删除 ----------------

test('ACTIVE_READING_SESSION_BLOCKS_DELETE', async t => {
  const h = harness(t)
  h.useClock()
  const page = h.load()
  const b = await importOne(h, page, '正在读.pdf', 1024)
  const filePath = h.fs.userDataPath + '/books/' + b.fileName

  await page.openLocalBook({ currentTarget: { dataset: { id: b.localId } } })
  await flush()
  assert.ok(page._start, '前置条件：必须存在活动阅读会话')

  const res = await tapDelete(page, b.localId)
  await flush()

  assert.strictEqual(res.deleted, false)
  assert.strictEqual(res.reason, 'SESSION_ACTIVE')
  assert.strictEqual(h.modals.length, 0, '阻止删除时不进入确认流程')
  assert.strictEqual(h.lastToast().title, '这本书正在阅读中，请先结束阅读再删除')
  assert.ok(entryOf(h, b.localId), '记录必须保留')
  assert.strictEqual(h.fs.hasFile(filePath), true, '文件必须保留')

  // 未结算分钟不得被悄悄丢弃
  h.advanceClock(60000)
  const settled = await page.settleSession('TEST')
  await flush()
  assert.strictEqual(settled.settled, true)
  assert.strictEqual(entryOf(h, b.localId).minutes, 1)
  assert.strictEqual(h.calls.callFunction, 1)
})

test('OTHER_BOOK_SESSION_DOES_NOT_BLOCK_DELETE', async t => {
  const h = harness(t)
  h.useClock()
  const page = h.load()
  const a = await importOne(h, page, '在读.pdf', 1024)
  const b = await importOne(h, page, '待删.pdf', 2048)
  await page.openLocalBook({ currentTarget: { dataset: { id: a.localId } } })
  await flush()

  const res = await tapDelete(page, b.localId)
  await flush()

  assert.strictEqual(res.deleted, true, '删除的不是正在阅读的书 → 允许')
  assert.ok(entryOf(h, a.localId), '正在阅读的书必须保留')
  assert.ok(page._start, '对另一本书的会话不得被清掉')

  h.advanceClock(60000)
  const settled = await page.settleSession('TEST')
  await flush()
  assert.strictEqual(settled.localId, a.localId)
  assert.strictEqual(entryOf(h, a.localId).minutes, 1, '会话分钟必须写给仍在的书')
})

test('NO_WRITE_TO_DELETED_LOCAL_ID', async t => {
  const h = harness(t)
  const page = h.load()
  const b = await importOne(h, page, '删后不写.pdf', 1024)

  await tapDelete(page, b.localId)
  await flush()
  assert.ok(!page._localId, '删除后不得残留本地会话目标')

  // 删除后任何结算都不得向已删除的 localId 写分钟
  const settled = await page.settleSession('TEST')
  assert.strictEqual(settled.settled, false)
  const repo = lb.getLocalBooks()
  await assert.rejects(() => repo.addMinutes(b.localId, 3), err => err && err.code === 'NOT_FOUND')
  const flushRes = await repo.flushPending()
  assert.strictEqual(flushRes.flushed, 0)
  assert.strictEqual((await repo.list()).books.length, 0)
})

// ---------------- 15. 待补写阅读分钟 + 每日统计不丢失 ----------------

test('DELETE_DROPS_BOOK_PENDING_BUT_KEEPS_DAILY_PENDING', async t => {
  const h = harness(t, { callFunctionFails: true })
  h.useClock()
  const page = h.load()
  const b = await importOne(h, page, 'pending.pdf', 1024)

  await page.openLocalBook({ currentTarget: { dataset: { id: b.localId } } })
  await flush()

  // 会话结算时：索引写失败 → 本机分钟进 localBooks_pending_v1
  //             云函数调用失败 → 每日统计进 readingDailyPending_v1
  h.storage.failWriteFor(lb.STORAGE_KEY)
  h.advanceClock(60000)
  const settled = await page.settleSession('TEST')
  await flush()
  h.storage.allowWriteFor(lb.STORAGE_KEY)

  assert.strictEqual(settled.dailyFailed, true)
  const bookPendingBefore = JSON.parse(h.storage.read(lb.PENDING_KEY) || '{}')
  const dailyPendingBefore = JSON.parse(h.storage.read(dp.PENDING_KEY) || '[]')
  assert.strictEqual(bookPendingBefore[b.localId], 1, '前置条件：本机分钟必须已进待补写键')
  assert.strictEqual(dailyPendingBefore.length, 1, '前置条件：每日统计必须已进待补报队列')

  const res = await tapDelete(page, b.localId)
  await flush()

  assert.strictEqual(res.deleted, true)
  assert.strictEqual(res.droppedPendingMinutes, 1, '该书的待补写分钟必须被显式清理并回报数量')

  // 每日统计与「书是否被删除」无关，绝不允许被删除动作清掉
  assert.deepStrictEqual(
    JSON.parse(h.storage.read(dp.PENDING_KEY) || '[]'),
    dailyPendingBefore,
    '每日阅读统计待补报不得丢失'
  )

  // 该书的待补写键必须清掉，且后续 flush 绝不把已删除的书复活
  const bookPendingAfter = JSON.parse(h.storage.read(lb.PENDING_KEY) || '{}')
  assert.strictEqual(bookPendingAfter[b.localId], undefined)
  assert.deepStrictEqual(bookPendingAfter, {})

  const repo = lb.getLocalBooks()
  const flushRes = await repo.flushPending()
  assert.strictEqual(flushRes.flushed, 0, '不得为已删除的书补写分钟')
  const listRes = await repo.list()
  assert.strictEqual(listRes.books.length, 0, 'flush 后不得复活已删除的书')
  assert.strictEqual(entryOf(h, b.localId), null)
})

test('DELETE_DOES_NOT_TOUCH_OTHER_BOOKS_PENDING', async t => {
  const h = harness(t)
  const page = h.load()
  const a = await importOne(h, page, 'keep-pending.pdf', 1024)
  const b = await importOne(h, page, 'drop-pending.pdf', 1024)
  await page.loadLocalBooks()

  const repo = lb.getLocalBooks()
  h.storage.failWriteFor(lb.STORAGE_KEY)
  await repo.addMinutes(a.localId, 5)
  await repo.addMinutes(b.localId, 9)
  h.storage.allowWriteFor(lb.STORAGE_KEY)
  assert.deepStrictEqual(
    JSON.parse(h.storage.read(lb.PENDING_KEY) || '{}'),
    { [a.localId]: 5, [b.localId]: 9 }
  )

  await tapDelete(page, b.localId)
  await flush()

  const after = JSON.parse(h.storage.read(lb.PENDING_KEY) || '{}')
  assert.strictEqual(after[b.localId], undefined, '被删书籍的待补写键必须清掉')

  // a 的 5 分钟绝不允许因删除 b 而丢失：要么仍在待补写键，要么已补写进索引
  const aInPending = Number(after[a.localId] || 0)
  assert.strictEqual(entryOf(h, a.localId).minutes + aInPending, 5, 'a 的未同步分钟必须完整保留')
  assert.strictEqual(entryOf(h, b.localId), null, 'b 必须被删除')

  const flushRes = await repo.flushPending()
  assert.strictEqual(flushRes.flushed, 0, '补写已完成，不得重复累计')
  assert.strictEqual(entryOf(h, a.localId).minutes, 5, '最终 a 必须拿到完整 5 分钟')
})

test('PENDING_CLEAR_FAILURE_DOES_NOT_RESURRECT_BOOK', async t => {
  const h = harness(t)
  const page = h.load()
  const b = await importOne(h, page, '复活检查.pdf', 1024)

  const repo = lb.getLocalBooks()
  h.storage.failWriteFor(lb.STORAGE_KEY)
  await repo.addMinutes(b.localId, 4)
  h.storage.allowWriteFor(lb.STORAGE_KEY)

  // 删除时索引可写、但待补写键清不掉
  h.storage.failWriteFor(lb.PENDING_KEY)
  const res = await tapDelete(page, b.localId)
  await flush()
  h.storage.allowWriteFor(lb.PENDING_KEY)

  assert.strictEqual(res.deleted, true)
  assert.strictEqual(res.droppedPendingMinutes, 0)
  assert.strictEqual(res.reason, null)

  // 即使 pending 残留，flush 也只能丢弃、绝不重建条目
  const flushRes = await repo.flushPending()
  assert.strictEqual(flushRes.flushed, 0)
  assert.strictEqual(flushRes.dropped, 1)
  assert.strictEqual((await repo.list()).books.length, 0, '不得把已删除的书复活')
  assert.deepStrictEqual(JSON.parse(h.storage.read(lb.PENDING_KEY) || '{}'), {})
})

test('DELETED_BOOK_ENTRY_IS_FULLY_REMOVED_FROM_INDEX', async t => {
  const h = harness(t)
  const page = h.load()
  const b = await importOne(h, page, '彻底删.pdf', 1024)
  await page.loadLocalBooks()

  await tapDelete(page, b.localId)
  await flush()

  const idx = parseIndex(h.storage)
  assert.deepStrictEqual(idx.books, [], '索引中不得残留该书任何字段')
  assert.strictEqual(h.storage.read(lb.STORAGE_KEY).indexOf(b.localId), -1)
  assert.strictEqual(h.storage.read(lb.STORAGE_KEY).indexOf(b.fileName), -1)
})
