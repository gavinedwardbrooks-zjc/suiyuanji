// ============================================================
// bindCouple · 云函数入口（PRD v0.6 §6.1）
// 仅做：解析 OPENID/event → 调用 core.js → 返回结果
// 核心状态机见 core.js（可单测）
// ============================================================
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const core = require('./core')

// 把真实 db 包装成 core.js 需要的 adapter 接口
function makeColAdapter(col) {
  return {
    where: q => ({ get: () => col.where(q).get() }),
    add: async ({ data }) => {
      const r = await col.add({ data })
      return { _id: r._id }
    },
    doc: id => ({ update: ({ data }) => col.doc(id).update({ data }) }),
    updateWhere: async ({ where, data }) => {
      const r = await col.where(where).update({ data })
      return { updated: (r.stats && r.stats.updated) || 0 }
    }
  }
}

function makeTxnAdapter(t) {
  const wrap = (col) => ({
    where: q => ({ get: () => col.where(q).get() }),
    doc: id => ({ update: ({ data }) => col.doc(id).update({ data }) }),
    updateWhere: async ({ where, data }) => {
      const r = await col.where(where).update({ data })
      return { updated: (r.stats && r.stats.updated) || 0 }
    }
  })
  return { collection: name => wrap(t.collection(name)) }
}

const adapter = {
  command: db.command,
  collection: name => makeColAdapter(db.collection(name)),
  async runTransaction(fn) {
    const t = await db.startTransaction()
    try {
      const res = await fn(makeTxnAdapter(t))
      await t.commit()
      return res
    } catch (e) {
      await t.rollback().catch(() => {})
      throw e
    }
  }
}

exports.main = async (event = {}, context) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { ok: false, msg: '未获取到用户身份' }

  const action = event.action
  const now = Date.now()

  try {
    switch (action) {
      case 'generate': // her 生成绑定码
        return await core.generate({ db: adapter, herOpenid: OPENID, now })

      case 'claim': // him 输入绑定码
        if (!event.code || typeof event.code !== 'string') return { ok: false, code: 'BAD_ARGS', msg: '缺少绑定码' }
        return await core.claim({ db: adapter, code: event.code, himOpenid: OPENID, now })

      case 'confirm': // her 同意/拒绝
        if (!event.requestId) return { ok: false, code: 'BAD_ARGS', msg: '缺少 requestId' }
        return await core.confirm({
          db: adapter,
          herOpenid: OPENID,
          requestId: event.requestId,
          accept: event.accept !== false,
          now
        })

      case 'cancel': // her 取消自己的 pending
        if (!event.requestId) return { ok: false, code: 'BAD_ARGS', msg: '缺少 requestId' }
        return await core.cancel({ db: adapter, herOpenid: OPENID, requestId: event.requestId, now })

      case 'unbind':
        return await core.unbind({ db: adapter, openid: OPENID, now })

      case 'status': // 查询我的绑定状态（M1 Binding UI 接线）
        return await core.status({ db: adapter, openid: OPENID })

      default:
        return { ok: false, code: 'BAD_ACTION', msg: '未知操作: ' + action }
    }
  } catch (e) {
    const code = e && e.code
    if (code === 'TX_CONFLICT' || code === 'ALREADY_BOUND' || code === 'PARTNER_ALREADY_BOUND') {
      return { ok: false, code, msg: (e && e.msg) || '操作失败' }
    }
    console.error('bindCouple error', action, e)
    return { ok: false, code: 'INTERNAL', msg: '服务繁忙，请稍后重试' }
  }
}
