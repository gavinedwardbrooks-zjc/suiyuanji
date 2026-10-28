// desktopDaily handler 本地逻辑测试（MockDB）
// 覆盖：未认证读/写拒绝、token 校验、users 反查 _openid、get/save、
//       字段级合并、requestId 幂等、revision 乐观锁、身份注入忽略、跨用户隔离。
const assert = require('assert')
const Module = require('module')
const path = require('path')
const { MockDB } = require('./mock-db')

async function load(name, db) {
  const original = Module._load
  Module._load = function (request) {
    if (request === 'wx-server-sdk') {
      return { DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => db, getWXContext: () => ({ OPENID: 'unused' }) }
    }
    return original.apply(this, arguments)
  }
  const p = path.resolve(__dirname, '../cloudfunctions', name, 'index.js')
  delete require.cache[p]
  const fn = require(p)
  Module._load = original
  return fn
}

const { createDesktopSession } = require('../cloudfunctions/desktopDaily/desktopSessionCore')
const { CloudDesktopSessionRepository } = require('../cloudfunctions/desktopDaily/cloudDesktopSessionRepository')

function httpJson(body) {
  return { httpMethod: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}
function authJson(body, token) {
  const event = httpJson(body)
  event.headers.authorization = 'Bearer ' + token
  return event
}

async function setup(seedUsers, extra = {}) {
  const db = new MockDB({
    users: seedUsers,
    desktop_sessions: [],
    daily_records: [],
    ...extra
  })
  const handler = await load('desktopDaily', db)
  return { db, handler }
}

async function makeToken(db, userUid) {
  const repo = new CloudDesktopSessionRepository(db)
  const made = createDesktopSession({ user_uid: userUid, deviceId: 'dv_test', deviceName: 'Test PC', now: Date.now() })
  await repo.create(made.record)
  return made.token
}

function test(name, fn) {
  return fn().then(
    () => { console.log('#   PASS ', name) },
    e => { console.error('#   FAIL ', name, '\n', e && e.message); process.exitCode = 1 }
  )
}

async function main() {
  console.log('# === desktopDaily handler 测试 ===')
  const seedUsers = [
    { _id: 'u1', _openid: 'real_openid', user_uid: 'uid_real', role: 'him' },
    { _id: 'u2', _openid: 'other_openid', user_uid: 'uid_other', role: 'her' }
  ]

  await test('UNAUTHENTICATED_DAILY_READ_BLOCKED', async () => {
    const { handler } = await setup(seedUsers)
    const r = await handler.main(httpJson({ action: 'get', date: '2026-09-08' }))
    assert.strictEqual(r.statusCode, 400)
    assert.strictEqual(JSON.parse(r.body).code, 'INVALID_DESKTOP_SESSION')
  })

  await test('UNAUTHENTICATED_DAILY_WRITE_BLOCKED', async () => {
    const { handler } = await setup(seedUsers)
    const r = await handler.main(httpJson({ action: 'save', date: '2026-09-08', requestId: 'req_x', revision: 0, goals: [], todos: [] }))
    assert.strictEqual(JSON.parse(r.body).code, 'INVALID_DESKTOP_SESSION')
  })

  await test('INVALID_TOKEN_REJECTED', async () => {
    const { handler } = await setup(seedUsers)
    const r = await handler.main(authJson({ action: 'get', date: '2026-09-08' }, 'not-a-real-token'))
    assert.strictEqual(JSON.parse(r.body).code, 'INVALID_DESKTOP_SESSION')
  })

  await test('AUTHENTICATED_DAILY_READ_EMPTY', async () => {
    const { db, handler } = await setup(seedUsers)
    const token = await makeToken(db, 'uid_real')
    const r = await handler.main(authJson({ action: 'get', date: '2026-09-08' }, token))
    assert.strictEqual(r.statusCode, 200)
    const body = JSON.parse(r.body)
    assert.strictEqual(body.ok, true)
    assert.strictEqual(body.record, null)
  })

  await test('AUTHENTICATED_DAILY_SAVE_NEW', async () => {
    const { db, handler } = await setup(seedUsers)
    const token = await makeToken(db, 'uid_real')
    const goals = [{ text: '读书', done: false, reminderOn: false, reminderTime: '21:00' }, { text: '', done: false, reminderOn: false, reminderTime: '21:00' }, { text: '', done: false, reminderOn: false, reminderTime: '21:00' }]
    const todos = [{ text: '买牛奶', done: false }]
    const r = await handler.main(authJson({ action: 'save', date: '2026-09-08', requestId: 'req_1', revision: 0, goals, todos }, token))
    assert.strictEqual(r.statusCode, 200)
    assert.strictEqual(JSON.parse(r.body).revision, 1)
    const rec = db.dump().daily_records[0]
    assert.strictEqual(rec._openid, 'real_openid')
    assert.strictEqual(rec.date, '2026-09-08')
    assert.strictEqual(rec.goals[0].text, '读书')
    assert.strictEqual(rec.todos[0].text, '买牛奶')
    assert.ok(!('segments' in rec), '新记录不引入未使用字段')
  })

  await test('AUTHENTICATED_DAILY_READ_AFTER_SAVE', async () => {
    const { db, handler } = await setup(seedUsers)
    const token = await makeToken(db, 'uid_real')
    await handler.main(authJson({ action: 'save', date: '2026-09-08', requestId: 'req_1', revision: 0, goals: [{ text: '运动', done: false, reminderOn: false, reminderTime: '21:00' }], todos: [] }, token))
    const r = await handler.main(authJson({ action: 'get', date: '2026-09-08' }, token))
    const body = JSON.parse(r.body)
    assert.strictEqual(body.record.revision, 1)
    assert.strictEqual(body.record.goals[0].text, '运动')
    assert.deepStrictEqual(body.record.todos, [])
  })

  await test('DAILY_GOAL_SAVE_FIELD_LEVEL_MERGE', async () => {
    // 模拟小程序先写入完整记录（含 segments），Desktop 只改 goals/todos → segments 必须保留
    const { db, handler } = await setup(seedUsers)
    const token = await makeToken(db, 'uid_real')
    await db.collection('daily_records').add({
      data: {
        _openid: 'real_openid', date: '2026-09-08',
        goals: [{ text: '旧目标', done: true, reminderOn: false, reminderTime: '21:00' }],
        todos: [{ text: '旧小事', done: false }],
        segments: { life: '今天心情不错', work: '', growth: '' },
        mood: { type: 'calm', weather: 'sunny' },
        score: 3, readProgress: 10, revision: 2, lastRequestId: 'mini_req_old', schemaVersion: 2, createdAt: 1, updatedAt: 1
      }
    })
    const r = await handler.main(authJson({
      action: 'save', date: '2026-09-08', requestId: 'req_desktop_1', revision: 2,
      goals: [{ text: '新目标', done: false, reminderOn: false, reminderTime: '21:00' }],
      todos: [{ text: '新小事', done: true }]
    }, token))
    assert.strictEqual(JSON.parse(r.body).revision, 3)
    const rec = db.dump().daily_records.find(d => d.date === '2026-09-08')
    assert.strictEqual(rec.goals[0].text, '新目标')
    assert.strictEqual(rec.todos[0].text, '新小事')
    assert.strictEqual(rec.todos[0].done, true)
    assert.deepStrictEqual(rec.segments, { life: '今天心情不错', work: '', growth: '' }, 'segments 保留')
    assert.strictEqual(rec.mood.type, 'calm')
    assert.strictEqual(rec.score, 3)
    assert.strictEqual(rec.readProgress, 10)
  })

  await test('DOUBLE_SUBMIT_IDEMPOTENT', async () => {
    const { db, handler } = await setup(seedUsers)
    const token = await makeToken(db, 'uid_real')
    const payload = { action: 'save', date: '2026-09-08', requestId: 'req_same', revision: 0, goals: [{ text: 'A', done: false, reminderOn: false, reminderTime: '21:00' }], todos: [] }
    await handler.main(authJson(payload, token))
    const again = await handler.main(authJson(payload, token))
    const body = JSON.parse(again.body)
    assert.strictEqual(body.idempotent, true)
    assert.strictEqual(body.revision, 1)
    assert.strictEqual(db.dump().daily_records.length, 1, '不重复写入')
  })

  await test('REV_CONFLICT_ON_STALE_REVISION', async () => {
    const { db, handler } = await setup(seedUsers)
    const token = await makeToken(db, 'uid_real')
    await handler.main(authJson({ action: 'save', date: '2026-09-08', requestId: 'req_1', revision: 0, goals: [{ text: 'A', done: false, reminderOn: false, reminderTime: '21:00' }], todos: [] }, token))
    const stale = await handler.main(authJson({ action: 'save', date: '2026-09-08', requestId: 'req_2', revision: 0, goals: [{ text: 'B', done: false, reminderOn: false, reminderTime: '21:00' }], todos: [] }, token))
    assert.strictEqual(stale.statusCode, 409)
    assert.strictEqual(JSON.parse(stale.body).code, 'REV_CONFLICT')
  })

  await test('IDENTITY_INJECTION_IGNORED', async () => {
    const { db, handler } = await setup(seedUsers)
    const token = await makeToken(db, 'uid_real')
    // 客户端试图伪造身份字段：必须被忽略，owner 仍是 token 解析出的 uid_real
    const r = await handler.main(authJson({
      action: 'save', date: '2026-09-08', requestId: 'req_attack', revision: 0,
      openid: 'victim_openid', user_uid: 'uid_other', coupleId: 'c_evil', role: 'her',
      goals: [{ text: 'X', done: false, reminderOn: false, reminderTime: '21:00' }], todos: []
    }, token))
    assert.strictEqual(r.statusCode, 200)
    const rec = db.dump().daily_records[0]
    assert.strictEqual(rec._openid, 'real_openid')
  })

  await test('USER_ISOLATION_READ', async () => {
    const { db, handler } = await setup(seedUsers)
    const token = await makeToken(db, 'uid_real')
    await handler.main(authJson({ action: 'save', date: '2026-09-08', requestId: 'req_1', revision: 0, goals: [{ text: 'A', done: false, reminderOn: false, reminderTime: '21:00' }], todos: [] }, token))
    const otherToken = await makeToken(db, 'uid_other')
    const r = await handler.main(authJson({ action: 'get', date: '2026-09-08' }, otherToken))
    assert.strictEqual(JSON.parse(r.body).record, null, '他人不可见')
  })

  await test('DATE_INVALID_REJECTED', async () => {
    const { db, handler } = await setup(seedUsers)
    const token = await makeToken(db, 'uid_real')
    const r = await handler.main(authJson({ action: 'get', date: '2026-13-99' }, token))
    assert.strictEqual(JSON.parse(r.body).code, 'DATE_INVALID')
  })

  // 关系归属（P0 隐私隔离）：桌面端也是 daily_records 的创建入口，必须与小程序
  // 写同一条规则——创建时写一次 coupleId，之后不覆盖。
  await test('COUPLE_MARK_ON_CREATE', async () => {
    const { db, handler } = await setup([
      { _id: 'u1', _openid: 'real_openid', user_uid: 'uid_real', role: 'her', coupleId: 'CZ-1' },
      { _id: 'u2', _openid: 'other_openid', user_uid: 'uid_other', role: 'him', coupleId: 'CZ-1' }
    ], {
      couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'real_openid', himOpenid: 'other_openid', status: 'active', boundAt: 1000 }]
    })
    const token = await makeToken(db, 'uid_real')
    const r = await handler.main(authJson({ action: 'save', date: '2026-09-08', requestId: 'req_c1', revision: 0, goals: [], todos: [] }, token))
    assert.strictEqual(JSON.parse(r.body).ok, true)
    const rec = db.dump().daily_records[0]
    assert.strictEqual(rec.coupleId, 'CZ-1', '创建时必须写入关系标记')
  })

  await test('COUPLE_MARK_ABSENT_WHEN_UNBOUND', async () => {
    const { db, handler } = await setup(seedUsers) // 两个用户都没有 coupleId
    const token = await makeToken(db, 'uid_real')
    await handler.main(authJson({ action: 'save', date: '2026-09-08', requestId: 'req_c2', revision: 0, goals: [], todos: [] }, token))
    const rec = db.dump().daily_records[0]
    assert.strictEqual(Object.prototype.hasOwnProperty.call(rec, 'coupleId'), true)
    assert.strictEqual(rec.coupleId, null, '已确认未绑定 → 显式 null')
  })

  await test('COUPLE_MARK_NOT_OVERWRITTEN_ON_UPDATE', async () => {
    const { db, handler } = await setup([
      { _id: 'u1', _openid: 'real_openid', user_uid: 'uid_real', role: 'her', coupleId: 'CZ-2' }
    ], {
      couples: [{ _id: 'c2', coupleId: 'CZ-2', herOpenid: 'real_openid', himOpenid: 'x', status: 'active', boundAt: 5000 }],
      daily_records: [{ _id: 'r1', _openid: 'real_openid', date: '2026-09-08', coupleId: 'CZ-1', revision: 1, goals: [], todos: [] }]
    })
    const token = await makeToken(db, 'uid_real')
    await handler.main(authJson({ action: 'save', date: '2026-09-08', requestId: 'req_c3', revision: 1, goals: [{ text: 'X', done: false, reminderOn: false, reminderTime: '21:00' }], todos: [] }, token))
    const rec = db.dump().daily_records[0]
    assert.strictEqual(rec.coupleId, 'CZ-1', '更新不得改写归属（否则旧关系内容会被搬到新关系）')
    assert.strictEqual(rec.goals[0].text, 'X')
  })

  console.log('# === desktopDaily handler tests PASS ===')
}

main().catch(e => { console.error(e); process.exit(1) })
