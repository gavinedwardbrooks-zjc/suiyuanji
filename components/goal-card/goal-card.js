Component({
  properties: {
    goal: { type: Object, value: { text: '', done: false, reminderOn: false, reminderTime: '21:00' } },
    color: { type: String, value: '#FFC9D4' },
    index: { type: Number, value: 0 }
  },
  methods: {
    onInput(e) {
      this.triggerEvent('input', { index: this.data.index, text: e.detail.value })
    },
    onToggleDone() {
      this.triggerEvent('toggleDone', { index: this.data.index })
    },
    onToggleReminder() {
      this.triggerEvent('toggleReminder', { index: this.data.index })
    },
    onTime(e) {
      this.triggerEvent('changeTime', { index: this.data.index, time: e.detail.value })
    }
  }
})
