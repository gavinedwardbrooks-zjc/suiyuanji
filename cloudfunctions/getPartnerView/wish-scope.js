// ============================================================
// wish-scope · 心愿 / 记录的「情侣关系归属」判定（纯逻辑，零写入）
//
// 背景（P0 隐私缺陷）：
//   早期 wishes 文档只有 `_openid`，没有 `coupleId`。查询只按属主过滤，
//   于是「解绑 → 与另一个人绑定」之后，新伴侣能读到上一段关系的私人心愿，
//   也能把上一段关系的心愿标记为「已安排」。
//
// 判定规则（2026-10-18 收紧，**唯一允许共享的依据**）：
//   文档自带 `coupleId` 且**等于当前生效关系** → 共享；其余一律不共享。
//   历史文档（缺 `coupleId`）→ 'unattributed'，对双方都不展示、不修改、不删除。
//
// 为什么不再用「createdAt >= couple.boundAt」推断历史文档归属
//   （上一轮曾用过，本轮按审计结论撤回）：
//     1. `boundAt` 只写在 pending→active 那次流转里。**早于该字段上线的关系
//        没有 boundAt**，读出来是 0，任何时间比较都失去意义；而用「0 就当作
//        无限早」会把所有历史文档都判成当前关系，正是要防止的事。
//     2. 该推断依赖「一个人同时只可能处于一段生效关系」。但 bindCouple.confirm()
//        只把 `herOpenid` 命中的旧 active 置为 superseded，**him 一侧的旧 active
//        不会被处理**，因此一个人确实可能同时挂着两段 status='active' 的关系，
//        前提不成立。
//     3. 历史心愿可能由旧客户端直接写库，`createdAt` 由客户端提供，不具备
//        不可伪造性；拿它做权限依据等于把权限交给调用方。
//   结论：历史文档的归属**无法可靠证明**，按 fail-closed 一律不共享。
//   （要恢复这部分数据，必须由用户显式确认归属，或执行经批准的迁移；见报告。）
//
// 为什么这里没有「写回 coupleId」的迁移：
//   归属判定一旦落到写操作，就必须先有人确认历史数据的真实归属。
//   本文件刻意只做读时判定（可逆、零副作用）。
//
// 注意：本文件在 getPartnerView 与 dailyRecord 各有一份，必须**逐字节一致**
//      （云函数独立打包，不能跨目录 require；一致性由 tests 守护）。
// ============================================================

// 归属判定的结果
const SAME_COUPLE = 'same-couple'   // 显式属于当前关系（唯一可共享的情况）
const FOREIGN = 'foreign'           // 明确属于另一段关系
const UNATTRIBUTED = 'unattributed' // 无关系标记 / 无法证明 → 不展示、不改写

// 对外展示上限（与修复前保持一致）
const WISH_VISIBLE_LIMIT = 50

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key)
}

// couple 文档 → 判定上下文。
// boundAt 只作为**诊断信息**保留（便于日志/报告），**不参与任何归属判定**。
function contextOf(couple) {
  const coupleId = couple && typeof couple.coupleId === 'string' && couple.coupleId
    ? couple.coupleId
    : null
  return {
    coupleId,
    boundAt: Number(couple && couple.boundAt) || 0
  }
}

// 未绑定 / 关系不生效时的上下文：所有心愿都不共享（fail-closed）
function emptyContext() {
  return { coupleId: null, boundAt: 0 }
}

// 是否为「没有关系标记」的历史文档（缺失或 null）
function isLegacy(wish) {
  if (!wish) return true
  const cid = wish.coupleId
  return cid === undefined || cid === null
}

// 归属判定（纯函数，不读写数据库）
function attributionOf(wish, ctx) {
  if (!wish) return UNATTRIBUTED
  if (!ctx || !ctx.coupleId) return UNATTRIBUTED

  const wcid = wish.coupleId
  if (typeof wcid === 'string' && wcid) {
    return wcid === ctx.coupleId ? SAME_COUPLE : FOREIGN
  }
  // 非字符串但存在的异常值（数字/对象…）→ 无法理解 → 当作异己，绝不归属
  if (wcid !== undefined && wcid !== null) return FOREIGN
  // 历史文档：没有任何可证明的关系标记 → 不猜
  return UNATTRIBUTED
}

// 是否可以向「当前这段关系」展示 / 允许其修改
function isWishShared(wish, ctx) {
  return attributionOf(wish, ctx) === SAME_COUPLE
}

// 创建时判重的作用域：同属主 + 同类型 + 同文本 + **同一段关系**才算重复。
// 未绑定（coupleId = null）时只与同样标记为未绑定的文档比较，
// 不碰没有任何 coupleId 字段的历史文档（否则老数据会挡住新建，心愿再也加不上）。
function isSameScope(wish, ctx) {
  if (!wish) return false
  const cid = ctx ? ctx.coupleId : null
  if (!cid) return hasOwn(wish, 'coupleId') && wish.coupleId === null
  return isWishShared(wish, ctx)
}

// 新文档的关系标记：生效关系 → coupleId；未绑定 → 显式 null（便于精确判重）
function coupleIdForWrite(ctx) {
  return ctx && ctx.coupleId ? ctx.coupleId : null
}

// ============================================================
// 心愿的业务日期（wishDate）
//
// 为什么不再用 createdAt 当业务日期：
//   「补写历史某一天」时，createdAt 是**实际写库的这一刻**（今天），
//   而这条心愿在业务上属于那一天。用 createdAt 归属会把 10-20 的心愿
//   显示到 10-26；更糟的是第二天再写一次同样的心愿会被判成重复，
//   那一整天根本建不出心愿来（用户实测到的缺陷）。
//
// 口径（唯一）：
//   · wishDate 由 dailyRecord.save 按**记录自身的 date** 写入，只认服务端
//     校验过的记录日期；客户端传不了这个字段（传了也不看）。
//   · 一旦写入不再改动（syncWishes 只 add，从不 update）⇒ 改记录日期搬不动旧心愿。
//   · 纯日期字符串 YYYY-MM-DD，按北京时间自然日，不做任何时区换算。
//
// 历史文档（没有 wishDate 字段）：
//   · 读取侧退回 createdAt 的北京日期 —— 只读兼容，**不写回、不补字段**；
//   · 这是近似：补写过的历史记录，其心愿会被算到「实际写库那天」。
//     无法确认的归属就保持原样（宁可少显示，也不擅自迁移）。
// ============================================================
const BEIJING_OFFSET_MS = 8 * 3600 * 1000

function pad2(n) {
  return String(n).padStart(2, '0')
}

// 绝对时间戳 → 北京时间自然日；非法值返回 ''（不猜、不兜成今天）
function beijingDateOf(ms) {
  const t = Number(ms)
  if (!Number.isFinite(t) || t <= 0) return ''
  const d = new Date(t + BEIJING_OFFSET_MS)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

// 合法业务日期：YYYY-MM-DD 且真实存在（拒绝 2026-02-30 这类）
function isValidBizDate(s) {
  if (typeof s !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const y = +m[1], mo = +m[2], d = +m[3]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

// 判重用的「同一天」：这条已有心愿是否属于同一个业务日期。
//   有 wishDate → 只认它（严格等值）；
//   无 wishDate（历史文档）→ 退回 createdAt 的北京日期，**仅用于避免重复创建**，
//     不作为展示归属的依据（否则等于又拿 createdAt 冒充日记日期）。
function isSameWishDate(wish, wishDate) {
  if (!wish || !isValidBizDate(wishDate)) return false
  const wd = wish.wishDate
  if (typeof wd === 'string' && wd) return wd === wishDate
  // 非字符串但存在的异常值（数字/对象…）→ 无法理解 → 不认为同一天
  if (wd !== undefined && wd !== null) return false
  return beijingDateOf(wish.createdAt) === wishDate
}

// daily_records 的读权限：只有**创建时就属于当前关系**的记录才可以给另一半看。
// 缺失 coupleId 的历史记录 = 无法证明归属 → 拒绝展示（fail-closed）。
function isRecordInCouple(rec, couple) {
  if (!rec || !couple) return false
  const cid = couple.coupleId
  if (typeof cid !== 'string' || !cid) return false
  return typeof rec.coupleId === 'string' && rec.coupleId === cid
}

// 由 users.coupleId + couples(status=active) 推导当前生效关系（身份来自调用方 OPENID）
// 返回 { coupleId, couple, error } —— 查不到就是未绑定，不抛错。
// 查询异常则抛出，由调用方决定「整次操作失败」（宁可少写、不可错归属）。
//
// 成员校验：couple 文档必须**真的包含**这个 openid。
// users.coupleId 有可能指向一段与自己无关 / 已失效的关系（历史遗留、人工改库、
// 换绑中断），只按 coupleId 等值查会让这类脏数据变成越权入口。
async function resolveContext(db, openid) {
  if (!openid) return { coupleId: null, couple: null, error: null }
  const me = (await db.collection('users').where({ _openid: openid }).get()).data[0]
  if (!me || !me.coupleId) return { coupleId: null, couple: null, error: null }
  const c = (await db.collection('couples')
    .where({ coupleId: me.coupleId, status: 'active' }).get()).data[0]
  if (!c) return { coupleId: null, couple: null, error: null }
  if (c.herOpenid !== openid && c.himOpenid !== openid) {
    return { coupleId: null, couple: null, error: null }
  }
  return { coupleId: c.coupleId, couple: c, error: null }
}

module.exports = {
  SAME_COUPLE,
  FOREIGN,
  UNATTRIBUTED,
  WISH_VISIBLE_LIMIT,
  isLegacy,
  contextOf,
  emptyContext,
  attributionOf,
  isWishShared,
  isSameScope,
  coupleIdForWrite,
  beijingDateOf,
  isValidBizDate,
  isSameWishDate,
  isRecordInCouple,
  resolveContext
}
