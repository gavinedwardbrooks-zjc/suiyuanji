// ============================================================
// utils/wish-dedup.js · 心愿去重规则（PRD v0.6 §4.2 R4）
// 规则：同类型内 trim 后完全一致即重复，自动去重；跨类型不去重。
// 抽离为纯函数以便自动测试（tests/wish-dedup.test.js）
// ============================================================

/**
 * 判断 text 在 list 中是否重复（同类型列表内判断）
 * @param {string[]} list 当前类型的心愿列表（eats 或 dos）
 * @param {string} text 待添加文本
 * @returns {boolean} true=重复或空输入（拒绝），false=可添加
 */
function isDuplicate(list, text) {
  const t = (text || '').trim()
  if (!t) return true
  return list.some(x => x === t)
}

module.exports = { isDuplicate }
