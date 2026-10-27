const app = getApp()
const CONFIG = require('../../config')
// 订阅结果的判定与话术：与「我们」页共用同一份（见 utils/subscribe-feedback.js）
const { subResultOf, subFeedback, subFailFeedback } = require('../../utils/subscribe-feedback')

// ============================================================
// 日历页 · M4 经期记录简化版（PRD v0.8）
// 保存一律走 wx.cloud.callFunction('menstrual')，禁止前端直写数据库
//
// 2026-10-17 · 经期提醒（一次性订阅消息，模板 472）
//   · 前端只做「用户点击时申请授权」+ 把结果交给云函数记账；
//   · 什么时候发、发给谁、发不发得出去，全部由服务端判定（menstrual/remind.js）；
//   · 一次性订阅：一次同意 ≈ 一条消息，用完要再点一次，绝不显示「已永久开启」。
// ============================================================

// 经期提醒模板（cloudfunctions 侧的 TPL_PERIOD 与它必须一致）
const TPL_PERIOD = CONFIG.SUB_TPL_PERIOD

function pad(n) { return String(n).padStart(2, '0') }
function buildGrid(year, month) {
  const startWeek = new Date(year, month - 1, 1).getDay()
  const daysInMonth = new Date(year, month, 0).getDate()
  const cells = []
  for (let i = 0; i < startWeek; i++) cells.push({ blank: true })
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, date: `${year}-${pad(month)}-${pad(d)}`, blank: false })
  }
  return cells
}
const todayStr = (() => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
})()

// requestId（幂等契约）
function genRequestId() {
  return 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10)
}

// 输入归一化：只保留数字，最多 3 位。
// 一律以**字符串**保存输入值（不再让 data 里同时存在 number 与 string 两种类型），
// 只有在保存时才转成 number —— 类型混杂是「输入框显示与校验各说各话」的常见来源。
function digitsOnly(raw, maxLen) {
  return String(raw == null ? '' : raw).replace(/[^\d]/g, '').slice(0, maxLen || 3)
}

// 严格整数解析：空串 / 含非数字 / 超出位数 → null（不静默当 0）
function parseIntStrict(raw, maxDigits) {
  const s = digitsOnly(raw, maxDigits || 3)
  if (!s) return null
  const n = Number(s)
  return Number.isInteger(n) ? n : null
}

const CYCLE_MIN = 15
const CYCLE_MAX = 60
const PERIOD_MIN = 1
const PERIOD_MAX = 10

// 提醒状态的如实描述（纯函数）。
// 一次性订阅的真相：一次同意 ≈ 一条消息；微信没有「查剩余次数」的接口，
// 提醒状态的如实描述（只留「必须说的」，解释性长文交给卡片底部那一行）。
// 次数只是服务端记账（微信没有「查剩余次数」的接口），因此绝不说成「还能收 N 次」。
// 她这边：未开启 / 已记录 N 次已经在标题右侧的状态标签上，提示行不再重复一遍。
// 他这边：真正的门槛是「她打开了『也提醒 TA』」，这条前置条件必须留着，且要短。
function buildRemindHint(ready, quota, isHer) {
  if (!ready) {
    return '提醒模板还没配置，暂时收不到微信提醒；日历和记录不受影响。'
  }
  const n = Math.max(0, Number(quota) || 0)
  if (isHer) return ''
  if (n <= 0) return '先由 TA 打开下面的「也提醒 TA」，再由你自己订阅一次。'
  return '需要 TA 打开「也提醒 TA」之后，这条提醒才会发给你。'
}

Page({
  data: {
    year: 0, month: 0,
    weeks: ['日', '一', '二', '三', '四', '五', '六'],
    cells: [],
    configured: false,
    isHer: true,
    open: false,
    // M4 输入（一律字符串，见 digitsOnly 注释）
    lastStart: '',
    cycle: '28',
    periodLen: '5', // 经期持续天数（M4 增量，默认 5）
    nextStart: '',
    nextLabel: '',
    revision: 0,
    saving: false,
    todayStr,
    // 经期提醒（一次性订阅）
    remindReady: CONFIG.isTplReady(TPL_PERIOD),
    remindQuota: 0,
    // 先给一版「未开启」文案，避免首屏出现空提示；云端 get 回来后立刻覆盖成真实状态
    remindHint: buildRemindHint(CONFIG.isTplReady(TPL_PERIOD), 0, true),
    partnerRemind: false,
    // 经期共享授权（默认关）：她决定是否允许 TA 查看经期数据
    sharePeriod: false,
    shareDenied: false
  },

  onLoad() {
    const d = new Date()
    this.setData({ year: d.getFullYear(), month: d.getMonth() + 1 })
    this.setData({ isHer: (app.globalData.role || 'her') === 'her' })
    // 表单是否被用户改动过（脏标记）。**不是**渲染状态，故意不放进 data：
    // 它的唯一职责是拦住后到达的云端 get 响应覆盖用户正在输入的内容。
    this._formDirty = false
    // 首屏数据由 onShow 的 loadMarks() 负责（onLoad 之后必触发 onShow）；
    // 这里不再重复请求，避免同一份数据两次异步回写、放大竞态窗口。
  },

  onShow() {
    if (app.globalData.role) this.setData({ isHer: app.globalData.role === 'her' })
    this.loadMarks()
  },

  // 日历标记（month）+ 设置区数据（get）
  loadMarks() {
    const { year, month } = this.data
    wx.cloud.callFunction({ name: 'menstrual', data: { action: 'month', year, month } })
      .then(res => {
        const r = res.result || {}
        const map = {}
        ;(r.days || []).forEach(d => { if (d.type || d.read) map[d.date] = { type: d.type, read: d.read } })
        const cells = buildGrid(year, month).map(c =>
          c.blank ? c : { ...c, isToday: c.date === todayStr, mark: map[c.date] || null }
        )
        this.setData({ cells, configured: !!r.configured, shareDenied: !!r.shareDenied })
      })
      .catch(err => console.error('loadMarks month', err))

    wx.cloud.callFunction({ name: 'menstrual', data: { action: 'get' } })
      .then(res => {
        const r = res.result || {}
        if (!r.ok) return
        // 提醒状态和「有没有记录过经期」无关：没记录的人也要能看到自己还剩几次授权
        if (r.remind) this.applyRemind(r.remind)
        if (r.shareDenied) {
          this.setData({ shareDenied: true })
          return
        }
        this.setData({ shareDenied: false })
        if (!r.configured || !r.record) return
        const rec = r.record
        // 只更新「不依赖用户输入」的派生字段：预计日期 / 乐观锁 revision。
        // 表单字段（lastStart / cycle / periodLen）只在用户没有改动过时才回填 ——
        // 这是本次 Bug 的关键：onLoad/onShow/切月都会发 get，慢网络下响应可能在
        // 用户已经开始输入之后才到达，之前会把刚输入的数字直接覆盖回旧值。
        const patch = {
          nextStart: rec.nextStart,
          nextLabel: this.fmtNextLabel(rec.nextStart),
          revision: rec.revision || 0
        }
        if (!this._formDirty) {
          patch.lastStart = rec.lastStart || ''
          patch.cycle = String(rec.cycle || '')
          patch.periodLen = String(rec.periodLen || '')
        }
        this.setData(patch)
      })
      .catch(err => console.error('loadMarks get', err))
  },

  // 提醒状态的显示口径（纯函数，模块级 buildRemindHint 的桥）
  applyRemind(remind) {
    const rm = remind || {}
    const quota = Math.max(0, Number(rm.quota) || 0)
    this.setData({
      remindQuota: quota,
      partnerRemind: rm.partnerRemind === true,
      sharePeriod: rm.sharePeriod === true,
      remindHint: buildRemindHint(this.data.remindReady, quota, this.data.isHer)
    })
  },

  // 统一出口：把 utils/subscribe-feedback 产出的纯数据提示弹出来
  showFeedback(fb) {
    const f = fb || subFeedback('unknown')
    if (f.type === 'modal') {
      wx.showModal({ title: f.title, content: f.content, showCancel: false })
      return
    }
    wx.showToast({ title: f.title, icon: 'none' })
  },

  // 「订阅经期提醒」：只能在用户点击时申请（wx.requestSubscribeMessage 的硬性要求）。
  // 模板没配好就不调用 —— 空 tmplIds 会直接报错。
  subscribeRemind() {
    if (this._subbingRemind) return
    if (!CONFIG.isTplReady(TPL_PERIOD)) {
      wx.showModal({
        title: '经期提醒暂不可用',
        content: '需要先在微信公众平台申请「经期提醒」订阅模板，把模板 ID 填进 config.js 并配置云函数环境变量。配置好之前，日历和记录都照常可用。',
        showCancel: false
      })
      return
    }
    this._subbingRemind = true
    wx.requestSubscribeMessage({
      tmplIds: [TPL_PERIOD],
      success: (res) => {
        // 与「我们」页同一套判定：accept / reject / ban / filter 分别处理，
        // 不能把 ban / filter 说成「已取消」（前者要去设置里改，后者是模板问题）
        const state = subResultOf(res, TPL_PERIOD)
        if (state !== 'accept') {
          this._subbingRemind = false
          this.showFeedback(subFeedback(state))
          return
        }
        // 身份由云函数 WXContext 决定，前端传不了别人的 openid
        wx.cloud.callFunction({ name: 'menstrual', data: { action: 'subPeriod' } })
          .then(r => {
            this._subbingRemind = false
            const rr = (r && r.result) || {}
            // 服务端没记账就不能说「已开启」：常见于云函数还是旧版本（不认识 subPeriod）、
            // 或调用被限流。微信侧确实授权成功，但服务端额度为 0 时定时任务不会发，
            // 说「已开启」等于让用户等一条永远不会来的提醒。
            if (!rr.ok) {
              wx.showToast({ title: '已同意，但记录未成功，请稍后再试', icon: 'none' })
              return
            }
            const q = Number((rr.quota || {}).period) || 0
            this.setData({
              remindQuota: q,
              remindHint: buildRemindHint(this.data.remindReady, q, this.data.isHer)
            })
            this.showFeedback(subFeedback('accept'))
          })
          .catch(() => {
            this._subbingRemind = false
            wx.showToast({ title: '已同意，但记录失败，不影响接收提醒', icon: 'none' })
          })
      },
      fail: (e) => {
        this._subbingRemind = false
        this.showFeedback(subFailFeedback((e && e.errMsg) || ''))
      }
    })
  },

  // 记录方决定「是否也提醒 TA」。默认关闭；失败要把开关拨回去，不能显示成功。
  onPartnerRemind(e) {
    const on = !!(e && e.detail && e.detail.value)
    const revert = () => this.setData({ partnerRemind: !on })
    if (this._savingPartner) { revert(); return }
    this._savingPartner = true
    wx.cloud.callFunction({ name: 'menstrual', data: { action: 'remindPrefs', partner: on } })
      .then(r => {
        this._savingPartner = false
        const rr = (r && r.result) || {}
        if (rr.ok) {
          this.setData({ partnerRemind: rr.partnerRemind === true })
          wx.showToast({ title: rr.partnerRemind ? '已开启：也会提醒 TA' : '已关闭', icon: 'none' })
        } else {
          revert()
          wx.showToast({ title: rr.msg || '设置失败，请重试', icon: 'none' })
        }
      })
      .catch(() => {
        this._savingPartner = false
        revert()
        wx.showToast({ title: '网络异常，请重试', icon: 'none' })
      })
  },

  // 记录方决定「是否允许 TA 查看经期数据」（默认关）。失败要把开关拨回去，不能显示成功。
  onSharePeriod(e) {
    const on = !!(e && e.detail && e.detail.value)
    const revert = () => this.setData({ sharePeriod: !on })
    if (this._savingShare) { revert(); return }
    this._savingShare = true
    wx.cloud.callFunction({ name: 'menstrual', data: { action: 'sharePeriod', share: on } })
      .then(r => {
        this._savingShare = false
        const rr = (r && r.result) || {}
        if (rr.ok) {
          this.setData({ sharePeriod: rr.sharePeriod === true })
          wx.showToast({ title: rr.sharePeriod ? '已开启：TA 可查看经期' : '已关闭', icon: 'none' })
        } else {
          revert()
          wx.showToast({ title: rr.msg || '设置失败，请重试', icon: 'none' })
        }
      })
      .catch(() => {
        this._savingShare = false
        revert()
        wx.showToast({ title: '网络异常，请重试', icon: 'none' })
      })
  },

  fmtNextLabel(nextStart) {
    if (!nextStart) return ''
    const [, m, d] = nextStart.split('-')
    return `${Number(m)}月${Number(d)}日左右`
  },

  prev() {
    let { year, month } = this.data
    month--
    if (month < 1) { month = 12; year-- }
    this.setData({ year, month })
    this.loadMarks()
  },
  next() {
    let { year, month } = this.data
    month++
    if (month > 12) { month = 1; year++ }
    this.setData({ year, month })
    this.loadMarks()
  },

  toggleSetting() {
    const next = !this.data.open
    // 展开设置面板视为开始一次新的编辑：脏标记归零，让面板展示的是云端最新值
    if (next) this._formDirty = false
    this.setData({ open: next })
  },
  onLastStart(e) {
    this._formDirty = true
    this.setData({ lastStart: e.detail.value })
  },
  // 输入即所见：只保留数字，且**不在每次按键时重新 setData 同一个值**。
  // 只有当用户敲进非法字符/超长、需要把输入框内容纠正回数字时才 setData；
  // 正常输入只更新内部状态 —— 避免「每输入一个字符就被框架回写一次」造成的闪断/丢字。
  onCycle(e) {
    const raw = String(e.detail.value == null ? '' : e.detail.value)
    const clean = digitsOnly(raw, 3)
    this._formDirty = true
    if (clean !== raw) this.setData({ cycle: clean })
    else this.data.cycle = clean
  },
  onPeriodLen(e) {
    const raw = String(e.detail.value == null ? '' : e.detail.value)
    const clean = digitsOnly(raw, 2)
    this._formDirty = true
    if (clean !== raw) this.setData({ periodLen: clean })
    else this.data.periodLen = clean
  },
  // 失焦时把「空 / 非法」的输入整理回合法字符串，但不做范围判断（不打断用户填写）
  onCycleBlur() {
    if (this.data.cycle === '') this.setData({ cycle: '28' })
  },
  onPeriodLenBlur() {
    if (this.data.periodLen === '') this.setData({ periodLen: '5' })
  },

  // M4 保存：走云函数（revision + requestId 契约），失败有用户可见反馈
  saveMenstrual() {
    if (this.data.saving) return
    const lastStart = this.data.lastStart
    if (!lastStart) { wx.showToast({ title: '请选择最近一次开始日期', icon: 'none' }); return }
    const cycle = parseIntStrict(this.data.cycle, 3)
    if (cycle === null || cycle < CYCLE_MIN || cycle > CYCLE_MAX) {
      wx.showToast({ title: `周期需为 ${CYCLE_MIN}~${CYCLE_MAX} 的整数天`, icon: 'none' })
      return
    }
    const periodLen = parseIntStrict(this.data.periodLen, 2)
    if (periodLen === null || periodLen < PERIOD_MIN || periodLen > PERIOD_MAX) {
      wx.showToast({ title: `经期持续天数需为 ${PERIOD_MIN}~${PERIOD_MAX} 的整数天`, icon: 'none' })
      return
    }
    this.setData({ saving: true })
    wx.cloud.callFunction({
      name: 'menstrual',
      data: {
        action: 'save',
        lastStart,
        cycle,
        periodLen,
        requestId: genRequestId(),
        revision: this.data.revision
      }
    }).then(res => {
      const r = res.result || {}
      if (r.ok) {
        // 以服务端回读值为准（服务端会把 periodLen 归一化），并清除脏标记，
        // 让随后的 loadMarks() 可以把云端真实值写回表单。
        this._formDirty = false
        this.setData({
          revision: r.revision,
          cycle: String(cycle),
          periodLen: String(r.periodLen || periodLen),
          nextStart: r.nextStart,
          nextLabel: this.fmtNextLabel(r.nextStart),
          saving: false,
          open: false,
          configured: true
        })
        wx.showToast({ title: '保存成功' })
        this.loadMarks()
      } else if (r.code === 'REV_CONFLICT') {
        this.setData({ saving: false })
        wx.showModal({
          title: '内容已被更新',
          content: '经期信息在别处被修改过。重新加载最新内容？',
          confirmText: '重新加载',
          success: m => { if (m.confirm) { this._formDirty = false; this.loadMarks() } }
        })
      } else {
        this.setData({ saving: false })
        wx.showToast({ title: r.msg || '保存失败', icon: 'none' })
        console.error('saveMenstrual', r.code || '', r.msg || '')
      }
    }).catch(() => {
      this.setData({ saving: false })
      wx.showToast({ title: '网络异常，请重试', icon: 'none' })
    })
  }
})
