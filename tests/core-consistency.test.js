// ============================================================
// tests/core-consistency.test.js · 云函数本地复制核心一致性测试
// login/core.js 与 bindCouple/core.js 共享 genCode/migrateDocV1ToV2/SCHEMA_VERSION
// 因微信云函数独立打包而本地复制，本测试锁定两份实现行为一致（防漂移）
// 运行：node tests/core-consistency.test.js
// ============================================================
const assert = require('assert')
const loginCore = require('../cloudfunctions/login/core')
const bindCore = require('../cloudfunctions/bindCouple/core')

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

console.log('\n=== core 一致性测试（login vs bindCouple）===')

testCase('SCHEMA_VERSION 一致', () => {
  assert.strictEqual(loginCore.SCHEMA_VERSION, bindCore.SCHEMA_VERSION)
  assert.strictEqual(loginCore.SCHEMA_VERSION, 2)
})

testCase('genCode 输出格式一致（XZ- + 8 位）', () => {
  const a = loginCore.genCode()
  const b = bindCore.genCode()
  assert.match(a, /^XZ-[A-HJ-NP-Z2-9]{8}$/)
  assert.match(b, /^XZ-[A-HJ-NP-Z2-9]{8}$/)
  // 随机性：连续 20 次不应产生重复（防固定值退化）
  const seen = new Set()
  for (let i = 0; i < 20; i++) seen.add(loginCore.genCode())
  assert.ok(seen.size > 15, 'genCode 随机性不足')
})

testCase('migrateDocV1ToV2 行为一致：无 schemaVersion 文档', () => {
  const v1 = { _openid: 'u1', role: 'her', bindCode: 'XZ-OLD' }
  const a = loginCore.migrateDocV1ToV2({ ...v1 })
  const b = bindCore.migrateDocV1ToV2({ ...v1 })
  assert.deepStrictEqual(a, b)
  assert.strictEqual(a.changed, true)
  assert.strictEqual(a.doc.schemaVersion, 2)
  assert.strictEqual(a.doc.bindCode, 'XZ-OLD')
})

testCase('migrateDocV1ToV2 行为一致：已 v2 文档幂等', () => {
  const v2 = { _openid: 'u2', schemaVersion: 2, score: 4 }
  const a = loginCore.migrateDocV1ToV2({ ...v2 })
  const b = bindCore.migrateDocV1ToV2({ ...v2 })
  assert.deepStrictEqual(a, b)
  assert.strictEqual(a.changed, false)
})

testCase('migrateDocV1ToV2 行为一致：core 字段逐项不变', () => {
  const doc = { _openid: 'u3', segments: { life: 'x' }, mood: { type: 'calm' }, wishes: [{ type: 'eat', text: '火锅' }] }
  const a = loginCore.migrateDocV1ToV2({ ...doc })
  for (const key of Object.keys(doc)) assert.deepStrictEqual(a.doc[key], doc[key])
})

console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
if (failed) process.exit(1)
console.log('Core Consistency: ALL GREEN')
