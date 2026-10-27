const api = require('../../utils/writingApi')
const TYPES = [
  { value: 'free', label: '随便写写' }, { value: 'life', label: '生活感悟' },
  { value: 'observation', label: '观察记录' }, { value: 'story', label: '一个故事' },
  { value: 'future_self', label: '写给未来的自己' }, { value: 'prompt', label: '主题练习' },
  { value: 'book_thought', label: '读后想到的事' }
]
Page({
  data: { writingId: '', title: '', content: '', type: 'free', types: TYPES, wordCount: 0, status: 'draft', saving: false, deleting: false, isEdit: false },
  onLoad(options) { if (options.writingId) { this.setData({ writingId: options.writingId, isEdit: true }); this.load(options.writingId) } },
  goBack() { wx.navigateBack() },
  load(id) { api.getWriting(id).then(r => { const w = r.writing; this.setData({ title: w.title || '', content: w.content || '', type: w.type || 'free', status: w.status || 'draft', wordCount: w.wordCount || 0 }) }).catch(err => { console.error('LOAD_WRITING_FAILED', err); wx.showToast({ title: '加载失败，请稍后再试', icon: 'none' }) }) },
  onTitle(e) { this.setData({ title: e.detail.value }) },
  onContent(e) { this.setData({ content: e.detail.value, wordCount: Array.from(e.detail.value).length }) },
  selectType(e) { this.setData({ type: e.currentTarget.dataset.value }) },
  saveDraft() { this.save('draft') },
  finish() { if (!this.data.content.trim()) { wx.showToast({ title: '先写几句再完成吧', icon: 'none' }); return } this.save('finished') },
  save(status) { if (this.data.saving) return; this.setData({ saving: true }); const payload = { title: this.data.title, content: this.data.content, type: this.data.type, status, bookId: null }; const request = this.data.isEdit ? api.updateWriting(this.data.writingId, payload) : api.createWriting(payload); request.then(() => { wx.showToast({ title: status === 'finished' ? '已完成' : '草稿已保存', icon: 'none' }); setTimeout(() => wx.navigateBack(), 350) }).catch(err => { console.error('SAVE_WRITING_FAILED', err); wx.showToast({ title: '保存失败，请检查网络后重试', icon: 'none' }) }).finally(() => this.setData({ saving: false })) },
  remove() { if (this.data.deleting) return; wx.showModal({ title: '要删掉这篇文字吗？', content: '删除后就找不回来啦。', cancelText: '取消', confirmText: '删除', success: r => { if (!r.confirm) return; this.setData({ deleting: true }); api.deleteWriting(this.data.writingId).then(() => wx.navigateBack()).catch(err => { console.error('DELETE_WRITING_FAILED', err); wx.showToast({ title: '删除失败，内容没有被删除', icon: 'none' }) }).finally(() => this.setData({ deleting: false })) } }) }
})
