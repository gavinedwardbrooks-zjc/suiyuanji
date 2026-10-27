// ============================================================
// utils/partner-name.js · 情侣称呼的统一展示口径
//
// 「给 TA 的称呼」是**查看者自己**设定的（存在 users.partnerName）。
// 没有自定义称呼时，全部页面统一回退到通用称呼「TA」，不写死任何个人化称呼。
// ============================================================

function displayName(name) {
  const n = String(name || '').trim()
  return n ? n.slice(0, 12) : 'TA'
}

module.exports = { displayName }
