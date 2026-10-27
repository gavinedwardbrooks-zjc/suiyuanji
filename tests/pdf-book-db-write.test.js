// ============================================================
// S2 迁移说明（READING_LOCAL_STORAGE_S2）
//
// 本文件原本断言「导入 = 上传云存储 + 写 books 集合」这条链路存在。
// 用户已冻结决策：阅读文件改为纯本机存储。该云端写入路径被移除，
// 原 4 条断言不再描述任何有效行为，因此这里**同强度反向**为新契约：
//   导入链路必须完全不出现云存储上传与 books 写入。
//
// 注意：文件保留、断言不删只反向；旧的云端**读取**能力
// （loadBooks / openBook 的 getTempFileURL + downloadFile + openDocument）
// 仍由 tests/pdf-open-download-api.test.js 继续覆盖，未做任何放宽。
// ============================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.resolve(__dirname, '../pages/reading/reading.js'), 'utf8')
const importBlock = source.slice(source.indexOf('  importBook() {'), source.indexOf('  openLocalBook(e) {'))

test('IMPORT_NEVER_WRITES_CLOUD_STORAGE', () => {
  assert.ok(importBlock.length > 0, 'importBook 区块必须存在')
  assert.doesNotMatch(importBlock, /wx\.cloud\.uploadFile/)
  assert.doesNotMatch(importBlock, /wx\.cloud\.deleteFile/)
  assert.doesNotMatch(importBlock, /wx\.cloud\.getTempFileURL/)
  assert.doesNotMatch(importBlock, /wx\.cloud\.callFunction/)
})

test('IMPORT_NEVER_WRITES_BOOKS_COLLECTION', () => {
  assert.doesNotMatch(source, /db\.collection\('books'\)\.add\(/)
  assert.doesNotMatch(importBlock, /collection\('books'\)/)
})

test('IMPORT_GOES_THROUGH_LOCAL_REPO', () => {
  assert.match(importBlock, /require\('\.\.\/\.\.\/utils\/localBooks'\)/)
  assert.match(importBlock, /\.importFile\(/)
  assert.match(importBlock, /chooseMessageFile/)
})

test('IMPORT_SUCCESS_REQUIRES_REAL_ENTRY', () => {
  assert.match(source, /\.then\(result => this\.finishLocalImport\(result\)\)/)
  assert.match(source, /if \(!result \|\| !result\.entry\)/)
  assert.match(source, /IMPORT_NO_ENTRY/)
})

test('IMPORT_FAILURE_NEVER_SHOWS_SUCCESS_TOAST', () => {
  const failBlock = source.slice(source.indexOf('  failLocalImport(err) {'), source.indexOf('  openLocalBook(e) {'))
  assert.ok(failBlock.length > 0, 'failLocalImport 区块必须存在')
  assert.match(failBlock, /localImportMessage/)
  assert.match(failBlock, /icon: 'none'/)
  assert.doesNotMatch(failBlock, /已存到本机书架|已加入书架/)
  assert.doesNotMatch(failBlock, /icon: 'success'/)
})

test('DUPLICATE_IMPORT_ASKS_BEFORE_REPLACE', () => {
  assert.match(source, /confirmReplaceDuplicate/)
  assert.match(source, /onDuplicate: 'replace'/)
  assert.match(source, /wx\.showModal\(/)
})

test('IMPORT_BLOCK_HAS_NO_IDENTITY_FIELDS', () => {
  assert.doesNotMatch(importBlock, /_openid|user_uid|ownerOpenid|coupleId|\brole\b/)
})
