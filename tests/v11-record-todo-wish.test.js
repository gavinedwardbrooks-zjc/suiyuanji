// ============================================================
// tests/v11-record-todo-wish.test.js · 记录页日期体验调整（V1.1）
//
// 本轮两个改动：
//   B. 共同待办从「我们」页迁到「记录」页，并按「创建日期（北京时间）」归组
//   C. 「这天的愿望」严格按创建日期展示，不再每天重复显示历史心愿
//
// 证据分档（不得互相冒充）：
//   [L1] 代码结构存在        —— 静态源码 / WXML 断言
//   [L2] 本地模拟请求成功    —— **真实云函数代码** + 内存云数据库 + **真实页面代码** + 假 wx
//   [L3] 微信云环境真实请求  —— 未覆盖（云函数未上传）
//   [L4] 开发者工具实际渲染  —— 未覆盖
//
// 运行：node tests/v11-record-todo-wish.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const fs = require('fs')
const { MockDB } = require('./mock-db')

const ROOT = path.resolve(__dirname, '..')
const GPV_PATH = path.join(ROOT, 'cloudfunctions/getPartnerView/index.js')
const RECORD_PAGE = path.join(ROOT, 'pages/record/record.js')
const OURS_PAGE = path.join(ROOT, 'pages/ours/ours.js')

const HER = 'openid_her_A'
const HIM = 'openid_him_B'
const HER2 = 'openid_her_C'
const HIM2 = 'openid_him_D'

let OPENID = HER
let passed = 0, failed = 0
const failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed++; console.log('  PASS  ' + name) })
    .catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message) })
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a))
}
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8') }
const flush = () => new Promise(r => setTimeout(r, 0))

// 北京时间 → 绝对时间戳（毫秒）。测试里所有「某天某点」都用它，
// 避免依赖跑测试机器的本地时区。
function bjTime(y, mo, d, h, mi) {
  return Date.UTC(y, mo - 1, d, (h || 0) - 8, mi || 0, 0, 0)
}

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
const loadGpv = (db) => loadFn(GPV_PATH, db)

function seed(opts) {
  const o = opts || {}
  return {
    users: [
      { _id: 'u_her', _openid: HER, role: 'her', coupleId: 'CZ-1', partnerName: '' },
      { _id: 'u_him', _openid: HIM, role: 'him', coupleId: 'CZ-1', partnerName: '' },
      { _id: 'u_her2', _openid: HER2, role: 'her', coupleId: 'CZ-2', partnerName: '' },
      { _id: 'u_him2', _openid: HIM2, role: 'him', coupleId: 'CZ-2', partnerName: '' }
    ],
    couples: [
      { _id: 'c1', coupleId: 'CZ-1', herOpenid: HER, himOpenid: HIM, status: o.status || 'active', anniversary: null },
      { _id: 'c2', coupleId: 'CZ-2', herOpenid: HER2, himOpenid: HIM2, status: 'active', anniversary: null }
    ],
    daily_records: o.daily_records || [],
    wishes: o.wishes || [],
    couple_todos: o.couple_todos || [],
    messages: [],
    menstrual: [],
    record_shares: o.record_shares || [],
    recipes: [],
    travel_places: []
  }
}

function wish(id, text, createdAt, opts) {
  const o = opts || {}
  return {
    _id: id.owner + '_' + id.seq,
    _openid: id.owner,
    coupleId: o.coupleId === undefined ? 'CZ-1' : o.coupleId,
    type: o.type || 'eat',
    text,
    status: o.status || 'pending',
    createdAt,
    arrangedAt: o.arrangedAt || null
  }
}

function todo(id, text, createdAt, opts) {
  const o = opts || {}
  return {
    _id: id,
    coupleId: o.coupleId || 'CZ-1',
    text,
    done: o.done === true,
    doneAt: o.doneAt || 0,
    createdAt,
    updatedAt: createdAt
  }
}

// ============================================================
// 页面 harness（真实页面代码 + 假 wx）
// ============================================================
function makeWx(routes, opts) {
  const o = opts || {}
  const calls = []
  const toasts = []
  const modals = []
  return {
    calls, toasts, modals,
    wx: {
      cloud: {
        callFunction: (payload) => {
          calls.push(payload)
          const name = payload && payload.name
          const action = (payload && payload.data && payload.data.action) || 'view'
          const op = payload && payload.data && payload.data.op
          const h = (routes || {})[name + ':' + action + ':' + op] ||
            (routes || {})[name + ':' + action] || (routes || {})[action]
          if (!h) return Promise.resolve({ result: { ok: true } })
          if (h === 'reject') return Promise.reject(new Error('offline'))
          return Promise.resolve(h(payload.data || {}, payload)).then(r => ({ result: r }))
        }
      },
      getStorageSync: () => '',
      setStorageSync: () => {},
      removeStorageSync: () => {},
      showToast: (m) => { toasts.push(m && m.title) },
      showModal: (m) => { modals.push(m); if (o.autoConfirm && typeof m.success === 'function') m.success({ confirm: true }) },
      switchTab: () => {},
      navigateTo: () => {}
    }
  }
}

function loadPage(pagePath, wx, globalData) {
  global.getApp = () => ({
    globalData: Object.assign({ openid: HER, role: 'her', coupleId: 'CZ-1', partnerName: '' }, globalData || {}),
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

// 记录页：直接把视图模式与日期钉死，只测共同待办这一段逻辑
function recordPage(routes, opts) {
  const env = makeWx(routes, opts)
  const page = loadPage(RECORD_PAGE, env.wx)
  const dates = (opts && opts.dates) || {}
  page.setData({
    viewMode: (opts && opts.viewMode) || 'owner',
    date: dates.date || '2026-10-26',
    todayStr: dates.today || '2026-10-26',
    todoScope: 'day'
  })
  return { page, wx: env.wx, calls: env.calls, toasts: env.toasts, modals: env.modals }
}

async function main() {
  console.log('\n=== V1.1 记录页日期体验（共同待办迁移 + 这天的愿望） ===\n')

  const TODAY_BJ = '2026-10-26'
  const YDAY_BJ = '2026-10-25'

  // ============================================================
  console.log('-- A. 共同待办：服务端行为 --')
  // ============================================================

  await testCase('[L2] A1 her 添加、him 读取（同一份数据，双方权限相同）', async () => {
    const db = new MockDB(seed())
    const gpv = loadGpv(db)
    OPENID = HER
    const add = await gpv.main({ action: 'coupleTodo', op: 'add', text: '周末一起逛超市' })
    assertEq(add.ok, true, 'her 添加应成功')
    OPENID = HIM
    const list = await gpv.main({ action: 'coupleTodo', op: 'list' })
    assertEq(list.ok, true)
    assertEq(list.items.length, 1, 'him 应看到 her 刚加的那条')
    assertEq(list.items[0].text, '周末一起逛超市')
    assertEq(list.items[0].done, false)
  })

  await testCase('[L2] A2 him 添加、her 读取', async () => {
    const db = new MockDB(seed())
    const gpv = loadGpv(db)
    OPENID = HIM
    const add = await gpv.main({ action: 'coupleTodo', op: 'add', text: '订电影票' })
    assertEq(add.ok, true, 'him 添加应成功')
    assertEq(db.dump().couple_todos[0].createdByRole, 'him', '创建者由服务端按身份写')
    OPENID = HER
    const list = await gpv.main({ action: 'coupleTodo', op: 'list' })
    assertEq(list.items.map(i => i.text).join(','), '订电影票')
  })

  await testCase('[L2] A3 创建日期与完成日期由服务端按北京时间给出', async () => {
    // 北京时间 2026-10-26 00:10 = UTC 2026-10-25 16:10（跨零点前后最容易错）
    const createdAt = bjTime(2026, 10, 26, 0, 10)
    const doneAt = bjTime(2026, 10, 26, 23, 50)
    const db = new MockDB(seed({ couple_todos: [todo('t1', '整理行李', createdAt, { done: true, doneAt })] }))
    const gpv = loadGpv(db)
    OPENID = HER
    const list = await gpv.main({ action: 'coupleTodo', op: 'list' })
    const t = list.items[0]
    assertEq(t.createdDate, '2026-10-26', '创建日必须是北京时间那一天')
    assertEq(t.doneDate, '2026-10-26', '完成日必须是北京时间那一天')
    assertEq(t.createdAt, createdAt, '原始时间戳保留（前端不重算）')
  })

  await testCase('[L2] A4 完成 / 恢复：doneAt 跟着变，恢复后清 0', async () => {
    const createdAt = bjTime(2026, 10, 25, 9, 0)
    const db = new MockDB(seed({ couple_todos: [todo('t1', '买生活用品', createdAt)] }))
    const gpv = loadGpv(db)
    OPENID = HIM
    const done = await gpv.main({ action: 'coupleTodo', op: 'toggle', id: 't1', done: true })
    assertEq(done.ok, true)
    assertOk(done.doneAt > 0, '完成时必须写完成时间')
    let row = db.dump().couple_todos[0]
    assertEq(row.done, true)
    assertOk(row.doneAt > 0)
    // 恢复未完成
    const undo = await gpv.main({ action: 'coupleTodo', op: 'toggle', id: 't1', done: false })
    assertEq(undo.ok, true)
    row = db.dump().couple_todos[0]
    assertEq(row.done, false)
    assertEq(row.doneAt, 0, '恢复未完成必须把 doneAt 清零')
  })

  await testCase('[L2] A5 删除：真删且不留残影；删别人的返回 NOT_FOUND 且不删', async () => {
    const createdAt = bjTime(2026, 10, 26, 10, 0)
    const db = new MockDB(seed({ couple_todos: [todo('t1', '要删的', createdAt)] }))
    const gpv = loadGpv(db)
    OPENID = HER
    const rm = await gpv.main({ action: 'coupleTodo', op: 'remove', id: 't1' })
    assertEq(rm.ok, true)
    assertEq(db.dump().couple_todos.length, 0, '删除后集合里不能剩')
    const again = await gpv.main({ action: 'coupleTodo', op: 'remove', id: 't1' })
    assertEq(again.code, 'NOT_FOUND', '重复删除返回 NOT_FOUND')
  })

  await testCase('[L2] A6 换绑 / 跨情侣隔离：新关系读不到旧关系的共同待办', async () => {
    const createdAt = bjTime(2026, 10, 26, 10, 0)
    const db = new MockDB(seed({ couple_todos: [todo('t1', '旧关系的事', createdAt)] }))
    const gpv = loadGpv(db)
    OPENID = HER2 // CZ-2
    const list = await gpv.main({ action: 'coupleTodo', op: 'list' })
    assertEq(list.ok, true)
    assertEq(list.items.length, 0, '另一段关系不得看到 CZ-1 的待办')
    const rm = await gpv.main({ action: 'coupleTodo', op: 'remove', id: 't1' })
    assertEq(rm.code, 'NOT_FOUND', '跨情侣删除必须被拒')
    assertEq(db.dump().couple_todos.length, 1, '别人的待办不能被删掉')
  })

  await testCase('[L2] A7 非 active 关系：一律 NOT_ACTIVE，零写入', async () => {
    const db = new MockDB(seed({ status: 'superseded' }))
    const gpv = loadGpv(db)
    OPENID = HER
    for (const op of ['list', 'add', 'toggle', 'remove']) {
      const r = await gpv.main({ action: 'coupleTodo', op, text: 'x', id: 't1', done: true })
      assertEq(r.ok, false, op + ' 在非 active 关系下必须失败')
      assertEq(r.code, 'NOT_ACTIVE', op + ' 应返回 NOT_ACTIVE')
    }
    assertEq((db.dump().couple_todos || []).length, 0, '失败路径不得有任何写入')
  })

  await testCase('[L2] A8 数据边界：共同待办不写 daily_records.todos，也不改日记文档', async () => {
    const rec = { _id: 'r1', _openid: HER, date: TODAY_BJ, coupleId: 'CZ-1', todos: [{ text: '个人小事', done: false }], revision: 1 }
    const db = new MockDB(seed({ daily_records: [rec] }))
    const gpv = loadGpv(db)
    OPENID = HER
    await gpv.main({ action: 'coupleTodo', op: 'add', text: '一起订票' })
    const after = db.dump().daily_records[0]
    assertEq(JSON.stringify(after), JSON.stringify(rec), 'daily_records 必须一字节未动')
    assertEq(db.dump().couple_todos.length, 1, '只应写 couple_todos')
  })

  // ============================================================
  console.log('\n-- B. 这天的愿望：服务端按创建日期筛选 --')
  // ============================================================

  const wY = wish({ owner: HER, seq: 'y' }, '昨天想吃火锅', bjTime(2026, 10, 25, 12, 0))
  const wT = wish({ owner: HER, seq: 't' }, '今天想吃烤肉', bjTime(2026, 10, 26, 9, 0))
  const wNight = wish({ owner: HER, seq: 'n' }, '零点后写下的愿望', bjTime(2026, 10, 26, 0, 30))

  await testCase('[L2] B1 昨天创建的心愿不出现在今天', async () => {
    const db = new MockDB(seed({ wishes: [wY, wT] }))
    const gpv = loadGpv(db)
    OPENID = HIM
    const v = await gpv.main({ action: 'view', date: TODAY_BJ })
    assertEq(v.ok, true)
    assertEq(v.dayWishes.map(w => w.text).join(','), '今天想吃烤肉', '今天只看今天创建的')
    // 完整心愿列表仍然照旧（心愿管理要用），只是不再冒充「这天的」
    assertEq(v.wishes.length, 2, '总列表不受日期筛选影响')
  })

  await testCase('[L2] B2 切到历史日期，展示那一天真正创建的心愿', async () => {
    const db = new MockDB(seed({ wishes: [wY, wT] }))
    const gpv = loadGpv(db)
    OPENID = HIM
    const v = await gpv.main({ action: 'view', date: YDAY_BJ })
    assertEq(v.dayWishes.map(w => w.text).join(','), '昨天想吃火锅')
  })

  await testCase('[L2] B3 那天没有心愿 → dayWishes 为空数组（前端据此显示空态）', async () => {
    const db = new MockDB(seed({ wishes: [wT] }))
    const gpv = loadGpv(db)
    OPENID = HIM
    const v = await gpv.main({ action: 'view', date: '2026-10-01' })
    assertEq(Array.isArray(v.dayWishes), true, '必须是数组，不能是 null/undefined')
    assertEq(v.dayWishes.length, 0)
  })

  await testCase('[L2] B4 跨北京时间零点：00:30 属于当天，23:30 属于前一天', async () => {
    const wLate = wish({ owner: HER, seq: 'l' }, '昨晚十一点半', bjTime(2026, 10, 25, 23, 30))
    const db = new MockDB(seed({ wishes: [wLate, wNight] }))
    const gpv = loadGpv(db)
    OPENID = HIM
    const t = await gpv.main({ action: 'view', date: '2026-10-26' })
    assertEq(t.dayWishes.map(w => w.text).join(','), '零点后写下的愿望', '00:30 必须算 10-26')
    const y = await gpv.main({ action: 'view', date: '2026-10-25' })
    assertEq(y.dayWishes.map(w => w.text).join(','), '昨晚十一点半', '23:30 必须算 10-25')
  })

  await testCase('[L2] B5 心愿状态变为「已安排」不改变它的创建日', async () => {
    const arrangedAt = bjTime(2026, 10, 26, 18, 0)
    const w = wish({ owner: HER, seq: 'd' }, '昨天想做蛋糕', bjTime(2026, 10, 25, 20, 0), { status: 'done_by_partner', arrangedAt })
    const db = new MockDB(seed({ wishes: [w] }))
    const gpv = loadGpv(db)
    OPENID = HIM
    const y = await gpv.main({ action: 'view', date: '2026-10-25' })
    assertEq(y.dayWishes.map(x => x.text).join(','), '昨天想做蛋糕', '状态变了但创建日不变')
    const t = await gpv.main({ action: 'view', date: '2026-10-26' })
    assertEq(t.dayWishes.length, 0, '不能因为「今天被安排」就把它挪到今天')
  })

  await testCase('[L2] B6 归属隔离不因日期筛选放宽：上一段关系 / 无标记的心愿都不进 dayWishes', async () => {
      const other = wish({ owner: HER, seq: 'o' }, '旧关系的心愿', bjTime(2026, 10, 26, 8, 0), { coupleId: 'CZ-OLD' })
      const legacy = wish({ owner: HER, seq: 'g' }, '没有关系标记的老数据', bjTime(2026, 10, 26, 8, 30), { coupleId: null })
      const mine = wish({ owner: HER, seq: 'm' }, '这段关系的心愿', bjTime(2026, 10, 26, 9, 30))
      const db = new MockDB(seed({ wishes: [other, legacy, mine] }))
      const gpv = loadGpv(db)
      OPENID = HIM
      const v = await gpv.main({ action: 'view', date: '2026-10-26' })
      assertEq(v.dayWishes.map(w => w.text).join(','), '这段关系的心愿', '只允许当前关系的心愿')
    })

    await testCase('[L2] B7 她自己的视角不额外拿一份 dayWishes（少了也拿不到别人的）', async () => {
      const db = new MockDB(seed({ wishes: [wT] }))
      const gpv = loadGpv(db)
      OPENID = HER
      const v = await gpv.main({ action: 'view', date: '2026-10-26' })
      assertEq(v.dayWishes.length, 0, 'her 侧不计算 dayWishes（她的记录页用当天快照）')
      assertEq(v.wishes.length, 1, '她自己的心愿列表照常')
    })

    await testCase('[L2] B8 him 不得读取未分享的私人日记（迁入待办不改变这条红线）', async () => {
      const rec = {
        _id: 'r1', _openid: HER, date: TODAY_BJ, coupleId: 'CZ-1', revision: 1,
        mood: { type: 'happy', weather: 'sunny' },
        segments: { life: '生活正文', work: '工作正文', growth: '成长正文' },
        score: 5, herSummary: '她的私密小结'
      }
      const db = new MockDB(seed({ daily_records: [rec] }))
      const gpv = loadGpv(db)
      OPENID = HIM
      const v = await gpv.main({ action: 'view', date: TODAY_BJ })
      assertEq(v.ok, true)
      assertEq(v.shared, null, '没分享就是 null，不是空对象')
      const json = JSON.stringify(v)
      for (const bad of ['生活正文', '工作正文', '成长正文', '她的私密小结', 'herSummary']) {
        assertOk(json.indexOf(bad) === -1, '响应里泄漏了私密内容：' + bad)
      }
      assertOk(!Object.prototype.hasOwnProperty.call(v, 'segments'), '响应体不得有 segments 字段')
    })

    // ============================================================
    console.log('\n-- C. 记录页客户端：日期视图与失败态 --')
    // ============================================================

    const mkItem = (id, text, createdDate, opts) => {
      const o = opts || {}
      return {
        _id: id, text, done: o.done === true,
        createdAt: 1, doneAt: o.done ? 2 : 0,
        createdDate, doneDate: o.doneDate || ''
      }
    }

    await testCase('[L2] C1 「这一天」视图只显示当天创建的（昨天的不混进来）', async () => {
      const items = [
        mkItem('t1', '今天的事', TODAY_BJ),
        mkItem('t2', '昨天的事', YDAY_BJ)
      ]
      const { page } = recordPage({ 'getPartnerView:coupleTodo': () => ({ ok: true, items }) })
      page.loadTodos()
      await flush()
      assertEq(page.data.todoState, 'ready')
      assertEq(page.data.todoTotal, 1, '只算当天的')
      assertEq(page.data.shownTodos[0].text, '今天的事')
      assertEq(page.data.todoHeadLabel, '今天 · 1 件')
    })

    await testCase('[L2] C2 「待完成」视图跨日期汇总未完成（旧的不会被日期过滤掉）', async () => {
      const items = [
        mkItem('t1', '今天的事', TODAY_BJ),
        mkItem('t2', '上周没做完的事', '2026-10-19')
      ]
      const { page } = recordPage({ 'getPartnerView:coupleTodo': () => ({ ok: true, items }) })
      page.loadTodos()
      await flush()
      page.switchTodoScope({ currentTarget: { dataset: { scope: 'open' } } })
      assertEq(page.data.todoScope, 'open')
      assertEq(page.data.todoTotal, 2, '跨日期未完成都要在')
      assertEq(page.data.todoHeadLabel, '待完成 2 件')
      // 回到这一天
      page.switchTodoScope({ currentTarget: { dataset: { scope: 'day' } } })
      assertEq(page.data.todoTotal, 1)
    })

    await testCase('[L2] C3 已完成的不进「待完成」；完成日期显示在条目里', async () => {
      const items = [
        mkItem('t1', '已经做完的', TODAY_BJ, { done: true, doneDate: TODAY_BJ }),
        mkItem('t2', '还没做的', TODAY_BJ)
      ]
      const { page } = recordPage({ 'getPartnerView:coupleTodo': () => ({ ok: true, items }) })
      page.loadTodos()
      await flush()
      // 「这一天」视图两条都显示（完成的带完成日期）
      assertEq(page.data.todoTotal, 2)
      const done = page.data.shownTodos.filter(t => t.done)[0]
      assertEq(done.meta, '10-26 加的 · 10-26 完成', '完成日期必须显示出来')
      const undone = page.data.shownTodos.filter(t => !t.done)[0]
      assertEq(undone.meta, '10-26 加的', '未完成不显示完成日期')
      // 「待完成」只留未完成
      page.switchTodoScope({ currentTarget: { dataset: { scope: 'open' } } })
      assertEq(page.data.todoTotal, 1)
      assertEq(page.data.shownTodos[0].text, '还没做的')
    })

    await testCase('[L2] C4 看历史日期时说清「新增会记在今天」，添加后也明确提示', async () => {
      const { page, calls, toasts } = recordPage({
        'getPartnerView:coupleTodo': (data) => {
          if (data.op === 'add') return { ok: true, item: { _id: 'new', text: data.text } }
          return { ok: true, items: [] }
        }
      }, { dates: { date: YDAY_BJ, today: TODAY_BJ } })
      page.loadTodos()
      await flush()
      assertOk(page.data.todoDayHint.indexOf('不会写进这一天') !== -1, '历史日期必须给出归属提示：' + page.data.todoDayHint)
      page.setData({ todoInput: '看电影' })
      page.addSharedTodo()
      await flush()
      await flush()
      // 服务端只按「此刻」落库：客户端绝不能自己补一个日期字段
      const addCall = calls.filter(c => c.data && c.data.op === 'add')[0]
      assertEq(addCall.data.text, '看电影')
      assertOk(!('date' in addCall.data), '添加时不得带客户端日期（服务端说了算）')
      assertOk(toasts.some(t => t && t.indexOf('已记在今天') !== -1), '必须当场说明记到了今天：' + toasts.join('|'))
    })

    await testCase('[L2] C5 读取失败 → error，不显示成「这一天还没有一起要做的事」', async () => {
      const { page } = recordPage({ 'getPartnerView:coupleTodo': 'reject' })
      page.loadTodos()
      await flush()
      assertEq(page.data.todoState, 'error')
      assertEq(page.data.todoTotal, 0)
      assertEq(page.data.shownTodos.length, 0)
    })

    await testCase('[L2] C6 关系失效 → blocked（与网络失败分开，卡片整块不渲染）', async () => {
      const { page } = recordPage({ 'getPartnerView:coupleTodo': () => ({ ok: false, code: 'NOT_ACTIVE' }) })
      page.loadTodos()
      await flush()
      assertEq(page.data.todoState, 'blocked')
      const wxml = read('pages/record/record.wxml')
      assertOk(wxml.indexOf("todoState !== 'blocked'") !== -1, 'blocked 时必须整块隐藏')
    })

    await testCase('[L2] C7 待办读写不影响个人记录：不调用 dailyRecord，也不碰草稿', async () => {
      const { page, calls } = recordPage({
        'getPartnerView:coupleTodo': () => ({ ok: true, items: [mkItem('t1', '一起散步', TODAY_BJ)] })
      })
      page.loadTodos()
      await flush()
      page.setData({ todoInput: '一起做饭' })
      page.addSharedTodo()
      await flush()
      const daily = calls.filter(c => c.name === 'dailyRecord')
      assertEq(daily.length, 0, '共同待办不得触碰 dailyRecord')
      assertEq(page.data.dirty, false, '添加共同待办不该把页面标成「有未保存的日记」')
    })

    // ============================================================
    console.log('\n-- D. 结构 / 迁移 / 回归（L1） --')
    // ============================================================

    await testCase('[L1] D1 「我们」页已无共同待办 UI 与请求，记录页两个分支都有', () => {
      const oursWxml = read('pages/ours/ours.wxml')
      const oursJs = read('pages/ours/ours.js')
      assertEq(oursWxml.indexOf('一起做的事'), -1, '我们页仍在渲染卡片')
      assertEq(oursJs.indexOf('coupleTodo'), -1, '我们页仍在请求共同待办')
      const rec = read('pages/record/record.wxml')
      assertEq((rec.match(/class="block note-green fade-in shared-todo"/g) || []).length, 2, '记录页两个分支各一份')
      assertOk(rec.indexOf('本周末') === -1 && rec.indexOf('最早') === -1, 'wxml 不应写死任何示例数据')
    })

    await testCase('[L1] D2 「这天的愿望」只绑 dayWishes，不再绑全量 wishes', () => {
      const rec = read('pages/record/record.wxml')
      assertOk(rec.indexOf('pvDayWishes') !== -1, '缺 pvDayWishes 绑定')
      const idx = rec.indexOf('这天的愿望')
      const seg = rec.slice(idx, idx + 900)
      assertEq(seg.indexOf('{{pvWishes'), -1, '「这天的愿望」不得再绑全量心愿列表')
      assertOk(seg.indexOf('这天还没有写下愿望') !== -1, '缺空态文案')
    })

    await testCase('[L1] D3 记录页「今天」用北京时间（与服务端 createdDate 同源）', () => {
      const js = read('pages/record/record.js')
      assertOk(js.indexOf('function beijingTodayStr(') !== -1, '缺 beijingTodayStr')
      assertOk(js.indexOf('date: beijingTodayStr(), todayStr: beijingTodayStr()') !== -1, 'onLoad 未用北京时间初始化')
      assertEq(js.indexOf('fmtDate(new Date())'), -1, '不得再有「用设备本地时间当今天」的取值')
    })

    await testCase('[L1] D4 记录页不直接调云函数（统一入口 requestCoupleTodo）', () => {
      const js = read('pages/record/record.js')
      assertEq(js.indexOf("name: 'getPartnerView'"), -1, '记录页出现直接调用')
      const pv = read('utils/partner-view.js')
      assertOk(pv.indexOf('function requestCoupleTodo(') !== -1, '缺 requestCoupleTodo 入口')
      assertOk(pv.indexOf('TODO_FIELDS') !== -1, '缺共同待办字段白名单')
    })

    await testCase('[L1] D5 云函数：dayWishes 走创建日区间查询，失败时退化为内存筛选', () => {
      const src = read('cloudfunctions/getPartnerView/index.js')
      assertOk(src.indexOf('function readDayWishes(') !== -1, '缺 readDayWishes')
      assertOk(src.indexOf('cmd.gte(range.start).and(cmd.lte(range.end))') !== -1, '缺创建日区间条件')
      assertOk(src.indexOf('[day-wishes-range-fail]') !== -1, '区间查询失败必须有告警与退化路径')
      assertOk(src.indexOf('isOnBeijingDay(w.createdAt, date)') !== -1, '退化时必须按同一日期口径筛')
    })

    await testCase('[L1] D6 云函数：createdDate/doneDate 只在 list 里补，不写库、不改协议字段', () => {
      const src = read('cloudfunctions/getPartnerView/index.js')
      assertOk(src.indexOf('createdDate: beijingDateOf(createdAt)') !== -1, '缺 createdDate')
      assertOk(src.indexOf('doneDate: beijingDateOf(doneAt)') !== -1, '缺 doneDate')
      // add / toggle 的返回也不得凭空造日期（避免与 list 口径不一致）
      assertEq(src.indexOf('createdDate: beijingDateOf(now)'), -1, 'add 返回不应自带日期计算')
    })

    console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
    if (failures.length) {
      console.log('\n失败项：')
      for (const f of failures) console.log('  - ' + f)
      process.exitCode = 1
    } else {
      console.log('V1.1 Record Date UX: ALL GREEN')
    }
}

main().catch(e => {
  console.error('测试脚本本身出错：', e)
  process.exitCode = 1
})
