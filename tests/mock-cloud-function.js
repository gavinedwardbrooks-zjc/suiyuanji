// ============================================================
// tests/mock-cloud-function.js · 用**真实云函数代码**跑服务端逻辑
//
// 只替换 wx-server-sdk（注入替身数据库），不改云函数一行。
// 支持载入**多份互相独立的实例**（模拟多个云函数容器 / 多次冷启动）：
// 每份实例都有独立的模块级状态与闭包，但共享同一个数据库 —— 这正是
// 「幂等性必须落在数据库上，不能落在进程内存里」这句话的可执行证明。
// ============================================================
const Module = require('module')
const path = require('path')

const FN_PATH = path.resolve(__dirname, '../cloudfunctions/dailyRecord/index.js')

function makeSdk(db, openid) {
  return {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    // 无论云函数里取几个句柄，都指向同一个数据库
    database: () => db,
    getWXContext: () => ({ OPENID: openid })
  }
}

// 载入一份独立的云函数实例
function loadInstance(db, opts) {
  const o = opts || {}
  const openid = o.openid === undefined ? 'her_001' : o.openid
  const origLoad = Module._load
  Module._load = function (request) {
    if (request === 'wx-server-sdk') return makeSdk(db, openid)
    return origLoad.apply(this, arguments)
  }
  try {
    delete require.cache[FN_PATH]
    const mod = require(FN_PATH)
    return {
      openid,
      modulePath: FN_PATH,
      main: (event, context) => mod.main(event || {}, context || {})
    }
  } finally {
    Module._load = origLoad
  }
}

// 载入 n 份实例，全部指向同一个 db
function loadInstances(db, n, opts) {
  const out = []
  for (let i = 0; i < n; i++) out.push(loadInstance(db, opts))
  return out
}

// wx.cloud.callFunction 形态的路由（客户端替身用）：只路由 dailyRecord，
// 其余云函数本替身不承载，按成功空结果返回（阅读模块只调用 dailyRecord）。
function makeCallFunction(db, opts) {
  const inst = loadInstance(db, opts)
  return {
    instance: inst,
    callFunction: async payload => {
      const name = payload && payload.name
      const data = payload && payload.data
      if (name !== 'dailyRecord') return { result: { ok: true, __stub: true } }
      return { result: await inst.main(data) }
    }
  }
}

module.exports = { FN_PATH, loadInstance, loadInstances, makeCallFunction }
