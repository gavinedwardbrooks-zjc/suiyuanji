// ============================================================
// dates.js · 纯日期工具（menstrual 云函数内部共享）
//
// 单独成文件的唯一目的：让「经期预测」只有一套日期算法。
//   index.js  —— 用户的 get / save / month（预测 nextStart）
//   remind.js —— 定时扫描（判断预计日期、倒计时天数）
// 两者必须用同一套 addDays / daysBetween，否则会出现「日历显示 10 月 31 日、
// 提醒却按 11 月 1 日发」这种自相矛盾。tests/period-remind.test.js 的
// SINGLE_DATE_ALGORITHM 守着「云函数目录里只有一份实现」。
// ============================================================

function pad(n) { return String(n).padStart(2, '0') }
function fmt(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }

// 纯年月日日期解析（拒绝 2026-02-30 等非法日期）
function parseDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''))
  if (!m) return null
  const y = +m[1], mo = +m[2], d = +m[3]
  const dt = new Date(y, mo - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null
  return dt
}

// 纯日期加法（年月日级运算，自动进位，覆盖跨月/跨年/闰年；避免时区 DST 裸毫秒计算）
function addDays(dateStr, n) {
  const dt = parseDate(dateStr)
  if (!dt) return null
  dt.setDate(dt.getDate() + n)
  return fmt(dt)
}

// 纯年月日差值（b - a，单位天）。任一非法 → null
function daysBetween(a, b) {
  const da = parseDate(a), dbb = parseDate(b)
  if (!da || !dbb) return null
  const t1 = Date.UTC(da.getFullYear(), da.getMonth(), da.getDate())
  const t2 = Date.UTC(dbb.getFullYear(), dbb.getMonth(), dbb.getDate())
  return Math.round((t2 - t1) / 86400000)
}

function todayStr() { return fmt(new Date()) }

module.exports = { pad, fmt, parseDate, addDays, daysBetween, todayStr }
