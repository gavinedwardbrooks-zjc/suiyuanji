// ============================================================
// tests/m8-travel.test.js · M8 今天去哪里测试（PRD v0.8 / 指令 §60-66）
// seed 完整性 / diagnose-repair / 随机 / 详情 / 编辑 / AI / UI
// 运行：node tests/m8-travel.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const fs = require('fs')
const { MockDB } = require('./mock-db')
const { TRAVEL_PLACES, TRAVEL_SEED_VERSION, validateTravelSeed } = require('../cloudfunctions/lifePlanner/travel-places-seed')

const ROOT = path.resolve(__dirname, '..')
let passed = 0, failed = 0, failures = []

function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name) }
  else { failed++; failures.push(name + (detail ? ' -> ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : '')) }
}
function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name) })
    .catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message) })
}
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)) }
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }

let OPENID = 'A'
let aiCalls = 0
function loadLp(db, failAI) {
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return { DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => db, getWXContext: () => ({ OPENID }) }
    }
    return origLoad.apply(this, arguments)
  }
  const fnPath = path.resolve(__dirname, '../cloudfunctions/lifePlanner/index.js')
  delete require.cache[fnPath]
  const mod = require(fnPath)
  Module._load = origLoad
  aiCalls = 0
  mod.__setTransport(async (messages) => {
    aiCalls++
    if (failAI) throw new Error('AI down')
    // 根据 prompt 判断北京/外地
    const isBj = messages[0].content.includes('1 日情侣轻松游')
    const days = isBj ? 1 : 3
    const ds = []
    for (let i = 1; i <= days; i++) {
      ds.push({ day: i, title: '第' + i + '天', items: [
        { period: 'morning', title: '早上去玩', description: '轻松出发' },
        { period: 'evening', title: '晚上休息', description: '回酒店' }
      ] })
    }
    return JSON.stringify({ title: '测试计划', days: ds, tips: ['出发前查官方信息'] })
  })
  return mod
}

function seedDb(extra) {
  return new MockDB(Object.assign({
    users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', schemaVersion: 2 },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', schemaVersion: 2 },
      { _id: 'u_x', _openid: 'X', role: 'her', coupleId: null, schemaVersion: 2 }
    ],
    couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'active', anniversary: null }],
    recipes: [], travel_places: [], daily_records: [], wishes: [], messages: [], menstrual: []
  }, extra || {}))
}
async function runSeed(db) {
  const mod = loadLp(db)
  OPENID = 'A'
  const r = await mod.main({ action: 'seedTravelPlaces' })
  assertOk(r.ok)
  assertEq(r.inserted, 60, '插入 60 条')
}

async function runAll() {
  console.log('\n=== M8-1 · seed 完整性 ===\n')
  const v = validateTravelSeed()
  check('S1 total = 60', v.total === 60, '实际 ' + v.total)
  check('S2 beijing = 30', v.byType.beijing === 30)
  check('S3 outside = 30', v.byType.outside === 30)
  check('S4 name+type 无重复', v.problems.filter(p => p.includes('重复')).length === 0)
  check('S5 所有 shortIntro 非空', v.problems.filter(p => p.includes('缺简介')).length === 0)
  check('S6 所有 highlights 非空', v.problems.filter(p => p.includes('缺亮点')).length === 0)
  check('S7 所有 plan 非空', v.problems.filter(p => p.includes('缺计划')).length === 0)
  check('S8 beijing defaultDays=1', v.problems.filter(p => p.includes('北京天数')).length === 0)
  check('S9 outside defaultDays=3', v.problems.filter(p => p.includes('外地天数')).length === 0)
  check('S10 seedVersion=1', TRAVEL_SEED_VERSION === 1)

  await testCase('S11 seedTravelPlaces 插入 60 条，enabled 全 boolean true，写策略并发', async () => {
    const db = seedDb()
    await runSeed(db)
    const list = db.dump().travel_places
    assertEq(list.length, 60)
    assertOk(list.every(p => p.enabled === true), 'enabled 全 true')
    assertOk(list.every(p => p.revision === 1 && p.seedVersion === 1), 'revision/seedVersion')
  })

  console.log('\n=== M8-2 · diagnose / repair ===\n')

  await testCase('D1 60 完整 → missing=0', async () => {
    const db = seedDb()
    await runSeed(db)
    const mod = loadLp(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'diagnoseTravelPlaces' })
    assertOk(r.ok)
    assertEq(r.dbCount, 60)
    assertEq(r.fetchedCount, 60)
    assertEq(r.missingSeedCount, 0)
    assertEq(r.duplicateIdCount, 0)
    assertEq(r.typeDist.beijing, 30)
    assertEq(r.typeDist.outside, 30)
  })

  await testCase('D2 48/60 partial → missing=12 精确', async () => {
    const db = seedDb()
    const first48 = TRAVEL_PLACES.slice(0, 48)
    db._data.travel_places = first48.map((p, i) => ({ _id: 't' + i, ...p, enabled: true, seedVersion: 1, revision: 1 }))
    const mod = loadLp(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'diagnoseTravelPlaces' })
    assertEq(r.missingSeedCount, 12)
    assertEq(r.typeDist.beijing, 30, '前 48 含全部北京')
    assertEq(r.typeDist.outside, 18)
    assertOk(r.missingSeedNames.every(n => n.includes('(outside)')), '缺失全为外地')
  })

  await testCase('D3 repair 只补 12 → total=60', async () => {
    const db = seedDb()
    const first48 = TRAVEL_PLACES.slice(0, 48)
    db._data.travel_places = first48.map((p, i) => ({ _id: 't' + i, ...p, enabled: true, seedVersion: 1, revision: 1 }))
    const mod = loadLp(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'repairTravelPlaces' })
    assertEq(r.inserted, 12)
    assertEq(r.total, 60)
    assertEq(r.beijing, 30)
    assertEq(r.outside, 30)
  })

  await testCase('D4 第二次 repair inserted=0', async () => {
    const db = seedDb()
    await runSeed(db)
    const mod = loadLp(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'repairTravelPlaces' })
    assertEq(r.inserted, 0)
    assertEq(r.total, 60)
  })

  await testCase('D5 人工编辑内容不覆盖', async () => {
    const db = seedDb()
    await runSeed(db)
    const edited = db._data.travel_places.find(p => p.name === '故宫博物院')
    edited.plan.tips = ['人工编辑的贴士']
    const mod = loadLp(db)
    OPENID = 'A'
    await mod.main({ action: 'repairTravelPlaces' })
    const after = db.dump().travel_places.find(p => p.name === '故宫博物院')
    assertEq(after.plan.tips[0], '人工编辑的贴士', 'repair 不覆盖')
  })

  console.log('\n=== M8-3 · 随机 ===\n')

  await testCase('R1 beijing random 只出 beijing', async () => {
    const db = seedDb()
    await runSeed(db)
    const mod = loadLp(db)
    OPENID = 'A'
    for (let i = 0; i < 10; i++) {
      const r = await mod.main({ action: 'randomTravel', type: 'beijing' })
      assertOk(r.ok)
      assertEq(r.place.type, 'beijing')
    }
  })

  await testCase('R2 outside random 只出 outside', async () => {
    const db = seedDb()
    await runSeed(db)
    const mod = loadLp(db)
    OPENID = 'A'
    for (let i = 0; i < 10; i++) {
      const r = await mod.main({ action: 'randomTravel', type: 'outside' })
      assertOk(r.ok)
      assertEq(r.place.type, 'outside')
    }
  })

  await testCase('R3 disabled 不出现', async () => {
    const db = seedDb()
    await runSeed(db)
    const target = db._data.travel_places.find(p => p.type === 'beijing')
    await db.collection('travel_places').doc(target._id).update({ data: { enabled: false } })
    const mod = loadLp(db)
    OPENID = 'A'
    for (let i = 0; i < 15; i++) {
      const r = await mod.main({ action: 'randomTravel', type: 'beijing' })
      assertOk(r.place._id !== target._id, '随机出禁用地点')
    }
  })

  await testCase('R4 pool 空 → TRAVEL_POOL_EMPTY fail-closed', async () => {
    const db = seedDb()
    await runSeed(db)
    for (const p of db._data.travel_places.filter(x => x.type === 'outside')) {
      await db.collection('travel_places').doc(p._id).update({ data: { enabled: false } })
    }
    const mod = loadLp(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'randomTravel', type: 'outside' })
    assertEq(r.code, 'TRAVEL_POOL_EMPTY')
  })

  await testCase('R5 excludeId 避开上一轮', async () => {
    const db = seedDb()
    await runSeed(db)
    const mod = loadLp(db)
    OPENID = 'A'
    const r1 = await mod.main({ action: 'randomTravel', type: 'beijing' })
    const r2 = await mod.main({ action: 'randomTravel', type: 'beijing', excludeId: r1.place._id })
    assertOk(r2.place._id !== r1.place._id, '尽量避开')
  })

  await testCase('R6 读取完整 30 条而非默认 20', async () => {
    const db = seedDb()
    await runSeed(db)
    const mod = loadLp(db)
    OPENID = 'A'
    // 直接验证 pool 读取完整（fetchAll 30 条），而非依赖随机覆盖统计
    const pool = await mod.fetchAll(db.collection('travel_places'), { type: 'beijing', enabled: true })
    assertEq(pool.length, 30, '北京 pool 完整 30 条（分页未截断）')
    // 随机仍正常工作
    const r = await mod.main({ action: 'randomTravel', type: 'beijing' })
    assertOk(r.ok && r.place.type === 'beijing')
  })

  console.log('\n=== M8-4 · 详情 ===\n')

  await testCase('DETAIL1 北京详情完整（1 day）', async () => {
    const db = seedDb()
    await runSeed(db)
    const mod = loadLp(db)
    OPENID = 'A'
    const bj = db.dump().travel_places.find(p => p.type === 'beijing')
    const r = await mod.main({ action: 'getTravelPlace', placeId: bj._id })
    assertOk(r.ok && r.place)
    assertEq(r.place.plan.days.length, 1, '北京 1 day')
    assertOk(r.place.shortIntro && r.place.highlights.length > 0)
  })

  await testCase('DETAIL2 外地详情完整（3 days）', async () => {
    const db = seedDb()
    await runSeed(db)
    const mod = loadLp(db)
    OPENID = 'A'
    const ot = db.dump().travel_places.find(p => p.type === 'outside')
    const r = await mod.main({ action: 'getTravelPlace', placeId: ot._id })
    assertOk(r.ok && r.place)
    assertEq(r.place.plan.days.length, 3, '外地 3 days')
  })

  await testCase('DETAIL3 NOT_FOUND', async () => {
    const db = seedDb()
    const mod = loadLp(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'getTravelPlace', placeId: 'nope' })
    assertEq(r.code, 'NOT_FOUND')
  })

  await testCase('DETAIL4 stale-info 提示在详情页 UI', () => {
    const wxml = fs.readFileSync(path.join(ROOT, 'pages/travel-detail/travel-detail.wxml'), 'utf8')
    assertOk(wxml.includes('出发前请以官方最新信息为准'), 'stale-info 提示存在')
  })

  console.log('\n=== M8-5 · 编辑 ===\n')

  async function oneBj() {
    const db = seedDb()
    await runSeed(db)
    const bj = db.dump().travel_places.find(p => p.name === '天坛公园')
    return { db, bj }
  }

  await testCase('E1 revision 1→2', async () => {
    const { db, bj } = await oneBj()
    const mod = loadLp(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'saveTravelPlace', placeId: bj._id, shortIntro: 'x', highlights: ['a'], plan: { title: 't', days: [{ day: 1, title: 'd', items: [] }], tips: [] }, requestId: 'e1', revision: 1 })
    assertOk(r.ok)
    assertEq(r.revision, 2)
  })

  await testCase('E2 stale revision → REV_CONFLICT', async () => {
    const { db, bj } = await oneBj()
    const mod = loadLp(db)
    OPENID = 'A'
    await mod.main({ action: 'saveTravelPlace', placeId: bj._id, shortIntro: 'x', highlights: ['a'], plan: { title: 't', days: [], tips: [] }, requestId: 'a', revision: 1 })
    const c = await mod.main({ action: 'saveTravelPlace', placeId: bj._id, shortIntro: 'y', highlights: ['b'], plan: { title: 't', days: [], tips: [] }, requestId: 'c', revision: 1 })
    assertEq(c.code, 'REV_CONFLICT')
  })

  await testCase('E3 duplicate requestId 幂等', async () => {
    const { db, bj } = await oneBj()
    const mod = loadLp(db)
    OPENID = 'A'
    await mod.main({ action: 'saveTravelPlace', placeId: bj._id, shortIntro: 'x', highlights: ['a'], plan: { title: 't', days: [], tips: [] }, requestId: 'dup', revision: 1 })
    const r2 = await mod.main({ action: 'saveTravelPlace', placeId: bj._id, shortIntro: 'x', highlights: ['a'], plan: { title: 't', days: [], tips: [] }, requestId: 'dup', revision: 1 })
    assertEq(r2.idempotent, true)
    assertEq(r2.revision, 2, '幂等返回当前 revision')
    assertEq(db.dump().travel_places.find(p => p._id === bj._id).revision, 2, '不再次 +1')
  })

  await testCase('E4 保存后重读保持（人工 SoT）', async () => {
    const { db, bj } = await oneBj()
    const mod = loadLp(db)
    OPENID = 'A'
    await mod.main({ action: 'saveTravelPlace', placeId: bj._id, shortIntro: '人工简介', highlights: ['人工亮点'], plan: { title: 't', days: [], tips: ['人工贴士'] }, requestId: 's1', revision: 1 })
    const r = await mod.main({ action: 'getTravelPlace', placeId: bj._id })
    assertEq(r.place.shortIntro, '人工简介')
    assertEq(r.place.plan.tips[0], '人工贴士')
  })

  await testCase('E5 name/type 不允许改（save 无 name/type 字段）', () => {
    const js = fs.readFileSync(path.join(ROOT, 'cloudfunctions/lifePlanner/index.js'), 'utf8')
    const seg = js.split("if (action === 'saveTravelPlace')")[1].split('return { ok: true, revision')[0]
    assertEq(seg.includes('name'), false, 'save 不应写 name')
    assertEq(seg.includes('city'), false, 'save 不应写 city')
  })

  await testCase('E6 active her / him 可编辑；outsider / superseded deny', async () => {
    const { db, bj } = await oneBj()
    const mod = loadLp(db)
    OPENID = 'A'
    const rh = await mod.main({ action: 'saveTravelPlace', placeId: bj._id, shortIntro: 'a', highlights: ['a'], plan: { title: 't', days: [], tips: [] }, requestId: 'h', revision: 1 })
    assertOk(rh.ok, 'her 可编辑')
    OPENID = 'B'
    const rm = await mod.main({ action: 'saveTravelPlace', placeId: bj._id, shortIntro: 'b', highlights: ['b'], plan: { title: 't', days: [], tips: [] }, requestId: 'm', revision: 2 })
    assertOk(rm.ok, 'him 可编辑')
    OPENID = 'X'
    const rx = await mod.main({ action: 'saveTravelPlace', placeId: bj._id, shortIntro: 'x', highlights: ['x'], plan: { title: 't', days: [], tips: [] }, requestId: 'x', revision: 3 })
    assertEq(rx.code, 'NOT_ACTIVE', 'outsider deny')
    OPENID = 'B'
    await db.collection('couples').doc('c1').update({ data: { status: 'superseded' } })
    const rs = await mod.main({ action: 'saveTravelPlace', placeId: bj._id, shortIntro: 's', highlights: ['s'], plan: { title: 't', days: [], tips: [] }, requestId: 's', revision: 3 })
    assertEq(rs.code, 'NOT_ACTIVE', 'superseded deny')
    OPENID = 'A'
  })

  console.log('\n=== M8-6 · AI regenerate ===\n')

  await testCase('AI1 前端有二次确认', () => {
    const js = fs.readFileSync(path.join(ROOT, 'pages/travel-detail/travel-detail.js'), 'utf8')
    assertOk(js.includes('AI 会重新生成当前旅行计划，并覆盖编辑框中的内容。是否继续？'), '二次确认文案')
  })

  await testCase('AI2 AI fail → 原内容不变 + AI_FAILED', async () => {
    const { db, bj } = await oneBj()
    const before = JSON.stringify(db.dump().travel_places.find(p => p._id === bj._id))
    const mod = loadLp(db, true)
    OPENID = 'A'
    const r = await mod.main({ action: 'regenerateTravelPlace', placeId: bj._id })
    assertEq(r.code, 'AI_FAILED')
    assertEq(JSON.stringify(db.dump().travel_places.find(p => p._id === bj._id)), before, '原计划保留')
  })

  await testCase('AI3 AI invalid response → AI_INVALID_RESPONSE 原内容不变', async () => {
    const { db, bj } = await oneBj()
    const mod = loadLp(db)
    mod.__setTransport(async () => 'not json at all')
    OPENID = 'A'
    const r = await mod.main({ action: 'regenerateTravelPlace', placeId: bj._id })
    assertEq(r.code, 'AI_INVALID_RESPONSE')
    assertOk(db.dump().travel_places.find(p => p._id === bj._id).plan.days.length === 1, '原计划仍在')
  })

  await testCase('AI4 AI success → draft；未确认保存 DB 不变', async () => {
    const { db, bj } = await oneBj()
    const mod = loadLp(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'regenerateTravelPlace', placeId: bj._id })
    assertOk(r.ok && r.draft)
    assertEq(r.draft.days.length, 1, '北京 1 day')
    assertOk(r.draft.days[0].items.every(it => ['morning', 'noon', 'afternoon', 'evening'].includes(it.period)), 'period 合法')
    assertEq(db.dump().travel_places.find(p => p._id === bj._id).revision, 1, '未确认保存 DB 不变')
    // 确认保存 → revision+1，name/type 不变
    const save = await mod.main({ action: 'saveTravelPlace', placeId: bj._id, shortIntro: bj.shortIntro, highlights: bj.highlights, plan: { title: r.draft.title, days: r.draft.days, tips: r.draft.tips }, requestId: 'ai1', revision: 1 })
    assertEq(save.revision, 2)
    const after = db.dump().travel_places.find(p => p._id === bj._id)
    assertEq(after.name, bj.name, 'name 不变')
    assertEq(after.type, bj.type, 'type 不变')
  })

  await testCase('AI5 外地 AI 输出 3 days', async () => {
    const db = seedDb()
    await runSeed(db)
    const ot = db.dump().travel_places.find(p => p.type === 'outside')
    const mod = loadLp(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'regenerateTravelPlace', placeId: ot._id })
    assertOk(r.ok && r.draft)
    assertEq(r.draft.days.length, 3, '外地 3 days')
  })

  await testCase('AI6 AI Key 不在前端 + prompt 无 private data', async () => {
    const js = fs.readFileSync(path.join(ROOT, 'pages/travel-detail/travel-detail.js'), 'utf8')
    assertEq(js.includes('AI_API_KEY'), false, '前端无 Key')
    const lp = fs.readFileSync(path.join(ROOT, 'cloudfunctions/lifePlanner/index.js'), 'utf8')
    const seg = lp.split("if (action === 'regenerateTravelPlace')")[1].split("let text")[0]
    assertEq(seg.includes('mood'), false, 'prompt 不含 mood')
    assertEq(seg.includes('diary'), false, 'prompt 不含 diary')
    assertEq(seg.includes('profile'), false, 'prompt 不含 profile')
  })

  console.log('\n=== M8-7 · UI ===\n')

  const oursWxml = fs.readFileSync(path.join(ROOT, 'pages/ours/ours.wxml'), 'utf8')
  const oursJs = fs.readFileSync(path.join(ROOT, 'pages/ours/ours.js'), 'utf8')
  const travelWxml = fs.readFileSync(path.join(ROOT, 'pages/travel/travel.wxml'), 'utf8')
  const travelJs = fs.readFileSync(path.join(ROOT, 'pages/travel/travel.js'), 'utf8')
  const travelDetailWxml = fs.readFileSync(path.join(ROOT, 'pages/travel-detail/travel-detail.wxml'), 'utf8')

  check('U1 我们页有「今天去哪里」', oursWxml.includes('今天去哪里') && oursWxml.includes('goTravel'))
  check('U2 入口跳转 travel 页', oursJs.includes("'/pages/travel/travel'"))
  check('U3 默认北京 Tab', /tab === 'beijing'/.test(travelWxml) && /tab: 'beijing'/.test(travelJs))
  check('U4 可切换外地 Tab', travelWxml.includes('data-tab="outside"'))
  check('U5 北京随机显示 1 天', travelWxml.includes("tab === 'beijing' ? '默认 1 天'"))
  check('U6 外地随机显示 3 天 2 夜', travelWxml.includes("'3 天 2 夜'"))
  check('U7 结果可进详情', travelWxml.includes('goDetail') && travelWxml.includes('place._id'))
  check('U8 成功后清旧 error', travelJs.includes("error: ''"))
  check('U9 empty state 正常', travelWxml.includes('旅行地点库还没准备好'))
  check('U10 无 emoji', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(oursWxml + travelWxml + travelDetailWxml), 'M8 页面含 emoji')

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
  console.log('M8 Travel: ALL GREEN')
}

runAll().catch(e => { console.error('测试执行异常:', e); process.exit(1) })
