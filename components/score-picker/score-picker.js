const ICONS = require('../../assets/svg-icons')

// 今日得分打分器 · PRD §3.4 动效保留（弹跳），emoji → SVG 爱心（§3.2）
Component({
  properties: {
    value: { type: Number, value: 0 },
    readonly: { type: Boolean, value: false },
    // 称呼：显示「X 的得分 / X 给你打的分」中的 X。由使用方传入（查看者自己给 TA 的称呼），
    // 缺省回退「TA」，组件不内置任何个人化名字。
    name: { type: String, value: 'TA' }
  },
  data: {
    open: false,
    animClass: '',
    word: '',
    faceSrc: ICONS.heart,
    heartSrc: ICONS.heart,
    wordMap: { 0: '', 1: '今天有点不开心', 2: '不太满意哦', 3: '还行的一天', 4: '挺开心的', 5: '超爱你' },
    animMap: { 0: '', 1: 'shake', 2: 'shake', 3: 'calm', 4: 'bounce', 5: 'bounce' },
    hearts: [1, 2, 3, 4, 5]
  },
  observers: {
    'value': function (v) {
      this.setData({
        animClass: this.data.animMap[v] || '',
        word: this.data.wordMap[v] || ''
      })
    }
  },
  methods: {
    toggleOpen() {
      if (this.data.readonly) return
      this.setData({ open: !this.data.open })
    },
    pick(e) {
      const v = Number(e.currentTarget.dataset.v)
      this.triggerEvent('change', { value: v })
      this.setData({ open: false })
    }
  }
})
