const app = getApp()
const CONFIG = require('../../config')
const ICONS = require('../../assets/svg-icons')
const { isDuplicate } = require('../../utils/wish-dedup')
const { fromDraft, fromRecordWishes } = require('../../utils/record-restore')
const { addWish, removeWish } = require('../../utils/wish-input')
const { displayName } = require('../../utils/partner-name')
// V1.1 · P0/P1/P2：角色与绑定状态一律走 utils/viewer-role.js，页面内不做角色比较
const { viewerFlags, pageViewMode, VIEW_MODE_OWNER, VIEW_MODE_COMPANION } = require('../../utils/viewer-role')
// V1.1 · P2：伴侣数据的唯一入口（白名单 + 统一错误码 + 防过期令牌）
const { createController, requestPartnerView, requestCoupleTodo, viewStateOf } = require('../../utils/partner-view')
// V1.1 · P3.1：日期级分享（严格布尔 / 预览 / 统一文案）
const shareApi = require('../../utils/record-share')

// 订阅消息模板 ID：统一收口在 config.js（PRD §4.1 B3）
const SUB_TPL_ID = CONFIG.SUB_TPL_REMIND

// requestId：前端生成 UUID 风格串（PRD §2.3 幂等契约）
function genRequestId() {
  return 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10)
}

function fmtDate(d) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function addDays(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return fmtDate(new Date(y, m - 1, d + delta))
}

// 一起做的事（双方共同待办）：默认展示 5 条，多了可展开
const TODO_SHOW = 5
// 服务端 coupleTodo list 单次最多返回 100 条（couple-todo.js 的 TODO_LIMIT）。
// 这是**显示上限**，不是总数上限 —— 只有服务端没截断时才敢说「全部」。
const TODO_LIMIT_CLIENT = 100

// 北京时间自然日（UTC+8 固定偏移）。
// 记录页的「今天」必须和服务端同一口径：设备时区一旦不是 +08:00，
// 用设备本地时间算 today 就会和 couple_todos.createdDate 对不上，
// 「这一天新增的」会整体错位一天。
function beijingTodayStr(now) {
  const ms = now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : Date.now())
  const t = new Date(ms + 8 * 3600 * 1000)
  const p = n => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`
}

function defaultGoals() {
  return [
    { text: '', done: false, reminderOn: false, reminderTime: '21:00' },
    { text: '', done: false, reminderOn: false, reminderTime: '21:00' },
    { text: '', done: false, reminderOn: false, reminderTime: '21:00' }
  ]
}
function emptySegments() {
  return { life: '', work: '', growth: '' }
}

Page({
  data: {
    date: '',
    todayStr: '',
    colors: ['#FFC9D4', '#FFE9A8', '#BFE3F2'],
    goals: defaultGoals(),
    goalDoneCount: 0,
    todos: [],
    todoDraft: '',
    segments: emptySegments(),
    segCounts: { life: 0, work: 0, growth: 0 },
    mood: { type: 'calm', weather: 'sunny' },
    score: 0,
    eatInput: '',
    doInput: '',
    eats: [],
    dos: [],
    revision: 0,
    saving: false,
    savedTip: '',
    loading: true,
    readProgress: 0,
    wishEatSrc: ICONS.wish_eat,
    wishDoSrc: ICONS.wish_do,
    pencilSrc: ICONS.pencil,
    // 我给 TA 的称呼（评分标题用；空 = 通用「TA」）
    partnerName: 'TA',
    // V1.1 · P0：查看者快照（只接线，不改变任何可见行为与读写行为）
    // 默认值即「未加载」态：角色未确认前一律 false，避免误入伴侣视图。
    viewerState: 'loading', roleReady: false, isHer: false, isHim: false,
    bound: false, canEnterPartnerView: false,
    // V1.1 · P1/P2/P2.1：视图模式。pending = 身份未确认（不渲染任何一方页面）；
    // owner = 记录方表单；companion = 陪伴方按日期查看；companion-blocked = 陪伴方但绑定不可用。
    // 默认值必须是 pending：首屏在角色确认前不得出现个人记录编辑表单。
    viewMode: 'pending', companionViewEnabled: true,
    // V1.1 · P2：伴侣共享数据（只存 getPartnerView 白名单字段），失败/切换即清空
    pvState: 'idle', pvCode: '', pvName: '', pvScore: null, pvSummary: '', pvWishes: [], pvDayWishes: [],
    // V1.1 · P3.1：她主动共享的这一天（心情 / 天气 / 三段日记）—— 只有服务端 shared 非空才非空
    pvShared: null, pvMood: '', pvWeather: '',
    // V1.1 · P3.0：登录态（失败/超时 → 明确提示 + 重试，不回落记录方表单）
    loginState: 'loading',
    // V1.1 · P3.1：她这一天的分享状态
    // shareRev = 服务端权威版本号（0 = 还没有分享文档）。写入时必须原样回传，服务端据此做 CAS。
    shareState: 'idle', shareEnabled: false, shareCanShare: false, shareBusy: false,
    shareRev: 0, shareNote: '',
    // 有未保存内容（草稿）时，分享区必须明确区分「已保存/未保存」
    dirty: false,
    // V1.1：一起做的事（双方共同待办 couple_todos）—— her/him 都看得到、都能改。
    // 与上方「小事 · 提醒事项」（daily_records.todos，只有她能写）完全分开。
    // todoScope：day = 这一天新增的；open = 跨日期还没做完的
    todoScope: 'day',
    todoState: 'idle',      // idle / loading / ready / error / blocked（关系不可用）
    todoItems: [],          // 服务端原样列表（含 createdDate / doneDate）
    shownTodos: [],         // 按 scope 过滤 + 折叠后的展示项
    todoInput: '',
    todoBusy: false,
    todoTotal: 0,
    todoTruncated: false,
    todoExpanded: false,
    todoHasMore: false,
    todoHeadLabel: '',
    todoMoreLabel: '',
    todoLimitHint: '',
    todoEmptyText: '这一天还没有一起要做的事',
    todoDayHint: ''
  },

  // 防过期令牌控制器（页面级实例，避免跨页面串号）
  _pvCtl() {
    if (!this._pv) this._pv = createController()
    return this._pv
  },

  // 分享请求的独立令牌（与伴侣视图令牌互不干扰）
  _shCtl() {
    if (!this._sh) this._sh = createController()
    return this._sh
  },

  // 登录态快照（P3.0）：只用于渲染 pending 分支里的错误/重试，不参与授权判断
  _syncLogin() {
    const snap = typeof app.loginSnapshot === 'function'
      ? app.loginSnapshot()
      : { state: 'ready', canRetry: false }
    if (this.data.loginState !== snap.state) this.setData({ loginState: snap.state })
    return snap
  },

  // P3.3：关系层面的错误（已解绑 / 换绑 / 身份过期）→ 重新向服务端确认身份，
  // 并按新快照重算视图模式；不再是记录方就清掉分享区，避免展示过期状态。
  _refreshAfterRelationChange() {
    const done = () => {
      const mode = this._syncViewer(app.globalData)
      if (mode !== VIEW_MODE_OWNER) this._clearShare()
    }
    const p = typeof app.silentLogin === 'function' ? app.silentLogin() : null
    if (p && typeof p.then === 'function') p.then(done).catch(done)
    else done()
  },

  // 用户主动重试登录：成功后由 onLoad 注册的 whenReady 回调接手加载
  onLoginRetry() {
    if (typeof app.retryLogin !== 'function') return
    if (this.data.loginState !== 'loading') this.setData({ loginState: 'loading' })
    const p = app.retryLogin()
    if (p && typeof p.then === 'function') p.then(() => this._syncLogin())
  },

  // ============ V1.1 · P3.1 分享状态（她侧） ============
  // 每次更换日期都重新向服务端确认：分享状态不缓存、不沿用上一天
  _clearShare() {
    this._shCtl().invalidate()
    this.setData({
      shareState: 'idle', shareEnabled: false, shareCanShare: false, shareBusy: false,
      shareRev: 0, shareNote: ''
    })
  },

  _loadShare(date) {
    if (this.data.viewMode !== VIEW_MODE_OWNER) return
    const ctl = this._shCtl()
    const { token } = ctl.begin()
    this.setData({
      shareState: 'loading', shareNote: '',
      // 版本号随内容一起清空：读取中/读取失败时不允许拿旧版本去写
      shareRev: 0
    })
    shareApi.requestShareStatus(date, wx.cloud.callFunction).then(res => {
      // 日期已切换 / 页面已离开 / 身份已变 → 丢弃这次返回
      if (!ctl.isCurrent(token)) return
      if (this.data.date !== date) return
      if (!res.ok) {
        this.setData({
          shareState: 'error', shareEnabled: false, shareCanShare: false,
          shareRev: 0, shareNote: shareApi.hintOf(res.code)
        })
        // 关系已失效/已换绑 → 重新确认身份，不能继续显示过期状态
        if (shareApi.needsIdentityRefresh(res.code)) this._refreshAfterRelationChange()
        return
      }
      // 新客户端 + 旧云函数：旧服务端不回 rev，也不认识 expectedRev。
      // 此时若继续允许开关，写入就会退化成「无条件覆盖」——必须 fail-closed。
      if (!res.casSupported) {
        this.setData({
          shareState: 'error', shareEnabled: false, shareCanShare: false,
          shareRev: 0, shareNote: '当前服务端版本暂不支持安全开关分享，请更新小程序后再试'
        })
        return
      }
      this.setData({
        shareState: 'ready',
        // 严格布尔：服务端没明确说 true 就是没共享
        shareEnabled: res.enabled,
        shareCanShare: res.canShare,
        shareRev: res.rev,
        shareNote: ''
      })
    })
  },

  // 分享状态读取失败时的重试（不影响记录本身的编辑）
  reloadShare() { this._loadShare(this.data.date) },

  onShareToggle() {
    if (this.data.shareState !== 'ready' || this.data.shareBusy) return
    if (this.data.shareEnabled) this._confirmDisableShare()
    else this._confirmEnableShare()
  },

  // 开启前必须让她看到「会分享什么」——预览只用**已保存**的内容
  _confirmEnableShare() {
    if (!this.data.shareCanShare) {
      wx.showToast({ title: shareApi.hintOf('NO_RECORD'), icon: 'none', duration: 2500 })
      return
    }
    const preview = shareApi.buildSharePreview(this._savedSnapshot)
    const dirtyNote = this._dirty
      ? '\n\n注意：你还有未保存的修改，这次不会分享未保存的部分。'
      : ''
    wx.showModal({
      title: '分享这一天？',
      content: shareApi.SHARE_NOTICE + '\n\n即将分享（已保存的内容）：\n' + preview.text + dirtyNote,
      confirmText: '开启分享',
      cancelText: '再想想',
      success: m => { if (m.confirm) this._setShare(true) }
    })
  },

  _confirmDisableShare() {
    wx.showModal({
      title: '关闭这一天的分享？',
      content: '关闭后，TA 将看不到这一天的心情、天气，以及生活、工作、成长三段日记。',
      confirmText: '关闭分享',
      cancelText: '保持开启',
      success: m => { if (m.confirm) this._setShare(false) }
    })
  },

  // 写分享状态：只有服务端 ok:true 才更新 UI，绝不假装成功。
  // P3.3-R1：必须带上刚读到的服务端版本号（CAS）；版本不符时服务端零写入，
  // 这里也不做任何乐观更新，而是立刻回读权威状态 —— 不保留旧的本地显示。
  _setShare(enabled) {
    const date = this.data.date
    const expectedRev = this.data.shareRev
    const ctl = this._shCtl()
    const { token } = ctl.begin()
    this.setData({ shareBusy: true })
    shareApi.requestShareSet(date, enabled, expectedRev, wx.cloud.callFunction).then(res => {
      if (!ctl.isCurrent(token)) return
      this.setData({ shareBusy: false })
      if (this.data.date !== date) return
      if (!res.ok) {
        wx.showToast({ title: shareApi.hintOf(res.code), icon: 'none', duration: 2500 })
        // 换绑/解绑期间写入被服务端判为过期 → 同步身份，且不把开关显示成已成功
        if (shareApi.needsIdentityRefresh(res.code)) {
          this._clearShare()
          this._refreshAfterRelationChange()
          return
        }
        // 版本冲突 → 服务端零写入；必须重新拉一次权威状态，而不是留着旧显示
        if (res.code === shareApi.CODE.CONFLICT) this._loadShare(date)
        return
      }
      this.setData({
        shareEnabled: res.enabled,
        shareRev: res.rev,
        shareState: 'ready',
        shareNote: ''
      })
      wx.showToast({ title: res.enabled ? '已开启分享' : '已关闭分享', icon: 'success' })
    })
  },

  // V1.1 · P1/P2：角色快照 + 视图模式的唯一刷新入口（首页/记录页同一口径）
  _syncViewer(g) {
    const ctl = this._pvCtl()
    const mode = pageViewMode(g, { companionViewEnabled: this.data.companionViewEnabled })
    const modeChanged = mode !== this.data.viewMode
    const identityChanged = ctl.watchIdentity(g)
    if (modeChanged || identityChanged) this._clearPv()
    this.setData(Object.assign(viewerFlags(g), { viewMode: mode }))
    return mode
  },

  // 清空伴侣数据 + 作废在途请求
  _clearPv() {
    this._pvCtl().invalidate()
    this.setData({
      pvState: 'idle', pvCode: '', pvName: '', pvScore: null,
      pvSummary: '', pvWishes: [], pvDayWishes: [],
      // P3：共享内容一并清空 —— 撤销/换绑/失败后不留残影
      pvShared: null, pvMood: '', pvWeather: '',
      // 共同待办同样属于「当前这段关系」：身份/关系一变就必须清空，
      // 不能让上一段关系的清单在新关系里继续挂着。
      todoState: 'idle', todoItems: [], shownTodos: [], todoTotal: 0,
      todoHeadLabel: '', todoMoreLabel: '', todoLimitHint: '', todoDayHint: ''
    })
  },

  // 陪伴方按日期取数：只在服务端 ok:true 时展示，失败不回退旧数据
  _loadPv(date) {
    const ctl = this._pvCtl()
    const { token } = ctl.begin()
    // 共同待办与「共享内容」是两条独立链路：他看得到这一天的共享内容与否，
    // 都不影响共同待办的可读写（这是双方对等的功能，不是她的隐私内容）。
    this.loadTodos()
    // 请求开始即清空：日期连点/切换身份时不会闪现上一份内容
    this.setData({
      pvState: 'loading', pvCode: '', pvName: '', pvScore: null,
      pvSummary: '', pvWishes: [], pvDayWishes: [],
      pvShared: null, pvMood: '', pvWeather: ''
    })
    requestPartnerView(date, wx.cloud.callFunction).then(res => {
      if (!ctl.isCurrent(token)) return // 已换日期/身份/页面 → 丢弃这次返回
      if (!res.ok) {
        const blocked = res.code === 'NOT_ACTIVE' || res.code === 'UNAUTHORIZED'
        this.setData({ pvState: blocked ? 'blocked' : 'error', pvCode: res.code })
        if (blocked && typeof app.silentLogin === 'function') app.silentLogin()
        return
      }
      const d = res.data || {}
      // 服务端角色必须与陪伴视图一致；不一致（换绑竞态 / 本地 role 过期）一律不展示
      if (d.role !== 'him') {
        this.setData({ pvState: 'blocked', pvCode: 'ROLE_MISMATCH' })
        if (typeof app.silentLogin === 'function') app.silentLogin()
        return
      }
      // shared 只可能来自服务端「这一天对她/他/这段关系都成立」的授权，
      // 前端不再做任何二次判断，也不缓存（下次进入必须重新核验）
      const shared = d.shared || null
      this.setData({
        pvName: d.myPartnerName || '',
        pvScore: typeof d.score === 'number' && d.score > 0 ? d.score : null,
        pvSummary: d.partnerSummary || '',
        pvWishes: Array.isArray(d.wishes) ? d.wishes : [],
        // 「这天的愿望」只认服务端按创建日筛出来的那一份
        pvDayWishes: Array.isArray(d.dayWishes) ? d.dayWishes : [],
        pvShared: shared,
        pvMood: shared ? (shareApi.moodLabel(shared.mood.type) || '未选') : '',
        pvWeather: shared ? (shareApi.weatherLabel(shared.mood.weather) || '未选') : '',
        pvState: viewStateOf(d),
        pvCode: ''
      })
    })
  },

  // 陪伴方日期切换（只改查看日期，不动个人记录草稿）
  pvPrev() { this._pvGo(addDays(this.data.date, -1)) },
  pvNext() {
    if (this.data.date >= this.data.todayStr) {
      wx.showToast({ title: '今天就是最新的一天', icon: 'none' })
      return
    }
    this._pvGo(addDays(this.data.date, 1))
  },
  pvToday() { this._pvGo(this.data.todayStr) },
  onPvDate(e) { this._pvGo(e.detail.value) },
  _pvGo(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return
    if (date > this.data.todayStr) return
    this.setData({ date })
    this._loadPv(date)
  },
  reloadPv() { this._loadPv(this.data.date) },
  goOurs() { wx.switchTab({ url: '/pages/ours/ours' }) },

  onLoad() {
    // 「今天」与服务端同一口径（北京时间），否则设备时区不同会让「这一天新增的」归组错位
    this.setData({ date: beijingTodayStr(), todayStr: beijingTodayStr() })
    this._syncLogin()
    this._syncViewer(app.globalData)
    this._openid = null
    this._dirty = false
    this._saving = false
    this._hasShownOnce = false
    this._savedSnapshot = null
    app.whenReady(g => {
      this._openid = g.openid
      this._syncLogin()
      this.setData({ partnerName: displayName(app.globalData.partnerName) })
      const mode = this._syncViewer(g)
      // 关系 id 缓存：断网时用它判断草稿里的心愿能不能回填（唯一用途）
      this._coupleId = wx.getStorageSync(`couple_${this._openid}`) || null
      if (mode === VIEW_MODE_COMPANION) { this._loadPv(this.data.date); return }
      // 陪伴方但绑定不可用 → 只给安全状态，绝不加载个人记录
      if (mode !== VIEW_MODE_OWNER) return
      this.loadDay(this.data.date)
    })
  },

  onShow() {
    this._syncLogin()
    if (app.globalData.partnerName !== undefined) {
      this.setData({ partnerName: displayName(app.globalData.partnerName) })
    }
    // 每次回到本页都刷新一次角色/绑定快照：解绑、换绑、登录态变化后不沿用旧判定
    const mode = this._syncViewer(app.globalData)
    if (mode === VIEW_MODE_COMPANION) {
      // 首次进入由 onLoad 的 whenReady 负责加载，避免同一屏发两次请求
      if (this._hasShownOnce) this._loadPv(this.data.date)
      this._hasShownOnce = true
      return
    }
    if (mode !== VIEW_MODE_OWNER) {
      this._hasShownOnce = true
      return
    }
    if (!this._hasShownOnce) {
      this._hasShownOnce = true
      return
    }
    if (!this._dirty && !this._saving && this._openid) this.loadDay(this.data.date)
    // 有未保存草稿时不动表单，但仍刷新这一天的分享状态（分享的是已保存内容）
    else if (this._openid) {
      this._loadShare(this.data.date)
      // 共同待办与个人草稿互不干扰：草稿状态下也要拿到对方刚改的清单
      this.loadTodos()
    }
  },

  onHide() {
    // 页面离开即作废在途请求：回来之前到达的旧结果不得写回
    if (this._pv) this._pv.invalidate()
    if (this._sh) this._sh.invalidate()
    // R1：有未保存内容 → 提示（草稿已实时写入，不自动写库）
    if (this._dirty && !this._saving) {
      wx.showToast({ title: '还有未保存的内容，已存草稿', icon: 'none' })
    }
  },
  onUnload() { this.onHide() },

  // ============ 加载某天（R6 历史翻页共用） ============
  loadDay(date) {
    // 陪伴方视图不读、不写个人记录：任何路径都不允许落到个人记录表单
    if (this.data.viewMode !== VIEW_MODE_OWNER) return
    this.setData({ date, loading: true, savedTip: '' })
    this._dirty = false
    // 共同待办按日期归组，换日期就要重取（它不受个人草稿影响，随时可刷新）
    this.loadTodos()
    // 分享状态与日期严格绑定：先清空上一天的状态，再按新日期向服务端确认
    this._clearShare()
    this._loadShare(date)
    wx.cloud.callFunction({ name: 'dailyRecord', data: { action: 'get', date } })
      .then(res => {
        const result = res.result || {}
        const r = result.record
        this._cloudRevision = r ? (r.revision || 0) : 0
        // 分享预览的基准是**已保存**的云端内容（不含当前草稿/未保存修改）
        this._savedSnapshot = r ? { mood: r.mood, segments: r.segments } : null
        // 服务端判定的当前生效关系（唯一可信来源）。缓存一份，仅供断网时给草稿兜底。
        this._coupleId = typeof result.coupleId === 'string' && result.coupleId ? result.coupleId : null
        if (this._openid) wx.setStorageSync(`couple_${this._openid}`, this._coupleId || '')
        // 离线草稿优先（R1b）：有草稿 = 有未保存内容
        const draft = wx.getStorageSync(`draft_${this._openid}_${date}`)
        if (draft && draft.t) {
          // 草稿结构恢复（eats/dos 数组；兼容旧草稿仅 wishes）——与云端 record 分开
          const skip = !this._wishBackfillAllowed(draft.cid)
          this.setData(Object.assign(this._fromDraft(draft, { skipWishes: skip }), { loading: false, dirty: true }))
          this._dirty = true
          wx.showToast({ title: '发现未保存的内容，已恢复', icon: 'none' })
        } else {
          const base = r || { goals: defaultGoals(), todos: [], segments: emptySegments(), mood: { type: 'calm', weather: 'sunny' }, score: 0, readProgress: 0 }
          const skip = !this._wishBackfillAllowed(r && r.coupleId)
          this.setData(Object.assign(this._fromRecord(base, { skipWishes: skip }), { loading: false, dirty: false }))
        }
      })
      .catch(() => {
        // fail-closed：云端不可达 → 尝试草稿，否则空状态（PRD §2.3）
        const draft = wx.getStorageSync(`draft_${this._openid}_${date}`)
        if (draft && draft.t) {
          // 断网时用上次缓存的关系 id 判定；缓存缺失 → 不回填心愿（fail-closed）
          const skip = !this._wishBackfillAllowed(draft.cid)
          this.setData(Object.assign(this._fromDraft(draft, { skipWishes: skip }), { loading: false, dirty: true }))
          this._dirty = true
        } else {
          this.setData(Object.assign(this._fromRecord({}, { skipWishes: true }), { loading: false, dirty: false }))
        }
        wx.showToast({ title: '网络似乎不太稳定，正在展示本地内容', icon: 'none' })
      })
  },

  // 心愿回填闸门（P0 隐私隔离）：只有当「来源（记录/草稿）明确属于当前这段关系」时，
  // 才把心愿回填到表单。否则宁可空着 —— 用户手动输入才是明确意图。
  // 服务端另有同一条闸门（dailyRecord.save 的 wishSyncSkipped），客户端这道只是
  // 让人看不到、也带不走旧关系的内容。
  _wishBackfillAllowed(sourceCoupleId) {
    const cur = this._coupleId
    if (typeof cur !== 'string' || !cur) return false
    if (typeof sourceCoupleId !== 'string' || !sourceCoupleId) return false
    return sourceCoupleId === cur
  },

  // 云端 record → 页面 data（record.wishes 拆成 eats/dos）
  // opts.skipWishes：来源不属于当前关系 → 不回填心愿（其余字段照常）
  _fromRecord(r, opts) {
    const goals = (r.goals && r.goals.length) ? r.goals : defaultGoals()
    const segments = r.segments || emptySegments()
    const wishSrc = (opts && opts.skipWishes) ? { eats: [], dos: [] } : fromRecordWishes(r)
    const { eats, dos } = wishSrc
    return {
      goals,
      goalDoneCount: goals.filter(g => g.done).length,
      todos: r.todos || [],
      segments,
      segCounts: {
        life: (segments.life || '').length,
        work: (segments.work || '').length,
        growth: (segments.growth || '').length
      },
      mood: r.mood || { type: 'calm', weather: 'sunny' },
      score: r.score || 0,
      eats, dos,
      readProgress: r.readProgress || 0,
      revision: this._cloudRevision || 0
    }
  },

  // 本地草稿 → 页面 data（eats/dos 数组直取；兼容旧草稿仅 wishes）
  _fromDraft(draft, opts) {
    const d = draft || {}
    const goals = (d.goals && d.goals.length) ? d.goals : defaultGoals()
    const segments = d.segments || emptySegments()
    const wishSrc = (opts && opts.skipWishes) ? { eats: [], dos: [] } : fromDraft(d)
    const { eats, dos } = wishSrc
    return {
      goals,
      goalDoneCount: goals.filter(g => g.done).length,
      todos: d.todos || [],
      segments,
      segCounts: {
        life: (segments.life || '').length,
        work: (segments.work || '').length,
        growth: (segments.growth || '').length
      },
      mood: d.mood || { type: 'calm', weather: 'sunny' },
      score: d.score || 0,
      eats, dos,
      readProgress: d.readProgress || 0,
      revision: this._cloudRevision || 0
    }
  },

  // ============ 离线草稿（R1b：编辑即写，云端保存成功清除） ============
  _persistDraft() {
    if (!this._openid) return
    const d = this.data
    wx.setStorageSync(`draft_${this._openid}_${d.date}`, {
      t: Date.now(),
      // 写入草稿时所属的关系（P0）：换绑后旧草稿不得把旧心愿带回新关系
      cid: this._coupleId || '',
      goals: d.goals,
      todos: d.todos,
      segments: d.segments,
      mood: d.mood,
      score: d.score,
      eats: d.eats,
      dos: d.dos,
      readProgress: d.readProgress
    })
    this._dirty = true
    if (!this.data.dirty) this.setData({ dirty: true })
  },
  _clearDraft() {
    if (!this._openid) return
    wx.removeStorageSync(`draft_${this._openid}_${this.data.date}`)
    this._dirty = false
    if (this.data.dirty) this.setData({ dirty: false })
  },
  _markChange() {
    this._persistDraft()
  },

  // ============ 今日目标 ============
  updateGoals(arr) {
    this.setData({ goals: arr, goalDoneCount: arr.filter(g => g.done).length })
    this._markChange()
  },
  onGoalInput(e) {
    const i = e.detail.index
    const goals = this.data.goals.slice()
    goals[i].text = e.detail.text
    this.updateGoals(goals)
  },
  onGoalToggleDone(e) {
    const i = e.detail.index
    const goals = this.data.goals.slice()
    goals[i].done = !goals[i].done
    this.updateGoals(goals)
  },
  onGoalToggleReminder(e) {
    const i = e.detail.index
    const goals = this.data.goals.slice()
    goals[i].reminderOn = !goals[i].reminderOn
    this.updateGoals(goals)
    if (goals[i].reminderOn && SUB_TPL_ID !== 'TEMPLATE_ID_HERE') {
      wx.requestSubscribeMessage({ tmplIds: [SUB_TPL_ID], fail: () => {} })
    }
  },
  onGoalChangeTime(e) {
    const i = e.detail.index
    const goals = this.data.goals.slice()
    goals[i].reminderTime = e.detail.time
    this.updateGoals(goals)
  },
  // ============ 小事 todo ============
  onTodoDraft(e) { this.setData({ todoDraft: e.detail.value }) },
  addTodo() {
    const t = this.data.todoDraft.trim()
    if (!t) return
    this.setData({ todos: [...this.data.todos, { text: t, done: false }], todoDraft: '' })
    this._markChange()
  },
  toggleTodo(e) {
    const i = e.detail.index
    const todos = this.data.todos.slice()
    todos[i].done = !todos[i].done
    this.setData({ todos })
    this._markChange()
  },
  deleteTodo(e) {
    const i = e.detail.index
    const todos = this.data.todos.slice()
    todos.splice(i, 1)
    this.setData({ todos })
    this._markChange()
  },

  // ============ 一起做的事（双方共同待办，V1.1） ============
  //
  // 边界：
  //   · 个人小事 = daily_records.todos（按 _openid + date 存整天快照，只有她能写）
  //   · 共同待办 = couple_todos（按 coupleId 归属，her/him 权限完全相同）
  //   本页两者并排展示，但走的是两条完全不同的数据链路，互不影响。
  //
  // 日期归属：每条都由服务端给出 createdDate / doneDate（北京时间自然日），
  // 客户端只做字符串比较，不自己推时区。
  //
  // 读取失败绝不退化成「今天还没有一起要做的事」——那会让人以为数据丢了。
  loadTodos() {
    const mode = this.data.viewMode
    if (mode !== VIEW_MODE_OWNER && mode !== VIEW_MODE_COMPANION) {
      this.setData({ todoState: 'idle', todoItems: [], shownTodos: [], todoTotal: 0 })
      return
    }
    const seq = (this._tSeq = (this._tSeq || 0) + 1)
    // 已有结果时不闪回 loading（刷新期间保持上次内容）
    if (this.data.todoState !== 'ready') this.setData({ todoState: 'loading' })
    // 统一入口：页面不直接调 wx.cloud.callFunction（见 utils/partner-view.js）
    requestCoupleTodo('list', null, wx.cloud.callFunction).then(r => {
      if (seq !== this._tSeq) return
      if (!r.ok) {
        // blocked = 关系不可用（解绑/换绑/未生效）：与「读取失败」分开，
        // 前者不该给重试按钮，后者要给。
        this.setData({
          todoState: r.code === 'NOT_ACTIVE' ? 'blocked' : 'error',
          todoItems: [], shownTodos: [], todoTotal: 0
        })
        return
      }
      this._applyTodos(r.items, r.truncated)
    })
  },

  reloadSharedTodos() { this.loadTodos() },

  // 收到服务端结果 → 存原样列表，再按当前 scope 渲染
  _applyTodos(items, truncated) {
    const list = (items || []).filter(t => t && t._id && t.text)
    this.setData({
      todoItems: list,
      todoTruncated: typeof truncated === 'boolean' ? truncated : !!this.data.todoTruncated,
      todoState: 'ready'
    })
    this._renderTodos()
  },

  // 纯渲染：过滤（这一天 / 未完成）+ 折叠 + 文案，不发请求
  _renderTodos() {
    const d = this.data
    const base = d.todoScope === 'open'
      ? d.todoItems.filter(t => !t.done)
      : d.todoItems.filter(t => t.createdDate === d.date)
    const shown = d.todoExpanded ? base : base.slice(0, TODO_SHOW)
    const isOpen = d.todoScope === 'open'
    const dayWord = d.date === d.todayStr ? '今天' : String(d.date || '').slice(5)
    this.setData({
      shownTodos: shown.map(t => Object.assign({}, t, {
        createdShort: String(t.createdDate || '').slice(5),
        // 完成日期只在真的完成过时才有（doneAt=0 → doneDate=''）
        meta: String(t.createdDate || '').slice(5) + ' 加的' +
          (t.done && t.doneDate ? ' · ' + String(t.doneDate).slice(5) + ' 完成' : '')
      })),
      todoTotal: base.length,
      todoHasMore: base.length > TODO_SHOW,
      todoExpanded: base.length > TODO_SHOW ? d.todoExpanded : false,
      todoHeadLabel: d.todoTruncated
        // 被 100 条上限截断时，手里的数字只是「已取到的」——不能说成这一天的全部
        ? `已显示 ${base.length} 件`
        : (isOpen ? `待完成 ${base.length} 件` : `${dayWord} · ${base.length} 件`),
      todoMoreLabel: d.todoTruncated ? `展开这 ${base.length} 条 ›` : `查看全部 ${base.length} 条 ›`,
      todoLimitHint: d.todoTruncated ? `只显示最近 ${TODO_LIMIT_CLIENT} 条，更早的可能看不到` : '',
      todoEmptyText: isOpen ? '没有待完成的事，都做完啦' : '这一天还没有一起要做的事',
      // 看历史日期时必须说清楚新条目记到哪天，不能让人以为写进了那一天
      todoDayHint: (!isOpen && d.date !== d.todayStr)
        ? `新增的共同待办会记在今天（${String(d.todayStr || '').slice(5)}），不会写进这一天`
        : ''
    })
  },

  switchTodoScope(e) {
    const scope = e.currentTarget.dataset.scope === 'open' ? 'open' : 'day'
    if (scope === this.data.todoScope) return
    this.setData({ todoScope: scope, todoExpanded: false })
    this._renderTodos()
  },

  toggleSharedExpand() {
    this.setData({ todoExpanded: !this.data.todoExpanded })
    this._renderTodos()
  },

  onSharedTodoInput(e) { this.setData({ todoInput: e.detail.value }) },

  addSharedTodo() {
    const text = String(this.data.todoInput || '').trim()
    if (!text || this.data.todoBusy) return
    if (this.data.todoState !== 'ready') return
    this.setData({ todoBusy: true })
    requestCoupleTodo('add', { text }, wx.cloud.callFunction).then(r => {
      this.setData({ todoBusy: false })
      if (!r.ok) {
        wx.showToast({ title: r.msg || '添加失败', icon: 'none' })
        return
      }
      this.setData({ todoInput: '' })
      // 服务端按「此刻」落库：正在翻历史日期时，条目不会出现在当前这一天，
      // 必须当场说明，否则用户会以为写进了历史日期。
      if (this.data.todoScope === 'day' && this.data.date !== this.data.todayStr) {
        wx.showToast({ title: '已记在今天，切回今天就能看到', icon: 'none', duration: 2400 })
      }
      this.loadTodos()
    })
  },

  // 完成 / 恢复：把目标状态交给服务端（幂等，不在本地取反）
  toggleSharedTodo(e) {
    const { id, done } = e.currentTarget.dataset
    const wasDone = done === 1 || done === '1' || done === true
    if (!id || this.data.todoBusy) return
    this.setData({ todoBusy: true })
    requestCoupleTodo('toggle', { id, done: !wasDone }, wx.cloud.callFunction).then(r => {
      this.setData({ todoBusy: false })
      if (!r.ok) {
        wx.showToast({ title: r.msg || '操作失败', icon: 'none' })
        return
      }
      this.loadTodos()
    })
  },

  // 删除前轻量确认（避免误触；不做二次输入那套）
  removeSharedTodo(e) {
    const { id, text } = e.currentTarget.dataset
    if (!id || this.data.todoBusy) return
    wx.showModal({
      title: '删除这件事？',
      content: text || '',
      confirmText: '删除',
      cancelText: '再想想',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ todoBusy: true })
        requestCoupleTodo('remove', { id }, wx.cloud.callFunction).then(r2 => {
          this.setData({ todoBusy: false })
          if (!r2.ok) {
            wx.showToast({ title: r2.msg || '删除失败', icon: 'none' })
            return
          }
          this.loadTodos()
        })
      }
    })
  },

  // ============ 三段日记（R5 字数计数） ============
  onSegInput(e) {
    const seg = e.currentTarget.dataset.seg
    const v = e.detail.value
    this.setData({ [`segments.${seg}`]: v, [`segCounts.${seg}`]: v.length })
    this._markChange()
  },

  // ============ 心情天气 / 今日得分 ============
  onMoodChange(e) { this.setData({ mood: e.detail.value }); this._markChange() },
  onScoreChange(e) { this.setData({ score: e.detail.value }); this._markChange() },

  // ============ 心愿（R4：按钮/回车双入口，可靠添加 + 同类型 trim 全等去重） ============
  onEatDraft(e) { this.setData({ eatInput: e.detail.value }) },
  onDoDraft(e) { this.setData({ doInput: e.detail.value }) },
  addEatByButton() {
    const { list, added, reason } = addWish(this.data.eats, this.data.eatInput)
    if (reason === 'empty') return
    if (reason === 'dup') { wx.showToast({ title: '已经加过啦', icon: 'none' }); return }
    this.setData({ eats: list, eatInput: '' })
    this._markChange()
  },
  addDoByButton() {
    const { list, added, reason } = addWish(this.data.dos, this.data.doInput)
    if (reason === 'empty') return
    if (reason === 'dup') { wx.showToast({ title: '已经加过啦', icon: 'none' }); return }
    this.setData({ dos: list, doInput: '' })
    this._markChange()
  },
  deleteEat(e) {
    this.setData({ eats: removeWish(this.data.eats, e.currentTarget.dataset.i) })
    this._markChange()
  },
  deleteDo(e) {
    this.setData({ dos: removeWish(this.data.dos, e.currentTarget.dataset.i) })
    this._markChange()
  },

  // ============ 显式保存（R1：requestId + revision 幂等契约） ============
  onSaveTap() { this.save(true) },

  save(showTip) {
    // 陪伴方视图没有保存入口；这里再兜一道，防止误调
    if (this.data.viewMode !== VIEW_MODE_OWNER) return
    if (this._saving) return
    this._saving = true
    this.setData({ saving: true })
    const d = this.data
    const requestId = genRequestId()
    // 保存成功后用于刷新「分享预览」基准：预览必须来自已保存内容
    const savedDate = d.date
    const savedMood = d.mood
    const savedSegments = d.segments
    const wishes = [
      ...d.eats.map(t => ({ type: 'eat', text: t })),
      ...d.dos.map(t => ({ type: 'do', text: t }))
    ]
    wx.cloud.callFunction({
      name: 'dailyRecord',
      data: {
        action: 'save',
        date: d.date,
        requestId,
        revision: d.revision,
        goals: d.goals,
        todos: d.todos,
        segments: d.segments,
        mood: d.mood,
        wishes,
        score: d.score,
        readProgress: d.readProgress || 0
      }
    }).then(res => {
      const r = res.result || {}
      this.setData({ saving: false })
      if (r.ok) {
        // 服务端在每次 save 都会回传它判定的当前关系，顺手刷新本地缓存
        if (typeof r.coupleId === 'string' && r.coupleId) {
          this._coupleId = r.coupleId
          if (this._openid) wx.setStorageSync(`couple_${this._openid}`, r.coupleId)
        }
        this.setData({ revision: r.revision, savedTip: '已保存' })
        this._clearDraft()
        // 刚保存的内容才是「可被分享的内容」：刷新预览基准，并按当前日期刷新分享状态
        // （新建记录后 canShare 才会变成 true）
        if (this.data.date === savedDate) {
          this._savedSnapshot = { mood: savedMood, segments: savedSegments }
          this._loadShare(savedDate)
        }
        setTimeout(() => this.setData({ savedTip: '' }), 2000)
        if (showTip) wx.showToast({ title: '已保存', icon: 'success' })
        // 服务端拒绝了心愿同步 → 必须说清楚，否则用户会以为 TA 已经能看到这条心愿。
        // 两种原因都不得无痕：
        //   record-not-in-couple → 这一天的记录不属于当前绑定关系
        //   record-date-invalid  → 记录日期不合法（心愿没有可信的归属日期，一律不写）
        if (r.wishSyncSkipped === 'record-not-in-couple') {
          wx.showToast({ title: '这天的心愿不会同步给 TA', icon: 'none', duration: 2500 })
        } else if (r.wishSyncSkipped) {
          wx.showToast({ title: '心愿没能同步，请稍后再试', icon: 'none', duration: 2500 })
        }
      } else if (r.code === 'REV_CONFLICT') {
        // 版本冲突：不覆盖，提示刷新（PRD §2.3）
        wx.showModal({
          title: '内容已被更新',
          content: '这份记录在别处被修改过。重新加载最新内容？你未保存的改动仍保留在草稿中。',
          confirmText: '重新加载',
          cancelText: '暂不',
          success: m => { if (m.confirm) this.loadDay(this.data.date) }
        })
      } else {
        if (showTip) wx.showToast({ title: '保存失败，请稍后重试', icon: 'none' })
      }
    }).catch(() => {
      // 网络失败：草稿已在本地，内容不丢（R1b）
      this.setData({ saving: false })
      if (showTip) wx.showToast({ title: '网络似乎不太稳定，内容已存草稿', icon: 'none' })
    }).finally(() => {
      this._saving = false
    })
  },

  // ============ 历史翻页（R6） ============
  prevDay() { this.loadDay(addDays(this.data.date, -1)) },
  nextDay() {
    const today = beijingTodayStr()
    if (this.data.date >= today) {
      wx.showToast({ title: '今天就是最新的一天', icon: 'none' })
      return
    }
    this.loadDay(addDays(this.data.date, 1))
  },
  backToday() { this.loadDay(beijingTodayStr()) }
})
