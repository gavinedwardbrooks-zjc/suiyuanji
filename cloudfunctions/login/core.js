// ============================================================
// login · 自包含最小核心（PRD v0.6 §6.1）
// 微信云开发每个云函数独立打包：本文件与 bindCouple/core.js 共享以下 3 个
// 极小稳定纯函数，因无法跨云函数 require，特在此本地保留一份。
//
// ⚠️ 同步义务：修改 bindCouple/core.js 中 genCode / migrateDocV1ToV2 /
//    SCHEMA_VERSION 时，必须同步本文件，并运行 tests/core-consistency.test.js
//    验证两份实现行为一致（一致性由测试锁定）。
// ============================================================

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 去除 I/O/0/1
const CODE_LEN = 8
const CODE_PREFIX = 'XZ-'
const crypto = require('crypto')

function generateUserUid() {
  return 'uid_' + crypto.randomUUID()
}

function genCode() {
  let r = ''
  for (let i = 0; i < CODE_LEN; i++) r += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  return CODE_PREFIX + r
}

// 迁移契约（PRD §4.1 B2：schemaVersion 缺失=v1，幂等，核心字段不变）
const SCHEMA_VERSION = 2

function migrateDocV1ToV2(doc) {
  if (doc.schemaVersion >= SCHEMA_VERSION) return { doc, changed: false }
  // 只补 schemaVersion，绝不改动任何业务字段
  return { doc: { ...doc, schemaVersion: SCHEMA_VERSION }, changed: true }
}

module.exports = {
  genCode,
  generateUserUid,
  migrateDocV1ToV2,
  SCHEMA_VERSION
}
