// ============================================================
// tests/p3-share-server.test.js · V1.1 P3.1 日期级主动分享（真实云函数逻辑）
//
// 用真实 cloudfunctions/getPartnerView/index.js + 内存版云数据库，
// 不 mock 业务分支 —— 断言的是「服务端真的会这样判定」。
//
// 覆盖：
//   A 默认私密（缺字段 / 显式 false / 非布尔真值）
//   B her 开启 / 关闭分享（幂等、只写分享字段、不碰 daily_records）
//   C him 读取：只返回心情/天气/三段日记，其余私人字段一律不出现
//   D 权限矩阵：他不能开启、其他情侣不能读、解绑失效、换绑不继承
//   E 旧记录（缺 coupleId）保持 fail-closed
//   F 日期校验（非法 / 未来）
//
// 运行：node tests/p3-share-server.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const { MockDB } = require('./mock-db')

const ROOT = path.resolve(__dirname, '..')
const D1 = '2026-10-20'
const D_LEGACY = '2026-10-01'

const HER_A = 'A_her_openid'
const HIM_B = 'B_him_openid'
const HER_C = 'C_her_openid'
const HIM_D = 'D_him_openid'
const HIM_E = 'E_him_openid'

let OPENID = HER_A

let passed = 0, failed = 0, failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name) })
    .catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message) })
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a))
}
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }

// ---------------- mock wx-server-sdk ----------------
function loadFn(db) {
  const origLoad = Module._load
  Module._load = function (request) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test',
        init() {},
        database: () => db,
        getWXContext: () => ({ OPENID }),
        openapi: { subscribeMessage: { send: async () => ({ errCode: 0 }) } }
      }
    }
    return origLoad.apply(this, arguments)
  }
  const fnPath = path.join(ROOT, 'cloudfunctions/getPartnerView/index.js')
  delete require.cache[fnPath]
  const mod = require(fnPath)
  Module._load = origLoad
  return mod
}

// ---------------- 种子数据 ----------------
function record(openid, date, coupleId, extra) {
  const r = {
    _openid: openid,
    date,
    coupleId,
    revision: 3,
    goals: [{ text: '目标里的私密计划', done: false, reminderOn: false, reminderTime: '21:00' }],
    todos: [{ text: '私密待办', done: false }],
    segments: { life: '生活里的秘密内容', work: '工作里的秘密内容', growth: '成长里的秘密内容' },
    mood: { type: 'happy', weather: 'rain' },
    score: 4,
    wishes: [],
    readProgress: 42,
    herSummary: 'HER_SUMMARY_SECRET',
    symptoms: ['SYMPTOM_SECRET'],
    schemaVersion: 2,
    createdAt: 1,
    updatedAt: 2
  }
  if (coupleId === undefined) delete r.coupleId
  return Object.assign(r, extra || {})
}

function seed() {
  return {
    users: [
      { _id: 'uA', _openid: HER_A, role: 'her', coupleId: 'CZ-1', partnerName: '' },
      { _id: 'uB', _openid: HIM_B, role: 'him', coupleId: 'CZ-1', partnerName: '' },
      { _id: 'uC', _openid: HER_C, role: 'her', coupleId: 'CZ-2', partnerName: '' },
      { _id: 'uD', _openid: HIM_D, role: 'him', coupleId: 'CZ-2', partnerName: '' },
      { _id: 'uE', _openid: HIM_E, role: 'him', coupleId: null, partnerName: '' }
    ],
    couples: [
      { _id: 'c1', coupleId: 'CZ-1', status: 'active', herOpenid: HER_A, himOpenid: HIM_B, anniversary: null },
      { _id: 'c2', coupleId: 'CZ-2', status: 'active', herOpenid: HER_C, himOpenid: HIM_D, anniversary: null }
    ],
    daily_records: [
      record(HER_A, D1, 'CZ-1'),
      record(HER_A, D_LEGACY, undefined),
      record(HER_C, D1, 'CZ-2')
    ]
  }
}

function shareDoc(db, extra) {
  return Object.assign({
    _id: 'sh_' + HER_A + '_' + D1,
    _openid: HER_A,
    date: D1,
    coupleId: 'CZ-1',
    himOpenid: HIM_B,
    enabled: true,
    createdAt: 1,
    updatedAt: 1
  }, extra || {})
}

const shareOf = (db, openid, date) => (db.dump().record_shares || [])
  .filter(d => d._openid === openid && d.date === date)

// P3.3-R1（D2）：shareSet 要求客户端上送它已确认的版本号（CAS）。
// 非并发用例统一走这个辅助：等价于「页面刚读完状态，用户立刻点了开关」。
function curRevOf(db, openid, date) {
  const d = (db.dump().record_shares || []).find(x => x._openid === openid && x.date === date)
  if (!d) return 0
  return typeof d.rev === 'number' && d.rev >= 0 ? d.rev : 0
}
function setShare(fn, db, date, enabled, expectedRev) {
  const rev = expectedRev === undefined ? curRevOf(db, OPENID, date) : expectedRev
  return fn.main({ action: 'shareSet', date, enabled, expectedRev: rev })
}

async function main() {
  console.log('\n=== P3.1 主动分享 · 服务端 ===\n')

  // ---------------- A. 默认私密 ----------------
  await testCase('A1 没有任何分享文档 → him 读不到 shared，私人字段完全不出现', async () => {
    const db = new MockDB(seed())
    const fn = loadFn(db)
    OPENID = HIM_B
    const r = await fn.main({ action: 'view', date: D1 })
    assertEq(r.ok, true)
    assertEq(r.shared, null, 'shared 必须是 null 而不是空对象')
    assertEq(Object.prototype.hasOwnProperty.call(r, 'interaction'), false,
      'interaction 字段已随记录级互动一并移除')
    const json = JSON.stringify(r)
    for (const s of ['生活里的秘密内容', '工作里的秘密内容', '成长里的秘密内容',
      'HER_SUMMARY_SECRET', 'SYMPTOM_SECRET', '私密待办', 'readProgress', 'schemaVersion']) {
      assertOk(json.indexOf(s) === -1, '响应里不该出现：' + s)
    }
  })

  await testCase('A2 分享文档 enabled=false → 不共享', async () => {
    const db = new MockDB(seed())
    db._data.record_shares = [shareDoc(db, { enabled: false })]
    const fn = loadFn(db)
    OPENID = HIM_B
    const r = await fn.main({ action: 'view', date: D1 })
    assertEq(r.shared, null)
  })

  await testCase('A3 分享文档缺 enabled 字段 → 不共享（缺字段 = 没授权）', async () => {
    const db = new MockDB(seed())
    const doc = shareDoc(db)
    delete doc.enabled
    db._data.record_shares = [doc]
    const fn = loadFn(db)
    OPENID = HIM_B
    const r = await fn.main({ action: 'view', date: D1 })
    assertEq(r.shared, null)
  })

  await testCase('A4 非布尔真值（"true" / 1 / 对象）都不算开启', async () => {
    for (const bad of ['true', 1, '1', {}, []]) {
      const db = new MockDB(seed())
      db._data.record_shares = [shareDoc(db, { enabled: bad })]
      const fn = loadFn(db)
      OPENID = HIM_B
      const r = await fn.main({ action: 'view', date: D1 })
      assertEq(r.shared, null, 'enabled=' + JSON.stringify(bad) + ' 不得视为开启')
    }
  })

  await testCase('A5 her 的 shareStatus 默认未分享，canShare=true（记录属于当前关系）', async () => {
    const db = new MockDB(seed())
    const fn = loadFn(db)
    OPENID = HER_A
    const r = await fn.main({ action: 'shareStatus', date: D1 })
    assertEq(r.ok, true)
    assertEq(r.enabled, false)
    assertEq(r.canShare, true)
    assertEq(r.hasRecord, true)
  })

  // ---------------- B. her 开启 / 关闭 ----------------
  await testCase('B1 her 开启分享 → 只写分享字段，daily_records 一个字节都不变', async () => {
    const db = new MockDB(seed())
    const fn = loadFn(db)
    OPENID = HER_A
    const before = JSON.stringify(db.dump().daily_records)
    const r = await setShare(fn, db, D1, true)
    assertEq(r.ok, true)
    assertEq(r.enabled, true)
    const after = JSON.stringify(db.dump().daily_records)
    assertEq(after, before, '分享操作绝不能改动 daily_records')

    const docs = shareOf(db, HER_A, D1)
    assertEq(docs.length, 1, '只应有一条分享文档')
    assertEq(docs[0].coupleId, 'CZ-1', '必须绑定当前关系')
    assertEq(docs[0].himOpenid, HIM_B, '必须绑定被授权的具体 him')
    assertEq(docs[0].enabled, true)
  })

  await testCase('B2 开启幂等：重复开启仍只有一条文档', async () => {
    const db = new MockDB(seed())
    const fn = loadFn(db)
    OPENID = HER_A
    await setShare(fn, db, D1, true)
    await setShare(fn, db, D1, true)
    assertEq(shareOf(db, HER_A, D1).length, 1)
  })

  await testCase('B3 关闭幂等：重复关闭仍是 enabled=false，且不删除文档（保留历史语义）', async () => {
    const db = new MockDB(seed())
    const fn = loadFn(db)
    OPENID = HER_A
    await setShare(fn, db, D1, true)
    await setShare(fn, db, D1, false)
    await setShare(fn, db, D1, false)
    const docs = shareOf(db, HER_A, D1)
    assertEq(docs.length, 1)
    assertEq(docs[0].enabled, false)
  })

  await testCase('B4 enabled 不是布尔（"true" / 1）→ BAD_ARGS，且不写库', async () => {
    for (const bad of ['true', 1, 'false', null, undefined]) {
      const db = new MockDB(seed())
      const fn = loadFn(db)
      OPENID = HER_A
      const r = await fn.main({ action: 'shareSet', date: D1, enabled: bad })
      assertEq(r.ok, false, 'enabled=' + JSON.stringify(bad) + ' 必须拒绝')
      assertEq(r.code, 'BAD_ARGS')
      assertEq(shareOf(db, HER_A, D1).length, 0, '被拒绝的请求不得产生文档')
    }
  })

  await testCase('B5 关闭后 him 立刻读不到（服务端每次重新判定，不缓存）', async () => {
    const db = new MockDB(seed())
    const fn = loadFn(db)
    OPENID = HER_A
    await setShare(fn, db, D1, true)
    OPENID = HIM_B
    assertOk((await fn.main({ action: 'view', date: D1 })).shared, '开启后应可读')
    OPENID = HER_A
    await setShare(fn, db, D1, false)
    OPENID = HIM_B
    const after = await fn.main({ action: 'view', date: D1 })
    assertEq(after.shared, null, '关闭后必须立刻读不到')
    assertOk(JSON.stringify(after).indexOf('生活里的秘密内容') === -1)
  })

  // ---------------- C. 内容白名单 ----------------
  await testCase('C1 开启后 him 只拿到心情、天气、三段日记（逐字段精确匹配）', async () => {
    const db = new MockDB(seed())
    db._data.record_shares = [shareDoc(db)]
    const fn = loadFn(db)
    OPENID = HIM_B
    const r = await fn.main({ action: 'view', date: D1 })
    assertOk(r.shared, 'shared 应存在')
    assertEq(Object.keys(r.shared).sort().join(','), 'mood,segments')
    assertEq(Object.keys(r.shared.mood).sort().join(','), 'type,weather')
    assertEq(r.shared.mood.type, 'happy')
    assertEq(r.shared.mood.weather, 'rain')
    assertEq(Object.keys(r.shared.segments).sort().join(','), 'growth,life,work')
    assertEq(r.shared.segments.life, '生活里的秘密内容')
    assertEq(r.shared.segments.work, '工作里的秘密内容')
    assertEq(r.shared.segments.growth, '成长里的秘密内容')
    // 同一份响应里仍然不得出现任何其它私人字段
    const json = JSON.stringify(r)
    for (const s of ['HER_SUMMARY_SECRET', 'SYMPTOM_SECRET', '私密待办', '目标里的私密计划']) {
      assertOk(json.indexOf(s) === -1, '响应里不该出现：' + s)
    }
  })

  await testCase('C2 her 自己不会因为分享而拿到 shared（shared 只对 him 生效）', async () => {
    const db = new MockDB(seed())
    db._data.record_shares = [shareDoc(db)]
    const fn = loadFn(db)
    OPENID = HER_A
    const r = await fn.main({ action: 'view', date: D1 })
    assertEq(r.shared, null)
  })

  await testCase('C3 分享的是没有日记的记录 → 三段返回空串（不推断、不造内容）', async () => {
    const db = new MockDB(seed())
    db._data.daily_records[0].segments = {}
    db._data.record_shares = [shareDoc(db)]
    const fn = loadFn(db)
    OPENID = HIM_B
    const r = await fn.main({ action: 'view', date: D1 })
    assertEq(r.shared.segments.life, '')
    assertEq(r.shared.segments.work, '')
    assertEq(r.shared.segments.growth, '')
  })

  // ---------------- D. 权限矩阵 ----------------
  await testCase('D1 him 不能开启 / 关闭分享，也不能读她的分享状态', async () => {
    const db = new MockDB(seed())
    const fn = loadFn(db)
    OPENID = HIM_B
    const a = await setShare(fn, db, D1, true)
    assertEq(a.ok, false)
    assertEq(a.code, 'FORBIDDEN')
    const b = await fn.main({ action: 'shareStatus', date: D1 })
    assertEq(b.ok, false)
    assertEq(b.code, 'FORBIDDEN')
    assertEq(shareOf(db, HER_A, D1).length, 0)
  })

  await testCase('D2 另一对情侣的 him 读不到（partnerOpenid 不是她 → 没有记录）', async () => {
    const db = new MockDB(seed())
    db._data.record_shares = [shareDoc(db)]
    const fn = loadFn(db)
    OPENID = HIM_D
    const r = await fn.main({ action: 'view', date: D1 })
    assertEq(r.shared, null, 'D 只能看到 C 的记录，不能拿到 A 的分享')
    assertOk(JSON.stringify(r).indexOf('生活里的秘密内容') === -1)
  })

  await testCase('D3 解绑后（status≠active）him 直接 NOT_ACTIVE，拿不到任何内容', async () => {
    const db = new MockDB(seed())
    db._data.couples[0].status = 'superseded'
    db._data.record_shares = [shareDoc(db)]
    const fn = loadFn(db)
    OPENID = HIM_B
    const r = await fn.main({ action: 'view', date: D1 })
    assertEq(r.ok, false)
    assertEq(r.code, 'NOT_ACTIVE')
    assertOk(JSON.stringify(r).indexOf('生活里的秘密内容') === -1)
  })

  await testCase('D4 换绑后：新 him 不继承旧分享（旧文档 coupleId/himOpenid 都不匹配）', async () => {
    const db = new MockDB(seed())
    db._data.record_shares = [shareDoc(db)]      // 旧授权：CZ-1 / B
    // A 与 E 重新绑定
    db._data.couples[0] = { _id: 'c1', coupleId: 'CZ-9', status: 'active', herOpenid: HER_A, himOpenid: HIM_E, anniversary: null }
    db._data.users[0].coupleId = 'CZ-9'
    db._data.users[4].coupleId = 'CZ-9'
    // 新关系里的记录（记录本身是新的关系标记）
    db._data.daily_records[0].coupleId = 'CZ-9'
    const fn = loadFn(db)
    OPENID = HIM_E
    const r = await fn.main({ action: 'view', date: D1 })
    assertEq(r.shared, null, '新伴侣绝不能继承上一段关系的分享授权')
    // 她自己看到的状态也必须是「未分享」（旧授权对当前关系无效）
    OPENID = HER_A
    const s = await fn.main({ action: 'shareStatus', date: D1 })
    assertEq(s.enabled, false)
    assertEq(s.canShare, true)
  })

  await testCase('D5 换绑后她重新开启 → 新 him 可以读，旧 him 不能', async () => {
    const db = new MockDB(seed())
    db._data.record_shares = [shareDoc(db)]
    db._data.couples[0] = { _id: 'c1', coupleId: 'CZ-9', status: 'active', herOpenid: HER_A, himOpenid: HIM_E, anniversary: null }
    db._data.users[0].coupleId = 'CZ-9'
    db._data.users[4].coupleId = 'CZ-9'
    db._data.daily_records[0].coupleId = 'CZ-9'
    const fn = loadFn(db)
    OPENID = HER_A
    const set = await setShare(fn, db, D1, true)
    assertEq(set.ok, true)
    const docs = shareOf(db, HER_A, D1)
    assertEq(docs[0].coupleId, 'CZ-9')
    assertEq(docs[0].himOpenid, HIM_E)

    OPENID = HIM_E
    assertOk((await fn.main({ action: 'view', date: D1 })).shared, '新 him 应能读')
    OPENID = HIM_B
    const old = await fn.main({ action: 'view', date: D1 })
    assertEq(old.ok, false, '旧的 him 已经没有 active 关系')
  })

  await testCase('D6 分享文档被伪造成别人的 coupleId → 不生效（服务端只认当前关系）', async () => {
    const db = new MockDB(seed())
    db._data.record_shares = [shareDoc(db, { coupleId: 'CZ-2' })]
    const fn = loadFn(db)
    OPENID = HIM_B
    assertEq((await fn.main({ action: 'view', date: D1 })).shared, null)
  })

  await testCase('D7 分享文档指向另一个 him → 不生效', async () => {
    const db = new MockDB(seed())
    db._data.record_shares = [shareDoc(db, { himOpenid: HIM_D })]
    const fn = loadFn(db)
    OPENID = HIM_B
    assertEq((await fn.main({ action: 'view', date: D1 })).shared, null)
  })

  // ---------------- E. 旧记录 fail-closed ----------------
  await testCase('E1 历史记录缺 coupleId：canShare=false，shareSet 拒绝', async () => {
    const db = new MockDB(seed())
    const fn = loadFn(db)
    OPENID = HER_A
    const s = await fn.main({ action: 'shareStatus', date: D_LEGACY })
    assertEq(s.canShare, false, '无法证明归属的记录不得分享')
    assertEq(s.hasRecord, true)
    const r = await setShare(fn, db, D_LEGACY, true)
    assertEq(r.ok, false)
    assertEq(r.code, 'RECORD_NOT_IN_COUPLE')
    assertEq(shareOf(db, HER_A, D_LEGACY).length, 0, '失败时不得留下授权文档')
  })

  await testCase('E2 历史记录即使被手工塞了 enabled 文档，him 依然读不到', async () => {
    const db = new MockDB(seed())
    db._data.record_shares = [shareDoc(db, { date: D_LEGACY })]
    const fn = loadFn(db)
    OPENID = HIM_B
    const r = await fn.main({ action: 'view', date: D_LEGACY })
    assertEq(r.shared, null)
  })

  await testCase('E3 没有记录的那一天不能分享（NO_RECORD）', async () => {
    const db = new MockDB(seed())
    const fn = loadFn(db)
    OPENID = HER_A
    const r = await setShare(fn, db, '2026-10-05', true)
    assertEq(r.ok, false)
    assertEq(r.code, 'NO_RECORD')
  })

  // ---------------- F. 日期校验 ----------------
  await testCase('F1 非法日期 / 未来日期一律 BAD_ARGS', async () => {
    const db = new MockDB(seed())
    const fn = loadFn(db)
    OPENID = HER_A
    for (const d of ['2026-02-30', '2026-13-01', 'abc', '2026-1-1', '2999-01-01', '']) {
      const r = await setShare(fn, db, d, true)
      assertEq(r.ok, false, 'date=' + JSON.stringify(d) + ' 应被拒绝')
      assertEq(r.code, 'BAD_ARGS')
    }
    OPENID = HIM_B
    const v = await fn.main({ action: 'view', date: '2999-01-01' })
    assertEq(v.ok, false)
    assertEq(v.code, 'BAD_ARGS')
  })

  await testCase('F2 切到另一天：A 日开启不会让 B 日也可读', async () => {
    const db = new MockDB(seed())
    db._data.daily_records.push(record(HER_A, '2026-10-21', 'CZ-1'))
    db._data.record_shares = [shareDoc(db)]
    const fn = loadFn(db)
    OPENID = HIM_B
    assertOk((await fn.main({ action: 'view', date: D1 })).shared)
    assertEq((await fn.main({ action: 'view', date: '2026-10-21' })).shared, null,
      '分享只对被开启的那一天生效')
  })

  await testCase('F3 revision 保存不影响分享授权（两套写入互不覆盖）', async () => {
    const db = new MockDB(seed())
    const fn = loadFn(db)
    OPENID = HER_A
    await setShare(fn, db, D1, true)
    // 模拟 dailyRecord.save 覆盖 revision 与业务字段（分享字段不在 payload 里）
    const rec = db.dump().daily_records[0]
    const drFn = loadFn2(db, 'dailyRecord')
    const saved = await drFn.main({
      action: 'save', date: D1, requestId: 'req_p3_1', revision: rec.revision,
      goals: [], todos: [], segments: { life: '改过的生活', work: '', growth: '' },
      mood: { type: 'calm', weather: 'sunny' }, wishes: [], score: 5, readProgress: 0
    })
    assertEq(saved.ok, true)
    OPENID = HIM_B
    const v = await fn.main({ action: 'view', date: D1 })
    assertOk(v.shared, '保存记录后分享仍然有效')
    assertEq(v.shared.segments.life, '改过的生活', '共享的是记录的最新内容')
    assertEq(shareOf(db, HER_A, D1)[0].enabled, true)
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    console.log('\n失败用例:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('P3 Share Server: ALL GREEN')
}

// 需要按名字载入（dailyRecord / getPartnerView 各自独立打包）
function loadFn2(db, name) {
  const origLoad = Module._load
  Module._load = function (request) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test',
        init() {},
        database: () => db,
        getWXContext: () => ({ OPENID }),
        openapi: { subscribeMessage: { send: async () => ({ errCode: 0 }) } }
      }
    }
    return origLoad.apply(this, arguments)
  }
  const fnPath = path.join(ROOT, 'cloudfunctions/' + name + '/index.js')
  delete require.cache[fnPath]
  const mod = require(fnPath)
  Module._load = origLoad
  return mod
}

main()
