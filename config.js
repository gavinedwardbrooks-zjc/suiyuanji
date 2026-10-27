// ============================================================
// config.js · 客户端配置（PRD v0.6 §4.1 B3）
// 硬约束：本文件只放「非敏感」配置。
// AI Key 等密钥仅存云函数环境变量，禁止出现在客户端/config/仓库。
// ============================================================

const CONFIG = {
  // 微信云开发环境 ID（cloud1 · 2026-08-26 开通）
  CLOUD_ENV: 'YOUR_CLOUD_ENV_ID',

  // 订阅消息模板 ID（微信公众平台 → 订阅消息 → 我的模板）
  //
  // 两个通道（一个通道 = 一个模板 = 一份额度）：
  //   SUB_TPL_CHAT   「聊天消息通知」模板 3377 —— 她新增心愿 / 她发悄悄话，共用这一个模板
  //   SUB_TPL_PERIOD 「经期提醒」模板 472 —— 预计经期前 2 天提醒
  //
  // 模板 ID 不是密钥：客户端申请授权时必须用到它，所以放在这里；云函数侧同名环境变量
  // TPL_CHAT / TPL_PERIOD 可覆盖（缺省即用同样的 ID，见 cloudfunctions/*/notify.js）。
  // 一次性订阅：用户每同意一次 ≈ 可接收一条消息，没有「永久授权」。
  //
  // 下面两个占位符属于其他功能（目标提醒 / AI 小结），本次未改动。
  SUB_TPL_REMIND: 'TEMPLATE_ID_HERE',   // 目标提醒
  SUB_TPL_SUMMARY: 'TEMPLATE_ID_HERE',  // AI 晚间小结

  SUB_TPL_CHAT: 'TEMPLATE_ID_HERE',
  SUB_TPL_PERIOD: 'TEMPLATE_ID_HERE'
}

// 模板 ID 是否已真正填写（'' 与历史占位符都算未配置）
function isTplReady(id) {
  return typeof id === 'string' && id !== '' && id !== 'TEMPLATE_ID_HERE'
}

module.exports = CONFIG
module.exports.isTplReady = isTplReady
