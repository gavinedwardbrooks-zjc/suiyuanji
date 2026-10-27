// ============================================================
// tests/anni-role-access.test.js · V1.1 体验收尾第二轮定点复核
//
// 目的：把「代码结构存在」与「真的跑通」分开证明，四档分明：
//
//   L1 代码结构存在      —— 静态源码 / WXSS 断言（本文件标注 [L1]）
//   L2 本地模拟请求成功  —— **真实云函数代码** + 内存云数据库 + **真实页面代码**
//                          + 假 wx（本文件标注 [L2]）
//   L3 微信云环境真实请求成功 —— 未覆盖（需部署 + 真机，本文件不声称）
//   L4 开发者工具实际渲染 —— 未覆盖（需在微信开发者工具里看，本文件不声称）
//
// 覆盖两个疑点：
//   A. her 首页纪念日读取权限：her 调 getPartnerView(view) 是否真能拿到
//      anniversary / days；未绑定时是否 fail-closed。
//   B. 悄悄话滚动与数量：少于 50 条时「共 N 条」是否有事实依据；
//      滚到底只发生在「进入页面 / 自己刚发送」。
//
// 运行：node tests/anni-role-access.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const fs = require('fs')
const { MockDB } = require('./mock-db')

const ROOT = path.resolve(__dirname, '..')
const HOME_PAGE = path.join(ROOT, 'pages/home/home.js')
const OURS_PAGE = path.join(ROOT, 'pages/ours/ours.js')
const FN_PATH = path.join(ROOT, 'cloudfunctions/getPartnerView/index.js')

const HER_A = 'A_her_openid'
const HIM_B = 'B_him_openid'

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
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8') }
const flush = () => new Promise(r => setTimeout(r, 0))

function pad(n) { return String(n).padStart(2, '0') }
function dateStrOf(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function daysAgoStr(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return dateStrOf(d)
}

// ---------------- 真实云函数装载（只替换 wx-server-sdk） ----------------
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
  delete require.cache[FN_PATH]
  const mod = require(FN_PATH)
  Module._load = origLoad
  return { main: (event) => mod.main(event || {}, {}) }
}

function msg(i, extra) {
  return Object.assign({
    _id: 'm_' + pad(i),
    coupleId: 'CZ-1',
    fromOpenid: i % 2 === 0 ? HER_A : HIM_B,
    fromRole: i % 2 === 0 ? 'her' : 'him',
    text: '第 ' + i + ' 条',
    readAt: null,
    createdAt: 1000 + i
  }, extra || {})
}

function seed(opts) {
  const o = opts || {}
  return {
    users: [
      { _id: 'uA', _openid: HER_A, role: 'her', coupleId: o.herCouple === undefined ? 'CZ-1' : o.herCouple, partnerName: '' },
      { _id: 'uB', _openid: HIM_B, role: 'him', coupleId: 'CZ-1', partnerName: '' }
    ],
    couples: [
      {
        _id: 'c1', coupleId: 'CZ-1', status: o.status || 'active',
        herOpenid: HER_A, himOpenid: HIM_B, anniversary: o.anniversary === undefined ? null : o.anniversary
      }
    ],
    daily_records: [],
    messages: o.messages || []
  }
}

// ============================================================
// 首页 harness（真实 pages/home/home.js + 假 wx）
// ============================================================
function loadHomePage(callFunction) {
  global.getApp = () => ({
    globalData: { openid: HER_A, role: 'her', coupleId: 'CZ-1', partnerName: '' },
    whenReady: () => {},
    loginSnapshot: () => ({ state: 'ready' }),
    silentLogin: () => {}
  })
  global.wx = {
    cloud: { callFunction },
    getStorageSync: () => '',
    setStorageSync: () => {},
    switchTab: () => {}
  }
  let def = null
  global.Page = (c) => { def = c }
  delete require.cache[HOME_PAGE]
  require(HOME_PAGE)
  const page = Object.assign({}, def)
  page.data = JSON.parse(JSON.stringify(def.data))
  page.setData = function (patch) { Object.assign(page.data, patch || {}) }
  return page
}

// ============================================================
// 「我们」页 harness（真实 pages/ours/ours.js + 假 wx）
// ============================================================
function loadOursPage(routes) {
  global.getApp = () => ({
    globalData: { openid: HER_A, role: 'her', coupleId: 'CZ-1', bindCode: null, wishOpenOnEnter: false },
    whenReady: () => {},
    loginSnapshot: () => ({ state: 'ready' }),
    silentLogin: () => {}
  })
  global.wx = {
    cloud: {
      callFunction: (payload) => {
        const action = (payload && payload.data && payload.data.action) || 'view'
        const h = (routes || {})[action]
        return Promise.resolve(h ? h(payload) : { ok: true }).then(r => ({ result: r }))
      }
    },
    getStorageSync: () => '',
    setStorageSync: () => {},
    removeStorageSync: () => {},
    showToast: () => {},
    showModal: () => {},
    switchTab: () => {},
    navigateTo: () => {}
  }
  let def = null
  global.Page = (c) => { def = c }
  delete require.cache[OURS_PAGE]
  require(OURS_PAGE)
  const page = Object.assign({}, def)
  page.data = JSON.parse(JSON.stringify(def.data))
  page.setData = function (patch) { Object.assign(page.data, patch || {}) }
  return page
}

function viewPayload(opts) {
  const o = opts || {}
  return Object.assign({
    ok: true,
    role: 'her',
    myPartnerName: '',
    score: null,
    wishes: [],
    messages: [],
    unreadMsgs: 0,
    anniversary: null,
    days: null,
    partnerSummary: '',
    partnerSummaryAt: 0,
    partnerRole: 'him',
    shared: null
  }, o)
}

async function main() {
  console.log('\n=== 定点复核 · A 纪念日读取权限 / B 悄悄话滚动与数量 ===\n')

  // ============================================================
  // A. her 首页纪念日读取权限
  // ============================================================
  console.log('-- A. her 首页纪念日（服务端 + 客户端链路） --')

  await testCase('[L2] A1 her 调 getPartnerView(view) 真的拿到 anniversary 与 days（不被角色校验拒绝）', async () => {
    const anni = daysAgoStr(30)
    const db = new MockDB(seed({ anniversary: anni }))
    const fn = loadFn(db)
    OPENID = HER_A
    const r = await fn.main({ action: 'view' })
    assertEq(r.ok, true, 'her 的 view 必须 ok:true')
    assertEq(r.role, 'her', '服务端认定的角色必须是 her')
    assertEq(r.anniversary, anni, 'her 必须拿到 couple.anniversary')
    assertEq(typeof r.days, 'number', 'days 必须是数字')
    assertEq(r.days, 31, '在一起第 31 天（30 天前 + 1）')
  })

  await testCase('[L2] A2 her 与 him 取到的是同一份服务端值（anniversary 相同、days 相同）', async () => {
    const anni = daysAgoStr(100)
    const db = new MockDB(seed({ anniversary: anni }))
    const fn = loadFn(db)
    OPENID = HER_A
    const her = await fn.main({ action: 'view' })
    OPENID = HIM_B
    const him = await fn.main({ action: 'view' })
    assertEq(her.ok && him.ok, true)
    assertEq(her.anniversary, him.anniversary)
    assertEq(her.days, him.days)
    assertEq(her.days, 101)
  })

  await testCase('[L2] A3 her 未绑定（coupleId 为空）→ NOT_ACTIVE，且响应里没有任何 anniversary 可用值', async () => {
    const db = new MockDB(seed({ anniversary: daysAgoStr(10), herCouple: null }))
    const fn = loadFn(db)
    OPENID = HER_A
    const r = await fn.main({ action: 'view' })
    assertEq(r.ok, false)
    assertEq(r.code, 'NOT_ACTIVE')
    assertEq(Object.prototype.hasOwnProperty.call(r, 'anniversary'), false, '未授权响应不得夹带纪念日')
    assertEq(Object.prototype.hasOwnProperty.call(r, 'days'), false, '未授权响应不得夹带天数')
  })

  await testCase('[L2] A4 her 所在关系已 superseded → NOT_ACTIVE（旧关系不续用）', async () => {
    const db = new MockDB(seed({ anniversary: daysAgoStr(10), status: 'superseded' }))
    const fn = loadFn(db)
    OPENID = HER_A
    const r = await fn.main({ action: 'view' })
    assertEq(r.ok, false)
    assertEq(r.code, 'NOT_ACTIVE')
  })

  await testCase('[L2] A5 客户端链路：requestPartnerView 白名单裁剪后 anniversary / days 仍在', async () => {
    const anni = daysAgoStr(7)
    const db = new MockDB(seed({ anniversary: anni }))
    const fn = loadFn(db)
    OPENID = HER_A
    const pv = require(path.join(ROOT, 'utils/partner-view.js'))
    // call 直接桥到真实云函数：不是假响应，是真实服务端返回值
    const call = (payload) => fn.main(payload.data).then(result => ({ result }))
    const res = await pv.requestPartnerView('', call)
    assertEq(res.ok, true, '客户端必须判为 ok（否则首页会走 error 分支）')
    assertEq(res.data.anniversary, anni, '白名单丢弃了 anniversary')
    assertEq(typeof res.data.days, 'number', '白名单丢弃了 days')
    assertEq(res.data.days, 8)
  })

  await testCase('[L2] A6 首页 _loadOwnAnni 走真实服务端：ready 态 + 天数与日期都来自服务端', async () => {
    const anni = daysAgoStr(12)
    const db = new MockDB(seed({ anniversary: anni }))
    const fn = loadFn(db)
    OPENID = HER_A
    const page = loadHomePage((payload) => fn.main(payload.data).then(result => ({ result })))
    await page._loadOwnAnni()
    await flush()
    assertEq(page.data.ownAnniState, 'ready')
    assertEq(page.data.ownDays, 13)
    assertEq(page.data.ownAnniText, '在一起 · ' + anni)
  })

  await testCase('[L2] A7 关系不可用时首页不展示假数据：ownAnniState=error、ownDays=null', async () => {
    const db = new MockDB(seed({ anniversary: daysAgoStr(12), herCouple: null }))
    const fn = loadFn(db)
    OPENID = HER_A
    const page = loadHomePage((payload) => fn.main(payload.data).then(result => ({ result })))
    await page._loadOwnAnni()
    await flush()
    assertEq(page.data.ownAnniState, 'error')
    assertEq(page.data.ownDays, null)
    assertEq(page.data.ownAnniText, '')
  })

  await testCase('[L1] A8 首页只在记录方分支调 _loadOwnAnni，且不绕过统一入口直接调云函数', () => {
    const src = read('pages/home/home.js')
    assertOk(src.includes('this._loadOwnAnni()'), '缺 _loadOwnAnni 调用')
    assertOk(src.includes("if (mode !== VIEW_MODE_OWNER) return"), '缺记录方分支闸门')
    const idxGate = src.indexOf('if (mode !== VIEW_MODE_OWNER) return')
    const idxCall = src.indexOf('this._loadOwnAnni()')
    assertOk(idxGate !== -1 && idxCall > idxGate, '_loadOwnAnni 必须在记录方闸门之后')
    assertOk(src.indexOf("name: 'getPartnerView'") === -1, '不得绕过 utils/partner-view 直接调云函数')
    // 闸门判定本身：已绑定的 her 必须落在 owner，否则 _loadOwnAnni 永远不会被调用
    const { pageViewMode } = require(path.join(ROOT, 'utils/viewer-role.js'))
    const modeHer = pageViewMode({ openid: HER_A, role: 'her', coupleId: 'CZ-1' }, { companionViewEnabled: true })
    assertEq(modeHer, 'owner', '已绑定的 her 必须是记录方视图')
  })

  await testCase('[L1] A9 服务端 view 分支没有针对 her 的 FORBIDDEN 闸门（角色闸门只在 mark / share* / 称呼）', () => {
    const src = read('cloudfunctions/getPartnerView/index.js')
    // 角色闸门的位置必须都在 view 之前（各自 action 内），view 的返回对象里不得再出现
    const idxView = src.indexOf("if (event.action && event.action !== 'view')")
    assertOk(idxView !== -1, '找不到 view 分界行')
    const tail = src.slice(idxView)
    assertOk(tail.indexOf('FORBIDDEN') === -1, 'view 分支内出现 FORBIDDEN 闸门，her 会被拒绝')
    assertOk(tail.indexOf('anniversary') !== -1, 'view 返回里必须有 anniversary')
    assertOk(tail.indexOf('days:') !== -1, 'view 返回里必须有 days')
  })

  // ============================================================
  // B. 悄悄话滚动与数量
  // ============================================================
  console.log('\n-- B. 悄悄话滚动与数量 --')

  await testCase('[L2] B1 少于 50 条时服务端返回的就是全部（「共 N 条」有事实依据）', async () => {
    const msgs = []
    for (let i = 1; i <= 3; i++) msgs.push(msg(i))
    const db = new MockDB(seed({ messages: msgs }))
    const fn = loadFn(db)
    OPENID = HER_A
    const r = await fn.main({ action: 'view' })
    assertEq(r.ok, true)
    assertEq(r.messages.length, 3, '不足 50 条时必须全部返回')
    assertEq(db.dump().messages.length, 3, '库里也只有 3 条 → 返回数 = 总数')
  })

  await testCase('[L2] B2 满 50 条时服务端只给最近 50 条（「最近 50 条」有事实依据）', async () => {
    const msgs = []
    for (let i = 1; i <= 60; i++) msgs.push(msg(i))
    const db = new MockDB(seed({ messages: msgs }))
    const fn = loadFn(db)
    OPENID = HER_A
    const r = await fn.main({ action: 'view' })
    assertEq(r.messages.length, 50, '必须截断到 50')
    assertEq(r.messages[49]._id, 'm_60', '最后一条必须是最新的那条（时间升序）')
    assertEq(r.messages[0]._id, 'm_11', '最早可见的必须是第 11 条（前 10 条已不可见）')
  })

  await testCase('[L2] B3 页面按条数切换口径：<50 用「共 N 条」，=50 用「最近 50 条」', async () => {
    const few = loadOursPage({ view: () => viewPayload({ messages: [msg(1), msg(2), msg(3)] }) })
    await few.loadPartner(HER_A)
    await flush()
    assertEq(few.data.msgMaxed, false, '3 条必须判为「未截断」')
    assertEq(few.data.messages.length, 3)

    const many = []
    for (let i = 1; i <= 50; i++) many.push(msg(i))
    const full = loadOursPage({ view: () => viewPayload({ messages: many }) })
    await full.loadPartner(HER_A)
    await flush()
    assertEq(full.data.msgMaxed, true, '50 条必须判为「已截断」')
  })

  await testCase('[L2] B4 进入页面即滚到底部（msgScrollTop 增大）', async () => {
    const page = loadOursPage({ view: () => viewPayload({ messages: [msg(1), msg(2)] }) })
    const before = page.data.msgScrollTop
    await page.loadPartner(HER_A)
    await flush()
    assertOk(page.data.msgScrollTop > before, '进入页面必须触发一次滚到底')
  })

  await testCase('[L2] B5 无关刷新（标记心愿）不得把用户拽回底部', async () => {
    const page = loadOursPage({
      view: () => viewPayload({ messages: [msg(1), msg(2), msg(3)] }),
      mark: () => ({ ok: true })
    })
    await page.loadPartner(HER_A)
    await flush()
    const afterEnter = page.data.msgScrollTop
    assertOk(afterEnter > 0, '前置条件：进入页面已滚到底')
    await page.markWish({ currentTarget: { dataset: { id: 'w1' } } })
    await flush()
    await flush()
    assertEq(page.data.msgScrollTop, afterEnter, '标记心愿后的刷新不得改变滚动位置')
  })

  await testCase('[L2] B6 自己刚发完必须再滚到底（用户要看到自己这条）', async () => {
    const page = loadOursPage({
      view: () => viewPayload({ messages: [msg(1), msg(2)] }),
      msg: () => ({ ok: true, msgId: 'm_new' })
    })
    await page.loadPartner(HER_A)
    await flush()
    const afterEnter = page.data.msgScrollTop
    page.data.msgInput = '在吗'
    await page.sendMsg()
    await flush()
    await flush()
    assertOk(page.data.msgScrollTop > afterEnter, '发送成功后必须再次滚到底')
  })

  await testCase('[L1] B7 服务端 MSG_LIMIT 与客户端 MSG_LIMIT_CLIENT 必须一致（否则「共 N 条」会失真）', () => {
    const server = read('cloudfunctions/getPartnerView/index.js')
    const client = read('pages/ours/ours.js')
    const mServer = /const MSG_LIMIT = (\d+)/.exec(server)
    const mClient = /const MSG_LIMIT_CLIENT = (\d+)/.exec(client)
    assertOk(mServer && mClient, '找不到两处上限常量')
    assertEq(mClient[1], mServer[1], '客户端上限必须等于服务端上限')
    assertEq(mServer[1], '50')
  })

  await testCase('[L1] B8 滚动容器结构：scroll-y + max-height 上限（仅证明结构，不证明渲染）', () => {
    const wxml = read('pages/ours/ours.wxml')
    // 注意：wx:if 里含 `>`（messages.length > 0），不能用 [^>]* 匹配标签属性
    assertOk(/<scroll-view[\s\S]{0,200}?\sscroll-y[\s\S]{0,200}?scroll-top="\{\{msgScrollTop\}\}"/.test(wxml),
      'scroll-view 必须 scroll-y 且绑定 scroll-top')
    const wxss = read('pages/ours/ours.wxss')
    assertOk(/\.msg-scroll\s*\{[^}]*max-height:\s*\d+rpx/.test(wxss), '缺高度上限')
    assertOk(wxml.includes("msgMaxed ? '最近 ' + msgLimit + ' 条' : '共 ' + messages.length + ' 条'"),
      '数量文案必须按是否截断切换')
    assertOk(wxml.includes('只显示最近 {{msgLimit}} 条，更早的暂时看不到'), '截断时必须如实说明')
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failures.length) {
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
  console.log('Anni Role Access: ALL GREEN')
}

main().catch(e => { console.error(e); process.exit(1) })
