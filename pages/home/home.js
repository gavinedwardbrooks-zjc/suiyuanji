const app = getApp()
const ICONS = require('../../assets/svg-icons')
const { displayName } = require('../../utils/partner-name')
// V1.1 · P0/P1/P2：角色与绑定状态一律走 utils/viewer-role.js，页面内不做角色比较
const { viewerFlags, pageViewMode, VIEW_MODE_OWNER, VIEW_MODE_COMPANION } = require('../../utils/viewer-role')
// V1.1 · P2：伴侣数据的唯一入口（白名单 + 统一错误码 + 防过期令牌）
const { createController, requestPartnerView, viewStateOf } = require('../../utils/partner-view')

// 装饰元素 SVG（治愈系重塑，2026-08-28）
const decoSrc = {
  tape: ICONS.deco_tape,
  cloud: ICONS.deco_cloud,
  flower: ICONS.deco_flower,
  heart: ICONS.deco_heart_cute,
  star: ICONS.deco_star,
  sprout: ICONS.deco_sprout,
  cat: ICONS.deco_cat_hero
}

// ============================================================
// 首页 · M3（PRD v0.6 §4.3 / H1-H4）
// 职责：看今天（信息层级固定），不是编辑页；编辑走记录页
// ============================================================

function fmtDate(d) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function addDays(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return fmtDate(new Date(y, m - 1, d + delta))
}
function fmtShort(dateStr) {
  // '2026-08-20' -> '8/20'
  const [, m, d] = dateStr.split('-')
  return `${Number(m)}/${Number(d)}`
}
function greet() {
  const h = new Date().getHours()
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

// 预计经期摘要（只做展示格式化，不做任何推算；日期来自服务端 menstrual get）
function fmtPeriodLabel(nextStart) {
  if (typeof nextStart !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(nextStart)) return ''
  const [, m, d] = nextStart.split('-')
  return `${Number(m)}月${Number(d)}日左右`
}

// 纪念日辅助行：「在一起 · 2024-05-20」
function fmtAnniText(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return ''
  return '在一起 · ' + dateStr
}

// 心愿摘要：只给数量，不铺长列表（详情与管理在「我们」页）
function wishSummaryOf(list) {
  const arr = Array.isArray(list) ? list : []
  if (arr.length === 0) return '今天还没有心愿'
  const eat = arr.filter(w => w && w.type === 'eat').length
  const want = arr.length - eat
  if (eat > 0 && want > 0) return `想吃 ${eat} · 想做 ${want}`
  if (eat > 0) return `想吃 ${eat}`
  return `想做 ${want}`
}

// 心情/天气几何极简图标（§3.2 第二层，无 emoji）
const moodSrcMap = {
  happy: ICONS.mood_happy, calm: ICONS.mood_calm, low: ICONS.mood_low,
  angry: ICONS.mood_angry, tired: ICONS.mood_tired
}
const weatherSrcMap = {
  sunny: ICONS.weather_sunny, cloudy: ICONS.weather_cloudy,
  rain: ICONS.weather_rain, snow: ICONS.weather_snow
}

Page({
  data: {
    date: '', todayStr: '', greeting: '',
    // H1 今日状态（今日得分 + 心情）
    score: 0, scoreWord: '今天给 TA 打几分呢', moodSrc: '', weatherSrc: '',
    partnerName: 'TA',
    // H1 目标 / 小事
    goals: [], goalDone: 0, goalTotal: 0,
    todoCount: 0, todoDone: 0,
    // H3 AI 小结
    summary: '', summaryAt: '', hasSummary: false, summarySkeleton: false,
    // H2 空状态
    hasRecord: false, loading: true,
    // 治愈系装饰 SVG（Hero + 角落）
    decoTapeSrc: decoSrc.tape, decoCloudSrc: decoSrc.cloud,
    heroCatSrc: '',
    decoFlowerSrc: decoSrc.flower, decoHeartSrc: decoSrc.heart,
    decoStarSrc: decoSrc.star, decoSproutSrc: decoSrc.sprout,
    // H4 最近 7 天
    weekDays: [],
    // V1.1 · P0：查看者快照（只接线，不改变任何可见行为）
    // 默认值即「未加载」态：角色未确认前一律 false，避免误入伴侣视图。
    viewerState: 'loading', roleReady: false, isHer: false, isHim: false,
    bound: false, canEnterPartnerView: false,
    // V1.1 · P1/P2/P2.1：视图模式。pending = 身份未确认（不渲染任何一方页面）；
    // owner = 记录方视图；companion = 陪伴方仪表盘；companion-blocked = 陪伴方但绑定不可用。
    // 默认值必须是 pending：首屏在角色确认前不得出现个人记录相关界面。
    viewMode: 'pending', companionViewEnabled: true,
    // V1.1 · P2：伴侣共享数据。只存放 getPartnerView 白名单内的字段；
    // 请求开始/失败/身份变化时一律清空，绝不把上一份数据留在页面上。
    pvState: 'idle', pvCode: '', pvName: '', pvScore: null, pvSummary: '', pvWishes: [], pvDays: null,
    pvAnniText: '', pvWishSummary: '今天还没有心愿',
    // 记录方首页纪念日：与陪伴端同源（getPartnerView 的 anniversary / days），
    // 不新增接口、不新建字段；服务端说没有就是没有（null），前端不自己算天数。
    // ownAnniState 三态：idle（未加载，什么都不显示）/ ready（有权威结果）/ error（读不到，同样不显示）
    // 目的：避免「还没加载完」被渲染成「还没有设置纪念日」的假空态。
    ownDays: null, ownAnniText: '', ownAnniState: 'idle',
    // 首页经期摘要（both 角色；服务端按 sharePeriod 授权判定，未授权为空 → 不显示）
    homeNextLabel: '',
    // V1.1 今日决定（吃什么 / 去哪里）：双方同源，her 点卡片进推荐页改，him 只查看。
    // dayChoiceState：idle / loading / ready / error（读不到） / blocked（关系不可用）
    // 硬约束：网络或服务失败时**不得**渲染成「今天还没决定」，只显示「暂时读不到」。
    dayChoiceState: 'idle',
    mealDecided: false, mealName: '', mealAt: 0,
    travelDecided: false, travelName: '', travelAt: 0,
    // V1.1 · P3.0：登录态（失败/超时 → 明确提示 + 重试）
    loginState: 'loading'
  },

  onShow() { this.refresh() },
  // 页面离开即作废在途请求：回来之前到达的旧结果不得写回页面
  onHide() {
    if (this._pv) this._pv.invalidate()
    if (this._anni) this._anni.invalidate()
    this._periodSeq = (this._periodSeq || 0) + 1
    this._daySeq = (this._daySeq || 0) + 1
  },
  onUnload() {
    if (this._pv) this._pv.invalidate()
    if (this._anni) this._anni.invalidate()
    this._periodSeq = (this._periodSeq || 0) + 1
    this._daySeq = (this._daySeq || 0) + 1
  },

  // 登录态快照（P3.0）：只用于渲染 pending 分支里的错误/重试
  _syncLogin() {
    const snap = typeof app.loginSnapshot === 'function'
      ? app.loginSnapshot()
      : { state: 'ready' }
    if (this.data.loginState !== snap.state) this.setData({ loginState: snap.state })
    return snap
  },

  // 用户主动重试：成功后由 refresh 里注册的 whenReady 回调接手加载
  onLoginRetry() {
    if (typeof app.retryLogin !== 'function') return
    if (this.data.loginState !== 'loading') this.setData({ loginState: 'loading' })
    const p = app.retryLogin()
    if (p && typeof p.then === 'function') p.then(() => this._syncLogin())
  },

  // 防过期令牌控制器（首次使用时创建，避免模块级单例在页面间串号）
  _pvCtl() {
    if (!this._pv) this._pv = createController()
    return this._pv
  },

  // V1.1 · P1/P2：角色快照 + 视图模式的唯一刷新入口（首页/记录页同一口径）
  // 返回本次模式，供调用方决定加载自己那份数据还是伴侣数据。
  _syncViewer(g) {
    const ctl = this._pvCtl()
    const mode = pageViewMode(g, { companionViewEnabled: this.data.companionViewEnabled })
    const modeChanged = mode !== this.data.viewMode
    // 账号 / 角色 / coupleId 任一变化 → 立即作废在途请求并清空伴侣数据
    const identityChanged = ctl.watchIdentity(g)
    if (modeChanged || identityChanged) this._clearPv()
    this.setData(Object.assign(viewerFlags(g), { viewMode: mode }))
    return mode
  },

  // 清空伴侣数据 + 作废在途请求（失败、切模式、身份变化、页面离开都走它）
  _clearPv() {
    this._pvCtl().invalidate()
    this.setData({
      pvState: 'idle', pvCode: '', pvName: '', pvScore: null,
      pvSummary: '', pvWishes: [], pvDays: null,
      pvAnniText: '', pvWishSummary: '今天还没有心愿'
    })
  },

  // 首页经期摘要：只读调用现有 menstrual get（him 侧由服务端 sharePeriod 授权把关）。
  // 用单调序号丢弃过期响应：切页/隐藏后回来的旧结果不得覆盖当前页面。
  _loadPeriod() {
    const seq = (this._periodSeq = (this._periodSeq || 0) + 1)
    wx.cloud.callFunction({ name: 'menstrual', data: { action: 'get' } })
      .then(res => {
        if (seq !== this._periodSeq) return
        const r = (res && res.result) || {}
        const rec = r.ok && r.configured ? r.record : null
        const label = rec ? fmtPeriodLabel(rec.nextStart) : ''
        if (label !== this.data.homeNextLabel) this.setData({ homeNextLabel: label })
      })
      .catch(() => {
        // fail-closed：读不到就不显示（不猜日期、不展示旧值）
        if (seq === this._periodSeq && this.data.homeNextLabel) this.setData({ homeNextLabel: '' })
      })
  },

  // V1.1 今日决定：一次读回今天的两条决定（服务端按北京时间算「今天」）。
  // 双方都读同一份：her 与 him 看到的名字必然一致。
  // 失败处理分三种，绝不混同：
  //   · 关系不可用（NOT_ACTIVE/UNAUTHORIZED）→ blocked，卡片不渲染
  //   · 网络/服务异常 → error，卡片显示「暂时读不到」
  //   · 成功但当天没有决定 → ready + Decided=false，才显示「今天还没决定」
  _loadDayChoice() {
    const seq = (this._daySeq = (this._daySeq || 0) + 1)
    if (this.data.dayChoiceState === 'idle') this.setData({ dayChoiceState: 'loading' })
    wx.cloud.callFunction({ name: 'lifePlanner', data: { action: 'getDayChoice' } })
      .then(res => {
        if (seq !== this._daySeq) return
        const r = (res && res.result) || {}
        if (!r.ok) {
          if (r.code === 'NOT_ACTIVE' || r.code === 'UNAUTHORIZED') {
            this.setData({
              dayChoiceState: 'blocked',
              mealDecided: false, mealName: '', mealAt: 0,
              travelDecided: false, travelName: '', travelAt: 0
            })
            return
          }
          this.setData({ dayChoiceState: 'error' })
          return
        }
        const meal = r.meal || null
        const travel = r.travel || null
        this.setData({
          dayChoiceState: 'ready',
          mealDecided: !!meal,
          mealName: meal && typeof meal.name === 'string' ? meal.name : '',
          mealAt: meal && meal.decidedAt ? meal.decidedAt : 0,
          travelDecided: !!travel,
          travelName: travel && typeof travel.name === 'string' ? travel.name : '',
          travelAt: travel && travel.decidedAt ? travel.decidedAt : 0
        })
      })
      .catch(() => {
        if (seq !== this._daySeq) return
        // 保留已知结果（不把服务异常伪装成「还没决定」）；从未读成功过才落到 error
        if (this.data.dayChoiceState !== 'ready') this.setData({ dayChoiceState: 'error' })
      })
  },

  goFood() { wx.navigateTo({ url: '/pages/food/food' }) },
  goTravel() { wx.navigateTo({ url: '/pages/travel/travel' }) },

  // 记录方纪念日的独立令牌控制器：与伴侣视图互不影响（各自失效、各自丢弃旧响应）
  _anniCtl() {
    if (!this._anni) this._anni = createController()
    return this._anni
  },

  // 记录方首页纪念日：复用现有 getPartnerView（默认 view，read-only），
  // her 侧同样返回 anniversary / days —— 不新增 action、不改返回契约。
  // 取数仍必须走 utils/partner-view 的统一入口（白名单 + 防过期写回）。
  // 用同一份服务端值，是为了让 her 与 him 首页显示**完全相同**的日期与天数
  // （前端各算一遍会因时区/设备时间产生 1 天偏差）。
  _loadOwnAnni() {
    const ctl = this._anniCtl()
    const { token } = ctl.begin()
    requestPartnerView('', wx.cloud.callFunction).then(res => {
      if (!ctl.isCurrent(token)) return // 已刷新/已离开页面 → 丢弃
      // 关系不成立（NOT_ACTIVE 等）→ 不展示，绝不拿旧值凑
      if (!res.ok) {
        this.setData({ ownDays: null, ownAnniText: '', ownAnniState: 'error' })
        return
      }
      const d = res.data || {}
      this.setData({
        ownDays: typeof d.days === 'number' ? d.days : null,
        ownAnniText: fmtAnniText(d.anniversary),
        ownAnniState: 'ready'
      })
    })
  },

  // 陪伴方首页数据：只在 getPartnerView 返回 ok:true 时展示，失败不回退旧数据
  loadCompanion() {
    const ctl = this._pvCtl()
    const { token } = ctl.begin()
    // 请求一开始就清空：日期/身份切换或失败时不会闪现上一份内容
    this.setData({
      pvState: 'loading', pvCode: '', pvName: '', pvScore: null,
      pvSummary: '', pvWishes: [], pvDays: null,
      pvAnniText: '', pvWishSummary: '今天还没有心愿'
    })
    requestPartnerView('', wx.cloud.callFunction).then(res => {
      if (!ctl.isCurrent(token)) return // 已切换身份/模式或页面已离开 → 丢弃
      if (!res.ok) {
        const blocked = res.code === 'NOT_ACTIVE' || res.code === 'UNAUTHORIZED'
        this.setData({ pvState: blocked ? 'blocked' : 'error', pvCode: res.code })
        // 服务端已判定关系失效 → 顺手刷新登录态，下一次快照会落到 unbound
        if (blocked && typeof app.silentLogin === 'function') app.silentLogin()
        return
      }
      const d = res.data || {}
      // 服务端认定的角色必须与陪伴视图一致。本地 role 若因换绑/缓存过期而落后，
      // 服务端返回的会是记录方自己的数据 —— 那种情况一律按未授权处理，不展示。
      if (d.role !== 'him') {
        this.setData({ pvState: 'blocked', pvCode: 'ROLE_MISMATCH' })
        if (typeof app.silentLogin === 'function') app.silentLogin()
        return
      }
      const wishes = Array.isArray(d.wishes) ? d.wishes : []
      this.setData({
        pvName: d.myPartnerName || '',
        pvScore: typeof d.score === 'number' && d.score > 0 ? d.score : null,
        pvSummary: d.partnerSummary || '',
        pvWishes: wishes,
        pvWishSummary: wishSummaryOf(wishes),
        pvDays: typeof d.days === 'number' ? d.days : null,
        pvAnniText: fmtAnniText(d.anniversary),
        pvState: viewStateOf(d),
        pvCode: ''
      })
    })
  },

  reloadCompanion() { this.loadCompanion() },
  goOurs() { wx.switchTab({ url: '/pages/ours/ours' }) },
  // 心愿摘要点击：进「我们」页并自动展开心愿区（查看 / 标记已安排都在那里）
  openWishes() {
    app.globalData.wishOpenOnEnter = true
    wx.switchTab({ url: '/pages/ours/ours' })
  },

  refresh() {
    const date = fmtDate(new Date())
    this.setData({ date, todayStr: date, greeting: greet(), loading: true, partnerName: displayName(app.globalData.partnerName) })
    // 纪念日先回到 idle：刷新完成前不显示任何天数，也不显示假空态
    if (this.data.ownAnniState !== 'idle') {
      this.setData({ ownAnniState: 'idle', ownDays: null, ownAnniText: '' })
    }
    this._syncLogin()
    this._syncViewer(app.globalData)
    app.whenReady(g => {
      const openid = g.openid
      this._syncLogin()
      // 登录完成后重新取一次快照（openid/role/coupleId 此时才可信）
      const mode = this._syncViewer(g)
      // 经期摘要对两方都可能显示（him 侧由服务端 sharePeriod 授权判定）
      if (mode === VIEW_MODE_COMPANION || mode === VIEW_MODE_OWNER) this._loadPeriod()
      // 今日决定双方都要看（每次进前台都重读；跨天后自动落到新日期）
      if (mode === VIEW_MODE_COMPANION || mode === VIEW_MODE_OWNER) this._loadDayChoice()
      if (mode === VIEW_MODE_COMPANION) { this.loadCompanion(); return }
      // 陪伴方但绑定不可用 → 只显示安全状态，不加载任何私人记录
      if (mode !== VIEW_MODE_OWNER) return
      // 记录方：纪念日（与陪伴端同源，保证双方一致）
      this._loadOwnAnni()
      // 今日记录
      wx.cloud.callFunction({ name: 'dailyRecord', data: { action: 'get', date } })
        .then(res => {
          const record = res.result && res.result.record
          this._applyToday(record, openid, date)
        })
        .catch(() => {
          // fail-closed：云端不可达 → 空状态（H2），不清数据不造假
          this.setData({ hasRecord: false, loading: false })
        })
      // 最近 7 天（H4）：先展示身份一致的本地缓存，云端返回后覆盖
      this._applyWeekFromCache(openid, date)
      wx.cloud.callFunction({ name: 'profileStats', data: { action: 'week' } })
        .then(res => {
          const days = res.result && res.result.days
          if (days && days.length === 7) this._applyWeek(days)
        })
        .catch(() => { /* 保留缓存态，不报错 */ })
    })
  },

  // ---- H1/H2/H3 今日数据 ----
  _applyToday(record, openid, date) {
    if (!record) {
      // H2：无当天记录 → fail-closed 空状态（无假目标/假心情/假小结）
      this.setData({ hasRecord: false, loading: false, summarySkeleton: false })
      return
    }
    const goals = record.goals || []
    const todos = record.todos || []
    const mood = record.mood || {}
    const score = record.score || 0
    // M6：herSummary（记录方视角小结）；V1 summary 字段兼容回退
    const herSummary = record.herSummary || record.summary || ''
    this.setData({
      hasRecord: true,
      loading: false,
      goals,
      goalDone: goals.filter(g => g.done).length,
      goalTotal: goals.length,
      todoCount: todos.length,
      todoDone: todos.filter(t => t.done).length,
      score,
      scoreWord: score === 0 ? '今天给' + this.data.partnerName + '打几分呢' : (score <= 2 ? '有点不开心' : score === 3 ? '还行' : '很开心'),
      moodSrc: moodSrcMap[mood.type] || ICONS.mood_calm,
      weatherSrc: weatherSrcMap[mood.weather] || ICONS.weather_sunny,
      summary: herSummary,
      summaryAt: record.herSummaryAt ? '' : (record.summaryAt || ''),
      hasSummary: !!herSummary,
      // H3：有记录但小结未生成 → 手绘线稿骨架屏（不显示假 summary）
      summarySkeleton: !herSummary
    })
    // 写今日缓存标记（dr_{openid}_{date} 已有记录；身份已隔离）
    if (openid) wx.setStorageSync(`dr_${openid}_${date}`, { t: Date.now() })
  },

  // ---- H4 最近 7 天 ----
  // 缓存预展示：仅身份一致（openid 在 key 内天然隔离），云端返回后覆盖
  _applyWeekFromCache(openid, todayStr) {
    if (!openid) return
    const days = []
    for (let i = 6; i >= 0; i--) {
      const d = addDays(todayStr, -i)
      const cached = wx.getStorageSync(`dr_${openid}_${d}`)
      days.push({ date: d, hasRecord: !!cached })
    }
    this.setData({ weekDays: days })
  },
  // 云端结果覆盖（权威）：云端明确 hasRecord=false 的清空态也展示空
  _applyWeek(days) {
    this.setData({ weekDays: days })
  },

  // ---- 跳转 ----
  goRecord() { wx.switchTab({ url: '/pages/record/record' }) },
  goCalendar() { wx.switchTab({ url: '/pages/calendar/calendar' }) },
  fmtShort,
  // 三色便签循环（粉/黄/蓝，对应三个目标位置）
  goalColorForIndex(idx) {
    return ['pink', 'yellow', 'blue'][idx % 3] || 'purple'
  }
})
