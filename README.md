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
| 桌面版（Windows） | 手机扫码登录，在电脑上读写当天的目标与小事；支持窗口透明度与置顶 |
| 隐私 | 跨情侣数据隔离、解绑与重新绑定、数据删除与账号注销 |

---

## 技术栈

- **小程序端**：原生微信小程序（WXML / WXSS / JavaScript）
- **后端**：微信云开发（云函数 + 云数据库 + 云存储），`wx-server-sdk`
- **桌面端**：Tauri 2 + React 19 + Vite 7 + TypeScript + Rust（Windows）

> 桌面端可选。不构建桌面端时，删掉本地的 `desktop/` 目录即可，小程序完全不受影响。

---

## 快速开始

### 1. 环境准备

- 安装[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
- 注册小程序，拿到自己的 **AppID**
- 开通**云开发**，记下**环境 ID**

### 2. 导入项目

微信开发者工具 → 导入项目 → 选择本目录 → 填入你的 AppID。

> AppID 建议只在开发者工具里填。工具会把它写进 `project.private.config.json`
> （已被 `.gitignore` 忽略、也不会打进安装包），仓库里的 `project.config.json`
> 始终保持占位符 `wxYOUR_APPID`。**不要**为了让工具跑起来去改 `project.config.json`。

### 3. 生成本地私有配置

仓库里的 `config.js` 只有占位符。真实的云环境 ID / 订阅模板 ID 放在
**本机私有**的 `config.local.js`（已被 `.gitignore` 忽略，不会入库）：

```bash
node scripts/init-local-config.js        # 从 config.local.example.js 复制一份
node scripts/init-local-config.js --check # 体检：文件在不在、是否还是占位符
```

然后编辑 `config.local.js`：

| 配置项 | 说明 |
|---|---|
| `CLOUD_ENV` | 你的云开发环境 ID（云开发控制台 → 设置 → 环境 ID） |
| `SUB_TPL_CHAT` | 聊天消息通知订阅模板 ID |
| `SUB_TPL_PERIOD` | 经期提醒订阅模板 ID |
| `SUB_TPL_REMIND` / `SUB_TPL_SUMMARY` | 目标提醒 / AI 晚间小结模板（可留占位符） |

> `config.local.js` **必须先创建**才能跑起来。缺失时 `app.js` 会 fail-closed：
> 拒绝初始化云能力、控制台打印配置指引 —— 它**不会**省略 `env` 参数让微信
> 回落到默认环境（那可能连到不属于你的线上环境）。
>
> 分层红线：`config.js` / `config.local.js` 只放**客户端标识**；
> AI Key、AppSecret 等服务端密钥只允许出现在云函数环境变量里。

### 4. 部署云函数

`cloudfunctions/` 下每个文件夹右键 → **「上传并部署：云端安装依赖」**。

核心云函数（小程序端 11 个）：`login` `bindCouple` `dailyRecord` `getPartnerView` `menstrual` `aiSummary` `deleteAccount` `profileStats` `lifePlanner` `reminderCheck` `writing`

桌面端另有 5 个：`desktopAuthPublic` `desktopAuthMiniapp` `desktopDaily` `userIdentity` `userUidMigration`（不部署不影响小程序）。

### 5. 配置云函数环境变量

参考根目录 `.env.example`（集中示例），在云开发控制台为各云函数单独配置。**未配置 AI Key 也能跑**：`aiSummary` 会自动使用内置模板降级兜底。

### 6. 配置定时触发器

| 触发器 | 周期 | 云函数 | 说明 |
|---|---|---|---|
| `dailySummary` | 每天 22:00 | aiSummary | 晚间小结 |
| `periodRemind` | 每天 09:00 | menstrual | 经期提醒 |

---

## 桌面版（可选）

仓库中的 `desktop/` 是一个 **Tauri 2 + React 19 + Rust** 的 Windows 桌面客户端，与小程序共用同一份云数据库。

```powershell
cd desktop
npm install
$env:DESKTOP_AUTH_BASE_URL = "https://<你的云环境地址>"
npm run tauri dev
```

- 登录：手机打开小程序 → 「我的」→「电脑登录」→ 扫桌面端二维码 → 确认
- 仓库内**不含任何真实云环境地址**，必须自行配置（见 [`desktop/README.md`](./desktop/README.md) §2）
- 详细架构、云函数分工与安全模型见 [`desktop/README.md`](./desktop/README.md)

---

## 目录结构

```
├── app.js / app.json / app.wxss   # 全局入口、tabBar、主题
├── config.js                      # 客户端配置（只有安全占位符）
├── config.local.example.js        # 本地私有配置模板（可提交）
├── scripts/                       # 本地脚本（init-local-config.js 等）
├── pages/                         # home record reading calendar ours mine privacy …
│   └── desktop-login-confirm/     # 桌面版扫码登录确认页
├── components/                    # todo-item score-picker goal-card …
├── assets/                        # 手绘插画（svg-icons，来源见 SOURCES.md）
├── utils/                         # 工具模块（含 desktop-qr.js 二维码解析）
├── cloudfunctions/                # 云函数（每个目录一个函数，根级 .js 为共享模块）
├── desktop/                       # Windows 桌面版（Tauri 2 + React 19 + Rust）
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
