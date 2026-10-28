const assert = require('assert')
const Module = require('module')
const path = require('path')
const { MockDB } = require('./mock-db')
async function load(name, db, openid) {
  const original = Module._load
  Module._load = function (request) { if (request === 'wx-server-sdk') return { DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => db, getWXContext: () => ({ OPENID: openid }) }; return original.apply(this, arguments) }
  const p = path.resolve(__dirname, '../cloudfunctions', name, 'index.js'); delete require.cache[p]; const fn = require(p); Module._load = original; return fn
}
async function main() {
  const db = new MockDB({ login_sessions: [], desktop_sessions: [], users: [{ _id: 'u1', _openid: 'real', user_uid: 'uid_real' }] })
  const pub = await load('desktopAuthPublic', db, null)
  const json = data => ({ httpMethod: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
  let r = await pub.main({ httpMethod: 'GET', headers: {}, body: '{}' }); assert.strictEqual(r.statusCode, 400)
  r = await pub.main({ httpMethod: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }); assert.strictEqual(r.statusCode, 400)
  r = await pub.main({ httpMethod: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(8193) }); assert.strictEqual(r.statusCode, 400)
  r = await pub.main(json({ action: 'create', deviceId: 'd1', deviceName: 'Windows PC' })); assert.strictEqual(r.statusCode, 200); const created = JSON.parse(r.body); assert(created.sessionId && created.nonce && created.pollSecret); assert(!created.user_uid)
  r = await pub.main(json({ action: 'status', sessionId: created.sessionId, pollSecret: 'wrong' })); assert.strictEqual(JSON.parse(r.body).code, 'INVALID_LOGIN_REQUEST')
  const mini = await load('desktopAuthMiniapp', db, 'real')
  r = await mini.main({ action: 'confirm', sessionId: created.sessionId, nonce: created.nonce, user_uid: 'uid_attacker', openid: 'victim', role: 'him', coupleId: 'other' }); assert.strictEqual(r.ok, true); assert.strictEqual(db.dump().login_sessions[0].user_uid, 'uid_real')
  r = await pub.main(json({ action: 'status', sessionId: created.sessionId, pollSecret: created.pollSecret })); assert.strictEqual(JSON.parse(r.body).status, 'approved')
  r = await pub.main(json({ action: 'consume', sessionId: created.sessionId, pollSecret: created.pollSecret, deviceId: 'd1', deviceName: 'Windows PC' })); assert.strictEqual(r.statusCode, 200); assert(JSON.parse(r.body).desktopToken)
  console.log('desktop auth handler tests PASS')
}
main().catch(e => { console.error(e); process.exit(1) })
