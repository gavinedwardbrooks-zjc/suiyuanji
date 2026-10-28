// ============================================================
// config.local.example.js · 本地私有配置模板（可提交，只含占位符）
//
// 用法：
//   1) node scripts/init-local-config.js
//      → 生成 config.local.js（已被 .gitignore 忽略，不会入库）
//   2) 在 config.local.js 里填入**你自己的**真实值
//   3) 微信开发者工具重新编译
//
// 也可以手工复制本文件为 config.local.js，效果相同。
//
// 红线：
//   · 只放「客户端标识」（云环境 ID、订阅模板 ID）——它们本来就会出现在
//     小程序包里，不是密钥。
//   · AI Key / AppSecret / 服务端 Token **一律不能**放这里，
//     只能配在云函数环境变量中（云开发控制台 → 云函数 → 配置）。
//   · config.local.js 不得提交、不得上传、不得贴进 issue 或截图。
// ============================================================
module.exports = {
  // 微信云开发环境 ID
  // 云开发控制台 → 设置 → 环境 ID，形如 your-env-id-1a2b3c4d
  CLOUD_ENV: 'YOUR_CLOUD_ENV_ID',

  // 订阅消息模板 ID（微信公众平台 → 订阅消息 → 我的模板）
  // 与功能对应关系：
  //   SUB_TPL_REMIND  目标提醒
  //   SUB_TPL_SUMMARY AI 晚间小结
  //   SUB_TPL_CHAT    聊天消息通知（新增心愿 / 悄悄话共用）
  //   SUB_TPL_PERIOD  经期提醒
  // 没有的通道就保持占位符，代码会自动跳过未配置的模板。
  SUB_TPL_REMIND: 'TEMPLATE_ID_HERE',
  SUB_TPL_SUMMARY: 'TEMPLATE_ID_HERE',
  SUB_TPL_CHAT: 'TEMPLATE_ID_HERE',
  SUB_TPL_PERIOD: 'TEMPLATE_ID_HERE'
}
