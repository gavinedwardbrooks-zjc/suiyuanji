const assert = require('assert')
const login = require('../cloudfunctions/loginSessionCore')
const { InMemoryLoginSessionRepository } = require('../cloudfunctions/loginSessionRepository')
const core = require('../cloudfunctions/desktopSessionCore')
const { InMemoryDesktopSessionRepository } = require('../cloudfunctions/desktopSessionRepository')
const fail = (p, code) => assert.rejects(p, e => e.message === code)
async function main() {
  const lr = new InMemoryLoginSessionRepository({ delayMs: 5 }); const dr = new InMemoryDesktopSessionRepository({ delayMs: 5 })
  const l = await login.createLoginSession({ desktopDeviceId: 'd', desktopDeviceName: 'PC', now: 1000 }); await lr.create(l.record); await login.confirmLoginSession({ repo: lr, sessionId: l.sessionId, nonce: l.nonce, authenticatedUserUid: 'uid_server', now: 2000 })
  const made = await core.createDesktopSession({ user_uid: 'uid_server', deviceId: 'd', deviceName: 'PC', now: 2000 }); await dr.create(made.record)
  assert(made.token.length >= 43); assert(!JSON.stringify(made.record).includes(made.token)); assert.strictEqual((await core.validateDesktopSession({ repo: dr, token: made.token, now: 2001 })).user_uid, 'uid_server'); await fail(core.validateDesktopSession({ repo: dr, token: 'wrong', now: 2001 }), 'INVALID_DESKTOP_SESSION')
  const before = (await dr.get(made.record.desktopSessionId)).lastSeenAt; await core.validateDesktopSession({ repo: dr, token: made.token, now: 2002 }); assert.strictEqual((await dr.get(made.record.desktopSessionId)).lastSeenAt, before); await core.validateDesktopSession({ repo: dr, token: made.token, now: 302002 }); assert.strictEqual((await dr.get(made.record.desktopSessionId)).lastSeenAt, 302002)
  assert.strictEqual((await core.revokeDesktopSession({ repo: dr, token: made.token, now: 4000 })).revoked, true); await fail(core.validateDesktopSession({ repo: dr, token: made.token, now: 4001 }), 'INVALID_DESKTOP_SESSION'); assert.strictEqual((await core.revokeDesktopSession({ repo: dr, token: made.token, now: 4002 })).code, 'ALREADY_REVOKED')
  const exp = await core.createDesktopSession({ user_uid: 'uid_x', deviceId: 'd', deviceName: 'PC', now: 1 }); await dr.create(exp.record); await fail(core.validateDesktopSession({ repo: dr, token: exp.token, now: exp.record.expiresAt }), 'INVALID_DESKTOP_SESSION'); assert.strictEqual((await dr.get(exp.record.desktopSessionId)).status, 'expired')
  const hL = new InMemoryLoginSessionRepository({ delayMs: 5 }); const hD = new InMemoryDesktopSessionRepository({ delayMs: 5 }); const h = await login.createLoginSession({ desktopDeviceId: 'd', desktopDeviceName: 'PC', now: 1 }); await hL.create(h.record); await login.confirmLoginSession({ repo: hL, sessionId: h.sessionId, nonce: h.nonce, authenticatedUserUid: 'uid_h', now: 2 }); const handoff = await core.consumeAndCreateDesktopSession({ loginCore: login, loginRepo: hL, desktopRepo: hD, loginSessionId: h.sessionId, pollSecret: h.pollSecret, deviceId: 'd', deviceName: 'PC', now: 3 }); assert(handoff.token); assert.strictEqual(hD.records.size, 1)
  const failL = new InMemoryLoginSessionRepository({ delayMs: 5 }); const failD = new InMemoryDesktopSessionRepository({ delayMs: 5 }); const f = await login.createLoginSession({ desktopDeviceId: 'd', desktopDeviceName: 'PC', now: 1 }); await failL.create(f.record); await login.confirmLoginSession({ repo: failL, sessionId: f.sessionId, nonce: f.nonce, authenticatedUserUid: 'uid_f', now: 2 }); failD.failCreate = true; await fail(core.consumeAndCreateDesktopSession({ loginCore: login, loginRepo: failL, desktopRepo: failD, loginSessionId: f.sessionId, pollSecret: f.pollSecret, deviceId: 'd', deviceName: 'PC', now: 3 }), 'DESKTOP_SESSION_CREATE_FAILED_RECOVERABLE'); assert.strictEqual((await failL.get(f.sessionId)).status, 'approved'); const retry = await core.consumeAndCreateDesktopSession({ loginCore: login, loginRepo: failL, desktopRepo: failD, loginSessionId: f.sessionId, pollSecret: f.pollSecret, deviceId: 'd', deviceName: 'PC', now: 4 }); assert(retry.token); assert.strictEqual(failD.records.size, 1); const replay = await core.consumeAndCreateDesktopSession({ loginCore: login, loginRepo: failL, desktopRepo: failD, loginSessionId: f.sessionId, pollSecret: f.pollSecret, deviceId: 'd', deviceName: 'PC', now: 5 }); assert(replay.token); assert.strictEqual(replay.rotated, true); assert.notStrictEqual(replay.token, retry.token); assert.strictEqual(failD.records.size, 1); await fail(core.validateDesktopSession({ repo: failD, token: retry.token, now: 6 }), 'INVALID_DESKTOP_SESSION'); assert.strictEqual((await core.validateDesktopSession({ repo: failD, token: replay.token, now: 6 })).user_uid, 'uid_f'); await fail(core.consumeAndCreateDesktopSession({ loginCore: login, loginRepo: failL, desktopRepo: failD, loginSessionId: f.sessionId, pollSecret: 'stolen-from-photo', deviceId: 'd', deviceName: 'PC', now: 7 }), 'INVALID_LOGIN_REQUEST')
  assert.throws(() => core.createDesktopSession({ user_uid: { x: 1 }, deviceId: 'd', deviceName: 'PC', now: 1 }), e => e.message === 'INVALID_USER_UID'); assert.throws(() => core.createDesktopSession({ user_uid: 'uid', deviceId: 'd', deviceName: 'x'.repeat(81), now: 1 }), e => e.message === 'INVALID_DEVICENAME')

  // ============================================================
  // 重放恢复的安全边界（M2 冻结复核 · 2026-10-28）
  // 争议点：consume 响应丢失后允许「凭 pollSecret 再换一次 token」，
  // 若不设窗口，pollSecret 就变成 30 天内可无限换发 token 的长期凭据。
  // ============================================================
  const replaySetup = async (now) => {
    const rL = new InMemoryLoginSessionRepository({ delayMs: 0 })
    const rD = new InMemoryDesktopSessionRepository({ delayMs: 0 })
    const s = await login.createLoginSession({ desktopDeviceId: 'd', desktopDeviceName: 'PC', now })
    await rL.create(s.record)
    await login.confirmLoginSession({ repo: rL, sessionId: s.sessionId, nonce: s.nonce, authenticatedUserUid: 'uid_r', now: now + 100 })
    const first = await core.consumeAndCreateDesktopSession({ loginCore: login, loginRepo: rL, desktopRepo: rD, loginSessionId: s.sessionId, pollSecret: s.pollSecret, deviceId: 'd', deviceName: 'PC', now: now + 200 })
    return { rL, rD, s, first }
  }

  // R1 换发窗口 = 登录会话有效期（5 分钟），不是 desktop session 的 30 天
  {
    const { rL, rD, s, first } = await replaySetup(1000)
    const again = await core.consumeAndCreateDesktopSession({ loginCore: login, loginRepo: rL, desktopRepo: rD, loginSessionId: s.sessionId, pollSecret: s.pollSecret, deviceId: 'd', deviceName: 'PC', now: 4000 })
    assert.strictEqual(again.rotated, true, '窗口内重放应允许恢复')
    assert.strictEqual(again.expiresAt, first.expiresAt, '换发 token 不得延长有效期（无无限续期）')
    await fail(core.validateDesktopSession({ repo: rD, token: first.token, now: 4001 }), 'INVALID_DESKTOP_SESSION')
    // s.record.expiresAt = 1000 + 5min = 301000：越过即拒绝
    await fail(core.consumeAndCreateDesktopSession({ loginCore: login, loginRepo: rL, desktopRepo: rD, loginSessionId: s.sessionId, pollSecret: s.pollSecret, deviceId: 'd', deviceName: 'PC', now: s.record.expiresAt }), 'DESKTOP_SESSION_ALREADY_USED')
    assert.strictEqual((await core.validateDesktopSession({ repo: rD, token: again.token, now: s.record.expiresAt })).user_uid, 'uid_r', '被拒绝的重放不得影响当前仍有效的 token')
    assert.strictEqual(rD.records.size, 1, '重放不得新建第二条 desktop session')
  }

  // R2 已撤销的会话不得靠重放「复活」
  {
    const { rL, rD, s, first } = await replaySetup(1000)
    assert.strictEqual((await core.revokeDesktopSession({ repo: rD, token: first.token, now: 2000 })).revoked, true)
    await fail(core.consumeAndCreateDesktopSession({ loginCore: login, loginRepo: rL, desktopRepo: rD, loginSessionId: s.sessionId, pollSecret: s.pollSecret, deviceId: 'd', deviceName: 'PC', now: 2100 }), 'DESKTOP_SESSION_ALREADY_USED')
    await fail(core.validateDesktopSession({ repo: rD, token: first.token, now: 2200 }), 'INVALID_DESKTOP_SESSION')
  }

  // R3 换发是「按旧 tokenHash 的 CAS」：并发重放只有一个赢家，不得两次都报成功
  {
    const cD = new InMemoryDesktopSessionRepository({ delayMs: 0 })
    const c = await core.createDesktopSession({ user_uid: 'uid_c', deviceId: 'd', deviceName: 'PC', now: 1 })
    await cD.create(c.record)
    const staleHash = core.hashToken(c.token)
    assert.strictEqual(await cD.rotateToken(c.record.desktopSessionId, 'active', staleHash, 'hashA', 2), true)
    assert.strictEqual(await cD.rotateToken(c.record.desktopSessionId, 'active', staleHash, 'hashB', 3), false, '旧 hash 已失效，第二次必须失败')
    assert.strictEqual((await cD.get(c.record.desktopSessionId)).tokenHash, 'hashA', '失败的重放不得覆盖当前 token')
  }

  console.log('desktop session core tests PASS')
}
main().catch(e => { console.error(e); process.exit(1) })
