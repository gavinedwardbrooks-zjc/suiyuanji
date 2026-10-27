// ============================================================
// utils/viewer-role.js · 角色与绑定状态的唯一判定口径（V1.1 · P0）
//
// 唯一数据来源：app.globalData（openid / role / coupleId），不新建第二套角色系统。
//   · role     来自 users.role，由绑定确认时服务端写入（生成绑定码的一方='her'，
//              认领绑定码的一方='him'），登录时随 login 返回。
//   · coupleId 来自 users.coupleId，登录时随 login 返回；解绑时被置空。
//
// 【重要限制 · 必须按 fail-closed 使用】
//   coupleId 只是 users 文档上的一个字段，**不能证明 couples.status === 'active'**。
//   解绑、换绑、被新的 active 关系取代之后，本地这份值都可能滞后或过期
//   （例如绑定成功后本地不会即时回写，需要重新登录才更新）。
//   因此 resolveViewer() 永远返回 serverVerified: false。
//   任何「进入伴侣视图 / 展示共享数据」的判断，都必须再以服务端
//   bindCouple.status 或 getPartnerView 的结果为准，本模块只做**前置门槛**，
//   不做授权本身。
//
// 【安全降级】
//   身份未就绪（openid 缺失）   → state='loading'      → 全部角色位为 false
//   已登录但角色缺失或非法      → state='role_unknown' → 全部角色位为 false
//   角色就绪但没有 coupleId     → state='unbound'      → 不进伴侣视图
//   角色就绪且有 coupleId       → state='bound'        → 仍需服务端复核 active
// ============================================================

const ROLE_HER = 'her'
const ROLE_HIM = 'him'

// 四种查看者状态；非 loading 的两端都不允许进入伴侣视图
const STATE_LOADING = 'loading'
const STATE_ROLE_UNKNOWN = 'role_unknown'
const STATE_UNBOUND = 'unbound'
const STATE_BOUND = 'bound'

// 只接受两个合法角色值，其余（大小写变体、空串、历史脏值）一律视为「角色未知」。
// 不按性别、昵称、登录顺序或 openid 大小推断角色。
function normalizeRole(value) {
  return value === ROLE_HER || value === ROLE_HIM ? value : null
}

// coupleId 必须是「非空白字符串」才算存在；null/undefined/数字/空白串都归一为 null。
function normalizeCoupleId(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

// 核心判定：把 globalData 折叠成一份只读快照。
// 入参允许是 undefined/null（页面首屏 race 期），此时安全降级为 loading。
function resolveViewer(globalData) {
  const g = globalData && typeof globalData === 'object' ? globalData : {}

  const openid = typeof g.openid === 'string' && g.openid.trim() ? g.openid.trim() : null
  const role = normalizeRole(g.role)
  const coupleId = normalizeCoupleId(g.coupleId)

  const identityReady = !!openid
  const roleReady = identityReady && !!role

  let state
  if (!identityReady) state = STATE_LOADING
  else if (!roleReady) state = STATE_ROLE_UNKNOWN
  else if (!coupleId) state = STATE_UNBOUND
  else state = STATE_BOUND

  const isHer = roleReady && role === ROLE_HER
  const isHim = roleReady && role === ROLE_HIM
  // bound 只在角色已确认时成立：角色缺失但有 coupleId 也按「未确认绑定」处理
  const bound = state === STATE_BOUND

  return {
    openid,
    role,
    coupleId,
    state,
    identityReady,
    roleReady,
    bound,
    isHer,
    isHim,
    partnerRole: isHer ? ROLE_HIM : (isHim ? ROLE_HER : null),
    // 伴侣视图的唯一入口条件：角色确认是 him **且** 已确认绑定。
    // 单独 role === 'him' 不足以进入（未绑定/解绑/本地未刷新都会被拦住）。
    canEnterPartnerView: isHim && bound,
    // 绑定值来自本地 globalData，未经服务端 active 复核
    boundSource: bound ? 'local' : null,
    serverVerified: false,
    // 降级原因（便于页面与测试定位，不要用于展示给用户）
    degradeReason: state === STATE_LOADING
      ? 'identity-not-ready'
      : state === STATE_ROLE_UNKNOWN
        ? 'role-missing'
        : state === STATE_UNBOUND
          ? 'no-couple'
          : null
  }
}

// 供页面 setData 直接使用的扁平快照（字段名固定，避免各页面各起一套名字）
function viewerFlags(globalData) {
  const v = resolveViewer(globalData)
  return {
    viewerState: v.state,
    roleReady: v.roleReady,
    isHer: v.isHer,
    isHim: v.isHim,
    bound: v.bound,
    canEnterPartnerView: v.canEnterPartnerView
  }
}

// ============================================================
// 页面视图模式（V1.1 · P1 建立骨架 / P2 打开开关）
//
// 目的：把「这一屏该渲染谁的视图」收成一个显式取值，页面 WXML 只按它分支，
// 不再散落 role 判断。
//
//   owner              —— 记录方视图（现有线上界面）
//   pending            —— 身份/角色尚未确认，中性等待（不渲染任何一方的表单）
//   companion          —— 陪伴方视图（仅在 him 且本地已确认绑定时进入，
//                         内容仍需 getPartnerView 服务端验证成功）
//   companion-blocked  —— 已确认是陪伴方但没有可用绑定（未绑定 / 解绑后），
//                         只给安全状态，不允许回落 owner（否则会看到记录编辑页）
//
// 安全约束：开关由页面 `companionViewEnabled` 显式打开（P2 起为 true）。
// 角色未确认一律 pending（不猜测为 her）；her 确认后才是 owner。
// ============================================================
const VIEW_MODE_OWNER = 'owner'
const VIEW_MODE_COMPANION = 'companion'
// 已确认是陪伴方、但本地没有有效绑定（未绑定 / 已解绑）→ 只能给安全状态，
// 不允许回落到 owner（否则陪伴方会看到个人记录编辑页）。
const VIEW_MODE_COMPANION_BLOCKED = 'companion-blocked'
// 身份或角色尚未确认（首屏静默登录未返回）→ 中性等待，谁的表单都不渲染。
// 这是 P2.1 修掉「首次登录先闪一下 owner 表单」的关键。
const VIEW_MODE_PENDING = 'pending'

function pageViewMode(globalData, options) {
  const v = resolveViewer(globalData)
  // 只认字面量 true：避免 'false' / 1 / 对象等真值把伴侣视图意外打开
  const enabled = !!options && options.companionViewEnabled === true
  if (!enabled) return VIEW_MODE_OWNER
  // 1) 身份未就绪 / 角色未知：不猜角色，不渲染任何一方页面
  if (v.state === STATE_LOADING || v.state === STATE_ROLE_UNKNOWN) return VIEW_MODE_PENDING
  // 2) 陪伴方且已确认绑定
  if (v.canEnterPartnerView) return VIEW_MODE_COMPANION
  // 3) 角色已确认是陪伴方，但没有可用绑定（解绑后 role 会残留，必须靠 coupleId 归零拦住）
  if (v.isHim) return VIEW_MODE_COMPANION_BLOCKED
  // 4) 记录方
  return VIEW_MODE_OWNER
}

module.exports = {
  ROLE_HER,
  ROLE_HIM,
  STATE_LOADING,
  STATE_ROLE_UNKNOWN,
  STATE_UNBOUND,
  STATE_BOUND,
  VIEW_MODE_OWNER,
  VIEW_MODE_COMPANION,
  VIEW_MODE_COMPANION_BLOCKED,
  VIEW_MODE_PENDING,
  normalizeRole,
  normalizeCoupleId,
  resolveViewer,
  viewerFlags,
  pageViewMode
}
