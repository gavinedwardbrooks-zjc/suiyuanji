// pages/recipe/recipe.js · M7 菜谱详情 + 编辑 + AI 重新生成
const app = getApp()

function genRequestId() {
  return 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10)
}
function fmtList(arr) { return (arr || []).map((s, i) => `${i + 1}. ${s}`).join('\n') }

Page({
  data: {
    id: '',
    recipe: null,
    notFound: false,
    editing: false,
    // 编辑态草稿
    draftIngredients: '',
    draftSteps: '',
    draftTips: '',
    saving: false,
    generating: false,
    aiDraft: null, // AI 生成的待确认内容
    error: ''
  },

  onLoad(q) {
    this.setData({ id: q.id || '' })
    this.load()
  },

  load() {
    wx.cloud.callFunction({ name: 'lifePlanner', data: { action: 'getRecipe', recipeId: this.data.id } })
      .then(res => {
        const r = res.result || {}
        if (r.ok && r.recipe) {
          const rec = r.recipe
          this.setData({
            recipe: rec,
            notFound: false,
            draftIngredients: fmtList(rec.ingredients),
            draftSteps: fmtList(rec.steps),
            draftTips: fmtList(rec.tips)
          })
        } else {
          this.setData({ notFound: true })
        }
      })
      .catch(() => this.setData({ notFound: true }))
  },

  // ---- 编辑 ----
  enterEdit() { this.setData({ editing: true, aiDraft: null }) },
  cancelEdit() {
    const rec = this.data.recipe
    this.setData({
      editing: false, aiDraft: null,
      draftIngredients: fmtList(rec.ingredients),
      draftSteps: fmtList(rec.steps),
      draftTips: fmtList(rec.tips)
    })
  },
  onIngredients(e) { this.setData({ draftIngredients: e.detail.value }) },
  onSteps(e) { this.setData({ draftSteps: e.detail.value }) },
  onTips(e) { this.setData({ draftTips: e.detail.value }) },

  save() {
    if (this.data.saving) return
    const split = s => s.split('\n').map(x => x.replace(/^\d+[.、)]\s*/, '').trim()).filter(Boolean)
    const ingredients = split(this.data.draftIngredients)
    const steps = split(this.data.draftSteps)
    const tips = split(this.data.draftTips)
    if (!ingredients.length || !steps.length) {
      wx.showToast({ title: '食材和步骤不能为空', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    wx.cloud.callFunction({
      name: 'lifePlanner',
      data: {
        action: 'saveRecipe',
        recipeId: this.data.id,
        ingredients, steps, tips,
        requestId: genRequestId(),
        revision: this.data.recipe.revision || 1
      }
    }).then(res => {
      const r = res.result || {}
      this.setData({ saving: false })
      if (r.ok) {
        wx.showToast({ title: '已保存' })
        this.setData({ editing: false, aiDraft: null })
        this.load()
      } else if (r.code === 'REV_CONFLICT') {
        wx.showModal({
          title: '内容已被更新',
          content: '这道菜谱在别处被修改过。重新加载最新内容？',
          confirmText: '重新加载',
          success: m => { if (m.confirm) this.load() }
        })
      } else {
        wx.showToast({ title: r.msg || '保存失败', icon: 'none' })
      }
    }).catch(() => this.setData({ saving: false }))
  },

  // ---- AI 重新生成（二次确认 → draft → 预览 → 确认保存） ----
  regenerate() {
    if (this.data.generating) return
    wx.showModal({
      title: 'AI 重新生成',
      content: 'AI 会重新生成这道菜的制作方法，并覆盖当前内容。是否继续？',
      confirmText: '继续',
      cancelText: '取消',
      success: m => {
        if (!m.confirm) return
        this.setData({ generating: true, error: '' })
        wx.cloud.callFunction({ name: 'lifePlanner', data: { action: 'regenerateRecipe', recipeId: this.data.id } })
          .then(res => {
            const r = res.result || {}
            this.setData({ generating: false })
            if (r.ok && r.draft) {
              // AI 成功 → 只进编辑预览，不直接落库（用户确认保存）
              this.setData({
                aiDraft: r.draft,
                editing: true,
                draftIngredients: fmtList(r.draft.ingredients),
                draftSteps: fmtList(r.draft.steps),
                draftTips: fmtList(r.draft.tips)
              })
              wx.showToast({ title: 'AI 已生成，确认后保存', icon: 'none' })
            } else {
              this.setData({ error: r.msg || 'AI 生成失败，已保留原内容' })
            }
          })
          .catch(() => this.setData({ generating: false, error: 'AI 生成失败，已保留原内容' }))
      }
    })
  }
})
