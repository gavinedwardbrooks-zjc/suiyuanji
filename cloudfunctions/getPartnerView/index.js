// ============================================================
// getPartnerView · 云函数（PRD v0.8 M5 — 情侣互动）
// actions:
//   view（默认）— 拉取「我们」页数据（按当前角色渲染 her/him 视图）
//   mark         — 陪伴方把对方的心愿标记为「已安排」（原子 + 通知幂等）
//   msg          — 发送留言（可带 requestId 去重；成功后旁路通知对方）
//   readMsg      — 接收方标记留言已读（幂等，只写第一次）
//   sub          — 记录一次「微信消息提醒」订阅授权（一次性订阅配额 +1）
//   setAnniversary — 设置纪念日（active couple 双方可编辑）
//   shareStatus  — 记录方查询自己某一天的分享状态（V1.1 · P3.1）
//   shareSet     — 记录方开启 / 关闭某一天的分享（expectedRev 乐观锁）
//
// V1.1 收尾：记录级点赞 / 留言（原 like / comment）已随产品范围收窄一并移除。
//   这两个 action 现在落到末尾的 BAD_ACTION 分支，不写任何文档。
//   集合 record_interactions 与其历史数据保留，不删除、不清理。
//
// 安全红线（P5）：
//   所有 action 一律先验证当前 OPENID 属于 status === 'active' 的 couple；
//   superseded/expired/pending/missing → { ok:false, code:'NOT_ACTIVE' }
//   身份一律来自 cloud.getWXContext().OPENID
// 隐私红线：
//   partner response 永不含 日记/mood/body/symptoms/herSummary/herReport
//   心愿除「属主」外还必须属于**当前这段 active 关系**（详见 ./wish-scope.js）：
//   换绑/解绑后，上一段关系的私人心愿既不可读、也不可标记，且不会被自动归属。
//   daily_records 中的 partner 可见字段（score / partnerSummary）同样要求
//   记录自身的 coupleId 等于当前关系；缺失或不符 → 一律按「没有这条记录」处理，
//   绝不因为「同一天」就把上一段关系的内容透出去。
// ============================================================
const cloud = require('wx-server-sdk')
const notify = require('./notify')
const wishScope = require('./wish-scope')
// V1.1 · P3.1：日期级主动分享的判定（纯逻辑，零写入）
const recShare = require('./record-share')
// V1.1：双方共同待办的纯逻辑（与个人待办 daily_records.todos 完全隔离）
const coupleTodo = require('./couple-todo')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
// 注：写入路径仍一律用 where().update() / where().remove()（旧的 updateWhere 已废弃）。
// db.command 只用于**读**：心愿按创建日取区间（gte/lte）。
const cmd = db.command

const MSG_LIMIT = 50
const MSG_MAX_LEN = 500
const TPL_ARRANGE = process.env.TPL_ARRANGE || '' // 心愿已安排订阅模板（真云配置，不硬编码）

function pad(n) { return String(n).padStart(2, '0') }
function fmt(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }

// 业务日期统一按**北京时间自然日**（= UTC+8）。
// 云函数运行时区是 UTC（见 notify.js），若直接用 fmt(new Date())：
//   · 北京时间 00:00–08:00 会把「今天」算成昨天 → 在一起的第 N 天少 1 天；
//   · 同一天里 normalizeDay 会拒掉客户端传的「今天」日期 → 分享开关打不开。
// 做法：绝对时间 +8h 后取 UTC 字段 —— 固定 +08:00，且不受服务器时区设置影响。
const BEIJING_OFFSET_MS = 8 * 3600 * 1000
function beijingToday(now) {
  const ms = now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : Date.now())
  const t = new Date(ms + BEIJING_OFFSET_MS)
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

// 绝对时间戳 → 它属于北京时间的哪一天。非法值一律返回 ''（不猜、不兜成今天）。
function beijingDateOf(ms) {
  const t = Number(ms)
  if (!Number.isFinite(t) || t <= 0) return ''
  return beijingToday(new Date(t))
}

// 北京时间某个自然日的毫秒区间（左闭右闭，整数时间戳上没有歧义）。
// 用于「只取这一天创建的心愿」，避免把整段关系的历史心愿都搬进某一天。
function dayRangeOf(date) {
  const d = parseDate(date)
  if (!d) return null
  const start = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - BEIJING_OFFSET_MS
  return { start, end: start + 86400000 - 1 }
}

// 时间戳是否落在北京时间的某一天（createdAt 不是可信数字时判否 → 不归属任何一天）
function isOnBeijingDay(ms, date) {
  const s = beijingDateOf(ms)
  return !!s && s === date
}

// 纯日期解析（拒绝 2026-02-30 等）
function parseDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''))
  if (!m) return null
  const y = +m[1], mo = +m[2], d = +m[3]
  const dt = new Date(y, mo - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null
  return dt
}

// 纯年月日差值（daysBetween + 1 = 在一起第 N 天）
function daysBetween(a, b) {
  const da = parseDate(a), dbb = parseDate(b)
  if (!da || !dbb) return null
  const t1 = Date.UTC(da.getFullYear(), da.getMonth(), da.getDate())
  const t2 = Date.UTC(dbb.getFullYear(), dbb.getMonth(), dbb.getDate())
  return Math.round((t2 - t1) / 86400000)
}
function daysTogether(anniversary, today) {
  const n = daysBetween(anniversary, today)
  return n === null ? null : n + 1
}

// 统一鉴权：当前 OPENID 必须在 active couple 中；返回 { couple, me, partnerOpenid } 或 null
// 成员校验不可省：users.coupleId 可能指向一段与自己无关的关系（历史遗留 / 人工改库 /
// 换绑中断），只按 coupleId 等值查会把它变成越权入口。
async function getActiveCouple(openid) {
  const me = (await db.collection('users').where({ _openid: openid }).get()).data[0]
  if (!me || !me.coupleId) return null
  const c = (await db.collection('couples').where({ coupleId: me.coupleId, status: 'active' }).get()).data[0]
  if (!c) return null
  if (c.herOpenid !== openid && c.himOpenid !== openid) return null
  return {
    couple: c,
    me,
    partnerOpenid: me.role === 'him' ? c.herOpenid : c.himOpenid
  }
}

// ============================================================
// V1.1 · 「这天的愿望」按业务日期（wishDate）读取
//
// 演进（2026-10-26 · 用户批准）：
//   上一版把 `createdAt` 当业务日期 —— 补写历史某天时，createdAt 是「实际写库那一刻」，
//   于是那天的心愿被算到今天；而且同文本跨日会被判重，第二天根本建不出心愿。
//   现在入口侧写入 `wishDate`（= 记录自身的 date，服务端校验），读取以它为准。
//
// 唯一归属口径 `wishBelongsToDay`：
//   · 有 wishDate  → 只认 wishDate（客户端伪造不了：写入只认记录日期）
//   · 无 wishDate（历史文档）→ 退回 createdAt 的北京日期
//     （只读兼容；这是近似，补写过的历史记录会被算到实际写库那天）
//   · 值异常（数字/对象/空串）→ 不归属任何一天（不猜）
//
// 历史文档为什么不补写 wishDate：归属一旦落到写操作，就必须先有人确认真实日期；
// 无法确认的一律保留原样（不迁移、不删除、不擅自补字段）。
// ============================================================
function mapWishForView(w) {
  return {
    _id: w._id,
    type: w.type,
    text: w.text,
    status: w.status,
    arrangedAt: w.arrangedAt || null,
    createdAt: w.createdAt || 0
  }
}

function visibleWishOf(w, ctx) {
  if (!w) return false
  if (w.status !== 'pending' && w.status !== 'done_by_partner') return false
  // 双保险：查询已按 coupleId 等值过滤，这里再用同一套判定复核一次
  return wishScope.isWishShared(w, ctx)
}

// 这条心愿是否属于「这一天」（唯一口径，见上方注释）
function wishBelongsToDay(w, date) {
  if (!w) return false
  const wd = w.wishDate
  if (typeof wd === 'string' && wd) return wd === date
  if (wd !== undefined && wd !== null) return false // 异常值 → 不归属任何一天
  return isOnBeijingDay(w.createdAt, date)
}

// 取「北京时间的某一天」的心愿。两条查询各司其职：
//   ① `wishDate` 等值 —— 权威路径（新数据；补写历史日期也在这里命中）
//   ② `createdAt` 区间 —— **只服务没有 wishDate 的历史文档**，合并后仍要过
//      `wishBelongsToDay`：带 wishDate 却落在别的日子的（补写场景）会被剔掉，
//      不会因为「写库那天」把心愿挪走。
// 索引没建 / 查询报错时，哪一条失败就只降级哪一条（打到已取回的列表里按同一口径筛），
// 不编造数据、不把昨天的心愿当成今天的。
async function readDayWishes(date, ownerOpenid, coupleId, ctx, fallbackRows) {
  if (!ownerOpenid) return []
  const range = dayRangeOf(date)
  if (!range) return []
  const col = db.collection('wishes')
  const rows = []

  try {
    const byDate = (await col.where({ _openid: ownerOpenid, coupleId, wishDate: date })
      .orderBy('createdAt', 'asc')
      .limit(wishScope.WISH_VISIBLE_LIMIT)
      .get()).data
    for (const w of byDate || []) rows.push(w)
  } catch (e) {
    console.warn('[day-wishes-date-fail]', (e && (e.errMsg || e.message)) || String(e))
    // 退化：已取回的整份心愿列表里按同一口径筛（含 wishDate 的那部分）
    for (const w of (fallbackRows || [])) {
      if (wishBelongsToDay(w, date)) rows.push(w)
    }
  }

  try {
    const byCreated = (await col.where({
      _openid: ownerOpenid,
      coupleId,
      createdAt: cmd.gte(range.start).and(cmd.lte(range.end))
    }).orderBy('createdAt', 'asc')
      .limit(wishScope.WISH_VISIBLE_LIMIT)
      .get()).data
    for (const w of byCreated || []) rows.push(w)
  } catch (e) {
    console.warn('[day-wishes-range-fail]', (e && (e.errMsg || e.message)) || String(e))
    for (const w of (fallbackRows || [])) {
      if (isOnBeijingDay(w.createdAt, date)) rows.push(w)
    }
  }

  // 合并：按 _id 去重 → 同一口径复核 → 按创建时间升序 → 上限
  const seen = Object.create(null)
  const merged = []
  for (const w of rows) {
    if (!w || !w._id || seen[w._id]) continue
    seen[w._id] = true
    if (!wishBelongsToDay(w, date)) continue
    if (!visibleWishOf(w, ctx)) continue
    merged.push(w)
  }
  merged.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
  return merged.slice(0, wishScope.WISH_VISIBLE_LIMIT).map(mapWishForView)
}

// 通知 her「心愿已安排」（仅成功发送才写 notifySentAt；未授权/无模板/失败 → 业务不受影响）
async function notifyArranged(wishId, herOpenid) {
  if (!TPL_ARRANGE) return { sent: false, reason: 'no_template' }
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: herOpenid,
      templateId: TPL_ARRANGE,
      page: 'pages/ours/ours',
      data: {
        thing1: { value: '你的心愿被安排啦' },
        thing2: { value: '来看看是哪一件吧' }
      }
    })
    return { sent: true }
  } catch (e) {
    console.error('notifyArranged fail', wishId, e.errCode || e.message)
    return { sent: false, reason: 'send_failed' }
  }
}

// ============================================================
// V1.1 · P3.1：日期级主动分享的服务端读取（全部零写入口径）
// ============================================================

// 日期归一：必须是合法的 YYYY-MM-DD，且不晚于服务器当天。
// 分享以日期为核心键，非法日期直接拒绝（不猜、不纠正）。
function normalizeDay(raw) {
  if (typeof raw !== 'string' || !raw) return null
  if (!parseDate(raw)) return null
  if (raw > beijingToday()) return null
  return raw
}

// 读取某一天的分享状态文档（可能不存在 = 从未分享）
async function findDayShare(ownerOpenid, date) {
  if (typeof ownerOpenid !== 'string' || !ownerOpenid) return null
  const r = await db.collection(recShare.SHARE_COLLECTION)
    .where({ _openid: ownerOpenid, date }).get()
  return (r.data || [])[0] || null
}

exports.main = async (event = {}, context) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { ok: false, code: 'UNAUTHORIZED', msg: '未获取到用户身份' }

  const active = await getActiveCouple(OPENID)
  if (!active) {
    return { ok: false, code: 'NOT_ACTIVE', msg: '当前情侣关系未生效，请重新绑定' }
  }
  const { couple, me, partnerOpenid } = active

  // ---- mark：陪伴方把对方的心愿标记为「已安排」（原子 + 幂等 + 通知至多一次） ----
  //
  // 归属校验（P0 隐私隔离）：除了「是 her 的 pending 心愿」之外，还必须
  // **属于当前这段关系**。历史文档（无 coupleId）按 wish-scope 的保守规则判定；
  // 判定不出归属的一律拒绝，绝不把上一段关系的心愿标记成「已安排」。
  // 归属判定在服务端完成，前端传不了 coupleId / role / openid。
  if (event.action === 'mark') {
    if (me.role !== 'him') {
      return { ok: false, code: 'FORBIDDEN', msg: '只有心愿的接收方可以标记已安排' }
    }
    const wishId = event.wishId
    if (!wishId) return { ok: false, code: 'BAD_ARGS', msg: '缺少 wishId' }
    // 关系不完整 → 无法确定「谁的心愿可以安排」，拒绝写入（与 readMsg 同一条红线）
    if (!partnerOpenid) return { ok: false, code: 'NO_PARTNER', msg: '当前关系缺少另一半' }

    const wishCtx = wishScope.contextOf(couple)
    const target = (await db.collection('wishes').where({ _id: wishId }).get()).data[0]
    // 不区分「不存在 / 不是 TA 的 / 不属于这段关系」，统一拒绝 ——
    // 避免把别人的心愿是否存在变成可枚举的侧信道。
    // 归属只认「coupleId === 当前关系」；历史文档（无 coupleId）不可证明 → 拒绝。
    const ownable = !!target && target._openid === partnerOpenid
    if (!ownable || !wishScope.isWishShared(target, wishCtx)) {
      return { ok: false, code: 'FORBIDDEN', msg: '心愿不存在或不属于当前关系' }
    }
    // 幂等：已安排过 → 返回当前状态（不重复写 arrangedAt、不重复通知）
    if (target.status !== 'pending') {
      return {
        ok: true,
        already: true,
        arrangedAt: target.arrangedAt || null,
        notifySentAt: target.notifySentAt || null
      }
    }
    // 只允许安排 her 的 pending 心愿（原子：更新行数 === 1 才是第一次合法流转）
    // 用 where().update()：这是 wx-server-sdk 的官方批量更新写法。
    // 注意 updateWhere(...) **不是** SDK 的 API（bindCouple 里的同名方法是它自己
    // 封装的 adapter），在真实云环境直接调用会抛 TypeError。
    // `coupleId` 再次进入 where：归属不只在内存里校验过，写入条件里也钉死一次 ——
    // 即使文档在两次读之间被改动，也不可能把「另一段关系的心愿」流转掉。
    const now = Date.now()
    const upd = await db.collection('wishes').where({
      _id: wishId, _openid: partnerOpenid, coupleId: couple.coupleId, status: 'pending'
    }).update({ data: { status: 'done_by_partner', arrangedAt: now } })
    if (((upd && upd.stats && upd.stats.updated) || 0) !== 1) {
      // 并发下另一方已经先流转 → 幂等返回，不重复通知
      const w = (await db.collection('wishes').where({ _id: wishId }).get()).data[0]
      return {
        ok: true,
        already: true,
        arrangedAt: w ? w.arrangedAt : null,
        notifySentAt: w ? w.notifySentAt || null : null
      }
    }
    // 第一次成功流转 → 尝试通知（成功才写 notifySentAt）
    // 注意：变量不能叫 notify —— 会在这个块级作用域里遮蔽顶部 require 的 notify 模块。
    const arrangeNotice = await notifyArranged(wishId, partnerOpenid)
    if (arrangeNotice.sent) {
      await db.collection('wishes').doc(wishId).update({ data: { notifySentAt: Date.now() } })
    } else {
      await db.collection('wishes').doc(wishId).update({ data: { notificationSkipped: true } })
    }
    return { ok: true, arrangedAt: now, notifySent: arrangeNotice.sent }
  }

  // ---- msg：发送留言（requestId 去重 + 旁路通知对方） ----
  if (event.action === 'msg') {
    const text = String(event.text || '').trim().slice(0, MSG_MAX_LEN)
    if (!text) return { ok: false, code: 'BAD_ARGS', msg: '留言不能为空' }
    const requestId = event.requestId ? String(event.requestId) : ''

    // 幂等：同一发送者对同一 couple 的同一 requestId 只落一条、只通知一次。
    // 客户端在失去响应后重试会复用同一个 requestId（见 pages/ours/ours.js）。
    if (requestId) {
      const dup = (await db.collection('messages')
        .where({ coupleId: couple.coupleId, fromOpenid: OPENID, requestId })
        .get()).data
      if (dup.length) {
        return { ok: true, idempotent: true, msgId: dup[0]._id, notifiedAt: dup[0].notifiedAt || null }
      }
    }

    const doc = {
      coupleId: couple.coupleId,
      fromOpenid: OPENID,
      fromRole: me.role,
      text,
      readAt: null, // 显式 null，供已读原子更新匹配
      createdAt: Date.now()
    }
    if (requestId) doc.requestId = requestId
    const added = await db.collection('messages').add({ data: doc })
    const msgId = (added && added._id) || null

    // 通知是旁路：失败/未授权/无模板都不影响留言本身已经保存成功
    let notice = { sent: false, reason: 'skipped' }
    if (msgId) {
      notice = await notify.sendCoupleNotice({
        db, cloud, env: process.env, openid: OPENID, kind: 'msg', at: doc.createdAt
      })
      try {
        await db.collection('messages').doc(msgId).update({
          data: notice.sent ? { notifiedAt: Date.now() } : { notificationSkipped: true }
        })
      } catch (e) {
        console.warn('msg notify flag write fail', e && (e.errMsg || e.message))
      }
    }
    return { ok: true, msgId, notifySent: notice.sent, notifyReason: notice.reason }
  }

  // ---- sub：记录一次「微信消息提醒」订阅授权（一次性订阅配额 +1） ----
  // 只能由当前用户为自己登记；前端传不了别人的 openid（身份来自 WXContext）。
  // 心愿与悄悄话共用一个模板（chat 通道）→ 一次授权只记 1 次，
  // granted 里同时出现 wish 与 msg 也不会记成 2 次（见 notify.channelsOf 去重）。
  if (event.action === 'sub') {
    const granted = Array.isArray(event.granted) ? event.granted
      : (Array.isArray(event.channels) ? event.channels : [])
    const r = await notify.grantQuota(db, OPENID, granted, notify.readTemplates(process.env))
    if (!r.ok) return { ok: false, code: 'BAD_ARGS', msg: '未收到有效的订阅结果' }
    return { ok: true, quota: r.quota }
  }

  // ---- readMsg：接收方标记留言已读（幂等：readAt 只写第一次） ----
  //
  // 权限模型（越权一律 updated=0，不区分「不存在 / 不是给你的 / 已读」，
  // 避免把别人的消息是否存在变成可枚举的侧信道）：
  //   · 当前 OPENID 必须处于 status=active 的 couple（函数入口已校验）
  //   · 消息必须属于**当前这对** couple      → 挡住跨情侣越权
  //   · 消息必须由**另一半**发出              → 发送方无法清掉接收方的未读，
  //                                            也无法清掉第三方消息的未读
  //   · readAt 必须为 null（缺失视为 null）   → 幂等，只会写第一次
  // 旧数据兼容：M5 之前写入的 messages 没有 readAt 字段，云数据库里
  // `readAt: null` 同时匹配「显式 null」与「字段缺失」，因此老消息也能正常标记。
  if (event.action === 'readMsg') {
    const msgId = event.msgId
    if (!msgId) return { ok: false, code: 'BAD_ARGS', msg: '缺少 msgId' }
    // 关系不完整（role 缺失 / 对方 openid 为空）→ 无法确定「谁是接收方」，拒绝写入
    if (!partnerOpenid) return { ok: false, code: 'NO_PARTNER', msg: '当前关系缺少另一半' }
    const upd = await db.collection('messages').where({
      _id: msgId,
      coupleId: couple.coupleId,
      fromOpenid: partnerOpenid,
      readAt: null
    }).update({ data: { readAt: Date.now() } })
    const updated = (upd && upd.stats && upd.stats.updated) || 0
    return { ok: true, updated } // 0 = 已读 / 非接收方 / 非本对情侣（幂等）
  }

  // ---- setAnniversary：设置纪念日（active couple 双方可编辑） ----
  if (event.action === 'setAnniversary') {
    const anniversary = event.anniversary
    const parsed = parseDate(anniversary)
    if (!parsed) return { ok: false, code: 'BAD_ARGS', msg: '纪念日格式应为 YYYY-MM-DD' }
    if (anniversary > beijingToday()) {
      return { ok: false, code: 'BAD_ARGS', msg: '纪念日不能晚于今天' }
    }
    await db.collection('couples').doc(couple._id).update({ data: { anniversary, updatedAt: Date.now() } })
    return { ok: true, anniversary, days: daysTogether(anniversary, beijingToday()) }
  }

  // ---- setPartnerName：设置「我给 TA 的称呼」（本人设置，作用于自己的 users 文档） ----
  // 称呼是**查看者自己**设定的：女生叫男生「小胖」、男生叫女生「宝宝」，互不覆盖。
  // 只能改自己的（me 来自 getActiveCouple，身份由 WXContext 决定，前端传不了别人）。
  // 清空 / 恢复默认：传空串即可（'' 表示没有自定义称呼，UI 回退「TA」）。
  if (event.action === 'setPartnerName') {
    const raw = event.name
    if (typeof raw !== 'string') return { ok: false, code: 'BAD_ARGS', msg: '称呼格式不正确' }
    const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 12)
    await db.collection('users').doc(me._id).update({
      data: { partnerName: name, partnerNameAt: Date.now() }
    })
    return { ok: true, partnerName: name }
  }

  // ============================================================
  // V1.1 · P3.1 日期级主动分享
  //
  // 共同红线：
  //   · 身份只来自 WXContext.OPENID；客户端传的 openid / coupleId / role 一律不看
  //   · 判定要求「当前这段 active 关系」+「记录归属这段关系」
  //   · 分享授权额外绑定 himOpenid，换绑后旧授权对新伴侣自动失效
  //   · him 侧任何不满足都拿不到内容，也不泄露「她这天有没有记录」
  // ============================================================

  // ---- shareStatus：her 查询自己某一天的分享状态 ----
  if (event.action === 'shareStatus') {
    if (me.role !== 'her') return { ok: false, code: 'FORBIDDEN', msg: '只有记录方可以查看分享状态' }
    const date = normalizeDay(event.date)
    if (!date) return { ok: false, code: 'BAD_ARGS', msg: '日期不合法' }
    const rec = (await db.collection('daily_records').where({ _openid: OPENID, date }).get()).data[0]
    // 记录必须归属当前关系才谈得上分享；历史记录缺 coupleId → canShare=false
    // （与 score / partnerSummary 的 fail-closed 口径一致，不做批量回填）
    const canShare = wishScope.isRecordInCouple(rec, couple)
    const shareDoc = await findDayShare(OPENID, date)
    const enabled = canShare && recShare.isShareActiveFor(shareDoc, couple, couple.himOpenid, date)
    // rev = 服务端权威版本号（无文档 → 0）。客户端必须原样回传到 shareSet.expectedRev，
    // 否则服务端无法区分「他看的是哪一版」，只能拒绝写入（见 shareSet 的 CAS 规则）。
    return {
      ok: true,
      date,
      enabled,
      canShare,
      hasRecord: !!rec,
      rev: recShare.shareRevOf(shareDoc)
    }
  }

  // ---- shareSet：her 开启 / 关闭某一天的分享（幂等）----
  if (event.action === 'shareSet') {
    if (me.role !== 'her') return { ok: false, code: 'FORBIDDEN', msg: '只有记录方可以分享这一天' }
    const date = normalizeDay(event.date)
    if (!date) return { ok: false, code: 'BAD_ARGS', msg: '日期不合法' }
    // 严格布尔：只接受 true / false。'true'、1 之类一律拒绝，不猜客户端意图。
    if (event.enabled !== true && event.enabled !== false) {
      return { ok: false, code: 'BAD_ARGS', msg: 'enabled 必须是布尔值' }
    }
    const enabled = event.enabled
    const rec = (await db.collection('daily_records').where({ _openid: OPENID, date }).get()).data[0]
    if (!rec) return { ok: false, code: 'NO_RECORD', msg: '这一天还没有记录，无法分享' }
    if (!wishScope.isRecordInCouple(rec, couple)) {
      return { ok: false, code: 'RECORD_NOT_IN_COUPLE', msg: '这一天的记录不属于当前绑定关系，无法分享' }
    }
    const himOpenid = couple.himOpenid
    if (typeof himOpenid !== 'string' || !himOpenid) {
      return { ok: false, code: 'NO_PARTNER', msg: '当前关系缺少另一半' }
    }
    const id = recShare.shareDocId(OPENID, date)

    // P3.3-R1（D2）：分享开关改为 **客户端确认版本号** 的 CAS，不再由服务端自动重试。
    //
    // 规则（唯一依据，不看按钮点击先后）：
    //   · 客户端读取 shareStatus 时拿到 `rev`，提交时原样回传 `expectedRev`；
    //   · 只有 expectedRev === 服务端当前 rev 才允许写入，写成功后 rev+1；
    //   · 不一致 → CONFLICT，**零写入**，且绝不「重读最新版本再写一遍」
    //     —— 那等于把过期请求自动升级到最新状态，正是本轮要禁止的覆盖；
    //   · 完全没带 expectedRev 的旧请求 → 同样 CONFLICT（无版本号就无法证明它看的是哪一版），
    //     不存在「缺字段就当无条件覆盖」的兼容分支。
    //   · 首次创建：只有 expectedRev === 0（=「我认为还没有分享文档」）才允许 add；
    //     并发下 add 撞确定性 _id 会失败，此时重新读取后仍按同一个 expectedRev 判定，
    //     因此后到者得到 CONFLICT 而不是覆盖。
    const hasRawExpected = event.expectedRev !== undefined && event.expectedRev !== null
    const expectedRev = recShare.normalizeExpectedRev(event.expectedRev)
    if (expectedRev === null) {
      return hasRawExpected
        ? { ok: false, code: 'BAD_ARGS', msg: 'expectedRev 必须是非负整数' }
        : { ok: false, code: 'CONFLICT', needRefresh: true, msg: '缺少分享状态版本号，请刷新后再试' }
    }

    let applied = false
    let committedRev = 0
    let writeErr = null
    // 最多两轮：第二轮只为处理「并发创建撞确定性 _id」，不用于掩盖版本冲突
    for (let attempt = 0; attempt < 2 && !applied; attempt++) {
      const fresh = await getActiveCouple(OPENID)
      if (!fresh) return { ok: false, code: 'NOT_ACTIVE', msg: '当前情侣关系未生效，请重新绑定' }
      if (fresh.couple.coupleId !== couple.coupleId) {
        return { ok: false, code: 'STALE_RELATION', msg: '绑定关系已变化，请重新进入后再试' }
      }
      const currentHim = fresh.couple.himOpenid
      if (typeof currentHim !== 'string' || !currentHim) {
        return { ok: false, code: 'NO_PARTNER', msg: '当前关系缺少另一半' }
      }
      const now = Date.now()
      // 只写分享相关字段：既不会覆盖整份文档，也完全不触碰 daily_records。
      // R1-1：显式开关是用户的权威决定 → 恒清除补偿留下的失效标记，
      // 否则「异常失效过」的文档会永久停在「enabled=true 但判定恒 false」的矛盾态。
      const patch = {
        coupleId: fresh.couple.coupleId,
        himOpenid: currentHim,
        enabled,
        invalidated: false,
        invalidatedAt: null,
        updatedAt: now
      }
      if (enabled) patch.enabledAt = now
      else patch.disabledAt = now
      const existing = (await db.collection(recShare.SHARE_COLLECTION).where({ _id: id }).get()).data[0]

      if (!existing) {
        if (expectedRev !== 0) {
          // 客户端以为有版本，但服务端没有文档（被删/从未创建）→ 让它刷新，不猜
          return { ok: false, code: 'CONFLICT', rev: 0, msg: '分享状态已变化，请刷新后再试' }
        }
        try {
          await db.collection(recShare.SHARE_COLLECTION).add({
            data: Object.assign({ _id: id, _openid: OPENID, date, rev: 1, createdAt: now }, patch)
          })
          committedRev = 1
          applied = true
        } catch (e) {
          // 并发下另一个请求先建了同一 _id（确定性 _id 的唯一约束）→ 下一轮重读再判定
          writeErr = e
        }
        continue
      }

      const curRev = recShare.shareRevOf(existing)
      if (expectedRev !== curRev) {
        return { ok: false, code: 'CONFLICT', rev: curRev, msg: '分享状态已变化，请刷新后再试' }
      }
      let upd = null
      try {
        upd = await db.collection(recShare.SHARE_COLLECTION)
          .where(Object.assign({ _id: id }, recShare.revConditionOf(existing)))
          .update({ data: Object.assign({ rev: curRev + 1 }, patch) })
      } catch (e) {
        // 写入失败 → 明确报错，绝不假装成功，也不自动再试一遍
        console.warn('shareSet write fail', (e && e.errCode) || 'write_fail')
        return { ok: false, code: 'DB_ERROR', msg: '分享状态没有保存成功，请稍后重试' }
      }
      if (((upd && upd.stats && upd.stats.updated) || 0) === 1) {
        committedRev = curRev + 1
        applied = true
      } else {
        // 本次 CAS 的版本在读取与写入之间被别人推进 → 明确冲突（不重试 = 不替客户端升级）
        // 不回传 rev：此时手里读到的是旧值，回传会误导客户端；让它重新读一次权威状态。
        return { ok: false, code: 'CONFLICT', msg: '分享状态已变化，请刷新后再试' }
      }
    }
    if (!applied) {
      // 只记录固定标签与错误码：不把文档内容 / openid 写进日志
      console.warn('shareSet create race fail', (writeErr && writeErr.errCode) || 'write_fail')
      return { ok: false, code: 'CONFLICT', msg: '分享状态正在被修改，请稍后重试' }
    }

    // 写后关系复检（兜底）：
    // 分享文档按 (her, 日期) 单文档跨关系复用，换绑若发生在本次写入期间，
    // 本次写入可能把**上一段关系**的 coupleId/himOpenid 重新写回去。
    //
    // R1-2：补偿必须严格绑定「本次提交出来的那一版」——
    // 条件里同时带 `rev: committedRev` 与 `coupleId`，因此：
    //   · 后续请求已提交更新版本（rev 已推进）→ updated=0 → 不做任何补偿，
    //     绝不把新关系刚写下的授权关掉；
    //   · 只有仍然是本次那一版时才置失效。
    // 说明：这是应用层兜底，不是数据库级原子（真实事务语义见设计文档）。
    const after = await getActiveCouple(OPENID)
    if (!after || after.couple.coupleId !== couple.coupleId) {
      let rollback = 'skipped' // skipped = 已有更新的提交接管了这条文档，本次不做补偿
      try {
        const upd = await db.collection(recShare.SHARE_COLLECTION)
          .where({ _id: id, coupleId: couple.coupleId, rev: committedRev })
          .update({
            data: {
              enabled: false,
              invalidated: true,
              invalidatedAt: Date.now(),
              rev: committedRev + 1
            }
          })
        if (((upd && upd.stats && upd.stats.updated) || 0) === 1) rollback = 'applied'
      } catch (e) {
        // 补偿失败也不能放行：旧文档仍带旧 coupleId，isShareActiveFor 会因关系不符拒绝
        rollback = 'failed'
        console.warn('shareSet rollback fail', (e && e.errCode) || 'write_fail')
      }
      return { ok: false, code: 'STALE_RELATION', rollback, msg: '绑定关系已变化，请重新进入后再试' }
    }
    // 幂等：重复开启/关闭都收敛到同一个状态，永远只有一条授权文档
    return { ok: true, date, enabled, rev: committedRev }
  }

  // ============================================================
  // V1.1 · 双方共同待办（couple_todos）
  //
  // 与个人待办 daily_records.todos 的边界：
  //   · 个人待办：按 _openid + date 存整天快照，只有她本人能写（本函数完全不碰）
  //   · 共同待办：按 coupleId 归属的独立集合，双方权限相同
  //
  // 每个 op 都按同一条红线执行：
  //   ① 身份来自 WXContext.OPENID（函数入口已校验 active couple）
  //   ② coupleId 只用服务端解析出来的那一个，客户端传的一律不看
  //   ③ 单条操作必须 where({ _id, coupleId }) 双条件 → 跨情侣改不动、删不掉
  //   ④ 无效输入 / 数据库失败 → 明确错误码，绝不假装成功
  //
  // 并发取舍：单文档 where().update() / where().remove()，
  // 不做通用事务框架（这里没有任何需要跨文档一致的写）。
  // ============================================================
  if (event.action === 'coupleTodo') {
    const op = event.op
    const tcol = db.collection(coupleTodo.TODO_COLLECTION)
    const role = couple.herOpenid === OPENID ? 'her' : (couple.himOpenid === OPENID ? 'him' : null)
    // 成员校验不可省：只有 members 才谈得上共同待办
    if (!role) return { ok: false, code: 'NOT_ACTIVE', msg: '当前情侣关系未生效，请重新绑定' }

    if (op === 'list') {
      const raw = (await tcol.where({ coupleId: couple.coupleId })
        .orderBy('createdAt', 'desc')
        .limit(coupleTodo.TODO_LIMIT)
        .get()).data
      const items = raw.map(t => {
        const createdAt = typeof t.createdAt === 'number' ? t.createdAt : 0
        const doneAt = typeof t.doneAt === 'number' ? t.doneAt : 0
        return {
          _id: t._id,
          text: typeof t.text === 'string' ? t.text : '',
          done: t.done === true,
          createdAt,
          doneAt,
          // 业务日期一律由服务端按北京时间算，客户端不再做时区推算。
          // createdDate 用于「这一天新增的」筛选，doneDate 用于显示「完成于哪天」。
          createdDate: beijingDateOf(createdAt),
          doneDate: beijingDateOf(doneAt)
        }
      }).filter(t => t.text)
      return {
        ok: true,
        items: coupleTodo.sortTodos(items),
        limit: coupleTodo.TODO_LIMIT,
        truncated: raw.length >= coupleTodo.TODO_LIMIT
      }
    }

    if (op === 'add') {
      const norm = coupleTodo.normalizeTodoText(event.text)
      if (!norm.ok) {
        const msg = norm.reason === 'TOO_LONG'
          ? `一件事最多 ${coupleTodo.TODO_MAX_LEN} 个字`
          : '写一件要做的事吧'
        return { ok: false, code: 'BAD_ARGS', msg }
      }
      const now = Date.now()
      const added = await tcol.add({
        data: {
          coupleId: couple.coupleId,
          text: norm.text,
          done: false,
          doneAt: 0,
          createdAt: now,
          updatedAt: now,
          // 创建者只做记录用途；权限判定永远不看这两个字段
          createdByRole: role,
          createdByOpenid: OPENID
        }
      })
      return {
        ok: true,
        item: { _id: (added && added._id) || null, text: norm.text, done: false, createdAt: now, doneAt: 0 }
      }
    }

    if (op === 'toggle') {
      const id = typeof event.id === 'string' ? event.id.trim() : ''
      if (!id) return { ok: false, code: 'BAD_ARGS', msg: '缺少待办 id' }
      // 严格布尔：'true' / 1 之类一律拒绝，不猜客户端意图
      if (event.done !== true && event.done !== false) {
        return { ok: false, code: 'BAD_ARGS', msg: 'done 必须是布尔值' }
      }
      const now = Date.now()
      const upd = await tcol.where({ _id: id, coupleId: couple.coupleId }).update({
        data: {
          done: event.done,
          doneAt: event.done ? now : 0,
          updatedAt: now,
          updatedByRole: role
        }
      })
      // 0 = 不存在 / 不属于这段关系（不区分，避免把别人的待办 id 变成可枚举的侧信道）
      if (((upd && upd.stats && upd.stats.updated) || 0) !== 1) {
        return { ok: false, code: 'NOT_FOUND', msg: '这条待办不存在或不属于当前关系' }
      }
      return { ok: true, id, done: event.done, doneAt: event.done ? now : 0 }
    }

    if (op === 'remove') {
      const id = typeof event.id === 'string' ? event.id.trim() : ''
      if (!id) return { ok: false, code: 'BAD_ARGS', msg: '缺少待办 id' }
      const rm = await tcol.where({ _id: id, coupleId: couple.coupleId }).remove()
      if (((rm && rm.stats && rm.stats.removed) || 0) !== 1) {
        return { ok: false, code: 'NOT_FOUND', msg: '这条待办不存在或不属于当前关系' }
      }
      return { ok: true, id, removed: 1 }
    }

    return { ok: false, code: 'BAD_ARGS', msg: '未知操作: ' + String(op) }
  }

  // ---- 默认 view ----
  if (event.action && event.action !== 'view') {
    return { ok: false, code: 'BAD_ACTION', msg: '未知操作: ' + event.action }
  }

  // 日期：客户端可以翻历史，但必须是合法且不晚于今天的 YYYY-MM-DD。
  // 分享的授权按日期对齐，脏日期直接拒绝而不是拿去做查询。
  let date = beijingToday()
  if (event.date !== undefined && event.date !== null && event.date !== '') {
    const d = normalizeDay(event.date)
    if (!d) return { ok: false, code: 'BAD_ARGS', msg: '日期不合法' }
    date = d
  }
  const isHim = me.role === 'him'

  // ---- daily_records：记录级关系归属（P0 · 2026-10-18）----
  //
  // daily_records.coupleId 只在**创建那一刻**由云函数写入（见 dailyRecord.save），
  // 之后任何一次覆盖保存都不会改写它 ⇒ 它是一份「这条记录产生于哪一段关系」
  // 的不可变证据，正是可以拿来做权限判断的东西。
  //
  // 因此 partner 可见字段（score / partnerSummary）只来自**归属当前关系**的记录：
  //   · coupleId 相等   → 正常展示
  //   · coupleId 缺失   → 历史记录，无法证明归属 → 按「没有这条记录」处理
  //   · coupleId 不等   → 上一段关系 → 按「没有这条记录」处理
  // 注意 event.date 由客户端指定（可以翻到任意历史日期），所以这层校验必须在
  // 服务端逐条做，不能依赖「客户端只会查今天」。
  const partnerRecRaw = partnerOpenid
    ? (await db.collection('daily_records').where({ _openid: partnerOpenid, date }).get()).data[0]
    : null
  const rec = wishScope.isRecordInCouple(partnerRecRaw, couple) ? partnerRecRaw : null
  // 自己的记录：本人读取自己的内容不构成跨情侣访问，保持原行为
  const myRec = (await db.collection('daily_records').where({ _openid: OPENID, date }).get()).data[0]

  // M6 A2：partnerSummary（伙伴版小结）her/him 均可读；绝不含 herSummary。
  // 展示的是「哪一份记录里的 partnerSummary」也属于记录级归属的一部分：
  // 上一段关系期间生成的伙伴小结，不得在新关系里继续展示。
  const partnerSummaryRec = isHim
    ? rec
    : (wishScope.isRecordInCouple(myRec, couple) ? myRec : null)
  const partnerSummary = partnerSummaryRec ? (partnerSummaryRec.partnerSummary || '') : ''
  const partnerSummaryAt = partnerSummaryRec ? (partnerSummaryRec.partnerSummaryAt || 0) : 0

  // 心愿：pending + done_by_partner（含安排状态）
  // 归属两道门（P0 隐私隔离）：
  //   ① 属主：her 看自己的；him 看 her 的（wishOwnerOpenid）
  //   ② 关系：coupleId **必须等于**当前关系（直接落到查询条件里）
  //      历史文档（无 coupleId）不满足等值条件 ⇒ 不会被查出 ⇒ 不展示、不改写、不删除。
  // 过滤必须在服务端完成：coupleId 只来自 couples 文档，前端无法参与。
  const wishOwnerOpenid = isHim ? partnerOpenid : OPENID
  const wishCtx = wishScope.contextOf(couple)
  // 关系不完整（另一半 openid 为空）→ 不查询：
  // where({ _openid: null }) 在云数据库里会匹配「字段缺失」的文档，宁可空列表也不冒险。
  let rawWishes = []
  if (wishOwnerOpenid) {
    rawWishes = (await db.collection('wishes')
      .where({ _openid: wishOwnerOpenid, coupleId: couple.coupleId })
      .orderBy('createdAt', 'desc')
      .limit(wishScope.WISH_VISIBLE_LIMIT)
      .get()).data
  }
  const wishes = rawWishes
    .filter(w => visibleWishOf(w, wishCtx))
    .slice(0, wishScope.WISH_VISIBLE_LIMIT)
    .reverse()
    .map(mapWishForView)

  // V1.1：记录页「这天的愿望」只展示**这一天创建**的心愿（北京时间自然日）。
  // 只给 him 算：这个卡片只出现在陪伴方视图里；她的记录页展示的是当天记录快照里的
  // 心愿（daily_records.wishes），本来就跟日期绑定，不需要这条路。
  // 少算一次查询，也避免 her 侧多拿一份自己的历史心愿列表。
  const dayWishes = isHim ? await readDayWishes(date, wishOwnerOpenid, couple.coupleId, wishCtx, rawWishes) : []

  // 留言：最新优先，最多 50
  const rawMsgs = (await db.collection('messages').where({ coupleId: couple.coupleId }).orderBy('createdAt', 'desc').limit(MSG_LIMIT).get()).data
  // 未读（站内提示用）：对方发给我、且我没读过。走服务端真值，不依赖本地存储。
  const unreadMsgs = rawMsgs.filter(m => m.fromOpenid !== OPENID && !m.readAt).length
  const msgs = rawMsgs
    .reverse()
    .map(m => ({
      _id: m._id,
      role: m.fromRole,
      text: m.text,
      createdAt: m.createdAt,
      readAt: m.readAt || null,
      mine: m.fromOpenid === OPENID
    }))

  // 纪念日 + 在一起第 N 天
  const anniversary = couple.anniversary || null
  const todayStr = beijingToday()

  // 经期预计（him 视角：她允许共享的 nextStart；her 视角：自己的）
  let nextStart = null
  let nextLabel = ''
  if (couple) {
    // 经期归属：her 看自己的；him 看她允许共享的（与心愿同源修复）。
    // Task B5：经期是敏感个人信息，him 读取还要求 her 已开启 sharePeriod 授权。
    const menstrualOwner = isHim ? partnerOpenid : OPENID
    const m = (await db.collection('menstrual').where({ _openid: menstrualOwner }).get()).data[0]
    const shareOk = !isHim || (m && m.sharePeriod === true)
    if (m && m.lastStart && shareOk) {
      const cyc = m.cycle || m.cycleLen || 28
      nextStart = addDaysStr(m.lastStart, cyc)
      const [, mo, dd] = nextStart.split('-')
      nextLabel = `${Number(mo)}月${Number(dd)}日左右`
    }
  }

  // 订阅消息记账（服务端估算；真实额度以微信为准，UI 不得声称"永久开启"）。
  // 只回传次数，不回传任何 openid。按通道记账：chat（心愿/悄悄话）、period（经期提醒）。
  const templates = notify.readTemplates(process.env)
  const partnerUser = (await db.collection('users').where({ _openid: partnerOpenid }).get()).data[0]
  const myQuota = notify.scopedQuota((me && me.subQuota) || {}, templates)
  const partnerQuota = notify.scopedQuota((partnerUser && partnerUser.subQuota) || {}, templates)
  // 心愿通知是否被允许（模板用途闸门，见 notify.isWishNotifyAllowed）。
  // 客户端据此决定文案里要不要承诺「加心愿也会提醒你」—— 承诺了却发不出去
  // 比不承诺更糟，所以文案必须跟着服务端的真实开关走。
  const wishNotify = notify.isWishNotifyAllowed(process.env)

  // V1.1 · P3.1：只有 him 才可能拿到「已主动共享」的私人内容。
  // 三重条件缺一不可：
  //   ① 记录归属当前关系（上面的 isRecordInCouple 已经算过，rec 非空即通过）
  //   ② 这一天的分享对**当前这个 him** 生效（couple + himOpenid + date 全等）
  //   ③ 调用者确实是 him（her 不需要也不可能通过这里拿自己的「共享」内容）
  // 不满足时 shared 恒为 null —— 不返回空对象，避免前端误判为「已共享但为空」。
  let shared = null
  if (isHim && rec && partnerOpenid) {
    const shareDoc = await findDayShare(partnerOpenid, date)
    if (recShare.isShareActiveFor(shareDoc, couple, OPENID, date)) {
      shared = recShare.pickSharedContent(rec)
    }
  }

  return {
    ok: true,
    role: me.role,
    // 我给 TA 的称呼（查看者自己设定；空 = 通用「TA」）
    myPartnerName: typeof me.partnerName === 'string' ? me.partnerName.trim().slice(0, 12) : '',
    // 今日得分：记录方看自己的打分；陪伴方看对方允许共享的 score
    score: isHim ? (rec ? rec.score : null) : (myRec ? myRec.score : null),
    wishes,
    // 这一天（event.date，默认北京时间今天）创建的心愿；她的视角恒为空数组
    dayWishes,
    messages: msgs,
    unreadMsgs,
    myQuota,
    partnerQuota,
    wishNotify,
    anniversary,
    days: anniversary ? daysTogether(anniversary, todayStr) : null,
    nextStart,
    nextLabel,
    partnerSummary,
    partnerSummaryAt,
    partnerRole: isHim ? 'her' : 'him',
    // 仅在「这一天的分享对当前 him 生效」时非空（见上方注释）
    shared
  }
}

// 供单测导出
module.exports.main = exports.main
module.exports.parseDate = parseDate
module.exports.daysBetween = daysBetween
module.exports.daysTogether = daysTogether
module.exports.beijingToday = beijingToday
module.exports.beijingDateOf = beijingDateOf
module.exports.dayRangeOf = dayRangeOf
module.exports.isOnBeijingDay = isOnBeijingDay
module.exports.wishBelongsToDay = wishBelongsToDay
module.exports.coupleTodo = coupleTodo

function addDaysStr(dateStr, n) {
  const dt = parseDate(dateStr)
  if (!dt) return null
  dt.setDate(dt.getDate() + n)
  return fmt(dt)
}
