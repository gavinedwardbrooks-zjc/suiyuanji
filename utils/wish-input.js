// ============================================================
// utils/wish-input.js · 心愿添加/删除纯函数（M5 心愿交互修复）
// 可靠主入口：按钮/回车统一走 addWish，避免依赖 bindconfirm 真机行为
// ============================================================

// 添加心愿：trim、空不加、同类型去重；成功清空由调用方处理
function addWish(list, raw) {
  const t = String(raw == null ? '' : raw).trim()
  if (!t) return { list, added: false, reason: 'empty' }
  if (list.includes(t)) return { list, added: false, reason: 'dup' }
  return { list: [...list, t], added: true, reason: 'ok' }
}

// 删除心愿（按索引；越界/非法索引返回原数组）
function removeWish(list, index) {
  if (!Array.isArray(list)) return []
  const i = Number(index)
  if (!Number.isInteger(i) || i < 0 || i >= list.length) return list
  const next = list.slice()
  next.splice(i, 1)
  return next
}

module.exports = { addWish, removeWish }
