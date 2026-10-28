# 碎愿集（Suiyuanji）部署指南

> 本文为开源模板的部署清单。所有生产环境标识（AppID、云环境 ID、订阅模板 ID）均以占位符标注，**部署前请替换为你自己的值**。请勿提交任何真实密钥或真实数据。

**相关文档**：[架构说明](./ARCHITECTURE.md) · [开发环境](./DEVELOPMENT.md) ·
[云函数说明](./CLOUD_FUNCTIONS.md) · [数据模型](./DATA_MODEL.md) ·
[桌面版交接](./DESKTOP_HANDOVER.md) · [安全策略](../SECURITY.md)

---

## 1. 前置准备

1. 注册微信小程序，获取 **AppID**（在开发者工具「详情 → 基本信息」里填写，工具会写入本机
   私有的 `project.private.config.json`；仓库里的 `project.config.json` 始终保持占位符）。
2. 开通微信云开发，记录 **云环境 ID**（填进本地私有配置 `config.local.js` 的 `CLOUD_ENV`）。
3. 在微信公众平台 → 订阅消息 → 我的模板，申请以下两类模板并记录模板 ID：
   - 「聊天消息通知」模板（心愿 / 悄悄话通知）
   - 「经期提醒」模板（预计经期前提醒）

---

## 2. 必需数据库集合

在云开发控制台创建以下集合（权限建议「仅创建者可读写」，敏感数据由云函数校验）：

- `users` — 用户档案（含情侣关系、称呼、配额记账）
- `couples` — 情侣关系（pending → active → superseded/unbound/expired）
- `daily_records` — 每日记录（目标 / 小事 / 日记 / 心情 / 打分 / 心愿）
- `wishes` — 心愿
- `messages` — 双向留言
- `menstrual` — 经期记录（敏感个人信息，默认不共享）
- `profiles` — 持续画像（供 AI 小结使用）
- `books` — 书籍 / 阅读进度
- `recipes` — 食谱
- `travel_places` — 旅行地点
- `weekly_reports` — 周报
- `writings` — 随笔 / 写作
- `record_shares` — 记录级分享授权（记录方按天主动分享，默认关闭）
- `day_choices` — 今日决定（吃什么 / 去哪里，每个「情侣 + 日期 + 类型」一条）
- `couple_todos` — 双方共同待办（与个人待办 `daily_records.todos` 完全隔离）

> 后 3 个（`record_shares` / `day_choices` / `couple_todos`）的权限必须设为**「仅云函数可读写」**，
> 客户端不可直读直写 —— 否则 `coupleId` / `enabled` / `done` 等字段都可被伪造，越权模型直接失效。
>
> 它们**不会**被云函数「首次写入自动建表」：集合不存在时 `add()` 返回
> `-502005 collection not exists`，而不是替你建集合。因此顺序一定是**先建集合，再部署云函数**。

---

## 3. 必需复合索引

> 均为**非唯一**索引。不删除既有索引，不迁移/改写业务数据，不自动补写历史 `coupleId`。

| 集合 | 索引名 | 字段（方向） |
|---|---|---|
| `wishes` | `idx_openid_couple_created` | `_openid`↑ `coupleId`↑ `createdAt`↓ |
| `wishes` | `idx_openid_couple_wishdate` | `_openid`↑ `coupleId`↑ `wishDate`↑ `createdAt`↑ |
| `messages` | `idx_couple_created` | `coupleId`↑ `createdAt`↓ |
| `recipes` | `idx_enabled_category` | `enabled`↑ `category`↑ |
| `daily_records` | `idx_openid_couple_date` | `_openid`↑ `coupleId`↑ `date`↑ |
| `couple_todos` | `idx_couple_created` | `coupleId`↑ `createdAt`↓ |

第二条 `wishes` 索引服务「这天的愿望」：心愿按**业务日期** `wishDate` 等值查询，
不再用 `createdAt` 冒充日记日期（补写历史日期时 `createdAt` 是实际写库那一刻，会错位）。
两条索引并存：第一条继续服务心愿列表与无 `wishDate` 的历史文档兜底，第二条服务按日期取心愿。
忘建第二条不会崩，`getPartnerView` 会各自降级并打日志（`[day-wishes-date-fail]` /
`[day-wishes-range-fail]`），但历史日期可能看不到本该显示的心愿。

> **`wishes.wishDate` 字段口径**（string，`YYYY-MM-DD`，北京时间自然日）：只由 `dailyRecord.save`
> 按**记录自身的 `date`** 写入，客户端传不了；一经写入不再改动（`syncWishes` 只 `add` 不 `update`），
> 因此改记录日期搬不动旧心愿。`createdAt` 仍保留真实写库时间，语义不变。
> 判重键 = `_openid + coupleId + wishDate + type + text`（同日同文本不重复，跨日相同文本各自独立），
> 没有唯一索引参与判重。
>
> 历史心愿（没有 `wishDate`）**不迁移、不补字段、不删除**：读取时退回 `createdAt` 的北京日期，
> 这是近似值（补写过的历史记录会被算到实际写库那天），不做任何自动回填。

创建方式：云开发控制台 → 数据库 → 对应集合 → 索引管理；或参考 `scripts/create-indexes.ps1`（需先安装并登录 CloudBase CLI，且以 `tcb db nosql execute --help` 核对语法）。

---

## 4. 必需云函数部署

`cloudfunctions/` 下共 16 个云函数，逐个右键 → **「上传并部署：云端安装依赖」**。

**小程序端（11 个，必需）**

`login` · `bindCouple` · `dailyRecord` · `getPartnerView` · `menstrual` · `aiSummary` · `deleteAccount` · `profileStats` · `lifePlanner` · `reminderCheck` · `writing`

**桌面端（5 个，仅 Windows 桌面版需要）**

`desktopAuthPublic` · `desktopAuthMiniapp` · `desktopDaily` · `userIdentity` · `userUidMigration`

| 云函数 | 触发方式 | 作用 |
| --- | --- | --- |
| `desktopAuthPublic` | HTTP | 桌面端唯一登录入口（create / status / consume / validate / logout） |
| `desktopAuthMiniapp` | 小程序 callFunction | 手机扫码后的 inspect / confirm / cancel，身份取自 `getWXContext().OPENID` |
| `desktopDaily` | HTTP + Bearer | 读写 `daily_records` 的 `goals` / `todos` |
| `userIdentity` | 小程序 callFunction | `openid → user_uid` 身份映射 |
| `userUidMigration` | 手动调用 | 为历史用户补 `user_uid`（一次性工具，默认 dry-run） |

> **未部署这 5 个函数不影响小程序任何功能**，只影响 Windows 桌面版能否登录。

### 桌面端 HTTP 触发路径

`desktopAuthPublic` 与 `desktopDaily` 需要在云开发控制台单独创建 HTTP 访问路径：

| 云函数 | HTTP 路径 |
| --- | --- |
| `desktopAuthPublic` | `/desktop-auth` |
| `desktopDaily` | `/desktop-daily` |

建好后把基址（形如 `https://<环境ID>.<区域>.app.tcloudbase.com`）填进桌面端的
`desktop.config.json`（见 `desktop/README.md` §2）。**该基址不要写进仓库。**

### `cloudfunctions/` 根目录的 6 个 .js 文件是什么

`loginSessionCore.js` · `desktopSessionCore.js` · `loginSessionRepository.js` ·
`desktopSessionRepository.js` · `cloudLoginSessionRepository.js` ·
`cloudDesktopSessionRepository.js`

它们不是云函数，是**共享源码与测试锚点**：

- 各云函数目录内有同名副本（云函数必须独立打包，不能跨目录 require）；
- 根目录 `tests/` 直接 `require` 它们做单元测试。

修改这些模块时，请同步更新对应的云函数目录副本，否则会出现「测试通过但线上跑的是旧逻辑」。

> 每个云函数独立打包，运行时代码不得跨云函数目录 `require('../其他函数')`（见 `tests/deploy-isolation.test.js`）。

---

## 5. 环境变量

微信云开发的环境变量按「云函数」逐个配置。集中示例见根目录 `.env.example`：

| 云函数 | 变量 | 说明 |
|---|---|---|
| aiSummary / lifePlanner | `AI_API_URL` | OpenAI 兼容接口地址（留空则走内置降级模板） |
| aiSummary / lifePlanner | `AI_API_KEY` | AI 接口密钥（**仅填云端，绝不提交仓库**） |
| aiSummary / lifePlanner | `AI_MODEL` | 模型名（缺省 `gpt-3.5-turbo`） |
| dailyRecord / getPartnerView / menstrual | `TPL_CHAT` | 聊天通知模板 ID（覆盖 `config.js` 默认占位符） |
| dailyRecord / getPartnerView / menstrual | `TPL_PERIOD` | 经期提醒模板 ID（覆盖 `config.js` 默认占位符） |
| reminderCheck | `TPL_REMIND` | 目标提醒模板 ID（未配置则静默跳过，不误发） |

---

## 6. 触发器

| 触发器名 | 云函数 | cron | 超时 | 说明 |
|---|---|---|---|---|
| `dailySummary` | aiSummary | `0 0 22 * * * *` | 60s | 每晚 22:00 生成当日 AI 小结 |
| `periodRemind` | menstrual | `0 0 9 * * * *` | 20s | 每天 09:00 经期提醒扫描 |

> `reminderCheck` 默认**不配置触发器**（避免未经授权的真实通知）。确认模板已申请、且理解其发送逻辑后再自行决定是否启用。

---

## 7. 上线前检查

- 本地测试全绿：`for f in tests/*.test.js; do node "$f" || exit 1; done`
- 小程序主包 < 2MB（`tests/package-size.test.js` 守护）。
- `config.js` 与 `notify.js` 的模板 ID 已替换为**同一个**真实模板 ID（`tests/couple-notify.test.js` 守护一致性）。
- 隐私说明页（`pages/privacy/privacy`）已注册，联系方式按平台要求补充。

---

## 8. 真云验收项（本地测试证明不了，部署后请逐条核）

本地跑的是「真实云函数代码 + 内存假数据库」，**只能证明代码逻辑，不能证明 SDK 行为**。
下表这些项不要凭本地测试结果当作已验证：

| # | 待核项 | 为什么本地证明不了 | 怎么核 |
|---|---|---|---|
| V1 | 集合不存在时 `add()` 返回 `-502005` | 内存库没有这个错误码 | 部署前先只读 `count()` 确认集合存在 |
| V2 | `where({_id,...}).update()` 返回 `{ stats: { updated: n } }` | 返回形状是内存库自己造的 | 确认一次今日决定 → `ok:true` + `mode:created`；再确认一次 → `mode:replaced` |
| V3 | `where({_id,...}).remove()` 返回 `{ stats: { removed: n } }` | 同上 | 删一条共同待办 → 该条消失且 `ok:true`；再删同一条 → `NOT_FOUND` |
| V4 | `add({data:{_id}})` 支持自定义 `_id` | 同上 | 控制台看 `day_choices` 的 `_id` 形如 `dc_2026-10-26_m_<12hex>` |
| V5 | 复合索引真的生效 | 本地无索引概念 | 控制台索引状态为「已生效」；云函数日志里没有 `[day-wishes-date-fail]` / `[day-wishes-range-fail]` |
| V6 | 客户端不能直读直写三个新集合 | 本地无权限模型 | 小程序里直接 `db.collection('couple_todos').get()` / `.add()` 应失败 |
| V7 | 北京时间自然日 | 已用固定 +08:00 偏移（不依赖运行时区），逻辑本地已测 | 北京时间 00:30 确认一次今日决定 → `date` 必须是当天 |
- §2 的三个新增集合已建好，且权限为「仅云函数可读写」；用小程序客户端直接
  `wx.cloud.database().collection('couple_todos').get()` 应失败或返回空，`add()` 应被拒。
- §3 的 6 个索引已在控制台状态为「已生效」。`scripts/create-indexes.ps1` 只覆盖最早的 4 个，
  新增的两条（`wishes` 的 `wishDate` 索引、`couple_todos` 索引）请按 §3 在控制台手动创建 ——
  该脚本从未在本仓库验证执行过，以控制台手动创建为准。
