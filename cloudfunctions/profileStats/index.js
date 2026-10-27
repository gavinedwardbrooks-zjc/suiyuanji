// ============================================================
// profileStats · 云函数（PRD v0.6 §6.1 / M3 H4）
// action: 'week' — 首页最近 7 天回顾（含今天，连续 7 自然日）
// 安全：仅根据 getWXContext() 识别身份，绝不信前端传 openid
// 隐私：只返回 { date, hasRecord }，不返回日记/mood/body/summary 等任何私有字段
// ============================================================
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function fmtDate(d) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { ok: false, msg: '未获取到用户身份' }

  const action = event.action || 'week'
  if (action !== 'week') return { ok: false, code: 'BAD_ACTION', msg: '未知操作: ' + action }

  // 最近 7 个自然日（含今天）
  const today = new Date()
  const days = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    days.push({ date: fmtDate(d) })
  }
  const dateList = days.map(d => d.date)

  // 只查这 7 天里当前用户有记录的日期；投影仅 date 字段（不拉取任何内容字段）
  const res = await db.collection('daily_records')
    .where({ _openid: OPENID, date: _.in(dateList) })
    .field({ date: true })
    .get()

  const have = new Set(res.data.map(r => r.date))
  const result = days.map(d => ({ date: d.date, hasRecord: have.has(d.date) }))
  return { ok: true, days: result }
}
