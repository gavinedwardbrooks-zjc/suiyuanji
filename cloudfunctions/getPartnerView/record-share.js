// ============================================================
// record-share · 日期级主动分享的服务端判定（V1.1 · P3.1）
//
// 设计原则（与 P3 指令 §三 一一对应）：
//   · 缺失分享字段 = 不共享；显式 false = 不共享；
//     只有 `enabled === true`（严格布尔）才算授权 —— 字符串 'true'、数字 1 一律不算。
//   · 授权同时绑定：记录的属主（her）+ 日期 + 当前这段 active 关系（coupleId）
//     + 被授权的具体 him 身份（himOpenid）。
//     因此「换绑后新伴侣」拿不到任何旧授权，解绑后旧 him 也拿不到。
//   · 只读判定：本文件不做任何写操作，也不改写 daily_records。
//
// 数据落点：独立集合，不往 daily_records 里塞字段。
//   理由：dailyRecord.save 是按 revision 覆盖 goals/todos/segments/... 的整份写入，
//   分享权限若混在同一条文档里，任何一次保存语义变化都可能把它带掉；
//   独立集合还能让「分享」这件事天然带上 coupleId/himOpenid 的绑定信息。
//
// ------------------------------------------------------------
// V1.1 收尾（本轮）：移除记录级互动
//   原 P3.2 的点赞 / 留言判定（likeDocId、commentDocId、pickInteractionForHim/Her、
//   publicId / opaqueKey / uniqueKeys、actorOf / isInvalidated / isScopedId 等）
//   随功能一并删除。本文件现在只剩「分享授权」这一件事。
//   集合 record_interactions 保留不删、历史数据不清理（见 docs/DEPLOYMENT.md）。
// ------------------------------------------------------------
// ============================================================

// 集合名（云函数管理端写入，客户端无直写权限）
const SHARE_COLLECTION = 'record_shares'

// 单段日记读取上限（防御异常超长内容撑爆端上渲染；正常记录远小于此）
const SEGMENT_MAX_LEN = 20000

const SEGMENT_KEYS = ['life', 'work', 'growth']

// 确定性 _id：同一 (属主, 日期) 只有一条分享状态文档，
// 天然避免「同一天出现两条互相矛盾的授权」。
// 注意：分享文档本身**不**按 coupleId 分片 —— 它记录的是「她今天分享给了谁」，
// 关系信息落在文档字段里，由 isShareActiveFor 逐项比对；
// 换绑后旧字段自然失配，重新开启时被覆盖成新关系（见 shareSet 的乐观锁）。
function shareDocId(ownerOpenid, date) {
  return 'sh_' + ownerOpenid + '_' + date
}

// 严格布尔：只认字面量 true
function isEnabled(share) {
  return !!share && share.enabled === true
}

// 分享文档版本号：缺字段的历史文档按 0 处理（用于 shareSet 的乐观锁）
function shareRevOf(share) {
  const v = share && share.rev
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

// ------------------------------------------------------------
// P3.3-R1：分享开关的 CAS（expectedRev）协议辅助
// ------------------------------------------------------------

// 客户端上送的版本号：只接受非负整数。
// 返回 null 表示「不是合法的版本号」，由调用方区分「完全没带」与「带了但不合法」。
function normalizeExpectedRev(raw) {
  if (typeof raw !== 'number') return null
  if (!Number.isInteger(raw) || raw < 0) return null
  return raw
}

// CAS 的 where 版本条件：
//   · 有数值 rev → 等值比较（唯一能匹配本次读到的那个版本）
//   · 历史文档缺 rev → 用 null 匹配「字段缺失 / 显式 null」
//     （与本仓库既有口径一致：messages.readAt 的更新同样依赖 null 匹配缺字段）
function revConditionOf(doc) {
  const v = doc && doc.rev
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return { rev: v }
  return { rev: null }
}

// 授权是否对「当前这段关系的这个 him、这个日期」有效
// 任何一项对不上都返回 false（fail-closed）
function isShareActiveFor(share, couple, himOpenid, date) {
  if (!isEnabled(share)) return false
  if (!couple || typeof couple.coupleId !== 'string' || !couple.coupleId) return false
  if (typeof himOpenid !== 'string' || !himOpenid) return false
  if (share.coupleId !== couple.coupleId) return false      // 换绑/解绑 → 旧授权失效
  if (share.himOpenid !== himOpenid) return false           // 只授权给这一段关系里的他
  if (share.date !== date) return false
  // 显式作废（例如写后复检发现关系已变时被标记失效）一律不成立
  if (share.invalidated === true) return false
  return true
}

function asText(v, max) {
  if (typeof v !== 'string') return ''
  return max && v.length > max ? v.slice(0, max) : v
}

// him 可见内容：**只有**心情、天气、三段日记。
// 其余字段（goals/todos/score/wishes/herSummary/symptoms/readProgress/...）
// 无论记录里有什么，都不会进入返回值。
function pickSharedContent(rec) {
  if (!rec || typeof rec !== 'object') return null
  const mood = rec.mood && typeof rec.mood === 'object' ? rec.mood : {}
  const segs = rec.segments && typeof rec.segments === 'object' ? rec.segments : {}
  const segments = {}
  for (let i = 0; i < SEGMENT_KEYS.length; i++) {
    segments[SEGMENT_KEYS[i]] = asText(segs[SEGMENT_KEYS[i]], SEGMENT_MAX_LEN)
  }
  return {
    mood: {
      type: typeof mood.type === 'string' ? mood.type : '',
      weather: typeof mood.weather === 'string' ? mood.weather : ''
    },
    segments
  }
}

module.exports = {
  SHARE_COLLECTION,
  SEGMENT_MAX_LEN,
  SEGMENT_KEYS,
  shareDocId,
  isEnabled,
  shareRevOf,
  normalizeExpectedRev,
  revConditionOf,
  isShareActiveFor,
  pickSharedContent
}
