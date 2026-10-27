// ============================================================
// tests/txt-reader.test.js · 本机 TXT 分页阅读器行为测试（S5）
//
// 两条主线：
//   1. 正确性：按字节切页时不得切坏 UTF-8 字符（中文 / emoji / BOM）
//   2. 内存有界：任何一次读取的长度都必须被页大小硬性约束住
// 全部用例真实调用 utils/txtReader.js，用 Buffer 精确控制字节边界。
// ============================================================
const test = require('node:test')
const assert = require('node:assert/strict')

const R = require('../utils/txtReader')

// 用真实 Buffer 做一个读取后端：position / length 就是字节，绝不整文件读
function makeBackend(bytes, opts) {
  const o = opts || {}
  const log = []
  let failText = o.failText === true
  let failProbe = o.failProbe === true
  const readRange = req => {
    log.push({ offset: req.offset, length: req.length, encoding: req.encoding })
    const enc = String(req.encoding || 'utf8').toLowerCase()
    if (enc === 'binary') {
      if (failProbe) return Promise.resolve({ ok: false, reason: 'PROBE_FAILED' })
      return Promise.resolve({ ok: true, data: bytes.subarray(req.offset, req.offset + req.length).toString('latin1') })
    }
    if (failText) return Promise.resolve({ ok: false, reason: 'READ_FAILED' })
    return Promise.resolve({ ok: true, data: bytes.subarray(req.offset, req.offset + req.length).toString('utf8') })
  }
  return {
    log,
    readRange,
    reader: createReader(bytes, readRange, o.pageBytes),
    setFailText(v) { failText = v },
    setFailProbe(v) { failProbe = v }
  }
}

function createReader(bytes, readRange, pageBytes) {
  return R.createTxtReader({ size: bytes.length, pageBytes: pageBytes || 10, readRange })
}

async function readAll(reader, pageBytes) {
  const out = []
  for (let i = 0; i < reader.pageCount; i++) {
    const res = await reader.readPage(i)
    assert.strictEqual(res.ok, true, '第 ' + i + ' 页必须可读')
    out.push(res)
  }
  return out
}

// ---------------- 纯函数 ----------------

test('PURE_IS_CONTINUATION_BYTE', () => {
  assert.strictEqual(R.isContinuationByte(0x80), true)
  assert.strictEqual(R.isContinuationByte(0xbf), true)
  assert.strictEqual(R.isContinuationByte(0xc0), false)
  assert.strictEqual(R.isContinuationByte(0x41), false) // 'A'
})

test('PURE_FIND_CHAR_START_SKIPS_CONTINUATION_BYTES', () => {
  // 汉字「中」= E4 B8 AD，续字节为 B8 / AD
  const bin = String.fromCharCode(0xe4, 0xb8, 0xad, 0x41)
  assert.strictEqual(R.findCharStart(bin, 0), 0, '起点本身即字符起点')
  assert.strictEqual(R.findCharStart(bin, 1), 3, '落在续字节上必须前移到下一个起点')
  assert.strictEqual(R.findCharStart(bin, 2), 3)
  assert.strictEqual(R.findCharStart(bin, 3), 3)
  assert.strictEqual(R.findCharStart(bin, 9), -1, '越界找不到起点')
})

test('PURE_STRIP_BOM_ONLY_AT_HEAD', () => {
  assert.strictEqual(R.stripBom('\uFEFF你好'), '你好')
  assert.strictEqual(R.stripBom('你好\uFEFF'), '你好\uFEFF', '只去头部 BOM，不动正文')
  assert.strictEqual(R.stripBom('你好'), '你好')
})

test('PURE_HAS_ENCODING_ISSUE', () => {
  assert.strictEqual(R.hasEncodingIssue('正常中文'), false)
  assert.strictEqual(R.hasEncodingIssue('a\uFFFDb'), true)
  assert.strictEqual(R.hasEncodingIssue(null), false)
})

test('PURE_PAGE_COUNT_AND_CLAMP', () => {
  assert.strictEqual(R.pageCountOf(0, 8192), 0)
  assert.strictEqual(R.pageCountOf(-1, 8192), 0)
  assert.strictEqual(R.pageCountOf(1, 8192), 1)
  assert.strictEqual(R.pageCountOf(8192, 8192), 1)
  assert.strictEqual(R.pageCountOf(8193, 8192), 2)
  assert.strictEqual(R.pageCountOf(100, 0), 0, '页大小非法 → 0 页')
  assert.strictEqual(R.clampPageIndex(5, 3), 2)
  assert.strictEqual(R.clampPageIndex(-5, 3), 0)
  assert.strictEqual(R.clampPageIndex(1, 0), -1)
})

test('PURE_RAW_RANGE_LAST_PAGE_ENDS_AT_SIZE', () => {
  assert.deepStrictEqual(R.rawRange(0, 100, 30), { index: 0, start: 0, end: 30, isLast: false })
  assert.deepStrictEqual(R.rawRange(3, 100, 30), { index: 3, start: 90, end: 100, isLast: true })
  assert.strictEqual(R.rawRange(0, 0, 30), null)
})

test('PURE_EFFECTIVE_PAGE_COUNT_MERGES_TINY_TAIL', () => {
  assert.strictEqual(R.effectivePageCount(100, 30), 4, '尾页 10 字节 → 保留')
  assert.strictEqual(R.effectivePageCount(31, 30), 1, '尾页 1 字节 → 并入上一页')
  assert.strictEqual(R.effectivePageCount(32, 30), 1, '尾页 2 字节 → 并入')
  assert.strictEqual(R.effectivePageCount(33, 30), 1, '尾页 3 字节 → 并入')
  assert.strictEqual(R.effectivePageCount(34, 30), 2, '尾页 4 字节 → 保留')
  assert.strictEqual(R.effectivePageCount(66, 5), 13, '汉字 3 字节 + 5 字节页 → 末尾 1 字节并入')
  assert.strictEqual(R.effectivePageCount(0, 30), 0)
  assert.strictEqual(R.effectivePageCount(100, 0), 0)
})

test('NO_EMPTY_PAGE_EVEN_WHEN_TAIL_CROSSES_CHAR_BOUNDARY', async () => {
  // 文件末尾正好切在汉字的中间字节上：对齐后末页曾会变成空页
  const pageBytes = 8192
  const bytes = Buffer.from('汉'.repeat(8200), 'utf8') // 24600 字节
  const b = makeBackend(bytes, { pageBytes })
  const ranges = []
  for (let i = 0; i < b.reader.pageCount; i++) ranges.push(await b.reader.byteRange(i))
  for (const r of ranges) assert.ok(r.end > r.start, '第 ' + r.index + ' 页不得为空页')
  const pages = await readAll(b.reader)
  assert.strictEqual(pages.map(p => p.text).join(''), '汉'.repeat(8200))
  assert.strictEqual(pages.some(p => p.encodingIssue), false)
})

// ---------------- 分页正确性 ----------------

test('CHINESE_TEXT_PAGINATES_LOSSLESSLY_AT_TINY_PAGE_SIZE', async () => {
  const text = '春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。'
  const bytes = Buffer.from(text, 'utf8')
  for (const pageBytes of [5, 7, 10, 13, 31, 64, 4096]) {
    const b = makeBackend(bytes, { pageBytes })
    const pages = await readAll(b.reader)
    const joined = pages.map(p => p.text).join('')
    assert.strictEqual(joined, text, 'pageBytes=' + pageBytes + ' 时必须逐字无损')
    assert.strictEqual(pages.some(p => p.encodingIssue), false, 'pageBytes=' + pageBytes + ' 时不得出现替换字符')
  }
})

test('MIXED_ASCII_EMOJI_NEWLINE_PAGINATES_LOSSLESSLY', async () => {
  // emoji 是 4 字节字符，最容易在按字节切页时被切碎
  const text = 'line1\n中文abc🚀🎉\nline2\ttab\r\n结束'
  const bytes = Buffer.from(text, 'utf8')
  for (const pageBytes of [4, 6, 11, 29, 128]) {
    const b = makeBackend(bytes, { pageBytes })
    const pages = await readAll(b.reader)
    assert.strictEqual(pages.map(p => p.text).join(''), text, 'pageBytes=' + pageBytes)
    assert.strictEqual(pages.some(p => p.encodingIssue), false, 'pageBytes=' + pageBytes + ' 时不得误报编码异常')
  }
})

test('PAGES_PARTITION_BYTES_WITHOUT_GAP_OR_OVERLAP', async () => {
  const bytes = Buffer.from('中文混排内容'.repeat(30), 'utf8')
  const b = makeBackend(bytes, { pageBytes: 17 })
  const ranges = []
  for (let i = 0; i < b.reader.pageCount; i++) ranges.push(await b.reader.byteRange(i))
  assert.strictEqual(ranges[0].start, 0)
  assert.strictEqual(ranges[ranges.length - 1].end, bytes.length, '最后一页必须覆盖到文件末尾')
  for (let i = 1; i < ranges.length; i++) {
    assert.strictEqual(ranges[i].start, ranges[i - 1].end, '相邻页必须首尾相接，不漏不叠')
  }
  for (const r of ranges) {
    assert.ok(r.end > r.start, '不得出现空页')
    assert.ok(r.end - r.start <= 17 + 3, '单页字节数不得超过页大小 + 3')
  }
})

test('EVERY_READ_IS_BOUNDED_BY_PAGE_SIZE', async () => {
  const bytes = Buffer.from('有界读取验证'.repeat(4000), 'utf8') // ~48KB
  const pageBytes = 8192
  const b = makeBackend(bytes, { pageBytes })
  assert.strictEqual(b.reader.pageCount, R.effectivePageCount(bytes.length, pageBytes))
  const first = await b.reader.readPage(0)
  assert.strictEqual(first.ok, true)
  for (const call of b.log) {
    assert.ok(call.length > 0, '不得出现「不传 length 就读全文件」的调用')
    const cap = call.encoding === 'binary' ? R.PROBE_BYTES : pageBytes + 3
    assert.ok(call.length <= cap, '单次读取不得超过 ' + cap + ' 字节，实际 ' + call.length)
  }
  // 单页开销：1 次正文读 + 最多 2 次字节探测
  assert.ok(b.log.length <= 3, '单页读取次数必须很少，实际 ' + b.log.length)
  assert.strictEqual(b.log.filter(c => c.encoding !== 'binary').length, 1)
})

test('LARGE_FILE_DOES_NOT_READ_WHOLE_FILE', async () => {
  const size = 5 * 1024 * 1024 // 5MB
  const bytes = Buffer.alloc(size, 0x41) // 全 'A'
  const b = makeBackend(bytes, { pageBytes: 8192 })
  assert.strictEqual(b.reader.pageCount, R.effectivePageCount(size, 8192))
  const res = await b.reader.readPage(3)
  assert.strictEqual(res.ok, true)
  const totalBytesRead = b.log.reduce((s, c) => s + c.length, 0)
  assert.ok(totalBytesRead < 9000, '读一页只应读 8KB 级，实际 ' + totalBytesRead)
})

// ---------------- BOM / 编码 ----------------

test('BOM_STRIPPED_ON_FIRST_PAGE_ONLY', async () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('你好世界', 'utf8')])
  const b = makeBackend(bytes, { pageBytes: 4 })
  const pages = await readAll(b.reader)
  assert.strictEqual(pages[0].text.startsWith('\uFEFF'), false, '首页不得带 BOM')
  assert.strictEqual(pages.map(p => p.text).join(''), '你好世界')
  assert.strictEqual(pages[1].text.indexOf('\uFEFF'), -1)
})

test('NON_UTF8_BYTES_REPORT_ENCODING_ISSUE_WITHOUT_FIXING', async () => {
  // 「你好」的 GBK 编码，按 UTF-8 解必然产出替换字符
  const bytes = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xc4, 0xe3, 0xba, 0xc3])
  const b = makeBackend(bytes, { pageBytes: 4096 })
  const res = await b.reader.readPage(0)
  assert.strictEqual(res.ok, true, '编码异常仍应可读，不得报错中断')
  assert.strictEqual(res.encodingIssue, true, '必须显式上报编码异常')
  assert.deepStrictEqual(Array.from(bytes), [0xc4, 0xe3, 0xba, 0xc3, 0xc4, 0xe3, 0xba, 0xc3], '读取不得改动任何字节')
})

// ---------------- 异常 ----------------

test('READ_FAILURE_IS_RESOLVED_NOT_THROWN', async () => {
  const bytes = Buffer.from('任意内容', 'utf8')
  const b = makeBackend(bytes, { pageBytes: 4 })
  b.setFailText(true)
  const res = await b.reader.readPage(0)
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.reason, 'READ_FAILED')
})

test('PROBE_FAILURE_FALLS_BACK_AND_WARNS', async () => {
  const bytes = Buffer.from('中文中文中文', 'utf8')
  const warns = []
  const reader = R.createTxtReader({
    size: bytes.length,
    pageBytes: 5,
    onWarn: (tag, info) => warns.push({ tag, info }),
    readRange: req => {
      if (req.encoding === 'binary') return Promise.resolve({ ok: false, reason: 'PROBE_FAILED' })
      return Promise.resolve({ ok: true, data: bytes.subarray(req.offset, req.offset + req.length).toString('utf8') })
    }
  })
  const res = await reader.readPage(1)
  assert.strictEqual(res.ok, true, '探测失败不得阻断阅读')
  assert.strictEqual(warns[0].tag, 'ALIGN_PROBE_FAILED')
})

test('EMPTY_FILE_HAS_ZERO_PAGES', async () => {
  const b = makeBackend(Buffer.alloc(0), { pageBytes: 4096 })
  assert.strictEqual(b.reader.pageCount, 0)
  assert.strictEqual(b.reader.isEmpty, true)
  const res = await b.reader.readPage(0)
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.reason, 'PAGE_OUT_OF_RANGE')
})

test('OUT_OF_RANGE_INDEX_IS_CLAMPED_NOT_CRASHED', async () => {
  const bytes = Buffer.from('一二三四五六七八九十', 'utf8')
  const b = makeBackend(bytes, { pageBytes: 6 })
  const high = await b.reader.readPage(999)
  assert.strictEqual(high.ok, true)
  assert.strictEqual(high.index, b.reader.pageCount - 1)
  const low = await b.reader.readPage(-3)
  assert.strictEqual(low.ok, true)
  assert.strictEqual(low.index, 0)
})
