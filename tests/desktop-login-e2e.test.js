// ============================================================
// tests/desktop-login-e2e.test.js · 桌面扫码授权 + 统一身份 + 日记同步
//                            —— 完整本地模拟联调（不连接任何真实云环境）
//
// 驱动的是**真实云函数代码**（index.js + 共享模块），只把 wx-server-sdk
// 换成内存 MockDB。因此它验证的是协议与权限逻辑本身，而不是替身实现。
//
// 覆盖四组：
//   E  扫码授权状态机（创建/扫码/确认/轮询/消费/过期/取消/重复/并发/非法码/网络恢复）
//   I  身份与权限（冒充、伪造 coupleId/role、未授权、过期、撤销、服务端归属）
//   D  日记同步（读/建/跨端读/跨端更新/幂等/冲突/失败/历史数据不破坏）
//
// 明确不在本文件覆盖（必须在真实环境验证，不得在此虚报 PASS）：
//   · 微信扫码调起与 wx.scanCode 的真实交互
//   · cloud.getWXContext() 真实注入的 OPENID
//   · 云函数真实部署、HTTP 触发路由、网络时延与重试
// ============================================================
const assert = require('assert')
const Module = require('module')
const path = require('path')
const { MockDB } = require('./mock-db')
const { parseDesktopLoginResult } = require('../utils/desktop-qr')

const CF = path.resolve(__dirname, '../cloudfunctions')
const DATE = '2026-10-28'
let passed = 0
let failed = 0
const failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++
    console.log('  PASS  ' + name)
  }).catch(e => {
    failed++
    failures.push(name + ' :: ' + e.message)
    console.log('  FAIL  ' + name + '  -> ' + e.message)
  })
}

// 用 MockDB 注入真实云函数；每个函数目录只认自己目录内的依赖副本（与线上一致）
function loadFn(name, db, openid) {
  const orig = Module._load
  Module._load = function (request) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test',
        init() {},
        database: () => db,
        getWXContext: () => ({ OPENID: openid })
      }
    }
    return orig.apply(this, arguments)
  }
  for (const key of Object.keys(require.cache)) if (key.startsWith(CF)) delete require.cache[key]
  const mod = require(path.join(CF, name, 'index.js'))
  Module._load = orig
  return mod
}

const post = (fn, body, token) => fn.main({
  httpMethod: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(token ? { authorization: 'Bearer ' + token } : {})
  },
  body: JSON.stringify(body)
})
const j = r => JSON.parse(r.body)
// 服务端 goals 白名单归一化后的形状（桌面保存后的权威形态）
const goalShape = (text, done = false, extra = {}) => ({ text, done, reminderOn: false, reminderTime: '21:00', reminded: false, ...extra })

function seed() {
  return new MockDB({
    login_sessions: [],
    desktop_sessions: [],
    users: [
      { _id: 'uA', _openid: 'openid_A', user_uid: 'uid_A', role: 'her', coupleId: null, nickName: '她' },
      { _id: 'uB', _openid: 'openid_B', user_uid: 'uid_B', role: 'him', coupleId: null, nickName: '他' }
    ],
    daily_records: [],
    couples: []
  })
}

// 走完一次完整登录，返回 { token, sessionId, nonce, pollSecret, pub, mini }
async function loginAs(db, openid) {
  const pub = loadFn('desktopAuthPublic', db, null)
  const mini = loadFn('desktopAuthMiniapp', db, openid)
  const created = j(await post(pub, { action: 'create', deviceId: 'device-1', deviceName: 'Windows PC' }))
  await mini.main({ action: 'inspect', sessionId: created.sessionId, nonce: created.nonce })
  const confirmed = await mini.main({ action: 'confirm', sessionId: created.sessionId, nonce: created.nonce })
  assert.strictEqual(confirmed.ok, true, 'confirm 应成功')
  const consumed = j(await post(pub, { action: 'consume', sessionId: created.sessionId, pollSecret: created.pollSecret, deviceId: 'device-1', deviceName: 'Windows PC' }))
  return { ...created, token: consumed.desktopToken, pub, mini }
}

async function run() {
  console.log('\n=== E 组 · 扫码授权状态机 ===\n')

  await testCase('E1 创建二维码：返回会话凭据，落库只存哈希', async () => {
    const db = seed()
    const pub = loadFn('desktopAuthPublic', db, null)
    const r = await post(pub, { action: 'create', deviceId: 'device-1', deviceName: 'Windows PC' })
    assert.strictEqual(r.statusCode, 200)
    const body = j(r)
    assert(body.sessionId && body.nonce && body.pollSecret && body.expiresAt)
    assert.strictEqual(body.user_uid, undefined, '不得在创建阶段返回身份')
    const doc = db.dump().login_sessions[0]
    assert.strictEqual(doc.status, 'pending')
    assert(doc.nonceHash && doc.pollSecretHash, '必须存哈希')
    const raw = JSON.stringify(doc)
    assert(!raw.includes(body.nonce), '明文 nonce 不得落库')
    assert(!raw.includes(body.pollSecret), '明文 pollSecret 不得落库')
    assert.strictEqual(doc.user_uid, null)
  })

  await testCase('E2 二维码文本只含 sid + nonce，可被小程序解析回同一会话', async () => {
    const db = seed()
    const pub = loadFn('desktopAuthPublic', db, null)
    const body = j(await post(pub, { action: 'create', deviceId: 'device-1', deviceName: 'Windows PC' }))
    // 与 lib.rs auth_start_login 拼出的 qr_text 完全一致
    const qrText = `suiyuanji://desktop-login?v=1&sid=${body.sessionId}&nonce=${body.nonce}`
    const parsed = parseDesktopLoginResult(qrText)
    assert.strictEqual(parsed.ok, true)
    assert.strictEqual(parsed.sessionId, body.sessionId)
    assert.strictEqual(parsed.nonce, body.nonce)
    assert(!qrText.includes(body.pollSecret), 'pollSecret 绝不能进二维码')
  })

  await testCase('E3 合法扫码：inspect 只校验不授权', async () => {
    const db = seed()
    const pub = loadFn('desktopAuthPublic', db, null)
    const mini = loadFn('desktopAuthMiniapp', db, 'openid_A')
    const body = j(await post(pub, { action: 'create', deviceId: 'device-1', deviceName: 'Windows PC' }))
    const r = await mini.main({ action: 'inspect', sessionId: body.sessionId, nonce: body.nonce })
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.valid, true)
    assert.strictEqual(r.desktopDeviceName, 'Windows PC')
    assert.strictEqual(db.dump().login_sessions[0].status, 'pending', 'inspect 不得改变会话状态')
  })

  await testCase('E4 用户确认：身份只来自服务端 OPENID，客户端塞的身份字段全部无效', async () => {
    const db = seed()
    const pub = loadFn('desktopAuthPublic', db, null)
    const mini = loadFn('desktopAuthMiniapp', db, 'openid_A')
    const body = j(await post(pub, { action: 'create', deviceId: 'device-1', deviceName: 'Windows PC' }))
    const r = await mini.main({
      action: 'confirm', sessionId: body.sessionId, nonce: body.nonce,
      user_uid: 'uid_B', openid: 'openid_B', role: 'him', coupleId: 'cpl_hacked'
    })
    assert.strictEqual(r.ok, true)
    const doc = db.dump().login_sessions[0]
    assert.strictEqual(doc.status, 'approved')
    assert.strictEqual(doc.user_uid, 'uid_A', '身份必须来自 OPENID，不能被 body 覆盖')
    assert.strictEqual(doc.coupleId, undefined, '确认阶段不得写入客户端提交的 coupleId')
    assert.strictEqual(doc.role, undefined, '确认阶段不得写入客户端提交的 role')
  })

  await testCase('E5 桌面轮询 → 消费 → 拿到 token → 校验出正确身份', async () => {
    const db = seed()
    const s = await loginAs(db, 'openid_A')
    assert(s.token && s.token.length >= 40)
    const r = await post(s.pub, { action: 'validate' }, s.token)
    assert.strictEqual(r.statusCode, 200)
    assert.strictEqual(j(r).authenticated, true)
    const doc = db.dump().desktop_sessions[0]
    assert.strictEqual(doc.user_uid, 'uid_A')
    assert(doc.tokenHash && !JSON.stringify(doc).includes(s.token), 'token 明文不得落库')
    assert.strictEqual(db.dump().login_sessions[0].status, 'consumed', '一次性消费')
  })

  await testCase('E6 二维码超时：状态转 expired，确认与消费都被拒绝', async () => {
    const db = seed()
    const pub = loadFn('desktopAuthPublic', db, null)
    const mini = loadFn('desktopAuthMiniapp', db, 'openid_A')
    const body = j(await post(pub, { action: 'create', deviceId: 'device-1', deviceName: 'Windows PC' }))
    // 把过期时间推到过去（模拟 5 分钟 TTL 到期）
    db._data.login_sessions[0].expiresAt = Date.now() - 1
    const status = j(await post(pub, { action: 'status', sessionId: body.sessionId, pollSecret: body.pollSecret }))
    assert.strictEqual(status.status, 'expired')
    const confirmed = await mini.main({ action: 'confirm', sessionId: body.sessionId, nonce: body.nonce })
    assert.strictEqual(confirmed.ok, false)
    assert.strictEqual(confirmed.code, 'SESSION_EXPIRED')
    const consumed = await post(pub, { action: 'consume', sessionId: body.sessionId, pollSecret: body.pollSecret, deviceId: 'device-1', deviceName: 'Windows PC' })
    assert.strictEqual(consumed.statusCode, 400)
    assert.strictEqual(db.dump().desktop_sessions.length, 0, '过期会话不得签发 token')
  })

  await testCase('E7 用户取消：状态 cancelled，消费被拒绝', async () => {
    const db = seed()
    const pub = loadFn('desktopAuthPublic', db, null)
    const mini = loadFn('desktopAuthMiniapp', db, 'openid_A')
    const body = j(await post(pub, { action: 'create', deviceId: 'device-1', deviceName: 'Windows PC' }))
    const r = await mini.main({ action: 'cancel', sessionId: body.sessionId, nonce: body.nonce })
    assert.strictEqual(r.ok, true)
    assert.strictEqual(j(await post(pub, { action: 'status', sessionId: body.sessionId, pollSecret: body.pollSecret })).status, 'cancelled')
    const consumed = j(await post(pub, { action: 'consume', sessionId: body.sessionId, pollSecret: body.pollSecret, deviceId: 'device-1', deviceName: 'Windows PC' }))
    assert.strictEqual(consumed.ok, false)
    assert.strictEqual(consumed.code, 'SESSION_NOT_APPROVED')
    assert.strictEqual(db.dump().desktop_sessions.length, 0)
  })

  await testCase('E8 重复确认：第二次确认被拒（SESSION_NOT_PENDING）', async () => {
    const db = seed()
    const pub = loadFn('desktopAuthPublic', db, null)
    const mini = loadFn('desktopAuthMiniapp', db, 'openid_A')
    const body = j(await post(pub, { action: 'create', deviceId: 'device-1', deviceName: 'Windows PC' }))
    assert.strictEqual((await mini.main({ action: 'confirm', sessionId: body.sessionId, nonce: body.nonce })).ok, true)
    const again = await mini.main({ action: 'confirm', sessionId: body.sessionId, nonce: body.nonce })
    assert.strictEqual(again.ok, false)
    assert.strictEqual(again.code, 'SESSION_NOT_PENDING')
    assert.strictEqual(db.dump().desktop_sessions.length, 0)
  })

  await testCase('E9 重复消费（响应丢失后恢复）：换发新 token，旧 token 立即失效', async () => {
    const db = seed()
    const s = await loginAs(db, 'openid_A')
    const replay = j(await post(s.pub, { action: 'consume', sessionId: s.sessionId, pollSecret: s.pollSecret, deviceId: 'device-1', deviceName: 'Windows PC' }))
    assert(replay.ok && replay.desktopToken, '重放必须能拿回可用 token，否则用户只能重新扫码')
    assert.notStrictEqual(replay.desktopToken, s.token)
    assert.strictEqual(db.dump().desktop_sessions.length, 1, '不能产生第二条桌面会话')
    assert.strictEqual((await post(s.pub, { action: 'validate' }, s.token)).statusCode, 400, '旧 token 必须失效')
    assert.strictEqual((await post(s.pub, { action: 'validate' }, replay.desktopToken)).statusCode, 200)
  })

  await testCase('E10 并发确认：只有一个能成功', async () => {
    const db = seed()
    const pub = loadFn('desktopAuthPublic', db, null)
    const mini = loadFn('desktopAuthMiniapp', db, 'openid_A')
    const body = j(await post(pub, { action: 'create', deviceId: 'device-1', deviceName: 'Windows PC' }))
    const results = await Promise.all([
      mini.main({ action: 'confirm', sessionId: body.sessionId, nonce: body.nonce }),
      mini.main({ action: 'confirm', sessionId: body.sessionId, nonce: body.nonce })
    ])
    assert.strictEqual(results.filter(r => r.ok).length, 1, '并发确认必须恰好成功一次')
  })

  await testCase('E11 非法二维码：全部 fail-closed', async () => {
    const bad = [
      '',
      'https://example.com/login?v=1&sid=x&nonce=y',
      'suiyuanji://desktop-login',
      'suiyuanji://desktop-login?sid=x&nonce=y',                       // 缺 v
      'suiyuanji://desktop-login?v=2&sid=x&nonce=y',                   // v 错误
      'suiyuanji://desktop-login?v=1&sid=x',                           // 缺 nonce
      'suiyuanji://desktop-login?v=1&nonce=y',                         // 缺 sid
      'suiyuanji://desktop-login?v=1&sid=x&nonce=y&pollSecret=leak',   // 禁止字段
      'suiyuanji://desktop-login?v=1&sid=x&nonce=y&user_uid=uid_A',    // 禁止字段
      'suiyuanji://desktop-login?v=1&sid=x&nonce=y&coupleId=cpl',      // 禁止字段
      'suiyuanji://desktop-login?v=1&sid=x&nonce=y&role=him',          // 禁止字段
      'suiyuanji://desktop-login?v=1&sid=x&sid=z&nonce=y',             // 重复 key
      'suiyuanji://desktop-login?v=1&sid=x&nonce=y&unknown=1'          // 未知 key
    ]
    for (const text of bad) assert.strictEqual(parseDesktopLoginResult(text).ok, false, '应拒绝: ' + text)
  })

  await testCase('E12 未登录 / 无身份用户不能确认', async () => {
    const db = seed()
    const pub = loadFn('desktopAuthPublic', db, null)
    const body = j(await post(pub, { action: 'create', deviceId: 'device-1', deviceName: 'Windows PC' }))
    const noOpenid = loadFn('desktopAuthMiniapp', db, null)
    const r1 = await noOpenid.main({ action: 'confirm', sessionId: body.sessionId, nonce: body.nonce })
    assert.strictEqual(r1.ok, false, '无 OPENID 必须拒绝')
    // 有 OPENID 但 users 里没有 user_uid（历史脏数据）
    db._data.users.push({ _id: 'uC', _openid: 'openid_C' })
    const noUid = loadFn('desktopAuthMiniapp', db, 'openid_C')
    const r2 = await noUid.main({ action: 'confirm', sessionId: body.sessionId, nonce: body.nonce })
    assert.strictEqual(r2.ok, false, '无 user_uid 必须拒绝')
    assert.strictEqual(db.dump().login_sessions[0].status, 'pending', '两次拒绝都不得改变会话')
  })

  await testCase('E13 错误用户消费会话：pollSecret 不匹配即拒绝', async () => {
    const db = seed()
    const pub = loadFn('desktopAuthPublic', db, null)
    const mini = loadFn('desktopAuthMiniapp', db, 'openid_A')
    const body = j(await post(pub, { action: 'create', deviceId: 'device-1', deviceName: 'Windows PC' }))
    await mini.main({ action: 'confirm', sessionId: body.sessionId, nonce: body.nonce })
    const stolen = j(await post(pub, { action: 'consume', sessionId: body.sessionId, pollSecret: 'photo-of-the-qr', deviceId: 'attacker', deviceName: 'attacker' }))
    assert.strictEqual(stolen.ok, false)
    assert.strictEqual(stolen.code, 'INVALID_LOGIN_REQUEST')
    assert.strictEqual(db.dump().desktop_sessions.length, 0, '不得签发 token')
    assert.strictEqual(db.dump().login_sessions[0].status, 'approved', '会话不能被攻击者消费掉')
  })

  await testCase('E14 云端写失败后可恢复：不留下半个会话', async () => {
    const db = seed()
    const pub = loadFn('desktopAuthPublic', db, null)
    const mini = loadFn('desktopAuthMiniapp', db, 'openid_A')
    const body = j(await post(pub, { action: 'create', deviceId: 'device-1', deviceName: 'Windows PC' }))
    await mini.main({ action: 'confirm', sessionId: body.sessionId, nonce: body.nonce })
    db.injectFail('desktop_sessions', 'add')   // 第一次写桌面会话失败
    const first = await post(pub, { action: 'consume', sessionId: body.sessionId, pollSecret: body.pollSecret, deviceId: 'device-1', deviceName: 'Windows PC' })
    assert.strictEqual(first.statusCode, 500, '失败必须显式报错，不能静默成功')
    assert.strictEqual(db.dump().login_sessions[0].status, 'approved', '一次性消费必须回滚，否则用户永久卡死')
    const retry = j(await post(pub, { action: 'consume', sessionId: body.sessionId, pollSecret: body.pollSecret, deviceId: 'device-1', deviceName: 'Windows PC' }))
    assert.strictEqual(retry.ok, true)
    assert(retry.desktopToken, '重试必须拿到 token')
    assert.strictEqual(db.dump().desktop_sessions.length, 1)
  })

  console.log('\n=== I 组 · 身份与权限 ===\n')

  await testCase('I1 A 的 token 读不到 B 的日记（服务端强制归属）', async () => {
    const db = seed()
    db._data.daily_records.push({ _id: 'recB', _openid: 'openid_B', date: DATE, goals: [{ text: 'B 的目标', done: false }], todos: [], revision: 1 })
    const s = await loginAs(db, 'openid_A')
    const daily = loadFn('desktopDaily', db, null)
    const r = j(await post(daily, { action: 'get', date: DATE }, s.token))
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.record, null, 'A 不得读到 B 的记录')
  })

  await testCase('I2 客户端伪造 coupleId / role 不生效', async () => {
    const db = seed()
    const s = await loginAs(db, 'openid_A')
    const daily = loadFn('desktopDaily', db, null)
    const r = j(await post(daily, {
      action: 'save', date: DATE, requestId: 'req-i2', revision: 0,
      goals: [{ text: '写点东西', done: false }], todos: [],
      coupleId: 'cpl_hacked', role: 'him', user_uid: 'uid_B', _openid: 'openid_B'
    }, s.token))
    assert.strictEqual(r.ok, true)
    const rec = db.dump().daily_records[0]
    assert.strictEqual(rec._openid, 'openid_A', '归属由 token 决定')
    assert.strictEqual(rec.coupleId, null, '未绑定关系时只能写 null，不能写客户端提交的值')
    assert.strictEqual(rec.role, undefined, '不得写入客户端提交的 role')
  })

  await testCase('I3 未授权桌面不能读日记（无 token / 假 token）', async () => {
    const db = seed()
    const daily = loadFn('desktopDaily', db, null)
    const noAuth = await post(daily, { action: 'get', date: DATE })
    assert.strictEqual(noAuth.statusCode, 400)
    assert.strictEqual(j(noAuth).code, 'INVALID_DESKTOP_SESSION')
    const fake = await post(daily, { action: 'get', date: DATE }, 'a'.repeat(43))
    assert.strictEqual(fake.statusCode, 400)
    assert.strictEqual(j(fake).code, 'INVALID_DESKTOP_SESSION')
  })

  await testCase('I4 过期会话不能继续访问', async () => {
    const db = seed()
    const s = await loginAs(db, 'openid_A')
    db._data.desktop_sessions[0].expiresAt = Date.now() - 1000
    const daily = loadFn('desktopDaily', db, null)
    const r = await post(daily, { action: 'get', date: DATE }, s.token)
    assert.strictEqual(r.statusCode, 400)
    assert.strictEqual(j(r).code, 'INVALID_DESKTOP_SESSION')
    assert.strictEqual(db.dump().desktop_sessions[0].status, 'expired', '过期状态必须落库')
  })

  await testCase('I5 撤销（退出登录）后不能再访问，且状态真的落库', async () => {
    const db = seed()
    const s = await loginAs(db, 'openid_A')
    const out = j(await post(s.pub, { action: 'logout' }, s.token))
    assert.strictEqual(out.ok, true)
    assert.strictEqual(db.dump().desktop_sessions[0].status, 'revoked', '撤销必须真的写进库（历史上这里是坏的）')
    const daily = loadFn('desktopDaily', db, null)
    const r = await post(daily, { action: 'get', date: DATE }, s.token)
    assert.strictEqual(r.statusCode, 400)
    assert.strictEqual(j(r).code, 'INVALID_DESKTOP_SESSION')
  })

  await testCase('I6 token 明文不落库、不进日志字段', async () => {
    const db = seed()
    const s = await loginAs(db, 'openid_A')
    const dump = JSON.stringify(db.dump())
    assert(!dump.includes(s.token), '数据库里不得出现 token 明文')
    assert(dump.includes('tokenHash'), '只允许存 tokenHash')
  })

  console.log('\n=== D 组 · 日记同步 ===\n')

  await testCase('D1 桌面读取小程序已存在的日记', async () => {
    const db = seed()
    db._data.daily_records.push({
      _id: 'recA', _openid: 'openid_A', date: DATE, revision: 3,
      goals: [{ text: '早睡', done: true }], todos: [{ text: '买菜', done: false }],
      segments: { life: '很平静', work: '', growth: '' }, mood: { type: 'calm', weather: 'sunny' }, score: 5
    })
    const s = await loginAs(db, 'openid_A')
    const daily = loadFn('desktopDaily', db, null)
    const r = j(await post(daily, { action: 'get', date: DATE }, s.token))
    assert.strictEqual(r.record.revision, 3)
    assert.deepStrictEqual(r.record.goals, [{ text: '早睡', done: true }])
    assert.deepStrictEqual(r.record.todos, [{ text: '买菜', done: false }])
  })

  await testCase('D2 桌面上新建日记：落库字段正确、revision 1', async () => {
    const db = seed()
    const s = await loginAs(db, 'openid_A')
    const daily = loadFn('desktopDaily', db, null)
    const r = j(await post(daily, { action: 'save', date: DATE, requestId: 'req-d2', revision: 0, goals: [{ text: '跑步', done: false }], todos: [{ text: '洗衣服', done: false }] }, s.token))
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.revision, 1)
    const rec = db.dump().daily_records[0]
    assert.strictEqual(rec._openid, 'openid_A')
    assert.strictEqual(rec.date, DATE)
    assert.strictEqual(rec.lastRequestId, 'req-d2')
    assert.strictEqual(rec.revision, 1)
  })

  await testCase('D3 小程序能读到桌面创建的日记', async () => {
    const db = seed()
    const s = await loginAs(db, 'openid_A')
    const daily = loadFn('desktopDaily', db, null)
    await post(daily, { action: 'save', date: DATE, requestId: 'req-d3', revision: 0, goals: [{ text: '桌面写的目标', done: false }], todos: [] }, s.token)
    const mp = loadFn('dailyRecord', db, 'openid_A')
    const r = await mp.main({ action: 'get', date: DATE })
    assert.strictEqual(r.ok, true)
    assert.deepStrictEqual(r.record.goals, [goalShape('桌面写的目标')])
    assert.strictEqual(r.record.revision, 1)
  })

  await testCase('D4 小程序更新后，桌面重新读取拿到新内容', async () => {
    const db = seed()
    const s = await loginAs(db, 'openid_A')
    const daily = loadFn('desktopDaily', db, null)
    await post(daily, { action: 'save', date: DATE, requestId: 'req-d4a', revision: 0, goals: [{ text: '目标A', done: false }], todos: [] }, s.token)
    const mp = loadFn('dailyRecord', db, 'openid_A')
    const upd = await mp.main({
      action: 'save', date: DATE, requestId: 'req-d4b', revision: 1,
      goals: [{ text: '目标A', done: true }, { text: '目标B', done: false }], todos: [], segments: { life: '今天不错', work: '', growth: '' }
    })
    assert.strictEqual(upd.ok, true)
    const after = j(await post(daily, { action: 'get', date: DATE }, s.token))
    assert.strictEqual(after.record.revision, 2)
    assert.strictEqual(after.record.goals.length, 2)
    assert.strictEqual(after.record.goals[0].done, true)
  })

  await testCase('D5 重复提交同一 requestId：幂等，不重复加 revision', async () => {
    const db = seed()
    const s = await loginAs(db, 'openid_A')
    const daily = loadFn('desktopDaily', db, null)
    const body = { action: 'save', date: DATE, requestId: 'req-d5', revision: 0, goals: [{ text: '一次', done: false }], todos: [] }
    const first = j(await post(daily, body, s.token))
    const second = j(await post(daily, { ...body }, s.token))
    assert.strictEqual(first.revision, 1)
    assert.strictEqual(second.idempotent, true)
    assert.strictEqual(second.revision, 1)
    assert.strictEqual(db.dump().daily_records.length, 1, '不得产生第二条记录')
  })

  await testCase('D6 revision 冲突：拒绝覆盖并返回 409', async () => {
    const db = seed()
    db._data.daily_records.push({ _id: 'recA', _openid: 'openid_A', date: DATE, revision: 5, goals: [], todos: [] })
    const s = await loginAs(db, 'openid_A')
    const daily = loadFn('desktopDaily', db, null)
    const r = await post(daily, { action: 'save', date: DATE, requestId: 'req-d6', revision: 3, goals: [{ text: '覆盖尝试', done: false }], todos: [] }, s.token)
    assert.strictEqual(r.statusCode, 409)
    assert.strictEqual(j(r).code, 'REV_CONFLICT')
    assert.strictEqual(db.dump().daily_records[0].revision, 5, '冲突时原数据不得被改写')
    assert.deepStrictEqual(db.dump().daily_records[0].goals, [])
  })

  await testCase('D7 云端写失败：返回明确错误，不假装成功', async () => {
    const db = seed()
    db._data.daily_records.push({ _id: 'recA', _openid: 'openid_A', date: DATE, revision: 1, goals: [], todos: [] })
    const s = await loginAs(db, 'openid_A')
    const daily = loadFn('desktopDaily', db, null)
    db.injectFail('daily_records', 'update')
    const r = await post(daily, { action: 'save', date: DATE, requestId: 'req-d7', revision: 1, goals: [{ text: 'x', done: false }], todos: [] }, s.token)
    assert.strictEqual(r.statusCode, 500)
    assert.strictEqual(j(r).code, 'INTERNAL_ERROR')
    assert.strictEqual(db.dump().daily_records[0].revision, 1, '失败不得改动数据')
  })

  await testCase('D8 历史（V1）记录：只改 goals/todos，其余字段原样保留', async () => {
    const db = seed()
    db._data.daily_records.push({
      _id: 'recV1', _openid: 'openid_A', date: DATE,
      goals: [{ text: '旧目标', done: false }], todos: [],
      segments: { life: '旧生活', work: '旧工作', growth: '旧成长' },
      mood: { type: 'happy', weather: 'cloudy' }, score: 4, readProgress: 33
      // 注意：没有 revision 字段（V1）
    })
    const s = await loginAs(db, 'openid_A')
    const daily = loadFn('desktopDaily', db, null)
    const r = j(await post(daily, { action: 'save', date: DATE, requestId: 'req-d8', revision: 0, goals: [{ text: '新目标', done: true }], todos: [{ text: '新小事', done: false }] }, s.token))
    assert.strictEqual(r.ok, true)
    const rec = db.dump().daily_records[0]
    assert.deepStrictEqual(rec.segments, { life: '旧生活', work: '旧工作', growth: '旧成长' }, 'segments 不得被清空')
    assert.deepStrictEqual(rec.mood, { type: 'happy', weather: 'cloudy' })
    assert.strictEqual(rec.score, 4)
    assert.strictEqual(rec.readProgress, 33)
    assert.deepStrictEqual(rec.goals, [goalShape('新目标', true)])
    assert.strictEqual(rec.revision, 1)
  })

  await testCase('D9 未知 action：400 + 明确 code（不再是 500 内部错误）', async () => {
    const db = seed()
    const s = await loginAs(db, 'openid_A')
    const daily = loadFn('desktopDaily', db, null)
    const r = await post(daily, { action: 'dropAll' }, s.token)
    assert.strictEqual(r.statusCode, 400)
    assert.strictEqual(j(r).code, 'INVALID_ACTION')
  })

  await testCase('D10 日期格式非法：拒绝（不写库）', async () => {
    const db = seed()
    const s = await loginAs(db, 'openid_A')
    const daily = loadFn('desktopDaily', db, null)
    for (const bad of ['2026-13-01', '2026-02-30', '20261028', '', '2026-1-1']) {
      const r = await post(daily, { action: 'get', date: bad }, s.token)
      assert.strictEqual(r.statusCode, 400, '应拒绝日期 ' + bad)
      assert.strictEqual(j(r).code, 'DATE_INVALID')
    }
    assert.strictEqual(db.dump().daily_records.length, 0)
  })

  await testCase('D11 桌面保存不得抹掉 reminded（否则同一条目标会重复提醒）', async () => {
    const db = seed()
    db._data.daily_records.push({
      _id: 'recA', _openid: 'openid_A', date: DATE, revision: 1,
      // 这条目标今天已经提醒过了（reminderCheck 写的 reminded:true）
      goals: [{ text: '吃药', done: false, reminderOn: true, reminderTime: '08:00', reminded: true }],
      todos: []
    })
    const s = await loginAs(db, 'openid_A')
    const daily = loadFn('desktopDaily', db, null)
    const read = j(await post(daily, { action: 'get', date: DATE }, s.token))
    assert.strictEqual(read.record.goals[0].reminded, true, '读取时必须带出 reminded')
    // 桌面把读到的 goals 原样回写（用户只是勾了一个小事）
    const saved = j(await post(daily, { action: 'save', date: DATE, requestId: 'req-d11', revision: 1, goals: read.record.goals, todos: [{ text: '顺手做的小事', done: true }] }, s.token))
    assert.strictEqual(saved.ok, true)
    const g = db.dump().daily_records[0].goals[0]
    assert.strictEqual(g.reminded, true, 'reminded 必须原样保留，否则提醒会重复推送')
    assert.strictEqual(g.reminderOn, true)
    assert.strictEqual(g.reminderTime, '08:00')
  })

  // ============================================================
  // reminded 的服务端权威性（M2 冻结复核 · 2026-10-28）
  // reminded 由 reminderCheck 在「提醒已发出」后写入，是服务端状态。
  // 桌面若能把 true 写进去 = 可以抑制自己的提醒；能把 true 改回 false
  // = 同一条目标重复推送，直接消耗用户的一次性订阅消息额度。
  // 结论：客户端提交的 reminded 一律无效，只能由服务端从旧记录继承。
  // ============================================================
  await testCase('D12 客户端新建目标时伪造 reminded:true 不生效', async () => {
    const db = seed()
    const s = await loginAs(db, 'openid_A')
    const daily = loadFn('desktopDaily', db, null)
    const r = j(await post(daily, {
      action: 'save', date: DATE, requestId: 'req-d12', revision: 0,
      goals: [goalShape('伪造提醒', false, { reminderOn: true, reminderTime: '07:00', reminded: true })],
      todos: []
    }, s.token))
    assert.strictEqual(r.ok, true)
    assert.strictEqual(db.dump().daily_records[0].goals[0].reminded, false, '客户端不得把 reminded 写成 true')
  })

  await testCase('D13 客户端不得把服务端已写的 reminded:true 重置为 false', async () => {
    const db = seed()
    db._data.daily_records.push({
      _id: 'recB', _openid: 'openid_A', date: DATE, revision: 1,
      goals: [{ text: '吃药', done: false, reminderOn: true, reminderTime: '08:00', reminded: true }],
      todos: []
    })
    const s = await loginAs(db, 'openid_A')
    const daily = loadFn('desktopDaily', db, null)
    const r = j(await post(daily, {
      action: 'save', date: DATE, requestId: 'req-d13', revision: 1,
      goals: [goalShape('吃药', false, { reminderOn: true, reminderTime: '08:00', reminded: false })],
      todos: []
    }, s.token))
    assert.strictEqual(r.ok, true)
    assert.strictEqual(db.dump().daily_records[0].goals[0].reminded, true, 'reminded 是服务端状态，客户端改不动')
  })

  await testCase('D14 目标文本改变视为新目标，reminded 归零（应当重新提醒）', async () => {
    const db = seed()
    db._data.daily_records.push({
      _id: 'recC', _openid: 'openid_A', date: DATE, revision: 1,
      goals: [{ text: '吃药', done: false, reminderOn: true, reminderTime: '08:00', reminded: true }],
      todos: []
    })
    const s = await loginAs(db, 'openid_A')
    const daily = loadFn('desktopDaily', db, null)
    const r = j(await post(daily, {
      action: 'save', date: DATE, requestId: 'req-d14', revision: 1,
      goals: [goalShape('吃维生素', false, { reminderOn: true, reminderTime: '08:00' })],
      todos: []
    }, s.token))
    assert.strictEqual(r.ok, true)
    assert.strictEqual(db.dump().daily_records[0].goals[0].reminded, false, '内容变了就是另一条目标')
  })

  await testCase('D15 多条同文本目标按多重集继承 reminded，不串到别的目标', async () => {
    const db = seed()
    db._data.daily_records.push({
      _id: 'recD', _openid: 'openid_A', date: DATE, revision: 1,
      goals: [{ text: '喝水', done: false, reminderOn: true, reminderTime: '09:00', reminded: true }],
      todos: []
    })
    const s = await loginAs(db, 'openid_A')
    const daily = loadFn('desktopDaily', db, null)
    const r = j(await post(daily, {
      action: 'save', date: DATE, requestId: 'req-d15', revision: 1,
      goals: [
        goalShape('喝水', false, { reminderOn: true, reminderTime: '09:00' }),
        goalShape('喝水', false, { reminderOn: true, reminderTime: '09:00' })
      ],
      todos: []
    }, s.token))
    assert.strictEqual(r.ok, true)
    const stored = db.dump().daily_records[0].goals.map(g => g.reminded)
    assert.deepStrictEqual(stored, [true, false], '只有一条能继承「今天已提醒」，拼接出来的第二条必须还能提醒')
  })

  console.log('\n=== 结果 ===')
  console.log(`  ${passed} PASS / ${failed} FAIL`)
  if (failures.length) { console.log('\n失败明细：'); failures.forEach(f => console.log('  - ' + f)) }
  if (failed > 0) process.exit(1)
}

run().catch(e => { console.error(e); process.exit(1) })
