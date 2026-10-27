// ============================================================
// deleteAccount · 云函数（V1.0 公开版 — 数据删除与账号注销）
// actions:
//   preview — 返回注销的影响范围（删除哪些/保留哪些），供前端二次确认弹窗展示
//   execute — 执行注销：解绑 → 删除个人数据 → 删除用户档案
//
// 隐私与安全：
//   · 身份一律来自 cloud.getWXContext().OPENID，前端传不了别人的 openid
//   · 只删除**本人**数据（_openid === OPENID / fromOpenid === OPENID）
//   · 区分个人 / 共享数据：
//       - 个人数据（日记、心愿、经期、画像、书、自己发的留言、用户档案）→ 物理删除
//       - 共享数据（couples 关系、对方发的留言、周报）→ 不物理删除，
//         只解绑（couple → unbound），此后对方通过 getPartnerView 也读不到旧内容
//   · 注销不可逆：execute 前前端必须先 preview 并让用户明确确认
//
// 上线阻断项（本轮不部署、不碰真实云数据，仅本地实现 + 测试）：
//   1. 微信侧账号级注销需接入微信官方接口，本函数只删除小程序云数据库内的数据；
//   2. 共享数据（couples / 对方 messages / weekly_reports）物理删除会伤及对方，
//      故只解绑不物理删除 —— 若合规要求「彻底物理删除」，需另行设计双向确认流程。
// ============================================================
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 个人数据集合（按 _openid 物理删除）
const PERSONAL_COLLECTIONS = ['daily_records', 'wishes', 'menstrual', 'profiles', 'books']

async function getMe(openid) {
  return (await db.collection('users').where({ _openid: openid }).get()).data[0] || null
}

// 当前 active 关系（带成员校验：coupleId 指向与自己无关的关系不算数）
async function activeCouple(openid, me) {
  if (!me || !me.coupleId) return null
  const c = (await db.collection('couples').where({ coupleId: me.coupleId, status: 'active' }).get()).data[0]
  if (!c || (c.herOpenid !== openid && c.himOpenid !== openid)) return null
  return c
}

// preview：影响范围（只读，不删除任何数据）
async function preview(openid) {
  const me = await getMe(openid)
  const c = await activeCouple(openid, me)
  const counts = {}
  for (const col of PERSONAL_COLLECTIONS) {
    const r = await db.collection(col).where({ _openid: openid }).get()
    counts[col] = (r && r.data ? r.data.length : 0)
  }
  const msgR = await db.collection('messages').where({ fromOpenid: openid }).get()
  counts.messages = (msgR && msgR.data ? msgR.data.length : 0)
  return {
    ok: true,
    bound: !!c,
    willUnbind: !!c,
    willDelete: { ...counts, users: me ? 1 : 0 },
    sharedKept: {
      couples: c ? '解绑置 unbound（不物理删除）' : '无',
      partnerMessages: '对方发送的留言保留（关系解除后对方无法再访问）',
      weeklyReports: '涉及本关系的周报保留（关系解除后无法再访问）'
    },
    note: '注销会永久删除你的日记、心愿、经期、画像、书籍等个人数据；共享数据因涉及双方只解除绑定、不物理删除。此操作不可撤销。'
  }
}

// execute：执行注销（尽力而为 + 明确上报失败集合）
async function execute(openid) {
  const me = await getMe(openid)
  const deleted = {}
  const failedCollections = []

  // 1. 解绑（如 active）—— 共享数据不物理删除，只解除访问
  if (me && me.coupleId) {
    const c = await activeCouple(openid, me)
    if (c) {
      const otherOpenid = c.herOpenid === openid ? c.himOpenid : c.herOpenid
      await db.collection('couples').doc(c._id).update({
        data: { status: 'unbound', unboundAt: Date.now(), unboundByUserUid: me.user_uid || null }
      })
      if (otherOpenid) {
        const other = (await db.collection('users').where({ _openid: otherOpenid }).get()).data[0]
        if (other) {
          await db.collection('users').doc(other._id).update({
            data: { coupleId: null, bindCode: db.command.remove(), partnerName: '' }
          })
        }
      }
    }
  }

  // 2. 删除个人数据（尽力而为：单个集合失败不影响其他集合，但必须上报）
  for (const col of PERSONAL_COLLECTIONS) {
    try {
      const r = await db.collection(col).where({ _openid: openid }).remove()
      deleted[col] = (r && r.stats && r.stats.removed) || 0
    } catch (e) {
      console.error('[deleteAccount] delete fail', col, (e && (e.errMsg || e.message)) || String(e))
      failedCollections.push(col)
    }
  }
  // 自己发的留言
  try {
    const r = await db.collection('messages').where({ fromOpenid: openid }).remove()
    deleted.messages = (r && r.stats && r.stats.removed) || 0
  } catch (e) {
    console.error('[deleteAccount] delete fail messages', (e && (e.errMsg || e.message)) || String(e))
    failedCollections.push('messages')
  }

  // 3. 删除用户档案（最后一步：档案删除后即"注销"）
  let removedUser = 0
  if (me) {
    try {
      const r = await db.collection('users').doc(me._id).remove()
      removedUser = (r && r.stats && r.stats.removed) || 0
    } catch (e) {
      console.error('[deleteAccount] delete fail users', (e && (e.errMsg || e.message)) || String(e))
      failedCollections.push('users')
    }
  }
  deleted.users = removedUser

  return {
    ok: failedCollections.length === 0,
    deleted,
    failedCollections,
    msg: failedCollections.length ? '部分数据删除失败，请稍后重试' : '已注销并删除个人数据'
  }
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { ok: false, code: 'UNAUTHORIZED', msg: '未获取到用户身份' }
  if (event.action === 'preview') return preview(OPENID)
  if (event.action === 'execute') return execute(OPENID)
  return { ok: false, code: 'BAD_ACTION', msg: '未知操作' }
}

module.exports.main = exports.main
module.exports.PERSONAL_COLLECTIONS = PERSONAL_COLLECTIONS
