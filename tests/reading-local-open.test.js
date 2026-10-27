// ============================================================
// tests/reading-local-open.test.js · S3 本机 PDF 打开 / 计时结算 行为测试
//
// 全部用例真实 require 并执行 pages/reading/reading.js，
// 通过注入的 wx 替身跑完整链路，不做「只断言源码字符串」的假验证。
//
// 旧云端打开能力的兼容断言保留在：
//   - tests/pdf-open-download-api.test.js（源码形状，未放宽）
//   - tests/reading-local-import.test.js::OPEN_CLOUD_BOOK_STILL_WORKS_UNCHANGED
// ============================================================
const test = require('node:test')
const assert = require('node:assert/strict')

const lb = require('../utils/localBooks')
const dp = require('../utils/readingDailyPending')
const { createReadingHarness } = require('./reading-page-harness')

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

async function importOne(h, page, name, size) {
  h.ctx.pushFile(h.seedTempFile(name, size))
  await page.importBook()
  return page.data.localBooks[0]
}

function tap(page, localId) {
  return page.openLocalBook({ currentTarget: { dataset: { id: localId } } })
}

// 让 Promise 链全部落地
function flush(times) {
  const n = times || 8
  let p = Promise.resolve()
  for (let i = 0; i < n; i++) p = p.then(() => new Promise(r => setImmediate(r)))
  return p
}

// ---------------- 1. 本地 PDF 存在 → 正确本地路径 ----------------

test('LOCAL_PDF_OPENS_FROM_RUNTIME_DERIVED_PATH', async t => {
  const h = harness(t)
  const page = h.load()
  const b = await importOne(h, page, '存在.pdf', 2048)

  const res = await tap(page, b.localId)

  assert.strictEqual(res.opened, true)
  assert.strictEqual(h.calls.openDocument, 1)
  assert.strictEqual(
    h.calls.openDocumentData[0].filePath,
    h.fs.userDataPath + '/books/' + b.fileName,
    '必须使用运行时 USER_DATA_PATH 派生的路径'
  )
  assert.strictEqual(h.calls.openDocumentData[0].fileType, 'pdf')
})

test('LOCAL_PDF_PATH_IGNORES_STALE_STORED_FILEPATH', async t => {
  // 导入时快照的 filePath 协议可能与当前运行环境不同（真机 wxfile:// / 工具 http://）
  // → 打开时必须忽略它，重新按 USER_DATA_PATH 派生
  const h = harness(t)
  const page = h.load()
  const b = await importOne(h, page, 'stale.pdf', 1024)

  const idx = parseIndex(h.storage)
  idx.books[0].filePath = 'http://tmp/stale-protocol.pdf'
  h.storage.write(lb.STORAGE_KEY, JSON.stringify(idx))

  const page2 = h.reload()
  await page2.loadLocalBooks()
  const res = await tap(page2, b.localId)

  assert.strictEqual(res.opened, true)
  assert.strictEqual(
    h.calls.openDocumentData[0].filePath,
    h.fs.userDataPath + '/books/' + b.fileName
  )
  assert.notStrictEqual(h.calls.openDocumentData[0].filePath, 'http://tmp/stale-protocol.pdf')
})

// ---------------- 2. 零 CloudBase 文件下载调用 ----------------

test('LOCAL_PDF_OPEN_MAKES_ZERO_CLOUD_FILE_CALLS', async t => {
  const h = harness(t)
  h.useClock()
  const page = h.load()
  const b = await importOne(h, page, 'zero.pdf', 4096)

  await tap(page, b.localId)
  await flush()

  // 打开阶段：只允许 openDocument，绝不允许任何云端文件操作
  assert.strictEqual(h.calls.getTempFileURL, 0, '不得调 getTempFileURL')
  assert.strictEqual(h.calls.downloadFile, 0, '不得调 downloadFile')
  assert.strictEqual(h.calls.uploadFile, 0)
  assert.strictEqual(h.calls.deleteFile, 0)
  assert.strictEqual(h.calls.booksUpdate.length, 0, '本机书不得写云端 books')
  assert.strictEqual(h.calls.callFunction, 0, '未结算前不得产生每日统计调用')

  // 结算后：每日统计允许，但绝不带 bookId（云函数因此不会触碰云端 books）
  h.advanceClock(60000)
  const settled = await page.settleSession('TEST')
  await flush()

  assert.strictEqual(settled.settled, true)
  assert.strictEqual(settled.minutes, 1)
  assert.strictEqual(settled.dailySynced, true, '成功必须如实回报')
  assert.strictEqual(settled.dailyFailed, false)
  assert.strictEqual(h.calls.callFunction, 1)
  assert.strictEqual(h.calls.callFunctionData[0].bookId, undefined, '本机书不得把 bookId 传给云函数')
  assert.strictEqual(h.calls.callFunctionData[0].action, 'addRead')
  assert.strictEqual(h.calls.callFunctionData[0].requestId !== undefined && h.calls.callFunctionData[0].requestId !== null, true, '必须带幂等 requestId')
  assert.strictEqual(h.calls.booksUpdate.length, 0, '结算后仍不得写云端 books')
})

// ---------------- 3. 文件缺失 → 不调 openDocument ----------------

test('MISSING_FILE_MARKS_MISSING_WITHOUT_OPENING', async t => {
  const h = harness(t)
  const page = h.load()
  const b = await importOne(h, page, 'lost.pdf', 1024)
  const full = h.fs.userDataPath + '/books/' + b.fileName
  h.fs.deleteFileRaw(full) // 文件被外部删除，列表尚未刷新

  const res = await tap(page, b.localId)

  assert.strictEqual(res.opened, false)
  assert.strictEqual(res.reason, 'FILE_MISSING')
  assert.strictEqual(h.calls.openDocument, 0, '文件不存在绝不调 openDocument')
  assert.strictEqual(h.calls.getTempFileURL, 0)
  assert.strictEqual(h.calls.downloadFile, 0)
  assert.strictEqual(h.lastToast().title, '本机文件已丢失，请重新导入')

  const e = entryOf(h, b.localId)
  assert.ok(e, '元数据必须保留，不得自动删除记录')
  assert.strictEqual(e.missing, true, '必须落盘 missing 标记')
  assert.strictEqual(e.name, 'lost')
})

test('MISSING_FILE_DOES_NOT_START_READING_TIMER', async t => {
  const h = harness(t)
  const page = h.load()
  const b = await importOne(h, page, 'lost2.pdf', 1024)
  h.fs.deleteFileRaw(h.fs.userDataPath + '/books/' + b.fileName)

  await tap(page, b.localId)
  await flush()

  assert.ok(!page._start, '打开失败不得留下会话')
  assert.strictEqual(h.calls.callFunction, 0, '失败不得产生每日阅读分钟')
  assert.strictEqual(entryOf(h, b.localId).minutes, 0)
})

// ---------------- 4. openDocument 失败 → 不开始计时 ----------------

test('OPEN_DOCUMENT_FAILURE_STARTS_NO_TIMER', async t => {
  const h = harness(t, { openDocumentFails: true })
  const page = h.load()
  const b = await importOne(h, page, 'broken.pdf', 1024)

  const res = await tap(page, b.localId)
  await flush()

  assert.strictEqual(res.opened, false)
  assert.strictEqual(res.reason, 'OPEN_DOCUMENT_FAILED')
  assert.strictEqual(h.calls.openDocument, 1)
  assert.ok(!page._start, '打开失败不得开始计时')
  assert.ok(!page._localId)
  assert.strictEqual(h.calls.callFunction, 0, '打开失败不得产生阅读分钟')
  assert.strictEqual(h.lastToast().title, '打开失败，请重试')
})

// ---------------- 5. TXT → 跳内置阅读页，仍不进 PDF 打开流程 ----------------
// S5 起本地 TXT 不再停在书架页，而是跳转 pages/reading-txt（openDocument 的
// fileType 合法值不含 txt）。断言强度不变：依旧零 openDocument、零云端回落。

test('LOCAL_TXT_ROUTED_TO_BUILTIN_READER_NOT_PDF_OPEN', async t => {
  const h = harness(t)
  const page = h.load()
  const b = await importOne(h, page, '笔记.txt', 512)
  assert.strictEqual(b.ext, 'txt')
  const toastBefore = h.toasts.length

  const res = await tap(page, b.localId)
  await flush()

  assert.strictEqual(res.opened, true)
  assert.strictEqual(res.route, 'TXT_READER')
  assert.strictEqual(h.calls.openDocument, 0, 'TXT 不得进 openDocument')
  assert.strictEqual(h.calls.getTempFileURL, 0)
  assert.strictEqual(h.calls.downloadFile, 0)
  assert.strictEqual(h.calls.navigateTo, 1, '必须跳转内置阅读页')
  assert.match(h.calls.navigateToData[0].url, /^\/pages\/reading-txt\/reading-txt\?localId=/)
  assert.ok(h.calls.navigateToData[0].url.indexOf(b.localId) !== -1)
  assert.strictEqual(h.toasts.length, toastBefore, '跳转成功不得出现失败提示')
  assert.ok(!page._start, '跳转本身不得在书架页开始计时')
  assert.strictEqual(b.localHint, '本机文件 · 点击阅读')
})

test('LOCAL_TXT_NAV_FAILURE_REPORTS_AND_STILL_NO_CLOUD_FALLBACK', async t => {
  const h = harness(t, { navigateToFails: true })
  const page = h.load()
  const b = await importOne(h, page, '跳转失败.txt', 512)

  await tap(page, b.localId)
  await flush()

  assert.strictEqual(h.calls.navigateTo, 1)
  assert.strictEqual(h.lastToast().title, '打开失败，请重试')
  assert.strictEqual(h.calls.openDocument, 0, '跳转失败也绝不允许回落到 openDocument')
  assert.strictEqual(h.calls.getTempFileURL, 0)
  assert.strictEqual(h.calls.downloadFile, 0)
  assert.ok(!page._start)
})

// ---------------- 6. 云端旧书籍 → 原有打开行为保持 ----------------

test('CLOUD_LEGACY_OPEN_PATH_UNCHANGED', async t => {
  const h = harness(t)
  const page = h.load()
  const cloudBook = { _id: 'c9', name: '云书', fileID: 'cloud://x', ext: 'pdf' }

  page.openBook({ currentTarget: { dataset: { b: cloudBook } } })
  await flush()

  assert.strictEqual(h.calls.getTempFileURL, 1, '云端书仍走 getTempFileURL')
  assert.strictEqual(h.calls.downloadFile, 1)
  assert.strictEqual(h.calls.openDocument, 1)
  assert.strictEqual(h.calls.openDocumentData[0].fileType, 'pdf')
  assert.ok(page._start, '云端书打开成功仍需计时')
  assert.strictEqual(page._bookId, 'c9')
})

test('CLOUD_BOOK_SETTLE_KEEPS_BOOKID_AND_BOOKS_UPDATE', async t => {
  const cloudBook = { _id: 'cA', name: '云书A', fileID: 'cloud://a', ext: 'pdf', minutes: 0 }
  const h = harness(t, { cloudDb: true, cloudBooks: [cloudBook] })
  h.useClock()
  const page = h.load()

  page.openBook({ currentTarget: { dataset: { b: cloudBook } } })
  await flush()
  h.advanceClock(2 * 60000)
  await page.settleSession('TEST')
  await flush()

  assert.strictEqual(h.calls.callFunctionData[0].bookId, 'cA', '云端书继续带 bookId')
  // 单一写入方（2026-10-16）：books.minutes 由云函数在同一个事务里累加，
  // 客户端不再直写 —— 之前两个写入方会让每次结算累计两次。
  assert.deepStrictEqual(h.calls.booksUpdate, [], '客户端不得直写云端 books')
  assert.strictEqual(h.cloud.book('cA').minutes, 2, '云端 books.minutes 由云函数恰好 +2')
  assert.strictEqual(h.cloud.record().readProgress, 2, '与 readProgress 同事务、数值一致')
})

test('CLOUD_BOOK_WITHOUT_FILEID_STILL_REFUSES', async t => {
  const h = harness(t)
  const page = h.load()
  page.openBook({ currentTarget: { dataset: { b: { _id: 'm1', name: '手动书单' } } } })
  await flush()
  assert.strictEqual(h.calls.getTempFileURL, 0)
  assert.strictEqual(h.lastToast().title, '这是手动书单记录')
})

// ---------------- 7. onHide / onUnload 单次结算 ----------------

test('HIDE_AND_UNLOAD_SETTLE_EXACTLY_ONCE', async t => {
  const h = harness(t)
  h.useClock()
  const page = h.load()
  const b = await importOne(h, page, 'once.pdf', 1024)
  await tap(page, b.localId)

  h.advanceClock(90000) // 90 秒 = 1 整分钟 + 30 秒余量
  await page.onHide()
  await page.onUnload()
  await flush()

  assert.strictEqual(h.calls.callFunction, 1, '两次触发只能结算一次')
  assert.strictEqual(entryOf(h, b.localId).minutes, 1)
  assert.strictEqual(h.calls.callFunctionData[0].minutes, 1, '本地单书分钟与每日阅读分钟必须同值')
})

test('HIDE_PAUSES_AND_SHOW_RESUMES_WITHOUT_LOSING_OR_INVENTING_TIME', async t => {
  const h = harness(t)
  h.useClock()
  const page = h.load()
  const b = await importOne(h, page, 'resume.pdf', 1024)
  await tap(page, b.localId)

  // 第一段 40 秒：不足一分钟 → 不记分钟、不调云端，余量必须保留
  h.advanceClock(40000)
  const first = await page.onHide()
  await flush()
  assert.strictEqual(first.settled, true)
  assert.strictEqual(first.minutes, 0, '不足一分钟绝不允许强行记成 1 分钟')
  assert.strictEqual(h.calls.callFunction, 0, '不足一分钟不得调用每日统计')
  assert.strictEqual(entryOf(h, b.localId).minutes, 0)
  assert.strictEqual(first.carryMs, 40000, '余量必须原样保留')

  // 回到前台：必须自动接着计时
  page.onShow()
  assert.strictEqual(page._rs.active(), true, '从后台回来必须重新开始计时')
  assert.strictEqual(page._localId, b.localId)

  // 第二段 30 秒：40 + 30 = 70 秒 → 记 1 分钟，余量 10 秒
  h.advanceClock(30000)
  const second = await page.onUnload()
  await flush()
  assert.strictEqual(second.minutes, 1, '两段合计满一分钟才记 1 分钟')
  assert.strictEqual(second.carryMs, 10000)
  assert.strictEqual(h.calls.callFunction, 1, '每日统计只调一次')
  assert.strictEqual(entryOf(h, b.localId).minutes, 1)
  assert.strictEqual(h.calls.callFunctionData[0].minutes, 1)
})

test('SUB_MINUTE_SESSIONS_NEVER_RECORD_AND_NEVER_LOSE_CARRY', async t => {
  const h = harness(t)
  h.useClock()
  const page = h.load()
  const b = await importOne(h, page, 'carry.pdf', 1024)

  // 三次 20 秒 = 60 秒 → 第 3 次才记 1 分钟
  const expected = [0, 0, 1]
  for (let i = 0; i < 3; i++) {
    await tap(page, b.localId)
    h.advanceClock(20000)
    const res = await page.settleSession('TEST')
    await flush()
    assert.strictEqual(res.minutes, expected[i], '第 ' + (i + 1) + ' 次结算分钟数错误')
    assert.strictEqual(entryOf(h, b.localId).minutes, expected[i])
  }
  assert.strictEqual(h.calls.callFunction, 1, '只有真正记账的那一次才调用每日统计')
  assert.strictEqual(h.calls.callFunctionData[0].minutes, 1)
  assert.strictEqual(h.calls.booksUpdate.length, 0)
})

test('SETTLE_WITHOUT_SESSION_IS_NOOP', async t => {
  const h = harness(t)
  const page = h.load()
  const r = await page.stopTimer()
  assert.strictEqual(r.settled, false)
  assert.strictEqual(r.reason, 'NO_ACTIVE_SESSION')
  assert.strictEqual(h.calls.callFunction, 0)
})

test('REPEATED_TAP_WHILE_OPENING_IS_IGNORED', async t => {
  const h = harness(t)
  const page = h.load()
  const b = await importOne(h, page, 'double.pdf', 1024)

  const p1 = tap(page, b.localId)
  const p2 = tap(page, b.localId)
  const [r1, r2] = await Promise.all([p1, p2])
  await flush()

  assert.strictEqual(r1.opened, true)
  assert.strictEqual(r2.opened, false)
  assert.strictEqual(r2.reason, 'OPEN_IN_FLIGHT')
  assert.strictEqual(h.calls.openDocument, 1, '重复点击不得重复打开')
})

test('OPEN_AFTER_ENTRY_REMOVED_DOES_NOT_FABRICATE_MISSING', async t => {
  const h = harness(t)
  const page = h.load()
  const b = await importOne(h, page, 'gone.pdf', 1024)

  // 记录在别处被移除，页面列表尚未刷新
  const idx = parseIndex(h.storage)
  idx.books = []
  h.storage.write(lb.STORAGE_KEY, JSON.stringify(idx))

  const res = await tap(page, b.localId)

  assert.strictEqual(res.opened, false)
  assert.strictEqual(res.reason, 'ENTRY_NOT_FOUND')
  assert.strictEqual(h.calls.openDocument, 0)
  assert.strictEqual(h.lastToast().title, '本机记录已失效，请重新进入页面')
  assert.strictEqual(entryOf(h, b.localId), null, '不得凭空重建记录')
  assert.strictEqual(h.fs.hasFile(h.fs.userDataPath + '/books/' + b.fileName), true, '不得删文件')
})

// ---------------- 8. 本地 minutes 正确累计 ----------------

test('LOCAL_MINUTES_ACCUMULATE_PER_SESSION', async t => {
  const h = harness(t)
  h.useClock()
  const page = h.load()
  const b = await importOne(h, page, 'acc.pdf', 1024)

  for (let i = 1; i <= 3; i++) {
    await tap(page, b.localId)
    h.advanceClock(60000)
    await page.settleSession('TEST')
    await flush()
    assert.strictEqual(entryOf(h, b.localId).minutes, i, '第 ' + i + ' 次会话后应为 ' + i + ' 分钟')
  }
  assert.strictEqual(h.calls.booksUpdate.length, 0, '本机分钟绝不写云端 books')
  // 多次打开同一本书：每次都只上报一次每日统计，且金额与本地一致
  assert.strictEqual(h.calls.callFunction, 3)
  for (const d of h.calls.callFunctionData) assert.strictEqual(d.minutes, 1)
})

test('LOCAL_MINUTES_WRITE_FAILURE_IS_BUFFERED_NOT_LOST', async t => {
  const h = harness(t)
  h.useClock()
  const page = h.load()
  const b = await importOne(h, page, 'buf.pdf', 1024)
  await tap(page, b.localId)

  h.storage.failWriteFor(lb.STORAGE_KEY)
  h.advanceClock(60000)
  await page.settleSession('TEST')
  await flush()

  // 索引写失败 → 增量必须进待补写键
  const pending = JSON.parse(h.storage.read(lb.PENDING_KEY) || '{}')
  assert.strictEqual(pending[b.localId], 1, '本地分钟不得静默丢失')

  h.storage.allowWriteFor(lb.STORAGE_KEY)
  const page2 = h.reload()
  await page2.loadLocalBooks()
  assert.strictEqual(page2.data.localBooks[0].minutes, 1, '重新进入后必须补写回来')
})

// ---------------- 9. 每日阅读分钟不重复累计 ----------------

test('DAILY_READ_COUNTED_ONCE_PER_SESSION', async t => {
  const h = harness(t)
  h.useClock()
  const page = h.load()
  const b = await importOne(h, page, 'daily.pdf', 1024)
  await tap(page, b.localId)

  h.advanceClock(60000)
  await page.onHide()
  await page.onUnload()
  const again = await page.stopTimer()
  await flush()

  assert.strictEqual(again.settled, false, '重复触发必须被识别为无会话')
  assert.strictEqual(h.calls.callFunction, 1, '每日统计只允许一次')
  const d = h.calls.callFunctionData[0]
  assert.strictEqual(d.action, 'addRead')
  assert.strictEqual(d.minutes, 1)
  assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/)
})

// ---------------- 10. 云端统计失败 → 本地阅读记录不丢失 ----------------

test('DAILY_SYNC_FAILURE_KEEPS_LOCAL_MINUTES_AND_QUEUES_PENDING', async t => {
  const h = harness(t, { callFunctionFails: true })
  h.useClock()
  const page = h.load()
  const b = await importOne(h, page, 'offline.pdf', 1024)
  await tap(page, b.localId)

  const before = JSON.parse(h.storage.read(dp.PENDING_KEY) || '[]').length
  h.advanceClock(60000)
  const settled = await page.settleSession('TEST')
  await flush()

  assert.strictEqual(settled.settled, true)
  assert.strictEqual(settled.dailyFailed, true, '失败必须如实回报')
  assert.strictEqual(settled.dailySynced, false)

  // 本地分钟照常保存
  assert.strictEqual(entryOf(h, b.localId).minutes, 1, '云端失败不得回滚本地分钟')
  assert.strictEqual(page.data.localBooks[0].minutes, 1)

  // 待补报队列必须显式落地，且带幂等 requestId（可安全重放）
  const q = JSON.parse(h.storage.read(dp.PENDING_KEY) || '[]')
  assert.strictEqual(q.length, before + 1, '失败必须进待补报队列，不得静默丢弃')
  assert.strictEqual(q[q.length - 1].minutes, 1)
  assert.strictEqual(q[q.length - 1].localId, b.localId)
  assert.match(q[q.length - 1].date, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(q[q.length - 1].requestId, '待补报条目必须带幂等 requestId')

  assert.strictEqual(page.data.localBooks.length, 1, '记录不得被删除')
  assert.ok(h.toastTitles().some(x => /待补报/.test(String(x))), '必须有用户可见的失败提示')
})

test('DAILY_NOT_OK_RESULT_IS_TREATED_AS_FAILURE', async t => {
  const h = harness(t, { callFunctionResult: { ok: false, code: 'BAD_ARGS' } })
  h.useClock()
  const page = h.load()
  const b = await importOne(h, page, 'badres.pdf', 1024)
  await tap(page, b.localId)
  h.advanceClock(60000)
  await page.settleSession('TEST')
  await flush()

  assert.strictEqual(entryOf(h, b.localId).minutes, 1)
  const q = JSON.parse(h.storage.read(dp.PENDING_KEY) || '[]')
  assert.strictEqual(q.length, 1, 'ok!==true 也必须记为待补报')
})

// ---------------- 辅助：待补报队列本身的契约 ----------------

test('DAILY_PENDING_QUEUE_REJECTS_MALFORMED_ENTRIES', () => {
  assert.strictEqual(dp.normalizeEntry(null), null)
  assert.strictEqual(dp.normalizeEntry({ date: 'bad', minutes: 3 }), null)
  assert.strictEqual(dp.normalizeEntry({ date: '2026-10-15', minutes: 0 }), null)
  assert.strictEqual(dp.normalizeEntry({ date: '2026-10-15', minutes: 2 }).minutes, 2)
  assert.deepStrictEqual(dp.normalizeQueue('{not json'), [])
  // 上限仍生效：内容互不相同的条目被裁剪到上限
  const distinct = []
  for (let i = 0; i < 80; i++) {
    distinct.push({ date: '2026-10-15', minutes: 1, requestId: 'r' + i, at: i })
  }
  assert.strictEqual(dp.normalizeQueue(JSON.stringify(distinct)).length, dp.MAX_ENTRIES)
  // 同一 requestId 的重复条目必须合并（否则重放会重复累计）
  const dup = new Array(80).fill({ date: '2026-10-15', minutes: 1, requestId: 'same' })
  assert.strictEqual(dp.normalizeQueue(JSON.stringify(dup)).length, 1)
})
