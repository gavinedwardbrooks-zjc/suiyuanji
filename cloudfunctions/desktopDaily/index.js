// ============================================================
// desktopDaily · Desktop 业务云函数（HTTP 触发）
// action: 'get' | 'save'
// authority：仅 Bearer desktopToken → 服务端 validate → user_uid
//           → users.user_uid 反查 _openid → daily_records（与小程序同一份数据）
// 禁止信任客户端提交的 openid / _openid / user_uid / coupleId / role。
// save 语义（与小程序 dailyRecord 对齐的最小子集）：
//   - 只写 goals / todos 两个字段（字段级合并，不覆盖 segments/mood/wishes/score/readProgress）
//   - requestId 幂等：同 date 同 requestId 不重复写
//   - revision 乐观锁：不匹配 → REV_CONFLICT，拒绝覆盖
// ============================================================
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const desktopCore = require('./desktopSessionCore')
const { CloudDesktopSessionRepository } = require('./cloudDesktopSessionRepository')

const repo = new CloudDesktopSessionRepository(db)
const SCHEMA_VERSION = 2
const MAX_BODY = 8192

function response(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

const ALLOWED_CODES = [
  'INVALID_DESKTOP_SESSION', 'BAD_ARGS', 'REV_CONFLICT', 'USER_NOT_FOUND', 'INVALID_ACTION',
  'METHOD_NOT_POST', 'BODY_TOO_LARGE', 'INVALID_JSON', 'DATE_INVALID'
]
function safeError(error) {
  return ALLOWED_CODES.includes(error && error.message) ? error.message : 'INTERNAL_ERROR'
}

function parse(event) {
  if (!event || event.httpMethod !== 'POST') throw new Error('METHOD_NOT_POST')
  const type = String((event.headers && (event.headers['content-type'] || event.headers['Content-Type'])) || '').toLowerCase()
  if (!type.startsWith('application/json')) throw new Error('INVALID_JSON')
  if (typeof event.body !== 'string' || Buffer.byteLength(event.body, 'utf8') > MAX_BODY) throw new Error('BODY_TOO_LARGE')
  try { return JSON.parse(event.body) } catch (e) { throw new Error('INVALID_JSON') }
}

function assertDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('DATE_INVALID')
  const [y, m, d] = date.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) throw new Error('DATE_INVALID')
  const check = new Date(Date.UTC(y, m - 1, d))
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) throw new Error('DATE_INVALID')
}

// goals：白名单 { text<=100, done, reminderOn, reminderTime<=8 }，最多 10 项
// reminded 是 **服务端状态**，由 reminderCheck 在「已发送提醒后」写入（{...g, reminded:true}），
// 桌面客户端**不可写**：一旦接受客户端值，就等于允许伪造（抑制自己的提醒）
// 或重置（reminderCheck 会重复推送，消耗用户一次性订阅消息额度）。
// ⇒ 客户端传什么这里都归一化为 false，再用 inheritReminded() 从旧记录继承。
function sanitizeGoals(goals) {
  if (!Array.isArray(goals)) throw new Error('BAD_ARGS')
  if (goals.length > 10) throw new Error('BAD_ARGS')
  return goals.map(g => {
    if (!g || typeof g !== 'object') throw new Error('BAD_ARGS')
    return {
      text: typeof g.text === 'string' ? g.text.slice(0, 100) : '',
      done: g.done === true,
      reminderOn: g.reminderOn === true,
      reminderTime: typeof g.reminderTime === 'string' ? g.reminderTime.slice(0, 8) : '21:00',
      reminded: false
    }
  })
}

// 目标的「同一性」：内容 + 提醒时刻。文本或提醒时刻一变，就是另一条目标，
// 理应重新提醒一次；只有完全相同的目标才继承「今天已经提醒过」。
function goalKey(g) { return String(g && g.text || '') + '\u0000' + String(g && g.reminderTime || '') }

// 把服务端旧记录里 reminded:true 的目标「按多重集」搬回新数组：
// 同文本同提醒时刻出现 N 次就最多继承 N 次，不会因为数组重排 / 增删而串到别的目标上。
function inheritReminded(next, previous) {
  const pool = new Map()
  for (const g of (Array.isArray(previous) ? previous : [])) {
    if (!g || g.reminded !== true) continue
    const k = goalKey(g)
    pool.set(k, (pool.get(k) || 0) + 1)
  }
  if (pool.size === 0) return next
  return next.map(g => {
    const k = goalKey(g)
    const left = pool.get(k) || 0
    if (left <= 0) return g
    pool.set(k, left - 1)
    return { ...g, reminded: true }
  })
}

// todos：白名单 { text<=200, done }，最多 200 项
function sanitizeTodos(todos) {
  if (!Array.isArray(todos)) throw new Error('BAD_ARGS')
  if (todos.length > 200) throw new Error('BAD_ARGS')
  return todos.map(t => {
    if (!t || typeof t !== 'object') throw new Error('BAD_ARGS')
    return { text: typeof t.text === 'string' ? t.text.slice(0, 200) : '', done: t.done === true }
  })
}

function migrate(doc) {
  if (!doc) return doc
  if (doc.schemaVersion >= SCHEMA_VERSION) return doc
  return { ...doc, schemaVersion: SCHEMA_VERSION }
}

exports.main = async (event = {}) => {
  try {
    const body = parse(event)
    const auth = String((event.headers && (event.headers.authorization || event.headers.Authorization)) || '')
    if (!/^Bearer [^\s]+$/.test(auth) || auth.length > 700) throw new Error('INVALID_DESKTOP_SESSION')

    const now = Date.now()
    const { user_uid } = await desktopCore.validateDesktopSession({ repo, token: auth.slice(7), now })
    if (!user_uid) throw new Error('INVALID_DESKTOP_SESSION')

    // 服务端反查 users → _openid（daily_records 的主键与小程序一致）
    const user = (await db.collection('users').where({ user_uid }).limit(1).get()).data[0]
    if (!user || !user._openid) throw new Error('USER_NOT_FOUND')
    const openid = user._openid

    const action = body.action
    const col = db.collection('daily_records')

    // 关系标记（P0 隐私隔离 · 2026-10-18）：与小程序 dailyRecord 保持同一规则 ——
    // daily_records.coupleId 只在**创建时**写一次，作为「这条记录产生于哪一段关系」
    // 的不可变证据；读取侧（getPartnerView / aiSummary）据此判断能不能给另一半看。
    // Desktop 是另一个创建入口，如果不写这个字段，桌面端创建的那一天就永远无法
    // 共享给伴侣，还会连带把当天在小程序里的心愿同步挡在门外。
    // 规则：users.coupleId → couples(status=active) 且成员校验通过才写；
    //       没有 coupleId → 显式写 null（已确认未绑定）；有 coupleId 但关系不生效 → 不写。
    async function coupleMarkFor() {
      try {
        if (!user.coupleId) return { coupleId: null }
        const c = (await db.collection('couples')
          .where({ coupleId: user.coupleId, status: 'active' }).get()).data[0]
        if (!c) return {}
        if (c.herOpenid !== openid && c.himOpenid !== openid) return {}
        return { coupleId: c.coupleId }
      } catch (e) {
        console.warn('[desktopDaily] 关系解析失败，本次不写归属', (e && (e.errMsg || e.message)) || '')
        return {}
      }
    }

    // ---- get ----
    if (action === 'get') {
      assertDate(body.date)
      const r = (await col.where({ _openid: openid, date: body.date }).get()).data[0]
      if (!r) return response(200, { ok: true, record: null })
      const doc = migrate(r)
      return response(200, {
        ok: true,
        record: {
          goals: doc.goals || [],
          todos: doc.todos || [],
          revision: typeof doc.revision === 'number' ? doc.revision : 0,
          updatedAt: doc.updatedAt || null
        }
      })
    }

    // ---- save ----
    if (action === 'save') {
      assertDate(body.date)
      if (typeof body.requestId !== 'string' || !body.requestId || body.requestId.length > 128) throw new Error('BAD_ARGS')
      const date = body.date
      const requestId = body.requestId
      const clientRevision = typeof body.revision === 'number' ? body.revision : 0
      const clientGoals = sanitizeGoals(body.goals)
      const todos = sanitizeTodos(body.todos)

      const existing = (await col.where({ _openid: openid, date }).get()).data[0]

      // reminded 只能由服务端（reminderCheck）写：保存时从旧记录继承，客户端提交的值无效。
      const goals = inheritReminded(clientGoals, existing && existing.goals)

      // 幂等：同 date 同 requestId 已处理 → 直接返回当前 revision
      if (existing && existing.lastRequestId === requestId) {
        return response(200, { ok: true, revision: existing.revision, idempotent: true })
      }

      if (!existing) {
        if (clientRevision !== 0) {
          return response(409, { ok: false, code: 'REV_CONFLICT', msg: '记录已存在，请刷新', revision: null })
        }
        const coupleMark = await coupleMarkFor()
        await col.add({
          data: {
            _openid: openid,
            date,
            goals,
            todos,
            ...coupleMark,
            revision: 1,
            lastRequestId: requestId,
            schemaVersion: SCHEMA_VERSION,
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        })
        return response(200, { ok: true, revision: 1 })
      }

      // V1 兼容：无 revision 的旧文档先补 0，使 CAS 可匹配
      if (existing.revision === undefined) {
        await col.doc(existing._id).update({ data: { revision: 0 } })
        existing.revision = 0
      }

      // 字段级合并：只覆盖 goals/todos，其余字段（segments/mood/wishes/score/readProgress…）原样保留
      const upd = await col.where({ _openid: openid, date, revision: clientRevision }).update({
        data: {
          goals,
          todos,
          revision: existing.revision + 1,
          lastRequestId: requestId,
          schemaVersion: SCHEMA_VERSION,
          updatedAt: Date.now()
        }
      })
      if (!upd.stats || upd.stats.updated === 0) {
        return response(409, { ok: false, code: 'REV_CONFLICT', msg: '内容已被更新，请刷新后重试', revision: existing.revision })
      }
      return response(200, { ok: true, revision: existing.revision + 1 })
    }

    // 未知 action：明确 400 + 稳定 code（此前走安全兜底会变成 500 INTERNAL_ERROR，
    // 让「客户端拼错 action」看起来像服务端故障）
    return response(400, { ok: false, code: 'INVALID_ACTION' })
  } catch (error) {
    const code = safeError(error)
    return response(code === 'INTERNAL_ERROR' ? 500 : 400, { ok: false, code })
  }
}
