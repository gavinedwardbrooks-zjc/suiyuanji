const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const TPL_REMIND = process.env.TPL_REMIND || ''

function pad(n) { return String(n).padStart(2, '0') }
function fmt(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }

exports.main = async (event, context) => {
  const now = new Date()
  const date = fmt(now)
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`

  const recs = (await db.collection('daily_records').where({ date }).get()).data
  let sent = 0

  for (const r of recs) {
    let changed = false
    for (let i = 0; i < r.goals.length; i++) {
      const g = r.goals[i]
      if (g.reminderOn && !g.done && !g.reminded && g.reminderTime <= hhmm) {
        try { await sendRemind(r._openid, g.text) } catch (e) { console.error('remind fail', e) }
        r.goals[i] = { ...g, reminded: true }
        changed = true
        sent++
      }
    }
    if (changed) {
      await db.collection('daily_records').doc(r._id).update({ data: { goals: r.goals } })
    }
  }
  return { ok: true, sent }
}

async function sendRemind(openid, text) {
  if (!TPL_REMIND) return
  await cloud.openapi.subscribeMessage.send({
    touser: openid,
    templateId: TPL_REMIND,
    data: {
      thing1: { value: (text || '今日目标').slice(0, 20) },
      thing2: { value: '还有目标没完成哦，慢慢来～' }
    }
  })
}
