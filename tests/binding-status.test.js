// ============================================================
// tests/binding-status.test.js · M1 Binding UI status 接线测试
// 覆盖前端渲染所需的 status 视角：未绑定/生成码/pending 三态/确认/取消/过期
// 运行：node tests/binding-status.test.js
// ============================================================
const assert = require('assert')
const { MockDB } = require('./mock-db')
const core = require('../cloudfunctions/bindCouple/core')

const HER = 'her_001'
const HIM = 'him_001'
const NOW = Date.now()

let passed = 0
let failed = 0
const failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++
    console.log('  PASS  ' + name)
  }).catch(e => {
    failed++
    failures.push({ name, error: e.message })
    console.log('  FAIL  ' + name + '  -> ' + e.message)
  })
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a))
}
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }

function seed() {
  return new MockDB({
    users: [
      { _id: 'u_her', _openid: HER, role: 'her', coupleId: null, bindCode: 'XZ-INIT1', failCount: 0, failWindowStart: 0, schemaVersion: 2, createdAt: NOW },
      { _id: 'u_him', _openid: HIM, role: 'her', coupleId: null, bindCode: 'XZ-INIT2', failCount: 0, failWindowStart: 0, schemaVersion: 2, createdAt: NOW }
    ],
    couples: []
  })
}

async function runAll() {
  console.log('\n=== M1 Binding UI · status 接线测试 ===\n')

  await testCase('S1 未绑定：status 返回 bound=false + bindCode=null + pending=null', async () => {
    const db = seed()
    const s = await core.status({ db, openid: HER, now: NOW })
    assertOk(s.ok)
    assertEq(s.bound, false)
    assertEq(s.bindCode, null, 'users.bindCode 陈旧值不得作为可用绑定码返回')
    assertEq(s.pending, null)
    assertEq(s.role, 'her')
  })

  await testCase('S2 her 生成码后：status 显示 waiting_claim（等待对方输入）', async () => {
    const db = seed()
    const g = await core.generate({ db, herOpenid: HER, now: NOW })
    assertOk(g.ok)
    const s = await core.status({ db, openid: HER })
    assertEq(s.pending.state, 'waiting_claim')
    assertEq(s.pending.needsMe, false)
    assertEq(s.bound, false)
    assertEq(s.bindCode, g.bindCode)
  })

  await testCase('S3 him 认领后：her status 显示 confirm_needed（needsMe=true，待同意/拒绝）', async () => {
    const db = seed()
    const g = await core.generate({ db, herOpenid: HER, now: NOW })
    await core.claim({ db, code: g.bindCode, himOpenid: HIM, now: NOW + 1 })
    const s = await core.status({ db, openid: HER })
    assertEq(s.pending.state, 'confirm_needed')
    assertEq(s.pending.needsMe, true, 'her 侧需要操作')
    assertOk(s.pending.requestId)
  })

  await testCase('S4 him 认领后：him status 显示 waiting_confirm（等待对方确认）', async () => {
    const db = seed()
    const g = await core.generate({ db, herOpenid: HER, now: NOW })
    await core.claim({ db, code: g.bindCode, himOpenid: HIM, now: NOW + 1 })
    const s = await core.status({ db, openid: HIM })
    assertEq(s.pending.state, 'waiting_confirm')
    assertEq(s.pending.needsMe, false)
  })

  await testCase('S5 her 同意后：双方 status bound=true + coupleId', async () => {
    const db = seed()
    const g = await core.generate({ db, herOpenid: HER, now: NOW })
    await core.claim({ db, code: g.bindCode, himOpenid: HIM, now: NOW + 1 })
    const cf = await core.confirm({ db, herOpenid: HER, requestId: g.requestId, accept: true, now: NOW + 2 })
    assertOk(cf.ok)
    const sHer = await core.status({ db, openid: HER })
    const sHim = await core.status({ db, openid: HIM })
    assertEq(sHer.bound, true)
    assertEq(sHim.bound, true)
    assertEq(sHer.coupleId, cf.coupleId)
    assertEq(sHim.coupleId, cf.coupleId)
    assertEq(sHim.role, 'him')
    assertEq(sHer.pending, null)
    assertEq(sHim.pending, null)
  })

  await testCase('S6 her 取消后：status pending=null，可重新生成', async () => {
    const db = seed()
    const g = await core.generate({ db, herOpenid: HER, now: NOW })
    const c = await core.cancel({ db, herOpenid: HER, requestId: g.requestId, now: NOW + 1 })
    assertOk(c.ok)
    const s = await core.status({ db, openid: HER, now: NOW + 1 })
    assertEq(s.pending, null)
    assertEq(s.bindCode, null, '取消后不得暴露 users.bindCode 陈旧值')
    const g2 = await core.generate({ db, herOpenid: HER, now: NOW + 2 })
    assertOk(g2.ok, '取消后可重新生成')
  })

  await testCase('S7 过期 pending：status 触发惰性过期 → pending=null 且 couples 置 expired', async () => {
    const db = seed()
    await core.generate({ db, herOpenid: HER, now: NOW - 25 * 3600 * 1000 })
    const s = await core.status({ db, openid: HER, now: NOW })
    assertEq(s.pending, null, '过期 pending 应被清理')
    assertEq(s.bindCode, null, '过期 pending 不得暴露绑定码')
    assertEq(db.dump().couples[0].status, 'expired')
  })

  await testCase('S8 her 拒绝后：status bound=false + pending=null', async () => {
    const db = seed()
    const g = await core.generate({ db, herOpenid: HER, now: NOW })
    await core.claim({ db, code: g.bindCode, himOpenid: HIM, now: NOW + 1 })
    const rj = await core.confirm({ db, herOpenid: HER, requestId: g.requestId, accept: false, now: NOW + 2 })
    assertOk(rj.ok)
    const s = await core.status({ db, openid: HER })
    assertEq(s.bound, false)
    assertEq(s.pending, null)
  })

  await testCase('S9 已有 active 时换绑被拒：status 仍指向旧关系', async () => {
    const db = seed()
    // 建立首段关系
    const g1 = await core.generate({ db, herOpenid: HER, now: NOW })
    await core.claim({ db, code: g1.bindCode, himOpenid: HIM, now: NOW + 1 })
    await core.confirm({ db, herOpenid: HER, requestId: g1.requestId, accept: true, now: NOW + 2 })
    // 未解绑直接换绑：新码 → 新 him → confirm 应拒绝
    const g2 = await core.generate({ db, herOpenid: HER, now: NOW + 3 })
    await core.claim({ db, code: g2.bindCode, himOpenid: 'him_new', now: NOW + 4 })
    let code = null
    try { await core.confirm({ db, herOpenid: HER, requestId: g2.requestId, accept: true, now: NOW + 5 }) } catch (e) { code = e.code }
    assertEq(code, 'ALREADY_BOUND', '已有 active 应拒绝换绑')
    const s = await core.status({ db, openid: HER })
    assertEq(s.bound, true)
    assertEq(s.coupleId, g1.coupleId, 'status 应仍指向旧关系')
  })

  await testCase('S9b 先解绑后：可正常重新绑定到新关系', async () => {
    const db = seed()
    const g1 = await core.generate({ db, herOpenid: HER, now: NOW })
    await core.claim({ db, code: g1.bindCode, himOpenid: HIM, now: NOW + 1 })
    await core.confirm({ db, herOpenid: HER, requestId: g1.requestId, accept: true, now: NOW + 2 })
    await core.unbind({ db, openid: HER, now: NOW + 3 })
    const g2 = await core.generate({ db, herOpenid: HER, now: NOW + 4 })
    await core.claim({ db, code: g2.bindCode, himOpenid: 'him_new', now: NOW + 5 })
    const cf = await core.confirm({ db, herOpenid: HER, requestId: g2.requestId, accept: true, now: NOW + 6 })
    assertOk(cf.ok, '解绑后应可重新绑定')
    const s = await core.status({ db, openid: HER })
    assertEq(s.coupleId, g2.coupleId, 'status 应指向新关系')
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failures.length) {
    failures.forEach(f => console.log('  - ' + f.name + ': ' + f.error))
    process.exit(1)
  }
  console.log('Binding Status: ALL GREEN')
}

runAll().catch(e => { console.error('测试执行异常:', e); process.exit(1) })
