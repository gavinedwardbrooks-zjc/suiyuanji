const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.resolve(__dirname, '../pages/reading/reading.js'), 'utf8')
const openBook = source.slice(source.indexOf('  openBook(e) {'), source.indexOf('  onHide()'))

test('DOWNLOADFILE_CALLBACK_USED', () => {
  assert.match(openBook, /wx\.downloadFile\(\{[\s\S]*success:/)
  assert.match(openBook, /fail:/)
})
test('NO_DOWNLOADFILE_CATCH_CHAIN', () => {
  assert.doesNotMatch(openBook, /wx\.downloadFile\(\{\s*url\s*\}\)\.catch/)
})
test('PDF_DOWNLOAD_SUCCESS_OPENS_DOCUMENT', () => {
  assert.match(openBook, /statusCode !== 200/)
  assert.match(openBook, /PDF_DOWNLOAD_OK/)
  assert.match(openBook, /wx\.openDocument\(/)
  assert.match(openBook, /filePath: res\.tempFilePath/)
  assert.match(openBook, /PDF_OPEN_OK/)
})
test('PDF_DOWNLOAD_FAIL_SAFE_ERROR', () => assert.match(openBook, /PDF_DOWNLOAD_FAILED/))
test('PDF_OPEN_FAIL_SAFE_ERROR', () => assert.match(openBook, /PDF_OPEN_FAILED/))
test('TXT_FLOW_UNCHANGED', () => assert.match(openBook, /b\.ext === 'txt' \? 'txt' : 'pdf'/))
