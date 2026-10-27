// ============================================================
// notify.js · 微信订阅消息（一次性订阅）
//
// 为什么要独立成文件：微信云开发每个云函数独立打包，运行期禁止跨目录 require
// （见 tests/deploy-isolation.test.js）。因此 getPartnerView / dailyRecord / menstrual
// 各自持有一份**内容完全一致**的副本，由 tests/couple-notify.test.js 的
// NOTIFY_MODULE_IDENTICAL 用例守住三份不漂移。
//
// 两个通道（channel）——通道 = 一个模板，配额也按通道记账：
//   chat   「聊天消息通知」模板 3377
//          这个模板只承载**聊天消息**语义，即「新悄悄话」。
//          「新心愿」虽然共用同一模板的字段（thing1/thing5 区分），但模板用途
//          未获平台确认，因此被下方 isWishNotifyAllowed 闸门**永久拦下**，不发。
//   period 「经期提醒」模板 472
//
// 平台事实（必须如实对待，不做假设）：
//   · 小程序只能通过「订阅消息」触达用户，没有无限制的主动推送。
//   · 订阅消息分一次性 / 长期两类，两者都受模板能力与用户授权约束；
//     本项目按最保守的**一次性订阅**设计：用户每同意一次 ≈ 可接收一条消息。
//   · 微信没有提供「查询剩余可发送次数」的开放接口，所以下面的配额只是
//     服务端记账（users.subQuota），可能与真实额度存在偏差；
//     真实闸门始终在微信侧 —— 发送失败会被捕获并降级，绝不回滚业务数据。
//   · 模板 ID 不是密钥（客户端申请授权时本来就要用它），因此这里内置默认值，
//     并允许云函数环境变量 TPL_CHAT / TPL_PERIOD 覆盖。内置默认值必须与
//     config.js 保持一致（tests/couple-notify.test.js 的 TPL_DEFAULT_IN_SYNC 守着）。
//
// 安全约束（全部在服务端完成，前端无法影响）：
//   1. 接收者只从「openid → users.coupleId → couples(status=active)」推导，
//      绝不接受前端传入的接收者 openid。
//   2. 关系不是 active（解绑 / 过期 / superseded）→ 一律不发。
//   3. partnerOpenid === 发送者 → 不发（不会发给自己）。
//   4. 通知内容不含任何私密原文：只说「新增了一条心愿 / 留下了一句话」。
//   5. 任何失败都不向上抛：通知是旁路，业务（保存心愿/悄悄话）永远优先。
// ============================================================

// 官方模板 ID（微信公众平台 → 订阅消息 → 我的模板）
const DEFAULT_TEMPLATES = {
  chat: 'TEMPLATE_ID_HERE',   // 聊天消息通知模板（部署前替换为你的模板 ID）
  period: 'TEMPLATE_ID_HERE'  // 经期提醒模板（部署前替换为你的模板 ID）
}

const CHANNELS = ['chat', 'period']

// 事件类型 → 通道。心愿与悄悄话共用 chat 通道（同一个模板、同一份额度）。
const KINDS = ['wish', 'msg']
const CHANNEL_OF_KIND = { wish: 'chat', msg: 'chat', period: 'period' }

// 点击消息后的落地页
const PAGE_OF = {
  wish: 'pages/ours/ours',
  msg: 'pages/ours/ours',
  period: 'pages/calendar/calendar'
}

// thing3「消息来自」的通用兜底称呼。
// 旧版这里是个人的私人昵称 —— 开放给所有情侣后，任何没设昵称的人收到推送都会看到
// 一个陌生名字，等于把私人称呼广播出去。现在统一用中性的「你的另一半」。
const DEFAULT_SENDER_NAME = '你的另一半'

function pad2(n) { return String(n).padStart(2, '0') }

// 北京时间（UTC+8）固定偏移。微信云函数运行时是 UTC 时区，Date 的本地方法
// （getFullYear/getHours/getMinutes…）会返回 UTC 分量，导致「消息时间」比北京时间
// 慢整整 8 小时（线上真实 bug：北京时间 10:46 收到，模板显示 02:46）。
// 因此所有用户可见时间一律用「绝对时间戳 + 固定 8h 偏移」再取 UTC 分量换算，
// 得到稳定的北京时间，绝不依赖服务器本地时区。
const CN_TZ_OFFSET_MS = 8 * 60 * 60 * 1000

// 纯日期 → 微信 date 类型要求的「年月日」格式：2019年10月1日
// 入参是 YYYY-MM-DD 纯日期字符串，不含时刻，不存在时区换算问题。
function fmtCnDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''))
  if (!m) return ''
  return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日`
}

// 时间戳 → 微信 time 类型要求的「年月日 + 24 小时制」：2019年10月1日 15:01
// 入参 ts 是绝对 epoch 毫秒时间戳（Date.now() / messages.createdAt），本身从未被
// 预加时区偏移，因此这里加一次 8h 得到北京时间、不会重复偏移。
function fmtCnDateTime(ts) {
  const ms = typeof ts === 'number' ? ts : Date.now()
  if (isNaN(new Date(ms).getTime())) return ''
  const d = new Date(ms + CN_TZ_OFFSET_MS)
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
}

// 纯日期 → time 类型字段（模板 B 的 time4「上月日期」是 time 类型，不是 date 类型）。
// time.DATA 要求 24 小时制时间（支持 + 年月日），只给「年月日」有被判格式不合法的风险，
// 因此补一个中性的 00:00；数据本身没有时刻，这个 00:00 不代表任何真实时间。
function fmtCnDateTimeOfDate(dateStr) {
  const d = fmtCnDate(dateStr)
  return d ? `${d} 00:00` : ''
}

// 模板字段映射 —— 字段名必须是「我的模板」里已生效的关键词，多一个都会报 47003。
// 模板 A（3377）：thing1 通知类型 / thing3 消息来自 / thing5 备注 / time6 消息时间
// 模板 B（472）：date1 预计日期 / number2 倒计时天数 / time4 上月日期
// thing 限 20 个字符以内；所有取值都走固定话术，绝不带用户原文（隐私）。
const FIELD_MAP = {
  chat: (ctx) => {
    const c = ctx || {}
    const isWish = c.kind === 'wish'
    const isHim = c.senderRole === 'him'
    return {
      thing1: { value: isWish ? '新心愿' : '新悄悄话' },
      thing3: { value: senderNameOf(c.senderName, c.senderRole) },
      thing5: {
        value: isWish ? 'TA 新增了一条心愿' : 'TA 给你留了一句话'
      },
      time6: { value: fmtCnDateTime(c.at) }
    }
  },
  period: (ctx) => {
    const c = ctx || {}
    return {
      date1: { value: fmtCnDate(c.nextStart) },
      number2: { value: String(Number.isInteger(c.countdown) ? c.countdown : 0) },
      time4: { value: fmtCnDateTimeOfDate(c.lastStart) }
    }
  }
}

// thing3「消息来自」：优先用她自己设的昵称；默认昵称（她/他）不算名字，退回固定称呼。
function senderNameOf(name, role) {
  const n = String(name || '').trim()
  if (n && n !== '她' && n !== '他') return n.slice(0, 12)
  return DEFAULT_SENDER_NAME
}

// 模板 ID：环境变量优先，缺省用内置默认（两者必须一致，见测试）。
// 显式把环境变量设为空串 = 关掉该通道（此时返回 no_template，绝不假装已发送）。
function readTemplates(env) {
  const e = env || {}
  const pick = (key, def) => (Object.prototype.hasOwnProperty.call(e, key) ? (e[key] || '') : def)
  return {
    chat: pick('TPL_CHAT', DEFAULT_TEMPLATES.chat),
    period: pick('TPL_PERIOD', DEFAULT_TEMPLATES.period)
  }
}

// 服务端推导接收者。返回 { ok:false, reason } 时一律不发。
async function resolvePartner(db, openid) {
  if (!openid) return { ok: false, reason: 'no_identity' }
  const me = (await db.collection('users').where({ _openid: openid }).get()).data[0]
  if (!me || !me.coupleId) return { ok: false, reason: 'not_bound' }
  const c = (await db.collection('couples').where({ coupleId: me.coupleId, status: 'active' }).get()).data[0]
  if (!c) return { ok: false, reason: 'not_active' }
  const partnerOpenid = me.role === 'him' ? c.herOpenid : c.himOpenid
  if (!partnerOpenid) return { ok: false, reason: 'no_partner' }
  if (partnerOpenid === openid) return { ok: false, reason: 'self_target' }
  return { ok: true, partnerOpenid, coupleId: c.coupleId, role: me.role || null }
}

function normalizeQuota(q) {
  const src = q || {}
  const out = {}
  for (const ch of CHANNELS) out[ch] = Math.max(0, Math.floor(Number(src[ch]) || 0))
  return out
}

// 配额是「这个模板还能发几条」。模板换过之后，旧模板上的记账一律不作数：
// 因此在 users.subQuota 里同时记下每个通道当时对应的模板 ID（subQuota.tpl）。
// 这样历史上按 wish/msg 两套模板记的账不会因为合并模板被重复计入。
function scopedQuota(raw, templates) {
  const q = normalizeQuota(raw)
  const tpl = (raw && raw.tpl) || {}
  const t = templates || readTemplates({})
  for (const ch of CHANNELS) {
    if (tpl[ch] !== t[ch]) q[ch] = 0
  }
  return q
}

async function readUser(db, openid) {
  const u = (await db.collection('users').where({ _openid: openid }).get()).data[0]
  return u || null
}

// 发送成功后扣减（失败不回补：宁可显示"已用完"提示用户重新授权，也不虚报可发）
async function writeQuota(db, user, quota, templates) {
  const tpl = {}
  const t = templates || readTemplates({})
  for (const ch of CHANNELS) tpl[ch] = t[ch]
  await db.collection('users').doc(user._id).update({ data: { subQuota: { ...quota, tpl } } })
}

// 用户在小程序里点了「允许」→ 服务端 +1（一次性订阅：一次同意 ≈ 一条消息）
// 关键：先按「事件类型 → 通道」归一化并去重，再累加。
// 心愿和悄悄话共用一个模板，同一次授权只能 +1，不能因为传了两个 kind 就 +2。
function channelsOf(list) {
  const out = []
  for (const raw of (Array.isArray(list) ? list : [])) {
    const key = String(raw)
    const ch = CHANNEL_OF_KIND[key] || (CHANNELS.indexOf(key) !== -1 ? key : null)
    if (ch && out.indexOf(ch) === -1) out.push(ch)
  }
  return out
}

async function grantQuota(db, openid, granted, templates) {
  const list = channelsOf(granted)
  if (!openid || !list.length) return { ok: false, reason: 'bad_args', quota: null }
  const u = await readUser(db, openid)
  if (!u) return { ok: false, reason: 'no_user', quota: null }
  const q = scopedQuota(u.subQuota, templates)
  for (const ch of list) q[ch] += 1
  await writeQuota(db, u, q, templates)
  return { ok: true, quota: q }
}

async function consumeQuota(db, openid, channel, templates) {
  const u = await readUser(db, openid)
  if (!u) return null
  const q = scopedQuota(u.subQuota, templates)
  if (q[channel] <= 0) return q
  q[channel] = Math.max(0, q[channel] - 1)
  await writeQuota(db, u, q, templates)
  return q
}

// 微信侧明确表示「没有可用授权」→ 记账归零，避免继续做无意义的发送尝试
async function zeroQuota(db, openid, channel, templates) {
  const u = await readUser(db, openid)
  if (!u) return null
  const q = scopedQuota(u.subQuota, templates)
  q[channel] = 0
  await writeQuota(db, u, q, templates)
  return q
}

// 返回「真实昵称」；取不到就返回空串，交给 senderNameOf 兜底成「你的另一半」。
// 这里绝不返回固定称呼 —— 否则谁寄来的消息都会显示成同一个名字。
async function resolveSenderName(db, openid, env) {
  try {
    const u = await readUser(db, openid)
    const n = u && u.nickName ? String(u.nickName).trim() : ''
    if (n && n !== '她' && n !== '他') return n.slice(0, 12)
  } catch (_) { /* 名字只影响文案，取不到就用默认 */ }
  const override = env && env.NOTIFY_NAME ? String(env.NOTIFY_NAME).trim() : ''
  return override ? override.slice(0, 12) : ''
}

// ------------------------------------------------------------
// 小程序版本状态（miniprogramState）—— 只影响「点开消息跳到哪个版本」
//
//   developer = 开发版：只有开发者本人 + 开发者工具能看到
//   trial     = 体验版：只有体验成员能看到
//   formal    = 正式版：线上已发布版本
//
// 默认 formal（生产语义）。但**真机验收体验版时必须临时改成 trial**：
// 否则消息能发出去、点击却跳到线上旧版本，看到的界面没有本次功能，
// 会得出「功能没生效」的错误结论（或者更糟：以为已生效）。
// 环境变量 MP_STATE 覆盖，非法值一律退回 formal（fail-closed，不做猜测试）。
// ------------------------------------------------------------
const MP_STATES = ['developer', 'trial', 'formal']
function resolveMiniprogramState(env) {
  const v = String((env && env.MP_STATE) || '').trim().toLowerCase()
  return MP_STATES.indexOf(v) !== -1 ? v : 'formal'
}

// ------------------------------------------------------------
// 心愿通知的「模板用途」闸门（合规，fail-closed，**已锁死**）
//
// 事实：模板 3377 在微信公众平台的标题是「聊天消息通知」，场景是「有人给你发了一条
// 聊天消息」。悄悄话属于这个场景；**心愿不是聊天消息** —— 心愿是双方共享清单里的
// 一条条目。模板虽然带 thing1「通知类型」，但那只是自由填空字段，不等于平台授权
// 我们把这个模板用于「心愿新增」。
//
// 因此这里默认**不发**心愿通知（返回 wish_template_purpose_unverified），
// 心愿改由站内未读提示触达（「我们」页顶部那条，不依赖任何微信授权）。
//
// 为什么不再提供 WISH_NOTIFY 环境变量开关：
//   上一版允许设 WISH_NOTIFY=on 就恢复发送。但「模板用途是否合规」是一个**平台
//   结论**，不该退化成一次云函数环境变量配置 —— 任何有控制台权限的人敲一下 on
//   就绕过了闸门，闸门等于不存在。合规结论没拿到之前，这里不接受任何外部输入：
//   isWishNotifyAllowed() 恒为 false，且**完全不读取 env**。
//
// 将来若拿到合规结论（或申请到专用的「心愿提醒」模板），正确做法是改这个常量并
// 走代码评审 + 重新部署，而不是在控制台改配置。届时 FIELD_MAP.chat 里的心愿话术
// 已经就绪，无需再改发送逻辑。
// ------------------------------------------------------------
const WISH_NOTIFY_ENABLED = false

// 注意签名保留 env 参数：调用方（getPartnerView）仍然传 process.env，
// 但函数体刻意不使用它 —— 任何环境变量/入参都无法把它变成 true。
function isWishNotifyAllowed(_env) {
  return WISH_NOTIFY_ENABLED
}

// errCode 分类：43101 = 用户未授权/已用完，属于预期降级；其余按真实故障记日志
const ERR_NO_PERMISSION = 43101

function classifyError(e) {
  const code = (e && (e.errCode !== undefined ? e.errCode : e.errcode)) || 0
  if (code === ERR_NO_PERMISSION) return 'no_permission'
  if (code === 40003) return 'invalid_openid'
  if (code === 40037 || code === 41028 || code === 41029 || code === 41030) return 'bad_template'
  if (code === 47003) return 'bad_field'  // 模板字段名/格式不符合
  if (code === -1) return 'system_busy'
  return 'send_failed'
}

// 核心：尝试给「当前调用者的另一半」发一条订阅消息。
// 永不抛错、永不阻塞业务；返回 { sent, reason } 供调用方决定是否写幂等标记。
//
// expectRole（可选）：限定「只有某个角色的事件才通知」。
//   · 心愿（wish）必须 expectRole='her' —— 心愿的属主是她，她也只看得见自己的心愿；
//     他若也新建了心愿，她那边看不到，通知过去就是指向不存在的内容。
//   · 悄悄话（msg）双方都能发、都能看，不设角色限制。
//   角色缺失（历史脏数据）→ 视为不匹配，宁可不发（skip > guess）。
async function sendCoupleNotice({ db, cloud, env, openid, kind, expectRole, at }) {
  const result = { sent: false, reason: '', channel: '' }
  // 配额属于**接收者**，所以归零时也必须用 partnerOpenid，不能用发送者 openid
  let partnerOpenid = ''
  const channel = CHANNEL_OF_KIND[kind] || ''
  // 提到 try 外面：catch 分支归零额度时也要用它（放 try 里会因块级作用域拿不到而静默失效）
  let templates = null
  try {
    if (KINDS.indexOf(kind) === -1 || !channel) return { sent: false, reason: 'bad_kind', channel: '' }
    result.channel = channel
    templates = readTemplates(env)
    const templateId = templates[channel]
    if (!templateId) {
      // 未配置模板 ID：这是「未配置」，不是「已发送」
      return { sent: false, reason: 'no_template', channel }
    }
    const partner = await resolvePartner(db, openid)
    if (!partner.ok) return { sent: false, reason: partner.reason, channel }
    if (expectRole && partner.role !== expectRole) {
      return { sent: false, reason: 'not_sender_role', channel }
    }
    partnerOpenid = partner.partnerOpenid

    const partnerUser = await readUser(db, partnerOpenid)
    const q = scopedQuota(partnerUser && partnerUser.subQuota, templates)
    if (q[channel] <= 0) return { sent: false, reason: 'no_quota', channel }

    // 合规闸门：模板用途未被确认覆盖「心愿」→ 绝不借着聊天模板把心愿推出去。
    // 放在配额检查之后、发送之前：前面的 not_bound / not_sender_role / no_quota
    // 诊断口径全部不变，只有「本来会发出去」的这一条被拦下。
    if (kind === 'wish' && !isWishNotifyAllowed(env)) {
      return { sent: false, reason: 'wish_template_purpose_unverified', channel }
    }

    const senderName = await resolveSenderName(db, openid, env)
    await cloud.openapi.subscribeMessage.send({
      touser: partnerOpenid,
      templateId,
      page: PAGE_OF[kind],
      miniprogramState: resolveMiniprogramState(env),
      lang: 'zh_CN',
      data: FIELD_MAP[channel]({
        kind, senderRole: partner.role, senderName, at: at || Date.now()
      })
    })
    // 消息**已经发出去了**。后面的记账失败绝不能把结论改写成「没发」：
    // 那会让调用方重试 → 用户收到重复消息（经期提醒里甚至会释放 claim 重发）。
    // 记账失败只影响本地的额度估算，宁可少扣一次，也不能谎报发送结果。
    try {
      await consumeQuota(db, partnerOpenid, channel, templates)
    } catch (e) {
      console.warn('[couple-notify] consumeQuota fail (消息已发出)', JSON.stringify({
        channel, errMsg: (e && (e.errMsg || e.message)) || ''
      }))
    }
    return { sent: true, reason: 'ok', channel }
  } catch (e) {
    const reason = classifyError(e)
    // 只记录非敏感诊断字段：不写 openid、不写心愿/悄悄话正文
    console.warn('[couple-notify]', JSON.stringify({
      kind, channel, reason, errCode: (e && e.errCode) || 0, errMsg: (e && (e.errMsg || e.message)) || ''
    }))
    if (reason === 'no_permission' && partnerOpenid) {
      try { await zeroQuota(db, partnerOpenid, channel, templates) } catch (_) { /* 记账失败不影响业务 */ }
    }
    return { sent: false, reason, channel }
  }
}

// 经期提醒：接收者是**指定**的 openid（她本人，或经她明确同意后的他），
// 身份由调用方（menstrual 云函数）在服务端确定，前端无法指定。
// 这里只做「授权额度 + 发送」，不做关系推导 —— 关系与共享权限在调用方判定。
async function sendPeriodReminder({ db, cloud, env, openid, nextStart, countdown, lastStart, at }) {
  const result = { sent: false, reason: '' }
  try {
    if (!openid) return { sent: false, reason: 'no_receiver' }
    const templates = readTemplates(env)
    const templateId = templates.period
    if (!templateId) return { sent: false, reason: 'no_template' }
    if (!fmtCnDate(nextStart)) return { sent: false, reason: 'bad_date' }
    const n = Number(countdown)
    if (!Number.isInteger(n) || n < 0 || n > 99) return { sent: false, reason: 'bad_countdown' }

    const u = await readUser(db, openid)
    const q = scopedQuota(u && u.subQuota, templates)
    if (q.period <= 0) return { sent: false, reason: 'no_quota' }

    await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId,
      page: PAGE_OF.period,
      miniprogramState: resolveMiniprogramState(env),
      lang: 'zh_CN',
      data: FIELD_MAP.period({ nextStart, countdown: n, lastStart, at: at || Date.now() })
    })
    // 同 sendCoupleNotice：发出去了就必须如实返回 sent:true，
    // 否则 remind.js 会释放 claim，「同一预计日期只提醒一次」的幂等就被破坏。
    try {
      await consumeQuota(db, openid, 'period', templates)
    } catch (e) {
      console.warn('[period-notify] consumeQuota fail (消息已发出)', JSON.stringify({
        errMsg: (e && (e.errMsg || e.message)) || ''
      }))
    }
    return { sent: true, reason: 'ok' }
  } catch (e) {
    const reason = classifyError(e)
    // 隐私：日志只记原因码，不记 openid、不记预测日期/上次日期
    console.warn('[period-notify]', JSON.stringify({
      reason, errCode: (e && e.errCode) || 0, errMsg: (e && (e.errMsg || e.message)) || ''
    }))
    if (reason === 'no_permission' && openid) {
      try { await zeroQuota(db, openid, 'period', readTemplates(env)) } catch (_) { /* 同上 */ }
    }
    return { sent: false, reason }
  }
}

module.exports = {
  DEFAULT_TEMPLATES,
  DEFAULT_SENDER_NAME,
  CHANNELS,
  KINDS,
  CHANNEL_OF_KIND,
  FIELD_MAP,
  PAGE_OF,
  readTemplates,
  fmtCnDate,
  fmtCnDateTime,
  fmtCnDateTimeOfDate,
  senderNameOf,
  resolvePartner,
  normalizeQuota,
  scopedQuota,
  channelsOf,
  grantQuota,
  consumeQuota,
  zeroQuota,
  classifyError,
  resolveMiniprogramState,
  MP_STATES,
  isWishNotifyAllowed,
  WISH_NOTIFY_ENABLED,
  sendCoupleNotice,
  sendPeriodReminder
}
