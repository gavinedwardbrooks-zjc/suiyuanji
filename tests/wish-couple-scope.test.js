// ============================================================
// tests/wish-couple-scope.test.js · P0 隐私隔离专项（心愿跨情侣关系）
//
// 覆盖：
//   A 归属判定纯函数（含 fail-closed 与异常输入）
//   B 创建归属（coupleId 由服务端推导 / 未绑定显式 null / 关系内判重）
//   C 跨情侣读取隔离（新伴侣 / 旧伴侣 / 本人 / 未归属历史文档）
//   D 越权写入（mark 跨关系 / 伪造 id / 角色 / 并发幂等）
//   E 历史数据兼容（零写入、零删除、无迁移脚本）
//   F 静态守护（双副本一致、不接受前端身份、无删除、前端不参与 coupleId）
//   G 旧客户端兼容（不传新字段仍工作、返回体不新增字段）
//
// 运行：node tests/wish-couple-scope.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const fs = require('fs')
const { MockDB } = require('./mock-db')

const ROOT = path.resolve(__dirname, '..')
let passed = 0, failed = 0, failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name) })
    .catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message) })
}
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)) }
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }
function assertDeep(a, b, msg) {
  const x = JSON.stringify(a), y = JSON.stringify(b)
  if (x !== y) throw new Error((msg || '') + '\n 期望 ' + y + '\n 实际 ' + x)
}

const scope = require('../cloudfunctions/getPartnerView/wish-scope')

// ---- mock sdk：OPENID 可切换 ----
let OPENID = 'A'
function loadFn(name, db) {
  const origLoad = Module._load
  Module._load = function (request) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => db,
        getWXContext: () => ({ OPENID }),
        openapi: { subscribeMessage: { send: async () => ({ errCode: 0 }) } }
      }
    }
    return origLoad.apply(this, arguments)
  }
  const fnPath = path.resolve(__dirname, '../cloudfunctions/' + name + '/index.js')
  delete require.cache[fnPath]
  const mod = require(fnPath)
  Module._load = origLoad
  return mod
}

// A=her（当前 CZ-2）· B=旧 him（CZ-1）· C=新 him（CZ-2）
function seedRebound(extra) {
  return new MockDB(Object.assign({
    users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-2', schemaVersion: 2 },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: null, schemaVersion: 2 },
      { _id: 'u_c', _openid: 'C', role: 'him', coupleId: 'CZ-2', schemaVersion: 2 }
    ],
    couples: [
      { _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'superseded', boundAt: 1000, supersededAt: 4000 },
      { _id: 'c2', coupleId: 'CZ-2', herOpenid: 'A', himOpenid: 'C', status: 'active', boundAt: 5000 }
    ],
    daily_records: [], messages: [], menstrual: [],
    wishes: [
      // 上一段关系（显式 coupleId）
      { _id: 'w_old', _openid: 'A', coupleId: 'CZ-1', type: 'eat', text: '和旧人吃火锅', status: 'pending', createdAt: 2000 },
      // 上一段关系期间写入、但当时没有 coupleId 字段的历史文档
      { _id: 'w_legacy_old', _openid: 'A', type: 'eat', text: '上一段关系的旧心愿', status: 'pending', createdAt: 2100 },
      // 当前关系
      { _id: 'w_new', _openid: 'A', coupleId: 'CZ-2', type: 'do', text: '一起去看海', status: 'pending', createdAt: 6000 }
    ]
  }, extra))
}

// 首次关系（没有前任）+ 历史文档
function seedFirstLove(extra) {
  return new MockDB(Object.assign({
    users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', schemaVersion: 2 },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', schemaVersion: 2 }
    ],
    couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'active', boundAt: 5000 }],
    daily_records: [], messages: [], menstrual: [],
    wishes: [
      // 绑定之前就写下的心愿（历史文档，无 coupleId）
      { _id: 'w_legacy', _openid: 'A', type: 'eat', text: '火锅', status: 'pending', createdAt: 1000 }
    ]
  }, extra))
}

// 未绑定用户
function seedUnbound(extra) {
  return new MockDB(Object.assign({
    users: [{ _id: 'u_a', _openid: 'A', role: 'her', coupleId: null, schemaVersion: 2 }],
    couples: [], daily_records: [], messages: [], menstrual: [], wishes: []
  }, extra))
}

function saveEvent(wishes, over) {
  return Object.assign({
    action: 'save', date: '2026-10-18', requestId: 'req-1', revision: 0,
    goals: [], todos: [], segments: { life: '', work: '', growth: '' },
    mood: { type: 'calm', weather: 'sunny' },
    wishes, score: 4, readProgress: 0
  }, over || {})
}

function wishesOf(db) { return db.dump().wishes || [] }

// ==================== A · 归属判定纯函数 ====================
async function runAttribution() {
  console.log('\n=== A · 归属判定（wish-scope 纯函数） ===\n')

  const ctxRebound = scope.contextOf({ coupleId: 'CZ-2', boundAt: 5000 })
  const ctxFirst = scope.contextOf({ coupleId: 'CZ-1', boundAt: 5000 })
  const ctxNoCouple = scope.emptyContext()

  await testCase('A1 显式同 coupleId → same-couple', () => {
    assertEq(scope.attributionOf({ coupleId: 'CZ-2', createdAt: 1 }, ctxRebound), 'same-couple')
    assertEq(scope.isWishShared({ coupleId: 'CZ-2' }, ctxRebound), true)
  })

  await testCase('A2 显式异 coupleId → foreign（硬隔离，绝不回退）', () => {
    assertEq(scope.attributionOf({ coupleId: 'CZ-1', createdAt: 9999 }, ctxRebound), 'foreign')
    assertEq(scope.isWishShared({ coupleId: 'CZ-1' }, ctxRebound), false, '即便 createdAt 晚于 boundAt 也不得回退')
  })

  await testCase('A3 无 coupleId 且 createdAt >= boundAt → 仍为 unattributed（本轮撤回时间推断）', () => {
    assertEq(scope.attributionOf({ createdAt: 5000 }, ctxRebound), 'unattributed')
    assertEq(scope.attributionOf({ createdAt: 6000 }, ctxRebound), 'unattributed', '时间晚于 boundAt 不是归属证据')
    assertEq(scope.isWishShared({ createdAt: 999999 }, ctxRebound), false)
  })

  await testCase('A4 无 coupleId + 早于 boundAt → unattributed', () => {
    assertEq(scope.attributionOf({ createdAt: 4999 }, ctxRebound), 'unattributed')
    assertEq(scope.isWishShared({ createdAt: 4999 }, ctxRebound), false)
  })

  await testCase('A5 无 coupleId + 首次关系（查不到其它关系）→ 仍为 unattributed（不假设历史完整）', () => {
    assertEq(scope.attributionOf({ createdAt: 1000 }, ctxFirst), 'unattributed')
    assertEq(scope.isWishShared({ createdAt: 1000 }, ctxFirst), false)
  })

  await testCase('A6 contextOf 不再产出任何「归属推断」状态（boundAt 仅作诊断）', () => {
    const ctx = scope.contextOf({ coupleId: 'CZ-2', boundAt: 5000 })
    assertEq(ctx.coupleId, 'CZ-2')
    assertEq(ctx.boundAt, 5000, 'boundAt 只留作日志/诊断')
    assertEq(Object.prototype.hasOwnProperty.call(ctx, 'hasOtherActivated'), false, '不得再携带关系历史推断字段')
    assertEq(scope.attributionOf({ createdAt: 1000 }, ctx), 'unattributed', '未经证明的历史文档不得共享')
  })

  await testCase('A7 无生效关系 → 一切 unshared（fail-closed）', () => {
    assertEq(scope.attributionOf({ coupleId: 'CZ-2', createdAt: 9999 }, ctxNoCouple), 'unattributed')
    assertEq(scope.isWishShared({ coupleId: 'CZ-2' }, ctxNoCouple), false)
    assertEq(scope.coupleIdForWrite(ctxNoCouple), null)
  })

  await testCase('A8 coupleId 为异常类型（数字 / 对象）→ foreign（fail-closed）', () => {
    assertEq(scope.attributionOf({ coupleId: 123, createdAt: 9999 }, ctxRebound), 'foreign')
    assertEq(scope.attributionOf({ coupleId: { a: 1 }, createdAt: 9999 }, ctxRebound), 'foreign')
  })

  await testCase('A9 空文档 → unattributed（不因 undefined 抛错）', () => {
    assertEq(scope.attributionOf(null, ctxRebound), 'unattributed')
    assertEq(scope.attributionOf({}, ctxRebound), 'unattributed')
  })

  await testCase('A10 isSameScope：未绑定只与「显式 null」同作用域（历史文档不挡新建）', () => {
    assertEq(scope.isSameScope({ coupleId: null, text: 'x' }, ctxNoCouple), true)
    assertEq(scope.isSameScope({ text: 'x' }, ctxNoCouple), false, '没有 coupleId 字段的历史文档不算同作用域')
    assertEq(scope.isSameScope({ coupleId: 'CZ-1', text: 'x' }, ctxNoCouple), false)
  })

  await testCase('A11 isSameScope：同关系内判重成立，异关系不成立', () => {
    assertEq(scope.isSameScope({ coupleId: 'CZ-2' }, ctxRebound), true)
    assertEq(scope.isSameScope({ coupleId: 'CZ-1' }, ctxRebound), false)
  })

  await testCase('A12 isLegacy：区分「无关系标记」与「显式 null」', () => {
    assertEq(scope.isLegacy({}), true)
    assertEq(scope.isLegacy({ coupleId: undefined }), true)
    assertEq(scope.isLegacy({ coupleId: null }), true)
    assertEq(scope.isLegacy({ coupleId: 'CZ-2' }), false)
    assertEq(scope.isLegacy(null), true)
  })

  await testCase('A13 isRecordInCouple：记录级归属只认 coupleId 等值', () => {
    const couple = { coupleId: 'CZ-2' }
    assertEq(scope.isRecordInCouple({ coupleId: 'CZ-2' }, couple), true)
    assertEq(scope.isRecordInCouple({ coupleId: 'CZ-1' }, couple), false)
    assertEq(scope.isRecordInCouple({}, couple), false, '历史记录（无 coupleId）不可证明 → 拒绝')
    assertEq(scope.isRecordInCouple({ coupleId: null }, couple), false)
    assertEq(scope.isRecordInCouple({ coupleId: 'CZ-2' }, null), false)
    assertEq(scope.isRecordInCouple(null, couple), false)
  })
}

// ==================== B · 创建归属 ====================
async function runCreate() {
  console.log('\n=== B · 创建归属（dailyRecord.syncWishes） ===\n')

  await testCase('B1 已绑定：新建心愿写入服务端推导的 coupleId', async () => {
    const db = seedFirstLove({ wishes: [] })
    const daily = loadFn('dailyRecord', db)
    OPENID = 'A'
    const r = await daily.main(saveEvent([{ type: 'eat', text: '螺蛳粉' }]))
    assertOk(r.ok)
    const w = wishesOf(db)
    assertEq(w.length, 1)
    assertEq(w[0].coupleId, 'CZ-1', '必须带上当前关系标识')
    assertEq(w[0]._openid, 'A')
  })

  await testCase('B2 未绑定：写入显式 coupleId=null（不是缺字段，便于精确判重）', async () => {
    const db = seedUnbound()
    const daily = loadFn('dailyRecord', db)
    OPENID = 'A'
    const r = await daily.main(saveEvent([{ type: 'eat', text: '一个人也要吃好' }]))
    assertOk(r.ok)
    const w = wishesOf(db)[0]
    assertOk(Object.prototype.hasOwnProperty.call(w, 'coupleId'), '必须显式写入 coupleId 字段')
    assertEq(w.coupleId, null)
  })

  await testCase('B3 未绑定重复保存 → 不重复创建', async () => {
    const db = seedUnbound()
    const daily = loadFn('dailyRecord', db)
    OPENID = 'A'
    await daily.main(saveEvent([{ type: 'eat', text: '火锅' }]))
    await daily.main(saveEvent([{ type: 'eat', text: '火锅' }], { requestId: 'req-2', revision: 1 }))
    assertEq(wishesOf(db).length, 1)
  })

  await testCase('B4 换伴侣后许同一个愿望 → 新建（旧关系文档零改动）', async () => {
    const db = seedRebound({
      wishes: [{ _id: 'w_old', _openid: 'A', coupleId: 'CZ-1', type: 'eat', text: '火锅', status: 'done_by_partner', createdAt: 2000, arrangedAt: 3000 }]
    })
    const before = JSON.stringify(wishesOf(db))
    const daily = loadFn('dailyRecord', db)
    OPENID = 'A'
    const r = await daily.main(saveEvent([{ type: 'eat', text: '火锅' }]))
    assertOk(r.ok)
    const w = wishesOf(db)
    assertEq(w.length, 2, '旧关系文档不得挡住新关系的创建')
    const created = w.find(x => x._id !== 'w_old')
    assertEq(created.coupleId, 'CZ-2')
    assertEq(created.status, 'pending')
    // 旧文档逐字节未变
    const oldBefore = JSON.parse(before)[0]
    const oldAfter = w.find(x => x._id === 'w_old')
    assertDeep(oldAfter, oldBefore, '历史文档被改动了')
  })

  await testCase('B5 同一关系内重复保存 → 不重复创建（判重仍生效）', async () => {
    const db = seedFirstLove({ wishes: [] })
    const daily = loadFn('dailyRecord', db)
    OPENID = 'A'
    await daily.main(saveEvent([{ type: 'eat', text: '螺蛳粉' }]))
    await daily.main(saveEvent([{ type: 'eat', text: '  螺蛳粉  ' }], { requestId: 'req-2', revision: 1 }))
    assertEq(wishesOf(db).length, 1)
  })

  await testCase('B6 关系解析失败 → wishSyncFailed（不落库、不猜归属）', async () => {
    const db = seedFirstLove({ wishes: [] })
    const daily = loadFn('dailyRecord', db)
    OPENID = 'A'
    const orig = db.collection.bind(db)
    db.collection = (name) => {
      if (name === 'couples') throw new Error('boom: couples unavailable')
      return orig(name)
    }
    let r
    try {
      r = await daily.main(saveEvent([{ type: 'eat', text: '火锅' }]))
    } finally {
      db.collection = orig
    }
    assertOk(r.ok, '主记录仍保存成功')
    assertEq(r.wishSyncFailed, true, '必须显式报错，不得静默')
    assertEq(wishesOf(db).length, 0, '关系不明时一条都不写')
  })

  await testCase('B7 同一关系内已安排的心愿不会被重新保存的 record 重置为 pending', async () => {
    // 这条记录必须是「当前关系创建」的，否则心愿同步会被闸门拒绝（见 B8）。
    // 判重键自 2026-10-26 起包含 wishDate（= 记录自身的 date），
    // 因此「同一天已安排」的心愿必须带上同一天的 wishDate —— 这正是「重复保存」的语义。
    const db = seedFirstLove({
      wishes: [{ _id: 'w1', _openid: 'A', coupleId: 'CZ-1', wishDate: '2026-10-18', type: 'eat', text: '火锅', status: 'done_by_partner', createdAt: 1000, arrangedAt: 2000 }]
    })
    const daily = loadFn('dailyRecord', db)
    OPENID = 'A'
    await daily.main(saveEvent([{ type: 'eat', text: '火锅' }]))
    assertEq(wishesOf(db).length, 1)
    assertEq(wishesOf(db)[0].status, 'done_by_partner')
  })

  await testCase('B8 历史记录（无 coupleId）保存 → 不同步心愿、且一个字段都不补写', async () => {
    // 场景：这条记录产生于 coupleId 字段上线之前，无法证明属于当前关系。
    // 记录本身允许保存（那是用户自己的日记），但不得由它派生新心愿。
    const db = seedFirstLove({
      wishes: [],
      daily_records: [{ _id: 'r_legacy', _openid: 'A', date: '2026-10-18', revision: 1, goals: [], todos: [], segments: {}, mood: {}, wishes: [], score: 3 }]
    })
    const daily = loadFn('dailyRecord', db)
    OPENID = 'A'
    const r = await daily.main(saveEvent([{ type: 'eat', text: '旧关系的心愿' }], { revision: 1 }))
    assertOk(r.ok, '记录本身必须保存成功')
    assertEq(r.wishSyncSkipped, 'record-not-in-couple', '必须明确回报被跳过')
    assertEq(wishesOf(db).length, 0, '不得创建心愿')
    const rec = db.dump().daily_records.find(x => x._id === 'r_legacy')
    assertEq(Object.prototype.hasOwnProperty.call(rec, 'coupleId'), false, '不得给历史记录补写 coupleId')
  })

  await testCase('B9 记录属于另一段关系（coupleId 不等）→ 不同步心愿', async () => {
    const db = seedRebound({
      daily_records: [{ _id: 'r_old', _openid: 'A', date: '2026-10-18', revision: 1, coupleId: 'CZ-1', wishes: [], score: 3 }]
    })
    const daily = loadFn('dailyRecord', db)
    OPENID = 'A'
    const before = wishesOf(db).length
    const r = await daily.main(saveEvent([{ type: 'do', text: '和旧人约好的事' }], { revision: 1 }))
    assertOk(r.ok)
    assertEq(r.wishSyncSkipped, 'record-not-in-couple')
    assertEq(wishesOf(db).length, before, '不得向新关系产愿')
  })

  await testCase('B10 新记录（当前关系创建）→ 正常同步并写入 coupleId', async () => {
    const db = seedFirstLove({ wishes: [], daily_records: [] })
    const daily = loadFn('dailyRecord', db)
    OPENID = 'A'
    const r = await daily.main(saveEvent([{ type: 'eat', text: '新心愿' }], { date: '2026-10-19' }))
    assertOk(r.ok)
    assertEq(r.wishSyncSkipped, null)
    assertEq(wishesOf(db).length, 1, '正常路径不能被闸门误伤')
    assertEq(wishesOf(db)[0].coupleId, 'CZ-1')
    const rec = db.dump().daily_records.find(x => x.date === '2026-10-19')
    assertEq(rec.coupleId, 'CZ-1', '记录创建时必须写入关系标记')
  })
}

// ==================== C · 跨情侣读取隔离 ====================
async function runRead() {
  console.log('\n=== C · 跨情侣读取隔离（getPartnerView.view） ===\n')

  await testCase('C1 新伴侣（him）看不到旧关系心愿（含无 coupleId 的历史文档）', async () => {
    const db = seedRebound()
    const pv = loadFn('getPartnerView', db)
    OPENID = 'C'
    const r = await pv.main({})
    assertOk(r.ok)
    assertEq(r.wishes.length, 1, '只应看到当前关系的心愿: ' + JSON.stringify(r.wishes))
    assertEq(r.wishes[0]._id, 'w_new')
    const s = JSON.stringify(r)
    assertOk(!s.includes('和旧人吃火锅'), '旧关系心愿正文泄露')
    assertOk(!s.includes('上一段关系的旧心愿'), '未归属历史文档泄露')
    OPENID = 'A'
  })

  await testCase('C2 本人（her）在新关系里也看不到旧关系 / 未归属心愿（保守策略）', async () => {
    const db = seedRebound()
    const pv = loadFn('getPartnerView', db)
    OPENID = 'A'
    const r = await pv.main({})
    assertOk(r.ok)
    assertEq(r.wishes.length, 1)
    assertEq(r.wishes[0]._id, 'w_new')
  })

  await testCase('C3 旧伴侣已失权（NOT_ACTIVE），读不到任何心愿', async () => {
    const db = seedRebound()
    const pv = loadFn('getPartnerView', db)
    OPENID = 'B'
    const r = await pv.main({})
    assertEq(r.code, 'NOT_ACTIVE')
    assertOk(!JSON.stringify(r).includes('一起吃'), '失权响应不得带任何心愿内容')
    OPENID = 'A'
  })

  await testCase('C4 未归属历史文档对双方都不展示，但数据仍在库里', async () => {
    const db = seedRebound()
    const pv = loadFn('getPartnerView', db)
    OPENID = 'C'
    await pv.main({})
    OPENID = 'A'
    await pv.main({})
    const w = wishesOf(db)
    assertEq(w.length, 3, '三条心愿一条都不能少')
    assertOk(w.some(x => x._id === 'w_legacy_old'), '被隐藏的历史文档必须原样保留')
  })

  await testCase('C5 首次关系 + 历史文档 → 仍不展示（不假设关系历史完整）', async () => {
    // 「查不到别的关系记录」不能证明「从未有过别的关系」：历史记录可能缺失。
    // 因此历史文档在**任何**关系下都不共享，数据原样保留。
    const db = seedFirstLove()
    const pv = loadFn('getPartnerView', db)
    OPENID = 'B'
    const rHim = await pv.main({})
    assertEq(rHim.wishes.length, 0, 'him 不得看到历史文档: ' + JSON.stringify(rHim.wishes))
    OPENID = 'A'
    const rHer = await pv.main({})
    assertEq(rHer.wishes.length, 0)
    assertOk(!JSON.stringify(rHim).includes('火锅'), '历史心愿正文不得出现在响应里')
    OPENID = 'A'
  })

  await testCase('C6 第三方用户（无关系）读不到任何心愿', async () => {
    const db = seedFirstLove({
      users: [
        { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', schemaVersion: 2 },
        { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', schemaVersion: 2 },
        { _id: 'u_x', _openid: 'X', role: 'her', coupleId: null, schemaVersion: 2 }
      ]
    })
    const pv = loadFn('getPartnerView', db)
    OPENID = 'X'
    const r = await pv.main({})
    assertEq(r.code, 'NOT_ACTIVE')
    assertOk(!JSON.stringify(r).includes('火锅'))
    OPENID = 'A'
  })

  await testCase('C7 解绑后双方都读不到（couple 不再 active）', async () => {
    const db = seedFirstLove()
    db.collection('couples').doc('c1').update({ data: { status: 'unbound' } })
    const pv = loadFn('getPartnerView', db)
    for (const who of ['A', 'B']) {
      OPENID = who
      const r = await pv.main({})
      assertEq(r.code, 'NOT_ACTIVE', who + ' 解绑后必须失权')
    }
    OPENID = 'A'
  })

  await testCase('C8 真实状态机换绑（generate→claim→confirm）：旧心愿不跟着人到新关系', async () => {
    // 起点：A(her) + B(him) 已绑定，A 有过一条心愿
    const db = new MockDB({
      users: [
        { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', schemaVersion: 2 },
        { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', schemaVersion: 2 },
        { _id: 'u_c', _openid: 'C', role: 'her', coupleId: null, schemaVersion: 2 }
      ],
      couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'active', boundAt: 1000 }],
      daily_records: [], messages: [], menstrual: [],
      wishes: [{ _id: 'w1', _openid: 'A', coupleId: 'CZ-1', type: 'eat', text: '和B的约定', status: 'pending', createdAt: 2000 }]
    })
    const bcore = require(path.resolve(__dirname, '../cloudfunctions/bindCouple/core.js'))
    // 换绑必须先解绑（P0：confirm 不再自动 supersede）
    await bcore.unbind({ db, openid: 'A', now: Date.now() })
    const g = await bcore.generate({ db, herOpenid: 'A', now: Date.now() + 1 })
    await bcore.claim({ db, code: g.bindCode, himOpenid: 'C', now: Date.now() + 2 })
    await bcore.confirm({ db, herOpenid: 'A', requestId: g.requestId, accept: true, now: Date.now() + 3 })
    const newCouple = db.dump().couples.find(c => c.herOpenid === 'A' && c.status === 'active')
    assertOk(newCouple && newCouple.coupleId !== 'CZ-1', '换绑应产生新的 coupleId')

    // 新伴侣看不到旧心愿；本人也看不到
    const pv = loadFn('getPartnerView', db)
    OPENID = 'C'
    const rC = await pv.main({})
    assertOk(rC.ok, JSON.stringify(rC))
    assertEq(rC.wishes.length, 0, '换绑后新伴侣不得看到旧关系心愿')
    OPENID = 'A'
    const rA = await pv.main({})
    assertEq(rA.wishes.length, 0, '本人视角同样保守隐藏（数据仍在库里）')

    // 旧心愿原样保留
    const kept = wishesOf(db).find(w => w._id === 'w1')
    assertDeep(kept, { _id: 'w1', _openid: 'A', coupleId: 'CZ-1', type: 'eat', text: '和B的约定', status: 'pending', createdAt: 2000 })

    // 新关系下新许的心愿 → 只有新伴侣可见
    const daily = loadFn('dailyRecord', db)
    await daily.main(saveEvent([{ type: 'do', text: '和C去看海' }]))
    const created = wishesOf(db).find(w => w.text === '和C去看海')
    assertOk(created, '新心愿应创建')
    assertEq(created.coupleId, newCouple.coupleId, '新心愿必须归属新关系')
    OPENID = 'C'
    const rC2 = await pv.main({})
    assertDeep(rC2.wishes.map(w => w.text), ['和C去看海'])
    OPENID = 'A'
  })

  await testCase('C9 关系数据残缺（herOpenid 为空）→ 心愿列表为空，不查 _openid=null', async () => {
    const db = new MockDB({
      users: [{ _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-9', schemaVersion: 2 }],
      couples: [{ _id: 'c9', coupleId: 'CZ-9', herOpenid: null, himOpenid: 'B', status: 'active', boundAt: 1000 }],
      daily_records: [], messages: [], menstrual: [],
      wishes: [{ _id: 'w_orphan', _openid: 'A', type: 'eat', text: '孤儿心愿', status: 'pending', createdAt: 2000 }]
    })
    const pv = loadFn('getPartnerView', db)
    OPENID = 'B'
    const r = await pv.main({})
    assertOk(r.ok, JSON.stringify(r))
    assertEq(r.wishes.length, 0, '关系残缺时必须返回空列表（fail-closed）')
    const m = await pv.main({ action: 'mark', wishId: 'w_orphan' })
    assertEq(m.code, 'NO_PARTNER', '无法确定另一半时拒绝写')
    assertEq(wishesOf(db)[0].status, 'pending')
    OPENID = 'A'
  })

  await testCase('C10 旧关系文档不影响列表顺序：仍按 createdAt 升序返回', async () => {
    const db = seedRebound({
      wishes: [
        { _id: 'w1', _openid: 'A', coupleId: 'CZ-2', type: 'eat', text: '先写的', status: 'pending', createdAt: 5001 },
        { _id: 'w2', _openid: 'A', coupleId: 'CZ-2', type: 'eat', text: '后写的', status: 'pending', createdAt: 5002 }
      ]
    })
    const pv = loadFn('getPartnerView', db)
    OPENID = 'C'
    const r = await pv.main({})
    assertDeep(r.wishes.map(w => w.text), ['先写的', '后写的'])
    OPENID = 'A'
  })
}

// ==================== D · 越权写入 ====================
async function runWrite() {
  console.log('\n=== D · 越权写入（mark） ===\n')

  await testCase('D1 新伴侣不能把旧关系心愿标记为已安排（库内零改动）', async () => {
    const db = seedRebound()
    const before = JSON.stringify(wishesOf(db))
    const pv = loadFn('getPartnerView', db)
    OPENID = 'C'
    const r = await pv.main({ action: 'mark', wishId: 'w_old' })
    assertEq(r.ok, false)
    assertEq(r.code, 'FORBIDDEN')
    assertEq(JSON.stringify(wishesOf(db)), before, '旧关系心愿被改动了')
    OPENID = 'A'
  })

  await testCase('D2 新伴侣也不能 mark 未归属的历史文档', async () => {
    const db = seedRebound()
    const before = JSON.stringify(wishesOf(db))
    const pv = loadFn('getPartnerView', db)
    OPENID = 'C'
    const r = await pv.main({ action: 'mark', wishId: 'w_legacy_old' })
    assertEq(r.ok, false)
    assertEq(r.code, 'FORBIDDEN')
    assertEq(JSON.stringify(wishesOf(db)), before)
    OPENID = 'A'
  })

  await testCase('D3 旧伴侣 mark → NOT_ACTIVE', async () => {
    const db = seedRebound()
    const pv = loadFn('getPartnerView', db)
    OPENID = 'B'
    const r = await pv.main({ action: 'mark', wishId: 'w_old' })
    assertEq(r.code, 'NOT_ACTIVE')
    OPENID = 'A'
  })

  await testCase('D4 her 不能冒充 him mark（FORBIDDEN）', async () => {
    const db = seedRebound()
    const pv = loadFn('getPartnerView', db)
    OPENID = 'A'
    const r = await pv.main({ action: 'mark', wishId: 'w_new' })
    assertEq(r.code, 'FORBIDDEN')
    assertEq(wishesOf(db).find(w => w._id === 'w_new').status, 'pending')
  })

  await testCase('D5 自己的（别的用户的）心愿不能越权 mark，且错误与「不存在」同构', async () => {
    const db = seedRebound({
      wishes: [{ _id: 'w_x', _openid: 'X', coupleId: 'CZ-2', type: 'eat', text: '别人的', status: 'pending', createdAt: 6000 }]
    })
    const pv = loadFn('getPartnerView', db)
    OPENID = 'C'
    const rOther = await pv.main({ action: 'mark', wishId: 'w_x' })
    const rMissing = await pv.main({ action: 'mark', wishId: 'nope-not-exists' })
    assertEq(rOther.ok, false)
    assertEq(rOther.code, 'FORBIDDEN')
    assertEq(rMissing.code, rOther.code, '不得通过错误码区分「存在但不是你的」与「不存在」')
    assertEq(rMissing.msg, rOther.msg, '错误文案也必须同构')
    assertEq(wishesOf(db).find(w => w._id === 'w_x').status, 'pending')
    OPENID = 'A'
  })

  await testCase('D6 归属正确时 mark 成功（功能未被隔离误伤）', async () => {
    const db = seedRebound()
    const pv = loadFn('getPartnerView', db)
    OPENID = 'C'
    const r = await pv.main({ action: 'mark', wishId: 'w_new' })
    assertOk(r.ok, JSON.stringify(r))
    assertOk(r.arrangedAt > 0)
    assertEq(wishesOf(db).find(w => w._id === 'w_new').status, 'done_by_partner')
    OPENID = 'A'
  })

  await testCase('D7 历史文档（无 coupleId）一律不可 mark，库内零改动', async () => {
    // 与读取侧同一条红线：无法证明归属的心愿，不允许被当前关系流转状态。
    const db = seedFirstLove()
    const pv = loadFn('getPartnerView', db)
    OPENID = 'B'
    const r = await pv.main({ action: 'mark', wishId: 'w_legacy' })
    assertEq(r.ok, false)
    assertEq(r.code, 'FORBIDDEN')
    assertEq(wishesOf(db)[0].status, 'pending', '库内状态不得被改动')
    assertEq(Object.prototype.hasOwnProperty.call(wishesOf(db)[0], 'arrangedAt'), false)
    OPENID = 'A'
  })

  await testCase('D8 并发重复 mark：只流转一次，arrangedAt 不被覆盖', async () => {
    const db = seedRebound()
    const pv = loadFn('getPartnerView', db)
    OPENID = 'C'
    const [r1, r2] = await Promise.all([
      pv.main({ action: 'mark', wishId: 'w_new' }),
      pv.main({ action: 'mark', wishId: 'w_new' })
    ])
    const arr = wishesOf(db).find(w => w._id === 'w_new').arrangedAt
    assertOk(r1.arrangedAt === arr, '第一次返回的 arrangedAt 即库内值')
    assertOk(r2.already === true || r2.arrangedAt === arr, '第二次必须是幂等返回')
    assertEq(wishesOf(db).find(w => w._id === 'w_new').status, 'done_by_partner')
    OPENID = 'A'
  })

  await testCase('D9 请求里伪造 coupleId / openid / role 一律无效', async () => {
    const db = seedRebound()
    const before = JSON.stringify(wishesOf(db))
    const pv = loadFn('getPartnerView', db)
    OPENID = 'C'
    const r = await pv.main({
      action: 'mark', wishId: 'w_old',
      coupleId: 'CZ-1', openid: 'A', role: 'her', fromOpenid: 'A'
    })
    assertEq(r.ok, false, '伪造参数不得绕过归属校验')
    assertEq(JSON.stringify(wishesOf(db)), before)
    OPENID = 'A'
  })
}

// ==================== E · 历史数据兼容 ====================
async function runLegacy() {
  console.log('\n=== E · 历史数据兼容（零写入 / 零删除 / 无迁移） ===\n')

  await testCase('E1 读操作不改写任何历史心愿（仅读时判定）', async () => {
    const db = seedRebound()
    const before = JSON.stringify(wishesOf(db))
    const pv = loadFn('getPartnerView', db)
    for (const who of ['A', 'C']) {
      OPENID = who
      await pv.main({})
    }
    assertEq(JSON.stringify(wishesOf(db)), before, '读路径必须零写入')
    OPENID = 'A'
  })

  await testCase('E2 全流程后 wishes 条数不减少（无删除）', async () => {
    const db = seedRebound()
    const n0 = wishesOf(db).length
    const pv = loadFn('getPartnerView', db)
    OPENID = 'C'
    await pv.main({})
    await pv.main({ action: 'mark', wishId: 'w_old' })
    await pv.main({ action: 'mark', wishId: 'w_new' })
    OPENID = 'A'
    await pv.main({})
    await loadFn('dailyRecord', db).main(saveEvent([{ type: 'eat', text: '新愿望' }]))
    assertEq(wishesOf(db).length, n0 + 1, '只允许新增，不允许减少')
    OPENID = 'A'
  })

  await testCase('E3 历史文档缺少 coupleId 时不会被自动补写（无隐式迁移）', async () => {
    const db = seedFirstLove()
    const pv = loadFn('getPartnerView', db)
    OPENID = 'B'
    await pv.main({})
    const w = wishesOf(db).find(x => x._id === 'w_legacy')
    assertOk(!Object.prototype.hasOwnProperty.call(w, 'coupleId'), '读路径不得擅自补写 coupleId')
    OPENID = 'A'
  })

  await testCase('E4 仓库内不存在自动回填 coupleId 的迁移脚本', () => {
    const files = []
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue
        const full = path.join(d, e.name)
        if (e.isDirectory()) walk(full)
        else if (/\.(js|json|md)$/.test(e.name)) files.push(full)
      }
    }
    walk(path.join(ROOT, 'cloudfunctions'))
    walk(path.join(ROOT, 'scripts'))
    // 迁移特征只有一种：对 wishes 集合做 update，且写入内容里带 coupleId
    const UPDATE_WITH_COUPLEID = /collection\(\s*['"]wishes['"]\s*\)[\s\S]{0,300}?\.update\s*\(\s*\{\s*data\s*:\s*\{[^}]*coupleId/
    const hits = files.filter(f => UPDATE_WITH_COUPLEID.test(fs.readFileSync(f, 'utf8')))
    assertEq(hits.length, 0, '发现疑似迁移写入：' + hits.join(', '))
  })

  await testCase('E5 wishes 集合在全仓没有任何 remove / 删除调用', () => {
    const targets = []
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue
        const full = path.join(d, e.name)
        if (e.isDirectory()) walk(full)
        else if (e.name.endsWith('.js') && !full.includes('tests' + path.sep)) targets.push(full)
      }
    }
    for (const d of ['cloudfunctions', 'pages', 'utils']) walk(path.join(ROOT, d))
    const hits = targets.filter(f => /collection\(\s*['"]wishes['"]\s*\)[\s\S]{0,200}\.remove\s*\(/.test(fs.readFileSync(f, 'utf8')))
    assertEq(hits.length, 0, '发现删除调用：' + hits.join(', '))
  })
}

// ==================== F · 静态守护 ====================
async function runStatic() {
  console.log('\n=== F · 静态守护 ===\n')

  await testCase('F1 两份 wish-scope.js 逐字节一致', () => {
    const a = fs.readFileSync(path.join(ROOT, 'cloudfunctions/getPartnerView/wish-scope.js'))
    const b = fs.readFileSync(path.join(ROOT, 'cloudfunctions/dailyRecord/wish-scope.js'))
    assertOk(a.equals(b), 'wish-scope.js 两份副本已漂移')
  })

  await testCase('F2 云函数按同目录 require 引入归属模块（不跨函数目录）', () => {
    for (const fn of ['getPartnerView', 'dailyRecord']) {
      const s = fs.readFileSync(path.join(ROOT, 'cloudfunctions', fn, 'index.js'), 'utf8')
      assertOk(s.includes("require('./wish-scope')"), fn + ' 未引入 wish-scope')
      assertOk(!s.includes("require('../"), fn + ' 存在跨云函数引用')
    }
  })

  await testCase('F3 归属判定不读取 event 里的 coupleId / role / openid', () => {
    const src = fs.readFileSync(path.join(ROOT, 'cloudfunctions/getPartnerView/index.js'), 'utf8')
    for (const bad of ['event.coupleId', 'event.role', 'event.openid', 'event.fromOpenid', 'event.userOpenid']) {
      assertOk(!src.includes(bad), '服务端读取了前端可控的身份字段: ' + bad)
    }
    // 身份唯一来源
    assertOk(src.includes('cloud.getWXContext()'), '身份必须来自 WXContext')
  })

  await testCase('F4 前端从不向云函数传 coupleId / 心愿归属字段', () => {
    const files = []
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name)
        if (e.isDirectory()) walk(full)
        else if (e.name.endsWith('.js')) files.push(full)
      }
    }
    walk(path.join(ROOT, 'pages'))
    walk(path.join(ROOT, 'utils'))
    const hits = files.filter(f => /callFunction\([\s\S]{0,300}coupleId\s*:/.test(fs.readFileSync(f, 'utf8')))
    assertEq(hits.length, 0, '前端疑似传入 coupleId：' + hits.join(', '))
  })

  await testCase('F5 getPartnerView 的 wish 查询带属主 + 归属双重过滤', () => {
    const src = fs.readFileSync(path.join(ROOT, 'cloudfunctions/getPartnerView/index.js'), 'utf8')
    assertOk(src.includes('where({ _openid: wishOwnerOpenid, coupleId: couple.coupleId })'), '缺少属主 + 关系双过滤')
    // 复核收口在 visibleWishOf：同一条判定同时守「心愿列表」与「这天的愿望」
    assertOk(src.includes('function visibleWishOf(w, ctx)'), '缺少关系归属复核')
    assertOk(src.includes('wishScope.isWishShared(w, ctx)'), '归属复核未调用 wishScope')
    assertOk(src.includes('visibleWishOf(w, wishCtx)'), '心愿列表未走归属复核')
    assertOk(!/collection\('wishes'\)\s*\.\s*where\(\{\s*_openid:\s*partnerOpenid\s*\}\)\s*\.orderBy\([^)]*\)\s*\.limit\(50\)/.test(src),
      '仍存在只按 _openid 取 50 条的旧查询')
  })

  await testCase('F6 dailyRecord 写心愿时带 coupleId，且判重按关系作用域', () => {
    const src = fs.readFileSync(path.join(ROOT, 'cloudfunctions/dailyRecord/index.js'), 'utf8')
    assertOk(src.includes('coupleId: wishScope.coupleIdForWrite(ctx)'), '新建心愿未写入 coupleId')
    assertOk(src.includes('wishScope.isSameScope(d, ctx)'), '判重未按关系作用域')
    assertOk(src.includes('canSyncWishes(recordCoupleId, ctx)'), '缺少「记录归属 → 才可产愿」的写入闸门')
  })

  await testCase('F7 getPartnerView 的 daily_records 读取带记录级归属校验', () => {
    const src = fs.readFileSync(path.join(ROOT, 'cloudfunctions/getPartnerView/index.js'), 'utf8')
    assertOk(src.includes('wishScope.isRecordInCouple(partnerRecRaw, couple)'), 'partner 记录未做归属校验')
    assertOk(!/where\(\{\s*_openid:\s*partnerOpenid,\s*date\s*\}\)\.get\(\)\)\.data\[0\]\s*\n\s*const myRec/.test(src),
      '仍存在无归属校验的 partner 记录读取')
  })

  await testCase('F8 aiSummary 周报与伴侣小结带关系归属过滤', () => {
    const src = fs.readFileSync(path.join(ROOT, 'cloudfunctions/aiSummary/index.js'), 'utf8')
    assertOk(src.includes('coupleId: couple.coupleId'), '周报查询未按关系过滤')
    assertOk(src.includes('isRecShareable(rec, ownerCoupleId)'), '伴侣小结未做归属校验')
    assertOk(src.includes('partnerSummaryCoupleId'), '伴侣小结未记录生成时的关系')
  })
}

// ==================== G · 旧客户端兼容 ====================
async function runCompat() {
  console.log('\n=== G · 旧客户端兼容 ===\n')

  await testCase('G1 旧客户端只传 type/text 的 wishes → 服务端仍能正确归属', async () => {
    const db = seedFirstLove({ wishes: [] })
    const daily = loadFn('dailyRecord', db)
    OPENID = 'A'
    // 旧版 record.js 的 payload（无任何 coupleId 概念）
    const r = await daily.main(saveEvent([{ type: 'eat', text: '火锅' }, { type: 'do', text: '看海' }]))
    assertOk(r.ok)
    assertEq(wishesOf(db).length, 2)
    for (const w of wishesOf(db)) assertEq(w.coupleId, 'CZ-1')
  })

  await testCase('G2 旧客户端 mark 只传 wishId → 行为不变（当前关系心愿仍可安排）', async () => {
    const db = seedFirstLove({
      wishes: [{ _id: 'w_cur', _openid: 'A', coupleId: 'CZ-1', type: 'eat', text: '火锅', status: 'pending', createdAt: 1000 }]
    })
    const pv = loadFn('getPartnerView', db)
    OPENID = 'B'
    const r = await pv.main({ action: 'mark', wishId: 'w_cur' })
    assertOk(r.ok, JSON.stringify(r))
    assertEq(wishesOf(db)[0].status, 'done_by_partner')
    OPENID = 'A'
  })

  await testCase('G3 view 返回的心愿字段集合没有新增（旧前端渲染不炸）', async () => {
    const db = seedFirstLove({
      wishes: [{ _id: 'w_cur', _openid: 'A', coupleId: 'CZ-1', type: 'eat', text: '火锅', status: 'pending', createdAt: 1000 }]
    })
    const pv = loadFn('getPartnerView', db)
    OPENID = 'B'
    const r = await pv.main({})
    const keys = Object.keys(r.wishes[0]).sort()
    assertDeep(keys, ['_id', 'arrangedAt', 'createdAt', 'status', 'text', 'type'], '心愿返回字段发生变化')
    OPENID = 'A'
  })

  await testCase('G4 响应体不回传 coupleId / openid（不扩大下发给客户端的信息面）', async () => {
    const db = seedFirstLove({
      wishes: [{ _id: 'w_cur', _openid: 'A', coupleId: 'CZ-1', type: 'eat', text: '火锅', status: 'pending', createdAt: 1000 }]
    })
    const pv = loadFn('getPartnerView', db)
    OPENID = 'B'
    const r = await pv.main({})
    assertEq(r.wishes.length, 1)
    const s = JSON.stringify(r.wishes)
    assertOk(!s.includes('coupleId'), '心愿返回体不应带 coupleId')
    assertOk(!s.includes('openid') && !s.includes('_openid'), '心愿返回体不应带 openid')
    OPENID = 'A'
  })
}

async function main() {
  await runAttribution()
  await runCreate()
  await runRead()
  await runWrite()
  await runLegacy()
  await runStatic()
  await runCompat()
  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
  console.log('Wish Couple Scope: ALL GREEN')
}

main().catch(e => { console.error('测试执行异常:', e); process.exit(1) })
