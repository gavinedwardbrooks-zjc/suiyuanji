// ============================================================
// remind.js · 经期提醒扫描（一次性订阅，服务端定时触发）
//
// 触发方式（二选一，都在云端）：
//   · 定时触发器：cloudfunctions/menstrual/config.json（每天 09:00）
//   · 控制台/云函数测试手动执行 { action: 'remindTick', dryRun: true }
//     —— 手动执行**默认就是只读演练**（见 index.js），必须显式 dryRun:false 才会真发。
//
// 一次扫描做四件事：
//   1. 逐条读 menstrual（分页，不假设数据量）→ 复用 dates.js 的预测算法；
//   2. 判断是否进入提醒窗口（预计日期前 leadDays 天内，默认 2 天）；
//   3. 依「她本人 / 他（需她明确同意）」分别发送，接收者必须各自有有效订阅额度；
//   4. 用「已提醒的预计日期」做幂等：同一预计日期只发一次，预计日期一变就重新算。
//
// ── 为什么会话式「先查 → 再发 → 后写标记」不安全 ──────────────
// 定时触发器不是「严格单飞」：定时任务重叠、控制台手动执行、函数超时后重试，
// 都可能让同一份数据被两个实例同时处理。两个实例都先读到 remindSentFor 是旧值，
// 然后各自发一条 —— 用户收到两条，一次性订阅也被扣两次额度。
//
// 因此把顺序改成：**先原子领取（claim）→ 发送 → 成功才落标记 → 失败释放**：
//   · 领取是单文档条件更新（where 同时要求 sentFor 与 claimFor 都不等于本次日期），
//     云数据库单文档更新是原子的，两个实例只可能有一个拿到 claim（stats.updated === 1）；
//   · 拿不到 claim 的实例直接跳过，不发送；
//   · 发送失败 → 释放 claim，下一轮仍可重试（不丢提醒）；
//   · 实例崩溃导致 claim 悬挂 → CLAIM_TTL_MS 之后可被安全接管（不会永久锁死）。
// 已知残余：发送成功但「落标记」写入失败时，TTL 过后可能补发一条重复消息；
// 这是「宁可重复一次，也不丢提醒」的取舍，并会留 [period-remind-finalize-fail] 日志。
//
// 安全与隐私：
//   · 只发给她本人；发给他必须同时满足 m.remindPartner === true（她显式开启）、
//     有效 active 情侣绑定、他本人有 period 订阅额度。默认不共享。
//   · 失败永不抛错：一条失败不影响其他用户，也不影响经期记录本身。
//   · 日志只记统计与原因码，不记 openid、不记预计日期/上次日期。
// ============================================================
const { addDays, daysBetween, fmt } = require('./dates')
const notify = require('./notify')

// 预计经期前多少天提醒。产品默认 2 天；调用方可传入覆盖（便于测试与将来做偏好设置）。
const REMIND_LEAD_DAYS = 2

const SCAN_PAGE = 100
const SCAN_MAX_PAGES = 50

// 领取（claim）悬挂的自愈窗口。必须远大于一次发送耗时（秒级），
// 又远小于提醒窗口（2 天），这样崩溃后下一轮能接管，而正常发送绝不会被抢。
const CLAIM_TTL_MS = 6 * 60 * 60 * 1000

// claim 用的三个字段：谁领了、领的是哪个预计日期、什么时候领的
const CLAIM_FOR = 'remindClaimFor'
const CLAIM_AT = 'remindClaimAt'
const CLAIM_ID = 'remindClaimId'

function bump(bucket, key) {
  const k = key || 'unknown'
  bucket[k] = (bucket[k] || 0) + 1
}

function newClaimId(at) {
  return 'rc_' + at.toString(36) + '_' + Math.random().toString(36).slice(2, 10)
}

// 分页读全部 menstrual 记录。云开发单次 get 有上限（服务端默认 100），
// 所以必须分页；用 orderBy('_id') 保证多次读取的顺序稳定，不会漏读/重复读。
// where({}) 是「全部记录」的标准写法（也兼容测试里的数据库替身）。
async function scanAll(db) {
  const out = []
  for (let page = 0; page < SCAN_MAX_PAGES; page++) {
    const batch = (await db.collection('menstrual')
      .where({})
      .orderBy('_id', 'asc')
      .skip(page * SCAN_PAGE)
      .limit(SCAN_PAGE)
      .get()).data || []
    for (const d of batch) out.push(d)
    if (batch.length < SCAN_PAGE) break
  }
  return out
}

// 从「她」推导「他」。任何一步不成立都不发：解绑、关系非 active、绑定关系里的 her 不是她本人。
async function resolvePartnerOfHer(db, herOpenid) {
  if (!herOpenid) return { ok: false, reason: 'no_receiver' }
  const me = (await db.collection('users').where({ _openid: herOpenid }).get()).data[0]
  if (!me || !me.coupleId) return { ok: false, reason: 'not_bound' }
  const c = (await db.collection('couples').where({ coupleId: me.coupleId, status: 'active' }).get()).data[0]
  if (!c) return { ok: false, reason: 'not_active' }
  if (c.herOpenid && c.herOpenid !== herOpenid) return { ok: false, reason: 'owner_mismatch' }
  const himOpenid = c.himOpenid
  if (!himOpenid) return { ok: false, reason: 'no_partner' }
  if (himOpenid === herOpenid) return { ok: false, reason: 'self_target' }
  return { ok: true, himOpenid }
}

// 原子领取：只有「这个预计日期既没发过、也没被别人领走」时才拿得到。
// 单文档条件更新是原子的 —— 两个实例同时来，只有一个能 updated === 1。
async function tryClaim({ db, _, docId, sentField, nextStart, at }) {
  const claimId = newClaimId(at)
  const res = await db.collection('menstrual')
    .where({ _id: docId, [sentField]: _.neq(nextStart), [CLAIM_FOR]: _.neq(nextStart) })
    .update({ data: { [CLAIM_FOR]: nextStart, [CLAIM_AT]: at, [CLAIM_ID]: claimId } })
  const ok = !!(res && res.stats && res.stats.updated === 1)
  return ok ? claimId : ''
}

// 悬挂 claim 的接管：只有「确实过期」且「还是同一份 claim」时才清。
// CAS 条件带上 remindClaimAt，避免误清别人刚拿到的新 claim。
async function releaseStaleClaim({ db, _, doc, nextStart, at }) {
  if (doc[CLAIM_FOR] !== nextStart) return
  const claimedAt = Number(doc[CLAIM_AT]) || 0
  if (!claimedAt || at - claimedAt < CLAIM_TTL_MS) return
  try {
    await db.collection('menstrual')
      .where({ _id: doc._id, [CLAIM_FOR]: nextStart, [CLAIM_AT]: claimedAt })
      .update({ data: { [CLAIM_FOR]: null, [CLAIM_AT]: null, [CLAIM_ID]: null } })
    doc[CLAIM_FOR] = null
    doc[CLAIM_AT] = null
    doc[CLAIM_ID] = null
  } catch (e) {
    // 接管失败不致命：这一轮跳过，下一轮再试
    console.warn('[period-remind-steal-fail]', JSON.stringify({ reason: (e && (e.errMsg || e.message)) || '' }))
  }
}

// 落标记 + 释放 claim（必须带上 claimId，只释放自己的）
async function finalizeClaim({ db, _, docId, claimId, patch }) {
  const res = await db.collection('menstrual')
    .where({ _id: docId, [CLAIM_ID]: claimId })
    .update({ data: Object.assign({}, patch, { [CLAIM_FOR]: null, [CLAIM_AT]: null, [CLAIM_ID]: null }) })
  return !!(res && res.stats && res.stats.updated === 1)
}

async function releaseClaim({ db, _, docId, claimId }) {
  try {
    await db.collection('menstrual')
      .where({ _id: docId, [CLAIM_ID]: claimId })
      .update({ data: { [CLAIM_FOR]: null, [CLAIM_AT]: null, [CLAIM_ID]: null } })
  } catch (e) {
    console.warn('[period-remind-release-fail]', JSON.stringify({ reason: (e && (e.errMsg || e.message)) || '' }))
  }
}

// 给一个接收者投递一条提醒（领取 → 发送 → 落标记 / 释放）。
// dryRun 时走纯只读分支：不领取、不发送、不扣额度、不写任何字段。
async function deliverOne(o) {
  const { db, _, cloud, env, dryRun, doc, sentField, target, nextStart, countdown, lastStart, at, stats, prefix } = o
  if (!target) { bump(stats.skipped, prefix + 'no_receiver'); return }

  if (dryRun) {
    let left = 0
    try {
      const u = (await db.collection('users').where({ _openid: target }).get()).data[0]
      left = notify.scopedQuota(u && u.subQuota, notify.readTemplates(env)).period
    } catch (e) {
      bump(stats.skipped, prefix + 'read_failed')
      return
    }
    if (left <= 0) { bump(stats.skipped, prefix + 'no_quota'); return }
    stats.wouldSend++
    return
  }

  let claimId = ''
  try {
    claimId = await tryClaim({ db, _, docId: doc._id, sentField, nextStart, at })
  } catch (e) {
    console.warn('[period-remind-claim-fail]', JSON.stringify({ reason: (e && (e.errMsg || e.message)) || '' }))
    bump(stats.skipped, prefix + 'claim_failed')
    return
  }
  // 拿不到 claim：要么别的实例已经发过，要么正在发 —— 一律不发，避免重复
  if (!claimId) { bump(stats.skipped, 'concurrent'); return }

  const r = await notify.sendPeriodReminder({
    db, cloud, env, openid: target, nextStart, countdown, lastStart, at
  })

  if (!r.sent) {
    // 发送失败 → 立刻释放，下一轮仍可重试（不把「失败」记成「已提醒」）
    await releaseClaim({ db, _, docId: doc._id, claimId })
    bump(stats.skipped, prefix + r.reason)
    return
  }

  // 发送成功 → 落幂等标记（同时释放 claim）。写失败只留痕，不回滚已发出的消息。
  const ok = await finalizeClaim({
    db, _, docId: doc._id, claimId, patch: { [sentField]: nextStart, remindUpdatedAt: at }
  })
  if (!ok) {
    console.warn('[period-remind-finalize-fail]', JSON.stringify({ reason: 'flag_not_written' }))
  }
  stats.sent++
}

// 主扫描。返回统计（不含任何 openid / 日期）。
// dryRun=true：只读演练 —— 零发送、零额度扣减、零数据库写入。
async function runRemindTick({ db, cloud, env, today, leadDays, now, dryRun } = {}) {
  const _ = db.command
  const lead = Number.isInteger(leadDays) ? leadDays : REMIND_LEAD_DAYS
  const day = today || fmt(new Date())
  const at = now || Date.now()
  const isDry = dryRun === true
  const stats = { scanned: 0, due: 0, sent: 0, wouldSend: 0, skipped: {} }

  let docs = []
  try {
    docs = await scanAll(db)
  } catch (e) {
    console.warn('[period-remind-scan-fail]', JSON.stringify({ reason: (e && (e.errMsg || e.message)) || '' }))
    return { ok: false, code: 'SCAN_FAILED', scanned: 0, due: 0, sent: 0, wouldSend: 0, skipped: {} }
  }
  stats.scanned = docs.length

  for (const m of docs) {
    // 未设置经期 / 无属主 → 安全降级，不发
    if (!m || !m._openid) { bump(stats.skipped, 'no_owner'); continue }
    if (!m.lastStart) { bump(stats.skipped, 'not_configured'); continue }

    const cycle = m.cycle || m.cycleLen || 28
    const nextStart = addDays(m.lastStart, cycle)
    if (!nextStart) { bump(stats.skipped, 'bad_last_start'); continue }

    const countdown = daysBetween(day, nextStart)
    if (countdown === null) { bump(stats.skipped, 'bad_date'); continue }
    // 预计日期已经过去：说明她很久没更新记录，此时再提醒只会是过期消息
    if (countdown < 0) { bump(stats.skipped, 'prediction_passed'); continue }
    if (countdown > lead) { bump(stats.skipped, 'not_due'); continue }

    stats.due++

    // ---- 接收者 A：她本人 ----
    if (m.remindSentFor !== nextStart) {
      if (!isDry) await releaseStaleClaim({ db, _, doc: m, nextStart, at })
      await deliverOne({
        db, _, cloud, env, dryRun: isDry, doc: m, sentField: 'remindSentFor',
        target: m._openid, nextStart, countdown, lastStart: m.lastStart, at, stats, prefix: ''
      })
    }

    // ---- 接收者 B：他（默认关闭，必须她显式开启共享）----
    if (m.remindPartner === true) {
      const p = await resolvePartnerOfHer(db, m._openid)
      if (!p.ok) {
        bump(stats.skipped, 'partner_' + p.reason)
      } else if (m.remindPartnerSentFor !== nextStart) {
        if (!isDry) await releaseStaleClaim({ db, _, doc: m, nextStart, at })
        await deliverOne({
          db, _, cloud, env, dryRun: isDry, doc: m, sentField: 'remindPartnerSentFor',
          target: p.himOpenid, nextStart, countdown, lastStart: m.lastStart, at, stats, prefix: 'partner_'
        })
      }
    }
  }

  return {
    ok: true, day, leadDays: lead, dryRun: isDry,
    scanned: stats.scanned, due: stats.due, sent: stats.sent,
    wouldSend: stats.wouldSend, skipped: stats.skipped
  }
}

module.exports = {
  REMIND_LEAD_DAYS,
  CLAIM_TTL_MS,
  runRemindTick,
  scanAll,
  resolvePartnerOfHer
}
