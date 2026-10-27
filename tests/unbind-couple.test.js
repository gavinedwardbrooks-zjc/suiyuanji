const assert = require('assert')
const { MockDB } = require('./mock-db')
const core = require('../cloudfunctions/bindCouple/core')

async function setup() {
  const db = new MockDB({ users: [
    { _id: 'u1', _openid: 'her', user_uid: 'uid-her', role: 'her', coupleId: 'c1', bindCode: 'OLD1' },
    { _id: 'u2', _openid: 'him', user_uid: 'uid-him', role: 'him', coupleId: 'c1' }
  ], couples: [{ _id: 'c1doc', coupleId: 'c1', herOpenid: 'her', himOpenid: 'him', status: 'active' }] })
  return db
}

;(async () => {
  const db = await setup()
  const r = await core.unbind({ db, openid: 'her', now: 100 })
  assert.strictEqual(r.ok, true)
  const d = db.dump()
  assert.strictEqual(d.users[0].coupleId, null)
  assert.strictEqual(d.users[1].coupleId, null)
  assert.strictEqual(d.users[0].user_uid, 'uid-her')
  assert.strictEqual(d.users[1].user_uid, 'uid-him')
  assert.strictEqual(d.users[0].role, 'her')
  assert.strictEqual(d.users[1].role, 'him')
  assert.strictEqual(d.couples[0].status, 'unbound')
  assert.strictEqual(d.couples[0].unboundByUserUid, 'uid-her')
  const again = await core.unbind({ db, openid: 'her', now: 101 })
  assert.strictEqual(again.ok, true)
  const forged = await core.unbind({ db, openid: 'attacker', now: 102 })
  assert.strictEqual(forged.ok, true)
  console.log('unbind couple tests PASS')
})().catch(e => { console.error(e); process.exit(1) })
