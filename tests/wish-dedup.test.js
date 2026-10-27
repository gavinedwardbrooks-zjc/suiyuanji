// ============================================================
// tests/wish-dedup.test.js · 心愿去重规则（PRD v0.6 §4.2 R4）
// 同类型 trim 全等去重 / 跨类型不去重 / 空输入拒绝
// 运行：node tests/wish-dedup.test.js
// ============================================================
const assert = require('assert')
const { isDuplicate } = require('../utils/wish-dedup')

let passed = 0
let failed = 0

function testCase(name, fn) {
  try {
    fn()
    passed++
    console.log('  PASS  ' + name)
  } catch (e) {
    failed++
    console.log('  FAIL  ' + name + '  -> ' + e.message)
  }
}

console.log('\n=== 心愿去重规则测试 ===')

testCase('同类型完全一致 → 重复', () => {
  assert.strictEqual(isDuplicate(['火锅', '爬山'], '火锅'), true)
})

testCase('同类型 trim 后一致 → 重复（带空格输入）', () => {
  assert.strictEqual(isDuplicate(['火锅', '爬山'], '  火锅  '), true)
})

testCase('同类型不一致 → 不重复', () => {
  assert.strictEqual(isDuplicate(['火锅'], '寿司'), false)
})

testCase('空列表 → 不重复', () => {
  assert.strictEqual(isDuplicate([], '任何内容'), false)
})

testCase('空输入 / 纯空格 → 拒绝（视为重复）', () => {
  assert.strictEqual(isDuplicate([], ''), true)
  assert.strictEqual(isDuplicate([], '   '), true)
  assert.strictEqual(isDuplicate([], undefined), true)
})

testCase('跨类型不去重：eats 与 dos 独立判断', () => {
  // 模拟跨类型：同一条文本分别出现在 eat 列表和 do 列表，互不干扰
  const eats = ['火锅']
  const dos = ['火锅']
  assert.strictEqual(isDuplicate(eats, '火锅'), true, 'eat 列表内应判重')
  assert.strictEqual(isDuplicate(dos, '火锅'), true, 'do 列表内应判重')
  // 关键：同一文本在另一个列表存在，不影响本列表添加
  assert.strictEqual(isDuplicate(['想去看海'], '火锅'), false, '跨类型文本互不影响')
})

testCase('大小写敏感保持原样（中文场景无影响，英文精确匹配）', () => {
  assert.strictEqual(isDuplicate(['run'], 'run'), true)
  assert.strictEqual(isDuplicate(['run'], 'Run'), false)
})

console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
if (failed) process.exit(1)
console.log('Wish Dedup: ALL GREEN')
