// ============================================================
// utils/partner-view.js · 伴侣共享数据的唯一取数入口（V1.1 · P2）
//
// 三条硬约束（对应 P2 §5）：
//   1. 前端角色判定只是**预判**；可见数据必须来自 getPartnerView 返回 ok:true。
//   2. 失败（NOT_ACTIVE / UNAUTHORIZED / 网络异常 / 结构非法）时**不保留旧数据**，
//      由调用方把状态置为 blocked / error 并清空展示字段。
//   3. 所有异步写回必须带**单调令牌**：日期切换、身份变化、页面离开后，
//      旧请求的返回一律丢弃，不允许覆盖新状态。
//
// 本模块不判定授权、不改云函数；只做「白名单裁剪 + 统一错误码 + 令牌」。
// ============================================================

// 统一错误码（服务端原有 code + 客户端补充的两个）
const CODE = {
  NOT_ACTIVE: 'NOT_ACTIVE',
  UNAUTHORIZED: 'UNAUTHORIZED',
  BAD_ACTION: 'BAD_ACTION',
  NETWORK: 'NETWORK',   // 客户端：调用抛错 / 超时
  UNKNOWN: 'UNKNOWN'    // 客户端：返回结构不认识
}

// 展示白名单：只允许这些字段进入页面 data。
// 服务端即便未来多返回字段，也不会被前端持有（深度防御，不替代服务端授权）。
// V1.1 · P3.1：新增 shared —— 必须是显式列入白名单的字段，
// 不做「整个响应原样透传」（否则服务端任何新增字段都会自动进入页面）。
const VIEW_FIELDS = [
  'role',
  'myPartnerName',
  'score',
  'wishes',
  // V1.1：这一天（北京时间）创建的心愿，记录页「这天的愿望」只认它
  'dayWishes',
  'messages',
  'unreadMsgs',
  'anniversary',
  'days',
  'partnerSummary',
  'partnerSummaryAt',
  'partnerRole',
  'shared'
]

// 心愿字段白名单（列表项也是白名单）
const WISH_FIELDS = ['_id', 'type', 'text', 'status', 'arrangedAt', 'createdAt']

// 共同待办字段白名单（V1.1）。createdDate / doneDate 由服务端按北京时间算好，
// 客户端不再自己推日期 —— 两边口径不一致会让「这一天新增的」整体错位。
const TODO_FIELDS = ['_id', 'text', 'done', 'createdAt', 'doneAt', 'createdDate', 'doneDate']

// 共享内容白名单（P3.1）：只有心情、天气、三段日记
const SHARED_SEGMENTS = ['life', 'work', 'growth']
const SHARED_SEGMENT_MAX = 20000

function asText(v, max) {
  if (typeof v !== 'string') return ''
  return max && v.length > max ? v.slice(0, max) : v
}

// 分享内容：结构不认识就返回 null（= 没有共享），绝不猜
function pickShared(raw) {
  if (!raw || typeof raw !== 'object') return null
  const mood = raw.mood && typeof raw.mood === 'object' ? raw.mood : {}
  const segs = raw.segments && typeof raw.segments === 'object' ? raw.segments : {}
  const segments = {}
  for (const k of SHARED_SEGMENTS) segments[k] = asText(segs[k], SHARED_SEGMENT_MAX)
  return {
    mood: {
      type: typeof mood.type === 'string' ? mood.type : '',
      weather: typeof mood.weather === 'string' ? mood.weather : ''
    },
    segments
  }
}

function pickWish(w) {
  const out = {}
  if (!w || typeof w !== 'object') return out
  for (const k of WISH_FIELDS) if (w[k] !== undefined) out[k] = w[k]
  return out
}

function pickView(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const k of VIEW_FIELDS) if (src[k] !== undefined) out[k] = src[k]
  // 心愿只保留白名单字段；非数组一律归一为空数组（不猜结构）
  out.wishes = Array.isArray(src.wishes) ? src.wishes.map(pickWish) : []
  // 「这天的愿望」同一套字段白名单；缺失/异常 → 空数组（= 这天没有心愿）
  out.dayWishes = Array.isArray(src.dayWishes) ? src.dayWishes.map(pickWish) : []
  // 共享内容：结构不认识 → null（页面据此视为「没有共享」）
  out.shared = pickShared(src.shared)
  return out
}

// 共同待办的一条记录：只保留白名单字段（服务端多返回什么都进不来）
function pickTodo(t) {
  const out = {}
  if (!t || typeof t !== 'object') return out
  for (const k of TODO_FIELDS) if (t[k] !== undefined) out[k] = t[k]
  return out
}

// ============================================================
// 共同待办（couple_todos）的唯一取数入口
//
// 它和「伴侣视图」共用同一个云函数（getPartnerView），但返回结构完全不同，
// 所以单独一个入口，而不是把 op 塞进 requestPartnerView。
// 页面依然不直接 wx.cloud.callFunction —— 取数与错误码口径统一在这里，
// 这正是 partner-view 存在的意义（页面里出现 name:'getPartnerView' 即为越权写法）。
//
// op：'list' | 'add' | 'toggle' | 'remove'
// payload：list 无；add {text}；toggle {id, done}；remove {id}
// 返回：{ ok:true, items, item, id, done, doneAt, truncated, limit }
//     | { ok:false, code, msg }
// ============================================================
function requestCoupleTodo(op, payload, callFn) {
  const fn = callFn
  if (typeof fn !== 'function') return Promise.resolve({ ok: false, code: CODE.UNKNOWN })
  const data = Object.assign({ action: 'coupleTodo', op: String(op || '') }, payload || {})
  return Promise.resolve(fn({ name: 'getPartnerView', data }))
    .then(res => {
      const r = res && typeof res === 'object' && Object.prototype.hasOwnProperty.call(res, 'result')
        ? res.result
        : res
      if (!r || typeof r !== 'object') return { ok: false, code: CODE.UNKNOWN }
      if (r.ok !== true) {
        return {
          ok: false,
          code: r.code || CODE.UNKNOWN,
          // 服务端给了可读原因就原样给页面（例如「一件事最多 40 个字」）
          msg: typeof r.msg === 'string' ? r.msg : ''
        }
      }
      return {
        ok: true,
        items: Array.isArray(r.items) ? r.items.map(pickTodo) : [],
        item: r.item ? pickTodo(r.item) : null,
        id: typeof r.id === 'string' ? r.id : '',
        done: r.done === true,
        doneAt: typeof r.doneAt === 'number' ? r.doneAt : 0,
        truncated: r.truncated === true,
        limit: typeof r.limit === 'number' ? r.limit : 0
      }
    })
    .catch(() => ({ ok: false, code: CODE.NETWORK }))
}

// 把 callFunction 的返回值 / 云函数原始 result 都归一成 { ok, data } | { ok:false, code }
function normalizeResponse(res) {
  const r = res && typeof res === 'object' && Object.prototype.hasOwnProperty.call(res, 'result')
    ? res.result
    : res
  if (!r || typeof r !== 'object') return { ok: false, code: CODE.UNKNOWN }
  if (r.ok !== true) return { ok: false, code: r.code || CODE.UNKNOWN }
  return { ok: true, data: pickView(r) }
}

// 身份指纹：openid / role / coupleId 任一变化都要作废在途请求并清数据。
// 空值统一折叠成空串，避免 undefined 与 null 被当成「变了」。
function identityKeyOf(globalData) {
  const g = globalData && typeof globalData === 'object' ? globalData : {}
  const openid = typeof g.openid === 'string' ? g.openid.trim() : ''
  const role = g.role === 'her' || g.role === 'him' ? g.role : ''
  const coupleId = typeof g.coupleId === 'string' ? g.coupleId.trim() : ''
  return openid + '|' + role + '|' + coupleId
}

// 单调令牌：begin() 递增 → 旧令牌自动失效。
// 日期切换连点、换绑后旧请求、页面离开后返回，都靠它丢弃。
function createController() {
  let epoch = 0
  let identity = null
  return {
    // 每次发起请求前调用，拿到本次令牌
    begin() { epoch += 1; return { token: epoch } },
    // 写回前必须校验：false = 该请求已过期，直接丢弃
    isCurrent(token) { return typeof token === 'number' && token === epoch },
    // 页面隐藏 / 离开 / 切模式时调用：让所有在途请求作废
    invalidate() { epoch += 1 },
    // 身份变化检测：首次调用只记录，不视为变化
    watchIdentity(globalData) {
      const key = identityKeyOf(globalData)
      if (identity === null) { identity = key; return false }
      if (key !== identity) { identity = key; epoch += 1; return true }
      return false
    },
    identity() { return identity }
  }
}

// 取数：call 由调用方注入（页面传 wx.cloud.callFunction，测试传假函数），
// 因此本模块不依赖 wx，可在 node 下直接单测。
function requestPartnerView(date, call) {
  if (typeof call !== 'function') return Promise.resolve({ ok: false, code: CODE.UNKNOWN })
  const data = { action: 'view' }
  if (typeof date === 'string' && date) data.date = date
  let pending
  try {
    pending = call({ name: 'getPartnerView', data })
  } catch (e) {
    return Promise.resolve({ ok: false, code: CODE.NETWORK })
  }
  return Promise.resolve(pending)
    .then(normalizeResponse)
    .catch(() => ({ ok: false, code: CODE.NETWORK }))
}

// 有内容才叫 ready；否则 empty（不代表对方当天没有记录，只是「没有可查看内容」）
// P3：她主动共享的这一天（shared 非空）本身就是「有内容」——
//     即使没有评分/小结/心愿，him 也应该看到共享区，而不是「这一天没有可查看内容」。
function viewStateOf(data) {
  const d = data || {}
  const hasScore = typeof d.score === 'number' && d.score > 0
  const hasSummary = typeof d.partnerSummary === 'string' && d.partnerSummary.trim() !== ''
  const hasWishes = Array.isArray(d.wishes) && d.wishes.length > 0
  const hasShared = !!d.shared
  return hasScore || hasSummary || hasWishes || hasShared ? 'ready' : 'empty'
}

module.exports = {
  CODE,
  VIEW_FIELDS,
  WISH_FIELDS,
  TODO_FIELDS,
  pickView,
  pickShared,
  pickTodo,
  normalizeResponse,
  identityKeyOf,
  createController,
  requestPartnerView,
  requestCoupleTodo,
  viewStateOf
}
