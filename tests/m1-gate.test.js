// ============================================================
// tests/m1-gate.test.js · M1 Gate C 部分 16 case（PRD v0.6 §7 M1 + Gate 清单）
// 运行：node tests/m1-gate.test.js
// 无外部依赖，node 内置 assert
// ============================================================
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { MockDB } = require('./mock-db')
const { listPublishableFiles } = require('./private-terms.js')
const core = require('../cloudfunctions/bindCouple/core')

const ROOT = path.resolve(__dirname, '..')
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

function seedBase(extra) {
  const users = [
    { _id: 'u_her', _openid: HER, role: 'her', nickName: '她', coupleId: null, bindCode: 'XZ-INIT1', failCount: 0, failWindowStart: 0, schemaVersion: 2, createdAt: NOW },
    { _id: 'u_him', _openid: HIM, role: 'her', nickName: '她', coupleId: null, bindCode: 'XZ-INIT2', failCount: 0, failWindowStart: 0, schemaVersion: 2, createdAt: NOW }
  ]
  const couples = []
  if (extra && extra.activeCouple) {
    couples.push({
      _id: 'c_old', coupleId: 'CZ-OLD', herOpenid: HER, himOpenid: 'him_old',
      status: 'active', bindCode: null, boundAt: NOW - 86400000, createdAt: NOW - 86400000
    })
    users[0].coupleId = 'CZ-OLD'
  }
  if (extra && extra.pending) {
    couples.push({
      _id: 'c_pending', coupleId: 'CZ-PEND', herOpenid: HER, himOpenid: null,
      bindCode: extra.pendingCode || 'XZ-ABCDEF12', status: 'pending',
      requestId: extra.pendingRequestId || 'req_p1', createdAt: extra.pendingAgeMs !== undefined ? NOW - extra.pendingAgeMs : NOW
    })
  }
  return new MockDB({ users, couples })
}

// ==================== 16 Gate Cases ====================

async function runAll() {
  console.log('\n=== M1 Gate C · 16 cases ===\n')

  // C1 同码并发 2 请求 → exactly 1 pending
  await testCase('C1 同码并发认领，仅 1 个 pending 生效', async () => {
    const db = seedBase()
    const gen = await core.generate({ db, herOpenid: HER, now: NOW })
    assert.strictEqual(gen.ok, true)
    const [r1, r2] = await Promise.all([
      core.claim({ db, code: gen.bindCode, himOpenid: HIM, now: NOW }),
      core.claim({ db, code: gen.bindCode, himOpenid: 'him_002', now: NOW })
    ])
    const okCount = [r1, r2].filter(r => r.ok).length
    assert.strictEqual(okCount, 1, '并发认领应恰好 1 个成功，实际 ' + okCount)
    const pendings = db.dump().couples.filter(c => c.status === 'pending')
    assert.strictEqual(pendings.length, 1, '应恰好存在 1 个 pending')
  })

  // C2 连续失败 5 次 → 被拒
  await testCase('C2 连续失败 5 次后第 6 次被拒（限流）', async () => {
    const db = seedBase()
    let last
    for (let i = 0; i < 5; i++) last = await core.claim({ db, code: 'XZ-WRONG00', himOpenid: HIM, now: NOW + i })
    assert.strictEqual(last.ok, false)
    const after5 = await core.claim({ db, code: 'XZ-WRONG00', himOpenid: HIM, now: NOW + 5 })
    assert.strictEqual(after5.code, 'RATE_LIMITED', '第 6 次应被限流拒绝')
    const u = db.dump().users.find(u => u._openid === HIM)
    assert.strictEqual(u.failCount, 5)
  })

  // C3 失败 5 次 → login → 第 6 次仍拒绝
  await testCase('C3 login 不重置限流：错 5 次后 login 仍被拒', async () => {
    const db = seedBase()
    for (let i = 0; i < 5; i++) await core.claim({ db, code: 'XZ-WRONG00', himOpenid: HIM, now: NOW + i })
    // 模拟 login：只读用户 + 迁移 + 补码，绝不碰 failCount
    const u = db.dump().users.find(u => u._openid === HIM)
    const migrated = core.migrateDocV1ToV2(u)
    assert.strictEqual(migrated.changed, false)
    assert.strictEqual(db.dump().users.find(x => x._openid === HIM).failCount, 5, 'login 后 failCount 不得变化')
    const r6 = await core.claim({ db, code: 'XZ-WRONG00', himOpenid: HIM, now: NOW + 6 })
    assert.strictEqual(r6.code, 'RATE_LIMITED', '第 6 次仍应被拒')
  })

  // C4 有 pending → 再生成码 → 拒绝
  await testCase('C4 pending 唯一性：有有效 pending 时再生成被拒', async () => {
    const db = seedBase()
    const g1 = await core.generate({ db, herOpenid: HER, now: NOW })
    assert.strictEqual(g1.ok, true)
    const g2 = await core.generate({ db, herOpenid: HER, now: NOW + 1 })
    assert.strictEqual(g2.ok, false)
    assert.strictEqual(g2.code, 'PENDING_EXISTS')
    assert.strictEqual(db.dump().couples.filter(c => c.status === 'pending').length, 1)
  })

  // C5 取消 pending → 可重新生成
  await testCase('C5 取消 pending 后可重新生成', async () => {
    const db = seedBase()
    const g1 = await core.generate({ db, herOpenid: HER, now: NOW })
    const c = await core.cancel({ db, herOpenid: HER, requestId: g1.requestId, now: NOW + 1 })
    assert.strictEqual(c.ok, true)
    const g2 = await core.generate({ db, herOpenid: HER, now: NOW + 2 })
    assert.strictEqual(g2.ok, true, '取消后应可重新生成')
  })

  // C6 构造 createdAt=25h 前 pending → 确认失败并 expired
  await testCase('C6 过期 pending（25h）确认失败并转 expired', async () => {
    const db = seedBase({ pending: true, pendingCode: 'XZ-OLD00001', pendingRequestId: 'req_old', pendingAgeMs: 25 * 3600 * 1000 })
    const r = await core.confirm({ db, herOpenid: HER, requestId: 'req_old', accept: true, now: NOW })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.code, 'EXPIRED')
    assert.strictEqual(db.dump().couples.find(c => c._id === 'c_pending').status, 'expired')
  })

  // C7 pending → 同意 → active
  await testCase('C7 她同意后 pending → active', async () => {
    const db = seedBase()
    const g = await core.generate({ db, herOpenid: HER, now: NOW })
    const cl = await core.claim({ db, code: g.bindCode, himOpenid: HIM, now: NOW + 1 })
    assert.strictEqual(cl.ok, true)
    const cf = await core.confirm({ db, herOpenid: HER, requestId: g.requestId, accept: true, now: NOW + 2 })
    assert.strictEqual(cf.ok, true)
    const couples = db.dump().couples
    assert.strictEqual(couples.filter(c => c.status === 'active').length, 1)
    assert.strictEqual(couples.find(c => c.status === 'active').himOpenid, HIM)
    const him = db.dump().users.find(u => u._openid === HIM)
    assert.strictEqual(him.role, 'him', '小宇绑定后 role 应置 him')
    assert.strictEqual(him.coupleId, cf.coupleId)
  })

  // C8 pending → 拒绝 → 不 active
  await testCase('C8 她拒绝后不产生 active', async () => {
    const db = seedBase()
    const g = await core.generate({ db, herOpenid: HER, now: NOW })
    await core.claim({ db, code: g.bindCode, himOpenid: HIM, now: NOW + 1 })
    const rj = await core.confirm({ db, herOpenid: HER, requestId: g.requestId, accept: false, now: NOW + 2 })
    assert.strictEqual(rj.ok, true)
    const couples = db.dump().couples
    assert.strictEqual(couples.filter(c => c.status === 'active').length, 0)
    assert.strictEqual(couples.find(c => c._id === couples[0]._id).status, 'expired')
  })

  // C9 active → bindCode=null
  await testCase('C9 active 后 bindCode 置空', async () => {
    const db = seedBase()
    const g = await core.generate({ db, herOpenid: HER, now: NOW })
    await core.claim({ db, code: g.bindCode, himOpenid: HIM, now: NOW + 1 })
    await core.confirm({ db, herOpenid: HER, requestId: g.requestId, accept: true, now: NOW + 2 })
    const active = db.dump().couples.find(c => c.status === 'active')
    assert.strictEqual(active.bindCode, null)
    assert.ok(!active.bindCode)
  })

  // C10 已有 active → 换绑被拒（必须先前解绑，防双 active）
  await testCase('C10 已有 active 时换绑被拒：旧 active 保持', async () => {
    const db = seedBase({ activeCouple: true })
    const g = await core.generate({ db, herOpenid: HER, now: NOW })
    await core.claim({ db, code: g.bindCode, himOpenid: HIM, now: NOW + 1 })
    let code = null
    try {
      await core.confirm({ db, herOpenid: HER, requestId: g.requestId, accept: true, now: NOW + 2 })
    } catch (e) { code = e.code }
    assert.strictEqual(code, 'ALREADY_BOUND', '已有 active 应拒绝换绑')
    const couples = db.dump().couples
    const oldC = couples.find(c => c._id === 'c_old')
    assert.strictEqual(oldC.status, 'active', '旧关系应保持 active')
    assert.strictEqual(couples.filter(c => c.status === 'active').length, 1, '仍只 1 个 active')
    const her = db.dump().users.find(u => u._openid === HER)
    assert.strictEqual(her.coupleId, 'CZ-OLD')
  })

  // C10b 先解绑 → 换绑成功（正常重新绑定路径）
  await testCase('C10b 先解绑后可正常换绑', async () => {
    const db = seedBase({ activeCouple: true })
    const ub = await core.unbind({ db, openid: HER, now: NOW })
    assert.strictEqual(ub.ok, true)
    const g = await core.generate({ db, herOpenid: HER, now: NOW + 1 })
    await core.claim({ db, code: g.bindCode, himOpenid: HIM, now: NOW + 2 })
    const cf = await core.confirm({ db, herOpenid: HER, requestId: g.requestId, accept: true, now: NOW + 3 })
    assert.strictEqual(cf.ok, true)
    const activeList = db.dump().couples.filter(c => c.status === 'active')
    assert.strictEqual(activeList.length, 1)
    assert.strictEqual(activeList[0].coupleId, cf.coupleId)
    const oldC = db.dump().couples.find(c => c._id === 'c_old')
    assert.strictEqual(oldC.status, 'unbound', '旧关系应 unbound')
  })

  // C10c 对方（him）已有 active → 拒绝（PARTNER_ALREADY_BOUND）
  await testCase('C10c 对方已有 active 时拒绝（PARTNER_ALREADY_BOUND）', async () => {
    // her 无 active，但 him 已与他人 active
    const db = seedBase()
    db.collection('couples').add({ data: { _id: 'c_him_old', coupleId: 'CZ-HIM', herOpenid: 'him_old_her', himOpenid: HIM, status: 'active' } })
    db.collection('users').doc('u_him').update({ data: { coupleId: 'CZ-HIM', role: 'him' } })
    const g = await core.generate({ db, herOpenid: HER, now: NOW })
    await core.claim({ db, code: g.bindCode, himOpenid: HIM, now: NOW + 1 })
    let code = null
    try {
      await core.confirm({ db, herOpenid: HER, requestId: g.requestId, accept: true, now: NOW + 2 })
    } catch (e) { code = e.code }
    assert.strictEqual(code, 'PARTNER_ALREADY_BOUND', '对方已有 active 应拒绝')
  })

  // C11 换绑失败 → old active 不变
  await testCase('C11 换绑拒绝：旧 active 不受影响', async () => {
    const db = seedBase({ activeCouple: true })
    const g = await core.generate({ db, herOpenid: HER, now: NOW })
    await core.claim({ db, code: g.bindCode, himOpenid: HIM, now: NOW + 1 })
    await core.confirm({ db, herOpenid: HER, requestId: g.requestId, accept: false, now: NOW + 2 })
    const oldC = db.dump().couples.find(c => c._id === 'c_old')
    assert.strictEqual(oldC.status, 'active', '拒绝后旧 active 必须保持')
    const her = db.dump().users.find(u => u._openid === HER)
    assert.strictEqual(her.coupleId, 'CZ-OLD')
  })

  // C12 V1 fixture → 迁移成功
  await testCase('C12 V1 fixture 迁移成功（schemaVersion 缺失=v1→2）', async () => {
    const fixture = require('./v1-fixture.json')
    const uDoc = { ...fixture.users[0] }
    const dDoc = { ...fixture.daily_records[0] }
    const pDoc = { ...fixture.profiles[0] }
    const mu = core.migrateDocV1ToV2(uDoc)
    const md = core.migrateDocV1ToV2(dDoc)
    const mp = core.migrateDocV1ToV2(pDoc)
    assert.strictEqual(mu.changed && md.changed && mp.changed, true, 'v1 文档应判定为需要迁移')
    assert.strictEqual(mu.doc.schemaVersion, 2)
    assert.strictEqual(md.doc.schemaVersion, 2)
    assert.strictEqual(mp.doc.schemaVersion, 2)
    assert.strictEqual(mu.doc.nickName, '她')
    assert.strictEqual(md.doc.score, 4)
    assert.strictEqual(md.doc.segments.life, '今天去公园散步了')
    assert.strictEqual(mp.doc.topKeywords.length, 3)
  })

  // C13 连续迁移两次 → 第二次 no-op
  await testCase('C13 迁移幂等：第二次 no-op', async () => {
    const fixture = require('./v1-fixture.json')
    const doc = { ...fixture.users[0] }
    const m1 = core.migrateDocV1ToV2(doc)
    const m2 = core.migrateDocV1ToV2(m1.doc)
    assert.strictEqual(m1.changed, true)
    assert.strictEqual(m2.changed, false, '已迁移文档第二次应 no-op')
    assert.strictEqual(m2.doc.schemaVersion, 2)
  })

  // C14 migration 前后核心字段值相同
  await testCase('C14 迁移前后核心字段值不变', async () => {
    const fixture = require('./v1-fixture.json')
    const before = { u: { ...fixture.users[0] }, d: { ...fixture.daily_records[0] }, p: { ...fixture.profiles[0] } }
    const afterU = core.migrateDocV1ToV2(before.u).doc
    const afterD = core.migrateDocV1ToV2(before.d).doc
    const afterP = core.migrateDocV1ToV2(before.p).doc
    for (const key of Object.keys(before.u)) if (key !== 'schemaVersion') assert.deepStrictEqual(afterU[key], before.u[key])
    for (const key of Object.keys(before.d)) if (key !== 'schemaVersion') assert.deepStrictEqual(afterD[key], before.d[key])
    for (const key of Object.keys(before.p)) if (key !== 'schemaVersion') assert.deepStrictEqual(afterP[key], before.p[key])
    assert.strictEqual(Object.keys(afterU).length, Object.keys(before.u).length + 1)
  })

  // C15 repo scan 找不到 AI Key
  await testCase('C15 全仓库扫描无 AI Key', async () => {
    const keyPatterns = [/sk-[A-Za-z0-9]{16,}/, /AI_API_KEY\s*[:=]\s*['"][^'"]{8,}/, /api[_-]?key\s*[:=]\s*['"][A-Za-z0-9]{16,}/i]
    // 扫描口径统一到「一旦提交就会公开」的文件集合（tests/private-terms.js::listPublishableFiles）：
    //   排除 依赖 / 构建产物（dist、target、gen）/ 本地私有目录（.local）/ 私人配置 / 内部资料。
    // 与旧实现的差别只有两点，方向都是**更严**：
    //   1) 不再进入 desktop/src-tauri/target 这类编译产物 —— 旧实现会扫 Cargo 指纹文件，
    //      其中的随机串（如 task-03a8…）会撞出 sk- 形态的**假阳性**，与源码安全无关。
    //   2) 不再跳过 tests/ —— 测试文件同样会被提交、同样会公开，必须照扫。
    const files = listPublishableFiles(ROOT)
    assert.ok(files.length > 100, '可发布文件枚举异常偏少，疑似枚举失效: ' + files.length)
    const hits = []
    for (const rel of files) {
      if (!/\.(js|json|md|wxml|wxss)$/.test(rel)) continue
      let content
      try { content = fs.readFileSync(path.join(ROOT, rel), 'utf8') } catch (e) { continue }
      for (const p of keyPatterns) {
        const m = content.match(p)
        if (m) hits.push(rel + ' -> ' + m[0].slice(0, 40))
      }
    }
    assert.strictEqual(hits.length, 0, '发现疑似密钥: ' + hits.join(', '))
  })

  // C16 theme / illustration dirs / SOURCES.md 存在
  await testCase('C16 视觉地基文件齐全', async () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'style/theme.wxss')), 'theme.wxss 缺失')
    assert.ok(fs.existsSync(path.join(ROOT, 'assets/illustrations/SOURCES.md')), 'SOURCES.md 缺失')
    const theme = fs.readFileSync(path.join(ROOT, 'style/theme.wxss'), 'utf8')
    assert.ok(theme.includes('#FBF6EF'), 'theme.wxss 缺背景令牌 #FBF6EF')
    assert.ok(theme.includes('#E8899C'), 'theme.wxss 缺主色 #E8899C')
    assert.ok(theme.includes('#4A3F35'), 'theme.wxss 缺文字色 #4A3F35')
  })

  // ==================== Gate D STOP 条件复核 ====================
  console.log('\n=== Gate D STOP 条件复核 ===\n')
  await testCase('D1 绑定码不可重复认领（二次 claim 幂等但不可换人）', async () => {
    const db = seedBase()
    const g = await core.generate({ db, herOpenid: HER, now: NOW })
    const c1 = await core.claim({ db, code: g.bindCode, himOpenid: HIM, now: NOW + 1 })
    assert.strictEqual(c1.ok, true)
    const c2 = await core.claim({ db, code: g.bindCode, himOpenid: 'him_002', now: NOW + 2 })
    assert.strictEqual(c2.ok, false, '他人重复认领必须失败')
    assert.strictEqual(c2.code, 'CODE_TAKEN')
  })
  await testCase('D2 pending 不可绕过 her 确认直接 active', async () => {
    const db = seedBase()
    const g = await core.generate({ db, herOpenid: HER, now: NOW })
    await core.claim({ db, code: g.bindCode, himOpenid: HIM, now: NOW + 1 })
    // 没有任何操作能跳过 confirm：再 claim 一次（him 幂等）仍 pending
    const again = await core.claim({ db, code: g.bindCode, himOpenid: HIM, now: NOW + 2 })
    assert.strictEqual(again.ok, true)
    assert.strictEqual(db.dump().couples.filter(c => c.status === 'active').length, 0)
  })
  await testCase('D3 login 不能绕过限流（failCount 全程未变）', async () => {
    const db = seedBase()
    for (let i = 0; i < 5; i++) await core.claim({ db, code: 'XZ-WRONG00', himOpenid: HIM, now: NOW + i })
    const u = db.dump().users.find(x => x._openid === HIM)
    assert.strictEqual(u.failCount, 5)
    // login 路径（模拟）：迁移 + 补码，均不写 failCount
    core.migrateDocV1ToV2(u)
    assert.strictEqual(db.dump().users.find(x => x._openid === HIM).failCount, 5)
  })
  await testCase('D4 同一 her 不可同时持有多个有效 pending', async () => {
    const db = seedBase()
    await core.generate({ db, herOpenid: HER, now: NOW })
    const g2 = await core.generate({ db, herOpenid: HER, now: NOW + 1 })
    assert.strictEqual(g2.ok, false)
    assert.strictEqual(db.dump().couples.filter(c => c.status === 'pending').length, 1)
  })
  await testCase('D5 过期 pending 不可确认', async () => {
    const db = seedBase({ pending: true, pendingCode: 'XZ-OLD00002', pendingRequestId: 'req_old2', pendingAgeMs: 25 * 3600 * 1000 })
    const r = await core.confirm({ db, herOpenid: HER, requestId: 'req_old2', accept: true, now: NOW })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(db.dump().couples.find(c => c._id === 'c_pending').status, 'expired')
  })
  await testCase('D6 解绑后旧 partner 失权（unbound，无 active）', async () => {
    const db = seedBase({ activeCouple: true })
    const ub = await core.unbind({ db, openid: HER, now: NOW })
    assert.strictEqual(ub.ok, true)
    const oldC = db.dump().couples.find(c => c._id === 'c_old')
    assert.strictEqual(oldC.status, 'unbound')
    // 旧 partner（him_old）不再有 active 关系
    const oldPartnerActive = db.dump().couples.find(c => c.himOpenid === 'him_old' && c.status === 'active')
    assert.strictEqual(oldPartnerActive, undefined)
    // 双方 coupleId 都清空
    const her = db.dump().users.find(u => u._openid === HER)
    assert.strictEqual(her.coupleId, null)
  })
  await testCase('D7 先解绑再换绑：全程只 1 个 active', async () => {
    const db = seedBase({ activeCouple: true })
    await core.unbind({ db, openid: HER, now: NOW })
    const g = await core.generate({ db, herOpenid: HER, now: NOW + 1 })
    await core.claim({ db, code: g.bindCode, himOpenid: HIM, now: NOW + 2 })
    const cf = await core.confirm({ db, herOpenid: HER, requestId: g.requestId, accept: true, now: NOW + 3 })
    assert.strictEqual(cf.ok, true)
    const actives = db.dump().couples.filter(c => c.status === 'active')
    assert.strictEqual(actives.length, 1)
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failures.length) {
    console.log('\n失败明细:')
    failures.forEach(f => console.log('  - ' + f.name + ': ' + f.error))
    process.exit(1)
  }
  console.log('M1 Gate: ALL GREEN')
}

runAll().catch(e => {
  console.error('测试执行异常:', e)
  process.exit(1)
})
