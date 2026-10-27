// ============================================================
// aiSummary · 云函数（PRD v0.8 M6 — AI 能力升级）
// actions:
//   daily  — 生成 herSummary + partnerSummary（幂等：openid+date+type）
//   weekly — 生成周报双版本（幂等：coupleId+dateRange）
//   cron   — 兼容定时批量（当天全部记录）
// 定时触发：config.json 的 dailySummary 每天 22:00 触发，event.Type==='Timer' 且无 OPENID。
//   · 批量入口（Timer / mode=cron / action=cron）一律要求无 OPENID，防客户端伪造触发全量生成；
//   · daily 入口只处理本人记录，身份只来自 WXContext.OPENID，不接受 event.openid。
// 幂等与防并发：小结写入用 where({ herSummaryAt: null }).update() 原子条件落库，
//   「先查后写」的竞态窗口被消除（见 generateDailySummary）。
// 隐私红线（M6 §5）：
//   partnerPayload 硬白名单：score/完成目标/完成小事/共享心愿/经期预计
//   禁止：diary/mood.type/weather/body/symptoms/herSummary
//   fallback 分开：partnerFallback 只用白名单，绝不复用 herFallback
// A5 降级：AI 失败 → 各自 fallback，页面不空白
// AI Key 仅来自云函数环境变量（AI_API_KEY），仓库/客户端无明文
// ============================================================
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const https = require('https')

const TPL_SUMMARY = process.env.TPL_SUMMARY || ''
const AI_URL = process.env.AI_API_URL || ''
const AI_KEY = process.env.AI_API_KEY || ''
const AI_MODEL = process.env.AI_MODEL || 'gpt-3.5-turbo'

function pad(n) { return String(n).padStart(2, '0') }
function fmt(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function fmtTime(d) { return `${d.getMonth() + 1}月${d.getDate()}日` }
function parseDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''))
  if (!m) return null
  const y = +m[1], mo = +m[2], d = +m[3]
  const dt = new Date(y, mo - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null
  return dt
}
function addDays(dateStr, n) {
  const dt = parseDate(dateStr)
  if (!dt) return null
  dt.setDate(dt.getDate() + n)
  return fmt(dt)
}
function daysBetween(a, b) {
  const da = parseDate(a), dbb = parseDate(b)
  if (!da || !dbb) return null
  return Math.round((Date.UTC(dbb.getFullYear(), dbb.getMonth(), dbb.getDate()) - Date.UTC(da.getFullYear(), da.getMonth(), da.getDate())) / 86400000)
}

// ---------------- A4 经期前 2 天提示（只依赖 nextStart） ----------------
// 返回 { her: '这几天照顾好自己', partner: '这几天多陪陪 TA' } 或 ''
// 用 TA 而不是「她/他」：这两个字段分别给记录方和陪伴方看，不绑定性别。
function periodReminder(nextStart, today) {
  if (!nextStart) return { her: '', partner: '' }
  const n = daysBetween(today, nextStart)
  if (n === 2 || n === 1) {
    return { her: '这几天照顾好自己', partner: '这几天多陪陪 TA' }
  }
  return { her: '', partner: '' }
}

// ---------------- 白名单 payload（隐私核心） ----------------
// partnerPayload：硬白名单，只允许这些键；禁止一切 diary/mood/weather/body/summary
function buildPartnerPayload(rec, menstrual) {
  const nextStart = menstrual && menstrual.nextStart ? menstrual.nextStart : null
  return {
    score: typeof rec.score === 'number' ? rec.score : null,
    doneGoals: (rec.goals || []).filter(g => g && g.done).map(g => g.text),
    doneTodos: (rec.todos || []).filter(t => t && t.done).map(t => t.text),
    sharedWishes: (rec.wishes || []).filter(w => w && w.text).map(w => w.text),
    nextStart,
    nextLabel: nextStart ? `${Number(nextStart.split('-')[1])}月${Number(nextStart.split('-')[2])}日左右` : null
  }
}

function buildHerPayload(rec, profile, menstrual) {
  return {
    segments: rec.segments || { life: '', work: '', growth: '' },
    mood: rec.mood || {},
    weather: rec.mood && rec.mood.weather || '',
    score: rec.score,
    goals: rec.goals || [],
    todos: rec.todos || [],
    wishes: (rec.wishes || []).map(w => w.text),
    nextStart: menstrual && menstrual.nextStart || null,
    profile
  }
}

function buildHerPrompt(p) {
  const s = p.segments || {}
  const lines = [
    '你是 TA 的温柔伴侣。根据 TA 今天的生活记录，写一段 3-5 句、像懂 TA 的人说的暖心总结，不要套话。',
    `心情：${p.mood && p.mood.type || '未知'}`,
    `天气：${p.weather || '未知'}`,
    `TA 的得分：${p.score || '未打'}`,
    `目标：${p.goals.filter(g => g && g.done).map(g => g.text).join('、') || '无'}`,
    `完成的小事：${p.todos.filter(t => t && t.done).map(t => t.text).join('、') || '无'}`,
    `生活：${s.life || ''}`,
    `工作：${s.work || ''}`,
    `成长：${s.growth || ''}`,
    `TA 许的心愿：${p.wishes.join('、') || '无'}`
  ]
  if (p.nextStart) lines.push(`预计下次经期：${p.nextStart}`)
  return lines.join('\n')
}

function buildPartnerPrompt(p) {
  const lines = [
    '你是 TA 的伴侣，请根据以下 TA 今天愿意分享的信息，写一段 2-3 句、让 TA 的伴侣能关心 TA 的简短总结。只依据给出的信息，不要编造细节。',
    `TA 的得分：${p.score != null ? p.score + ' / 5' : '未打分'}`,
    `完成的目标：${p.doneGoals.join('、') || '无'}`,
    `完成的小事：${p.doneTodos.join('、') || '无'}`
  ]
  if (p.sharedWishes && p.sharedWishes.length) lines.push(`TA 许的心愿：${p.sharedWishes.join('、')}`)
  if (p.nextLabel) lines.push(`预计下次经期：${p.nextLabel}`)
  return lines.join('\n')
}

// ---------------- AI 调用（transport 可注入测试） ----------------
let _transport = null // 测试注入；默认 https.request
function callAI(messages) {
  if (_transport) return _transport(messages)
  if (!AI_URL || !AI_KEY) return Promise.reject(new Error('AI not configured'))
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: AI_MODEL, messages, temperature: 0.85 })
    const u = new URL(AI_URL)
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AI_KEY, 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000
    }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => {
        try {
          const j = JSON.parse(d)
          const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content
          if (!text) reject(new Error('invalid AI response'))
          else resolve(text.trim())
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('AI timeout')) })
    req.write(body)
    req.end()
  })
}

// ---------------- A5 fallback（her / partner 分开，partner 只用白名单） ----------------
function herFallback(rec) {
  const s = rec.segments || {}
  const done = (rec.todos || []).filter(x => x && x.done).length
  const total = (rec.todos || []).length
  const mood = rec.mood && rec.mood.type
  let m = '又是平凡却珍贵的一天。'
  if (mood === 'happy') m = '今天你看起来心情不错，真好。'
  else if (mood === 'low') m = '感觉你今天有点低落，想抱抱你。'
  else if (mood === 'angry') m = '今天是不是遇到烦心事了？我都在。'
  else if (mood === 'tired') m = '辛苦啦，今晚早点休息好不好。'
  const lifePart = s.life ? `生活里你说「${String(s.life).slice(0, 18)}」，` : ''
  return `${fmtTime(new Date())}的回顾：你完成了 ${done}/${total} 件小事。${m}${lifePart}不管怎样，我都陪着你。`
}

function partnerFallback(p) {
  const parts = []
  if (p.score != null) parts.push(`TA 今天给你打了 ${p.score} 分`)
  const n = p.doneGoals.length + p.doneTodos.length
  if (n > 0) parts.push(`完成了 ${p.doneGoals.length} 个目标、${p.doneTodos.length} 件小事`)
  if (p.sharedWishes && p.sharedWishes.length) parts.push(`许了心愿：${p.sharedWishes.join('、')}`)
  if (p.nextLabel) parts.push(`预计下次经期 ${p.nextLabel}`)
  const head = parts.length ? parts.join('；') + '。' : 'TA 今天没有分享新的动态。'
  return `${head}可以问问 TA 今天怎么样。`
}

// ---------------- A1 画像升级 ----------------
function weekKey(dateStr) {
  const dt = parseDate(dateStr)
  if (!dt) return ''
  const y = dt.getFullYear()
  const jan1 = new Date(y, 0, 1)
  const week = Math.ceil(((dt - jan1) / 86400000 + jan1.getDay() + 1) / 7)
  return `${y}-W${week}`
}
function extractKeywords(text) {
  return String(text || '').split(/[\s,，。.！!？?、;；]+/).filter(w => w && w.length > 1)
}

async function updateProfile(openid, rec, profile) {
  const s = rec.segments || {}
  const mood = rec.mood && rec.mood.type || 'unknown'
  const wk = weekKey(rec.date || fmt(new Date()))

  // moodTrend：按周聚合
  const moodTrend = profile && profile.moodTrend ? JSON.parse(JSON.stringify(profile.moodTrend)) : {}
  moodTrend[wk] = moodTrend[wk] || {}
  moodTrend[wk][mood] = (moodTrend[wk][mood] || 0) + 1

  // kwBySegment：分段关键词（累计去重，各段 ≤ 20）
  const kwBySegment = profile && profile.kwBySegment ? JSON.parse(JSON.stringify(profile.kwBySegment)) : { life: [], work: [], growth: [] }
  for (const seg of ['life', 'work', 'growth']) {
    const words = extractKeywords(s[seg])
    kwBySegment[seg] = Array.from(new Set([...(kwBySegment[seg] || []), ...words])).slice(0, 20)
  }

  // milestones：里程碑（简单规则：当日目标全完成/指数 5 分），不重复
  const milestones = profile && profile.milestones ? profile.milestones.slice() : []
  const allDone = (rec.goals || []).length >= 3 && (rec.goals || []).every(g => g && g.done)
  if (allDone) {
    const text = `三件大事全部完成（${rec.date}）`
    if (!milestones.includes(text)) milestones.push(text)
  }
  if (rec.score === 5) {
    const text = `满分的一天（${rec.date}）`
    if (!milestones.includes(text)) milestones.push(text)
  }

  // preferences：心愿偏好（从当天 wishes 快照聚合词频）
  const preferences = profile && profile.preferences ? JSON.parse(JSON.stringify(profile.preferences)) : { eat: {}, do: {} }
  for (const w of rec.wishes || []) {
    const type = w.type === 'do' ? 'do' : 'eat'
    preferences[type][w.text] = (preferences[type][w.text] || 0) + 1
  }

  const data = { moodTrend, kwBySegment, milestones, preferences, updatedAt: Date.now() }
  if (profile) {
    await db.collection('profiles').doc(profile._id).update({ data })
  } else {
    await db.collection('profiles').add({ data: { _openid: openid, ...data } })
  }
}

// ---------------- 读取 her 经期（M4 简化数据） ----------------
async function readMenstrual(herOpenid) {
  const m = (await db.collection('menstrual').where({ _openid: herOpenid }).get()).data[0]
  if (!m || !m.lastStart) return null
  const cyc = m.cycle || m.cycleLen || 28
  return { nextStart: addDays(m.lastStart, cyc) }
}

// ---------------- 记录的关系归属（P0 隐私隔离 · 2026-10-18） ----------------
// daily_records.coupleId 由 dailyRecord.save 在**创建时**写入，之后不可改写，
// 因此它可以作为「这条记录产生于哪一段关系」的证据。
// 返回记录所属关系 id（缺失 → null）。
function recCoupleIdOf(rec) {
  const cid = rec && rec.coupleId
  return typeof cid === 'string' && cid ? cid : null
}

// 用户当前生效关系（users.coupleId + couples(status=active)）
// 带成员校验：coupleId 指向一段与自己无关的关系时，不能当作有效的共享上下文。
async function currentCoupleIdOf(openid) {
  if (!openid) return null
  const me = (await db.collection('users').where({ _openid: openid }).get()).data[0]
  if (!me || !me.coupleId) return null
  const c = (await db.collection('couples').where({ coupleId: me.coupleId, status: 'active' }).get()).data[0]
  if (!c) return null
  if (c.herOpenid !== openid && c.himOpenid !== openid) return null
  return c.coupleId
}

// 这条记录的 partner 可见内容是否可以共享给「当前这段关系」
function isRecShareable(rec, ownerCoupleId) {
  const recCid = recCoupleIdOf(rec)
  return !!recCid && !!ownerCoupleId && recCid === ownerCoupleId
}

// ---------------- 批量读取（规模化：分页，防超时/超限） ----------------
const DAILY_BATCH = 100

async function fetchAllDailyRecords(date) {
  const out = []
  let offset = 0
  for (;;) {
    const r = (await db.collection('daily_records')
      .where({ date })
      .skip(offset)
      .limit(DAILY_BATCH)
      .get()).data
    out.push(...r)
    if (r.length < DAILY_BATCH) break
    offset += r.length
  }
  return out
}

// ---------------- 单条记录的小结生成（幂等 + 防并发 + 关系过滤） ----------------
// 幂等/防并发：不再「先查后写」（那有竞态窗口），而是把「尚未生成」作为写入条件
// 一次性落库 —— where({ herSummaryAt: null }).update() 返回 updated 数：
//   · updated === 1  → 本次抢到写入（首次生成）
//   · updated === 0  → 并发方/上次已生成 → 跳过（幂等，不再覆盖）
// 前端没有 aiSummary 调用，真实并发只有「Timer 触发一次」，因此「先检查」负责
// 省掉无谓的 AI 调用，「原子条件写入」负责兜底正确性（并发下也不会重复写/覆盖）。
// 失败语义：AI 失败走 fallback（A5 设计，不算失败）；只有数据库写入异常才抛错，
// 由外层记入 failed，绝不把「没写进去」报成成功。
// 返回 { wrote, aiFailed }：wrote=本次是否真的写入小结；aiFailed=本次 AI 调用失败次数。
async function generateDailySummary(rec, date) {
  const openid = rec._openid
  const profile = (await db.collection('profiles').where({ _openid: openid }).get()).data[0]
  const menstrual = await readMenstrual(openid)
  const reminder = periodReminder(menstrual && menstrual.nextStart, date)

  let wrote = false
  let aiFailed = 0

  // herSummary（本人私有，不受关系影响）
  if (!rec.herSummaryAt) {
    const herPayload = buildHerPayload(rec, profile, menstrual)
    let herText = null
    try {
      herText = await callAI([{ role: 'user', content: buildHerPrompt(herPayload) }])
    } catch (e) {
      aiFailed++
      console.error('[aiSummary] her AI fail', (e && (e.errMsg || e.message)) || String(e))
    }
    let herSummary = herText || herFallback(rec)
    if (reminder.her) herSummary = herSummary + '（' + reminder.her + '）'
    const upd = await db.collection('daily_records').where({
      _id: rec._id,
      herSummaryAt: null
    }).update({ data: { herSummary, herSummaryAt: Date.now(), updatedAt: Date.now() } })
    if ((upd && upd.stats && upd.stats.updated) === 1) wrote = true
  }

  // partnerSummary（给另一半看：仅当记录归属当前这段关系才生成）
  //
  // 关系归属（P0 隐私隔离）：partnerSummary 是**给另一半看**的文本，
  // 因此只允许为「属于记录方当前这段关系」的记录生成。
  //   · 换绑后，上一段关系期间的记录不再生成/更新伴侣小结（旧文本原样保留在库里，
  //     但 getPartnerView 也会按 coupleId 拒绝展示）
  //   · 未绑定 / coupleId 缺失（历史记录）→ 不生成：无法证明归属就不产生共享内容
  // 记录方自己的 herSummary 不受影响（那是本人私有内容）。
  const ownerCoupleId = await currentCoupleIdOf(openid)
  const shareable = isRecShareable(rec, ownerCoupleId)
  if (!rec.partnerSummaryAt && shareable) {
    const partnerPayload = buildPartnerPayload(rec, menstrual)
    let partnerText = null
    try {
      partnerText = await callAI([{ role: 'user', content: buildPartnerPrompt(partnerPayload) }])
    } catch (e) {
      aiFailed++
      console.error('[aiSummary] partner AI fail', (e && (e.errMsg || e.message)) || String(e))
    }
    let partnerSummary = partnerText || partnerFallback(partnerPayload)
    if (reminder.partner) partnerSummary = partnerSummary + '（' + reminder.partner + '）'
    const upd = await db.collection('daily_records').where({
      _id: rec._id,
      partnerSummaryAt: null
    }).update({ data: { partnerSummary, partnerSummaryAt: Date.now(), partnerSummaryCoupleId: ownerCoupleId, updatedAt: Date.now() } })
    if ((upd && upd.stats && upd.stats.updated) === 1) wrote = true
  }

  // 画像更新：独立于小结（小结幂等跳过时画像仍按当天记录更新）。
  // 注：updateProfile 的 moodTrend 聚合在「手动补算」重复触发同一记录时会重复 +1，
  // 这是已知遗留风险（Timer 每天仅触发一次，正常路径不受影响），本轮不扩 scope 修复。
  await updateProfile(openid, rec, profile)

  return { wrote, aiFailed }
}

// ---------------- main ----------------
exports.main = async (event = {}, context) => {
  const { OPENID } = cloud.getWXContext()

  // ---- daily：生成 herSummary + partnerSummary（幂等 + 防并发 + 关系过滤） ----
  // 入口识别（后台批量 vs 用户手动）：
  //   · event.Type === 'Timer' / TriggerName：微信定时器触发（config.json 每天 22:00），
  //     触发时**没有 OPENID**。反向校验：客户端也能伪造 { Type:'Timer' }，
  //     所以「有 OPENID」时一律拒绝，绝不让一个字段把鉴权绕过去（同 menstrual Y6）。
  //   · event.mode === 'cron' / event.action === 'cron'：后台批量入口（控制台/补算），
  //     同样要求无 OPENID。
  //   · event.action === 'daily'：用户手动触发，只处理**本人**当天记录，
  //     身份只来自 cloud.getWXContext().OPENID，不接受 event.openid（防伪造替他人生成）。
  const isTimer = event.Type === 'Timer' || !!event.TriggerName
  const isBatch = isTimer || event.mode === 'cron' || event.action === 'cron'
  if (event.action === 'daily' || isBatch) {
    // 批量入口：只允许无身份的调用（定时器/控制台），客户端伪造一律拒绝
    if (isBatch && OPENID) {
      return { ok: false, code: 'FORBIDDEN', msg: '仅定时触发器可执行' }
    }
    const date = event.date || fmt(new Date())
    if (!parseDate(date)) return { ok: false, code: 'BAD_ARGS', msg: '日期格式应为 YYYY-MM-DD' }

    let recs
    if (isBatch) {
      // 后台批量：当天全部记录，分页读取（规模化，防超时/超限）
      recs = await fetchAllDailyRecords(date)
    } else {
      // 用户手动触发：只处理本人当天记录
      if (!OPENID) return { ok: false, code: 'UNAUTHORIZED', msg: '未获取到用户身份' }
      const r = (await db.collection('daily_records').where({ _openid: OPENID, date }).get()).data[0]
      recs = r ? [r] : []
    }

    let count = 0
    let failed = 0
    let aiFailed = 0
    for (const rec of recs) {
      if (!rec || !rec._id) continue
      try {
        const r = await generateDailySummary(rec, date)
        if (r.wrote) count++
        aiFailed += r.aiFailed
      } catch (e) {
        // 单条失败不影响其他记录，但必须如实上报，绝不把「没写进去」报成成功
        console.error('[aiSummary] daily generate fail', rec._id, (e && (e.errCode || e.errMsg || e.message)) || String(e))
        failed++
      }
    }
    return { ok: true, count, failed, aiFailed }
  }

  // ---- weekly：周报双版本（幂等 coupleId+dateRange） ----
  if (event.action === 'weekly') {
    if (!OPENID) return { ok: false, msg: '未获取到用户身份' }
    const me = (await db.collection('users').where({ _openid: OPENID }).get()).data[0]
    if (!me || !me.coupleId) return { ok: false, msg: '尚未绑定情侣' }
    const couple = (await db.collection('couples').where({ coupleId: me.coupleId, status: 'active' }).get()).data[0]
    if (!couple || (couple.herOpenid !== OPENID && couple.himOpenid !== OPENID)) {
      return { ok: false, code: 'NOT_ACTIVE', msg: '情侣关系未生效' }
    }
    const herOpenid = couple.herOpenid

    const endDate = event.endDate || fmt(new Date())
    // 统计范围（本轮收窄，需在报告中说明）：
    //   周报只覆盖**当前这段关系**存续期间、且明确归属本关系的记录。
    //   ① 日期下界：couple.boundAt（本段关系激活时由服务端写入，客户端不可伪造）；
    //      该字段上线前建立的关系没有 boundAt → 不加日期下界。
    //   ② 关系等值：daily_records.coupleId === 当前 coupleId（硬条件，缺失即排除）。
    //   因此换绑后的新伴侣触发周报时，不会读到 A-B 期间的心愿/目标/小事。
    let startDate = event.startDate || addDays(endDate, -6)
    const boundAtMs = Number(couple.boundAt) || 0
    const boundAtDate = boundAtMs > 0 ? fmt(new Date(boundAtMs)) : null
    if (boundAtDate && startDate < boundAtDate) startDate = boundAtDate
    const dateRange = `${startDate}_${endDate}`

    // 幂等：已有周报 → 返回现有（不重调 AI）
    const existing = (await db.collection('weekly_reports').where({ coupleId: couple.coupleId, dateRange }).get()).data[0]
    if (existing) return { ok: true, idempotent: true, report: existing }

    // 窗口整体落在本段关系之前 → 没有任何可共享的数据（不查库）
    let recs = []
    if (!boundAtDate || endDate >= boundAtDate) {
      recs = (await db.collection('daily_records').where({
        _openid: herOpenid,
        coupleId: couple.coupleId,
        date: db.command.gte(startDate).and(db.command.lte(endDate))
      }).orderBy('date', 'asc').get()).data
      // 双保险：查询已按 coupleId 等值过滤，这里再按同一规则复核一次
      recs = recs.filter(r => recCoupleIdOf(r) === couple.coupleId)
    }

    const menstrual = await readMenstrual(herOpenid)
    const report = buildWeeklyReport(recs, menstrual)
    await db.collection('weekly_reports').add({
      data: {
        coupleId: couple.coupleId, dateRange,
        summary: report.herReport, partnerSummary: report.partnerReport,
        createdAt: Date.now(), updatedAt: Date.now()
      }
    })
    return { ok: true, report }
  }

  return { ok: false, code: 'BAD_ACTION', msg: '未知操作' }
}

// ---------------- A3 周报双版本 ----------------
function buildWeeklyReport(recs, menstrual) {
  const days = recs.length
  const goalsTotal = recs.reduce((a, r) => a + (r.goals || []).length, 0)
  const goalsDone = recs.reduce((a, r) => a + (r.goals || []).filter(g => g && g.done).length, 0)
  const todosTotal = recs.reduce((a, r) => a + (r.todos || []).length, 0)
  const todosDone = recs.reduce((a, r) => a + (r.todos || []).filter(t => t && t.done).length, 0)
  const wishes = Array.from(new Set(recs.reduce((a, r) => a.concat((r.wishes || []).map(w => w.text)), [])))
  const avgScore = recs.length ? (recs.reduce((a, r) => a + (typeof r.score === 'number' ? r.score : 0), 0) / recs.length).toFixed(1) : '—'
  const diaryDays = recs.filter(r => (r.segments && (r.segments.life || r.segments.work || r.segments.growth))).length

  // herReport：基于完整允许数据（不输出日记正文关键词）
  const herReport = `本周记录了 ${days} 天，共完成 ${goalsDone}/${goalsTotal} 个目标、${todosDone}/${todosTotal} 件小事，平均得分 ${avgScore}。${wishes.length ? '许过心愿：' + wishes.join('、') + '。' : ''}${nextHint(menstrual)}继续加油，我在。`

  // partnerReport：白名单（目标完成率/小事/心愿汇总/经期提醒）
  const rate = goalsTotal ? Math.round(goalsDone / goalsTotal * 100) : 0
  const partnerReport = `这周 TA 记录了 ${days} 天，目标完成率 ${rate}%，完成 ${todosDone} 件小事。${wishes.length ? '许过心愿：' + wishes.join('、') + '。' : ''}${nextHint(menstrual)}多陪陪 TA 吧。`

  return { herReport, partnerReport }
}
function nextHint(menstrual) {
  if (!menstrual || !menstrual.nextStart) return ''
  const n = menstrual.nextStart.split('-')
  return `预计下次经期 ${Number(n[1])}月${Number(n[2])}日左右。`
}

// ---------------- 导出（单测 + transport 注入） ----------------
module.exports.main = exports.main
module.exports.buildPartnerPayload = buildPartnerPayload
module.exports.buildHerPayload = buildHerPayload
module.exports.buildHerPrompt = buildHerPrompt
module.exports.buildPartnerPrompt = buildPartnerPrompt
module.exports.herFallback = herFallback
module.exports.partnerFallback = partnerFallback
module.exports.periodReminder = periodReminder
module.exports.buildWeeklyReport = buildWeeklyReport
module.exports.addDays = addDays
module.exports.daysBetween = daysBetween
module.exports.updateProfile = updateProfile
module.exports.__setTransport = (fn) => { _transport = fn }
