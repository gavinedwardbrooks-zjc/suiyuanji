// pages/food/food.js · M7 今天吃什么（随机入口）
// V1.1：新增「就吃这个」确认闭环 —— 只有记录方（her）能确认，him 只推荐不确认。
//   确认结果按「一对情侣 + 今天 + meal」唯一保存，双方首页读到同一份。
const app = getApp()
const { viewerFlags } = require('../../utils/viewer-role')

// 与服务端 day_choices 对齐：一次确认 = 1 荤 + 1 素 + 1 汤
const CONFIRM_ORDER = ['meat', 'vegetable', 'soup']

Page({
  data: {
    ready: false,        // seed 是否就绪
    loading: false,
    meal: null,          // { meat, vegetable, soup }
    error: '',
    // V1.1 今日决定
    isHer: false,            // 只有记录方显示确认按钮（服务端还会再拒一次）
    confirming: false,
    confirmedKey: '',        // 今天已确认的组合（refIds 顺序固定为 荤/素/汤）
    confirmedName: '',       // 今天已确认的显示名（服务端快照）
    isConfirmedCurrent: false, // 当前这组推荐是否就是已确认的那一组
    confirmError: ''
  },

  onShow() {
    this.syncRole()
    this.checkReady()
    this.loadChoice()
  },

  // 角色快照（P0 口径：不在页面里比 role 字符串）
  syncRole() {
    const flags = viewerFlags(app.globalData)
    if (this.data.isHer !== flags.isHer) this.setData({ isHer: flags.isHer })
  },

  checkReady() {
    wx.cloud.callFunction({ name: 'lifePlanner', data: { action: 'listRecipes' } })
      .then(res => {
        const r = res.result || {}
        this.setData({ ready: r.ok && (r.recipes || []).length > 0 })
      })
      .catch(() => this.setData({ ready: false }))
  },

  // 今天是否已经确认过（读不到就保持未知：不谎称「还没决定」）
  loadChoice() {
    const seq = (this._choiceSeq = (this._choiceSeq || 0) + 1)
    wx.cloud.callFunction({ name: 'lifePlanner', data: { action: 'getDayChoice', kind: 'meal' } })
      .then(res => {
        if (seq !== this._choiceSeq) return
        const r = res.result || {}
        if (!r.ok) return
        const m = r.meal || null
        const key = m && Array.isArray(m.refIds) ? m.refIds.join(',') : ''
        this.setData({
          confirmedKey: key,
          confirmedName: m && m.name ? m.name : '',
          isConfirmedCurrent: this._isCurrent(key)
        })
      })
      .catch(() => { /* 读不到 → 不显示已确认，也不显示「还没决定」 */ })
  },

  _currentKey() {
    const meal = this.data.meal
    if (!meal) return ''
    const ids = []
    for (const k of CONFIRM_ORDER) {
      if (!meal[k] || !meal[k]._id) return ''
      ids.push(meal[k]._id)
    }
    return ids.join(',')
  },

  _isCurrent(key) {
    const cur = this._currentKey()
    return !!key && !!cur && key === cur
  },

  randomMeal() {
    if (this.data.loading) return
    this.setData({ loading: true, error: '', confirmError: '' })
    const avoid = this.data.meal ? {
      meat: this.data.meal.meat._id,
      vegetable: this.data.meal.vegetable._id,
      soup: this.data.meal.soup._id
    } : undefined
    wx.cloud.callFunction({ name: 'lifePlanner', data: { action: 'randomMeal', avoid } })
      .then(res => {
        const r = res.result || {}
        if (r.ok && r.meal) {
          this.setData({ meal: r.meal, loading: false, error: '' })
          this.setData({ isConfirmedCurrent: this._isCurrent(this.data.confirmedKey) })
        } else {
          this.setData({ error: r.msg || '随机失败', loading: false })
        }
      })
      .catch(() => this.setData({ error: '网络异常，请重试', loading: false }))
  },

  // 确认今天吃这组（仅 her；him 调到这里服务端也会 FORBIDDEN）
  confirmMeal() {
    if (!this.data.isHer || this.data.confirming) return
    const key = this._currentKey()
    if (!key) return
    const ids = key.split(',')
    this.setData({ confirming: true, confirmError: '' })
    wx.cloud.callFunction({
      name: 'lifePlanner',
      data: { action: 'confirmDayChoice', kind: 'meal', refIds: ids }
    }).then(res => {
      const r = res.result || {}
      if (r.ok) {
        // 以服务端返回的快照为准（客户端不自己拼名字）
        this.setData({
          confirming: false,
          confirmedKey: Array.isArray(r.refIds) ? r.refIds.join(',') : key,
          confirmedName: r.name || '',
          confirmError: ''
        })
        this.setData({ isConfirmedCurrent: this._isCurrent(this.data.confirmedKey) })
        wx.showToast({ title: '已确定今天的菜', icon: 'none' })
        return
      }
      this.setData({ confirming: false, confirmError: r.msg || '确定失败' })
      wx.showToast({ title: r.msg || '确定失败', icon: 'none' })
    }).catch(() => {
      this.setData({ confirming: false, confirmError: '网络异常，请重试' })
      wx.showToast({ title: '网络异常，请重试', icon: 'none' })
    })
  },

  goRecipe(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/recipe/recipe?id=' + id })
  }
})
