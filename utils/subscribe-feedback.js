// ============================================================
// utils/subscribe-feedback.js · 订阅消息的结果判定与话术（单一来源）
//
// 为什么要有这个文件：
//   wx.requestSubscribeMessage 在「我们」页（聊天消息通知）和日历页（经期提醒）
//   各被调用一次。同一个返回矩阵如果在两个页面各写一遍，迟早会漂移成
//   「一边正确处理 ban，另一边显示已取消」。所以判定与话术在这里只写一份，
//   页面只负责把结果弹出来。
//
// 平台事实（决定了下面每一个分支）：
//   · 一次性订阅：一次 accept ≈ 一条消息额度，**不存在**永久发送权限。
//     用户勾「总是保持以上选择」只是让微信下次不再弹窗，额度仍然是一次性的。
//   · success 回调里每个模板 ID 对应一个字符串：
//       accept  用户同意（+1 次额度）
//       reject  本次拒绝（下次点还能再申请）
//       ban     用户此前拒绝过并被微信记住，只能去设置里改
//       filter  模板被平台过滤（模板调整/下线），与用户选择无关
//   · fail 回调带 errCode：20004 总开关被关；10003/20001~20003 模板配置问题；
//     10002 网络问题。
//   · 微信没有「查询剩余可发送次数」的接口 —— 所以任何地方都不得凭空显示次数，
//     也不得把服务端记账说成「微信确认的剩余额度」。
// ============================================================

const SUB_RESULTS = ['accept', 'reject', 'ban', 'filter']

// 取某个模板 ID 的结果；未知值一律返回 'unknown'（绝不乐观假设成 accept）
function subResultOf(res, tpl) {
  const v = res && tpl ? res[tpl] : ''
  return SUB_RESULTS.indexOf(v) !== -1 ? v : 'unknown'
}

// 结果 → 纯数据提示（type: 'toast' | 'modal'）
function subFeedback(state) {
  if (state === 'accept') {
    // 不说「已开启」：这句话在一次性订阅语境里等同于「永久开启」，是假承诺
    return { type: 'toast', title: '已记 1 次提醒' }
  }
  if (state === 'reject') {
    return { type: 'toast', title: '已取消，不影响正常使用' }
  }
  if (state === 'ban') {
    return {
      type: 'modal',
      title: '提醒被微信拦住了',
      content: '你之前拒绝过这类提醒，微信记住了这个选择（「总是保持以上选择」）。想收提醒的话，到「微信 → 我 → 设置 → 消息通知」或小程序右上角「···」→「设置」里打开订阅消息，再回来点一次开启。页面上的提示一直可用。'
    }
  }
  if (state === 'filter') {
    return {
      type: 'modal',
      title: '这个提醒暂时不可用',
      content: '微信暂时过滤了这个提醒模板（通常表示模板正在调整或已下线），不是你的操作问题。页面上的提示照常可用，稍后可以再试。'
    }
  }
  return { type: 'toast', title: '没有开启成功，可以稍后再试' }
}

// 调用失败（fail 回调）→ 纯数据提示。分级的理由：用户要能知道下一步做什么。
function subFailFeedback(errMsg) {
  const msg = String(errMsg || '')
  const m = /(\d{4,5})/.exec(msg)
  const code = m ? Number(m[1]) : 0
  if (code === 20004) {
    return {
      type: 'modal',
      title: '微信提醒被关掉了',
      content: '你在微信设置里关闭了本小程序的消息通知。可以到「微信 → 设置 → 消息通知」里重新打开后再试。'
    }
  }
  if (code === 10003 || code === 20001 || code === 20002 || code === 20003) {
    return {
      type: 'modal',
      title: '提醒功能暂不可用',
      content: '订阅模板配置有问题（模板 ID 无效 / 类型不对 / 数量超限），需要在微信公众平台检查。在此之前页面上的提示照常可用。'
    }
  }
  if (code === 10002) return { type: 'toast', title: '网络异常，请稍后再试' }
  return { type: 'toast', title: '没有开启成功，可以稍后再试' }
}

module.exports = {
  SUB_RESULTS,
  subResultOf,
  subFeedback,
  subFailFeedback
}
