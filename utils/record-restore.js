// ============================================================
// utils/record-restore.js · 记录页状态恢复纯函数（M5 心愿同步修复）
// 背景：_fromRecord 曾同时处理「云端 record（wishes: [{type,text}]）」与
//   「本地草稿（eats: string[] / dos: string[]）」两种 schema，
//   草稿恢复时 r.wishes 为 undefined → eats/dos 被清空 → save payload 空。
// 本模块将两种恢复拆开，便于单测与前端复用。
// ============================================================

// 本地草稿结构恢复：优先 draft.eats / draft.dos（数组）；
// 兼容旧草稿：仅 draft.wishes（[{type,text}]）时 fallback 拆分。
function fromDraft(draft) {
  const d = draft || {}
  const hasEats = Array.isArray(d.eats)
  const hasDos = Array.isArray(d.dos)
  const wishList = Array.isArray(d.wishes) ? d.wishes : []
  const eats = hasEats ? d.eats : wishList.filter(w => w && w.type === 'eat').map(w => w.text)
  const dos = hasDos ? d.dos : wishList.filter(w => w && w.type === 'do').map(w => w.text)
  return { eats, dos }
}

// 云端记录结构恢复：record.wishes（[{type,text}]）→ eats/dos
function fromRecordWishes(record) {
  const r = record || {}
  const wishList = Array.isArray(r.wishes) ? r.wishes : []
  return {
    eats: wishList.filter(w => w && w.type === 'eat').map(w => w.text),
    dos: wishList.filter(w => w && w.type === 'do').map(w => w.text)
  }
}

module.exports = { fromDraft, fromRecordWishes }
