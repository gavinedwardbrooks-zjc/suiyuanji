const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { MockDB } = require('./mock-db')
const core = require('../cloudfunctions/bindCouple/core')

const HER = 'her_regression'
const HIM = 'him_regression'
const OTHER = 'other_regression'
const NOW = 1700000000000

function dbFor({ users = [], couples = [] } = {}) {
  return new MockDB({
    users: [
      { _id: 'u_her', _openid: HER, role: 'her', coupleId: null, failCount: 0, failWindowStart: 0 },
      { _id: 'u_him', _openid: HIM, role: 'him', failCount: 0, failWindowStart: 0 },
      { _id: 'u_other', _openid: OTHER, role: 'him', failCount: 0, failWindowStart: 0 },
      ...users
    ],
    couples
  })
}

async function run() {
  let passed = 0
  async function t(name, fn) { await fn(); passed++; console.log('  PASS  ' + name) }
  console.log('\n=== Couple bind code regression ===\n')

  await t('BIND_CODE_GENERATE_VALID', async () => {
    const db = dbFor()
    const r = await core.generate({ db, herOpenid: HER, now: NOW })
    assert.strictEqual(r.ok, true)
    assert.match(r.bindCode, /^XZ-[A-Z2-9]{8}$/)
    const p = db.dump().couples[0]
    assert.strictEqual(p.bindCode, r.bindCode)
    assert.strictEqual(p.expiresAt, NOW + core.PENDING_TTL_MS)
  })

  await t('BIND_CODE_TRIM_AND_CASE_NORMALIZE', async () => {
    const db = dbFor()
    const g = await core.generate({ db, herOpenid: HER, now: NOW })
    const r = await core.claim({ db, code: '  ' + g.bindCode.toLowerCase() + '  ', himOpenid: HIM, now: NOW + 1 })
    assert.strictEqual(r.ok, true)
  })

  await t('ACTIVE_PENDING_RETURNS_CORRECT_BIND_CODE', async () => {
    const db = dbFor()
    const g = await core.generate({ db, herOpenid: HER, now: NOW })
    const s = await core.status({ db, openid: HER, now: NOW + 1 })
    assert.strictEqual(s.bindCode, g.bindCode)
    assert.strictEqual(s.pending.state, 'waiting_claim')
  })

  await t('CANCELLED_PENDING_DOES_NOT_EXPOSE_STALE_BIND_CODE', async () => {
    const db = dbFor()
    const g = await core.generate({ db, herOpenid: HER, now: NOW })
    assert.strictEqual((await core.cancel({ db, herOpenid: HER, requestId: g.requestId, now: NOW + 1 })).ok, true)
    const snapshot = db.dump()
    assert.strictEqual(snapshot.users.find(u => u._openid === HER).bindCode, g.bindCode, '测试必须保留 users.bindCode 陈旧值以覆盖缺陷')
    const s = await core.status({ db, openid: HER, now: NOW + 2 })
    assert.strictEqual(s.pending, null)
    assert.strictEqual(s.bindCode, null)
  })

  await t('CANCELLED_PENDING_CANNOT_BE_CLAIMED', async () => {
    const db = dbFor()
    const g = await core.generate({ db, herOpenid: HER, now: NOW })
    await core.cancel({ db, herOpenid: HER, requestId: g.requestId, now: NOW + 1 })
    const c = await core.claim({ db, code: g.bindCode, himOpenid: HIM, now: NOW + 2 })
    assert.strictEqual(c.ok, false)
    assert.strictEqual(c.code, 'INVALID_CODE')
  })

  await t('EXPIRED_PENDING_DOES_NOT_EXPOSE_BIND_CODE', async () => {
    const db = dbFor()
    const g = await core.generate({ db, herOpenid: HER, now: NOW })
    const s = await core.status({ db, openid: HER, now: NOW + core.PENDING_TTL_MS })
    assert.strictEqual(s.pending, null)
    assert.strictEqual(s.bindCode, null)
    const p = db.dump().couples.find(c => c.requestId === g.requestId)
    assert.strictEqual(p.status, 'expired')
    assert.strictEqual(p.expiredReason, 'timeout')
  })

  await t('OTHER_IDENTITY_CANNOT_ACCESS_PENDING_BIND_CODE', async () => {
    const db = dbFor()
    await core.generate({ db, herOpenid: HER, now: NOW })
    const s = await core.status({ db, openid: OTHER, now: NOW + 1 })
    assert.strictEqual(s.bindCode, null)
    assert.strictEqual(s.pending, null)
  })

  await t('MISSING_AND_NULL_COUPLE_ID_ARE_UNBOUND', async () => {
    const missing = dbFor()
    assert.strictEqual((await core.generate({ db: missing, herOpenid: HER, now: NOW })).ok, true)
    const nul = dbFor({ users: [{ _id: 'u_extra', _openid: 'extra', coupleId: null }] })
    assert.strictEqual((await core.generate({ db: nul, herOpenid: HER, now: NOW })).ok, true)
  })

  await t('SELF_BIND_BLOCKED', async () => {
    const db = dbFor()
    const g = await core.generate({ db, herOpenid: HER, now: NOW })
    const r = await core.claim({ db, code: g.bindCode, himOpenid: HER, now: NOW + 1 })
    assert.strictEqual(r.code, 'SELF_BIND')
  })

  await t('HISTORICAL_UNBOUND_SEED_IS_REAL', async () => {
    const historical = { _id: 'old', coupleId: 'CZ-OLD', herOpenid: HER, himOpenid: 'old_him', status: 'unbound', unboundAt: NOW - 1000 }
    const db = dbFor({ couples: [historical] })
    assert.strictEqual(db.dump().couples.some(c => c._id === 'old' && c.status === 'unbound'), true, '历史记录必须通过 seed 真正进入 MockDB')
    const g = await core.generate({ db, herOpenid: HER, now: NOW })
    const c = await core.claim({ db, code: g.bindCode, himOpenid: HIM, now: NOW + 1 })
    assert.strictEqual(c.ok, true)
    const confirmed = await core.confirm({ db, herOpenid: HER, requestId: g.requestId, accept: true, now: NOW + 2 })
    assert.strictEqual(confirmed.ok, true)
    const old = db.dump().couples.find(item => item._id === 'old')
    assert.strictEqual(old.status, 'unbound')
    assert.strictEqual(old.unboundAt, historical.unboundAt)
  })

  await t('GENERATE_CLAIM_SCHEMA_CONTRACT', async () => {
    const db = dbFor()
    const g = await core.generate({ db, herOpenid: HER, now: NOW })
    const p = db.dump().couples.find(c => c.requestId === g.requestId)
    assert.strictEqual(p.bindCode, g.bindCode)
    assert.strictEqual(p.status, 'pending')
    assert.strictEqual(p.herOpenid, HER)
    assert.strictEqual(p.expiresAt, NOW + core.PENDING_TTL_MS)
    const claim = await core.claim({ db, code: p.bindCode, himOpenid: HIM, now: NOW + 1 })
    assert.strictEqual(claim.ok, true)
    assert.strictEqual(claim.requestId, p.requestId)
  })

  await t('VALID_CODE_CAN_CREATE_NEW_COUPLE', async () => {
    const db = dbFor()
    const g = await core.generate({ db, herOpenid: HER, now: NOW })
    await core.claim({ db, code: g.bindCode, himOpenid: HIM, now: NOW + 1 })
    const c = await core.confirm({ db, herOpenid: HER, requestId: g.requestId, accept: true, now: NOW + 2 })
    assert.strictEqual(c.ok, true)
    const active = db.dump().couples.find(item => item.coupleId === g.coupleId)
    assert.strictEqual(active.status, 'active')
  })

  await t('SERVER_IDENTITY_AUTHORITY_PRESERVED', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/bindCouple/index.js'), 'utf8')
    assert.match(source, /cloud\.getWXContext\(\)/)
    assert.match(source, /core\.status\(\{ db: adapter, openid: OPENID \}\)/)
    assert.match(source, /core\.generate\(\{ db: adapter, herOpenid: OPENID, now \}\)/)
    assert.match(source, /core\.claim\(\{ db: adapter, code: event\.code, himOpenid: OPENID, now \}\)/)
    assert.doesNotMatch(source, /event\.(?:openid|OPENID|user_uid|coupleId|role)/)
  })

  await t('MINE_AND_OURS_CANCEL_STATE_REFRESH', async () => {
    const mine = fs.readFileSync(path.join(__dirname, '../pages/mine/mine.js'), 'utf8')
    const ours = fs.readFileSync(path.join(__dirname, '../pages/ours/ours.js'), 'utf8')
    assert.match(mine, /setData\(\{ statusLoading: true, bindCode: '', pending: null \}\)/)
    assert.match(mine, /setData\(\{ acting: false, bindCode: '', pending: null \}\)/)
    assert.match(mine, /app\.globalData\.bindCode = null/)
    assert.match(mine, /网络异常，请重试[\s\S]*this\.refresh\(\)/)
    assert.match(ours, /setData\(\{ loading: true, bindCode: '', pending: null \}\)/)
    assert.match(ours, /setData\(\{ acting: false, bindCode: '', pending: null \}\)/)
    assert.match(ours, /app\.globalData\.bindCode = null/)
    assert.match(ours, /网络异常，请重试[\s\S]*this\.load\(\)/)
  })

  function pending({ id, requestId, herOpenid = HER, himOpenid = null, createdAt, bindCode }) {
    return {
      _id: id,
      coupleId: 'CZ-' + id,
      requestId,
      herOpenid,
      himOpenid,
      createdAt,
      expiresAt: NOW + core.PENDING_TTL_MS,
      bindCode,
      status: 'pending'
    }
  }

  async function statusForOrder(couples, openid = HER) {
    return core.status({ db: dbFor({ couples }), openid, now: NOW })
  }

  await t('MULTIPLE_HER_PENDING_ORDER_INDEPENDENT', async () => {
    const older = pending({ id: 'p-her-old', requestId: 'req-her-old', createdAt: NOW - 20, bindCode: 'XZ-HEROLD22' })
    const newer = pending({ id: 'p-her-new', requestId: 'req-her-new', createdAt: NOW - 10, bindCode: 'XZ-HERNEW22' })
    const forward = await statusForOrder([older, newer])
    const reversed = await statusForOrder([newer, older])
    assert.deepStrictEqual(forward, reversed)
    assert.strictEqual(forward.pending.requestId, newer.requestId)
  })

  await t('MULTIPLE_HIM_PENDING_ORDER_INDEPENDENT', async () => {
    const older = pending({ id: 'p-him-old', requestId: 'req-him-old', herOpenid: 'owner_old', himOpenid: HIM, createdAt: NOW - 20, bindCode: 'XZ-HIMOLD22' })
    const newer = pending({ id: 'p-him-new', requestId: 'req-him-new', herOpenid: 'owner_new', himOpenid: HIM, createdAt: NOW - 10, bindCode: 'XZ-HIMNEW22' })
    const forward = await statusForOrder([older, newer], HIM)
    const reversed = await statusForOrder([newer, older], HIM)
    assert.deepStrictEqual(forward, reversed)
    assert.strictEqual(forward.pending.requestId, newer.requestId)
    assert.strictEqual(forward.bindCode, null)
  })

  await t('HER_AND_HIM_PENDING_PRIORITY', async () => {
    const ownWaitingClaim = pending({ id: 'p-own', requestId: 'req-own', createdAt: NOW - 1, bindCode: 'XZ-OWNCODE22' })
    const claimedOther = pending({ id: 'p-other', requestId: 'req-other', herOpenid: OTHER, himOpenid: HER, createdAt: NOW - 100, bindCode: 'XZ-OTHERC22' })
    const forward = await statusForOrder([ownWaitingClaim, claimedOther])
    const reversed = await statusForOrder([claimedOther, ownWaitingClaim])
    assert.deepStrictEqual(forward, reversed)
    assert.strictEqual(forward.pending.state, 'waiting_confirm')
    assert.strictEqual(forward.pending.requestId, claimedOther.requestId)
  })

  await t('CONFIRM_NEEDED_PRIORITY', async () => {
    const confirmNeeded = pending({ id: 'p-confirm', requestId: 'req-confirm', himOpenid: HIM, createdAt: NOW - 100, bindCode: 'XZ-CONFIRM2' })
    const waitingConfirm = pending({ id: 'p-wait', requestId: 'req-wait', herOpenid: OTHER, himOpenid: HER, createdAt: NOW - 1, bindCode: 'XZ-WAITING2' })
    const forward = await statusForOrder([waitingConfirm, confirmNeeded])
    const reversed = await statusForOrder([confirmNeeded, waitingConfirm])
    assert.deepStrictEqual(forward, reversed)
    assert.strictEqual(forward.pending.state, 'confirm_needed')
    assert.strictEqual(forward.pending.requestId, confirmNeeded.requestId)
    assert.strictEqual(forward.bindCode, null, '已被认领的绑定码不再处于可展示状态')
  })

  await t('WAITING_CONFIRM_PRIORITY', async () => {
    const waitingClaim = pending({ id: 'p-claim', requestId: 'req-claim', createdAt: NOW - 1, bindCode: 'XZ-WAITCLM2' })
    const waitingConfirm = pending({ id: 'p-wait', requestId: 'req-wait', herOpenid: OTHER, himOpenid: HER, createdAt: NOW - 100, bindCode: 'XZ-WAITCNF2' })
    const forward = await statusForOrder([waitingClaim, waitingConfirm])
    const reversed = await statusForOrder([waitingConfirm, waitingClaim])
    assert.deepStrictEqual(forward, reversed)
    assert.strictEqual(forward.pending.state, 'waiting_confirm')
    assert.strictEqual(forward.pending.requestId, waitingConfirm.requestId)
  })

  await t('SAME_TIMESTAMP_STABLE_TIEBREAK', async () => {
    const idB = pending({ id: 'p-b', requestId: 'req-b', createdAt: NOW - 1, bindCode: 'XZ-TIECODEB' })
    const idA = pending({ id: 'p-a', requestId: 'req-a', createdAt: NOW - 1, bindCode: 'XZ-TIECODEA' })
    const forward = await statusForOrder([idB, idA])
    const reversed = await statusForOrder([idA, idB])
    assert.deepStrictEqual(forward, reversed)
    assert.strictEqual(forward.pending.requestId, idA.requestId)
    assert.strictEqual(forward.bindCode, idA.bindCode)
  })

  await t('BIND_CODE_MATCHES_SELECTED_PENDING', async () => {
    const older = pending({ id: 'p-code-old', requestId: 'req-code-old', createdAt: NOW - 20, bindCode: 'XZ-CODEOLD2' })
    const newer = pending({ id: 'p-code-new', requestId: 'req-code-new', createdAt: NOW - 10, bindCode: 'XZ-CODENEW2' })
    const result = await statusForOrder([newer, older])
    assert.strictEqual(result.pending.requestId, newer.requestId)
    assert.strictEqual(result.bindCode, newer.bindCode)
  })

  await t('NO_PARTNER_BIND_CODE_LEAK', async () => {
    const ownWaitingClaim = pending({ id: 'p-own-leak', requestId: 'req-own-leak', createdAt: NOW - 1, bindCode: 'XZ-OWNLEAK2' })
    const partnerFlow = pending({ id: 'p-partner', requestId: 'req-partner', herOpenid: OTHER, himOpenid: HER, createdAt: NOW - 100, bindCode: 'XZ-SECRET22' })
    const result = await statusForOrder([ownWaitingClaim, partnerFlow])
    assert.strictEqual(result.pending.requestId, partnerFlow.requestId)
    assert.strictEqual(result.pending.state, 'waiting_confirm')
    assert.strictEqual(result.bindCode, null)
  })

  await t('EXPIRED_PENDING_EXCLUDED', async () => {
    const expired = pending({ id: 'p-expired', requestId: 'req-expired', himOpenid: HIM, createdAt: NOW - core.PENDING_TTL_MS, bindCode: 'XZ-EXPIRED2' })
    expired.expiresAt = NOW
    const valid = pending({ id: 'p-valid', requestId: 'req-valid', createdAt: NOW - 10, bindCode: 'XZ-VALID222' })
    const db = dbFor({ couples: [expired, valid] })
    const result = await core.status({ db, openid: HER, now: NOW })
    assert.strictEqual(result.pending.requestId, valid.requestId)
    assert.strictEqual(result.bindCode, valid.bindCode)
    const expiredAfter = db.dump().couples.find(item => item._id === expired._id)
    assert.strictEqual(expiredAfter.status, 'expired')
    assert.strictEqual(expiredAfter.expiredReason, 'timeout')
  })

  await t('SINGLE_PENDING_BACKWARD_COMPATIBILITY', async () => {
    const only = pending({ id: 'p-only', requestId: 'req-only', createdAt: NOW - 1, bindCode: 'XZ-ONLYCODE2' })
    const result = await statusForOrder([only])
    assert.strictEqual(result.pending.requestId, only.requestId)
    assert.strictEqual(result.pending.createdAt, only.createdAt)
    assert.strictEqual(result.pending.state, 'waiting_claim')
    assert.strictEqual(result.pending.needsMe, false)
    assert.strictEqual(result.bindCode, only.bindCode)
  })

  console.log('\n=== RESULT: ' + passed + ' PASS / 0 FAIL ===')
}

run().catch(e => { console.error(e); process.exit(1) })
