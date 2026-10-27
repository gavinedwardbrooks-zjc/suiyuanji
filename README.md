# 碎愿集 · Suiyuanji

一个**无广告、双人同步、温柔记录每一天**的轻量情侣小程序 —— 让她愿意记录，让他愿意打开查看。

基于**微信小程序 + 微信云开发**，数据私密隔离，无第三方广告、无数据买卖。

---

## 功能一览

| 模块 | 说明 |
|---|---|
| 情侣配对 | 一方生成配对码、另一方输入加入（角色是业务权限，不等同生理性别） |
| 自定义称呼 | 各自设置对另一半的称呼（宝宝 / 小胖 / 宝贝…），互不覆盖 |
| 每日记录 | 今日目标（可设提醒）、小事 todo、三段日记、心情天气、给对方打分 |
| 纸间心事 | PDF / TXT 导入、书架、阅读进度（本地优先，云端可迁移） |
| 日历 | 经期追踪 + 预测 + 阅读标记（经期共享默认关闭，需本人授权） |
| 我们 | 心愿 + 双向留言（评分展示统一在首页，不重复） |
| 今日决定 | 今天吃什么（食谱三菜组合）/ 今天去哪里（旅行攻略）；记录方确认后，双方首页看到同一个结果 |
| 共同待办 | 双方都能添加 / 勾选 / 删除，与个人小事完全分开 |
| 记录分享 | 记录方可按日期把某一天的日记分享给伴侣（默认关闭，可随时撤销） |
| AI 每日小结 | 每晚定时生成暖心总结（无 AI Key 时自动降级为内置模板） |
| 隐私 | 跨情侣数据隔离、解绑与重新绑定、数据删除与账号注销 |

---

## 技术栈

- **小程序端**：原生微信小程序（WXML / WXSS / JavaScript）
- **后端**：微信云开发（云函数 + 云数据库 + 云存储），`wx-server-sdk`

---

## 快速开始

### 1. 环境准备

- 安装[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
- 注册小程序，拿到自己的 **AppID**
- 开通**云开发**，记下**环境 ID**

### 2. 导入项目

微信开发者工具 → 导入项目 → 选择本目录 → 填入你的 AppID。

### 3. 配置客户端 `config.js`

打开项目根目录 `config.js`，替换为你的值：

| 配置项 | 说明 |
|---|---|
| `CLOUD_ENV` | 你的云开发环境 ID |
| `SUB_TPL_CHAT` | 聊天消息通知订阅模板 ID |
| `SUB_TPL_PERIOD` | 经期提醒订阅模板 ID |

> `config.js` 只放**非敏感**配置。AI Key 等密钥只允许出现在云函数环境变量中，禁止写入客户端 / 仓库。

### 4. 部署云函数

`cloudfunctions/` 下每个文件夹右键 → **「上传并部署：云端安装依赖」**。

核心云函数：`login` `bindCouple` `dailyRecord` `getPartnerView` `menstrual` `aiSummary` `deleteAccount`（另有 `profileStats` / `lifePlanner` / `reminderCheck` / `writing` 等可选，共 11 个）。

### 5. 配置云函数环境变量

参考根目录 `.env.example`（集中示例），在云开发控制台为各云函数单独配置。**未配置 AI Key 也能跑**：`aiSummary` 会自动使用内置模板降级兜底。

### 6. 配置定时触发器

| 触发器 | 周期 | 云函数 | 说明 |
|---|---|---|---|
| `dailySummary` | 每天 22:00 | aiSummary | 晚间小结 |
| `periodRemind` | 每天 09:00 | menstrual | 经期提醒 |

---

## 目录结构

```
├── app.js / app.json / app.wxss   # 全局入口、tabBar、主题
├── config.js                      # 客户端非敏感配置
├── pages/                         # home record reading calendar ours mine privacy …
├── components/                    # todo-item score-picker goal-card …
├── assets/                        # 手绘插画（svg-icons，来源见 SOURCES.md）
├── utils/                         # 工具模块
├── cloudfunctions/                # 云函数（每个目录一个函数）
└── tests/                         # 本地测试（Node，mock 云数据库）
```

---

## 隐私与数据

- 所有数据存于**你自己的微信云开发环境**，无第三方广告、无数据买卖。
- 伴侣视角**只能**看到：打分、心愿、经期区间、AI 小结/周报的授权部分，以及**你主动分享的那一天**的日记。
- 三段日记正文、心情细节、经期症状、安全期区间对本人私有（分享是按日期逐天授权，默认关闭）。
- 跨情侣数据隔离：换绑后，旧关系期间的数据不再对新伴侣展示（历史数据保留在库，不迁移不删除）。

---

## 测试

```bash
node tests/<name>.test.js   # 逐个运行
# 或全量：
for f in tests/*.test.js; do node "$f" || exit 1; done
```

---

## 许可证

[MIT](./LICENSE)
