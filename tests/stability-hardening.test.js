const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

const writingJs = read('pages/writing-edit/writing-edit.js')
const writingWxml = read('pages/writing-edit/writing-edit.wxml')
const bookJs = read('pages/book-edit/book-edit.js')
const bookWxml = read('pages/book-edit/book-edit.wxml')
const recordJs = read('pages/record/record.js')
const recordWxml = read('pages/record/record.wxml')
const readingJs = read('pages/reading/reading.js')
const readingWxml = read('pages/reading/reading.wxml')
const oursJs = read('pages/ours/ours.js')
const oursWxml = read('pages/ours/ours.wxml')
const mineJs = read('pages/mine/mine.js')
const writingWxss = read('pages/writing-edit/writing-edit.wxss')
const bookWxss = read('pages/book-edit/book-edit.wxss')

test('SAVE_DOUBLE_CLICK_BLOCKED', () => {
  assert.match(writingJs, /if \(this\.data\.saving\) return/)
  assert.match(bookJs, /if \(this\.data\.saving\) return/)
  assert.match(recordJs, /if \(this\._saving\) return/)
})

test('SAVE_LOADING_RENDERED_AND_DISABLED', () => {
  assert.match(writingWxml, /loading="\{\{saving\}\}" disabled="\{\{saving\}\}"/)
  assert.match(bookWxml, /loading="\{\{saving\}\}" disabled="\{\{saving\}\}"/)
  assert.match(recordWxml, /aria-disabled="\{\{saving\}\}"/)
})

test('SAVE_FAILURE_RECOVERS_LOADING', () => {
  assert.match(writingJs, /\.finally\(\(\) => this\.setData\(\{ saving: false \}\)\)/)
  assert.match(bookJs, /\.finally\(\(\) => this\.setData\(\{ saving: false \}\)\)/)
  assert.match(recordJs, /\.finally\(\(\) => \{\s*this\._saving = false\s*\}\)/)
})

test('ERROR_MESSAGE_USER_FRIENDLY', () => {
  assert.match(writingJs, /保存失败，请检查网络后重试/)
  assert.match(writingJs, /加载失败，请稍后再试/)
  assert.match(writingJs, /删除失败，内容没有被删除/)
  assert.match(readingJs, /加载失败，请稍后再试/)
  assert.match(recordJs, /网络似乎不太稳定/)
  assert.match(oursJs, /加载失败，请稍后再试/)
  assert.match(mineJs, /加载失败，请稍后再试/)
})

test('DELETE_FAILURE_KEEPS_DATA', () => {
  assert.match(writingJs, /api\.deleteWriting\(this\.data\.writingId\)\.then\(\(\) => wx\.navigateBack\(\)\)/)
  assert.match(writingJs, /删除失败，内容没有被删除/)
  assert.match(writingWxml, /loading="\{\{deleting\}\}" disabled="\{\{deleting\}\}"/)
})

test('RETURN_PAGE_REFRESH_CONTRACT', () => {
  assert.match(readingJs, /onShow\(\)[\s\S]*?this\.loadBooks\(\)[\s\S]*?this\.loadWritings\(\)/)
  assert.match(oursJs, /onShow\(\)[\s\S]*?this\.load\(\)/)
  assert.match(mineJs, /onShow\(\) \{ this\.refresh\(\) \}/)
  assert.match(recordJs, /onShow\(\)[\s\S]*?!this\._dirty && !this\._saving/)
  assert.match(recordJs, /onHide\(\)[\s\S]*?this\._dirty/)
})

test('EMPTY_STATE_RENDER', () => {
  assert.match(readingWxml, /书架还空空的/)
  assert.match(readingWxml, /还没有写过东西/)
  assert.match(recordWxml, /还没有小事，添加一件吧/)
  assert.match(recordWxml, /今天不想写也没关系/)
  assert.match(oursWxml, /还没有留言，说点什么吧/)
})

test('KEYBOARD_SAFE_INPUT_CONTRACT', () => {
  assert.match(writingWxml, /textarea[\s\S]*?adjust-position="true" cursor-spacing="24"/)
  assert.match(recordWxml, /textarea[\s\S]*?adjust-position="true" cursor-spacing="24"/)
  assert.match(bookWxml, /textarea[\s\S]*?adjust-position="true" cursor-spacing="24"/)
  assert.match(writingWxss, /env\(safe-area-inset-bottom\)/)
  assert.match(bookWxss, /env\(safe-area-inset-bottom\)/)
})

test('SMALL_SCREEN_LAYOUT_LOCAL', () => {
  assert.match(writingWxss, /@media \(max-width: 360px\)/)
  assert.match(writingWxss, /flex-direction: column/)
  assert.match(bookWxss, /flex-wrap: wrap/)
})
