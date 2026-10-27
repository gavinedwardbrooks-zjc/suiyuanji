// ============================================================
// tests/reading-txt-page.test.js · 本机 TXT 阅读页行为测试（S5）
//
// 真实 require 并执行 pages/reading-txt/reading-txt.js：
// 通过注入的 wx 替身跑完整「打开 → 分页 → 计时结算」链路，
// 不做「只断言源码字符串」的假验证。
//
// 同时保留一条跨页断言：书架页点 TXT 必须跳内置阅读页，
// 且跳转本身不得带来任何云端文件调用或计时。
// ============================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const lb = require('../utils/localBooks')
const dp = require('../utils/readingDailyPending')
const TR = require('../utils/txtReader')
const { createReadingHarness, createTxtHarness } = require('./reading-page-harness')

const ROOT = path.resolve(__dirname, '..')
const PAGE_SRC = fs.readFileSync(path.join(ROOT, 'pages/reading-txt/reading-txt.js'), 'utf8')
const PAGE_WXML = fs.readFileSync(path.join(ROOT, 'pages/reading-txt/reading-txt.wxml'), 'utf8')
const PAGE_WXSS = fs.readFileSync(path.join(ROOT, 'pages/reading-txt/reading-txt.wxss'), 'utf8')
const READING_SRC = fs.readFileSync(path.join(ROOT, 'pages/reading/reading.js'), 'utf8')

function txtHarness(t, options) {
  const h = createTxtHarness(options)
  t.after(() => h.dispose())
  return h
}

function shelfHarness(t, options) {
  const h = createReadingHarness(options)
  t.after(() => h.dispose())
  return h
}

function flush(times) {
  const n = times || 10
  let p = Promise.resolve()
  for (let i = 0; i < n; i++) p = p.then(() => new Promise(r => setImmediate(r)))
  return p
}

function entryOf(h, localId) {
  const idx = h.parseIndex()
  return (idx && idx.books || []).find(b => b.localId === localId) || null
}

// 造一本跨多页的中文书
const LONG_TEXT = '第一章 山与海\n' + '这是一段用于分页测试的中文正文，包含标点、换行与 emoji 🚀。\n'.repeat(600)

async function openAndWait(h, localId) {
  const page = h.open({ localId })
  await page.__openResult
  await flush()
  return page
}

// ---------------- 1. 书架 → 内置阅读页 ----------------

test('SHELF_TXT_TAP_NAVIGATES_TO_BUILTIN_READER', async t => {
  const h = shelfHarness(t)
  const page = h.load()
  h.ctx.pushFile(h.seedTempFile('随笔.txt', 512))
  await page.importBook()
  const b = page.data.localBooks[0]
  assert.strictEqual(b.ext, 'txt')
  const toastBefore = h.toasts.length

  const res = await page.openLocalBook({ currentTarget: { dataset: { id: b.localId } } })

  assert.strictEqual(res.opened, true)
  assert.strictEqual(res.route, 'TXT_READER')
  assert.strictEqual(h.calls.navigateTo, 1)
  const url = h.calls.navigateToData[0].url
  assert.match(url, /^\/pages\/reading-txt\/reading-txt\?localId=/)
  assert.ok(url.indexOf(b.localId) !== -1, '必须带上 localId，绝不直传路径')
  assert.strictEqual(h.calls.openDocument, 0, 'TXT 绝不允许走 openDocument')
  assert.strictEqual(h.calls.getTempFileURL, 0)
  assert.strictEqual(h.calls.downloadFile, 0)
  assert.strictEqual(h.calls.uploadFile, 0)
  assert.strictEqual(h.toasts.length, toastBefore, '导航成功不得新增任何提示')
  assert.strictEqual(page._start, undefined, '跳转本身不得在书架页开始计时')
})

test('SHELF_TXT_HINT_POINTS_TO_READING', async t => {
  const h = shelfHarness(t)
  const page = h.load()
  h.ctx.pushFile(h.seedTempFile('提示.txt', 512))
  await page.importBook()
  assert.strictEqual(page.data.localBooks[0].localHint, '本机文件 · 点击阅读')
})

test('SHELF_TXT_NAV_FAILURE_TOASTS_AND_DOES_NOT_START_TIMER', async t => {
  const h = shelfHarness(t, { navigateToFails: true })
  const page = h.load()
  h.ctx.pushFile(h.seedTempFile('失败.txt', 512))
  await page.importBook()
  const b = page.data.localBooks[0]

  const res = await page.openLocalBook({ currentTarget: { dataset: { id: b.localId } } })
  await flush()

  assert.strictEqual(h.calls.navigateTo, 1)
  assert.strictEqual(h.lastToast().title, '打开失败，请重试')
  assert.strictEqual(page._start, undefined)
  assert.strictEqual(res.opened, true, '返回值表达「已发出跳转」，失败提示由 toast 承担')
})

// ---------------- 2. 打开与分页 ----------------

test('OPEN_RENDERS_FIRST_PAGE_FROM_LOCAL_FILE', async t => {
  const h = txtHarness(t)
  const seeded = h.seedLocalBook({ name: '山海经', text: '第一章\n山海之间\n' })
  const page = await openAndWait(h, seeded.localId)

  assert.strictEqual(page.data.mode, 'reader')
  assert.strictEqual(page.data.bookName, '山海经')
  assert.strictEqual(page.data.pageText, '第一章\n山海之间\n')
  assert.strictEqual(page.data.pageIndex, 0)
  assert.strictEqual(page.data.pageCount, 1)
  assert.strictEqual(page.data.hasPrev, false)
  assert.strictEqual(page.data.hasNext, false)
  assert.strictEqual(page.data.errorCode, '')
  assert.strictEqual(h.calls.getTempFileURL, 0)
  assert.strictEqual(h.calls.downloadFile, 0)
  assert.strictEqual(h.calls.booksUpdate.length, 0, '本机阅读绝不写云端 books')
})

test('PAGING_IS_LOSSLESS_ACROSS_PAGES', async t => {
  const h = txtHarness(t)
  const seeded = h.seedLocalBook({ name: '长文', text: LONG_TEXT })
  const page = await openAndWait(h, seeded.localId)

  assert.ok(page.data.pageCount > 1, '长文必须分页')
  const collected = [page.data.pageText]
  for (let i = 1; i < page.data.pageCount; i++) {
    const r = await page.nextPage()
    assert.strictEqual(r.ok, true)
    collected.push(page.data.pageText)
  }
  assert.strictEqual(collected.join(''), LONG_TEXT, '逐页拼接必须与原文完全一致')
  assert.strictEqual(page.data.hasNext, false)
  assert.strictEqual(page.data.pageIndex, page.data.pageCount - 1)

  const back = await page.prevPage()
  assert.strictEqual(back.ok, true)
  assert.strictEqual(page.data.pageIndex, page.data.pageCount - 2)
})

test('JUMP_TO_PAGE_AND_INPUT_VALIDATION', async t => {
  const h = txtHarness(t)
  const seeded = h.seedLocalBook({ name: '跳转', text: LONG_TEXT })
  const page = await openAndWait(h, seeded.localId)

  page.onJumpInput({ detail: { value: '3' } })
  const r = await page.jumpToPage()
  assert.strictEqual(r.ok, true)
  assert.strictEqual(page.data.pageIndex, 2)
  assert.strictEqual(page.data.jumpValue, '')

  page.onJumpInput({ detail: { value: '99999' } })
  await page.jumpToPage()
  assert.strictEqual(page.data.pageIndex, page.data.pageCount - 1, '越界页码必须夹紧，不得报错')

  const before = h.calls.readFileLog.length
  page.onJumpInput({ detail: { value: 'abc' } })
  const bad = await page.jumpToPage()
  assert.strictEqual(bad.ok, false)
  assert.strictEqual(h.lastToast().title, '请输入页码')
  assert.strictEqual(h.calls.readFileLog.length, before, '非法输入不得触发任何读取')
})

test('EACH_PAGE_READ_IS_BOUNDED_MEMORY', async t => {
  const h = txtHarness(t)
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0x41) // 2MB 纯 ASCII
  const seeded = h.seedLocalBook({ name: '大文件', bytes })
  const page = await openAndWait(h, seeded.localId)

  assert.strictEqual(page.data.pageCount, TR.effectivePageCount(bytes.length, TR.DEFAULT_PAGE_BYTES))
  const before = h.calls.readFileLog.length
  assert.strictEqual(before, 2, '首页只允许 1 次正文读 + 1 次边界探测')

  await page.nextPage()
  const afterLog = h.calls.readFileLog.slice(before)
  assert.ok(afterLog.length <= 3)
  for (const call of h.calls.readFileLog) {
    const cap = call.encoding === 'binary' ? TR.PROBE_BYTES : TR.DEFAULT_PAGE_BYTES + 3
    assert.ok(call.length > 0 && call.length <= cap, '单次读取必须被页大小约束：' + JSON.stringify(call))
  }
  assert.ok(page.data.pageText.length <= TR.DEFAULT_PAGE_BYTES, 'setData 的正文长度必须被页大小约束')
})

test('BOM_AND_UTF8_CHINESE_RENDER_CORRECTLY', async t => {
  const h = txtHarness(t)
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('你好，世界\n第二行', 'utf8')])
  const seeded = h.seedLocalBook({ name: '带 BOM', bytes })
  const page = await openAndWait(h, seeded.localId)
  assert.strictEqual(page.data.pageText, '你好，世界\n第二行')
  assert.strictEqual(page.data.encodingWarning, false)
})

test('ENCODING_ISSUE_WARNS_WITHOUT_MODIFYING_FILE', async t => {
  const h = txtHarness(t)
  const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xc4, 0xe3, 0xba, 0xc3]) // GBK 的「你好你好」
  const seeded = h.seedLocalBook({ name: 'GBK', bytes: gbk })
  const page = await openAndWait(h, seeded.localId)

  assert.strictEqual(page.data.mode, 'reader', '编码异常仍应可读，不得阻断')
  assert.strictEqual(page.data.encodingWarning, true, '必须显式提示编码异常')
  assert.deepStrictEqual(Array.from(h.fs.bytesOf(seeded.path)), Array.from(gbk), '绝不修改用户文件')
  assert.strictEqual(h.calls.unlink, 0)
})

// ---------------- 3. 失败与保护 ----------------

test('FILE_MISSING_PROMPTS_AND_KEEPS_METADATA', async t => {
  const h = txtHarness(t)
  const seeded = h.seedLocalBook({ name: '丢失的书', text: '内容' })
  h.fs.deleteFileRaw(seeded.path)
  const page = await openAndWait(h, seeded.localId)

  assert.strictEqual(page.data.mode, 'error')
  assert.strictEqual(page.data.errorCode, 'FILE_MISSING')
  assert.strictEqual(page.data.errorText, '本机文件已丢失，请重新导入')
  assert.strictEqual(page.data.missing, true)
  assert.strictEqual(h.calls.readFile, 0, '文件不存在时不得尝试读取')
  const entry = entryOf(h, seeded.localId)
  assert.ok(entry, '元数据必须保留，绝不自动删除记录')
  assert.strictEqual(entry.missing, true, '丢失标记必须落盘')
  assert.strictEqual(h.calls.unlink, 0)
  const settled = await page.settle('UNLOAD')
  assert.strictEqual(settled.settled, false, '打开失败不得产生阅读分钟')
  assert.strictEqual(entryOf(h, seeded.localId).minutes, 0)
})

test('READ_FAILURE_SHOWS_ERROR_WITHOUT_TIMER_OR_DATA_CHANGE', async t => {
  const h = txtHarness(t, { fsFails: ['readFile'] })
  const seeded = h.seedLocalBook({ name: '读不动', text: '内容' })
  const page = await openAndWait(h, seeded.localId)

  assert.strictEqual(page.data.mode, 'error')
  assert.strictEqual(page.data.errorCode, 'READ_FAILED')
  assert.strictEqual(page.data.errorText, '读取失败，请重试')
  const settled = await page.settle('UNLOAD')
  assert.strictEqual(settled.settled, false)
  assert.strictEqual(h.calls.callFunction, 0, '失败会话不得上报每日统计')
  assert.strictEqual(entryOf(h, seeded.localId).minutes, 0)
  assert.strictEqual(h.calls.unlink, 0)
  assert.deepStrictEqual(Array.from(h.fs.bytesOf(seeded.path)), Array.from(Buffer.from('内容', 'utf8')))
})

test('FILE_REMOVED_MID_READING_FALLS_BACK_TO_MISSING_STATE', async t => {
  const h = txtHarness(t)
  const seeded = h.seedLocalBook({ name: '读到一半没了', text: LONG_TEXT })
  const page = await openAndWait(h, seeded.localId)
  assert.strictEqual(page.data.mode, 'reader')

  // 文件被外部清掉，但列表/记录还没刷新：下一页读取必须落到丢失态
  h.fs.deleteFileRaw(seeded.path)
  await page.nextPage()
  assert.strictEqual(page.data.mode, 'error')
  assert.strictEqual(page.data.errorCode, 'FILE_MISSING')
  assert.strictEqual(entryOf(h, seeded.localId).missing, true)
  assert.ok(entryOf(h, seeded.localId), '记录仍然保留')

  // 文件恢复后重试必须能继续读（不重建记录、不重置进度）
  h.fs.seedFileBytes(seeded.path, Buffer.from(LONG_TEXT, 'utf8'))
  const r = await page.retry()
  assert.strictEqual(r.ok, true)
  assert.strictEqual(page.data.mode, 'reader')
})

test('INDEX_CORRUPT_REFUSES_READING_WITHOUT_REPAIR', async t => {
  const h = txtHarness(t)
  const broken = '{"version":1,"books":[{'
  h.storage.write(lb.STORAGE_KEY, broken)
  const page = await openAndWait(h, 'lb_any')

  assert.strictEqual(page.data.mode, 'error')
  assert.strictEqual(page.data.errorCode, 'INDEX_CORRUPT')
  assert.strictEqual(page.data.errorText, '本机书单异常，已暂停阅读')
  assert.strictEqual(h.storage.read(lb.STORAGE_KEY), broken, '损坏的索引一字不得改动（绝不自动 repairIndex）')
  assert.ok(h.storage.read(lb.CORRUPT_BACKUP_KEY), '损坏原文必须留下备份')
  assert.strictEqual(h.calls.readFile, 0)
  assert.strictEqual(h.calls.unlink, 0)
})

test('ENTRY_NOT_FOUND_AND_EXT_GUARDS', async t => {
  const h = txtHarness(t)
  const missingEntry = await openAndWait(h, 'lb_not_exist')
  assert.strictEqual(missingEntry.data.errorCode, 'ENTRY_NOT_FOUND')

  const h2 = txtHarness(t)
  const notLocal = h2.seedLocalBook({ name: '云端遗物', text: 'x', source: 'cloud' })
  const p2 = await openAndWait(h2, notLocal.localId)
  assert.strictEqual(p2.data.errorCode, 'NOT_LOCAL')
  assert.strictEqual(h2.calls.readFile, 0)

  const h3 = txtHarness(t)
  const pdfEntry = h3.seedLocalBook({ name: '扫描件', ext: 'pdf', text: 'x' })
  const p3 = await openAndWait(h3, pdfEntry.localId)
  assert.strictEqual(p3.data.errorCode, 'UNSUPPORTED_EXT')

  const h4 = txtHarness(t)
  const empty = h4.seedLocalBook({ name: '空文件', text: '' })
  const p4 = await openAndWait(h4, empty.localId)
  assert.strictEqual(p4.data.errorCode, 'EMPTY_FILE')

  const h5 = txtHarness(t)
  const noId = h5.open({})
  await noId.__openResult
  assert.strictEqual(noId.data.errorCode, 'NO_LOCAL_ID')
})

// ---------------- 4. 计时结算 ----------------

test('TIMER_STARTS_ONLY_AFTER_SUCCESSFUL_RENDER', async t => {
  const h = txtHarness(t)
  const seeded = h.seedLocalBook({ name: '计时', text: '内容内容' })

  const before = h.load()
  assert.strictEqual((await before.settle('HIDE')).settled, false, '未打开就不得有会话')

  const page = await openAndWait(h, seeded.localId)
  assert.strictEqual(page._session.active(), true, '渲染成功后必须有活动会话')
  assert.strictEqual(page._session.isFor(seeded.localId), true)
})

test('HIDE_AND_UNLOAD_SETTLE_EXACTLY_ONCE', async t => {
  const h = txtHarness(t)
  h.useClock()
  const seeded = h.seedLocalBook({ name: '单次结算', text: '内容' })
  const page = await openAndWait(h, seeded.localId)
  assert.strictEqual(page._session.active(), true)

  h.advanceClock(5 * 60000)
  await page.onHide()
  await page.onUnload()
  await page.settle('MANUAL')
  await flush()

  assert.strictEqual(h.calls.callFunction, 1, '每日统计只允许一次')
  assert.strictEqual(entryOf(h, seeded.localId).minutes, 5, '5 分钟必须只结算一次')
})

test('LOCAL_MINUTES_ACCUMULATE_ACROSS_SESSIONS', async t => {
  const h = txtHarness(t)
  h.useClock()
  const seeded = h.seedLocalBook({ name: '累计', text: '内容' })

  const p1 = await openAndWait(h, seeded.localId)
  h.advanceClock(60000)
  await p1.settle('UNLOAD')
  await flush()
  assert.strictEqual(entryOf(h, seeded.localId).minutes, 1)

  const p2 = await openAndWait(h, seeded.localId)
  h.advanceClock(60000)
  await p2.settle('UNLOAD')
  await flush()
  assert.strictEqual(entryOf(h, seeded.localId).minutes, 2, '两次会话必须累加而不是覆盖')
  assert.strictEqual(h.calls.callFunction, 2)
  assert.strictEqual(h.calls.callFunctionData[0].bookId, undefined, '本机书不得传 bookId')
})

test('SUB_MINUTE_READING_IS_CARRIED_NOT_INVENTED', async t => {
  const h = txtHarness(t)
  h.useClock()
  const seeded = h.seedLocalBook({ name: '读了两眼', text: '内容' })
  const page = await openAndWait(h, seeded.localId)

  h.advanceClock(20000) // 20 秒
  const res = await page.settle('UNLOAD')
  await flush()

  assert.strictEqual(res.minutes, 0, '不足一分钟绝不允许记成 1 分钟')
  assert.strictEqual(res.carryMs, 20000, '余量必须保留')
  assert.strictEqual(h.calls.callFunction, 0, '没有记账就不得调用每日统计')
  assert.strictEqual(entryOf(h, seeded.localId).minutes, 0)

  // 下一次读 40 秒 → 20 + 40 = 60 秒 → 记 1 分钟
  const p2 = await openAndWait(h, seeded.localId)
  h.advanceClock(40000)
  const res2 = await p2.settle('UNLOAD')
  await flush()
  assert.strictEqual(res2.minutes, 1)
  assert.strictEqual(entryOf(h, seeded.localId).minutes, 1)
  assert.strictEqual(h.calls.callFunction, 1)
  assert.strictEqual(h.calls.callFunctionData[0].minutes, 1, '本地与每日必须同值')
})

test('RESUME_AFTER_BACKGROUND_STARTS_A_NEW_SESSION', async t => {
  const h = txtHarness(t)
  h.useClock()
  const seeded = h.seedLocalBook({ name: '切后台回来', text: '内容' })
  const page = await openAndWait(h, seeded.localId)
  assert.strictEqual(page._session.active(), true)

  // 切后台 → 结算第一段
  h.advanceClock(2 * 60000)
  await page.onHide()
  await flush()
  assert.strictEqual(page._session.active(), false, '切后台后会话必须已结束')
  assert.strictEqual(entryOf(h, seeded.localId).minutes, 2)

  // 回到前台：已经开始读的内容还在，必须补起新会话，否则后续时间会漏记
  page.onShow()
  assert.strictEqual(page._session.active(), true, '回到前台必须重新开始计时')

  h.advanceClock(3 * 60000)
  await page.onUnload()
  await flush()
  assert.strictEqual(entryOf(h, seeded.localId).minutes, 5, '两段会话必须各结算一次且不重复')
  assert.strictEqual(h.calls.callFunction, 2, '两段会话各上报一次每日统计')
})

test('ON_SHOW_NEVER_STARTS_TIMER_BEFORE_CONTENT_IS_RENDERED', async t => {
  const h = txtHarness(t)
  const seeded = h.seedLocalBook({ name: '丢失', text: '内容' })
  h.fs.deleteFileRaw(seeded.path)

  const page = await openAndWait(h, seeded.localId)
  page.onShow()
  const res = await page.settle('UNLOAD')
  assert.strictEqual(res.settled, false, '没有渲染出内容就绝不允许起计时')
  assert.strictEqual(entryOf(h, seeded.localId).minutes, 0)
})

test('DAILY_FAILURE_KEEPS_LOCAL_MINUTES_AND_BUFFERS_PENDING', async t => {
  const h = txtHarness(t, { callFunctionFails: true })
  h.useClock()
  const seeded = h.seedLocalBook({ name: '断网', text: '内容' })
  const page = await openAndWait(h, seeded.localId)
  h.advanceClock(60000)
  const res = await page.settle('UNLOAD')
  await flush()

  assert.strictEqual(res.dailyFailed, true)
  assert.strictEqual(entryOf(h, seeded.localId).minutes, 1, '每日失败不得回滚本机分钟')
  const queue = JSON.parse(h.storage.read(dp.PENDING_KEY) || '[]')
  assert.strictEqual(queue.length, 1, '失败事实必须落待补报队列')
  assert.strictEqual(queue[0].minutes, 1)
  assert.strictEqual(queue[0].localId, seeded.localId)
  assert.ok(queue[0].requestId, '待补报条目必须带幂等 requestId')
  assert.match(h.toastTitles().join('|'), /待补报/)
  assert.ok(h.errors.some(a => String(a[0]).indexOf('DAILY_READ_SYNC_FAILED') !== -1))
})

test('DELETED_LOCAL_ID_IS_NEVER_WRITTEN', async t => {
  const h = txtHarness(t)
  h.useClock()
  const seeded = h.seedLocalBook({ name: '中途被删', text: '内容' })
  const page = await openAndWait(h, seeded.localId)

  // 模拟记录被删除（S4 路径）：从索引里摘掉该条
  const idx = h.parseIndex()
  idx.books = idx.books.filter(b => b.localId !== seeded.localId)
  h.storage.write(lb.STORAGE_KEY, JSON.stringify(idx))

  h.advanceClock(60000)
  const res = await page.settle('UNLOAD')
  await flush()
  assert.strictEqual(res.settled, true)
  assert.strictEqual(entryOf(h, seeded.localId), null, '绝不把已删除的书重新创建出来')
  assert.strictEqual(res.dailySynced, true, '书被删了，当日阅读统计仍应记上')
  assert.strictEqual(h.calls.callFunction, 1)
})

test('READING_ONE_BOOK_NEVER_TOUCHES_OTHER_BOOKS', async t => {
  const h = txtHarness(t)
  const a = h.seedLocalBook({ name: '甲', localId: 'lb_a', text: '甲的内容' })
  const b = h.seedLocalBook({ name: '乙', localId: 'lb_b', text: '乙的内容', extra: { minutes: 42, progressPercent: 66, status: 'want' } })
  const snapshot = JSON.parse(JSON.stringify(entryOf(h, b.localId)))

  const page = await openAndWait(h, a.localId)
  await page.settle('UNLOAD')
  await flush()

  assert.deepStrictEqual(entryOf(h, b.localId), snapshot, '其他书籍的所有字段一个字都不能变')
})

// ---------------- 5. 结构 / 静态审计 ----------------

test('APP_JSON_REGISTERS_TXT_READER_AND_FILES_EXIST', () => {
  const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
  assert.ok(app.pages.includes('pages/reading-txt/reading-txt'), 'app.json 必须注册阅读页')
  assert.strictEqual(app.pages[0], 'pages/home/home', '首页必须仍是第一个页面')
  for (const ext of ['js', 'json', 'wxml', 'wxss']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'pages/reading-txt/reading-txt.' + ext)), ext + ' 必须存在')
  }
})

test('READER_SOURCE_HAS_NO_CLOUD_OR_DESTRUCTIVE_CALLS', () => {
  assert.doesNotMatch(PAGE_SRC, /getTempFileURL/)
  assert.doesNotMatch(PAGE_SRC, /wx\.downloadFile/)
  assert.doesNotMatch(PAGE_SRC, /wx\.cloud\.uploadFile/)
  assert.doesNotMatch(PAGE_SRC, /wx\.cloud\.deleteFile/)
  assert.doesNotMatch(PAGE_SRC, /\.remove\(/)
  assert.doesNotMatch(PAGE_SRC, /repairIndex/)
  assert.doesNotMatch(PAGE_SRC, /openDocument/)
  assert.doesNotMatch(PAGE_SRC, /db\.collection/)
  // 只允许通过 localBooks 的只读接口读文件
  assert.match(PAGE_SRC, /repo\.readRange\(/)
  assert.match(PAGE_SRC, /repo\.statFile\(/)
  // 计时控制器必须复用，不得在本页重写一套
  assert.match(PAGE_SRC, /createReadingSession/)
})

test('READER_UI_HAS_NO_DELETE_ENTRY_AND_USES_THEME_VARS', () => {
  assert.doesNotMatch(PAGE_WXML, /deleteLocalBook/)
  assert.doesNotMatch(PAGE_WXML, /bindtap="openLocalBook"/)
  assert.match(PAGE_WXML, /scroll-view/)
  assert.doesNotMatch(PAGE_WXSS, /#[0-9A-Fa-f]{3,8}\b/, 'wxss 不得出现硬编码色值')
  assert.match(PAGE_WXSS, /var\(--/)
})

test('READER_PAGE_SOURCE_IS_REGISTERED_IN_READING_ROUTE', () => {
  assert.match(READING_SRC, /\/pages\/reading-txt\/reading-txt\?localId=/)
  assert.doesNotMatch(READING_SRC, /TXT_DEFERRED_TO_S5/)
  // 跳转不得顺手开始计时（计时统一交给阅读页）
  const from = READING_SRC.indexOf('  openLocalTxt(localId) {')
  const to = READING_SRC.indexOf('  // ============ S4')
  assert.ok(from > 0 && to > from, '必须能定位 openLocalTxt 实现')
  const openTxt = READING_SRC.slice(from, to)
  assert.doesNotMatch(openTxt, /startReadingSession/)
  assert.doesNotMatch(openTxt, /openDocument/)
  assert.doesNotMatch(openTxt, /getTempFileURL/)
})

test('READER_PAGE_FILES_ARE_BALANCED', () => {
  const views = (PAGE_WXML.match(/<view\b/g) || []).length
  const viewsEnd = (PAGE_WXML.match(/<\/view>/g) || []).length
  assert.strictEqual(views, viewsEnd, 'view 标签必须配平')
  const texts = (PAGE_WXML.match(/<text\b/g) || []).length
  const textsEnd = (PAGE_WXML.match(/<\/text>/g) || []).length
  assert.strictEqual(texts, textsEnd, 'text 标签必须配平')
  const open = (PAGE_WXSS.match(/{/g) || []).length
  const close = (PAGE_WXSS.match(/}/g) || []).length
  assert.strictEqual(open, close, 'wxss 花括号必须配平')
})
