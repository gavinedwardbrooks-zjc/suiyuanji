// ============================================================
// bindCouple · 核心状态机（PRD v0.6 §2.2 / §5.2）
// 纯逻辑，不依赖 wx-server-sdk。db 由外部注入：
//  - 微信环境：index.js 传入真实 db 的 adapter
//  - 测试环境：tests/mock-db.js 传入内存 mock
// ============================================================

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 去除 I/O/0/1
const CODE_LEN = 8
const CODE_PREFIX = 'XZ-'
const MAX_FAILS = 5
const WINDOW_MS = 10 * 60 * 1000      // 限流窗口 10 分钟
const PENDING_TTL_MS = 24 * 60 * 60 * 1000 // pending 有效期 24h（惰性过期）

function normalizeBindCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : ''
}

function genCode() {
  let r = ''
  for (let i = 0; i < CODE_LEN; i++) r += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  return CODE_PREFIX + r
}
function genRequestId() {
  return 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10)
}
function genCoupleId() {
  return 'CZ-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase()
}

async function findUser(db, openid) {
  const r = await db.collection('users').where({ _openid: openid }).get()
  return r.data[0] || null
}

// ============ 限流（PRD §2.2-3：数据库唯一 SoT，仅绑定成功清零）============

async function isRateLimited(db, openid) {
  const u = await findUser(db, openid)
  if (!u) return false
  const failCount = u.failCount || 0
  const winStart = u.failWindowStart || 0
  if (!winStart) return false
  if (Date.now() - winStart > WINDOW_MS) {
    // 窗口自然过期 → 重置计数（开启新窗口）
    await db.collection('users').doc(u._id).update({ data: { failCount: 0, failWindowStart: 0 } })
    return false
  }
  return failCount >= MAX_FAILS
}

async function registerFail(db, openid) {
  const u = await findUser(db, openid)
  if (!u) return
  const now = Date.now()
  const winStart = u.failWindowStart || 0
  const windowExpired = !winStart || now - winStart > WINDOW_MS
  if (windowExpired) {
    await db.collection('users').doc(u._id).update({ data: { failCount: 1, failWindowStart: now } })
  } else {
    await db.collection('users').doc(u._id).update({ data: { failCount: db.command.inc(1) } })
  }
}

// 仅允许在「绑定成功」时刻调用；login 及其他入口一律不得调用（PRD §2.2-3 / Gate P0-01）
async function clearFail(db, openid) {
  const u = await findUser(db, openid)
  if (!u) return
  await db.collection('users').doc(u._id).update({ data: { failCount: 0, failWindowStart: 0 } })
}

// ============ pending 惰性过期（PRD §2.2-5，不依赖定时器）============

function isPendingExpired(p, now) {
  const expiresAt = p.expiresAt || ((p.createdAt || 0) + PENDING_TTL_MS)
  return now >= expiresAt
}

async function expirePending(db, p, now, reason) {
  await db.collection('couples').doc(p._id).update({
    data: { status: 'expired', expiredAt: now, expiredReason: reason || 'timeout' }
  })
}

// ============ generate：her 生成码（PRD §2.2-2/4，pending 唯一性）============

async function generate({ db, herOpenid, now }) {
  const pendings = (await db.collection('couples').where({ herOpenid, status: 'pending' }).get()).data
  for (const p of pendings) {
    if (isPendingExpired(p, now)) {
      await expirePending(db, p, now, 'timeout')
      continue
    }
    // 存在有效 pending → 拒绝（PRD §2.2-4b / Gate B1）
    return { ok: false, code: 'PENDING_EXISTS', msg: '已有进行中的绑定请求，请先取消' }
  }
  const bindCode = genCode()
  const requestId = genRequestId()
  const coupleId = genCoupleId()
  await db.collection('couples').add({
    data: {
      coupleId,
      herOpenid,
      himOpenid: null,
      bindCode,
      status: 'pending',
      requestId,
      createdAt: now,
      expiresAt: now + PENDING_TTL_MS
    }
  })
  // 同步 her 的 users.bindCode = 最新码（保证 status 与 UI 显示一致，M1 Binding UI 接线）
  const herUser = await findUser(db, herOpenid)
  if (herUser) {
    await db.collection('users').doc(herUser._id).update({ data: { bindCode } })
  }
  return { ok: true, bindCode, requestId, coupleId }
}

// ============ claim：him 输入码（原子认领，PRD §2.2-4a）============

async function claim({ db, code, himOpenid, now }) {
  const normalizedCode = normalizeBindCode(code)
  if (!normalizedCode) return { ok: false, code: 'BAD_ARGS', msg: '缺少绑定码' }
  if (await isRateLimited(db, himOpenid)) {
    return { ok: false, code: 'RATE_LIMITED', msg: '尝试次数过多，请 10 分钟后再试' }
  }
  const pendings = (await db.collection('couples').where({ bindCode: normalizedCode, status: 'pending' }).get()).data
  let target = null
  for (const p of pendings) {
    if (isPendingExpired(p, now)) {
      await expirePending(db, p, now, 'timeout')
      continue
    }
    target = p
    break
  }
  if (!target) {
    await registerFail(db, himOpenid)
    return { ok: false, code: 'INVALID_CODE', msg: '绑定码无效或已过期' }
  }
  if (target.herOpenid === himOpenid) {
    return { ok: false, code: 'SELF_BIND', msg: '不能绑定自己的绑定码' }
  }
  // 幂等：同一 him 重复认领同一 pending → 直接成功（不重复计数）
  if (target.himOpenid && target.himOpenid === himOpenid) {
    return { ok: true, requestId: target.requestId, already: true }
  }
  // 原子认领：仅当仍是 pending 且未被他人认领（update-where 受影响 0 条即失败）
  const r = await db.collection('couples').updateWhere({
    where: { _id: target._id, status: 'pending', himOpenid: db.command.eq(null) },
    data: { himOpenid }
  })
  if (r.updated !== 1) {
    await registerFail(db, himOpenid)
    return { ok: false, code: 'CODE_TAKEN', msg: '绑定码已被使用，请重试' }
  }
  return { ok: true, requestId: target.requestId }
}

// ============ cancel：her 主动取消自己的 pending（PRD §2.2-4b）============

async function cancel({ db, herOpenid, requestId, now }) {
  const r = await db.collection('couples').updateWhere({
    where: { herOpenid, status: 'pending', requestId },
    data: { status: 'expired', expiredAt: now, expiredReason: 'cancelled' }
  })
  return { ok: r.updated === 1, msg: r.updated === 1 ? '已取消' : '请求不存在或已处理' }
}

// ============ confirm：her 同意/拒绝（原子流转 + 换绑事务，PRD §2.2-4c/6）============

async function confirm({ db, herOpenid, requestId, accept, now }) {
  const pendings = (await db.collection('couples').where({ requestId, herOpenid, status: 'pending' }).get()).data
  const p = pendings[0]
  if (!p) return { ok: false, code: 'NOT_FOUND', msg: '绑定请求不存在或已处理' }
  if (isPendingExpired(p, now)) {
    await expirePending(db, p, now, 'timeout')
    return { ok: false, code: 'EXPIRED', msg: '绑定请求已过期' }
  }
  if (!accept) {
    const r = await db.collection('couples').updateWhere({
      where: { _id: p._id, status: 'pending', requestId },
      data: { status: 'expired', expiredAt: now, expiredReason: 'rejected' }
    })
    return { ok: r.updated === 1, msg: r.updated === 1 ? '已拒绝' : '请求已处理' }
  }

  // 同意：单事务完成「新 pending → active；双方 users 更新」。
  //
  // 防双 active（P0 · 2026-10-18）：
  //   旧实现只把 `herOpenid` 命中的旧 active 置为 superseded，**him 一侧的旧 active
  //   不会处理**，于是「他」同时挂着两段 status='active' 的关系。更糟的是这种
  //   「自动 supersede」会在旧伴侣无感知的情况下解除其绑定（未经第三方同意）。
  //   因此改为：确认前检查双方在**任意角色**（her 或 him）下是否已存在其它 active，
  //   有则拒绝（提示先解绑），**不再自动 supersede**。要换绑必须先走 unbind。
  return db.runTransaction(async t => {
    // 我（her）是否已有其它 active（无论以 her 还是 him 身份）
    const herAsHer = (await t.collection('couples').where({ herOpenid, status: 'active' }).get()).data
    if (herAsHer.some(o => o._id !== p._id)) {
      throw { code: 'ALREADY_BOUND', msg: '你已有进行中的情侣关系，请先解除再重新绑定' }
    }
    const herAsHim = (await t.collection('couples').where({ himOpenid: herOpenid, status: 'active' }).get()).data
    if (herAsHim.some(o => o._id !== p._id)) {
      throw { code: 'ALREADY_BOUND', msg: '你已有进行中的情侣关系，请先解除再重新绑定' }
    }
    // 对方（him）是否已有其它 active（无论以 him 还是 her 身份）
    if (p.himOpenid) {
      const himAsHim = (await t.collection('couples').where({ himOpenid: p.himOpenid, status: 'active' }).get()).data
      if (himAsHim.some(o => o._id !== p._id)) {
        throw { code: 'PARTNER_ALREADY_BOUND', msg: '对方已有情侣关系，请先解除再重新绑定' }
      }
      const himAsHer = (await t.collection('couples').where({ herOpenid: p.himOpenid, status: 'active' }).get()).data
      if (himAsHer.some(o => o._id !== p._id)) {
        throw { code: 'PARTNER_ALREADY_BOUND', msg: '对方已有情侣关系，请先解除再重新绑定' }
      }
    }

    const r = await t.collection('couples').updateWhere({
      where: { _id: p._id, status: 'pending', requestId },
      data: { status: 'active', boundAt: now, bindCode: null }
    })
    if (r.updated !== 1) {
      throw { code: 'TX_CONFLICT', msg: '请求已处理' }
    }
    // 更新她：coupleId 指向新关系，清空绑定码
    const herUser = (await t.collection('users').where({ _openid: herOpenid }).get()).data[0]
    if (herUser) {
      await t.collection('users').doc(herUser._id).update({
        data: { coupleId: p.coupleId, bindCode: db.command.remove(), role: 'her' }
      })
    }
    // 更新他：role → him，coupleId 指向新关系
    if (p.himOpenid) {
      const himUser = (await t.collection('users').where({ _openid: p.himOpenid }).get()).data[0]
      if (himUser) {
        await t.collection('users').doc(himUser._id).update({
          data: { coupleId: p.coupleId, role: 'him', bindCode: db.command.remove() }
        })
      }
    }
    // 绑定成功 → 清零双方失败计数（唯一清零入口，PRD §2.2-3）
    if (herUser) {
      await t.collection('users').doc(herUser._id).update({ data: { failCount: 0, failWindowStart: 0 } })
    }
    if (p.himOpenid) {
      const himUser = (await t.collection('users').where({ _openid: p.himOpenid }).get()).data[0]
      if (himUser) {
        await t.collection('users').doc(himUser._id).update({ data: { failCount: 0, failWindowStart: 0 } })
      }
    }
    return { ok: true, coupleId: p.coupleId, partnerOpenid: p.himOpenid, supersededCount: 0 }
  })
}

// ============ unbind：双方原子解除当前 active couple ============
async function unbind({ db, openid, now }) {
  const me = await findUser(db, openid)
  if (!me || !me.coupleId) return { ok: true, already: true, bound: false }
  const couples = (await db.collection('couples').where({ coupleId: me.coupleId, status: 'active' }).get()).data
  const couple = couples[0]
  if (!couple || (couple.herOpenid !== openid && couple.himOpenid !== openid)) {
    return { ok: false, code: 'NOT_ACTIVE', msg: '当前情侣关系未生效' }
  }
  const otherOpenid = couple.herOpenid === openid ? couple.himOpenid : couple.herOpenid
  return db.runTransaction(async t => {
    const current = (await t.collection('couples').where({ _id: couple._id, status: 'active' }).get()).data[0]
    if (!current) return { ok: true, already: true, bound: false }
    await t.collection('couples').doc(couple._id).update({ data: { status: 'unbound', unboundAt: now, unboundByUserUid: me.user_uid || null } })
    const updates = [me]
    if (otherOpenid) {
      const other = (await t.collection('users').where({ _openid: otherOpenid }).get()).data[0]
      if (other) updates.push(other)
    }
    for (const user of updates) {
      await t.collection('users').doc(user._id).update({
        data: { coupleId: null, bindCode: db.command.remove(), partnerName: '' }
      })
    }
    return { ok: true, bound: false }
  })
}

// ============ status：查询我的绑定状态（M1 Binding UI 接线）============

async function status({ db, openid, now = Date.now() }) {
  const me = await findUser(db, openid)
  if (!me) return { ok: true, role: null, bound: false, bindCode: null, pending: null }
  // 我参与的 active（纯私用场景最多 1 个）
  const allActive = (await db.collection('couples').where({ status: 'active' }).get()).data
  const active = allActive.find(c => c.herOpenid === openid || c.himOpenid === openid) || null
  // 只读取当前身份参与的 pending；不得向其他用户暴露绑定码。
  const herPending = (await db.collection('couples').where({ herOpenid: openid, status: 'pending' }).get()).data
  const himPending = (await db.collection('couples').where({ himOpenid: openid, status: 'pending' }).get()).data
  const pendingKey = p => String(p._id || p.requestId || p.coupleId || '')
  const relatedByKey = new Map()
  for (const candidate of [...herPending, ...himPending]) {
    relatedByKey.set(pendingKey(candidate), candidate)
  }

  const selectable = []
  for (const candidate of relatedByKey.values()) {
    if (isPendingExpired(candidate, now)) {
      await expirePending(db, candidate, now, 'timeout')
      continue
    }
    const state = candidate.herOpenid === openid && candidate.himOpenid
      ? 'confirm_needed'
      : (candidate.himOpenid === openid
          ? 'waiting_confirm'
          : (candidate.herOpenid === openid && !candidate.himOpenid ? 'waiting_claim' : null))
    if (state) selectable.push({ candidate, state })
  }

  const priority = { confirm_needed: 0, waiting_confirm: 1, waiting_claim: 2 }
  selectable.sort((a, b) => {
    const priorityDiff = priority[a.state] - priority[b.state]
    if (priorityDiff !== 0) return priorityDiff
    const aCreatedAt = Number.isFinite(a.candidate.createdAt) ? a.candidate.createdAt : Number.NEGATIVE_INFINITY
    const bCreatedAt = Number.isFinite(b.candidate.createdAt) ? b.candidate.createdAt : Number.NEGATIVE_INFINITY
    if (aCreatedAt !== bCreatedAt) return bCreatedAt - aCreatedAt
    return pendingKey(a.candidate).localeCompare(pendingKey(b.candidate))
  })

  const selected = selectable[0] || null
  const pending = selected ? selected.candidate : null
  const pendingView = selected ? {
    requestId: pending.requestId,
    createdAt: pending.createdAt,
    state: selected.state,
    needsMe: selected.state === 'confirm_needed'
  } : null
  return {
    ok: true,
    role: me.role,
    bound: !!active,
    coupleId: active ? active.coupleId : null,
    partnerOpenid: active ? (active.herOpenid === openid ? active.himOpenid : active.herOpenid) : null,
    // 仅 waiting_claim 可继续展示当前用户生成的绑定码；users.bindCode 仅作历史兼容存储。
    bindCode: selected && selected.state === 'waiting_claim' && pending.herOpenid === openid ? pending.bindCode || null : null,
    pending: pendingView
  }
}

// ============ 迁移契约（PRD §4.1 B2：schemaVersion 缺失=v1，幂等，核心字段不变）============

const SCHEMA_VERSION = 2

function migrateDocV1ToV2(doc) {
  if (doc.schemaVersion >= SCHEMA_VERSION) return { doc, changed: false }
  // 只补 schemaVersion，绝不改动任何业务字段
  return { doc: { ...doc, schemaVersion: SCHEMA_VERSION }, changed: true }
}

module.exports = {
  genCode,
  isRateLimited,
  registerFail,
  clearFail,
  isPendingExpired,
  expirePending,
  generate,
  claim,
  cancel,
  confirm,
  unbind,
  status,
  migrateDocV1ToV2,
  SCHEMA_VERSION,
  MAX_FAILS,
  WINDOW_MS,
  PENDING_TTL_MS
}
