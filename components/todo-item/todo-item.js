Component({
  properties: {
    item: { type: Object, value: { text: '', done: false } },
    index: { type: Number, value: 0 }
  },
  methods: {
    onToggle() { this.triggerEvent('toggle', { index: this.data.index }) },
    onDelete() { this.triggerEvent('delete', { index: this.data.index }) }
  }
})
