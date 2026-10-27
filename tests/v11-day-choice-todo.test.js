// ============================================================
// tests/v11-day-choice-todo.test.js · V1.1 最后两个核心功能
//
//   功能一：今天吃什么 / 今天去哪里 —— 确认闭环（day_choices）
//   功能二：双方共同待办（couple_todos）
//
// 四档证据，分开标注，互不冒充：
//   [L1] 代码结构存在      —— 静态源码 / WXML 断言
//   [L2] 本地模拟请求成功  —— **真实云函数代码** + 内存云数据库 + **真实页面代码** + 假 wx
//   [L3] 微信云环境真实请求 —— 未覆盖（需上传云函数）
//   [L4] 开发者工具实际渲染 —— 未覆盖（需在微信开发者工具里看）
//
// 运行：node tests/v11-day-choice-todo.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const fs = require('fs')
const { MockDB } = require('./mock-db')

const ROOT = path.resolve(__dirname, '..')
const LP_PATH = path.join(ROOT, 'cloudfunctions/lifePlanner/index.js')
const GPV_PATH = path.join(ROOT, 'cloudfunctions/getPartnerView/index.js')
const HOME_PAGE = path.join(ROOT, 'pages/home/home.js')
const OURS_PAGE = path.join(ROOT, 'pages/ours/ours.js')
const RECORD_PAGE = path.join(ROOT, 'pages/record/record.js')
const FOOD_PAGE = path.join(ROOT, 'pages/food/food.js')
const TRAVEL_PAGE = path.join(ROOT, 'pages/travel/travel.js')

const HER = 'openid_her_A'
const HIM = 'openid_him_B'
const HER2 = 'openid_her_C'
const HIM2 = 'openid_him_D'
const HIM_ORPHAN = 'openid_him_E'

let OPENID = HER
let passed = 0, failed = 0, failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name) })
    .catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message) })
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a))
}
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }
function assertNo(v, msg) { if (v) throw new Error(msg || '断言失败（期望不存在）') }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8') }
const flush = () => new Promise(r => setTimeout(r, 0))

// ---------------- 载入真实云函数（只替换 wx-server-sdk） ----------------
function loadFn(fnPath, db) {
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
  delete require.cache[fnPath]
  const mod = require(fnPath)
  Module._load = origLoad
  return mod
}
const loadLp = (db) => loadFn(LP_PATH, db)
const loadGpv = (db) => loadFn(GPV_PATH, db)

// ---------------- 种子数据 ----------------
const R_MEAT = 'r_meat_1'
const R_VEG = 'r_veg_1'
const R_SOUP = 'r_soup_1'
const R_MEAT_OFF = 'r_meat_off'
const R_MEAT_2 = 'r_meat_2'
const P_ON = 'p_on_1'
const P_OFF = 'p_off_1'

function recipe(id, name, category, enabled) {
  return { _id: id, name, category, enabled: enabled !== false, seedVersion: 'test', revision: 1, ingredients: [], steps: [], tips: [] }
}

function seed(opts) {
  const o = opts || {}
  return {
    users: [
      { _id: 'u_her', _openid: HER, role: 'her', coupleId: o.herCouple === undefined ? 'CZ-1' : o.herCouple, schemaVersion: 2 },
      { _id: 'u_him', _openid: HIM, role: 'him', coupleId: 'CZ-1', schemaVersion: 2 },
      { _id: 'u_her2', _openid: HER2, role: 'her', coupleId: 'CZ-2', schemaVersion: 2 },
      { _id: 'u_him2', _openid: HIM2, role: 'him', coupleId: 'CZ-2', schemaVersion: 2 },
      { _id: 'u_orphan', _openid: HIM_ORPHAN, role: 'him', coupleId: null, schemaVersion: 2 }
    ],
    couples: [
      { _id: 'c1', coupleId: 'CZ-1', herOpenid: HER, himOpenid: HIM, status: o.status || 'active', anniversary: null },
      { _id: 'c2', coupleId: 'CZ-2', herOpenid: HER2, himOpenid: HIM2, status: 'active', anniversary: null }
    ],
    recipes: [
      recipe(R_MEAT, '青椒炒肉', 'meat'),
      recipe(R_MEAT_2, '红烧肉', 'meat'),
      recipe(R_MEAT_OFF, '停用荤菜', 'meat', false),
      recipe(R_VEG, '蒜蓉西兰花', 'vegetable'),
      recipe(R_SOUP, '番茄蛋汤', 'soup')
    ],
    travel_places: [
      { _id: P_ON, name: '承德避暑山庄', type: 'outside', city: '承德', enabled: true, revision: 1, highlights: [], plan: { title: 't', days: [] } },
      { _id: P_OFF, name: '停用地点', type: 'beijing', enabled: false, revision: 1 }
    ],
    daily_records: o.daily_records || [],
    messages: [],
    wishes: [],
    menstrual: [],
    day_choices: o.day_choices || [],
    couple_todos: o.couple_todos || []
  }
}

const MEAL_IDS = [R_MEAT, R_VEG, R_SOUP]

// ============================================================
// 页面 harness（真实页面代码 + 假 wx）
// ============================================================
function makeWx(routes, opts) {
  const o = opts || {}
  const calls = []
  const modals = []
  return {
    calls,
    modals,
    wx: {
      cloud: {
        callFunction: (payload) => {
          calls.push(payload)
          const name = payload && payload.name
          const action = (payload && payload.data && payload.data.action) || 'view'
          const key = name + ':' + action
          const h = (routes || {})[key] || (routes || {})[action]
          if (!h) return Promise.resolve({ result: { ok: true } })
          if (h === 'reject') return Promise.reject(new Error('offline'))
          return Promise.resolve(h(payload.data || {}, payload)).then(r => ({ result: r }))
        }
      },
      getStorageSync: () => '',
      setStorageSync: () => {},
      removeStorageSync: () => {},
      showToast: () => {},
      showModal: (m) => { modals.push(m); if (o.autoConfirm && typeof m.success === 'function') m.success({ confirm: true }) },
      switchTab: () => {},
      navigateTo: () => {}
    }
  }
}

function loadPage(pagePath, wx, globalData) {
  global.getApp = () => ({
    globalData: Object.assign({ openid: HER, role: 'her', coupleId: 'CZ-1', bindCode: null, wishOpenOnEnter: false, partnerName: '' }, globalData || {}),
    whenReady: () => {},
    loginSnapshot: () => ({ state: 'ready' }),
    silentLogin: () => {}
  })
  global.wx = wx
  let def = null
  global.Page = (c) => { def = c }
  delete require.cache[pagePath]
  require(pagePath)
  const page = Object.assign({}, def)
  page.data = JSON.parse(JSON.stringify(def.data))
  page.setData = function (patch) { Object.assign(page.data, patch || {}) }
  return page
}

async function main() {
  console.log('\n=== V1.1 今日决定 + 共同待办 ===\n')

  const dc = require(path.join(ROOT, 'cloudfunctions/lifePlanner/day-choice.js'))
  const TODAY = dc.beijingToday()

  // ============================================================
  console.log('-- A. 今天吃什么 / 今天去哪里（服务端行为） --')
  // ============================================================

  await testCase('[L2] A1 her 可以确认吃什么：落库 1 条，名称快照由服务端读库生成', async () => {
    const db = new MockDB(seed())
    const lp = loadLp(db)
    OPENID = HER
    const r = await lp.main({ action: 'confirmDayChoice', kind: 'meal', refIds: MEAL_IDS })
    assertEq(r.ok, true, '确认必须成功')
    assertEq(r.date, TODAY, '日期必须是服务端的北京时间今天')
    assertEq(r.name, '青椒炒肉 + 蒜蓉西兰花 + 番茄蛋汤')
    assertEq(r.mode, 'created')
    const rows = db.dump().day_choices
    assertEq(rows.length, 1, '只能有一条')
    assertEq(rows[0].coupleId, 'CZ-1', 'coupleId 必须来自服务端关系')
    assertEq(rows[0].decidedRole, 'her')
    assertEq(rows[0].date, TODAY)
    assertEq(rows[0].kind, 'meal')
  })

  await testCase('[L2] A2 him 不能确认：FORBIDDEN 且零写入（服务端拒绝，不是靠前端隐藏按钮）', async () => {
    const db = new MockDB(seed())
    const lp = loadLp(db)
    OPENID = HIM
    const r = await lp.main({ action: 'confirmDayChoice', kind: 'meal', refIds: MEAL_IDS })
    assertEq(r.ok, false)
    assertEq(r.code, 'FORBIDDEN')
    assertEq((db.dump().day_choices || []).length, 0, 'him 越权确认不得留下任何文档')
  })

  await testCase('[L2] A3 双方读到同一份结果（her / him 的 name 与 refIds 完全一致）', async () => {
    const db = new MockDB(seed())
    const lp = loadLp(db)
    OPENID = HER
    assertEq((await lp.main({ action: 'confirmDayChoice', kind: 'meal', refIds: MEAL_IDS })).ok, true)
    const her = await lp.main({ action: 'getDayChoice' })
    OPENID = HIM
    const him = await lp.main({ action: 'getDayChoice' })
    assertEq(her.ok, true)
    assertEq(him.ok, true)
    assertEq(her.meal.name, him.meal.name)
    assertEq(her.meal.refIds.join(','), him.meal.refIds.join(','))
    assertEq(him.meal.name, '青椒炒肉 + 蒜蓉西兰花 + 番茄蛋汤')
    assertEq(him.role, 'him')
  })

  await taskSafe('A4 同一天重新确认覆盖旧结果（仍然只有一条，取最后一次成功保存）', async () => {
    const db = new MockDB(seed())
    const lp = loadLp(db)
    OPENID = HER
    await lp.main({ action: 'confirmDayChoice', kind: 'meal', refIds: MEAL_IDS })
    const r2 = await lp.main({ action: 'confirmDayChoice', kind: 'meal', refIds: [R_MEAT_2, R_VEG, R_SOUP] })
    assertEq(r2.ok, true)
    assertEq(r2.mode, 'replaced')
    const rows = db.dump().day_choices
    assertEq(rows.length, 1, '覆盖而不是新增')
    assertEq(rows[0].nameSnapshot, '红烧肉 + 蒜蓉西兰花 + 番茄蛋汤')
    const read2 = await lp.main({ action: 'getDayChoice', kind: 'meal' })
    assertEq(read2.meal.name, '红烧肉 + 蒜蓉西兰花 + 番茄蛋汤')
  })

  await testCase('[L2] A5 第二天不继承前一天结果（按日期分键，昨天读不到今天的决定）', async () => {
    const db = new MockDB(seed())
    const lp = loadLp(db)
    OPENID = HER
    await lp.main({ action: 'confirmDayChoice', kind: 'meal', refIds: MEAL_IDS })
    const yesterday = dc.beijingToday(new Date(Date.now() - 86400000))
    const r = await lp.main({ action: 'getDayChoice', date: yesterday })
    assertEq(r.ok, true, '读昨天是合法请求')
    assertEq(r.meal, null, '昨天没有决定，不能被今天的结果顶替')
    assertOk(dc.choiceDocId('CZ-1', TODAY, 'meal') !== dc.choiceDocId('CZ-1', yesterday, 'meal'), '不同日期必须不同 ID')
  })

  await testCase('[L2] A6 无效推荐 ID → NOT_FOUND，零写入', async () => {
    const db = new MockDB(seed())
    const lp = loadLp(db)
    OPENID = HER
    const r = await lp.main({ action: 'confirmDayChoice', kind: 'meal', refIds: ['not_exist', R_VEG, R_SOUP] })
    assertEq(r.ok, false)
    assertEq(r.code, 'NOT_FOUND')
    assertEq((db.dump().day_choices || []).length, 0)
  })

  await taskSafe('A7 已停用条目 → UNAVAILABLE，零写入（菜谱与地点各验一次）', async () => {
    const db = new MockDB(seed())
    const lp = loadLp(db)
    OPENID = HER
    const r1 = await lp.main({ action: 'confirmDayChoice', kind: 'meal', refIds: [R_MEAT_OFF, R_VEG, R_SOUP] })
    assertEq(r1.ok, false)
    assertEq(r1.code, 'UNAVAILABLE')
    const r2 = await lp.main({ action: 'confirmDayChoice', kind: 'travel', refIds: [P_OFF] })
    assertEq(r2.ok, false)
    assertEq(r2.code, 'UNAVAILABLE')
    assertEq((db.dump().day_choices || []).length, 0)
  })

  await taskSafe('A8 关系非 active / 未绑定 → NOT_ACTIVE（读和写都拒绝）', async () => {
    const db = new MockDB(seed({ status: 'superseded' }))
    const lp = loadLp(db)
    OPENID = HER
    assertEq((await lp.main({ action: 'getDayChoice' })).code, 'NOT_ACTIVE')
    assertEq((await lp.main({ action: 'confirmDayChoice', kind: 'meal', refIds: MEAL_IDS })).code, 'NOT_ACTIVE')
    const db2 = new MockDB(seed({ herCouple: null }))
    const lp2 = loadLp(db2)
    OPENID = HER
    assertEq((await lp2.main({ action: 'getDayChoice' })).code, 'NOT_ACTIVE')
    assertEq((await lp2.main({ action: 'confirmDayChoice', kind: 'travel', refIds: [P_ON] })).code, 'NOT_ACTIVE')
  })

  await testCase('[L2] A9 换绑后读不到旧关系的决定（新关系算不出旧 ID，且文档内 coupleId 不符）', async () => {
    const db = new MockDB(seed())
    const lp = loadLp(db)
    OPENID = HER
    const w = await lp.main({ action: 'confirmDayChoice', kind: 'meal', refIds: MEAL_IDS })
    assertOk(w.ok)
    // 模拟换绑：她的 coupleId 指向新的 active 关系（旧关系置 superseded）
    db._data.users[0].coupleId = 'CZ-9'
    db._data.couples[0].status = 'superseded'
    db._data.couples.push({ _id: 'c9', coupleId: 'CZ-9', herOpenid: HER, himOpenid: 'openid_him_new', status: 'active', anniversary: null })
    const r = await lp.main({ action: 'getDayChoice' })
    assertEq(r.ok, true, '新关系本身是有效的')
    assertEq(r.meal, null, '旧关系的决定必须读不到')
    assertEq(r.travel, null)
  })

  await taskSafe('A10 去哪里：确认 + 双方读取（地点名称快照来自库）', async () => {
    const db = new MockDB(seed())
    const lp = loadLp(db)
    OPENID = HER
    const r = await lp.main({ action: 'confirmDayChoice', kind: 'travel', refIds: [P_ON] })
    assertEq(r.ok, true)
    assertEq(r.name, '承德避暑山庄')
    OPENID = HIM
    const v = await lp.main({ action: 'getDayChoice', kind: 'travel' })
    assertEq(v.travel.name, '承德避暑山庄')
    assertEq(v.meal, null, '只读 travel 时不返回 meal')
  })

  await taskSafe('A11 跨情侣隔离：别人确认不会改到我们的结果，也读不到我们的', async () => {
    const db = new MockDB(seed())
    const lp = loadLp(db)
    OPENID = HER
    await lp.main({ action: 'confirmDayChoice', kind: 'meal', refIds: MEAL_IDS })
    OPENID = HER2
    const other = await lp.main({ action: 'getDayChoice' })
    assertEq(other.meal, null, '另一对情侣读不到')
    const w = await lp.main({ action: 'confirmDayChoice', kind: 'meal', refIds: [R_MEAT_2, R_VEG, R_SOUP] })
    assertEq(w.ok, true)
    const all = db.dump().day_choices
    assertEq(all.length, 2, '两对情侣各一条，互不覆盖')
    const mine = all.find(x => x.coupleId === 'CZ-1')
    assertEq(mine.nameSnapshot, '青椒炒肉 + 蒜蓉西兰花 + 番茄蛋汤', '我们的结果没被改')
  })

  await taskSafe('A12 客户端伪造无效：传 coupleId / role / 名称都不生效（him 也不能靠 role 提权）', async () => {
    const db = new MockDB(seed())
    const lp = loadLp(db)
    OPENID = HIM
    const r = await lp.main({
      action: 'confirmDayChoice', kind: 'meal', refIds: MEAL_IDS,
      coupleId: 'CZ-2', role: 'her', name: '伪造的菜名', nameSnapshot: '伪造的菜名'
    })
    assertEq(r.code, 'FORBIDDEN', '角色只认 couples 文档，客户端传 role 无效')
    assertEq((db.dump().day_choices || []).length, 0)
    // her 传伪造名称 → 落库的仍是服务端读库生成的名称
    OPENID = HER
    await lp.main({ action: 'confirmDayChoice', kind: 'meal', refIds: MEAL_IDS, nameSnapshot: '伪造的菜名', coupleId: 'CZ-2' })
    const doc = db.dump().day_choices[0]
    assertEq(doc.nameSnapshot, '青椒炒肉 + 蒜蓉西兰花 + 番茄蛋汤')
    assertEq(doc.coupleId, 'CZ-1', 'coupleId 只取服务端解析结果')
  })

  await taskSafe('A13 参数非法：kind 未知 / refIds 形状不对 / 分类不匹配 → BAD_ARGS', async () => {
    const db = new MockDB(seed())
    const lp = loadLp(db)
    OPENID = HER
    assertEq((await lp.main({ action: 'confirmDayChoice', kind: 'sleep', refIds: MEAL_IDS })).code, 'BAD_ARGS')
    assertEq((await lp.main({ action: 'confirmDayChoice', kind: 'meal', refIds: [R_MEAT, R_VEG] })).code, 'BAD_ARGS')
    assertEq((await lp.main({ action: 'confirmDayChoice', kind: 'meal', refIds: [R_MEAT, R_MEAT, R_VEG] })).code, 'BAD_ARGS')
    // 三个都是荤菜：形状对、分类错
    const bad = await lp.main({ action: 'confirmDayChoice', kind: 'meal', refIds: [R_MEAT, R_MEAT_2, R_VEG] })
    assertEq(bad.code, 'BAD_ARGS')
    assertEq((db.dump().day_choices || []).length, 0)
  })

  await testCase('[L1] A14 确定性文档 ID：28 字符、字符集合法、同键稳定、不同键不重复', () => {
    const id = dc.choiceDocId('CZ-1', '2026-10-26', 'meal')
    assertEq(id, 'dc_2026-10-26_m_' + id.slice(16), '前缀与日期必须可读')
    assertEq(id.length, 28, '长度必须固定 28 字符')
    assertOk(id.length <= dc.MAX_ID_LEN, '必须 ≤ 32')
    assertOk(/^[0-9a-zA-Z_-]+$/.test(id), '字符集必须是 [0-9a-zA-Z_-]')
    assertEq(dc.choiceDocId('CZ-1', '2026-10-26', 'meal'), id, '同键必须稳定')
    const keys = new Set([
      dc.choiceDocId('CZ-1', '2026-10-26', 'meal'),
      dc.choiceDocId('CZ-1', '2026-10-26', 'travel'),
      dc.choiceDocId('CZ-1', '2026-10-27', 'meal'),
      dc.choiceDocId('CZ-2', '2026-10-26', 'meal')
    ])
    assertEq(keys.size, 4, '关系 / 日期 / 类型任一不同都必须得到不同 ID')
    assertEq(dc.choiceDocId('', '2026-10-26', 'meal'), null)
    assertEq(dc.choiceDocId('CZ-1', '2026-02-30', 'meal'), null, '非法日期不生成 ID')
  })

  await testCase('[L1] A15 北京时间自然日：跨零点不会把「今天」算成昨天', () => {
    // UTC 15:59 = 北京时间 23:59（还是当天）
    assertEq(dc.beijingToday(new Date('2026-10-25T15:59:00Z')), '2026-10-25')
    // UTC 16:00 = 北京时间次日 00:00
    assertEq(dc.beijingToday(new Date('2026-10-25T16:00:00Z')), '2026-10-26')
    assertEq(dc.beijingToday(new Date('2026-10-25T16:30:00Z')), '2026-10-26')
  })

  // ============================================================
  console.log('\n-- B. 双方共同待办（服务端行为） --')
  // ============================================================

  await taskSafe('B1 her 添加后 him 能读到（同一份 list）', async () => {
    const db = new MockDB(seed())
    const gpv = loadGpv(db)
    OPENID = HER
    const add = await gpv.main({ action: 'coupleTodo', op: 'add', text: '周末一起去超市' })
    assertEq(add.ok, true)
    assertEq(add.item.text, '周末一起去超市')
    assertEq(add.item.done, false)
    OPENID = HIM
    const list = await gpv.main({ action: 'coupleTodo', op: 'list' })
    assertEq(list.ok, true)
    assertEq(list.items.length, 1)
    assertEq(list.items[0].text, '周末一起去超市')
  })

  await taskSafe('B2 him 添加后 her 能读到', async () => {
    const db = new MockDB(seed())
    const gpv = loadGpv(db)
    OPENID = HIM
    assertEq((await gpv.main({ action: 'coupleTodo', op: 'add', text: '订电影票' })).ok, true)
    OPENID = HER
    const list = await gpv.main({ action: 'coupleTodo', op: 'list' })
    assertEq(list.items.length, 1)
    assertEq(list.items[0].text, '订电影票')
  })

  await taskSafe('B3 双方都能标记完成与恢复（状态互相可见）', async () => {
    const db = new MockDB(seed())
    const gpv = loadGpv(db)
    OPENID = HER
    const add = await gpv.main({ action: 'coupleTodo', op: 'add', text: '整理旅行行李' })
    const id = add.item._id
    assertEq((await gpv.main({ action: 'coupleTodo', op: 'toggle', id, done: true })).ok, true)
    OPENID = HIM
    let list = await gpv.main({ action: 'coupleTodo', op: 'list' })
    assertEq(list.items[0].done, true, 'him 能看到 her 标的完成')
    assertEq((await gpv.main({ action: 'coupleTodo', op: 'toggle', id, done: false })).ok, true)
    OPENID = HER
    list = await gpv.main({ action: 'coupleTodo', op: 'list' })
    assertEq(list.items[0].done, false, 'him 恢复后 her 也能看到')
  })

  await taskSafe('B4 双方都能删除', async () => {
    const db = new MockDB(seed())
    const gpv = loadGpv(db)
    OPENID = HER
    const a = await gpv.main({ action: 'coupleTodo', op: 'add', text: '买生活用品' })
    OPENID = HIM
    assertEq((await gpv.main({ action: 'coupleTodo', op: 'remove', id: a.item._id })).ok, true)
    const list = await gpv.main({ action: 'coupleTodo', op: 'list' })
    assertEq(list.items.length, 0)
    assertEq(db.dump().couple_todos.length, 0, '物理删除，不留幽灵行')
  })

  await taskSafe('B5 跨情侣：读不到、改不动、删不掉（NOT_FOUND 且数据不变）', async () => {
    const db = new MockDB(seed())
    const gpv = loadGpv(db)
    OPENID = HER
    const a = await gpv.main({ action: 'coupleTodo', op: 'add', text: '只有我们能看到的待办' })
    const id = a.item._id
    OPENID = HER2
    const list2 = await gpv.main({ action: 'coupleTodo', op: 'list' })
    assertEq(list2.items.length, 0, '另一对情侣列表必须为空')
    assertEq((await gpv.main({ action: 'coupleTodo', op: 'toggle', id, done: true })).code, 'NOT_FOUND')
    assertEq((await gpv.main({ action: 'coupleTodo', op: 'remove', id })).code, 'NOT_FOUND')
    const row = db.dump().couple_todos[0]
    assertEq(row.done, false, '跨情侣改不动')
    assertEq(db.dump().couple_todos.length, 1, '跨情侣删不掉')
  })

  await taskSafe('B6 非 active 关系 / 未绑定 → NOT_ACTIVE（四个 op 全拒）', async () => {
    const db = new MockDB(seed({ status: 'superseded' }))
    const gpv = loadGpv(db)
    OPENID = HER
    for (const op of ['list', 'add', 'toggle', 'remove']) {
      const r = await gpv.main({ action: 'coupleTodo', op, text: 'x', id: 'x', done: true })
      assertEq(r.code, 'NOT_ACTIVE', op + ' 必须 NOT_ACTIVE')
    }
    const db2 = new MockDB(seed({ herCouple: null }))
    const gpv2 = loadGpv(db2)
    OPENID = HER
    assertEq((await gpv2.main({ action: 'coupleTodo', op: 'add', text: 'x' })).code, 'NOT_ACTIVE')
  })

  await taskSafe('B7 空内容 / 纯空白 / 过长 / 非字符串 → BAD_ARGS，零写入', async () => {
    const db = new MockDB(seed())
    const gpv = loadGpv(db)
    OPENID = HER
    for (const bad of ['', '   ', '\n\t ', 'a'.repeat(41), null, undefined, 123, {}, []]) {
      const r = await gpv.main({ action: 'coupleTodo', op: 'add', text: bad })
      assertEq(r.code, 'BAD_ARGS', JSON.stringify(bad) + ' 必须被拒绝')
    }
    assertEq((db.dump().couple_todos || []).length, 0, '非法输入不得落库')
    // 边界：正好 40 字可以
    const ok = await gpv.main({ action: 'coupleTodo', op: 'add', text: 'a'.repeat(40) })
    assertEq(ok.ok, true, '40 字是上限，必须允许')
    // 前后空白会被归一化，中间多空白折叠
    const t = await gpv.main({ action: 'coupleTodo', op: 'add', text: '  一起去   看电影  ' })
    assertEq(t.item.text, '一起去 看电影')
  })

  await taskSafe('B8 不影响她现有的个人待办（daily_records 一个字节都不动）', async () => {
    const personal = [{ text: '她自己的小事', done: false }, { text: '已完成的', done: true }]
    const db = new MockDB(seed({
      daily_records: [{ _id: 'rec1', _openid: HER, date: TODAY, coupleId: 'CZ-1', todos: personal, revision: 3 }]
    }))
    const gpv = loadGpv(db)
    const before = JSON.stringify(db.dump().daily_records)
    OPENID = HER
    const a = await gpv.main({ action: 'coupleTodo', op: 'add', text: '共同待办一条' })
    await gpv.main({ action: 'coupleTodo', op: 'toggle', id: a.item._id, done: true })
    await gpv.main({ action: 'coupleTodo', op: 'list' })
    await gpv.main({ action: 'coupleTodo', op: 'remove', id: a.item._id })
    assertEq(JSON.stringify(db.dump().daily_records), before, '个人待办必须完全不受影响')
  })

  await taskSafe('B9 列表排序：未完成在前（新→旧），已完成置后', async () => {
    const db = new MockDB(seed({
      couple_todos: [
        { _id: 't1', coupleId: 'CZ-1', text: '早的未完成', done: false, createdAt: 100, doneAt: 0 },
        { _id: 't2', coupleId: 'CZ-1', text: '晚的未完成', done: false, createdAt: 300, doneAt: 0 },
        { _id: 't3', coupleId: 'CZ-1', text: '已完成的', done: true, createdAt: 200, doneAt: 400 }
      ]
    }))
    const gpv = loadGpv(db)
    OPENID = HER
    const list = await gpv.main({ action: 'coupleTodo', op: 'list' })
    assertEq(list.items.map(i => i.text).join(','), '晚的未完成,早的未完成,已完成的', '未完成新的在前，完成的排最后')
    assertEq(list.truncated, false)
    assertEq(list.limit, 100)
    // 新增一条未完成 → 应该排在最前面（比已有的未完成都新）
    const added = await gpv.main({ action: 'coupleTodo', op: 'add', text: '刚加的' })
    assertOk(added.ok)
    const after = await gpv.main({ action: 'coupleTodo', op: 'list' })
    assertEq(after.items[0].text, '刚加的')
    assertEq(after.items[after.items.length - 1].text, '已完成的')
  })

  await taskSafe('B10 幂等与严格布尔：done 非布尔被拒；重复标记同一状态不出错', async () => {
    const db = new MockDB(seed())
    const gpv = loadGpv(db)
    OPENID = HER
    const a = await gpv.main({ action: 'coupleTodo', op: 'add', text: '幂等测试' })
    const id = a.item._id
    for (const bad of ['true', 1, null, undefined]) {
      assertEq((await gpv.main({ action: 'coupleTodo', op: 'toggle', id, done: bad })).code, 'BAD_ARGS')
    }
    assertEq((await gpv.main({ action: 'coupleTodo', op: 'toggle', id, done: true })).ok, true)
    assertEq((await gpv.main({ action: 'coupleTodo', op: 'toggle', id, done: true })).ok, true, '重复标记同一状态也必须成功')
    assertEq((await gpv.main({ action: 'coupleTodo', op: 'nope' })).code, 'BAD_ARGS')
  })

  // ============================================================
  console.log('\n-- C. 客户端行为（真实页面代码 + 假 wx） --')
  // ============================================================

  await taskSafe('C1 首页：读到决定后显示名字，未确认才显示「还没决定」', async () => {
    const { wx } = makeWx({
      'lifePlanner:getDayChoice': () => ({
        ok: true, date: TODAY, role: 'her',
        meal: { kind: 'meal', name: '青椒炒肉 + 蒜蓉西兰花 + 番茄蛋汤', refIds: MEAL_IDS, decidedAt: 1 },
        travel: null
      })
    })
    const page = loadPage(HOME_PAGE, wx)
    page._loadDayChoice()
    await flush()
    assertEq(page.data.dayChoiceState, 'ready')
    assertEq(page.data.mealDecided, true)
    assertEq(page.data.mealName, '青椒炒肉 + 蒜蓉西兰花 + 番茄蛋汤')
    assertEq(page.data.travelDecided, false, '没确认的地点必须是未确认态')
  })

  await taskSafe('C2 首页：关系不可用 → blocked，两张卡片都不渲染（不显示「还没决定」）', async () => {
    const { wx } = makeWx({ 'lifePlanner:getDayChoice': () => ({ ok: false, code: 'NOT_ACTIVE' }) })
    const page = loadPage(HOME_PAGE, wx)
    page._loadDayChoice()
    await flush()
    assertEq(page.data.dayChoiceState, 'blocked')
    assertEq(page.data.mealDecided, false)
    assertEq(page.data.mealName, '')
  })

  await taskSafe('C3 首页：请求失败 → error（既不显示未决定，也不伪造结果）', async () => {
    const { wx } = makeWx({ 'lifePlanner:getDayChoice': 'reject' })
    const page = loadPage(HOME_PAGE, wx)
    page._loadDayChoice()
    await flush()
    assertEq(page.data.dayChoiceState, 'error')
    assertEq(page.data.mealDecided, false)
    assertEq(page.data.mealName, '')
  })

  await taskSafe('C4 首页：先成功后失败 → 保留已知结果（不被网络异常覆盖成未决定）', async () => {
    let mode = 'ok'
    const { wx } = makeWx({
      'lifePlanner:getDayChoice': () => {
        if (mode === 'ok') return { ok: true, date: TODAY, role: 'her', meal: { kind: 'meal', name: '红烧肉 + 蒜蓉西兰花 + 番茄蛋汤', refIds: MEAL_IDS, decidedAt: 2 }, travel: null }
        return Promise.reject(new Error('offline'))
      }
    })
    const page = loadPage(HOME_PAGE, wx)
    page._loadDayChoice()
    await flush()
    assertEq(page.data.mealDecided, true)
    mode = 'fail'
    page._loadDayChoice()
    await flush()
    assertEq(page.data.dayChoiceState, 'ready', '已知结果必须保留')
    assertEq(page.data.mealName, '红烧肉 + 蒜蓉西兰花 + 番茄蛋汤')
  })

  await taskSafe('C5 吃什么：her 确认成功 → 已确定状态 + 服务端快照；换成别的组合后按钮恢复', async () => {
    const { wx, calls } = makeWx({
      'lifePlanner:confirmDayChoice': () => ({ ok: true, date: TODAY, kind: 'meal', refIds: MEAL_IDS, name: '青椒炒肉 + 蒜蓉西兰花 + 番茄蛋汤' }),
      'lifePlanner:getDayChoice': () => ({ ok: true, meal: null, travel: null })
    }, {})
    const page = loadPage(FOOD_PAGE, wx, { role: 'her' })
    page.syncRole()
    assertEq(page.data.isHer, true)
    page.setData({
      meal: { meat: { _id: R_MEAT, name: '青椒炒肉' }, vegetable: { _id: R_VEG, name: '蒜蓉西兰花' }, soup: { _id: R_SOUP, name: '番茄蛋汤' } }
    })
    page.confirmMeal()
    await flush()
    assertEq(page.data.confirmedName, '青椒炒肉 + 蒜蓉西兰花 + 番茄蛋汤')
    assertEq(page.data.isConfirmedCurrent, true, '当前这组就是已确认的那组')
    const sent = calls.filter(c => c.data && c.data.action === 'confirmDayChoice')[0]
    assertEq(sent.data.kind, 'meal')
    assertEq(sent.data.refIds.join(','), MEAL_IDS.join(','))
    // 再随机到别的菜 → 按钮不再是「已确定」
    page.setData({
      meal: { meat: { _id: R_MEAT_2, name: '红烧肉' }, vegetable: { _id: R_VEG, name: '蒜蓉西兰花' }, soup: { _id: R_SOUP, name: '番茄蛋汤' } }
    })
    page.setData({ isConfirmedCurrent: page._isCurrent(page.data.confirmedKey) })
    assertEq(page.data.isConfirmedCurrent, false, '换了组合就不能再显示已确定')
  })

  await taskSafe('C6 吃什么：him 不显示确认入口，即使调用也不发请求', async () => {
    const { wx, calls } = makeWx({ 'lifePlanner:confirmDayChoice': () => ({ ok: true }) })
    const page = loadPage(FOOD_PAGE, wx, { role: 'him' })
    page.syncRole()
    assertEq(page.data.isHer, false)
    page.setData({ meal: { meat: { _id: R_MEAT }, vegetable: { _id: R_VEG }, soup: { _id: R_SOUP } } })
    page.confirmMeal()
    await flush()
    assertEq(calls.filter(c => c.data && c.data.action === 'confirmDayChoice').length, 0, 'him 端不得发出确认请求')
  })

  await taskSafe('C7 去哪里：确认成功写入服务端快照；him 同样不能确认', async () => {
    const { wx, calls } = makeWx({
      'lifePlanner:confirmDayChoice': () => ({ ok: true, kind: 'travel', refIds: [P_ON], name: '承德避暑山庄' }),
      'lifePlanner:getDayChoice': () => ({ ok: true, meal: null, travel: null })
    })
    const herPage = loadPage(TRAVEL_PAGE, wx, { role: 'her' })
    herPage.syncRole()
    herPage.setData({ place: { _id: P_ON, name: '承德避暑山庄' } })
    herPage.confirmPlace()
    await flush()
    assertEq(herPage.data.confirmedName, '承德避暑山庄')
    assertEq(herPage.data.isConfirmedCurrent, true)

    const himWx = makeWx({ 'lifePlanner:confirmDayChoice': () => ({ ok: true }) })
    const himPage = loadPage(TRAVEL_PAGE, himWx.wx, { role: 'him' })
    himPage.syncRole()
    himPage.setData({ place: { _id: P_ON, name: '承德避暑山庄' } })
    himPage.confirmPlace()
    await flush()
    assertEq(himWx.calls.filter(c => c.data && c.data.action === 'confirmDayChoice').length, 0)
    assertEq(calls.length > 0, true)
  })

  // C8–C10：共同待办 UI 已从「我们」页迁到「记录」页，断言随之搬过去
  function recordPageWith(routes, opts) {
    const { wx, calls, modals } = makeWx(routes, opts)
    const page = loadPage(RECORD_PAGE, wx, { role: 'her' })
    // 记录页只在 owner / companion 两个视图模式下取共同待办
    page.setData({ viewMode: 'owner', date: TODAY, todayStr: TODAY, todoScope: 'day' })
    return { page, wx, calls, modals }
  }

  await taskSafe('C8 记录页：共同待办默认折叠 5 条，展开后显示全部', async () => {
    const items = []
    for (let i = 1; i <= 7; i++) items.push({ _id: 't' + i, text: '第' + i + '条', done: false, createdAt: i, doneAt: 0, createdDate: TODAY, doneDate: '' })
    const { page } = recordPageWith({ 'getPartnerView:coupleTodo': () => ({ ok: true, items }) })
    page.loadTodos()
    await flush()
    assertEq(page.data.todoState, 'ready')
    assertEq(page.data.todoTotal, 7)
    assertEq(page.data.shownTodos.length, 5, '默认只显示 5 条')
    assertEq(page.data.todoHasMore, true)
    page.toggleSharedExpand()
    assertEq(page.data.shownTodos.length, 7, '展开后显示全部')
    page.toggleSharedExpand()
    assertEq(page.data.shownTodos.length, 5, '收起后回到 5 条')
  })

  await taskSafe('C9 记录页：读取失败显示「读不到」，不显示成「还没有一起要做的事」', async () => {
    const { page } = recordPageWith({ 'getPartnerView:coupleTodo': 'reject' })
    page.loadTodos()
    await flush()
    assertEq(page.data.todoState, 'error')
    assertEq(page.data.todoTotal, 0)
    assertEq(page.data.shownTodos.length, 0)
  })

  await taskSafe('C10 记录页：添加 → 发送 op=add 并清空输入；删除 → 先确认再调用', async () => {
    let added = 0
    const { page, calls, modals } = recordPageWith({
      'getPartnerView:coupleTodo': (data) => {
        if (data.op === 'add') { added++; return { ok: true, item: { _id: 'new', text: data.text, done: false } } }
        if (data.op === 'remove') return { ok: true, id: data.id, removed: 1 }
        return { ok: true, items: [] }
      }
    }, { autoConfirm: true })
    page.setData({ todoState: 'ready' })
    page.setData({ todoInput: '  一起去看电影  ' })
    page.addSharedTodo()
    await flush()
    await flush()
    const addCall = calls.filter(c => c.data && c.data.op === 'add')[0]
    assertEq(addCall.data.text, '一起去看电影', '发送前必须去空白')
    assertEq(page.data.todoInput, '', '成功后清空输入框')
    assertEq(added, 1)
    // 删除必须先弹确认
    page.setData({ todoItems: [{ _id: 't1', text: '要删的', done: false, createdDate: TODAY }] })
    page.removeSharedTodo({ currentTarget: { dataset: { id: 't1', text: '要删的' } } })
    await flush()
    assertEq(modals.length, 1, '删除前必须有轻量确认')
    assertEq(calls.filter(c => c.data && c.data.op === 'remove').length, 1, '确认后才真正删除')
  })

  // ============================================================
  console.log('\n-- D. 静态结构（L1）与回归 --')
  // ============================================================

  await taskSafe('D1 首页两张卡片在 her / him 分支都存在，且未确认文案统一', () => {
    const wxml = read('pages/home/home.wxml')
    assertEq((wxml.match(/class="block note-yellow fade-in day-choice tap"/g) || []).length, 2, '吃什么卡片两处')
    assertEq((wxml.match(/class="block note-blue fade-in day-choice tap"/g) || []).length, 2, '去哪里卡片两处')
    // 只数数据绑定里的文案（注释里也提到同一句话，不能混算）
    assertEq((wxml.match(/\? '读取中…' : '今天还没决定'/g) || []).length, 4, '两张卡片 × 两处分支')
    assertOk(wxml.includes('暂时读不到'), '读失败必须有明确提示，不得伪装成未决定')
    // 未确认文案不能出现在 error 分支
    const errBlock = wxml.split("wx:elif=\"{{dayChoiceState === 'error'}}\"")[1] || ''
    assertNo(errBlock.slice(0, 200).indexOf('今天还没决定') !== -1, 'error 分支不得出现「今天还没决定」')
  })

  await taskSafe('D2 推荐页的确认入口受 isHer 保护，且服务端鉴权不依赖前端', () => {
    const food = read('pages/food/food.wxml')
    const travel = read('pages/travel/travel.wxml')
    assertOk(food.includes('wx:if="{{isHer}}"'), '吃什么页确认区必须受 isHer 保护')
    assertOk(travel.includes('wx:if="{{isHer}}"'), '去哪里页确认区必须受 isHer 保护')
    assertOk(food.includes('bindtap="confirmMeal"'), '缺「就吃这个」入口')
    assertOk(travel.includes('bindtap="confirmPlace"'), '缺「就去这里」入口')
    assertOk(food.includes('就吃这个') && travel.includes('就去这里'), '按钮文案缺失')
    const fn = read('cloudfunctions/lifePlanner/index.js')
    assertOk(fn.includes("code: 'FORBIDDEN'"), '服务端必须有角色闸门')
  })

  await taskSafe('D3 旅行详情页的「编辑计划」没有被当成今日确认（两条链路不混）', () => {
    const detail = read('pages/travel-detail/travel-detail.js')
    assertNo(detail.indexOf('confirmDayChoice') !== -1, '旅行详情不得写今日决定')
    const travel = read('pages/travel/travel.js')
    assertOk(travel.includes("kind: 'travel'"), '今日地点的确认必须走 day_choices')
    assertNo(travel.indexOf('saveTravelPlace') !== -1, '今日确认不得写入旅行计划')
  })

  await taskSafe('D4 记录页的区域与文案齐全（空态 / 折叠 / 删除确认），我们页已不再展示', () => {
    const wxml = read('pages/record/record.wxml')
    for (const t of ['一起做的事', '暂时读不到', '{{todoEmptyText}}', 'bindtap="addSharedTodo"', 'bindtap="toggleSharedTodo"', 'bindtap="removeSharedTodo"', 'bindtap="toggleSharedExpand"']) {
      assertOk(wxml.includes(t), '记录页缺：' + t)
    }
    const js = read('pages/record/record.js')
    // 空态文案由 JS 给（不能写死在 WXML：要区分「这一天」和「待完成」两种口径）
    assertOk(js.includes('还没有一起要做的事'), '缺「这一天还没有一起要做的事」文案')
    assertOk(js.includes('没有待完成的事'), '缺「待完成」视图的空态文案')
    // 四个 op 必须都在，且统一走 utils/partner-view 的 requestCoupleTodo 入口
    for (const op of ['list', 'add', 'toggle', 'remove']) {
      assertOk(js.includes("requestCoupleTodo('" + op + "'"), '缺 op: ' + op)
    }
    assertOk(js.includes('wx.showModal'), '删除必须有确认')
    assertOk(js.indexOf("name: 'getPartnerView'") === -1, '记录页不得绕过统一入口直接调云函数')
    // 迁移后不得两处各留一份（否则会出现两份互相打架的 UI）
    assertNo(read('pages/ours/ours.wxml').includes('一起做的事'), '我们页仍在渲染共同待办')
    assertNo(read('pages/ours/ours.js').includes('coupleTodo'), '我们页仍在请求共同待办')
  })

  await taskSafe('D5 回归：推荐 / 编辑 / 心愿 / 悄悄话链路未被破坏', async () => {
    const db = new MockDB(seed())
    const lp = loadLp(db)
    OPENID = HER
    const random = await lp.main({ action: 'randomMeal' })
    assertEq(random.ok, true, '随机推荐仍然可用')
    assertOk(random.meal.meat && random.meal.vegetable && random.meal.soup)
    const list = await lp.main({ action: 'listRecipes' })
    assertEq(list.ok, true)
    const travel = await lp.main({ action: 'randomTravel', type: 'outside' })
    assertEq(travel.ok, true)
    const place = await lp.main({ action: 'getTravelPlace', placeId: P_ON })
    assertEq(place.ok, true)
    const gpv = loadGpv(db)
    const view = await gpv.main({ action: 'view' })
    assertEq(view.ok, true, 'getPartnerView 默认 view 仍然正常')
    assertEq(Array.isArray(view.messages), true)
    OPENID = HIM
    const mark = await gpv.main({ action: 'mark', wishId: 'none' })
    assertEq(mark.ok, false, '心愿标记链路仍在（不存在的心愿被拒）')
  })

  await taskSafe('D6 回归：纪念日天数改用北京时间（发送端与读取端同源）', async () => {
    const gpvMod = loadGpv(new MockDB(seed()))
    assertEq(typeof gpvMod.beijingToday, 'function', '必须导出 beijingToday 供核对')
    const bj = gpvMod.beijingToday(new Date('2026-10-25T16:00:00Z'))
    assertEq(bj, '2026-10-26', 'UTC 16:00 必须算作北京时间次日')
    assertEq(gpvMod.daysTogether('2026-10-20', '2026-10-26'), 7)
    // 云函数源码里不得再有「用服务器本地时间当今天」的取值
    const src = read('cloudfunctions/getPartnerView/index.js')
    assertEq((src.match(/fmt\(new Date\(\)\)/g) || []).length, 1, '只允许出现在注释里')
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failures.length) {
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
  console.log('V1.1 Day Choice + Couple Todo: ALL GREEN')
}

// 小工具：与 testCase 等价（历史命名习惯），保持用例列表可读
function taskSafe(name, fn) { return testCase(name, fn) }

main().catch(e => { console.error(e); process.exit(1) })
