const app = getApp()
const CONFIG = require('../../config')
const { displayName } = require('../../utils/partner-name')

// ============================================================
// 「我们」页 · M5 情侣互动（PRD v0.8）
// 层级：纪念日 → 今日得分 → 心愿 → 留言 → 经期预计
// 未绑定 → 绑定操作区；superseded/NOT_ACTIVE → 清缓存回未绑定态
//
// 2026-10-17 · 微信消息提醒（一次性订阅消息）
//   · 前端只负责「在用户点击时申请授权」，并把授权结果交给云函数记账；
//   · 是否真的能发、发给谁、发不发得出去，全部由云函数判定（见 notify.js）；
//   · 模板没配 / 用户拒绝 / 发送失败 → UI 如实显示"暂不可用/没开启"，
//     绝不出现"已开启"的假状态；站内提示（未读悄悄话 / 有新心愿）始终可用。
// ============================================================

// partner view 缓存 key（身份隔离）
function pvKey(openid) { return `pv_${openid}` }

// 「已看到的心愿时间点」本地游标（站内新心愿提示用；只影响提示，不影响数据）
function wishSeenKey(openid) { return `wishSeen_${openid || 'anon'}` }

// requestId（悄悄话发送幂等：响应丢失后重试复用同一个 id，服务端只落一条）
function genRequestId() {
  return 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10)
}

// 服务端 getPartnerView 每次最多返回最近 50 条悄悄话（MSG_LIMIT）。
// 客户端据此如实提示「只保留最近 N 条」，不声称能翻到更早（翻页需新增服务端参数）。
const MSG_LIMIT_CLIENT = 50

// 纪念日摘要（紧凑入口用）：日期与天数都来自服务端，前端不重复推算
function anniLineOf(anniversary, days) {
  if (typeof anniversary !== 'string' || !anniversary) return ''
  return typeof days === 'number' ? `在一起 ${anniversary} · ${days} 天` : `在一起 ${anniversary}`
}

// 心愿摘要（紧凑入口用）：只给数量，详情展开后再看
function wishSummaryOf(list) {
  const arr = Array.isArray(list) ? list : []
  if (arr.length === 0) return '暂无'
  const eat = arr.filter(w => w && w.type === 'eat').length
  const want = arr.length - eat
  if (eat > 0 && want > 0) return `想吃 ${eat} · 想做 ${want}`
  if (eat > 0) return `想吃 ${eat}`
  return `想做 ${want}`
}

// 微信订阅消息：心愿与悄悄话共用**同一个模板**（chat 通道）。
// 一次授权 = 一条消息额度，两种事件从此共用这份额度，不再各占一个模板、
// 也不会因为传两个模板 ID 而在同一次弹窗里被重复计数。
//
// 注意（2026-10-17 复核）：份额度是「通道」层面的记账，两个事件都能用；
// 但**心愿能不能真的发出去**还多一道服务端闸门（模板用途未确认时默认不发，
// 见 cloudfunctions/*/notify.js 的 isWishNotifyAllowed）。因此文案里是否提到
// 「加心愿」必须跟着服务端返回的 wishNotify 走，不能写死。
const TPL_CHAT = CONFIG.SUB_TPL_CHAT
const hasAnyTpl = CONFIG.isTplReady(TPL_CHAT)

// 订阅状态的如实描述（纯函数，模块级）。
// 绝不出现「已永久开启」——微信没有「查询剩余可发送次数」的接口，
// 这里的次数只是服务端记账的估算值，真实闸门始终在微信侧。
//
// wishNotify 来自服务端（notify.isWishNotifyAllowed）：心愿是否能走微信提醒
// 取决于「聊天消息通知」模板的用途是否被确认覆盖心愿。不能确定时这里就**不承诺**
// 心愿会被微信提醒 —— 承诺了却发不出去，比不承诺更糟。
function notifyHintFor(ready, quota, wishNotify) {
  if (!ready) {
    // 模板没配好属于「必须说的错误状态」，不能当成普通说明省掉
    return '提醒模板还没配置，暂时收不到微信提醒，站内提示照常。'
  }
  const q = quota || { chat: 0 }
  const total = q.chat || 0
  const what = wishNotify ? 'TA 给你发悄悄话、加心愿时' : 'TA 给你发悄悄话时'
  if (total <= 0) return `还没开启。开启后 ${what}，微信会提醒你一次。`
  // 只留「这是服务端记账」这一条必要限定；「一次性 / 用完要再开启」
  // 统一交给卡片底部那一行辅助文案，避免同一件事在卡片里说两遍。
  return `已记录 ${total} 次（服务端记账）。`
}

// ------------------------------------------------------------
// 订阅结果的判定与话术统一放在 utils/subscribe-feedback.js
// （「我们」页与日历页共用同一份，避免两边对 ban / filter 的处理漂移）。
// 这里保留短别名，让页面代码读起来仍然直白。
// ------------------------------------------------------------
const { subResultOf, subFeedback, subFailFeedback } = require('../../utils/subscribe-feedback')



Page({
  data: {
    role: 'her',
    wishes: [],
    messages: [],
    msgInput: '',
    // 悄悄话滚动区：只有「进入页面 / 自己刚发完」才滚到底，
    // 其它刷新（标记心愿、保存纪念日）不得把正在翻历史的用户拽回底部。
    msgScrollTop: 0,
    msgMaxed: false,
    // 服务端每次最多返回最近 50 条（MSG_LIMIT）；数量文案据此如实表达，不谎称全部历史
    msgLimit: MSG_LIMIT_CLIENT,
    // 心愿 / 称呼默认收起（紧凑设置区），点标题展开
    wishOpen: false,
    wishSummary: '暂无',
    nameOpen: false,
    notBound: false,
    loading: true,
    // P3 纪念日
    anniversary: '',
    days: null,
    anniversaryPicker: '',
    anniOpen: false,
    todayStr: '',
    // 紧凑入口的一行摘要：在一起 + 日期 + 天数（天数来自服务端，前端不自己算）
    anniLine: '',
    // 我给 TA 的称呼（自定义，空 = 通用「TA」）
    myPartnerName: 'TA',
    partnerNameInput: '',
    // M6 A2：伙伴版小结
    partnerSummary: '',
    partnerSummaryAt: 0,
    // 站内未读提示（通知发不出去时的降级方案）
    unreadMsgs: 0,
    newWishes: 0,
    // 微信消息提醒
    notifyReady: hasAnyTpl,
    wishNotify: false, // 服务端开关：心愿能否走微信提醒（模板用途闸门）
    notifyHint: notifyHintFor(hasAnyTpl, { chat: 0 }, false),
    // 配额按通道记账：chat（心愿/悄悄话共用）、period（经期提醒，在日历页显示）
    myQuota: { chat: 0, period: 0 },
    partnerQuota: { chat: 0, period: 0 },
    myQuotaTotal: 0,
    // 绑定区状态
    bindCode: '',
    inputCode: '',
    pending: null,
    statusLoading: true,
    acting: false
  },

  onShow() {
    const d = new Date()
    const p = n => String(n).padStart(2, '0')
    if (!this.data.todayStr) this.setData({ todayStr: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` })
    this.load()
  },

  toggleAnni() { this.setData({ anniOpen: !this.data.anniOpen }) },
  toggleWish() { this.setData({ wishOpen: !this.data.wishOpen }) },
  toggleName() { this.setData({ nameOpen: !this.data.nameOpen }) },
  goFood() { wx.navigateTo({ url: '/pages/food/food' }) },
  goTravel() { wx.navigateTo({ url: '/pages/travel/travel' }) },

  load() {
    app.globalData.bindCode = null
    // 进入 / 重进页面：这一次刷新允许把悄悄话滚到底部
    this._wantBottom = true
    // 从首页「心愿摘要」跳进来 → 直接展开心愿区（一次性标记，读完即清）
    if (app.globalData.wishOpenOnEnter) {
      app.globalData.wishOpenOnEnter = false
      this.setData({ wishOpen: true })
    }
    // 每次页面重新出现都重新捕获「进入时」的未读基线
    this._unreadOnEnter = null
    this._wishSeenAt = null
    this.setData({ loading: true, bindCode: '', pending: null })
    app.whenReady(g => {
      // 先查绑定状态：未绑定 → 绑定操作区；已绑定 → 「我们」内容
      wx.cloud.callFunction({ name: 'bindCouple', data: { action: 'status' } })
        .then(res => {
          const s = res.result || {}
          if (s.ok && s.bound) {
            this.setData({ notBound: false, loading: true })
            this.loadPartner(g.openid)
          } else {
            this.setData({
              notBound: true,
              loading: false,
              bindCode: s.bindCode || '',
              pending: s.pending,
              role: s.role || 'her',
              statusLoading: false
            })
          }
        })
        .catch(err => {
          console.error('LOAD_RELATION_STATUS_FAILED', err)
          this.setData({ notBound: true, loading: false, statusLoading: false })
          wx.showToast({ title: '加载失败，请稍后再试', icon: 'none' })
        })
    })
  },

  loadPartner(openid) {
    wx.cloud.callFunction({ name: 'getPartnerView' }).then(res => {
      const r = res.result || {}
      if (r.code === 'NOT_ACTIVE' || r.code === 'UNAUTHORIZED') {
        // P5：旧 partner 失权 → 清 partner 缓存 → 回未绑定态（不删本人云端数据）
        if (openid) wx.removeStorageSync(pvKey(openid))
        app.silentLogin && app.silentLogin()
        this.setData({ notBound: true, loading: false, statusLoading: false })
        return
      }
      if (!r.ok) { this.setData({ notBound: true, loading: false, statusLoading: false }); return }
      // 缓存 partner view（身份隔离 key）
      if (openid) wx.setStorageSync(pvKey(openid), { t: Date.now(), role: r.role })
      const msgs = r.messages || []
      const wishes = r.wishes || []
      const myQuota = r.myQuota || { chat: 0, period: 0 }
      const partnerQuota = r.partnerQuota || { chat: 0, period: 0 }
      // 未读悄悄话：取「本次进入时的服务端真值」并固定在本次会话里显示；
      // 页面会自动 markRead，下次进来真值自然归零，不会出现永久红点。
      if (this._unreadOnEnter == null) this._unreadOnEnter = r.unreadMsgs || 0
      // 只有「进入页面」或「自己刚发完」才滚到底；标记心愿 / 保存纪念日触发的刷新
      // 不得把正在上滑看历史的人拽回底部。
      const wantBottom = this._wantBottom !== false
      this._wantBottom = false
      this.setData({
        role: r.role,
        wishes,
        wishSummary: wishSummaryOf(wishes),
        messages: msgs,
        msgMaxed: msgs.length >= MSG_LIMIT_CLIENT,
        // scroll-top 每次自增：内容变化后才会真正触发滚动到底部
        msgScrollTop: wantBottom
          ? (this._msgTop = (this._msgTop || 0) + 100000)
          : this.data.msgScrollTop,
        anniversary: r.anniversary || '',
        days: typeof r.days === 'number' ? r.days : null,
        anniLine: anniLineOf(r.anniversary, r.days),
        anniversaryPicker: r.anniversary || '',
        myPartnerName: displayName(r.myPartnerName),
        partnerNameInput: r.myPartnerName || '',
        partnerSummary: r.partnerSummary || '',
        partnerSummaryAt: r.partnerSummaryAt || 0,
        unreadMsgs: this._unreadOnEnter,
        newWishes: this.countNewWishes(wishes, openid, r.role),
        myQuota,
        partnerQuota,
        myQuotaTotal: (myQuota.chat || 0),
        wishNotify: r.wishNotify === true,
        notifyHint: notifyHintFor(this.data.notifyReady, myQuota, r.wishNotify === true),
        notBound: false,
        loading: false
      })
      // 打开页面自动标记「对方发给我」的留言已读（幂等，只写第一次）。
      // 两个角色都要做：之前只给 her 做，导致 him 侧收到的悄悄话永远停在未读，
      // 顶部「N 条新悄悄话」会一直挂着 —— 未读状态必须由「谁在读」决定，不是角色。
      this.markRead(msgs)
    }).catch(err => {
      console.error('LOAD_PARTNER_VIEW_FAILED', err)
      this.setData({ notBound: true, loading: false, statusLoading: false })
      wx.showToast({ title: '加载失败，请稍后再试', icon: 'none' })
    })
  },

  // 批量标记对方留言已读（readMsg 幂等）
  markRead(msgs) {
    for (const m of msgs) {
      if (!m.mine && !m.readAt && m._id) {
        wx.cloud.callFunction({ name: 'getPartnerView', data: { action: 'readMsg', msgId: m._id } }).catch(() => {})
      }
    }
  },

  // ---- 站内未读提示（微信订阅消息发不出去时的降级方案，永远可用） ----
  //
  // 「新心愿」只对接收方有意义：对方新增心愿 → 你需要知道。自己看自己的心愿不算「新」。
  // 游标存在本机（wishSeen_<openid>），只影响提示，不影响任何数据；
  // 每次进入页面读到即推进游标，所以提示不会永久挂着。
  countNewWishes(wishes, openid, role) {
    const list = wishes || []
    const seen = Number(wx.getStorageSync(wishSeenKey(openid)) || 0)
    let newest = seen
    for (const w of list) {
      const t = w.createdAt || 0
      if (t > newest) newest = t
    }
    if (newest > seen) {
      try { wx.setStorageSync(wishSeenKey(openid), newest) } catch (e) { /* 游标失败不影响展示 */ }
    }
    if (role !== 'him') return 0
    return list.filter(w => (w.createdAt || 0) > seen).length
  },

  // 订阅状态的如实描述（委托到模块级纯函数，保持单一文案来源）
  buildNotifyHint(myQuota) {
    return notifyHintFor(this.data.notifyReady, myQuota, this.data.wishNotify)
  },

  // 把纯数据的提示真正弹出来（页面里只有这一处 UI 出口，文案统一来自模块级判定）
  showFeedback(fb) {
    const f = fb || subFeedback('unknown')
    if (f.type === 'modal') {
      wx.showModal({ title: f.title, content: f.content, showCancel: false })
      return
    }
    wx.showToast({ title: f.title, icon: 'none' })
  },

  // 「微信消息提醒」授权入口。
  // 只能在用户点击时申请（wx.requestSubscribeMessage 的硬性要求），
  // 且模板必须已在 config.js 配好，否则不调用 —— 空 tmplIds 会直接报错。
  //
  // 一次性订阅的准确说法：一次 accept = 一条消息额度。
  // 即使用户勾了「总是保持以上选择」，微信也只是**不再弹窗**，额度依然是一次性的；
  // 所以这里每次都按「+1 次」记账，绝不把它当成永久发送权限。
  notifySub() {
    if (this._subbing) return
    // 心愿与悄悄话共用一个模板：只申请这一个 ID，一次授权就够两种事件各发一条。
    const tpls = []
    if (CONFIG.isTplReady(TPL_CHAT)) tpls.push(TPL_CHAT)
    if (!tpls.length) {
      wx.showModal({
        title: '微信消息提醒暂不可用',
        content: '还需要先在微信公众平台申请「聊天消息通知」订阅模板，把模板 ID 填进 config.js 并配置云函数环境变量。配置好之前，页面上的站内提示照常可用。',
        showCancel: false
      })
      return
    }
    this._subbing = true
    wx.requestSubscribeMessage({
      tmplIds: tpls,
      success: (res) => {
        // 逐种结果分别处理：accept / reject / ban / filter 含义不同，不能一律「已取消」
        const state = subResultOf(res, TPL_CHAT)
        if (state !== 'accept') {
          this._subbing = false
          this.showFeedback(subFeedback(state))
          return
        }
        // 把「同意了哪一类」交给服务端记账（身份由 WXContext 决定，前端传不了别人的 openid）
        wx.cloud.callFunction({ name: 'getPartnerView', data: { action: 'sub', granted: ['chat'] } })
          .then(r => {
            this._subbing = false
            const rr = (r && r.result) || {}
            // 服务端没记账就不能说「已开启」：例如云函数还是旧版本（不认识 sub action）。
            // 微信侧授权是真的，但服务端额度为 0 时不会有消息发出，不能给用户假承诺。
            if (!rr.ok) {
              wx.showToast({ title: '已同意，但记录未成功，请稍后再试', icon: 'none' })
              return
            }
            const q = rr.quota || { chat: 0, period: 0 }
            this.setData({
              myQuota: q,
              myQuotaTotal: (q.chat || 0),
              notifyHint: this.buildNotifyHint(q)
            })
            this.showFeedback(subFeedback('accept'))
          })
          .catch(() => {
            this._subbing = false
            wx.showToast({ title: '已同意，但记录失败，不影响接收提醒', icon: 'none' })
          })
      },
      fail: (e) => {
        this._subbing = false
        this.showFeedback(subFailFeedback((e && e.errMsg) || ''))
      }
    })
  },

  // ---- 给 TA 的称呼（自定义，本人设置；女生叫男生「小胖」、男生叫女生「宝宝」互不覆盖）----
  onPartnerNameInput(e) { this.setData({ partnerNameInput: e.detail.value }) },
  savePartnerName() {
    const name = (this.data.partnerNameInput || '').trim()
    if (name.length > 12) { wx.showToast({ title: '称呼最多 12 个字', icon: 'none' }); return }
    wx.cloud.callFunction({ name: 'getPartnerView', data: { action: 'setPartnerName', name } })
      .then(res => {
        const r = res.result || {}
        if (r.ok) {
          const finalName = r.partnerName || ''
          this.setData({ myPartnerName: displayName(finalName), partnerNameInput: finalName })
          app.globalData.partnerName = finalName
          wx.showToast({ title: finalName ? '已保存' : '已恢复默认「TA」', icon: 'none' })
        } else {
          wx.showToast({ title: r.msg || '保存失败', icon: 'none' })
        }
      })
      .catch(() => wx.showToast({ title: '网络异常，请重试', icon: 'none' }))
  },
  clearPartnerName() {
    this.setData({ partnerNameInput: '' })
    this.savePartnerName()
  },

  // ---- 心愿 ----
  markWish(e) {
    const id = e.currentTarget.dataset.id
    wx.cloud.callFunction({ name: 'getPartnerView', data: { action: 'mark', wishId: id } })
      .then(() => this.loadPartner(app.globalData.openid))
      .catch(err => {
        console.error('MARK_WISH_FAILED', err)
        wx.showToast({ title: '保存失败，请稍后重试', icon: 'none' })
      })
  },

  // ---- 留言 ----
  onMsgInput(e) { this.setData({ msgInput: e.detail.value }) },
  goRecord() { wx.switchTab({ url: '/pages/record/record' }) },
  // 发送幂等：同一条内容在「发送中 / 失败重试」期间复用同一个 requestId，
  // 服务端按 (coupleId, fromOpenid, requestId) 判重 → 响应丢失后重试也不会落两条、
  // 也不会重复通知对方。只有内容被改写或发送成功后才换新的 requestId。
  sendMsg() {
    const t = this.data.msgInput.trim()
    if (!t || this._sending) return
    if (!this._msgRid || this._msgRidText !== t) {
      this._msgRid = genRequestId()
      this._msgRidText = t
    }
    const requestId = this._msgRid
    this._sending = true
    wx.cloud.callFunction({ name: 'getPartnerView', data: { action: 'msg', text: t, requestId } })
      .then(() => {
        this._sending = false
        this._msgRid = null
        this._msgRidText = ''
        this.setData({ msgInput: '' })
        // 刚发完 → 一定要看到自己这条
        this._wantBottom = true
        this.loadPartner(app.globalData.openid)
      })
      .catch(() => {
        this._sending = false
        wx.showToast({ title: '发送失败，请重试', icon: 'none' })
      })
  },

  // ---- 纪念日 ----
  onAnniversary(e) { this.setData({ anniversaryPicker: e.detail.value }) },
  saveAnniversary() {
    const val = this.data.anniversaryPicker
    if (!val) { wx.showToast({ title: '请选择纪念日', icon: 'none' }); return }
    wx.cloud.callFunction({ name: 'getPartnerView', data: { action: 'setAnniversary', anniversary: val } })
      .then(res => {
        const r = res.result || {}
        if (r.ok) {
          wx.showToast({ title: '纪念日已保存' })
          this.loadPartner(app.globalData.openid)
        } else {
          wx.showToast({ title: r.msg || '保存失败', icon: 'none' })
        }
      })
      .catch(() => wx.showToast({ title: '网络异常，请重试', icon: 'none' }))
  },

  // ---- 绑定操作（未绑定态，M1 保留） ----
  onInput(e) { this.setData({ inputCode: e.detail.value }) },
  copyBindCode() {
    const code = this.data.bindCode
    if (!code || code === '—') { wx.showToast({ title: '请先生成绑定码', icon: 'none' }); return }
    wx.setClipboardData({ data: code, success: () => wx.showToast({ title: '已复制，去发给 TA 吧', icon: 'none' }) })
  },
  bind() {
    const code = this.data.inputCode.trim()
    if (!code || this.data.acting) return
    this.setData({ acting: true })
    wx.cloud.callFunction({ name: 'bindCouple', data: { action: 'claim', code } })
      .then(res => {
        const r = res.result || {}
        this.setData({ inputCode: '', acting: false })
        if (r.ok) wx.showToast({ title: '已提交，等对方确认', icon: 'none' })
        else wx.showToast({ title: r.msg || '绑定失败', icon: 'none' })
        this.load()
      })
      .catch(() => { this.setData({ acting: false }); wx.showToast({ title: '网络异常，请重试', icon: 'none' }) })
  },
  genCode() {
    if (this.data.acting) return
    this.setData({ acting: true })
    wx.cloud.callFunction({ name: 'bindCouple', data: { action: 'generate' } })
      .then(res => {
        const r = res.result || {}
        this.setData({ acting: false })
        if (r.ok) { this.setData({ bindCode: r.bindCode }); wx.showToast({ title: '新绑定码已生成', icon: 'none' }) }
        else wx.showToast({ title: r.msg || '生成失败', icon: 'none' })
        this.load()
      })
      .catch(() => { this.setData({ acting: false }); wx.showToast({ title: '网络异常，请重试', icon: 'none' }) })
  },
  confirmPending(e) {
    const requestId = this.data.pending && this.data.pending.requestId
    const accept = e.currentTarget.dataset.accept === '1'
    if (!requestId || this.data.acting) return
    this.setData({ acting: true })
    wx.cloud.callFunction({ name: 'bindCouple', data: { action: 'confirm', requestId, accept } })
      .then(res => {
        const r = res.result || {}
        this.setData({ acting: false })
        if (r.ok) { wx.showToast({ title: accept ? '绑定成功' : '已拒绝', icon: accept ? 'success' : 'none' }); app.silentLogin() }
        else wx.showToast({ title: r.msg || '操作失败', icon: 'none' })
        setTimeout(() => this.load(), 300)
      })
      .catch(() => { this.setData({ acting: false }); wx.showToast({ title: '网络异常，请重试', icon: 'none' }) })
  },
  cancelPending() {
    const requestId = this.data.pending && this.data.pending.requestId
    if (!requestId || this.data.acting) return
    this.setData({ acting: true })
    wx.cloud.callFunction({ name: 'bindCouple', data: { action: 'cancel', requestId } })
      .then(res => {
        const r = res.result || {}
        if (r.ok) {
          app.globalData.bindCode = null
          this.setData({ acting: false, bindCode: '', pending: null })
          wx.showToast({ title: '已取消', icon: 'none' })
        } else {
          this.setData({ acting: false })
          wx.showToast({ title: r.msg || '取消失败', icon: 'none' })
        }
        this.load()
      })
      .catch(() => {
        this.setData({ acting: false })
        wx.showToast({ title: '网络异常，请重试', icon: 'none' })
        this.load()
      })
  }
})
