const assert = require('assert')
const { MockDB } = require('./mock-db')
const identity = require('../cloudfunctions/userIdentity/core')

async function run() {
  const db = new MockDB({ users: [
    { _id: 'u1', _openid: 'old', role: 'her', coupleId: 'c1', nickName: 'A' },
    { _id: 'u2', _openid: 'existing', role: 'him', coupleId: 'c2', user_uid: 'uid_12345678-1234-4234-8234-123456789abc' },
    { _id: 'u3', _openid: 'new', role: 'her', coupleId: null }
  ], daily_records: [{ _id: 'd1', _openid: 'old', text: 'keep' }], wishes: [{ _id: 'w1', _openid: 'old' }], books: [{ _id: 'b1', _openid: 'old' }] })

  const first = await identity.ensureUserUid({ db, openid: 'old', generate: () => 'uid_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
  assert.strictEqual(first.created, true)
  assert.strictEqual(first.user_uid, 'uid_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  assert.strictEqual((await identity.ensureUserUid({ db, openid: 'old' })).user_uid, first.user_uid)
  for (let i = 0; i < 10; i++) assert.strictEqual((await identity.ensureUserUid({ db, openid: 'old' })).user_uid, first.user_uid)
  assert.strictEqual((await identity.ensureUserUid({ db, openid: 'existing' })).user_uid, 'uid_12345678-1234-4234-8234-123456789abc')

  const concurrent = await Promise.all(Array.from({ length: 20 }, () => identity.ensureUserUid({ db, openid: 'new', generate: () => 'uid_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }).catch(e => ({ error: e.message }))))
  const ids = new Set(concurrent.filter(x => x.ok).map(x => x.user_uid))
  assert.strictEqual(ids.size, 1)
  assert.strictEqual(db.dump().users.filter(u => u._openid === 'new')[0].user_uid, 'uid_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
  assert.strictEqual(new Set(db.dump().users.filter(u => u._openid === 'new').map(u => u.user_uid)).size, 1)

  const before = db.dump()
  const diag = await identity.diagnoseUserUid({ db })
  assert.strictEqual(diag.DUPLICATE_USER_UID, 0)
  const dry = await identity.migrateUserUid({ db, execute: false })
  assert.strictEqual(dry.WOULD_CHANGE_EXISTING, 0)
  assert.strictEqual(dry.WOULD_DELETE, 0)
  assert.strictEqual(dry.COUPLE_RELATIONS_TOUCHED, 0)
  assert.deepStrictEqual(db.dump().daily_records, before.daily_records)
  assert.deepStrictEqual(db.dump().wishes, before.wishes)
  assert.deepStrictEqual(db.dump().books, before.books)
  console.log('user_uid tests PASS: A-H')
}
run().catch(e => { console.error(e); process.exit(1) })
