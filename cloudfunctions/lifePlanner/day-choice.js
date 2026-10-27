// ============================================================
// day-choice.js · 「今天吃什么 / 今天去哪里」确认闭环的纯逻辑（V1.1）
//
// 只放**不碰数据库**的判定：业务日期、确定性文档 ID、参数形状、名称快照。
// 为什么单独成文件：这些规则是「一对情侣 + 一天 + 一种选择只有一份结果」的全部依据，
// 必须能脱离云数据库直接单测（尤其是跨零点与 ID 长度/字符集）。
//
// 三条硬规则：
//   1. 业务日期一律北京时间自然日（云函数运行时是 UTC，见 beijingToday 的注释）。
//   2. 文档 ID 确定性：同 (coupleId, date, kind) 恒等 → 覆盖更新，不产生第二条。
//   3. ID 长度与字符集必须满足微信云数据库对自定义 _id 的约束（≤32 字节，[0-9a-zA-Z_-]）。
// ============================================================
const crypto = require('crypto')

// 集合名（云函数管理端写入；客户端不直读直写）
const CHOICE_COLLECTION = 'day_choices'

// 两种选择：meal = 今天吃什么；travel = 今天去哪里
const KINDS = ['meal', 'travel']

// 确定性 ID 里的单字符编码（省长度）
const KIND_CODE = { meal: 'm', travel: 't' }

// 显示名快照上限（3 个菜名拼起来也在 60 字以内）
const MAX_NAME_LEN = 60

// 自定义 _id 上限：微信云数据库要求字符串、长度不超过 32 字节。
// 本文件的 ID 生成为 28 字符，留 4 字符余量。
const MAX_ID_LEN = 32

const BEIJING_OFFSET_MS = 8 * 3600 * 1000

function pad(n) { return String(n).padStart(2, '0') }

// 北京时间「今天」。
// 云函数运行时区是 UTC（notify.js 里有同样的说明），若直接用 new Date() 的本地字段，
// 北京时间 00:00–08:00 会把「今天」算成昨天 —— 决定写错日期、首页也读不到刚确认的结果。
// 做法：把绝对时间 +8h 后取 UTC 字段，等价于固定 +08:00，且不受服务器时区设置影响。
function beijingToday(now) {
  const ms = now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : Date.now())
  const t = new Date(ms + BEIJING_OFFSET_MS)
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

// 严格日期：格式 + 真实存在（拒绝 2026-02-30）
function isValidDate(raw) {
  if (typeof raw !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (!m) return false
  const y = +m[1], mo = +m[2], d = +m[3]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

function normalizeKind(raw) {
  return KINDS.indexOf(raw) !== -1 ? raw : null
}

// 确定性文档 ID：dc_<日期>_<m|t>_<hash12(coupleId)>
//  · 长度恒为 3 + 10 + 1 + 1 + 1 + 12 = 28 字符（≤ 32）
//  · 字符集只含 [0-9a-zA-Z_-]（date 里的 - 与 hash 的 hex）
//  · 用 coupleId 的哈希而不是明文：ID 更短、且不把内部标识写进可读主键
//  · hash12 = 48bit：两对不同情侣在同一天同一种选择上撞车的概率极低；
//    即便撞了，读写两侧都会比对文档里的 coupleId，撞车只会 fail-closed，不会串数据。
function choiceDocId(coupleId, date, kind) {
  if (typeof coupleId !== 'string' || !coupleId) return null
  if (!isValidDate(date)) return null
  const code = KIND_CODE[kind]
  if (!code) return null
  const h = crypto.createHash('md5').update(coupleId).digest('hex').slice(0, 12)
  const id = `dc_${date}_${code}_${h}`
  return id.length <= MAX_ID_LEN ? id : null
}

// 参数形状：meal 必须正好 1 荤 + 1 素 + 1 汤（三个不同的 ID）；travel 正好 1 个 ID。
// 分类是否匹配由云函数读库后判定（这里只看形状，不信任客户端语义）。
function isValidRefIds(kind, refIds) {
  if (!Array.isArray(refIds)) return false
  const list = refIds.filter(x => typeof x === 'string' && x.trim())
  if (list.length !== refIds.length) return false
  const uniq = new Set(list)
  if (uniq.size !== list.length) return false
  if (kind === 'meal') return list.length === 3
  if (kind === 'travel') return list.length === 1
  return false
}

function limitName(raw) {
  if (typeof raw !== 'string') return ''
  const s = raw.replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, MAX_NAME_LEN) : ''
}

// 三个菜名的显示快照：荤 + 素 + 汤（服务端读库生成，不接受客户端传名）
function mealName(meat, vegetable, soup) {
  const parts = [limitName(meat), limitName(vegetable), limitName(soup)].filter(Boolean)
  // 任何一项缺失都不构成合法的菜名快照（宁可拒绝，也不生成残缺名称）
  if (parts.length !== 3) return ''
  return limitName(parts.join(' + '))
}

module.exports = {
  CHOICE_COLLECTION,
  KINDS,
  KIND_CODE,
  MAX_NAME_LEN,
  MAX_ID_LEN,
  pad,
  beijingToday,
  isValidDate,
  normalizeKind,
  choiceDocId,
  isValidRefIds,
  limitName,
  mealName
}
