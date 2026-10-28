const assert = require('assert')
const Module = require('module')
const path = require('path')
const { MockDB } = require('./mock-db')

async function main() {
  const db = new MockDB({ users: [
    { _id: 'u1', _openid: 'a', role: 'her', coupleId: null },
    { _id: 'u2', _openid: 'b', role: 'him', coupleId: 'c1', user_uid: 'uid_12345678-1234-4234-8234-123456789abc' }
  ] })
  const original = Module._load
  Module._load = function (request) {
    if (request === 'wx-server-sdk') return { DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => db }
    return original.apply(this, arguments)
  }
  const fnPath = path.resolve(__dirname, '../cloudfunctions/userUidMigration/index.js')
  delete require.cache[fnPath]
  const fn = require(fnPath)
  Module._load = original

  const diagnose = await fn.main({ action: 'diagnose' })
  assert.strictEqual(diagnose.TOTAL_USERS, 2)
  assert.strictEqual(typeof diagnose.USERS_WITHOUT_USER_UID, 'number')
  const dryRun = await fn.main({ action: 'dryRun' })
  assert.strictEqual(dryRun.USER_UID_MIGRATION_DRY_RUN, true)
  assert.strictEqual(dryRun.WOULD_CHANGE_EXISTING, 0)
  assert.strictEqual((await fn.main({ action: 'execute' })).code, 'MIGRATION_NOT_AUTHORIZED')
  assert.strictEqual((await fn.main({ action: 'execute', nonce: 'wrong' })).code, 'MIGRATION_NOT_AUTHORIZED')
  assert.strictEqual(db.dump().users[0].user_uid, undefined)
  console.log('userUidMigration deployment handlers PASS')
}
main().catch(error => { console.error(error); process.exit(1) })
