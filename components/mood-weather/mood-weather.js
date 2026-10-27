const ICONS = require('../../assets/svg-icons')

// 心情天气选择器 · PRD §3.2 第二层（几何极简，无 emoji）
Component({
  properties: {
    value: { type: Object, value: { type: 'calm', weather: 'sunny' } }
  },
  data: {
    moods: [
      { key: 'happy', src: ICONS.mood_happy, label: '开心' },
      { key: 'calm', src: ICONS.mood_calm, label: '平静' },
      { key: 'low', src: ICONS.mood_low, label: '低落' },
      { key: 'angry', src: ICONS.mood_angry, label: '生气' },
      { key: 'tired', src: ICONS.mood_tired, label: '疲惫' }
    ],
    weathers: [
      { key: 'sunny', src: ICONS.weather_sunny, label: '晴' },
      { key: 'cloudy', src: ICONS.weather_cloudy, label: '多云' },
      { key: 'rain', src: ICONS.weather_rain, label: '雨' },
      { key: 'snow', src: ICONS.weather_snow, label: '雪' }
    ]
  },
  methods: {
    pickMood(e) {
      this.triggerEvent('change', { value: { ...this.data.value, type: e.currentTarget.dataset.k } })
    },
    pickWeather(e) {
      this.triggerEvent('change', { value: { ...this.data.value, weather: e.currentTarget.dataset.k } })
    }
  }
})
