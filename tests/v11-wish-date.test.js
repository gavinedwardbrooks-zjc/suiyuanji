// ============================================================
// tests/v11-wish-date.test.js · 心愿按日期归属与判重（V1.1 · 2026-10-26）
//
// 本轮唯一主题：心愿的业务日期（wishDate）
//   · 写入：wishDate = 记录自身的 date（服务端校验），客户端传不了
//   · 判重：openid + coupleId + wishDate + type + text
//   · 读取：记录页「这天的愿望」按 wishDate；历史文档退回 createdAt（只读近似）
//
// 证据分档（不得互相冒充）：
//   [L1] 代码结构 / 文档口径存在 —— 静态断言
//   [L2] 本地模拟请求成功 —— **真实云函数代码** + 内存云数据库 + 真实页面代码 + 假 wx
//   [L3] 微信云环境真实请求 —— 未覆盖（dailyRecord / getPartnerView 未重新上传）
//   [L4] 开发者工具实际渲染 —— 未覆盖
//
// 运行：node tests/v11-wish-date.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const fs = require('fs')
const { MockDB } = require('./mock-db')

const ROOT = path.resolve(__dirname, '..')
const DAILY_PATH = path.join(ROOT, 'cloudfunctions/dailyRecord/index.js')
const GPV_PATH = path.join(ROOT, 'cloudfunctions/getPartnerView/index.js')
const RECORD_PAGE = path.join(ROOT, 'pages/record/record.js')

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
function assertNotIn(str, needle, msg) {
  if (String(str).indexOf(needle) !== -1) throw new Error((msg || '') + '（不应出现：' + needle + '）')
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8') }
const flush = () => new Promise(r => setTimeout(r, 0))

// 北京时间 → 绝对时间戳（毫秒）。不依赖跑测试机器的本地时区。
function bjTime(y, mo, d, h, mi) {
  return Date.UTC(y, mo - 1, d, (h || 0) - 8, mi || 0, 0, 0)
}

// 北京时间「今天 + offsetDays」的纯日期字符串（测试不写死日期）
function bjDay(offsetDays) {
  const t = new Date(Date.now() + 8 * 3600 * 1000 + (offsetDays || 0) * 86400000)
  const p = n => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`
}

// 时间戳 → 北京时间自然日（与服务端同口径，用于断言 createdAt 的归属）
function bjDateOf(ms) {
  const t = new Date(Number(ms) + 8 * 3600 * 1000)
  const p = n => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`
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
const loadDaily = (db) => loadFn(DAILY_PATH, db)
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
    couple_todos: [],
    messages: [],
    menstrual: [],
    record_shares: [],
    recipes: [],
    travel_places: []
  }
}

// 心愿文档构造器：wishDate 省略 = 历史文档（没有这个字段）
function wish(id, text, createdAt, opts) {
  const o = opts || {}
  const doc = {
    _id: id,
    _openid: o.owner || HER,
    coupleId: o.coupleId === undefined ? 'CZ-1' : o.coupleId,
    type: o.type || 'eat',
    text,
    status: o.status || 'pending',
    createdAt
  }
  if (o.arrangedAt) doc.arrangedAt = o.arrangedAt
  if (o.wishDate !== null) doc.wishDate = o.wishDate === undefined ? bjDateOf(createdAt) : o.wishDate
  return doc
}

function saveEvent(wishes, over) {
  return Object.assign({
    action: 'save',
    date: bjDay(0),
    requestId: 'req-' + Math.random().toString(36).slice(2),
    revision: 0,
    goals: [], todos: [],
    segments: { life: '', work: '', growth: '' },
    mood: { type: 'calm', weather: 'sunny' },
    wishes,
    score: 4,
    readProgress: 0
  }, over || {})
}

const wishesOf = (db) => db.dump().wishes || []

// ============================================================
async function main() {
  console.log('\n=== V1.1 心愿按日期归属与判重 ===\n')

  const TODAY = bjDay(0)
  const YDAY = bjDay(-1)
  const PAST3 = bjDay(-3)

  // ============================================================
  console.log('-- A. 写入侧：wishDate 与判重（真实 dailyRecord 代码） --')
  // ============================================================

  await testCase('[L2] A1 同一天相同文本重复保存 → 不新建（判重仍生效）', async () => {
    const db = new MockDB(seed())
    const daily = loadDaily(db)
    OPENID = HER
    await daily.main(saveEvent([{ type: 'eat', text: '火锅' }], { requestId: 'r1', revision: 0 }))
    await daily.main(saveEvent([{ type: 'eat', text: '火锅' }], { requestId: 'r2', revision: 1 }))
    await daily.main(saveEvent([{ type: 'eat', text: '  火锅  ' }], { requestId: 'r3', revision: 2 }))
    assertEq(wishesOf(db).length, 1, '同一天三次保存同文本只应有 1 条')
    assertEq(wishesOf(db)[0].wishDate, TODAY, 'wishDate 必须是这条记录的日期')
  })

  await testCase('[L2] A2 不同日期相同文本 → 各建一条，wishDate 各自正确', async () => {
    const db = new MockDB(seed())
    const daily = loadDaily(db)
    OPENID = HER
    // 昨天一条记录
    const r1 = await daily.main(saveEvent([{ type: 'eat', text: '火锅' }], { date: YDAY, requestId: 'y1', revision: 0 }))
    assertOk(r1.ok, JSON.stringify(r1))
    // 今天一条记录，同样的四个字
    const r2 = await daily.main(saveEvent([{ type: 'eat', text: '火锅' }], { date: TODAY, requestId: 't1', revision: 0 }))
    assertOk(r2.ok, JSON.stringify(r2))
    const list = wishesOf(db)
    assertEq(list.length, 2, '跨日相同文本必须能各建一条（本轮核心修复）')
    const dates = list.map(w => w.wishDate).sort()
    assertEq(dates.join(','), [YDAY, TODAY].sort().join(','), '两条的 wishDate 必须是各自那天')
    // 两条都属于同一段关系
    assertEq(list.filter(w => w.coupleId === 'CZ-1').length, 2, '关系归属不变')
  })

  await testCase('[L2] A3 补写历史日期：wishDate = 那天，createdAt 仍是真实写库时间', async () => {
    const db = new MockDB(seed())
    const daily = loadDaily(db)
    OPENID = HER
    const r = await daily.main(saveEvent([{ type: 'eat', text: '三天前想吃的' }], { date: PAST3, requestId: 'p1', revision: 0 }))
    assertOk(r.ok, JSON.stringify(r))
    const w = wishesOf(db)[0]
    assertEq(w.wishDate, PAST3, 'wishDate 必须是补写的那一天')
    assertEq(bjDateOf(w.createdAt), TODAY, 'createdAt 仍是真实写库时间（今天），语义不变')
    assertOk(w.createdAt > 0, 'createdAt 必须存在')
  })

  await testCase('[L2] A4 跨情侣隔离：另一段关系的同文本同日期各建一条', async () => {
    const db = new MockDB(seed())
    const daily = loadDaily(db)
    OPENID = HER
    await daily.main(saveEvent([{ type: 'eat', text: '火锅' }], { requestId: 'a1', revision: 0 }))
    OPENID = HER2 // CZ-2
    const r = await daily.main(saveEvent([{ type: 'eat', text: '火锅' }], { requestId: 'c1', revision: 0 }))
    assertOk(r.ok, JSON.stringify(r))
    const list = wishesOf(db)
    assertEq(list.length, 2, '不同情侣关系的数据必须严格隔离（各自一条）')
    assertEq(list.filter(w => w.coupleId === 'CZ-1').length, 1)
    assertEq(list.filter(w => w.coupleId === 'CZ-2').length, 1)
  })

  await testCase('[L2] A5 已安排的心愿不因再次保存被重置，也不产生副本', async () => {
    const db = new MockDB(seed())
    const daily = loadDaily(db)
    OPENID = HER
    await daily.main(saveEvent([{ type: 'eat', text: '火锅' }], { requestId: 'r1', revision: 0 }))
    // him 标记已安排
    OPENID = HIM
    const gpv = loadGpv(db)
    const v = await gpv.main({ action: 'view', date: TODAY })
    assertEq(v.dayWishes.length, 1, 'him 当天应看到这条心愿')
    const marked = await gpv.main({ action: 'mark', wishId: wishesOf(db)[0]._id })
    assertOk(marked.ok, JSON.stringify(marked))
    // her 再保存同一天
    OPENID = HER
    await daily.main(saveEvent([{ type: 'eat', text: '火锅' }], { requestId: 'r2', revision: 1 }))
    const list = wishesOf(db)
    assertEq(list.length, 1, '不得产生 pending 副本')
    assertEq(list[0].status, 'done_by_partner', '已安排状态不得被重置')
    assertOk(list[0].arrangedAt > 0, 'arrangedAt 保留')
  })

  await testCase('[L2] A6 记录日期非法（2026-02-30）→ 不同步、零写入、明确回报', async () => {
    const db = new MockDB(seed())
    const daily = loadDaily(db)
    OPENID = HER
    const r = await daily.main(saveEvent([{ type: 'eat', text: '火锅' }], { date: '2026-02-30', requestId: 'bad1', revision: 0 }))
    assertOk(r.ok, '记录本身照常保存（那是她自己的日记）')
    assertEq(r.wishSyncSkipped, 'record-date-invalid', '必须明确回报被跳过')
    assertEq(wishesOf(db).length, 0, '不得写入没有可信日期的 wishDate')
  })

  await testCase('[L2] A7 历史文档（无 wishDate，createdAt 就在那天）→ 重复保存不新建', async () => {
    const legacy = wish('w_legacy', '火锅', bjTime(2026, 10, 18, 21, 0), { wishDate: null })
    assertOk(!Object.prototype.hasOwnProperty.call(legacy, 'wishDate'), '构造器：null 表示没有该字段')
    const db = new MockDB(seed({ wishes: [legacy] }))
    const daily = loadDaily(db)
    OPENID = HER
    await daily.main(saveEvent([{ type: 'eat', text: '火锅' }], { date: '2026-10-18', requestId: 'l1', revision: 0 }))
    assertEq(wishesOf(db).length, 1, '历史文档在「同一天」仍要挡住重复创建')
    assertOk(!Object.prototype.hasOwnProperty.call(wishesOf(db)[0], 'wishDate'), '不得擅自给历史文档补 wishDate')
  })

  await testCase('[L2] A8 历史文档（无 wishDate，createdAt 在别的日子）→ 不挡新建', async () => {
    const legacy = wish('w_legacy', '火锅', bjTime(2026, 10, 18, 21, 0), { wishDate: null })
    const db = new MockDB(seed({ wishes: [legacy] }))
    const daily = loadDaily(db)
    OPENID = HER
    await daily.main(saveEvent([{ type: 'eat', text: '火锅' }], { date: TODAY, requestId: 'n1', revision: 0 }))
    assertEq(wishesOf(db).length, 2, '不同日期的同文本必须能新建')
    const created = wishesOf(db).find(w => w._id !== 'w_legacy')
    assertEq(created.wishDate, TODAY, '新建的 wishDate 是今天')
  })

  await testCase('[L2] A9 请求里伪造 wishDate / createdAt 一律无效', async () => {
    const db = new MockDB(seed())
    const daily = loadDaily(db)
    OPENID = HER
    await daily.main(saveEvent([{ type: 'eat', text: '火锅' }], {
      date: TODAY, requestId: 'f1', revision: 0,
      wishDate: '2020-01-01', createdAt: 1,
      wishes: [{ type: 'eat', text: '火锅', wishDate: '2020-01-01', createdAt: 1 }]
    }))
    const w = wishesOf(db)[0]
    assertEq(w.wishDate, TODAY, 'wishDate 只认记录日期，客户端传什么都不看')
    assertEq(bjDateOf(w.createdAt), TODAY, 'createdAt 只由服务端 Date.now() 写')
  })

  await testCase('[L2] A10 端到端：她补写 3 天前 + 今天写同样的文本 → 他各看到各的', async () => {
    const db = new MockDB(seed())
    const daily = loadDaily(db)
    OPENID = HER
    const r1 = await daily.main(saveEvent([{ type: 'eat', text: '火锅' }], { date: PAST3, requestId: 'e1', revision: 0 }))
    assertOk(r1.ok, JSON.stringify(r1))
    const r2 = await daily.main(saveEvent([{ type: 'eat', text: '火锅' }], { date: TODAY, requestId: 'e2', revision: 0 }))
    assertOk(r2.ok, JSON.stringify(r2))
    assertEq(wishesOf(db).length, 2, '两条记录各自一条心愿')

    OPENID = HIM
    const gpv = loadGpv(db)
    const past = await gpv.main({ action: 'view', date: PAST3 })
    assertEq(past.dayWishes.length, 1, '3 天前应看到 1 条')
    const today = await gpv.main({ action: 'view', date: TODAY })
    assertEq(today.dayWishes.length, 1, '今天应看到 1 条（同文本不会被前一天挡住）')
    const other = await gpv.main({ action: 'view', date: YDAY })
    assertEq(other.dayWishes.length, 0, '中间那天没有心愿')
    assertEq(today.wishes.length, 2, '「我们」页总列表仍是 2 条')
    OPENID = HER
  })

  // ============================================================
  console.log('\n-- B. 读取侧：「这天的愿望」按 wishDate --')
  // ============================================================

  await testCase('[L2] B1 记录页切日期：只显示该 wishDate 的心愿', async () => {
    const db = new MockDB(seed({
      wishes: [
        wish('w_y', '昨天想吃火锅', bjTime(2026, 10, 25, 12, 0)),
        wish('w_t', '今天想吃烤肉', bjTime(2026, 10, 26, 9, 0))
      ]
    }))
    const gpv = loadGpv(db)
    OPENID = HIM
    const t = await gpv.main({ action: 'view', date: '2026-10-26' })
    assertEq(t.dayWishes.map(w => w.text).join(','), '今天想吃烤肉', '今天只看今天')
    const y = await gpv.main({ action: 'view', date: '2026-10-25' })
    assertEq(y.dayWishes.map(w => w.text).join(','), '昨天想吃火锅', '昨天只看昨天')
    OPENID = HER
  })

  await testCase('[L2] B2 补写场景（核心回归）：wishDate 在过去、createdAt 是今天 → 只属于那一天', async () => {
    // 这就是用户实测的缺陷：补写 10-20 的心愿，createdAt 却是今天（10-26）
    const backdated = {
      _id: 'w_back', _openid: HER, coupleId: 'CZ-1', wishDate: PAST3,
      type: 'eat', text: '补写那天的心愿', status: 'pending', createdAt: Date.now()
    }
    const db = new MockDB(seed({ wishes: [backdated] }))
    const gpv = loadGpv(db)
    OPENID = HIM
    const past = await gpv.main({ action: 'view', date: PAST3 })
    assertEq(past.dayWishes.map(w => w.text).join(','), '补写那天的心愿', '必须出现在补写的那一天')
    const today = await gpv.main({ action: 'view', date: TODAY })
    assertEq(today.dayWishes.length, 0, '不得因为 createdAt 是今天就算到今天')
    // 完整心愿列表不受影响（心愿管理仍要看到它）
    assertEq(today.wishes.length, 1, '总列表不应被日期筛选影响')
    OPENID = HER
  })

  await testCase('[L2] B3 历史文档（无 wishDate）→ 按 createdAt 兜底归属那一天', async () => {
    const legacy = wish('w_legacy', '老数据的心愿', bjTime(2026, 10, 20, 15, 0), { wishDate: null })
    const db = new MockDB(seed({ wishes: [legacy] }))
    const gpv = loadGpv(db)
    OPENID = HIM
    const hit = await gpv.main({ action: 'view', date: '2026-10-20' })
    assertEq(hit.dayWishes.map(w => w.text).join(','), '老数据的心愿', '历史文档按 createdAt 的北京日归属（近似）')
    const miss = await gpv.main({ action: 'view', date: '2026-10-21' })
    assertEq(miss.dayWishes.length, 0, '别的日子不显示')
    OPENID = HER
  })

  await testCase('[L2] B4 wishDate 异常值（数字 / 空串）→ 不归属任何一天', async () => {
    const db = new MockDB(seed({
      wishes: [
        { _id: 'w_bad1', _openid: HER, coupleId: 'CZ-1', wishDate: 20261026, type: 'eat', text: '坏日期A', status: 'pending', createdAt: bjTime(2026, 10, 26, 10, 0) },
        { _id: 'w_bad2', _openid: HER, coupleId: 'CZ-1', wishDate: '', type: 'eat', text: '坏日期B', status: 'pending', createdAt: bjTime(2026, 10, 26, 11, 0) }
      ]
    }))
    const gpv = loadGpv(db)
    OPENID = HIM
    const v = await gpv.main({ action: 'view', date: '2026-10-26' })
    assertEq(v.dayWishes.length, 0, '读不懂的 wishDate 不猜、不兜底成 createdAt')
    OPENID = HER
  })

  await testCase('[L2] B5 北京时间跨零点：23:30 属于前一天，00:30 属于当天', async () => {
    const night = wish('w_n', '零点后写下的', bjTime(2026, 10, 26, 0, 30))
    const late = wish('w_l', '昨晚十一点半', bjTime(2026, 10, 25, 23, 30))
    assertEq(night.wishDate, '2026-10-26', '00:30 的北京日必须是 26 号')
    assertEq(late.wishDate, '2026-10-25', '23:30 的北京日必须是 25 号')
    const db = new MockDB(seed({ wishes: [night, late] }))
    const gpv = loadGpv(db)
    OPENID = HIM
    const t = await gpv.main({ action: 'view', date: '2026-10-26' })
    assertEq(t.dayWishes.map(w => w.text).join(','), '零点后写下的')
    const y = await gpv.main({ action: 'view', date: '2026-10-25' })
    assertEq(y.dayWishes.map(w => w.text).join(','), '昨晚十一点半')
    OPENID = HER
  })

  await testCase('[L2] B6 权限不退化：异关系 / 无 coupleId 的历史文档都不进 dayWishes', async () => {
    const db = new MockDB(seed({
      wishes: [
        wish('w_old', '旧关系的心愿', bjTime(2026, 10, 26, 8, 0), { coupleId: 'CZ-OLD' }),
        wish('w_none', '没有关系标记', bjTime(2026, 10, 26, 8, 30), { coupleId: null }),
        wish('w_mine', '这段关系的心愿', bjTime(2026, 10, 26, 9, 30))
      ]
    }))
    const gpv = loadGpv(db)
    OPENID = HIM
    const v = await gpv.main({ action: 'view', date: '2026-10-26' })
    assertEq(v.dayWishes.map(w => w.text).join(','), '这段关系的心愿', '只允许当前关系的心愿')
    assertNotIn(JSON.stringify(v.dayWishes), '旧关系的心愿', '旧关系内容泄露')
    assertNotIn(JSON.stringify(v.dayWishes), '没有关系标记', '不可归属内容泄露')
    OPENID = HER
  })

  await testCase('[L2] B7 her 侧仍不下发 dayWishes；him 侧照常可读（权限口径不变）', async () => {
    const db = new MockDB(seed({ wishes: [wish('w1', '今天想吃的', bjTime(2026, 10, 26, 9, 0))] }))
    const gpv = loadGpv(db)
    OPENID = HER
    const her = await gpv.main({ action: 'view', date: '2026-10-26' })
    assertEq(her.dayWishes.length, 0, 'her 侧不额外计算（她的记录页用当天快照）')
    assertEq(her.wishes.length, 1, '她自己的心愿列表照常')
    OPENID = HIM
    const him = await gpv.main({ action: 'view', date: '2026-10-26' })
    assertEq(him.dayWishes.length, 1, 'him 侧仍能读到这一天的心愿')
    OPENID = HER
  })

  await testCase('[L2] B8 死数据不影响新路径：dayWishes 仍只回白名单字段（不多下发）', async () => {
    const db = new MockDB(seed({
      wishes: [Object.assign(wish('w1', '今天想吃的', bjTime(2026, 10, 26, 9, 0)), { secret: '不该下发', _openid2: HER })]
    }))
    const gpv = loadGpv(db)
    OPENID = HIM
    const v = await gpv.main({ action: 'view', date: '2026-10-26' })
    const keys = Object.keys(v.dayWishes[0]).sort()
    assertEq(keys.join(','), '_id,arrangedAt,createdAt,status,text,type', 'dayWishes 字段集合不得扩张')
    assertNotIn(JSON.stringify(v.dayWishes), '不该下发')
    assertNotIn(JSON.stringify(v.dayWishes), 'openid')
    OPENID = HER
  })

  // ============================================================
  console.log('\n-- C. 客户端：不传日期、放弃同步要说清楚 --')
  // ============================================================

  await testCase('[L2] C1 记录页保存只传 date，不传 wishDate / createdAt', async () => {
    const calls = []
    const wx = {
      cloud: { callFunction: (p) => { calls.push(p); return Promise.resolve({ result: { ok: true, revision: 1 } }) } },
      getStorageSync: () => '', setStorageSync: () => {}, removeStorageSync: () => {},
      showToast: () => {}, showModal: () => {}, switchTab: () => {}, navigateTo: () => {}
    }
    global.getApp = () => ({
      globalData: { openid: HER, role: 'her', coupleId: 'CZ-1', partnerName: '' },
      whenReady: () => {}, loginSnapshot: () => ({ state: 'ready' }), silentLogin: () => {}
    })
    global.wx = wx
    let def = null
    global.Page = (c) => { def = c }
    delete require.cache[RECORD_PAGE]
    require(RECORD_PAGE)
    const page = Object.assign({}, def)
    page.data = JSON.parse(JSON.stringify(def.data))
    page.setData = function (patch) { Object.assign(page.data, patch || {}) }
    page.setData({ viewMode: 'owner', date: TODAY, todayStr: TODAY, eats: ['火锅'], dos: [] })
    page.save(false)
    await flush()
    const saveCall = calls.filter(c => c.name === 'dailyRecord' && c.data && c.data.action === 'save')[0]
    assertOk(saveCall, '应发起一次 save')
    assertEq(saveCall.data.date, TODAY, '只传记录日期')
    assertOk(!('wishDate' in saveCall.data), '客户端不得传 wishDate')
    assertOk(!('createdAt' in saveCall.data), '客户端不得传 createdAt')
    assertEq(JSON.stringify(saveCall.data.wishes), JSON.stringify([{ type: 'eat', text: '火锅' }]), '心愿只带 type/text')
  })

  await testCase('[L2] C2 服务端放弃同步（record-date-invalid）→ 页面必须提示，不得静默', async () => {
    const toasts = []
    const wx = {
      cloud: {
        callFunction: (p) => Promise.resolve({
          result: p.data.action === 'save'
            ? { ok: true, revision: 1, wishSyncSkipped: 'record-date-invalid' }
            : { ok: true }
        })
      },
      getStorageSync: () => '', setStorageSync: () => {}, removeStorageSync: () => {},
      showToast: (m) => { toasts.push(m && m.title) },
      showModal: () => {}, switchTab: () => {}, navigateTo: () => {}
    }
    global.getApp = () => ({
      globalData: { openid: HER, role: 'her', coupleId: 'CZ-1', partnerName: '' },
      whenReady: () => {}, loginSnapshot: () => ({ state: 'ready' }), silentLogin: () => {}
    })
    global.wx = wx
    let def = null
    global.Page = (c) => { def = c }
    delete require.cache[RECORD_PAGE]
    require(RECORD_PAGE)
    const page = Object.assign({}, def)
    page.data = JSON.parse(JSON.stringify(def.data))
    page.setData = function (patch) { Object.assign(page.data, patch || {}) }
    page.setData({ viewMode: 'owner', date: TODAY, todayStr: TODAY })
    page.save(false)
    await flush()
    await flush()
    assertOk(toasts.some(t => t && t.indexOf('心愿没能同步') !== -1), '必须提示心愿没同步：' + toasts.join('|'))
  })

  // ============================================================
  console.log('\n-- D. 结构 / 索引 / 迁移边界（L1） --')
  // ============================================================

  await testCase('[L1] D1 判重键同时包含关系作用域与业务日期', () => {
    const src = read('cloudfunctions/dailyRecord/index.js')
    assertOk(src.indexOf('wishScope.isSameScope(d, ctx)') !== -1, '判重缺关系作用域')
    assertOk(src.indexOf('wishScope.isSameWishDate(d, wishDate)') !== -1, '判重缺业务日期')
    assertOk(src.indexOf('wishDate,') !== -1, '新建心愿必须写入 wishDate')
    // 业务日期只来自服务端校验过的记录 date（不是客户端时间戳）
    assertOk(src.indexOf('wishScope.isValidBizDate(date) ? date :') !== -1, '缺记录日期校验')
    assertOk(src.indexOf('record-date-invalid') !== -1, '日期非法必须明确回报')
  })

  await testCase('[L1] D2 写入只 add、从不 update：wishDate 一旦写入不可改', () => {
    const src = read('cloudfunctions/dailyRecord/index.js')
    // syncWishes 段落里不允许出现 update（唯一 update 是通知记账标记）
    const start = src.indexOf('async function syncWishes(')
    const end = src.indexOf('async function notifyNewWishes(')
    assertOk(start > 0 && end > start, '定位失败')
    const seg = src.slice(start, end)
    assertEq(seg.indexOf('.update('), -1, 'syncWishes 内不得有 update（否则可能改到历史文档）')
    // 通知记账 update 只写 notify 字段
    const notifySeg = src.slice(end, src.indexOf('// addRead 的原子实现'))
    assertEq(notifySeg.indexOf('wishDate'), -1, '通知记账不得触碰 wishDate')
  })

  await testCase('[L1] D3 读取侧：唯一归属口径 + 两条查询各自降级', () => {
    const src = read('cloudfunctions/getPartnerView/index.js')
    assertOk(src.indexOf('function wishBelongsToDay(w, date)') !== -1, '缺唯一归属口径')
    assertOk(src.indexOf("col.where({ _openid: ownerOpenid, coupleId, wishDate: date })") !== -1, '缺 wishDate 等值查询')
    assertOk(src.indexOf('cmd.gte(range.start).and(cmd.lte(range.end))') !== -1, '缺历史文档的 createdAt 区间兜底')
    assertOk(src.indexOf('[day-wishes-date-fail]') !== -1, 'wishDate 查询失败必须有独立告警')
    assertOk(src.indexOf('[day-wishes-range-fail]') !== -1, '区间查询失败必须有独立告警')
    assertOk(src.indexOf('module.exports.wishBelongsToDay = wishBelongsToDay') !== -1, '未导出（无法单测）')
  })

  await testCase('[L1] D4 两份 wish-scope.js 仍逐字节一致，且导出新判定', () => {
    const a = fs.readFileSync(path.join(ROOT, 'cloudfunctions/getPartnerView/wish-scope.js'))
    const b = fs.readFileSync(path.join(ROOT, 'cloudfunctions/dailyRecord/wish-scope.js'))
    assertOk(a.equals(b), '两份副本已漂移')
    const scope = require(path.join(ROOT, 'cloudfunctions/getPartnerView/wish-scope'))
    assertEq(typeof scope.isSameWishDate, 'function', '缺 isSameWishDate')
    assertEq(typeof scope.isValidBizDate, 'function', '缺 isValidBizDate')
    assertEq(typeof scope.beijingDateOf, 'function', '缺 beijingDateOf')
    // 纯函数口径
    assertEq(scope.isValidBizDate('2026-02-30'), false, '假日期必须拒绝')
    assertEq(scope.isValidBizDate('2026-2-3'), false, '非零填充必须拒绝')
    assertEq(scope.isValidBizDate('2026-10-26'), true)
    assertEq(scope.beijingDateOf(bjTime(2026, 10, 26, 0, 30)), '2026-10-26', '00:30 属于当天')
    assertEq(scope.beijingDateOf(bjTime(2026, 10, 25, 23, 30)), '2026-10-25', '23:30 属于前一天')
    assertEq(scope.beijingDateOf(0), '', '非法时间戳不猜')
    assertEq(scope.isSameWishDate({ wishDate: '2026-10-26' }, '2026-10-26'), true)
    assertEq(scope.isSameWishDate({ wishDate: '2026-10-25' }, '2026-10-26'), false)
    assertEq(scope.isSameWishDate({}, '2026-10-26'), false, '无字段且无 createdAt → 不算同一天')
    assertEq(scope.isSameWishDate({ createdAt: bjTime(2026, 10, 26, 9, 0) }, '2026-10-26'), true, '历史文档同日兜底')
  })

  await testCase('[L1] D5 没有任何自动回填 wishDate 的迁移脚本（零迁移）', () => {
    const files = []
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue
        const full = path.join(d, e.name)
        if (e.isDirectory()) walk(full)
        else if (/\.(js|json)$/.test(e.name)) files.push(full)
      }
    }
    walk(path.join(ROOT, 'cloudfunctions'))
    walk(path.join(ROOT, 'scripts'))
    // 迁移特征：对 wishes 集合做 update，且写入内容里带 wishDate
    const MIGRATE = /collection\(\s*['"]wishes['"]\s*\)[\s\S]{0,300}?\.update\s*\(\s*\{\s*data\s*:\s*\{[^}]*wishDate/
    const hits = files.filter(f => MIGRATE.test(fs.readFileSync(f, 'utf8')))
    assertEq(hits.length, 0, '发现疑似迁移写入：' + hits.join(', '))
  })

  await testCase('[L1] D6 DEPLOYMENT.md 补上 wishDate 索引与字段口径', () => {
    const doc = read('docs/DEPLOYMENT.md')
    // 开源版索引表用 ↑ 表示升序（等价于私有仓库的 (asc) 写法）
    assertOk(/`wishDate`↑|`wishDate`\(asc\)/.test(doc), '缺 wishDate 复合索引')
    assertOk(/wishDate/.test(doc) && /历史心愿（没有 `wishDate`）|历史心愿（无 `wishDate`）/.test(doc), '缺历史数据兼容说明')
    assertOk(/判重键/.test(doc), '缺判重键口径')
    // 增量部署在开源包里并入 §4；写入方必须点名 dailyRecord.save
    assertOk(doc.includes('dailyRecord'), '文档缺 dailyRecord')
    assertOk(/只由 `dailyRecord\.save`/.test(doc), '缺 wishDate 写入方（dailyRecord.save）')
  })

  await testCase('[L1] D7 前端全仓不出现 wishDate（只有服务端能决定归属日期）', () => {
    const files = []
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name)
        if (e.isDirectory()) walk(full)
        else if (e.name.endsWith('.js') || e.name.endsWith('.wxml')) files.push(full)
      }
    }
    walk(path.join(ROOT, 'pages'))
    walk(path.join(ROOT, 'utils'))
    const hits = files.filter(f => fs.readFileSync(f, 'utf8').indexOf('wishDate') !== -1)
    assertEq(hits.length, 0, '前端出现了 wishDate：' + hits.join(', '))
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failures.length) {
    console.log('\n失败项：')
    for (const f of failures) console.log('  - ' + f)
    process.exitCode = 1
  } else {
    console.log('V1.1 Wish Date: ALL GREEN')
  }
}

main().catch(e => {
  console.error('测试脚本本身出错：', e)
  process.exitCode = 1
})
