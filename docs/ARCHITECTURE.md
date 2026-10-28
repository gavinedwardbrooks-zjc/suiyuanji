# 架构说明 · 碎愿集（Suiyuanji）

> 面向需要改动本项目代码的开发者。只描述**当前源码能证实**的事实。
> 部署步骤见 [DEPLOYMENT.md](./DEPLOYMENT.md)，字段细节见 [DATA_MODEL.md](./DATA_MODEL.md)。

---

## 1. 一句话架构

**一个微信小程序 + 一组微信云函数 + 一个可选的 Windows 桌面客户端**，
三者共用同一套云数据库；所有业务判断都在云函数里，客户端不被信任。

```
┌────────────────────┐        ┌──────────────────────┐
│ 微信小程序（15 页）│        │ Windows 桌面端（可选）│
│ 原生 WXML/WXSS/JS  │        │ Tauri 2 + React 19   │
└─────────┬──────────┘        └──────────┬───────────┘
          │ wx.cloud.callFunction        │ HTTPS（Bearer desktopToken）
          │ 身份 = getWXContext().OPENID │ 身份 = 服务端解析 token → user_uid
          ▼                              ▼
┌───────────────────────────────────────────────────────┐
│ 微信云开发 · 云函数（16 个，彼此不互相调用）           │
│  · 小程序侧 11 个：login / bindCouple / dailyRecord /  │
│    getPartnerView / menstrual / aiSummary / …          │
│  · 桌面侧 3 个：desktopAuthPublic / desktopAuthMiniapp │
│    / desktopDaily                                      │
│  · 工具/迁移 2 个：userIdentity / userUidMigration     │
└─────────────────────────┬─────────────────────────────┘
                          ▼
┌───────────────────────────────────────────────────────┐
│ 云数据库（17 个集合）+ 云存储                          │
└───────────────────────────────────────────────────────┘
```

**关键点**：云函数**之间没有调用关系**（全仓无 `callFunction`）。
每个函数独立打包、独立部署，只依赖自己目录内的文件。这一条决定了下文的「共享模块副本机制」。

---

## 2. 运行单元清单

| 单元 | 数量 | 位置 | 技术 |
|---|---|---|---|
| 小程序页面 | 15 | `pages/` | 原生 WXML / WXSS / JS |
| 自定义组件 | 5 | `components/` | `card-skeleton` `goal-card` `mood-weather` `score-picker` `todo-item` |
| 云函数 | 16 | `cloudfunctions/<name>/` | Node.js + `wx-server-sdk ~2.6.3` |
| 云函数共享模块 | 6 | `cloudfunctions/*.js`（根级） | 纯 Node，无 SDK 依赖 |
| 桌面端前端 | 1 SPA | `desktop/src/` | React 19 + TypeScript 5.8 + Vite 7 |
| 桌面端后端 | 1 进程 | `desktop/src-tauri/src/` | Rust + Tauri 2 |
| 本地测试 | 83 | `tests/` | 纯 Node 脚本 + 内存 Mock（无测试框架） |
| 客户端工具模块 | 16 | `utils/` | 原生 JS（含 `desktop-qr.js` 二维码解析） |

---

## 3. 关键业务模块

| 模块 | 页面 | 主要云函数 | 说明 |
|---|---|---|---|
| 登录与建档 | 全局 `app.js` | `login` | 静默登录，首次建档生成 8 位绑定码与 `user_uid` |
| 情侣配对 | `pages/mine` | `bindCouple` | `pending → active`，换绑时旧关系置 `superseded` |
| 每日记录 | `pages/record` | `dailyRecord` | 目标 / 小事 / 三段日记 / 心情天气 / 打分，`revision` 乐观锁 |
| 首页仪表盘 | `pages/home` | `getPartnerView` `profileStats` | 最近 7 天回顾、纪念日、经期卡 |
| 我们（伴侣视角） | `pages/ours` | `getPartnerView` | 按角色渲染 `her` / `him` 视图，含心愿、悄悄话、共同待办 |
| 纸间心事（阅读） | `pages/reading` `reading-txt` | `dailyRecord.addRead` | 本地优先 + 云端迁移，阅读分钟在**事务内**累加 |
| 日历 / 经期 | `pages/calendar` | `menstrual` | 记录与预测；共享默认关闭，需本人授权 |
| 今日决定 | `pages/food` `recipe` `travel` | `lifePlanner` | 三菜组合 / 旅行攻略，记录方确认后双方同见 |
| AI 小结 | 首页 | `aiSummary` | 定时生成；无 AI Key 时降级为内置模板 |
| 数据删除 | `pages/mine` | `deleteAccount` | `preview` 展示影响范围 → `execute` 二次确认 |
| 桌面扫码授权 | `pages/desktop-login-confirm` | `desktopAuthMiniapp` `desktopAuthPublic` | 见 §6 |
| 桌面日记读写 | —（桌面端） | `desktopDaily` | 只碰 `goals` / `todos` |

---

## 4. 主要数据流

### 4.1 小程序静默登录

```
app.js onLaunch
  ├─ require('./config') → isCloudEnvReady()? 否 → 拒绝 wx.cloud.init（fail-closed）
  └─ wx.cloud.callFunction('login')
        ├─ getWXContext().OPENID（客户端传什么都不看）
        ├─ users 无记录 → 建档：role='her' / bindCode / user_uid / schemaVersion=2
        └─ 有记录 → 惰性补 user_uid、惰性迁移 schemaVersion、补 bindCode
```
返回 `{ openid, user_uid, role, coupleId, nickName, partnerName, bindCode }`，
写入 `app.globalData`，页面通过 `app.whenReady(cb)` 等待。

### 4.2 每日记录保存（幂等 + 乐观锁）

```
record 页 → dailyRecord.save
  { requestId, revision, goals, todos, segments, mood, ... }
    ├─ lastRequestId === requestId → 幂等返回当前 revision（不重复写）
    ├─ revision 不匹配 → REV_CONFLICT（拒绝覆盖）
    └─ 匹配 → 写库、revision + 1；顺带 syncWishes 写当日心愿（wishDate 由服务端定）
```

### 4.3 伴侣视角（`getPartnerView`）

一个函数承担「我们」页与首页的读请求，靠 `role` + 分享授权决定可见范围：

```
getPartnerView.view
  ├─ 本人字段：全量
  ├─ 伴侣字段：打分、心愿、经期区间、AI 小结 —— 且需本人已授权共享
  └─ 日记正文：仅当 record_shares 中该日期 enabled === true（严格布尔）
                且 share.coupleId === 当前生效关系
```

### 4.4 桌面扫码登录（详见 [DESKTOP_HANDOVER.md](./DESKTOP_HANDOVER.md)）

```
桌面 → desktopAuthPublic.create → sessionId + nonce + pollSecret（后两者只在内存/二维码分离持有）
手机 → 扫二维码（只含 sessionId + nonce）→ desktopAuthMiniapp.inspect / confirm
桌面 → 轮询 status → consume（校验 pollSecret）→ desktopToken（只进 Rust 内存）
```

---

## 5. 身份与权限边界

### 5.1 字段关系

```
_openid（微信身份，唯一真源）
   └─ users.user_uid（业务身份，登录时惰性生成；给桌面端用，避免跨端传 openid）
        ├─ users.coupleId ──→ couples.coupleId（当前生效关系）
        └─ users.role = 'her' | 'him'（关系里的两个位置，**不是生理性别**）

couples.herOpenid / couples.himOpenid（关系两侧的 openid）
daily_records._openid / .coupleId（记录属主 + 产生时的关系，创建时写一次，不可变）
```

### 5.2 权限边界

| 边界 | 规则 | 实现位置 |
|---|---|---|
| 身份来源 | 小程序只认 `getWXContext().OPENID`；桌面只认 Bearer token → `user_uid` → `users._openid` | 各云函数 `index.js` |
| 客户端字段 | **不信任** `openid` / `user_uid` / `coupleId` / `role` | 全仓无 `event.openid` 取值 |
| 数据归属 | 写入前用服务端解析出的 `_openid` 作为查询/写入条件 | `dailyRecord` `desktopDaily` |
| 跨情侣隔离 | `coupleId` 变了 → 旧数据对新伴侣不可见（数据保留、不迁移） | `wish-scope.js` `record-share.js` |
| 日记分享 | 按**日期**逐天授权，默认关闭，`enabled === true` 才算 | `getPartnerView/record-share.js` |
| 敏感集合 | `record_shares` / `day_choices` / `couple_todos` 权限必须「仅云函数可读写」 | 见 [DEPLOYMENT.md](./DEPLOYMENT.md) §2 |
| 密钥分层 | 客户端只放环境 ID / 模板 ID；AI Key / AppSecret 只在云函数环境变量 | `config.js` 注释 + `.env.example` |

---

## 6. 共享模块与副本机制（最容易踩的坑）

### 6.1 为什么有副本

微信云开发**每个云函数独立打包**，运行时只能访问自己目录里的文件：

- 不能 `require('../其他函数/xxx')` —— 部署后目录不完整，直接 `MODULE_NOT_FOUND`
  （`tests/deploy-isolation.test.js` 静态守卫这一条）；
- 所以同一份源码要在每个用到它的函数目录里**各存一份**。

### 6.2 结构

```
cloudfunctions/
├── loginSessionCore.js                 ← 源模块（也是测试的 require 目标）
├── desktopSessionCore.js
├── loginSessionRepository.js
├── desktopSessionRepository.js
├── cloudLoginSessionRepository.js
├── cloudDesktopSessionRepository.js
├── desktopAuthPublic/
│   ├── index.js
│   └── loginSessionCore.js …           ← 副本（必须是同一份内容）
├── desktopAuthMiniapp/
│   └── loginSessionCore.js …           ← 副本
└── desktopDaily/
    └── loginSessionCore.js …           ← 副本
```

当前实测（2026-10-28）：4 组模块、共 **9 份副本**，组内内容逐字节一致：

| 模块 | 副本位置 | 副本数 |
|---|---|---|
| `loginSessionCore.js` | `desktopAuthPublic/` `desktopAuthMiniapp/` `desktopDaily/` | 3 |
| `cloudLoginSessionRepository.js` | `desktopAuthPublic/` `desktopAuthMiniapp/` | 2 |
| `desktopSessionCore.js` | `desktopAuthPublic/` `desktopDaily/` | 2 |
| `cloudDesktopSessionRepository.js` | `desktopAuthPublic/` `desktopDaily/` | 2 |

> 另外两个根级模块（`desktopSessionRepository.js`、`loginSessionRepository.js`）是**内存实现**，
> 只被 `tests/` require，**没有任何目录副本**。

### 6.3 同步要求（改动前必读）

单元测试 `require` 的是**根级**模块，云函数运行时用的是**目录内副本**。
只改根级、忘了副本的结果是：**测试全绿，线上跑的还是旧代码**。

改完根级模块后必须复制：

```powershell
cd cloudfunctions
Copy-Item loginSessionCore.js desktopAuthPublic\loginSessionCore.js -Force
Copy-Item loginSessionCore.js desktopAuthMiniapp\loginSessionCore.js -Force
Copy-Item loginSessionCore.js desktopDaily\loginSessionCore.js -Force
Copy-Item cloudLoginSessionRepository.js desktopAuthPublic\cloudLoginSessionRepository.js -Force
Copy-Item cloudLoginSessionRepository.js desktopAuthMiniapp\cloudLoginSessionRepository.js -Force
Copy-Item desktopSessionCore.js desktopAuthPublic\desktopSessionCore.js -Force
Copy-Item desktopSessionCore.js desktopDaily\desktopSessionCore.js -Force
Copy-Item cloudDesktopSessionRepository.js desktopAuthPublic\cloudDesktopSessionRepository.js -Force
Copy-Item cloudDesktopSessionRepository.js desktopDaily\cloudDesktopSessionRepository.js -Force

# 同步完立刻验证（D1 会逐字节比对，不一致就红）
cd ..
node tests/cloudfunction-shared-modules.test.js
```

### 6.4 守卫测试（三条，缺一不可）

| 测试 | 保证什么 |
|---|---|
| `tests/cloudfunction-shared-modules.test.js` | D1 副本与源模块**逐字节一致**（忽略换行差异）；D2 `index.js` 调用的成员在目录内依赖里真实导出；D3 每个相对依赖在目录内存在（否则一部署就 `MODULE_NOT_FOUND`） |
| `tests/core-consistency.test.js` | 各函数目录的本地复制核心彼此一致 |
| `tests/deploy-isolation.test.js` | 运行时代码不得跨云函数目录 `require('../…')` |

提交前跑这三条，比跑一次部署便宜得多。

---

## 7. 关键设计决策

| 决策 | 为什么 | 代价 |
|---|---|---|
| 业务判断全在云函数 | 客户端可被改，数据库权限模型不足以表达「伴侣视角」 | 每个读操作都要过一次云函数调用 |
| 云函数之间不互调 | 独立打包、独立回滚，一个函数坏不连坐 | 共享逻辑只能靠源码副本，需要测试兜住 |
| `openid` 与 `user_uid` 双轨 | `openid` 只在微信侧有意义，桌面端不该接触 | 多一层反查；`user_uid` 需要惰性回填 |
| `role` 用 `her` / `him` | 产品是「两个人」的两侧，不是性别 | 命名容易被误读，注释里反复声明 |
| 记录 `coupleId` 创建时写一次、永不改 | 换绑后要能判断「这条数据产生于哪段关系」 | 换绑期间数据归属不可修正 |
| 客户端配置分三层 | 真实环境 ID 不进仓库，同时保证缺配置时 fail-closed | 新开发者多一步 `init-local-config.js` |
| 桌面 token 只存内存 | 不给磁盘上的 token 留任何窃取面 | 每次启动都要重新扫码 |
| `reminded` 由服务端维护 | 客户端能改它就能伪造/重置提醒状态 | 桌面对该字段只能读、不能写（见 [DATA_MODEL.md](./DATA_MODEL.md) §5） |
| 测试不用框架 | 零依赖、`node tests/x.test.js` 就能跑 | 断言与汇总要自己写，风格不统一 |

---

## 8. 已知技术债

| # | 技术债 | 影响 | 状态 |
|---|---|---|---|
| 1 | 共享模块靠手工复制 | 忘记同步 → 测试绿、线上旧代码 | 有 3 条守卫测试兜住，未根治 |
| 2 | 桌面端 3 个云函数未部署 | 桌面版不能用 | 冻结在 `aee3995`，见 [DESKTOP_HANDOVER.md](./DESKTOP_HANDOVER.md) |
| 3 | `desktopAuthPublic.create` 无速率限制 | 可被刷、放大存储成本（非越权） | 未修，已列为部署前必办 |
| 4 | 桌面 token 不持久 | 每次启动重扫码 | 设计取舍 |
| 5 | 云函数运行时为 UTC | `getPartnerView` 的 `fmt(new Date())` 在**北京时间 00:00–08:00** 取到的是前一天，`days` 会差一天 | 既有行为，未修 |
| 6 | `bindCouple/core.js` 在事务内使用 `where()` | 与官方「事务内不支持 where」的限制冲突 | 未修，属已知疑点 |
| 7 | `tests/config-local.test.js` C8 依赖被 gitignore 的本地报告 | 全新克隆会红一条 | 未修（改测试属代码变更） |
| 8 | `scripts/create-indexes.ps1` 只覆盖早期 4 个索引 | 新增索引要手工建 | 以 [DEPLOYMENT.md](./DEPLOYMENT.md) §3 为准 |
| 9 | 无人值守的端到端测试 | 真实扫码、真实 SDK 行为无自动化覆盖 | 只能人工验收 |

---

## 9. 想继续读什么

- 具体字段与集合 → [DATA_MODEL.md](./DATA_MODEL.md)
- 每个云函数的职责与部署前提 → [CLOUD_FUNCTIONS.md](./CLOUD_FUNCTIONS.md)
- 环境怎么搭、报错怎么查 → [DEVELOPMENT.md](./DEVELOPMENT.md)
- 桌面版的一切 → [DESKTOP_HANDOVER.md](./DESKTOP_HANDOVER.md)
