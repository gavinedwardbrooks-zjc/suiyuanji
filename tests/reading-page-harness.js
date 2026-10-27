// ============================================================
// tests/reading-page-harness.js · 页面级真实执行管道（非 .test.js）
//
// 目的：让 pages/reading/reading.js 在 Node 下真实跑起来，
// 从而对 S2 的「本机导入」做行为测试，而不是只做源码字符串断言。
//
// 做法：
//   - 注入 global.wx / global.Page / global.getApp 后再 require 页面
//   - writingApi 用 stub 顶替（与阅读无关，避免网络分支干扰）
//   - 捕获 console.error/warn，保持测试输出干净并可断言
// ============================================================

const { createMockWx } = require('./mock-fs')
const { AtomicMockDB } = require('./mock-cloud-db')
const { makeCallFunction } = require('./mock-cloud-function')
const lb = require('../utils/localBooks')

// 云端路由（可选）：把 wx.cloud.callFunction('dailyRecord') 接到**真实云函数代码**上。
// 不开启时仍是回 {ok:true} 的空壳替身 —— 那时客户端用例只能验证自己的账本，
// 验证不到服务端幂等。需要验证端到端「重放不重复累计」时用 { cloudDb: true } 开启。
function setupCloudRoute(options) {
  const o = options || {}
  if (!o.cloudDb) return null
  const db = (o.cloudDb && typeof o.cloudDb === 'object' && typeof o.cloudDb.collection === 'function')
    ? o.cloudDb
    : new AtomicMockDB({
      daily_records: [],
      wishes: [],
      // cloudBooks 同时充当页面列表与云端 books 集合的夹具
      books: (Array.isArray(o.cloudBooks) ? o.cloudBooks : []).map(b => Object.assign({ minutes: 0 }, b))
    })
  const router = makeCallFunction(db, { openid: o.cloudOpenid || 'her_001' })
  return { db, router }
}

// 时钟控制：计时结算基于 Date.now()，测试必须能确定地推进时间，
// 否则「不足一分钟保留 / 满一分钟才记账」这类契约无法被真实验证。
function makeClock() {
  const state = { real: Date.now, value: 1700000000000, patched: false }
  return {
    use(start) {
      if (!state.patched) {
        state.real = Date.now
        Date.now = () => state.value
        state.patched = true
      }
      if (Number.isFinite(Number(start))) state.value = Number(start)
      return state.value
    },
    advance(ms) {
      if (!state.patched) this.use()
      state.value += Number(ms) || 0
      return state.value
    },
    now() { return state.value },
    restore() {
      if (state.patched) {
        Date.now = state.real
        state.patched = false
      }
    }
  }
}

function cloudApi(cloud) {
  return {
    db: cloud.db,
    openid: cloud.router.instance.openid,
    dump: () => cloud.db.dump(),
    records: date => cloud.db.dump().daily_records.filter(d => !date || d.date === date),
    record: date => cloud.db.dump().daily_records.filter(d => !date || d.date === date)[0] || null,
    book: id => cloud.db.dump().books.filter(b => b._id === id)[0] || null,
    stats: cloud.db.stats,
    seed: (col, doc) => cloud.db.seed(col, doc),
    gateOn: (col, method, n) => cloud.db.gateOn(col, method, n)
  }
}

function createReadingHarness(options) {
  const cloud = setupCloudRoute(options)
  const ctx = createMockWx(cloud
    ? Object.assign({}, options, { callFunctionHandler: cloud.router.callFunction })
    : (options || {}))
  const clock = makeClock()

  // writingApi stub：只在 require.cache 层顶替，不改动生产文件
  const writingPath = require.resolve('../utils/writingApi')
  require.cache[writingPath] = {
    id: writingPath,
    filename: writingPath,
    loaded: true,
    exports: {
      listWritings: () => Promise.resolve({ writings: [] })
    }
  }

  const pagePath = require.resolve('../pages/reading/reading.js')
  const captured = { errors: [], warns: [] }
  const original = { error: console.error, warn: console.warn }

  function startCapture() {
    console.error = (...args) => { captured.errors.push(args) }
    console.warn = (...args) => { captured.warns.push(args) }
  }

  function load() {
    global.wx = ctx.wx
    // 静默登录产物：删除云端记录前的归属复核读的是 getApp().globalData.openid。
    // 默认 null（等价于「登录尚未完成」），需要验证归属判断时用 { appOpenid } 注入。
    global.getApp = () => ({ globalData: { openid: (options && options.appOpenid) || null }, whenReady: cb => { if (cb) cb({}) } })
    let cfg = null
    global.Page = c => { cfg = c }
    delete require.cache[pagePath]
    require(pagePath)
    const page = Object.assign({}, cfg)
    page.data = JSON.parse(JSON.stringify(cfg.data || {}))
    page.setData = function (patch) { Object.assign(this.data, patch) }
    return page
  }

  startCapture()

  return {
    ctx,
    wx: ctx.wx,
    fs: ctx.fs,
    storage: ctx.storage,
    calls: ctx.calls,
    toasts: ctx.toasts,
    modals: ctx.modals,
    errors: captured.errors,
    warns: captured.warns,
    cloud: cloud ? cloudApi(cloud) : null,
    // 删除类用例需要看云端夹具当前内容（只影响 mock 内部副本）
    cloudBooksNow: () => ctx.cloudBooksNow(),
    load,
    // 模拟「重新进入 / 重新编译页面」：同一存储与文件系统上新建页面实例
    reload: load,
    // 时钟控制（计时契约测试用）
    useClock: start => clock.use(start),
    advanceClock: ms => clock.advance(ms),
    now: () => clock.now(),
    restoreClock: () => clock.restore(),
    // 让接下来的 n 次云函数调用失败（缺省 1 次）
    failNextCallFunctions: n => ctx.failNextCallFunctions(n),
    seedTempFile(name, size) {
      const p = 'http://tmp/' + name
      ctx.fs.seedTemp(p, size)
      return { name, path: p, size }
    },
    lastToast() {
      return ctx.toasts.length ? ctx.toasts[ctx.toasts.length - 1] : null
    },
    toastTitles() {
      return ctx.toasts.map(t => t.title)
    },
    dispose() {
      clock.restore()
      console.error = original.error
      console.warn = original.warn
      delete global.wx
      delete global.Page
      delete global.getApp
    }
  }
}

// ============================================================
// createTxtHarness · pages/reading-txt/reading-txt.js 的页面级执行管道
//
// TXT 阅读页的入参只有 localId，因此除了真实 require 页面外，还需要
// 能在测试里「造一本本机书」：index 里一条记录 + USER_DATA_PATH 下真实字节。
// ============================================================
function createTxtHarness(options) {
  const cloud = setupCloudRoute(options)
  const ctx = createMockWx(cloud
    ? Object.assign({}, options, { callFunctionHandler: cloud.router.callFunction })
    : (options || {}))
  const clock = makeClock()
  const pagePath = require.resolve('../pages/reading-txt/reading-txt.js')
  const captured = { errors: [], warns: [] }
  const original = { error: console.error, warn: console.warn }

  console.error = (...args) => { captured.errors.push(args) }
  console.warn = (...args) => { captured.warns.push(args) }

  function load() {
    global.wx = ctx.wx
    global.getApp = () => ({ globalData: {}, whenReady: cb => { if (cb) cb({}) } })
    let cfg = null
    global.Page = c => { cfg = c }
    delete require.cache[pagePath]
    require(pagePath)
    const page = Object.assign({}, cfg)
    page.data = JSON.parse(JSON.stringify(cfg.data || {}))
    page.setData = function (patch) { Object.assign(this.data, patch) }
    return page
  }

  function parseIndex() {
    const raw = ctx.storage.read(lb.STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  }

  function seedLocalBook(opts) {
    const o = opts || {}
    const ext = o.ext || 'txt'
    const localId = o.localId || 'lb_seed_1'
    const fileName = o.fileName || (localId + '.' + ext)
    const path = ctx.fs.userDataPath + '/books/' + fileName
    let size = 0
    if (o.bytes !== undefined && o.bytes !== null) {
      ctx.fs.seedFileBytes(path, o.bytes)
      size = ctx.fs.sizeOf(path) || 0
    } else if (o.text !== undefined) {
      ctx.fs.seedFileBytes(path, Buffer.from(String(o.text), 'utf8'))
      size = ctx.fs.sizeOf(path) || 0
    } else {
      const declared = Number.isFinite(Number(o.size)) ? Number(o.size) : 4096
      ctx.fs.seedFile(path, declared)
      size = declared
    }
    const idx = parseIndex() || { version: 1, updatedAt: 0, pendingApplied: {}, books: [] }
    idx.books = (idx.books || []).filter(b => b.localId !== localId)
    // 用 localBooks 自己的归一化写种子：这样索引里存的形状与 writeIndex 之后完全一致，
    // 测试里对「其他书一字未改」的 deepStrictEqual 才是强断言而不是形状差异误报
    idx.books.push(lb.normalizeEntry(Object.assign({
      localId,
      name: o.name || '测试本机书',
      ext,
      source: o.source || 'local',
      fileName,
      filePath: path,
      size,
      status: 'reading',
      progressPercent: 0,
      minutes: 0,
      missing: false,
      createdAt: 1000,
      updatedAt: 1000
    }, o.extra || {})))
    ctx.storage.write(lb.STORAGE_KEY, JSON.stringify(idx))
    return { localId, fileName, path, size }
  }

  return {
    ctx,
    wx: ctx.wx,
    fs: ctx.fs,
    storage: ctx.storage,
    calls: ctx.calls,
    toasts: ctx.toasts,
    modals: ctx.modals,
    errors: captured.errors,
    warns: captured.warns,
    cloud: cloud ? cloudApi(cloud) : null,
    load,
    // 真实走一遍 onLoad（返回 onLoad 的 Promise）
    open(query) {
      const page = load()
      page.__openResult = Promise.resolve(page.onLoad(query || {}))
      return page
    },
    seedLocalBook,
    parseIndex,
    // 时钟控制（计时契约测试用）
    useClock: start => clock.use(start),
    advanceClock: ms => clock.advance(ms),
    now: () => clock.now(),
    restoreClock: () => clock.restore(),
    failNextCallFunctions: n => ctx.failNextCallFunctions(n),
    entryOf(localId) {
      const idx = parseIndex()
      return ((idx && idx.books) || []).find(b => b.localId === localId) || null
    },
    lastToast() {
      return ctx.toasts.length ? ctx.toasts[ctx.toasts.length - 1] : null
    },
    toastTitles() {
      return ctx.toasts.map(t => t.title)
    },
    dispose() {
      clock.restore()
      console.error = original.error
      console.warn = original.warn
      delete global.wx
      delete global.Page
      delete global.getApp
    }
  }
}

module.exports = { createReadingHarness, createTxtHarness }
