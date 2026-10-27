// pages/travel/travel.js · M8 今天去哪里（北京/外地双 Tab + 随机）
// V1.1：新增「就去这里」确认闭环 —— 只有记录方（her）能确认，him 只推荐不确认。
// 注意：这里的「今天去哪里」是**单日的地点选择**，与 travel-detail 里的
// 「多日旅行计划编辑」是两件事，互不写入对方的数据。
const app = getApp()
const ICONS = require('../../assets/svg-icons')
const { viewerFlags } = require('../../utils/viewer-role')

Page({
  data: {
    tab: 'beijing',
    ready: false,
    loading: false,
    place: null,
    error: '',
    lastId: '',
    decoCatSrc: ICONS.deco_cat_hero,
    decoPlantSrc: ICONS.deco_plant,
    // V1.1 今日决定
    isHer: false,
    confirming: false,
    confirmedKey: '',           // 今天已确认的地点 id
    confirmedName: '',
    isConfirmedCurrent: false,
    confirmError: ''
  },

  onShow() {
    this.syncRole()
    this.checkReady()
    this.loadChoice()
  },

  syncRole() {
    const flags = viewerFlags(app.globalData)
    if (this.data.isHer !== flags.isHer) this.setData({ isHer: flags.isHer })
  },

  checkReady() {
    wx.cloud.callFunction({ name: 'lifePlanner', data: { action: 'listTravelPlaces', type: this.data.tab } })
      .then(res => {
        const r = res.result || {}
        this.setData({ ready: r.ok && (r.places || []).length > 0 })
      })
      .catch(() => this.setData({ ready: false }))
  },

  // 今天是否已经确认过（读不到就保持未知：不谎称「还没决定」）
  loadChoice() {
    const seq = (this._choiceSeq = (this._choiceSeq || 0) + 1)
    wx.cloud.callFunction({ name: 'lifePlanner', data: { action: 'getDayChoice', kind: 'travel' } })
      .then(res => {
        if (seq !== this._choiceSeq) return
        const r = res.result || {}
        if (!r.ok) return
        const t = r.travel || null
        const key = t && Array.isArray(t.refIds) && t.refIds[0] ? t.refIds[0] : ''
        this.setData({
          confirmedKey: key,
          confirmedName: t && t.name ? t.name : '',
          isConfirmedCurrent: !!key && !!this.data.place && this.data.place._id === key
        })
      })
      .catch(() => { /* 读不到 → 不显示已确认，也不显示「还没决定」 */ })
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.tab) return
    this.setData({ tab, place: null, error: '', lastId: '', isConfirmedCurrent: false })
    this.checkReady()
  },

  randomPlace() {
    if (this.data.loading) return
    this.setData({ loading: true, error: '', confirmError: '' })
    wx.cloud.callFunction({
      name: 'lifePlanner',
      data: { action: 'randomTravel', type: this.data.tab, excludeId: this.data.lastId || undefined }
    }).then(res => {
      const r = res.result || {}
      this.setData({ loading: false })
      if (r.ok && r.place) {
        this.setData({
          place: r.place,
          lastId: r.place._id,
          error: '',
          isConfirmedCurrent: !!this.data.confirmedKey && this.data.confirmedKey === r.place._id
        })
      } else {
        this.setData({ error: r.msg || '随机失败' })
      }
    }).catch(() => this.setData({ loading: false, error: '网络异常，请重试' }))
  },

  // 确认今天去这里（仅 her；him 调到这里服务端也会 FORBIDDEN）
  confirmPlace() {
    if (!this.data.isHer || this.data.confirming) return
    const place = this.data.place
    if (!place || !place._id) return
    this.setData({ confirming: true, confirmError: '' })
    wx.cloud.callFunction({
      name: 'lifePlanner',
      data: { action: 'confirmDayChoice', kind: 'travel', refIds: [place._id] }
    }).then(res => {
      const r = res.result || {}
      if (r.ok) {
        const key = Array.isArray(r.refIds) && r.refIds[0] ? r.refIds[0] : place._id
        this.setData({
          confirming: false,
          confirmedKey: key,
          confirmedName: r.name || '',
          confirmError: '',
          isConfirmedCurrent: key === place._id
        })
        wx.showToast({ title: '已确定今天去哪里', icon: 'none' })
        return
      }
      this.setData({ confirming: false, confirmError: r.msg || '确定失败' })
      wx.showToast({ title: r.msg || '确定失败', icon: 'none' })
    }).catch(() => {
      this.setData({ confirming: false, confirmError: '网络异常，请重试' })
      wx.showToast({ title: '网络异常，请重试', icon: 'none' })
    })
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/travel-detail/travel-detail?id=' + id })
  }
})
