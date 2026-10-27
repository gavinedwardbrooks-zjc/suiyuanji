// ============================================================
// tests/couple-notify.test.js · 情侣事件微信订阅消息（合并模板 A · 3377）
//
// 覆盖：
//   N · notify.js 纯模块：模板解析 / 字段映射 / 身份推导 / 配额 / 发送 / 错误分类
//   P · getPartnerView 集成：悄悄话通知、requestId 幂等、订阅记账
//   Q · dailyRecord 集成：新增心愿通知、重复保存不通知、通知失败不影响业务
//   R · 安全与部署静态约束
//   S · 客户端订阅交互（wx.requestSubscribeMessage）
//
// 本轮的契约变化（相对旧版「心愿/悄悄话各一个模板」）：
//   · 两种事件共用模板 A（chat 通道）：thing1 通知类型 / thing3 消息来自
//     / thing5 备注 / time6 消息时间；
//   · 配额按「通道」记账：一次授权只 +1，不会因为传了 wish+msg 就 +2；
//   · 模板换了以后旧记账不作数（subQuota.tpl 记着当时用的模板 ID）。
//
// 平台事实（测试必须与之对齐，不允许造「假成功」）：
//   · 微信没有「查询剩余可发送次数」接口 → 配额只是服务端记账；
//   · 模板被显式关掉 → reason='no_template'，绝不假装已发送；
//   · 通知失败永不回滚已保存的心愿 / 悄悄话。
//
// 运行：node tests/couple-notify.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const fs = require('fs')
const { MockDB } = require('./mock-db')

const ROOT = path.resolve(__dirname, '..')
const NOTIFY_GPV = path.join(ROOT, 'cloudfunctions/getPartnerView/notify.js')
const NOTIFY_DR = path.join(ROOT, 'cloudfunctions/dailyRecord/notify.js')
const NOTIFY_MEN = path.join(ROOT, 'cloudfunctions/menstrual/notify.js')

const notifyMod = require(NOTIFY_GPV)
const TPL_CHAT = notifyMod.DEFAULT_TEMPLATES.chat
const TPL_PERIOD = notifyMod.DEFAULT_TEMPLATES.period

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

// 服务端记账口径的配额（带模板标记，否则会被 scopedQuota 判为「旧模板记账」而归零）
function quota(chat, period) {
  return {
    chat: chat || 0,
    period: period || 0,
    tpl: { chat: TPL_CHAT, period: TPL_PERIOD }
  }
}

// ------------------------------------------------------------
// 公共装配
// ------------------------------------------------------------
function seedCouple(extra) {
  return new MockDB(Object.assign({
    users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', nickName: '安安', subQuota: quota(0, 0) },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', subQuota: quota(2, 1) }
    ],
    couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'active', anniversary: null }],
    daily_records: [],
    wishes: [],
    messages: [],
    menstrual: []
  }, extra))
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

function loadNotify() {
  delete require.cache[NOTIFY_GPV]
  return require(NOTIFY_GPV)
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

function clearTplEnv() {
  delete process.env.TPL_CHAT
  delete process.env.TPL_PERIOD
  delete process.env.TPL_WISH
  delete process.env.TPL_MSG
  delete process.env.TPL_ARRANGE
  delete process.env.NOTIFY_NAME
  delete process.env.WISH_NOTIFY
}

// 心愿通知已**永久锁死**（见 notify.isWishNotifyAllowed）。
// 本文件 N / Q 两组测的是**发送机制本身**（字段、配额、角色、幂等、失败降级），
// 因此涉及「真的发出去」的用例一律用 kind='msg'（悄悄话，不受用途闸门限制）；
// 心愿话术通过 FIELD_MAP.chat({kind:'wish'}) 这个纯函数直接断言。
// 闸门本身（含「环境变量无法绕过」）由 tests/notify-security.test.js 守护。

const THING_MAX = 20
const timeReg = /^\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/

// ==================== N. notify.js 纯模块 ====================
async function runNotifyUnitTests() {
  console.log('\n=== N · notify.js：模板 / 字段 / 身份 / 配额 / 发送 ===\n')
  clearTplEnv()

  await testCase('N1 三份 notify.js 内容完全一致（云函数独立打包，必须同源）', async () => {
    const a = fs.readFileSync(NOTIFY_GPV, 'utf8')
    const b = fs.readFileSync(NOTIFY_DR, 'utf8')
    const c = fs.readFileSync(NOTIFY_MEN, 'utf8')
    assertOk(a === b, 'getPartnerView/notify.js 与 dailyRecord/notify.js 已漂移')
    assertOk(a === c, 'getPartnerView/notify.js 与 menstrual/notify.js 已漂移')
    assertOk(a.length > 2000, '副本内容异常')
  })

  await testCase('N2 内置模板 ID 与 config.js 完全一致（否则客户端申请的和云端发的不是同一个模板）', async () => {
    delete require.cache[path.join(ROOT, 'config.js')]
    const CONFIG = require(path.join(ROOT, 'config.js'))
    assertEq(CONFIG.SUB_TPL_CHAT, TPL_CHAT, 'chat 模板 ID 不一致')
    assertEq(CONFIG.SUB_TPL_PERIOD, TPL_PERIOD, 'period 模板 ID 不一致')
    assertEq(notifyMod.readTemplates({}).chat, TPL_CHAT, '缺省应使用内置模板')
    assertEq(notifyMod.readTemplates({ TPL_CHAT: 'OVERRIDE' }).chat, 'OVERRIDE', '环境变量应可覆盖')
    // 显式置空 = 关掉该通道
    assertEq(notifyMod.readTemplates({ TPL_CHAT: '' }).chat, '', '空串应视为关闭该通道')
  })

  await testCase('N3 模板被关掉 → no_template，且绝不调用发送接口', async () => {
    const db = seedCouple()
    const cloud = mockCloud()
    const notify = loadNotify()
    const r = await notify.sendCoupleNotice({ db, cloud, env: { TPL_CHAT: '' }, openid: 'A', kind: 'msg' })
    assertEq(r.sent, false)
    assertEq(r.reason, 'no_template')
    assertEq(cloud.calls.length, 0, '未配置模板时不得触碰微信接口')
  })

  await testCase('N4 未绑定（users 无 coupleId）→ not_bound', async () => {
    const db = seedCouple({ users: [{ _id: 'u_a', _openid: 'A', role: 'her', subQuota: quota(5, 5) }] })
    const cloud = mockCloud()
    const notify = loadNotify()
    const r = await notify.sendCoupleNotice({ db, cloud, env: process.env, openid: 'A', kind: 'msg' })
    assertEq(r.reason, 'not_bound')
    assertEq(cloud.calls.length, 0)
  })

  await testCase('N5 couples 非 active（已解绑/过期）→ not_active，不发给旧伴侣', async () => {
    const db = seedCouple({ couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'superseded' }] })
    const cloud = mockCloud()
    const notify = loadNotify()
    const r = await notify.sendCoupleNotice({ db, cloud, env: process.env, openid: 'A', kind: 'msg' })
    assertEq(r.reason, 'not_active')
    assertEq(cloud.calls.length, 0)
  })

  await testCase('N6 接收者等于调用者 → self_target，绝不发给自己', async () => {
    const db = seedCouple({ couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'B', himOpenid: 'B', status: 'active' }] })
    const cloud = mockCloud()
    const notify = loadNotify()
    const r = await notify.sendCoupleNotice({ db, cloud, env: process.env, openid: 'B', kind: 'msg' })
    assertEq(r.reason, 'self_target')
    assertEq(cloud.calls.length, 0)
  })

  await testCase('N7 接收者配额为 0 → no_quota，不盲发', async () => {
    const db = seedCouple({ users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', subQuota: quota(5, 5) },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', subQuota: quota(0, 0) }
    ] })
    const cloud = mockCloud()
    const notify = loadNotify()
    const r = await notify.sendCoupleNotice({ db, cloud, env: process.env, openid: 'A', kind: 'msg' })
    assertEq(r.reason, 'no_quota')
    assertEq(cloud.calls.length, 0)
  })

  await testCase('N8 正常发送 → touser 为伴侣、模板 A、落地页「我们」', async () => {
    const db = seedCouple()
    const cloud = mockCloud()
    const notify = loadNotify()
    const r = await notify.sendCoupleNotice({ db, cloud, env: process.env, openid: 'A', kind: 'msg' })
    assertEq(r.sent, true, 'reason=' + r.reason)
    assertEq(r.channel, 'chat')
    assertEq(cloud.calls.length, 1)
    const p = cloud.calls[0]
    assertEq(p.touser, 'B', '必须发给服务端推导出的伴侣')
    assertEq(p.templateId, TPL_CHAT, '必须用合并后的聊天模板')
    assertEq(p.page, 'pages/ours/ours', '点击后应落到「我们」页')
    assertEq(p.miniprogramState, 'formal')
  })

  await testCase('N9 字段精确：只有 thing1 / thing3 / thing5 / time6，多一个都会被微信拒', async () => {
    const db = seedCouple()
    const cloud = mockCloud()
    const notify = loadNotify()
    // 真正会发出去的是「悄悄话」（心愿已被用途闸门拦下，见 notify-security.test.js），线上报文以它取样
    await notify.sendCoupleNotice({ db, cloud, env: process.env, openid: 'A', kind: 'msg', at: Date.now() })
    const data = cloud.calls[0].data
    assertEq(Object.keys(data).sort().join(','), 'thing1,thing3,thing5,time6')
    assertEq(data.thing1.value, '新悄悄话', '通知类型')
    assertEq(data.thing3.value, '安安', '消息来自（她的昵称）')
    assertEq(data.thing5.value, 'TA 给你留了一句话', '备注')
    // 心愿话术仍由同一个 FIELD_MAP.chat 生成：闸门只决定「发不发」，不改字段结构
    const wishFields = notify.FIELD_MAP.chat({ kind: 'wish', senderRole: 'her', senderName: '安安', at: Date.now() })
    assertEq(Object.keys(wishFields).sort().join(','), 'thing1,thing3,thing5,time6')
    assertEq(wishFields.thing1.value, '新心愿')
    assertEq(wishFields.thing5.value, 'TA 新增了一条心愿')
  })

  await testCase('N10 两种事件共用同一套模板字段，但只有悄悄话会真的发出去', async () => {
    const db = seedCouple()
    const cloud = mockCloud()
    const notify = loadNotify()
    const rw = await notify.sendCoupleNotice({ db, cloud, env: process.env, openid: 'A', kind: 'wish' })
    const rm = await notify.sendCoupleNotice({ db, cloud, env: process.env, openid: 'A', kind: 'msg' })
    assertEq(rw.sent, false, '心愿必须被用途闸门拦下')
    assertEq(rw.reason, 'wish_template_purpose_unverified')
    assertEq(rm.sent, true, 'reason=' + rm.reason)
    assertEq(cloud.calls.length, 1, '心愿再也不能借聊天模板发出去')
    assertEq(cloud.calls[0].templateId, TPL_CHAT)
    assertEq(cloud.calls[0].data.thing1.value, '新悄悄话')
    assertEq(cloud.calls[0].data.thing5.value, 'TA 给你留了一句话')
  })

  await testCase('N11 time6 用微信 time 类型格式「YYYY年M月D日 HH:mm」且为北京时间', async () => {
    const db = seedCouple()
    const cloud = mockCloud()
    const notify = loadNotify()
    // 用 Date.UTC 构造绝对时间戳（UTC 06:05 = 北京 14:05），断言不依赖测试机本地时区
    const at = Date.UTC(2026, 9, 17, 6, 5)
    await notify.sendCoupleNotice({ db, cloud, env: process.env, openid: 'A', kind: 'msg', at })
    const v = cloud.calls[0].data.time6.value
    assertOk(timeReg.test(v), 'time6 格式不合法: ' + v)
    assertEq(v, '2026年10月17日 14:05', 'time6 必须显示北京时间（UTC+8），不能是 UTC 本地时区')
  })

  await testCase('N12 thing 字段都在 20 个字符以内（微信硬限制）', async () => {
    const db = seedCouple()
    const cloud = mockCloud()
    const notify = loadNotify()
    await notify.sendCoupleNotice({ db, cloud, env: process.env, openid: 'A', kind: 'wish' })
    await notify.sendCoupleNotice({ db, cloud, env: process.env, openid: 'A', kind: 'msg' })
    for (const call of cloud.calls) {
      for (const k of ['thing1', 'thing3', 'thing5']) {
        const v = String(call.data[k].value)
        assertOk(v.length <= THING_MAX, k + ' 超过 20 字符: ' + v)
      }
    }
  })

  await testCase('N13 隐私：通知里不出现悄悄话/心愿正文', async () => {
    const db = seedCouple({
      messages: [{ _id: 'm1', coupleId: 'CZ-1', fromOpenid: 'A', text: '我不开心，因为今天被领导骂了' }]
    })
    const cloud = mockCloud()
    const notify = loadNotify()
    await notify.sendCoupleNotice({ db, cloud, env: process.env, openid: 'A', kind: 'msg' })
    const wire = JSON.stringify(cloud.calls[0])
    assertOk(wire.indexOf('领导') === -1, '通知 payload 泄露了悄悄话正文')
    assertOk(wire.indexOf('不开心') === -1, '通知 payload 泄露了悄悄话正文')
  })

  await testCase('N14 发送成功扣的是**接收者**的 chat 额度，发送者不动', async () => {
    const db = seedCouple()
    const cloud = mockCloud()
    const notify = loadNotify()
    await notify.sendCoupleNotice({ db, cloud, env: process.env, openid: 'A', kind: 'msg' })
    const users = db.dump().users
    const b = users.find(u => u._openid === 'B')
    const a = users.find(u => u._openid === 'A')
    assertEq(b.subQuota.chat, 1, '接收者 B 的 chat 额度应从 2 扣到 1')
    assertEq(a.subQuota.chat, 0, '发送者 A 的额度不应被动')
    assertEq(b.subQuota.tpl.chat, TPL_CHAT, '应记录当前模板，换模板后旧额度自动作废')
  })

  await testCase('N15 43101（用户未授权）→ 不抛错、reason=no_permission、接收者额度归零', async () => {
    const db = seedCouple()
    const cloud = mockCloud({ throwErr: { errCode: 43101, errMsg: 'user refuse to accept the msg' } })
    const notify = loadNotify()
    let threw = false
    let r
    try {
      r = await notify.sendCoupleNotice({ db, cloud, env: process.env, openid: 'A', kind: 'msg' })
    } catch (e) { threw = true }
    assertOk(!threw, '通知失败必须被吞掉，不能向上抛（否则会拖垮业务）')
    assertEq(r.sent, false)
    assertEq(r.reason, 'no_permission')
    const b = db.dump().users.find(u => u._openid === 'B')
    assertEq(b.subQuota.chat, 0, '明确无授权 → 接收者额度归零，避免无意义重试')
  })

  await testCase('N16 40003（openid 非法）→ invalid_openid，额度不动', async () => {
    const db = seedCouple()
    const cloud = mockCloud({ throwErr: { errCode: 40003, errMsg: 'invalid openid' } })
    const notify = loadNotify()
    const r = await notify.sendCoupleNotice({ db, cloud, env: process.env, openid: 'A', kind: 'msg' })
    assertEq(r.reason, 'invalid_openid')
    const b = db.dump().users.find(u => u._openid === 'B')
    assertEq(b.subQuota.chat, 2, '非法 openid 不属于「用户拒绝」，不应归零额度')
  })

  await testCase('N17 47003（模板字段不匹配）→ bad_field，属于可诊断的配置错误', async () => {
    const db = seedCouple()
    const cloud = mockCloud({ throwErr: { errCode: 47003, errMsg: 'argument invalid' } })
    const notify = loadNotify()
    const r = await notify.sendCoupleNotice({ db, cloud, env: process.env, openid: 'A', kind: 'msg' })
    assertEq(r.reason, 'bad_field')
  })

  await testCase('N18 失败日志不含 openid、不含私密正文', async () => {
    const db = seedCouple()
    const cloud = mockCloud({ throwErr: { errCode: -1, errMsg: 'system busy' } })
    const notify = loadNotify()
    const logs = []
    const origWarn = console.warn
    console.warn = (...args) => logs.push(args.map(x => String(x)).join(' '))
    try {
      await notify.sendCoupleNotice({ db, cloud, env: process.env, openid: 'A', kind: 'msg' })
    } finally {
      console.warn = origWarn
    }
    assertOk(logs.length >= 1, '失败应留下诊断日志')
    const all = logs.join('\n')
    assertOk(all.indexOf('"A"') === -1 && all.indexOf('"B"') === -1, '日志泄露了 openid: ' + all)
    assertEq(JSON.parse(logs[0].replace('[couple-notify] ', '')).reason, 'system_busy')
  })

  await testCase('N19 合并模板后一次授权只 +1：同时传 wish 与 msg 不得记成 2 次', async () => {
    const db = seedCouple()
    const notify = loadNotify()
    const r = await notify.grantQuota(db, 'A', ['wish', 'msg'], notify.readTemplates({}))
    assertEq(r.ok, true)
    assertEq(r.quota.chat, 1, '同一模板只应 +1')
    assertEq(r.quota.period, 0)
    // 再来一次才是 2
    const r2 = await notify.grantQuota(db, 'A', ['chat'], notify.readTemplates({}))
    assertEq(r2.quota.chat, 2)
  })

  await testCase('N20 grantQuota 过滤非法通道，只认 chat / period', async () => {
    const db = seedCouple()
    const notify = loadNotify()
    const r = await notify.grantQuota(db, 'A', ['wish', 'evil', 123, 'period'], notify.readTemplates({}))
    assertEq(r.ok, true)
    assertEq(r.quota.chat, 1)
    assertEq(r.quota.period, 1)
    assertEq(Object.keys(r.quota).sort().join(','), 'chat,period', '不得写入额外字段')
    const bad = await notify.grantQuota(db, 'A', ['evil'], notify.readTemplates({}))
    assertEq(bad.ok, false)
  })

  await testCase('N21 旧版 {wish,msg} 记账不计入 chat（模板换了，旧额度作废）', async () => {
    const db = seedCouple({ users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', subQuota: { wish: 3, msg: 2 } },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', subQuota: { wish: 1, msg: 1 } }
    ] })
    const cloud = mockCloud()
    const notify = loadNotify()
    const r = await notify.sendCoupleNotice({ db, cloud, env: process.env, openid: 'A', kind: 'msg' })
    assertEq(r.reason, 'no_quota', '旧模板额度不能用于新模板，否则就是虚报可发')
    assertEq(cloud.calls.length, 0)
    const q = notify.scopedQuota({ wish: 3, msg: 2 }, notify.readTemplates({}))
    assertEq(q.chat, 0)
    assertEq(q.period, 0)
  })

  await testCase('N22 normalizeQuota：负数 / 非数字 / 缺失 → 0', async () => {
    const notify = loadNotify()
    assertEq(JSON.stringify(notify.normalizeQuota({ chat: -3, period: 'abc' })), JSON.stringify({ chat: 0, period: 0 }))
    assertEq(JSON.stringify(notify.normalizeQuota(null)), JSON.stringify({ chat: 0, period: 0 }))
    assertEq(JSON.stringify(notify.normalizeQuota({ chat: 2 })), JSON.stringify({ chat: 2, period: 0 }))
  })

  await testCase('N23 expectRole 限定发送者角色：him 建心愿 → 不发给她', async () => {
    const db = seedCouple({ users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', subQuota: quota(2, 0) },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', subQuota: quota(2, 0) }
    ] })
    const cloud = mockCloud()
    const notify = loadNotify()
    const r = await notify.sendCoupleNotice({ db, cloud, env: process.env, openid: 'B', kind: 'wish', expectRole: 'her' })
    assertEq(r.sent, false)
    assertEq(r.reason, 'not_sender_role')
    assertEq(cloud.calls.length, 0, '不该发给她一条指向不存在内容的通知')
  })

  await testCase('N24 expectRole 命中（her 发起的事件）→ 正常发送', async () => {
    const db = seedCouple()
    const cloud = mockCloud()
    const notify = loadNotify()
    // expectRole 是「角色闸门」的机制测试，与事件类型无关；用悄悄话取证（心愿已被用途闸门拦下）
    const r = await notify.sendCoupleNotice({ db, cloud, env: process.env, openid: 'A', kind: 'msg', expectRole: 'her' })
    assertEq(r.sent, true, 'reason=' + r.reason)
    assertEq(cloud.calls[0].touser, 'B')
  })

  await testCase('N25 角色缺失（历史脏数据）→ 视为不匹配，宁可不发', async () => {
    const db = seedCouple({ users: [
      { _id: 'u_a', _openid: 'A', coupleId: 'CZ-1' },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', subQuota: quota(1, 1) }
    ] })
    const cloud = mockCloud()
    const notify = loadNotify()
    const r = await notify.sendCoupleNotice({ db, cloud, env: process.env, openid: 'A', kind: 'wish', expectRole: 'her' })
    assertEq(r.reason, 'not_sender_role')
    assertEq(cloud.calls.length, 0)
  })

  await testCase('N26 悄悄话不设角色限制：him 发给她也能通知，且文案用「他」', async () => {
    const db = seedCouple({ users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', subQuota: quota(1, 0) },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', subQuota: quota(1, 0) }
    ] })
    const cloud = mockCloud()
    const notify = loadNotify()
    const r = await notify.sendCoupleNotice({ db, cloud, env: process.env, openid: 'B', kind: 'msg' })
    assertEq(r.sent, true, 'reason=' + r.reason)
    assertEq(cloud.calls[0].touser, 'A')
    assertEq(cloud.calls[0].data.thing5.value, 'TA 给你留了一句话', '备注应按发送者角色切换')
    assertEq(cloud.calls[0].data.thing3.value, '你的另一半', '他没设昵称时不能误用她的名字')
  })

  await testCase('N27 自定义昵称优先；默认昵称/空值一律回退到通用称呼（不写死姓名）', async () => {
    const notify = loadNotify()
    assertEq(notify.senderNameOf('小宇', 'her'), '小宇', '用户自己设的昵称要用')
    assertEq(notify.senderNameOf('她', 'her'), '你的另一半', '默认昵称不算名字')
    assertEq(notify.senderNameOf('', 'him'), '你的另一半')
    assertEq(notify.senderNameOf(undefined, 'her'), '你的另一半', '取不到昵称时不得回退到个人姓名')
    assertEq(notify.senderNameOf('他', 'him'), '你的另一半')
  })

  await testCase('N28 模板 B 字段精确：date1 / number2 / time4，格式符合微信要求', async () => {
    const notify = loadNotify()
    const data = notify.FIELD_MAP.period({ nextStart: '2026-10-31', countdown: 2, lastStart: '2026-10-03' })
    assertEq(Object.keys(data).sort().join(','), 'date1,number2,time4')
    assertEq(data.date1.value, '2026年10月31日', 'date 类型：年月日')
    assertEq(data.number2.value, '2', 'number 类型：纯数字字符串')
    assertOk(/^\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/.test(data.time4.value), 'time 类型：24 小时制（含年月日）')
    assertEq(data.time4.value, '2026年10月3日 00:00')
  })

  // ==================== 时区修复（2026-10-20）====================
  // 线上 bug：云函数 UTC 运行时，fmtCnDateTime 用本地方法 getHours 等返回 UTC 分量，
  // 导致「消息时间」比北京时间慢 8 小时（北京时间 10:46 收到，模板显示 02:46）。
  // 修复后一律用「绝对时间戳 + 固定 8h 偏移」取 UTC 分量换算北京时间。
  // 以下用例用 Date.UTC 构造输入、断言北京时间输出，跨 UTC 日期边界验证，不依赖测试机时区。
  await testCase('TZ1 复现线上 bug：UTC 02:46 → 北京 10:46', async () => {
    const notify = loadNotify()
    assertEq(notify.fmtCnDateTime(Date.UTC(2026, 9, 20, 2, 46)), '2026年10月20日 10:46')
  })

  await testCase('TZ2 北京时间上午：UTC 06:05 → 北京 14:05', async () => {
    const notify = loadNotify()
    assertEq(notify.fmtCnDateTime(Date.UTC(2026, 9, 17, 6, 5)), '2026年10月17日 14:05')
  })

  await testCase('TZ3 北京时间凌晨（跨 UTC 日）：UTC 16:30 → 北京次日 00:30', async () => {
    const notify = loadNotify()
    assertEq(notify.fmtCnDateTime(Date.UTC(2026, 9, 17, 16, 30)), '2026年10月18日 00:30')
  })

  await testCase('TZ4 北京时间晚上：UTC 14:00 → 北京 22:00', async () => {
    const notify = loadNotify()
    assertEq(notify.fmtCnDateTime(Date.UTC(2026, 9, 17, 14, 0)), '2026年10月17日 22:00')
  })

  await testCase('TZ5 跨年边界：UTC 12-31 18:00 → 北京次年 01-01 02:00', async () => {
    const notify = loadNotify()
    assertEq(notify.fmtCnDateTime(Date.UTC(2026, 11, 31, 18, 0)), '2027年1月1日 02:00')
  })

  await testCase('TZ6 非法时间戳不抛错、返回空串', async () => {
    const notify = loadNotify()
    assertEq(notify.fmtCnDateTime(NaN), '')
  })
}

// ==================== P. getPartnerView 集成 ====================
async function runPartnerViewTests() {
  console.log('\n=== P · getPartnerView：悄悄话通知 + requestId 幂等 + 订阅记账 ===\n')
  clearTplEnv()

  await testCase('P1 她发悄悄话 → 落库成功 + 通知他一次', async () => {
    const db = seedCouple()
    const cloud = mockCloud()
    const state = { openid: 'A', cloud }
    const mod = loadCloudFn('getPartnerView', db, state)
    const r = await mod.main({ action: 'msg', text: '想你了', requestId: 'r1' })
    assertEq(r.ok, true)
    assertEq(r.notifySent, true, 'reason=' + r.notifyReason)
    assertEq(db.dump().messages.length, 1)
    assertEq(cloud.calls.length, 1)
    assertEq(cloud.calls[0].touser, 'B')
    assertOk(db.dump().messages[0].notifiedAt > 0, '应写 notifiedAt')
  })

  await testCase('P2 通知失败 → 悄悄话仍然保存成功（绝不回滚业务）', async () => {
    const db = seedCouple()
    const cloud = mockCloud({ throwErr: { errCode: 43101, errMsg: 'refuse' } })
    const state = { openid: 'A', cloud }
    const mod = loadCloudFn('getPartnerView', db, state)
    const r = await mod.main({ action: 'msg', text: '在吗', requestId: 'r1' })
    assertEq(r.ok, true, '通知失败不得让发送失败')
    assertEq(r.notifySent, false)
    assertEq(r.notifyReason, 'no_permission')
    const msgs = db.dump().messages
    assertEq(msgs.length, 1, '悄悄话必须已落库')
    assertEq(msgs[0].notificationSkipped, true, '应如实标记未通知')
  })

  await testCase('P3 模板被关掉 → 保存成功但 notifyReason=no_template（不谎报已发送）', async () => {
    process.env.TPL_CHAT = ''
    const db = seedCouple()
    const cloud = mockCloud()
    const state = { openid: 'A', cloud }
    const mod = loadCloudFn('getPartnerView', db, state)
    const r = await mod.main({ action: 'msg', text: '在吗', requestId: 'r1' })
    assertEq(r.ok, true)
    assertEq(r.notifySent, false)
    assertEq(r.notifyReason, 'no_template')
    assertEq(cloud.calls.length, 0, '未配置模板时不得调用微信接口')
    delete process.env.TPL_CHAT
  })

  await testCase('P4 同 requestId 重试 → 只落一条、只通知一次', async () => {
    const db = seedCouple()
    const cloud = mockCloud()
    const state = { openid: 'A', cloud }
    const mod = loadCloudFn('getPartnerView', db, state)
    const r1 = await mod.main({ action: 'msg', text: '在吗', requestId: 'SAME' })
    const r2 = await mod.main({ action: 'msg', text: '在吗', requestId: 'SAME' })
    assertEq(r1.ok, true)
    assertEq(r2.ok, true)
    assertEq(r2.idempotent, true, '第二次应命中幂等')
    assertEq(db.dump().messages.length, 1, '重复提交不得落两条')
    assertEq(cloud.calls.length, 1, '重复提交不得重复通知')
  })

  await testCase('P5 不同 requestId 的两次真实发送 → 两条消息、两次通知', async () => {
    const db = seedCouple({ users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', subQuota: quota(0, 0) },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', subQuota: quota(2, 0) }
    ] })
    const cloud = mockCloud()
    const state = { openid: 'A', cloud }
    const mod = loadCloudFn('getPartnerView', db, state)
    await mod.main({ action: 'msg', text: '一', requestId: 'r1' })
    await mod.main({ action: 'msg', text: '二', requestId: 'r2' })
    assertEq(db.dump().messages.length, 2)
    assertEq(cloud.calls.length, 2)
    assertEq(db.dump().users.find(u => u._openid === 'B').subQuota.chat, 0, '两条消息应各扣一次额度')
  })

  await testCase('P6 未绑定用户发悄悄话 → NOT_ACTIVE，且不产生任何通知', async () => {
    const db = seedCouple({ users: [{ _id: 'u_a', _openid: 'A', role: 'her', subQuota: quota(1, 1) }] })
    const cloud = mockCloud()
    const state = { openid: 'A', cloud }
    const mod = loadCloudFn('getPartnerView', db, state)
    const r = await mod.main({ action: 'msg', text: '在吗', requestId: 'r1' })
    assertEq(r.code, 'NOT_ACTIVE')
    assertEq(db.dump().messages.length, 0)
    assertEq(cloud.calls.length, 0)
  })

  await testCase('P7 sub：只给调用者自己记账，前端传别人的 openid 无效', async () => {
    const db = seedCouple()
    const cloud = mockCloud()
    const state = { openid: 'A', cloud }
    const mod = loadCloudFn('getPartnerView', db, state)
    const r = await mod.main({ action: 'sub', granted: ['chat'], openid: 'B', _openid: 'B', target: 'B' })
    assertEq(r.ok, true)
    const users = db.dump().users
    assertEq(users.find(u => u._openid === 'A').subQuota.chat, 1, '应给调用者 A +1')
    assertEq(users.find(u => u._openid === 'B').subQuota.chat, 2, '不得改动 B 的配额')
  })

  await testCase('P8 sub 收到空 granted → BAD_ARGS，不写脏数据', async () => {
    const db = seedCouple()
    const cloud = mockCloud()
    const state = { openid: 'A', cloud }
    const mod = loadCloudFn('getPartnerView', db, state)
    const r = await mod.main({ action: 'sub', granted: [] })
    assertEq(r.ok, false)
    assertEq(r.code, 'BAD_ARGS')
    assertEq(db.dump().users.find(u => u._openid === 'A').subQuota.chat, 0)
  })

  await testCase('P9 sub 同时传 wish+msg（旧客户端）→ 只 +1，不重复记账', async () => {
    const db = seedCouple()
    const cloud = mockCloud()
    const state = { openid: 'A', cloud }
    const mod = loadCloudFn('getPartnerView', db, state)
    await mod.main({ action: 'sub', granted: ['wish', 'msg'] })
    assertEq(db.dump().users.find(u => u._openid === 'A').subQuota.chat, 1, '合并模板 → 一次授权只 +1')
  })

  await testCase('P10 view：未读悄悄话计数来自服务端真值，且不回传任何 openid', async () => {
    const db = seedCouple({
      messages: [
        { _id: 'm1', coupleId: 'CZ-1', fromOpenid: 'A', fromRole: 'her', text: '一', readAt: null, createdAt: 1 },
        { _id: 'm2', coupleId: 'CZ-1', fromOpenid: 'A', fromRole: 'her', text: '二', readAt: 123, createdAt: 2 },
        { _id: 'm3', coupleId: 'CZ-1', fromOpenid: 'B', fromRole: 'him', text: '三', readAt: null, createdAt: 3 }
      ]
    })
    const cloud = mockCloud()
    const state = { openid: 'B', cloud }
    const mod = loadCloudFn('getPartnerView', db, state)
    const r = await mod.main({})
    assertEq(r.ok, true)
    assertEq(r.unreadMsgs, 1, '只算「对方发给我且未读」')
    const wire = JSON.stringify(r)
    assertOk(wire.indexOf('"A"') === -1, 'view 响应不得回传伴侣 openid')
    assertOk(wire.indexOf('herOpenid') === -1 && wire.indexOf('himOpenid') === -1, 'view 响应不得回传 couple 原始字段')
    assertEq(typeof r.myQuota.chat, 'number', 'myQuota 只回传次数')
    assertEq(typeof r.partnerQuota.chat, 'number', 'partnerQuota 只回传次数')
  })

  await testCase('P11 解绑（not active）后 view 直接 NOT_ACTIVE，不泄露旧伴侣数据', async () => {
    const db = seedCouple({ couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'superseded' }] })
    const cloud = mockCloud()
    const state = { openid: 'B', cloud }
    const mod = loadCloudFn('getPartnerView', db, state)
    const r = await mod.main({})
    assertEq(r.code, 'NOT_ACTIVE')
    assertOk(r.wishes === undefined && r.messages === undefined, '未生效关系不得返回任何业务数据')
  })

  await testCase('P12 mark 分支的局部变量不遮蔽 notify 模块（回归：曾命名 const notify）', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'cloudfunctions/getPartnerView/index.js'), 'utf8')
    assertOk(!/const\s+notify\s*=\s*await/.test(src), '存在 const notify = await ...，会遮蔽 require 的 notify 模块')
    assertOk(!/(let|var)\s+notify\s*=/.test(src), '存在同名变量声明，会遮蔽 notify 模块')
  })
}

// ==================== Q. dailyRecord 集成 ====================
async function runDailyRecordTests() {
  console.log('\n=== Q · dailyRecord：新增心愿（通知已被用途闸门拦下，站内未读兜底） ===\n')
  clearTplEnv()

  function baseEvent(over) {
    return Object.assign({
      action: 'save',
      date: '2026-10-17',
      revision: 0,
      requestId: 'req-1',
      wishes: [{ type: 'eat', text: '火锅' }]
    }, over)
  }

  await testCase('Q1 新建心愿 → 记录与心愿都成功，但心愿通知被用途闸门拦下（不碰微信、不扣额度）', async () => {
    const db = seedCouple()
    const cloud = mockCloud()
    const state = { openid: 'A', cloud }
    const mod = loadCloudFn('dailyRecord', db, state)
    const r = await mod.main(baseEvent({}))
    assertEq(r.ok, true, '业务必须成功')
    assertEq(r.wishNotifySent, false, '「聊天消息通知」模板不得用于心愿新增')
    assertEq(r.wishNotifyReason, 'wish_template_purpose_unverified')
    assertEq(cloud.calls.length, 0, '闸门必须在调用微信接口之前就拦住')
    const w = db.dump().wishes
    assertEq(w.length, 1, '心愿本身要正常保存')
    assertEq(w[0].createdNotifySkipped, true, '必须留下「没发」的痕迹，不能无痕')
    assertEq(w[0].createdNotifyAt, undefined, '没发就不能写成功标记')
    const b = db.dump().users.find(u => u._openid === 'B')
    assertEq(b.subQuota.chat, 2, '没发就不能扣接收者额度')
  })

  await testCase('Q2 重复保存同一个心愿 → 不新增、也不再重复尝试通知', async () => {
    const db = seedCouple()
    const cloud = mockCloud()
    const state = { openid: 'A', cloud }
    const mod = loadCloudFn('dailyRecord', db, state)
    await mod.main(baseEvent({}))
    const before = db.dump().wishes.length
    const r2 = await mod.main(baseEvent({ revision: 1, requestId: 'req-2' }))
    assertEq(r2.ok, true)
    assertEq(db.dump().wishes.length, before, '不得重复创建心愿')
    assertEq(cloud.calls.length, 0, '重复保存不得再触发任何微信调用')
  })

  await testCase('Q3 未绑定 → 记录照常保存，通知降级 not_bound，心愿标记 skipped', async () => {
    const db = seedCouple({ users: [{ _id: 'u_a', _openid: 'A', role: 'her', subQuota: quota(1, 0) }] })
    const cloud = mockCloud()
    const state = { openid: 'A', cloud }
    const mod = loadCloudFn('dailyRecord', db, state)
    const r = await mod.main(baseEvent({}))
    assertEq(r.ok, true, '没有伴侣也不能影响记录保存')
    assertEq(r.wishNotifySent, false)
    assertEq(r.wishNotifyReason, 'not_bound')
    assertEq(cloud.calls.length, 0)
    assertEq(db.dump().wishes[0].createdNotifySkipped, true)
  })

  await testCase('Q4 通知环节报错也不冒泡：记录与心愿照常保存（心愿已不发，此用例是回归守卫）', async () => {
    const db = seedCouple()
    const cloud = mockCloud({ throwErr: { errCode: -1, errMsg: 'system busy' } })
    const state = { openid: 'A', cloud }
    const mod = loadCloudFn('dailyRecord', db, state)
    let threw = false
    let r
    try { r = await mod.main(baseEvent({})) } catch (e) { threw = true }
    assertOk(!threw, '通知异常不得冒泡到业务')
    assertEq(r.ok, true)
    assertEq(r.wishNotifySent, false)
    assertEq(db.dump().daily_records.length, 1, '记录必须已保存')
    assertEq(db.dump().wishes.length, 1, '心愿必须已保存')
  })

  await testCase('Q5 没有心愿的普通保存 → 完全不触发通知', async () => {
    const db = seedCouple()
    const cloud = mockCloud()
    const state = { openid: 'A', cloud }
    const mod = loadCloudFn('dailyRecord', db, state)
    const r = await mod.main(baseEvent({ wishes: [] }))
    assertEq(r.ok, true)
    assertEq(r.wishNotifySent, false)
    assertEq(cloud.calls.length, 0)
  })

  await testCase('Q6 他（him）新增心愿 → 记录与心愿照常保存，但不通知她', async () => {
    const db = seedCouple({ users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', subQuota: quota(1, 0) },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', subQuota: quota(1, 0) }
    ] })
    const cloud = mockCloud()
    const state = { openid: 'B', cloud } // B = him
    const mod = loadCloudFn('dailyRecord', db, state)
    const r = await mod.main(baseEvent({}))
    assertEq(r.ok, true, '业务不能受影响')
    assertEq(r.wishNotifySent, false)
    assertEq(r.wishNotifyReason, 'not_sender_role')
    assertEq(cloud.calls.length, 0, '不得发给她一条指向不存在内容的通知')
    assertEq(db.dump().wishes.length, 1, '心愿本身仍要保存')
  })
}

// ==================== R. 安全与部署静态约束 ====================
async function runStaticTests() {
  console.log('\n=== R · 安全与部署静态约束 ===\n')
  clearTplEnv()

  const gpv = fs.readFileSync(path.join(ROOT, 'cloudfunctions/getPartnerView/index.js'), 'utf8')
  const notify = fs.readFileSync(NOTIFY_GPV, 'utf8')
  const cfg = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8')
  const ours = fs.readFileSync(path.join(ROOT, 'pages/ours/ours.js'), 'utf8')

  await testCase('R1 模板 ID 只来自「环境变量或内置默认」，且只集中在 DEFAULT_TEMPLATES 一处', async () => {
    assertOk(/DEFAULT_TEMPLATES\s*=\s*\{/.test(notify), '应有集中的内置模板常量')
    const ids = notify.match(/['"][A-Za-z0-9_-]{40,}['"]/g) || []
    const placeholders = notify.match(/TEMPLATE_ID_HERE/g) || []
    assertEq(ids.length, 0, 'notify.js 不应残留真实模板 ID 字面量，实际 ' + ids.length)
    assertEq(placeholders.length, 2, 'notify.js 应恰好两个占位符，实际 ' + placeholders.length)
  })

  await testCase('R2 config.js 模板 ID 为占位符，isTplReady 正确识别', async () => {
    assertOk(/SUB_TPL_CHAT:\s*'TEMPLATE_ID_HERE'/.test(cfg), 'SUB_TPL_CHAT 应为占位符')
    assertOk(/SUB_TPL_PERIOD:\s*'TEMPLATE_ID_HERE'/.test(cfg), 'SUB_TPL_PERIOD 应为占位符')
    assertOk(/isTplReady/.test(cfg), '应有 isTplReady 判断（占位符也算未配置）')
    delete require.cache[path.join(ROOT, 'config.js')]
    const CONFIG = require(path.join(ROOT, 'config.js'))
    assertEq(CONFIG.isTplReady(CONFIG.SUB_TPL_CHAT), false)
    assertEq(CONFIG.isTplReady(CONFIG.SUB_TPL_PERIOD), false)
    assertEq(CONFIG.isTplReady(''), false)
    assertEq(CONFIG.isTplReady('TEMPLATE_ID_HERE'), false)
    assertEq(CONFIG.isTplReady('REAL_ID_EXAMPLE'), true)
  })

  await testCase('R3 前端不传接收者 openid / 不自行决定通知对象', async () => {
    assertOk(!/touser/.test(ours), '前端不得出现 touser')
    assertOk(!/action:\s*'sub'[^}]*openid/.test(ours), 'sub 请求不得携带他人 openid')
    assertOk(!/openid\s*:\s*['"]/.test(ours), '前端不得硬编码 openid')
  })

  await testCase('R4 未配置模板时不调用 wx.requestSubscribeMessage（空 tmplIds 会直接报错）', async () => {
    const idx = ours.indexOf('notifySub()')
    assertOk(idx > 0, '应存在 notifySub')
    const body = ours.slice(idx, idx + 1800)
    assertOk(body.indexOf('if (!tpls.length)') > 0, '必须先判空再申请')
    assertOk(body.indexOf('requestSubscribeMessage') > body.indexOf('if (!tpls.length)'), '判空必须在调用之前')
  })

  await testCase('R5 界面文案不承诺「永久开启」，并如实说明每次只提醒一次', async () => {
    const raw = fs.readFileSync(path.join(ROOT, 'pages/ours/ours.wxml'), 'utf8')
    const wxml = raw.replace(/<!--[\s\S]*?-->/g, '')
    assertOk(!/永久/.test(wxml), 'wxml 用户可见文案不得出现「永久」字样')
    assertOk(!/永久/.test(ours.replace(/\/\/[^\n]*/g, '')), 'ours.js 用户可见文案不得出现「永久」字样')
    // V1.1 UI 精简后，一次性语义改由底部那一行表达（「微信每次仅提醒一次，需要时可再次开启」），
    // 断言从字面「一次性订阅」放宽到语义等价表述，保证的仍是「不得让用户以为是长期授权」。
    assertOk(/每次仅提醒一次|一次性订阅/.test(wxml), '应如实告知每次只提醒一次')
    assertOk(/再次开启/.test(wxml), '应告知需要时可以再次开启')
  })

  await testCase('R6 站内未读提示（降级方案）不依赖任何授权/模板', async () => {
    const wxml = fs.readFileSync(path.join(ROOT, 'pages/ours/ours.wxml'), 'utf8')
    assertOk(/unreadMsgs\s*>\s*0/.test(wxml), '应有未读悄悄话提示')
    assertOk(/newWishes\s*>\s*0/.test(wxml), '应有新心愿提示')
    const bannerIdx = wxml.indexOf('notify-banner')
    const wxIfIdx = wxml.lastIndexOf('wx:if=', bannerIdx)
    const cond = wxml.slice(wxIfIdx, bannerIdx)
    assertOk(cond.indexOf('notifyReady') === -1, '未读提示不得依赖模板配置状态')
  })

  await testCase('R7 deploy-isolation：三个云函数各带 notify.js 副本，不跨目录 require', async () => {
    assertOk(fs.existsSync(NOTIFY_GPV) && fs.existsSync(NOTIFY_DR) && fs.existsSync(NOTIFY_MEN), '三份副本都应存在')
    assertOk(!/require\(['"]\.\.\//.test(notify), 'notify.js 不得跨目录 require')
    assertOk(/require\(['"]\.\/notify['"]\)/.test(gpv), 'getPartnerView 应 require ./notify')
  })

  await testCase('R8 调用微信接口的云函数都声明了 openapi 权限（云调用的前提）', async () => {
    for (const fn of ['getPartnerView', 'dailyRecord', 'menstrual']) {
      const p = path.join(ROOT, 'cloudfunctions', fn, 'config.json')
      assertOk(fs.existsSync(p), fn + ' 缺少 config.json')
      const conf = JSON.parse(fs.readFileSync(p, 'utf8'))
      assertOk(conf.permissions && Array.isArray(conf.permissions.openapi), fn + ' 未声明 permissions.openapi')
      assertOk(conf.permissions.openapi.indexOf('subscribeMessage.send') !== -1, fn + ' 未声明 subscribeMessage.send')
    }
  })
}

// ==================== S. 客户端订阅交互（运行时） ====================
function loadOursPage(tplChat) {
  const cfgPath = path.join(ROOT, 'config.js')
  delete require.cache[cfgPath]
  const CONFIG = require(cfgPath)
  const original = CONFIG.SUB_TPL_CHAT
  CONFIG.SUB_TPL_CHAT = tplChat || ''

  let pageDef = null
  const toasts = []
  const modals = []
  const subs = []
  const cloudCalls = []
  let subHandler = null

  global.getApp = () => ({ globalData: { openid: 'A', role: 'him', bindCode: null }, whenReady: () => {}, silentLogin() {} })
  global.Page = (def) => { pageDef = def }
  global.wx = {
    getStorageSync: () => 0,
    setStorageSync: () => {},
    removeStorageSync: () => {},
    showToast: (o) => toasts.push(o.title),
    showModal: (o) => modals.push(o),
    requestSubscribeMessage: (opts) => { subs.push(opts.tmplIds); if (subHandler) subHandler(opts) },
    cloud: {
      callFunction({ name, data }) {
        cloudCalls.push({ name, data })
        return Promise.resolve({ result: { ok: true, quota: { chat: 1, period: 0 } } })
      }
    }
  }

  const pagePath = path.join(ROOT, 'pages/ours/ours.js')
  delete require.cache[pagePath]
  require(pagePath)

  const p = Object.create(pageDef)
  p.data = JSON.parse(JSON.stringify(pageDef.data))
  p.setData = function (patch) { Object.assign(this.data, patch) }

  return {
    page: p,
    toasts,
    modals,
    subs,
    cloudCalls,
    setSubHandler(fn) { subHandler = fn },
    cleanup() { CONFIG.SUB_TPL_CHAT = original }
  }
}

async function runClientSubTests() {
  console.log('\n=== S · 客户端订阅交互（wx.requestSubscribeMessage） ===\n')

  await testCase('S1 未配置模板 → 不调用 requestSubscribeMessage，只解释原因', async () => {
    const h = loadOursPage('')
    h.page.notifySub()
    assertEq(h.subs.length, 0, '空 tmplIds 会直接报错，绝不能调用')
    assertEq(h.modals.length, 1, '应弹窗解释暂不可用')
    assertOk(/模板|公众平台/.test(h.modals[0].content), '说明应指向模板配置')
    h.cleanup()
  })

  await testCase('S2 只申请一个模板 ID（心愿与悄悄话共用，不再各自弹一次）', async () => {
    const h = loadOursPage('TPL_CHAT_ONLY')
    h.setSubHandler(o => o.success({ TPL_CHAT_ONLY: 'accept' }))
    h.page.notifySub()
    assertEq(h.subs.length, 1)
    assertEq(h.subs[0].length, 1, '同一次授权只申请一个模板')
    assertEq(h.subs[0][0], 'TPL_CHAT_ONLY')
    h.cleanup()
  })

  await testCase('S3 用户同意 → 上报 chat 通道并更新额度显示', async () => {
    const h = loadOursPage('TPL_CHAT_ONLY')
    h.setSubHandler(o => o.success({ TPL_CHAT_ONLY: 'accept' }))
    h.page.notifySub()
    await new Promise(r => setTimeout(r, 10))
    const sub = h.cloudCalls.find(c => c.data && c.data.action === 'sub')
    assertOk(sub, '应调用 sub 记账')
    assertEq(JSON.stringify(sub.data.granted), JSON.stringify(['chat']), '只上报 chat 一个通道')
    assertEq(h.page.data.myQuota.chat, 1, '额度显示应更新')
    assertEq(h.page.data.myQuotaTotal, 1, '只算 chat 通道，不重复计')
    h.cleanup()
  })

  await testCase('S4 用户拒绝 → 不发请求记账，提示不影响正常使用', async () => {
    const h = loadOursPage('TPL_CHAT_ONLY')
    h.setSubHandler(o => o.success({ TPL_CHAT_ONLY: 'reject' }))
    h.page.notifySub()
    await new Promise(r => setTimeout(r, 10))
    assertEq(h.cloudCalls.filter(c => c.data && c.data.action === 'sub').length, 0, '拒绝不应记账')
    assertOk(h.toasts.some(t => t.indexOf('不影响') !== -1), '应明确告知不影响正常使用')
    h.cleanup()
  })

  await testCase('S5 微信返回 20004（总开关关闭）→ 弹窗指路，不假装成功', async () => {
    const h = loadOursPage('TPL_CHAT_ONLY')
    h.setSubHandler(o => o.fail({ errMsg: 'requestSubscribeMessage:fail 20004' }))
    h.page.notifySub()
    assertEq(h.modals.length, 1)
    assertOk(/消息通知/.test(h.modals[0].content), '应指路到微信设置里的消息通知')
    h.cleanup()
  })

  await testCase('S6 发送中重复点击 → 只申请一次', async () => {
    const h = loadOursPage('TPL_CHAT_ONLY')
    h.setSubHandler(() => {})
    h.page.notifySub()
    h.page.notifySub()
    assertEq(h.subs.length, 1, '_subbing 应挡住重复申请')
    h.cleanup()
  })

  await testCase('S7 界面文案：未开启时显示「未开启」，不显示「已开启」', async () => {
    const h = loadOursPage('')
    assertEq(h.page.data.myQuotaTotal, 0)
    const hint = h.page.buildNotifyHint({ chat: 0 })
    assertEq(hint, h.page.data.notifyHint)
    assertOk(hint.indexOf('永久') === -1, '提示不得承诺永久')
    h.cleanup()
  })

  await testCase('S8 已申请过次数时，页面如实说明「用完要再开启」（文案已合并到底部一行）', async () => {
    const h = loadOursPage('TPL_CHAT_ONLY')
    const hint = h.page.buildNotifyHint({ chat: 3 })
    assertOk(hint.indexOf('3') !== -1, '应显示剩余记账次数: ' + hint)
    assertOk(/服务端记账/.test(hint), '必须说明次数是服务端记账: ' + hint)
    // V1.1 UI 精简：一次性 / 用完再开启 的说明从 hint 收拢到卡片底部唯一那一行，
    // 因此这里改查静态文案，而不是要求 hint 与底部各说一遍（同一件事说两遍正是本轮要修的）。
    const wxml = fs.readFileSync(path.join(ROOT, 'pages/ours/ours.wxml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    assertOk(/再次开启|再点一次/.test(wxml), '页面必须说明用完可以再次开启')
    assertOk(hint.indexOf('永久') === -1, '不得承诺永久')
    h.cleanup()
  })
}

// ==================== 主流程 ====================
;(async () => {
  console.log('========================================')
  console.log(' 情侣事件微信订阅消息（合并模板 A）· 测试')
  console.log('========================================')
  await runNotifyUnitTests()
  await runPartnerViewTests()
  await runDailyRecordTests()
  await runStaticTests()
  await runClientSubTests()

  console.log('\n========================================')
  console.log(' 结果: ' + passed + ' PASS / ' + failed + ' FAIL')
  if (failures.length) {
    console.log(' 失败项:')
    failures.forEach(f => console.log('   · ' + f))
  }
  console.log('========================================')
  process.exit(failed === 0 ? 0 : 1)
})()
