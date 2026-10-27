// ============================================================
// tests/notify-security.test.js · 通知体验优化 · 最后一轮定向安全检查
//
// 只回答五个问题（不重复造功能）：
//   1. markRead 的权限：只有「实际接收方」能标记已读，发送方不能清接收方的未读
//      （含双方收发、解绑、越权、旧数据兼容）
//   2. WISH_NOTIFY 开关：默认关闭，且**不允许仅靠环境变量**绕过模板用途校验
//   3. 订阅额度记账：ban / filter / reject / 调用失败都不得增加额度
//   4. 三份 notify.js 逐字节一致 + 新旧客户端互不报错
//   5. 全量回归（由外部跑全仓测试，本文件只管上面这些）
//
// 红线：不使用真实微信账号、不发送真实推送、不触碰真实数据库。
// 运行：node tests/notify-security.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { MockDB } = require('./mock-db')

const ROOT = path.resolve(__dirname, '..')
const NOTIFY_GPV = path.join(ROOT, 'cloudfunctions/getPartnerView/notify.js')
const NOTIFY_DR = path.join(ROOT, 'cloudfunctions/dailyRecord/notify.js')
const NOTIFY_MEN = path.join(ROOT, 'cloudfunctions/menstrual/notify.js')
const GPV_PATH = path.join(ROOT, 'cloudfunctions/getPartnerView/index.js')
const OURS_PATH = path.join(ROOT, 'pages/ours/ours.js')
const SUBUI_PATH = path.join(ROOT, 'utils/subscribe-feedback.js')

const NOTIFY = require(NOTIFY_GPV)
const SUBUI = require(SUBUI_PATH)
const TPL_CHAT = NOTIFY.DEFAULT_TEMPLATES.chat
const TPL_PERIOD = NOTIFY.DEFAULT_TEMPLATES.period

let passed = 0, failed = 0
const failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++
    console.log('  PASS  ' + name)
  }).catch(e => {
    failed++
    failures.push(name + ': ' + e.message)
    console.log('  FAIL  ' + name + '  -> ' + e.message)
  })
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a))
}
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }
function assertNo(hay, needle, msg) {
  if (String(hay).indexOf(needle) !== -1) throw new Error((msg || '') + ' 不应包含 ' + needle)
}

function quota(chat, period) {
  return { chat: chat || 0, period: period || 0, tpl: { chat: TPL_CHAT, period: TPL_PERIOD } }
}

// A = her，B = him，一对 active 情侣
function seed(extra) {
  return new MockDB(Object.assign({
    users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', nickName: '安安', subQuota: quota(0, 1) },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', subQuota: quota(2, 1) }
    ],
    couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'active', anniversary: null }],
    daily_records: [],
    wishes: [],
    messages: [],
    menstrual: []
  }, extra))
}

function msgDoc(id, from, extra) {
  return Object.assign({
    _id: id, coupleId: 'CZ-1', fromOpenid: from,
    fromRole: from === 'B' ? 'him' : 'her', text: '内容', readAt: null, createdAt: 1
  }, extra)
}

function mockCloud(opts) {
  const o = opts || {}
  const calls = []
  return {
    calls,
    openapi: {
      subscribeMessage: {
        send: async (params) => {
          calls.push(params)
          if (o.throwErr) {
            const e = new Error(o.throwErr.errMsg || 'send failed')
            e.errCode = o.throwErr.errCode
            throw e
          }
          return { errCode: 0 }
        }
      }
    }
  }
}

function loadCloudFn(name, db, state) {
  const origLoad = Module._load
  Module._load = function (request) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test',
        init() {},
        database: () => db,
        getWXContext: () => ({ OPENID: state.openid }),
        openapi: state.cloud.openapi
      }
    }
    return origLoad.apply(this, arguments)
  }
  const fnPath = path.join(ROOT, 'cloudfunctions', name, 'index.js')
  delete require.cache[fnPath]
  let mod
  try {
    mod = require(fnPath)
  } finally {
    Module._load = origLoad
  }
  return mod
}

function loadNotify() {
  delete require.cache[NOTIFY_GPV]
  return require(NOTIFY_GPV)
}

function clearEnv() {
  delete process.env.TPL_CHAT
  delete process.env.TPL_PERIOD
  delete process.env.WISH_NOTIFY
  delete process.env.NOTIFY_NAME
  delete process.env.MP_STATE
}

// ------------------------------------------------------------
// 「我们」页运行时替身（与 notify-experience.test.js 同源做法）
// ------------------------------------------------------------
function loadPage(opts) {
  const o = opts || {}
  let pageDef = null
  const toasts = []
  const modals = []
  const cloudCalls = []
  let subHandler = null

  const cfgPath = path.join(ROOT, 'config.js')
  delete require.cache[cfgPath]
  const CONFIG = require(cfgPath)
  const savedChat = CONFIG.SUB_TPL_CHAT
  const savedPeriod = CONFIG.SUB_TPL_PERIOD
  CONFIG.SUB_TPL_CHAT = 'TPL_CHAT_T'
  CONFIG.SUB_TPL_PERIOD = 'TPL_PERIOD_T'

  global.getApp = () => ({
    globalData: { openid: 'A', role: o.role || 'him', bindCode: null },
    whenReady: (cb) => cb({ openid: 'A' }),
    silentLogin() {}
  })
  global.Page = (def) => { pageDef = def }
  global.wx = global.wx || {}
  global.wx.getStorageSync = () => 0
  global.wx.setStorageSync = () => {}
  global.wx.removeStorageSync = () => {}
  global.wx.showToast = (x) => toasts.push(x.title)
  global.wx.showModal = (x) => modals.push(x)
  global.wx.requestSubscribeMessage = (x) => { if (subHandler) subHandler(x) }
  global.wx.switchTab = () => {}
  global.wx.navigateTo = () => {}
  global.wx.cloud = {
    callFunction({ name, data }) {
      cloudCalls.push({ name, data })
      if (o.onCall) {
        const r = o.onCall(name, data)
        if (r !== undefined) return Promise.resolve(r)
      }
      return Promise.resolve({ result: { ok: true, quota: { chat: 1, period: 1 } } })
    }
  }

  delete require.cache[OURS_PATH]
  delete require.cache[SUBUI_PATH]
  require(OURS_PATH)

  const p = Object.create(pageDef)
  p.data = JSON.parse(JSON.stringify(pageDef.data))
  p.setData = function (patch) { Object.assign(this.data, patch) }

  return {
    page: p,
    toasts,
    modals,
    cloudCalls,
    setSubHandler(fn) { subHandler = fn },
    cleanup() {
      CONFIG.SUB_TPL_CHAT = savedChat
      CONFIG.SUB_TPL_PERIOD = savedPeriod
    }
  }
}

const wait = (ms) => new Promise(r => setTimeout(r, ms || 10))

// ============================================================
// S · markRead 权限（只有实际接收方能标记已读）
// ============================================================
async function runMarkReadTests() {
  console.log('\n=== S · markRead 权限：接收方 / 发送方 / 解绑 / 越权 / 旧数据 ===\n')
  clearEnv()

  await testCase('S1 her 发给 him → him 能标记已读（readAt 真写入）', async () => {
    const db = seed({ messages: [msgDoc('m1', 'A')] })
    const mod = loadCloudFn('getPartnerView', db, { openid: 'B', cloud: mockCloud() })
    const r = await mod.main({ action: 'readMsg', msgId: 'm1' })
    assertEq(r.ok, true)
    assertEq(r.updated, 1)
    assertOk(db.dump().messages[0].readAt > 0, 'readAt 必须写入')
  })

  await testCase('S2 him 发给 her → her 能标记已读（方向对称，不是只给一个人做）', async () => {
    const db = seed({ messages: [msgDoc('m2', 'B')] })
    const mod = loadCloudFn('getPartnerView', db, { openid: 'A', cloud: mockCloud() })
    const r = await mod.main({ action: 'readMsg', msgId: 'm2' })
    assertEq(r.updated, 1)
    assertOk(db.dump().messages[0].readAt > 0)
  })

  await testCase('S3 发送方不能清掉自己消息的未读状态（updated=0，readAt 不变）', async () => {
    const db = seed({ messages: [msgDoc('m3', 'A')] })
    const mod = loadCloudFn('getPartnerView', db, { openid: 'A', cloud: mockCloud() })
    const r = await mod.main({ action: 'readMsg', msgId: 'm3' })
    assertEq(r.updated, 0, '发送方不是接收方，不得标记')
    assertEq(db.dump().messages[0].readAt, null)
  })

  await testCase('S4 消息来自「非另一半」的第三方 → 不能标记（fromOpenid 必须等于 partner）', async () => {
    const db = seed({ messages: [msgDoc('m4', 'X')] }) // X 既不是 her 也不是 him
    const mod = loadCloudFn('getPartnerView', db, { openid: 'A', cloud: mockCloud() })
    const r = await mod.main({ action: 'readMsg', msgId: 'm4' })
    assertEq(r.updated, 0, '不该由接收方之外的任何人清掉未读')
    assertEq(db.dump().messages[0].readAt, null)
  })

  await testCase('S5 跨情侣越权：拿别对情侣的 msgId → updated=0，且数据不动', async () => {
    const db = seed({
      couples: [
        { _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'active' },
        { _id: 'c2', coupleId: 'CZ-2', herOpenid: 'C', himOpenid: 'D', status: 'active' }
      ],
      users: [
        { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1' },
        { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1' },
        { _id: 'u_c', _openid: 'C', role: 'her', coupleId: 'CZ-2' },
        { _id: 'u_d', _openid: 'D', role: 'him', coupleId: 'CZ-2' }
      ],
      messages: [{ _id: 'm5', coupleId: 'CZ-2', fromOpenid: 'C', fromRole: 'her', text: '别人的', readAt: null, createdAt: 1 }]
    })
    const mod = loadCloudFn('getPartnerView', db, { openid: 'B', cloud: mockCloud() })
    const r = await mod.main({ action: 'readMsg', msgId: 'm5' })
    assertEq(r.updated, 0)
    assertEq(db.dump().messages[0].readAt, null)
  })

  await testCase('S6 解绑（couple 非 active）→ NOT_ACTIVE，一条都不写', async () => {
    const db = seed({
      couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'superseded' }],
      messages: [msgDoc('m6', 'A')]
    })
    const mod = loadCloudFn('getPartnerView', db, { openid: 'B', cloud: mockCloud() })
    const r = await mod.main({ action: 'readMsg', msgId: 'm6' })
    assertEq(r.ok, false)
    assertEq(r.code, 'NOT_ACTIVE', '关系失效后不允许任何写入')
    assertEq(db.dump().messages[0].readAt, null)
  })

  await testCase('S7 旧数据兼容：M5 之前没写 readAt 字段的老消息也能标记已读', async () => {
    const legacy = { _id: 'm7', coupleId: 'CZ-1', fromOpenid: 'A', fromRole: 'her', text: '老消息', createdAt: 1 }
    const db = seed({ messages: [legacy] })
    const mod = loadCloudFn('getPartnerView', db, { openid: 'B', cloud: mockCloud() })
    const r = await mod.main({ action: 'readMsg', msgId: 'm7' })
    assertEq(r.updated, 1, '字段缺失应等价于「未读」')
    assertOk(db.dump().messages[0].readAt > 0)
  })

  await testCase('S8 幂等：同一条已读消息再标一次 → updated=0，readAt 不被刷新', async () => {
    const db = seed({ messages: [msgDoc('m8', 'A', { readAt: 777 })] })
    const mod = loadCloudFn('getPartnerView', db, { openid: 'B', cloud: mockCloud() })
    const r = await mod.main({ action: 'readMsg', msgId: 'm8' })
    assertEq(r.updated, 0)
    assertEq(db.dump().messages[0].readAt, 777, '首次已读时间不得被覆盖')
  })

  await testCase('S9 关系不完整（couple 缺 himOpenid → 推不出另一半）→ NO_PARTNER，不写', async () => {
    const db = seed({
      couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: '', status: 'active' }],
      messages: [msgDoc('m9', 'B')]
    })
    const mod = loadCloudFn('getPartnerView', db, { openid: 'A', cloud: mockCloud() })
    const r = await mod.main({ action: 'readMsg', msgId: 'm9' })
    assertEq(r.ok, false, '无法确定「谁是接收方」时必须 fail-closed')
    assertEq(r.code, 'NO_PARTNER')
    assertEq(db.dump().messages[0].readAt, null)
  })

  await testCase('S10 客户端只为「对方发来的、未读的」消息发起 readMsg', async () => {
    const h = loadPage({
      role: 'him',
      onCall: (name, data) => {
        if (data && data.action === 'readMsg') return { result: { ok: true, updated: 1 } }
        if (name === 'getPartnerView' && (!data || !data.action)) {
          return {
            result: {
              ok: true, role: 'him', wishes: [], unreadMsgs: 2,
              messages: [
                { _id: 'mine', role: 'him', text: '我发的', createdAt: 3, readAt: null, mine: true },
                { _id: 'theirsRead', role: 'her', text: '读过', createdAt: 2, readAt: 99, mine: false },
                { _id: 'theirsNew', role: 'her', text: '没读', createdAt: 1, readAt: null, mine: false }
              ],
              myQuota: { chat: 0, period: 0 }, partnerQuota: { chat: 0, period: 0 }
            }
          }
        }
        return undefined
      }
    })
    h.page.loadPartner('A')
    await wait()
    const reads = h.cloudCalls.filter(c => c.data && c.data.action === 'readMsg')
    assertEq(reads.length, 1, '只该标记那一条未读的对方消息')
    assertEq(reads[0].data.msgId, 'theirsNew')
    h.cleanup()
  })

  await testCase('S11 客户端自报身份无效：event 里塞 fromOpenid / mine / role 都改不了判定', async () => {
    const db = seed({ messages: [msgDoc('m11', 'A')] })
    const mod = loadCloudFn('getPartnerView', db, { openid: 'A', cloud: mockCloud() }) // A 是发送方
    const r = await mod.main({
      action: 'readMsg', msgId: 'm11',
      fromOpenid: 'B', role: 'him', mine: false // 伪造
    })
    assertEq(r.updated, 0, '身份只来自 WXContext，前端入参不得参与')
    assertEq(db.dump().messages[0].readAt, null)
  })

  await testCase('S12 静态守卫：readMsg 用 where().update()（updateWhere 不是 SDK 的 API）', async () => {
    const src = fs.readFileSync(GPV_PATH, 'utf8')
    const block = src.slice(src.indexOf("event.action === 'readMsg'"), src.indexOf("event.action === 'setAnniversary'"))
    assertOk(/\.where\(\{[\s\S]*?\}\)\s*\.update\(/.test(block), 'readMsg 必须用官方 where().update()')
    assertNo(block, 'updateWhere', 'updateWhere 在真实云环境会抛 TypeError')
    assertOk(/fromOpenid:\s*partnerOpenid/.test(block), '必须限定「来自另一半」')
    assertOk(/readAt:\s*null/.test(block), '必须限定「还没读过」，保证幂等')
    assertOk(/coupleId:\s*couple\.coupleId/.test(block), '必须限定本对情侣，挡住越权')
    // 整个文件都不该再出现裸的 .updateWhere(...) 调用（注释里提到这个词是允许的）
    assertNo(src, '.updateWhere(', 'getPartnerView 不得直接调用 updateWhere')
  })
}

// ============================================================
// T · WISH_NOTIFY 开关（锁死，环境变量不可绕过）
// ============================================================
async function runWishGateTests() {
  console.log('\n=== T · 心愿通知闸门：默认关闭且不可用环境变量打开 ===\n')
  clearEnv()

  await testCase('T1 任何环境变量取值都无法打开闸门', async () => {
    for (const v of ['', 'off', '0', 'no', 'maybe', 'on', 'ON', 'On', 'true', 'TRUE', '1', 'yes', 'enable', ' ']) {
      assertEq(NOTIFY.isWishNotifyAllowed({ WISH_NOTIFY: v }), false, JSON.stringify(v) + ' 不得打开')
      process.env.WISH_NOTIFY = v
      assertEq(NOTIFY.isWishNotifyAllowed(process.env), false, 'process.env 下 ' + JSON.stringify(v) + ' 也不得打开')
      delete process.env.WISH_NOTIFY
    }
    assertEq(NOTIFY.WISH_NOTIFY_ENABLED, false, '代码级常量必须是 false')
  })

  await testCase('T2 三份副本都不再保留白名单开关（上一版的后门已删除）', async () => {
    for (const p of [NOTIFY_GPV, NOTIFY_DR, NOTIFY_MEN]) {
      const src = fs.readFileSync(p, 'utf8')
      assertNo(src, 'WISH_NOTIFY_ALLOWED', p + ' 仍有白名单常量')
      assertNo(src, "['on', 'true', '1', 'yes']", p + ' 仍有字符串白名单')
      const body = src.slice(src.indexOf('function isWishNotifyAllowed'), src.indexOf('// errCode 分类'))
      assertNo(body, 'process.env', p + ' 的闸门仍在读 process.env')
      assertOk(/return WISH_NOTIFY_ENABLED/.test(body), p + ' 的闸门必须直接返回常量')
    }
  })

  await testCase('T3 view 返回的 wishNotify 恒为 false（即使云函数里设了 WISH_NOTIFY=on）', async () => {
    process.env.WISH_NOTIFY = 'on'
    const db = seed()
    const mod = loadCloudFn('getPartnerView', db, { openid: 'A', cloud: mockCloud() })
    const r = await mod.main({})
    assertEq(r.ok, true)
    assertEq(r.wishNotify, false, '客户端不能被告知「心愿也会提醒」')
    delete process.env.WISH_NOTIFY
  })

  await testCase('T4 心愿保存成功，但绝不调用微信接口（WISH_NOTIFY=on 也一样）', async () => {
    process.env.WISH_NOTIFY = 'on'
    const db = seed()
    const cloud = mockCloud()
    const mod = loadCloudFn('dailyRecord', db, { openid: 'A', cloud })
    const r = await mod.main({ action: 'save', date: '2026-10-17', revision: 0, requestId: 't4', wishes: [{ type: 'eat', text: '火锅' }] })
    assertEq(r.ok, true, '记录与心愿必须保存成功')
    assertEq(r.wishNotifySent, false)
    assertEq(r.wishNotifyReason, 'wish_template_purpose_unverified')
    assertEq(cloud.calls.length, 0, '零微信调用')
    assertEq(db.dump().wishes.length, 1)
    assertEq(db.dump().wishes[0].createdNotifySkipped, true, '必须留下痕迹')
    delete process.env.WISH_NOTIFY
  })

  await testCase('T5 悄悄话不受影响（它本来就是聊天消息），仍是同一条路径', async () => {
    const db = seed()
    const cloud = mockCloud()
    const mod = loadCloudFn('getPartnerView', db, { openid: 'A', cloud })
    const r = await mod.main({ action: 'msg', text: '想你了', requestId: 't5' })
    assertEq(r.notifySent, true, 'reason=' + r.notifyReason)
    assertEq(cloud.calls.length, 1)
    assertEq(cloud.calls[0].templateId, TPL_CHAT)
  })

  await testCase('T6 客户端文案不承诺「加心愿会提醒」（wishNotify=false 时完全不提心愿）', async () => {
    const h = loadPage({ role: 'him' })
    const off = h.page.buildNotifyHint({ chat: 0 })
    assertNo(off, '心愿', 'wishNotify=false 时不得承诺心愿通知: ' + off)
    assertOk(off.indexOf('悄悄话') !== -1, '仍应说明悄悄话会提醒: ' + off)
    const on = h.page.buildNotifyHint({ chat: 3 })
    assertNo(on, '心愿', '额度文案也不得夹带心愿承诺: ' + on)
    assertOk(on.indexOf('3') !== -1, '应显示服务端记账的次数')
    h.cleanup()
  })
}

// ============================================================
// P · 额度记账：拒绝 / 拦截 / 失败都不得增加
// ============================================================
async function runQuotaTests() {
  console.log('\n=== P · 订阅额度：只有 accept 才 +1，其余一律不加 ===\n')
  clearEnv()

  // 逐个模拟 requestSubscribeMessage 的返回值，检查「有没有去记账」
  async function triggerSubscribe(resultKey) {
    const h = loadPage({ role: 'him' })
    h.setSubHandler((x) => {
      if (resultKey === 'fail') x.fail({ errMsg: 'requestSubscribeMessage:fail 20004' })
      else x.success({ TPL_CHAT_T: resultKey })
    })
    h.page.notifySub()
    await wait()
    const subCalls = h.cloudCalls.filter(c => c.data && c.data.action === 'sub')
    h.cleanup()
    return subCalls
  }

  await testCase('P1 accept → 恰好一次记账调用，且只申请 1 个通道', async () => {
    const subCalls = await triggerSubscribe('accept')
    assertEq(subCalls.length, 1)
    assertEq(JSON.stringify(subCalls[0].data.granted), JSON.stringify(['chat']), '一次授权只记 1 次')
  })

  await testCase('P2 reject → 完全不调用记账（拒绝不得 +1）', async () => {
    const subCalls = await triggerSubscribe('reject')
    assertEq(subCalls.length, 0, 'reject 还去记账就是凭空造额度')
  })

  await testCase('P3 ban → 完全不调用记账（被微信记住的拒绝也不能 +1）', async () => {
    const subCalls = await triggerSubscribe('ban')
    assertEq(subCalls.length, 0)
  })

  await testCase('P4 filter → 完全不调用记账（模板被平台过滤，不是授权成功）', async () => {
    const subCalls = await triggerSubscribe('filter')
    assertEq(subCalls.length, 0)
  })

  await testCase('P5 requestSubscribeMessage 调用失败 → 完全不调用记账', async () => {
    const subCalls = await triggerSubscribe('fail')
    assertEq(subCalls.length, 0)
  })

  await testCase('P6 服务端 sub：空 / 非法 granted 一律 ok:false 且不写库', async () => {
    for (const bad of [[], undefined, ['evil'], ['wish', 'msg'].slice(0, 0)]) {
      const db = seed()
      const before = JSON.stringify(db.dump().users)
      const mod = loadCloudFn('getPartnerView', db, { openid: 'A', cloud: mockCloud() })
      const r = await mod.main({ action: 'sub', granted: bad })
      assertEq(r.ok, false, JSON.stringify(bad) + ' 不该被接受')
      assertEq(JSON.stringify(db.dump().users), before, JSON.stringify(bad) + ' 不得写库')
    }
  })

  await testCase('P7 发送报 43101（未授权/用完）→ 额度归零，绝不是 +1', async () => {
    const db = seed()
    const cloud = mockCloud({ throwErr: { errCode: 43101, errMsg: 'user refuse to accept the msg' } })
    const mod = loadCloudFn('getPartnerView', db, { openid: 'A', cloud })
    const r = await mod.main({ action: 'msg', text: '在吗', requestId: 'p7' })
    assertEq(r.notifyReason, 'no_permission')
    const b = db.dump().users.find(u => u._openid === 'B')
    assertEq(b.subQuota.chat, 0, '归零才对：既不是 +1，也不是保持 2')
  })

  await testCase('P8 其它发送失败（-1 系统繁忙）→ 额度原封不动', async () => {
    const db = seed()
    const cloud = mockCloud({ throwErr: { errCode: -1, errMsg: 'system busy' } })
    const mod = loadCloudFn('getPartnerView', db, { openid: 'A', cloud })
    await mod.main({ action: 'msg', text: '在吗', requestId: 'p8' })
    const b = db.dump().users.find(u => u._openid === 'B')
    assertEq(b.subQuota.chat, 2, '失败既不能加也不能乱扣')
  })

  await testCase('P9 消息已发出但记账失败 → 仍返回 sent:true（不得谎报未发送）', async () => {
    const db = seed()
    db._data.__failOn = { col: 'users', method: 'update' } // 让 writeQuota 抛错
    const cloud = mockCloud()
    const mod = loadCloudFn('getPartnerView', db, { openid: 'A', cloud })
    const r = await mod.main({ action: 'msg', text: '在吗', requestId: 'p9' })
    assertEq(cloud.calls.length, 1, '消息确实已经发出去了')
    assertEq(r.notifySent, true, '发出去了却报失败 → 调用方会重发，用户收到重复消息')
    assertEq(r.notifyReason, 'ok')
    const b = db.dump().users.find(u => u._openid === 'B')
    assertEq(b.subQuota.chat, 2, '记账失败只影响估算，不会凭空 +1')
  })

  await testCase('P10 经期：没有额度 → 不调用微信接口（不反复尝试）', async () => {
    const db = seed({ users: [{ _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', subQuota: quota(0, 0) }] })
    const cloud = mockCloud()
    const notify = loadNotify()
    const r = await notify.sendPeriodReminder({
      db, cloud, env: {}, openid: 'A', nextStart: '2026-10-19', countdown: 2, lastStart: '2026-09-21'
    })
    assertEq(r.sent, false)
    assertEq(r.reason, 'no_quota')
    assertEq(cloud.calls.length, 0)
  })

  await testCase('P11 经期：43101 → 额度归零，不是 +1', async () => {
    const db = seed({ users: [{ _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', subQuota: quota(0, 1) }] })
    const cloud = mockCloud({ throwErr: { errCode: 43101 } })
    const notify = loadNotify()
    await notify.sendPeriodReminder({
      db, cloud, env: {}, openid: 'A', nextStart: '2026-10-19', countdown: 2, lastStart: '2026-09-21'
    })
    assertEq(db.dump().users[0].subQuota.period, 0)
  })

  await testCase('P12 经期：已发出但记账失败 → sent:true（否则幂等标记不会落，明天会重复发）', async () => {
    const db = seed({ users: [{ _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', subQuota: quota(0, 1) }] })
    db._data.__failOn = { col: 'users', method: 'update' }
    const cloud = mockCloud()
    const notify = loadNotify()
    const r = await notify.sendPeriodReminder({
      db, cloud, env: {}, openid: 'A', nextStart: '2026-10-19', countdown: 2, lastStart: '2026-09-21'
    })
    assertEq(cloud.calls.length, 1)
    assertEq(r.sent, true)
    assertEq(r.reason, 'ok')
  })
}

// ============================================================
// V · 一致性与新旧客户端兼容
// ============================================================
async function runCompatTests() {
  console.log('\n=== V · 三份 notify.js 一致 + 新旧客户端兼容 ===\n')
  clearEnv()

  function md5(p) { return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') }

  await testCase('V1 三个云函数的 notify.js 逐字节一致（云函数独立打包，不能 require 共享）', async () => {
    const a = md5(NOTIFY_GPV), b = md5(NOTIFY_DR), c = md5(NOTIFY_MEN)
    assertEq(b, a, 'dailyRecord 已漂移')
    assertEq(c, a, 'menstrual 已漂移')
    const ba = fs.readFileSync(NOTIFY_GPV)
    assertOk(ba.equals(fs.readFileSync(NOTIFY_DR)), '字节级不一致（dailyRecord）')
    assertOk(ba.equals(fs.readFileSync(NOTIFY_MEN)), '字节级不一致（menstrual）')
  })

  await testCase('V2 view 的返回字段「只增不改」：旧客户端读的字段一个都没少', async () => {
    const db = seed({ messages: [msgDoc('v2', 'A')] })
    const mod = loadCloudFn('getPartnerView', db, { openid: 'B', cloud: mockCloud() })
    const r = await mod.main({})
    for (const k of ['ok', 'role', 'score', 'wishes', 'messages', 'unreadMsgs', 'anniversary', 'days',
      'nextStart', 'nextLabel', 'partnerSummary', 'partnerSummaryAt', 'partnerRole']) {
      assertOk(Object.prototype.hasOwnProperty.call(r, k), '旧字段丢了: ' + k)
    }
    // 新增字段（旧客户端会忽略，不影响解析）
    for (const k of ['myQuota', 'partnerQuota', 'wishNotify']) {
      assertOk(Object.prototype.hasOwnProperty.call(r, k), '新字段缺失: ' + k)
    }
    const m = r.messages[0]
    for (const k of ['_id', 'role', 'text', 'createdAt', 'readAt', 'mine']) {
      assertOk(Object.prototype.hasOwnProperty.call(m, k), '留言旧字段丢了: ' + k)
    }
  })

  await testCase('V3 新客户端 + 旧云函数（响应里没有新字段）→ 不抛错，按「未开启」降级', async () => {
    const h = loadPage({
      role: 'him',
      onCall: (name, data) => {
        if (name === 'getPartnerView' && (!data || !data.action)) {
          // 旧版云函数的响应：没有 myQuota / partnerQuota / wishNotify
          return { result: { ok: true, role: 'him', wishes: [], messages: [], unreadMsgs: 0, score: 0 } }
        }
        return undefined
      }
    })
    let threw = false
    try { h.page.loadPartner('A'); await wait() } catch (e) { threw = true }
    assertOk(!threw, '缺字段不得让页面崩掉')
    assertEq(h.page.data.myQuotaTotal, 0, '没有额度字段就按 0 处理')
    assertEq(h.page.data.wishNotify, false, '没有 wishNotify 就按「不发心愿」处理（fail-closed）')
    assertOk(typeof h.page.data.notifyHint === 'string' && h.page.data.notifyHint.length > 0, '文案必须照常给出')
    assertNo(h.page.data.notifyHint, '心愿', '不知道能不能发，就不许承诺')
    h.cleanup()
  })

  await testCase('V4 新客户端 + 旧云函数（不认识 sub action）→ 如实说「记录未成功」，不谎报已开启', async () => {
    const h = loadPage({
      role: 'him',
      onCall: (name, data) => {
        if (data && data.action === 'sub') return { result: { ok: false, code: 'BAD_ACTION' } }
        return undefined
      }
    })
    h.setSubHandler((x) => x.success({ TPL_CHAT_T: 'accept' }))
    h.page.notifySub()
    await wait()
    const all = h.toasts.join(' | ')
    assertNo(all, '已开启', '服务端没记账就不能说已开启')
    assertOk(all.indexOf('记录未成功') !== -1, '必须如实告知: ' + all)
    h.cleanup()
  })

  await testCase('V5 旧客户端 + 新云函数：不调用 readMsg/sub 时，主要行为与之前一致', async () => {
    const db = seed({ messages: [msgDoc('v5', 'A')] })
    const mod = loadCloudFn('getPartnerView', db, { openid: 'B', cloud: mockCloud() })
    const view = await mod.main({}) // 旧客户端只会调用默认 view
    assertEq(view.ok, true)
    assertEq(view.role, 'him')
    assertEq(view.messages.length, 1)
    assertEq(view.unreadMsgs, 1, '旧客户端不调 readMsg → 未读照旧存在，不会凭空消失')
    assertEq(db.dump().messages[0].readAt, null)
  })

  await testCase('V6 三个云函数 config.json：openapi 权限 + timeout=20（默认 3s 会超时）', async () => {
    for (const name of ['getPartnerView', 'dailyRecord', 'menstrual']) {
      const p = path.join(ROOT, 'cloudfunctions', name, 'config.json')
      const c = JSON.parse(fs.readFileSync(p, 'utf8'))
      assertEq(c.timeout, 20, name + ' 缺 timeout')
      assertOk((c.permissions && c.permissions.openapi || []).indexOf('subscribeMessage.send') !== -1, name + ' 缺 openapi 权限')
    }
  })
}

// ==================== 主流程 ====================
;(async () => {
  console.log('========================================')
  console.log(' 通知安全定向检查 · 测试')
  console.log('========================================')
  await runMarkReadTests()
  await runWishGateTests()
  await runQuotaTests()
  await runCompatTests()

  console.log('\n========================================')
  console.log(' 结果: ' + passed + ' PASS / ' + failed + ' FAIL')
  if (failures.length) {
    console.log(' 失败项:')
    failures.forEach(f => console.log('   · ' + f))
    console.log('========================================')
    process.exit(1)
  }
  console.log('========================================')
})().catch(e => {
  console.error('SUITE CRASH', e)
  process.exit(1)
})
