// ============================================================
// tests/v11-deploy-boundary.test.js · 部署前文档与边界收尾（V1.1）
//
// 只守四件事，不测新功能（新功能在 v11-day-choice-todo.test.js）：
//   1. DEPLOYMENT.md 的云函数清单与实际目录一致（开源包 11 个）
//   2. 三个新增集合的建表 / 权限 / 索引口径齐全，且写明「不是云函数自动建表」
//   3. 共同待办「100 条上限」与「查看全部」文案一致（说得出才敢说全部）
//   4. 新写法的代码契约在本地能确认的部分（真云项不在本文件，见 DEPLOYMENT.md §8）
//
// 证据分档（不得互相冒充）：
//   [L1] 代码结构 / 文档口径存在 —— 静态断言
//   [L2] 本地模拟请求成功 —— 真实云函数代码 + 内存云数据库 + 真实页面代码 + 假 wx
//   [L3] 微信云环境真实请求 —— 未覆盖（云函数未上传）
//   [L4] 开发者工具实际渲染 —— 未覆盖
//
// 注：开源包不含桌面端与 V2.1 账号体系的云函数，因此函数总数是 11 而不是私有仓库的 16。
//
// 运行：node tests/v11-deploy-boundary.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const fs = require('fs')
const { MockDB } = require('./mock-db')

const ROOT = path.resolve(__dirname, '..')
const GPV_PATH = path.join(ROOT, 'cloudfunctions/getPartnerView/index.js')
// 共同待办 UI 已迁移到记录页（我们页不再展示），文案契约跟着搬过去
const RECORD_PAGE = path.join(ROOT, 'pages/record/record.js')
const RECORD_WXML = path.join(ROOT, 'pages/record/record.wxml')
const OURS_WXML = path.join(ROOT, 'pages/ours/ours.wxml')

const HER = 'openid_her_A'
const HIM = 'openid_him_B'
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
function assertNo(v, msg) { if (v) throw new Error(msg || '断言失败（期望不存在）') }
function read(p) { return fs.readFileSync(p, 'utf8') }

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

// ---------------- 页面 harness（真实页面代码 + 假 wx） ----------------
function loadPage(pagePath, wx) {
  global.getApp = () => ({
    globalData: { openid: HER, role: 'her', coupleId: 'CZ-1', bindCode: null, wishOpenOnEnter: false, partnerName: '' },
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

function seed(todos) {
  return {
    users: [
      { _id: 'u_her', _openid: HER, role: 'her', coupleId: 'CZ-1', schemaVersion: 2 },
      { _id: 'u_him', _openid: HIM, role: 'him', coupleId: 'CZ-1', schemaVersion: 2 }
    ],
    couples: [
      { _id: 'c1', coupleId: 'CZ-1', herOpenid: HER, himOpenid: HIM, status: 'active', anniversary: null }
    ],
    daily_records: [], messages: [], wishes: [], menstrual: [], recipes: [], travel_places: [],
    day_choices: [], couple_todos: todos || []
  }
}

async function main() {
  console.log('\n=== V1.1 部署前文档与边界 ===\n')

  const doc = read(path.join(ROOT, 'docs/DEPLOYMENT.md'))
  // 共同待办 UI 已迁到记录页：文案契约以记录页为准，我们页只用于「不得再有」的反向断言
  const recordJs = read(RECORD_PAGE)
  const recordWxml = read(RECORD_WXML)
  const oursWxml = read(OURS_WXML)

  // ============================================================
  // E1–E3 文档口径（[L1]）
  // ============================================================
  await testCase('[L1] E1 云函数数量口径统一：§4 写明 11 个，且 11 个都对得上真实目录', () => {
    assertNo(/9\s*个云函数/.test(doc), '文档仍存在「9 个云函数」')
    assertOk(/##\s*4\.\s*必需云函数部署/.test(doc), '§4 必需云函数部署缺失')
    assertOk(/共\s*11\s*个云函数/.test(doc), '§4 必须写明 11 个云函数')
    const list = 'login bindCouple dailyRecord getPartnerView menstrual aiSummary deleteAccount profileStats lifePlanner reminderCheck writing'.split(' ')
    assertEq(list.length, 11, '清单本身应为 11 个')
    for (const fn of list) {
      assertOk(doc.includes(fn), '文档缺函数 ' + fn)
      assertOk(fs.existsSync(path.join(ROOT, 'cloudfunctions', fn)), '仓库里没有云函数目录 ' + fn)
    }
  })

  await testCase('[L1] E2 三个新集合写清「手动预建」：先建集合后传函数，且点明 -502005', () => {
    assertOk(/##\s*2\.\s*必需数据库集合/.test(doc), '缺 §2 必需数据库集合')
    for (const col of ['record_shares', 'day_choices', 'couple_todos']) {
      assertOk(doc.includes(col), '文档缺集合 ' + col)
    }
    assertOk(/-502005/.test(doc), '必须说明集合不存在时的错误码')
    assertOk(/先建集合，再部署云函数/.test(doc), '必须写明「先建集合后传函数」的顺序')
    assertOk(/仅云函数可读写/.test(doc), '缺权限要求')
  })

  await testCase('[L1] E3 索引口径齐全：wishes 两条 + couple_todos，且写明 wishDate 判重规则', () => {
    assertOk(/\|\s*`wishes`\s*\|\s*`idx_openid_couple_created`/.test(doc), '缺 wishes 第一条索引')
    assertOk(/\|\s*`wishes`\s*\|\s*`idx_openid_couple_wishdate`/.test(doc), '缺 wishes 第二条（wishDate）索引')
    assertOk(/\|\s*`couple_todos`\s*\|\s*`idx_couple_created`/.test(doc), 'couple_todos 复合索引缺失')
    // wishDate 口径：写入口径 + 判重键 + 历史不迁移
    assertOk(/wishDate/.test(doc), '缺 wishDate 字段口径')
    assertOk(/只由 `dailyRecord\.save`/.test(doc), '必须写明 wishDate 的写入方')
    assertOk(/判重键\s*=\s*`_openid \+ coupleId \+ wishDate \+ type \+ text`/.test(doc), '判重键必须写明')
    assertOk(/不迁移、不补字段、不删除/.test(doc), '历史数据兼容策略必须写明')
  })

  await testCase('[L1] E4 真云验收项单列成节，且明确标注本地证明不了', () => {
    assertOk(/##\s*8\.\s*真云验收项/.test(doc), '缺 §8 真云验收项')
    const sec = doc.slice(doc.indexOf('## 8.'))
    for (const k of ['stats: { updated', 'stats: { removed', '自定义 `_id`', '复合索引', '直读直写']) {
      assertOk(sec.includes(k), '§8 缺待核项 ' + k)
    }
    assertOk(/不能证明 SDK 行为/.test(sec), '§8 必须写明本地不能证明 SDK 行为')
  })

  // ============================================================
  // E5–E6 100 条上限与文案（[L2]）
  // ============================================================
  await testCase('[L2] E5 服务端 137 条 → 只回 100 条 + truncated=true，且不删除任何历史数据', async () => {
    const many = []
    for (let i = 1; i <= 137; i++) {
      many.push({
        _id: 't' + i, coupleId: 'CZ-1', text: '事项' + i, done: false,
        createdAt: 1000 + i, updatedAt: 1000 + i, doneAt: 0
      })
    }
    const db = new MockDB(seed(many))
    const gpv = loadFn(GPV_PATH, db)
    OPENID = HER
    const r = await gpv.main({ action: 'coupleTodo', op: 'list' })
    assertOk(r.ok, 'list 应成功')
    assertEq(r.items.length, 100, '单次最多 100 条')
    assertEq(r.limit, 100, 'limit 应回传 100')
    assertEq(r.truncated, true, '被截断必须回传 truncated=true')
    assertEq(r.items[0].text, '事项137', '最新的一条在最前')
    assertEq(db.dump().couple_todos.length, 137, '读取不得删除历史待办')
  })

  await testCase('[L2] E6 客户端按 truncated 切换文案：截断只说「已显示」，不截断才说「查看全部 / N 件」', async () => {
    const DAY = '2026-10-26'
    const mk = (n) => Array.from({ length: n }, (_, i) => ({
      _id: 't' + (i + 1), text: '事项' + (i + 1), done: false,
      createdAt: 1000 + i, doneAt: 0,
      createdDate: DAY, doneDate: ''
    }))
    const wxStub = { cloud: { callFunction: () => Promise.resolve({ result: { ok: true } }) }, getStorageSync: () => '', setStorageSync: () => {}, removeStorageSync: () => {}, showToast: () => {}, showModal: () => {}, navigateTo: () => {}, switchTab: () => {} }
    const open = (n, cut) => {
      const p = loadPage(RECORD_PAGE, wxStub)
      // 记录页只有在 owner / companion 两个视图模式下才取数
      p.setData({ viewMode: 'owner', date: DAY, todayStr: DAY, todoScope: 'day' })
      p._applyTodos(mk(n), cut)
      return p
    }

    // 场景一：被服务端截断（取到 100 条，实际可能更多）
    const p1 = open(100, true)
    assertEq(p1.data.todoHeadLabel, '已显示 100 件', '截断时头部只能写「已显示」')
    assertEq(p1.data.todoMoreLabel, '展开这 100 条 ›', '截断时不得说「查看全部」')
    assertOk(/100/.test(p1.data.todoLimitHint), '截断提示应写明 100 条上限')

    // 场景二：没被截断（7 条）——这一天才敢给出确定的数量
    const p2 = open(7, false)
    assertEq(p2.data.todoHeadLabel, '今天 · 7 件', '未截断时给确定数量')
    assertEq(p2.data.todoMoreLabel, '查看全部 7 条 ›', '未截断才可以说「查看全部」')
    assertEq(p2.data.todoLimitHint, '', '未截断不该出现上限提示')

    // 场景三：展开/收起不得把截断结论丢掉
    const p3 = open(100, true)
    p3.toggleSharedExpand()
    assertEq(p3.data.todoTruncated, true, '展开后仍应保持截断标记')
    assertEq(p3.data.shownTodos.length, 100, '展开后显示已取到的 100 条')
    p3.toggleSharedExpand()
    assertEq(p3.data.shownTodos.length, 5, '收起回到 5 条')
    assertEq(p3.data.todoTruncated, true, '收起后仍应保持截断标记')
  })

  await testCase('[L1] E7 客户端上限常量与服务端 TODO_LIMIT 一致（防文案说谎）', () => {
    const ctl = require(path.join(ROOT, 'cloudfunctions/getPartnerView/couple-todo.js'))
    const m = /const TODO_LIMIT_CLIENT = (\d+)/.exec(recordJs)
    assertOk(m, '客户端缺 TODO_LIMIT_CLIENT')
    assertEq(Number(m[1]), ctl.TODO_LIMIT, '客户端与服务端的待办上限必须一致')
  })

  await testCase('[L1] E8 WXML 没有硬编码「查看全部 N 条」，改用服务端结论驱动', () => {
    assertNo(/查看全部 \{\{todoTotal\}\} 条/.test(recordWxml), 'WXML 仍硬编码「查看全部 N 条」')
    assertOk(recordWxml.includes('todoMoreLabel'), '更多按钮应由 todoMoreLabel 驱动')
    assertOk(recordWxml.includes('{{todoHeadLabel}}'), '头部计数应由 todoHeadLabel 驱动')
    assertOk(/wx:if="\{\{todoTruncated\}\}"/.test(recordWxml), '缺截断提示的条件渲染')
    // 迁移后我们页不得再出现这套卡片（防止两处各写一份）
    assertNo(/一起做的事/.test(oursWxml), '我们页仍在渲染共同待办卡片')
  })

  // ============================================================
  // E9 写操作契约（[L1] 静态 + [L2] 行为，真云项见文档 §9）
  // ============================================================
  await testCase('[L1] E9 单条操作必须 where({_id, coupleId}) 双条件，且按 stats 判断结果', () => {
    const gpv = read(GPV_PATH)
    const toggleIdx = gpv.indexOf("if (op === 'toggle')")
    const removeIdx = gpv.indexOf("if (op === 'remove')")
    assertOk(toggleIdx > 0 && removeIdx > toggleIdx, '缺 toggle / remove 分支')
    const toggle = gpv.slice(toggleIdx, removeIdx)
    const remove = gpv.slice(removeIdx, gpv.indexOf("return { ok: false, code: 'BAD_ARGS', msg: '未知操作"))
    assertOk(/where\(\{ _id: id, coupleId: couple\.coupleId \}\)\.update/.test(toggle), 'toggle 必须双条件 where')
    assertOk(/where\(\{ _id: id, coupleId: couple\.coupleId \}\)\.remove/.test(remove), 'remove 必须双条件 where')
    assertOk(/stats\.updated/.test(toggle), 'toggle 必须按 stats.updated 判定')
    assertOk(/stats\.removed/.test(remove), 'remove 必须按 stats.removed 判定')
    assertNo(/doc\(id\)\.update/.test(gpv) || /doc\(event\.id\)/.test(gpv), '不得用 doc(id) 单条件改单条')
  })

  await testCase('[L2] E10 双条件 where 真的挡得住跨情侣：改 / 删都返回 NOT_FOUND 且数据不变', async () => {
    const db = new MockDB(seed([{ _id: 'ta', coupleId: 'CZ-OTHER', text: '别人家的', done: false, createdAt: 1, updatedAt: 1, doneAt: 0 }]))
    const gpv = loadFn(GPV_PATH, db)
    OPENID = HER
    const tog = await gpv.main({ action: 'coupleTodo', op: 'toggle', id: 'ta', done: true })
    assertEq(tog.code, 'NOT_FOUND', '跨情侣 toggle 必须 NOT_FOUND')
    const rm = await gpv.main({ action: 'coupleTodo', op: 'remove', id: 'ta' })
    assertEq(rm.code, 'NOT_FOUND', '跨情侣 remove 必须 NOT_FOUND')
    const left = db.dump().couple_todos
    assertEq(left.length, 1, '别人的待办不得被删除')
    assertEq(left[0].done, false, '别人的待办不得被修改')
  })

  await testCase('[L1] E11 day_choices 确定性 ID：长度/字符集/唯一性（真云 add 自定义 _id 见文档 §9 V4）', () => {
    const dc = require(path.join(ROOT, 'cloudfunctions/lifePlanner/day-choice.js'))
    const id = dc.choiceDocId('CZ-1', '2026-10-26', 'meal')
    assertEq(id.length, 28, 'ID 应为 28 字符')
    assertOk(id.length <= 32, '不得超过微信云数据库 32 字节上限')
    assertOk(/^[0-9a-zA-Z_-]+$/.test(id), 'ID 字符集越界: ' + id)
    assertEq(dc.choiceDocId('CZ-1', '2026-10-26', 'meal'), id, '同键必须稳定')
    assertNo(dc.choiceDocId('CZ-1', '2026-10-26', 'travel') === id, 'kind 不同不得同 ID')
    assertNo(dc.choiceDocId('CZ-1', '2026-10-27', 'meal') === id, '日期不同不得同 ID')
    assertNo(dc.choiceDocId('CZ-2', '2026-10-26', 'meal') === id, '情侣不同不得同 ID')
    assertEq(dc.choiceDocId('CZ-1', '2026-02-30', 'meal'), null, '非法日期必须返回 null')
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    console.log('失败项：')
    failures.forEach(f => console.log('  - ' + f))
    process.exitCode = 1
  } else {
    console.log('V1.1 Deploy Boundary: ALL GREEN')
  }
}

main().catch(e => { console.error(e); process.exitCode = 1 })
