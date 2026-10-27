// ============================================================
// menstrual · 云函数（PRD v0.8 M4 — 简单经期记录 + 下次估算）
// action: 'get' 读取 / 'save' 写入（revision+requestId 契约）/ 'month' 日历标记
//         'subPeriod' 登记一次经期提醒订阅授权（一次性订阅）
//         'remindPrefs' 她设置「是否也提醒他」（默认关闭）
//         'remindTick' 定时扫描（仅无 OPENID 的定时触发器/控制台可执行）
// 范围：lastStart + cycle + periodLen（经期持续天数）→ nextStart 与经期区间。
// 已取消：排卵期/易孕期/安全期/三色区间/身体症状/经量（PRD v0.8 收缩）
// 安全：身份一律来自 cloud.getWXContext().OPENID；仅 her 可写
// 日期算法：全部来自 ./dates.js（唯一实现，提醒扫描复用同一套，见 remind.js）
// ============================================================
const cloud = require('wx-server-sdk')
const notify = require('./notify')
const remind = require('./remind')
const { pad, fmt, parseDate, addDays, todayStr } = require('./dates')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const SCHEMA_VERSION = 2
const CYCLE_MIN = 15
const CYCLE_MAX = 60
const CYCLE_DEFAULT = 28
const PERIOD_MIN = 1
const PERIOD_MAX = 10
const PERIOD_DEFAULT = 5 // 经期持续天数（M4 增量，用户可编辑，默认 5）


function validateCycle(cycle) {
  return typeof cycle === 'number' && Number.isInteger(cycle) && cycle >= CYCLE_MIN && cycle <= CYCLE_MAX
}

// 经期持续天数校验：整数 1~10（未传 → 默认 5，由调用方归一化）
function validatePeriodLen(periodLen) {
  return typeof periodLen === 'number' && Number.isInteger(periodLen) && periodLen >= PERIOD_MIN && periodLen <= PERIOD_MAX
}

// 读取归一化：旧记录无 periodLen → 默认 5（只读，不写库；下次保存时正式持久化）
function readPeriodLen(m) {
  return m && m.periodLen ? m.periodLen : PERIOD_DEFAULT
}

// 定位 her 的 openid（him 视角读取 her 经期；仅 her 可写）
// P5 安全（M5）：必须 status==='active' 才允许 partner 读取；superseded/expired → 返回 null
// requireShare=true：him 读取还要求 her 已开启「经期共享」授权（sharePeriod，默认关）。
//   经期是敏感个人信息，不能仅因为绑定成功就默认无限制读取（Task B5）。
async function findHerOpenid(openid, requireShare = false) {
  const me = (await db.collection('users').where({ _openid: openid }).get()).data[0]
  if (!me || !me.coupleId) return openid
  const c = (await db.collection('couples').where({ coupleId: me.coupleId }).get()).data[0]
  if (!c || c.status !== 'active') return null // 非 active：不授予 partner 读取
  if (openid === c.herOpenid) return openid
  if (openid === c.himOpenid) {
    if (requireShare) {
      const m = (await db.collection('menstrual').where({ _openid: c.herOpenid }).get()).data[0]
      if (!m || m.sharePeriod !== true) return null // 未授权共享 → 不授予读取
    }
    return c.herOpenid
  }
  return null
}

// 经期提醒的订阅状态（配额只是服务端记账，真实额度以微信为准）
async function buildRemindInfo(openid, m) {
  const templates = notify.readTemplates(process.env)
  const u = (await db.collection('users').where({ _openid: openid }).get()).data[0]
  const q = notify.scopedQuota((u && u.subQuota) || {}, templates)
  return {
    quota: q.period,
    leadDays: remind.REMIND_LEAD_DAYS,
    partnerRemind: !!(m && m.remindPartner === true),
    sharePeriod: !!(m && m.sharePeriod === true),
    sentFor: (m && m.remindSentFor) || '',
    partnerSentFor: (m && m.remindPartnerSentFor) || ''
  }
}

exports.main = async (event = {}) => {
  const ctx = cloud.getWXContext() || {}
  const OPENID = ctx.OPENID
  const action = event.action || 'month' // 兼容 V1 默认 month

  // ---- 定时触发器（event.Type === 'Timer'）：扫描经期提醒 ----
  // 定时调用没有 OPENID，绝不能落到下面的用户分支。
  // 反向校验同样重要：客户端也可以伪造 { Type:'Timer' } 传上来，
  // 所以这里必须要求「确实没有 OPENID」，否则鉴权就被一个字段绕过去了。
  if (event.Type === 'Timer' || event.TriggerName) {
    if (OPENID) return { ok: false, code: 'FORBIDDEN', msg: '仅定时触发器可执行' }
    return remind.runRemindTick({ db, cloud, env: process.env, dryRun: false })
  }

  // ---- 控制台/云函数测试手动扫描：只允许「无身份」的调用，客户端一律拒绝 ----
  // 手动执行**默认只读演练**（dryRun=true）：控制台就是生产环境，
  // 一次手滑就会给真实用户推送、扣掉真实订阅额度、写真实数据。
  // 想真正发一次必须显式传 dryRun:false —— 默认值必须是「什么都不做」。
  if (action === 'remindTick') {
    if (OPENID) return { ok: false, code: 'FORBIDDEN', msg: '仅定时触发器可执行' }
    const dryRun = !(event.dryRun === false || event.dryRun === 'false')
    return remind.runRemindTick({
      db, cloud, env: process.env, today: event.today, leadDays: event.leadDays, dryRun
    })
  }

  if (!OPENID) return { ok: false, msg: '未获取到用户身份' }

  // ---- subPeriod：登记一次「经期提醒」订阅授权（一次性订阅，一次同意 = 一条消息） ----
  // 只能给自己登记（身份来自 WXContext，前端传不了别人的 openid）。
  if (action === 'subPeriod') {
    const r = await notify.grantQuota(db, OPENID, ['period'], notify.readTemplates(process.env))
    if (!r.ok) return { ok: false, code: 'BAD_ARGS', msg: '未收到有效的订阅结果' }
    return { ok: true, quota: r.quota }
  }

  // ---- remindPrefs：她决定「是否也提醒他」（默认关闭，只能她本人改） ----
  if (action === 'remindPrefs') {
    const herOpenid = await findHerOpenid(OPENID)
    if (herOpenid === null) {
      return { ok: false, code: 'NOT_ACTIVE', msg: '当前情侣关系未生效，请重新绑定后再设置' }
    }
    if (herOpenid !== OPENID) {
      return { ok: false, code: 'FORBIDDEN', msg: '仅她可设置经期提醒' }
    }
    const on = event.partner === true
    const m = (await db.collection('menstrual').where({ _openid: herOpenid }).get()).data[0]
    if (!m || !m.lastStart) {
      return { ok: false, code: 'NOT_CONFIGURED', msg: '先记录一次经期，再开启提醒' }
    }
    await db.collection('menstrual').doc(m._id).update({
      data: { remindPartner: on, remindPrefsAt: Date.now() }
    })
    return { ok: true, partnerRemind: on }
  }

  // ---- sharePeriod：她决定「是否允许 TA 查看经期数据」（默认关，只能她本人改）----
  // 经期是敏感个人信息，不能仅因绑定成功就默认允许无限制读取（Task B5）。
  if (action === 'sharePeriod') {
    const herOpenid = await findHerOpenid(OPENID)
    if (herOpenid === null) {
      return { ok: false, code: 'NOT_ACTIVE', msg: '当前情侣关系未生效，请重新绑定后再设置' }
    }
    if (herOpenid !== OPENID) {
      return { ok: false, code: 'FORBIDDEN', msg: '仅她可设置经期共享' }
    }
    const on = event.share === true
    const m = (await db.collection('menstrual').where({ _openid: herOpenid }).get()).data[0]
    if (!m || !m.lastStart) {
      return { ok: false, code: 'NOT_CONFIGURED', msg: '先记录一次经期，再开启共享' }
    }
    await db.collection('menstrual').doc(m._id).update({
      data: { sharePeriod: on, sharePrefsAt: Date.now() }
    })
    return { ok: true, sharePeriod: on }
  }

  // ---- get ----
  if (action === 'get') {
    const herOpenid = await findHerOpenid(OPENID, true)
    // him 读取但 her 未授权共享 / 关系失效 → 一律按「看不到」处理，不查库
    if (herOpenid === null) {
      const emptyRemind = await buildRemindInfo(OPENID, null)
      return { ok: true, configured: false, record: null, shareDenied: true, remind: emptyRemind }
    }
    const m = (await db.collection('menstrual').where({ _openid: herOpenid }).get()).data[0]
    // 提醒状态与「有没有记录过经期」无关：没记录的人也要能看到自己还剩几次授权
    const remindInfo = await buildRemindInfo(OPENID, m)
    if (!m || !m.lastStart) return { ok: true, configured: false, record: null, remind: remindInfo }
    const cycle = m.cycle || m.cycleLen || CYCLE_DEFAULT
    const periodLen = readPeriodLen(m) // 旧记录无 periodLen → 5（只读默认，不写库）
    const nextStart = addDays(m.lastStart, cycle)
    return {
      ok: true,
      configured: true,
      remind: remindInfo,
      record: {
        lastStart: m.lastStart,
        cycle,
        periodLen,
        nextStart,
        nextPeriodStart: nextStart,                 // 下次预计经期起始
        nextPeriodEnd: addDays(nextStart, periodLen - 1), // 下次预计经期结束
        periodEnd: addDays(m.lastStart, periodLen - 1),   // 当前经期结束
        revision: m.revision || 1
      }
    }
  }

  // ---- save（revision + requestId 契约） ----
  if (action === 'save') {
    const herOpenid = await findHerOpenid(OPENID)
    // herOpenid === null：当前用户所在的 couple 不是 active（或关系缺失）→ 读写都不授权，
    // 与「已绑定但角色是 him」区分开，避免把权限问题误报成角色问题。
    if (herOpenid === null) {
      return { ok: false, code: 'NOT_ACTIVE', msg: '当前情侣关系未生效，请重新绑定后再设置' }
    }
    if (herOpenid !== OPENID) {
      return { ok: false, code: 'FORBIDDEN', msg: '仅她可设置经期信息' }
    }
    const { lastStart, cycle, requestId, revision } = event
    if (!lastStart || !parseDate(lastStart)) {
      return { ok: false, code: 'BAD_ARGS', msg: '开始日期格式应为 YYYY-MM-DD' }
    }
    if (lastStart > todayStr()) {
      return { ok: false, code: 'BAD_ARGS', msg: '开始日期不能晚于今天' }
    }
    if (!validateCycle(cycle)) {
      return { ok: false, code: 'BAD_ARGS', msg: `周期需为 ${CYCLE_MIN}~${CYCLE_MAX} 的整数天` }
    }
    // periodLen：未传 → 默认 5（旧前端兼容）；传入 → 必须整数 1~10
    const periodLen = event.periodLen === undefined ? PERIOD_DEFAULT : event.periodLen
    if (!validatePeriodLen(periodLen)) {
      return { ok: false, code: 'BAD_ARGS', msg: `经期持续天数需为 ${PERIOD_MIN}~${PERIOD_MAX} 的整数天` }
    }
    if (!requestId) {
      return { ok: false, code: 'BAD_ARGS', msg: '缺少 requestId' }
    }
    const clientRevision = typeof revision === 'number' ? revision : 0
    const nextStart = addDays(lastStart, cycle)

    const existing = (await db.collection('menstrual').where({ _openid: herOpenid }).get()).data[0]

    // 幂等：同 requestId 已处理 → 直接返回当前状态（不重复写、revision 不 +1）
    if (existing && existing.lastRequestId === requestId) {
      const curCycle = existing.cycle || existing.cycleLen || CYCLE_DEFAULT
      const curPeriod = readPeriodLen(existing)
      const curNext = addDays(existing.lastStart, curCycle)
      return {
        ok: true, revision: existing.revision || 1, idempotent: true,
        nextStart: curNext,
        nextPeriodEnd: addDays(curNext, curPeriod - 1),
        periodLen: curPeriod
      }
    }

    // V1 兼容：旧记录无 revision → 补 0（使乐观锁可匹配）
    if (existing && existing.revision === undefined) {
      await db.collection('menstrual').doc(existing._id).update({ data: { revision: 0 } })
      existing.revision = 0
    }

    if (!existing) {
      if (clientRevision !== 0) {
        return { ok: false, code: 'REV_CONFLICT', msg: '内容已被更新，请刷新' }
      }
      await db.collection('menstrual').add({
        data: {
          _openid: herOpenid, lastStart, cycle, periodLen, nextStart,
          revision: 1, lastRequestId: requestId, schemaVersion: SCHEMA_VERSION,
          createdAt: Date.now(), updatedAt: Date.now()
        }
      })
      return { ok: true, revision: 1, nextStart, periodLen, nextPeriodEnd: addDays(nextStart, periodLen - 1) }
    }

    // 乐观锁更新：仅云端 revision === 客户端 revision 才允许覆盖
    const upd = await db.collection('menstrual').where({ _openid: herOpenid, revision: clientRevision }).update({
      data: {
        lastStart, cycle, periodLen, nextStart,
        revision: existing.revision + 1, lastRequestId: requestId,
        schemaVersion: SCHEMA_VERSION, updatedAt: Date.now()
      }
    })
    if (!upd.stats || upd.stats.updated === 0) {
      return { ok: false, code: 'REV_CONFLICT', msg: '内容已被更新，请刷新', revision: existing.revision }
    }
    return { ok: true, revision: existing.revision + 1, nextStart, periodLen, nextPeriodEnd: addDays(nextStart, periodLen - 1) }
  }

  // ---- month：日历标记（仅经期日 + 阅读；无排卵/易孕/安全期） ----
  if (action === 'month') {
    const year = event.year, month = event.month
    // 定位 her 是谁（不要求 share：用于知道从谁的 daily_records 取阅读标记）
    const herOpenid = await findHerOpenid(OPENID)
    if (herOpenid === null) {
      // 关系失效 → 不查库（where _openid:null 会匹配字段缺失文档）
      return { ok: true, configured: false, shareDenied: true, days: [] }
    }
    if (!year || !month) return { ok: true, configured: false, days: [] }
    const m = (await db.collection('menstrual').where({ _openid: herOpenid }).get()).data[0]
    // 经期是否可见：her 自己，或 him 且 her 已授权 sharePeriod（Task B5）
    const canSeePeriod = OPENID === herOpenid || (m && m.sharePeriod === true)
    const daysInMonth = new Date(year, month, 0).getDate()
    const monthEnd = `${year}-${pad(month)}-${pad(daysInMonth)}`
    const out = []
    for (let d = 1; d <= daysInMonth; d++) {
      out.push({ date: `${year}-${pad(month)}-${pad(d)}`, type: '' })
    }
    // 经期区间：从 lastStart 起每 cycle 天一个区间，各标记连续 periodLen 天
    // 当前经期区间 = [lastStart, lastStart + periodLen - 1]
    // 下次预计经期区间 = [nextStart, nextStart + periodLen - 1]（以此类推）
    // 仅 canSeePeriod 且已配置才画经期标记。
    let lastStart = null
    let cycle = CYCLE_DEFAULT
    let periodLen = PERIOD_DEFAULT
    if (canSeePeriod && m && m.lastStart) {
      cycle = m.cycle || m.cycleLen || CYCLE_DEFAULT
      periodLen = readPeriodLen(m)
      lastStart = m.lastStart
      let cursor = m.lastStart
      for (let i = 0; i < 36 && cursor; i++) {
        if (cursor > monthEnd) break
        const startIdx = out.findIndex(x => x.date === cursor)
        if (startIdx >= 0) {
          for (let k = 0; k < periodLen && startIdx + k < out.length; k++) {
            if (!out[startIdx + k].type) out[startIdx + k].type = 'period'
          }
        }
        cursor = addDays(cursor, cycle)
      }
    }
    // 阅读标记（阅读进度 > 0 的日子）
    //
    // 关系归属（P0 隐私隔离 · 2026-10-18）：阅读标记是从 daily_records 派生的
    // 「她哪天读过书」这类活动信息。旧实现只按 _openid 取数，于是换绑之后
    // 新伴侣能在日历上看到她在**上一段关系期间**的阅读痕迹。
    // 现在：只要当前处于生效关系，就只统计归属这段关系的记录
    // （daily_records.coupleId 等值）；历史记录无法证明归属 → 不画标记。
    // 阅读标记不随经期授权开关走（它不是经期数据，只按关系隔离）。
    const startStr = `${year}-${pad(month)}-01`
    const me = (await db.collection('users').where({ _openid: OPENID }).get()).data[0]
    const activeCouple = me && me.coupleId
      ? (await db.collection('couples').where({ coupleId: me.coupleId, status: 'active' }).get()).data[0]
      : null
    let recs = []
    if (activeCouple && activeCouple.coupleId) {
      recs = (await db.collection('daily_records')
        .where({ _openid: herOpenid, coupleId: activeCouple.coupleId, date: _.gte(startStr).and(_.lte(monthEnd)) })
        .get()).data
    } else if (!me || !me.coupleId) {
      // 未绑定：只有本人能走到这里（herOpenid 就是自己），沿用原行为
      recs = (await db.collection('daily_records')
        .where({ _openid: herOpenid, date: _.gte(startStr).and(_.lte(monthEnd)) })
        .get()).data
    }
    const readSet = new Set()
    recs.forEach(r => { if (r.readProgress > 0) readSet.add(r.date) })
    out.forEach(x => { if (readSet.has(x.date)) x.read = true })
    return {
      ok: true,
      configured: !!lastStart,
      shareDenied: OPENID !== herOpenid && !canSeePeriod,
      days: out,
      lastStart,
      cycle,
      periodLen,
      nextStart: lastStart ? addDays(lastStart, cycle) : null,
      nextPeriodEnd: lastStart ? addDays(addDays(lastStart, cycle), periodLen - 1) : null
    }
  }

  return { ok: false, code: 'BAD_ACTION', msg: '未知操作: ' + action }
}

// 供单测导出（云函数入口仍是 main，额外导出不参与部署行为）
module.exports.main = exports.main
module.exports.addDays = addDays
module.exports.parseDate = parseDate
module.exports.validateCycle = validateCycle
module.exports.validatePeriodLen = validatePeriodLen
module.exports.todayStr = todayStr
