# 云函数说明 · 碎愿集（Suiyuanji）

> 16 个云函数，分三类：小程序侧 11 个、桌面侧 3 个、工具/迁移 2 个。
> **云函数之间没有任何调用关系**（全仓无 `callFunction`），每个都独立打包、独立部署、独立回滚。
> 部署操作手册见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

---

## 1. 总览

| # | 云函数 | 触发方式 | 类别 | 一句话职责 |
|---|---|---|---|---|
| 1 | `login` | 小程序 callFunction | 小程序 | 静默登录 + 首次建档 + 惰性迁移 |
| 2 | `bindCouple` | 小程序 callFunction | 小程序 | 情侣配对状态机 |
| 3 | `dailyRecord` | 小程序 callFunction | 小程序 | 每日记录读写、阅读分钟累加 |
| 4 | `getPartnerView` | 小程序 callFunction | 小程序 | 「我们」页 / 首页的读模型 + 分享与共同待办 |
| 5 | `menstrual` | 小程序 callFunction + 定时触发器 | 小程序 | 经期记录、预测、提醒 |
| 6 | `aiSummary` | 小程序 callFunction + 定时触发器 | 小程序 | AI 小结 / 周报（可降级为模板） |
| 7 | `deleteAccount` | 小程序 callFunction | 小程序 | 注销预览与执行 |
| 8 | `profileStats` | 小程序 callFunction | 小程序 | 最近 7 天回顾 |
| 9 | `lifePlanner` | 小程序 callFunction | 小程序 | 今天吃什么 / 今天去哪里 + 今日决定 |
| 10 | `reminderCheck` | 定时触发器（默认不配） | 小程序 | 目标提醒扫描 |
| 11 | `writing` | 小程序 callFunction | 小程序 | 随笔 CRUD |
| 12 | `desktopAuthPublic` | **HTTP（公开）** | 桌面 | 桌面登录唯一入口 |
| 13 | `desktopAuthMiniapp` | 小程序 callFunction | 桌面 | 手机端扫码后的 inspect / confirm / cancel |
| 14 | `desktopDaily` | **HTTP（Bearer）** | 桌面 | 桌面读写当日 `goals` / `todos` |
| 15 | `userIdentity` | 小程序 callFunction | 工具 | `openid → user_uid` 映射（内部） |
| 16 | `userUidMigration` | 手动调用 | 迁移 | 为历史用户补 `user_uid`（默认 dry-run） |

**只部署前 11 个，小程序即可完整可用。** 桌面侧 3 个不部署只影响桌面版。

---

## 2. 小程序侧（11 个）

### 2.1 `login`

| 项 | 内容 |
|---|---|
| 入参 | 无（身份来自 `getWXContext().OPENID`） |
| 返回 | `{ openid, user_uid, role, coupleId, nickName, partnerName, avatarUrl, bindCode }` |
| 首次调用 | 建档：`role='her'`、生成 8 位 `bindCode`、生成 `user_uid`、`schemaVersion=2` |
| 老用户 | 惰性补 `user_uid`（`user_uid = null` 时 CAS 写入）、惰性迁移 `schemaVersion`、缺 `bindCode` 时补一个 |
| 硬约束 | **绝不重置失败限流计数**（PRD Gate P0-01） |

### 2.2 `bindCouple`

| action | 作用 |
|---|---|
| `status` | 当前绑定状态（未绑定 / pending / active / 被 superseded） |
| `generate` | 她生成配对码（8 位），旧 pending 自动 supersede |
| `claim` | 他输入配对码认领（有失败限流） |
| `confirm` | 她确认接受 / 拒绝 |
| `cancel` | 取消 pending |
| `unbind` | 解绑（旧关系置 `unbound`，数据保留不删） |

核心状态机在 `bindCouple/core.js`，`index.js` 只做参数解析。

### 2.3 `dailyRecord`

| action | 作用 |
|---|---|
| `get` | 读某天记录 |
| `save` | 写记录：`requestId` 幂等 + `revision` 乐观锁；顺带同步当日心愿 |
| `addRead` | 阅读分钟累加，**在数据库事务内**保证同一 `requestId` 并发只累计一次 |

**幂等契约**：`lastRequestId === requestId` → 幂等返回当前 `revision`；
`revision` 不匹配 → `REV_CONFLICT` 拒绝覆盖。

### 2.4 `getPartnerView`

一个函数承担「我们」页与首页的大部分读请求，是**最复杂的读模型**：

| action | 作用 |
|---|---|
| `view`（默认） | 按当前角色渲染 `her` / `him` 视图 |
| `shareStatus` / `shareSet` | 记录级分享的读取与开关（`expectedRev` CAS） |
| `msg` / `readMsg` | 悄悄话（读取上限 50 条，无分页） |
| `mark` / `sub` | 已读标记、订阅授权登记 |
| `setAnniversary` / `setPartnerName` | 纪念日、自定义称呼 |
| `coupleTodo` | 双方共同待办（增 / 勾 / 删） |

可见范围由 `record-share.js` 与 `wish-scope.js` 决定：**默认不可见，按日期逐天授权**。

### 2.5 `menstrual`

| action | 作用 |
|---|---|
| `get` / `save` / `month` | 记录、按月标记、预测 |
| `subPeriod` / `remindPrefs` | 订阅授权、提醒偏好 |
| `sharePeriod` | 是否对伴侣展示区间（默认关闭，服务端判定） |
| `remindTick` | 定时触发器调用：扫描并发送提醒 |

日期算法集中在 `menstrual/dates.js`（唯一实现，提醒扫描复用同一套）。

### 2.6 `aiSummary`

| action | 作用 |
|---|---|
| `daily` | 生成当日小结（`herSummary` + `partnerSummary`，按 `openid+date+type` 幂等） |
| `weekly` | 周报 |
| `cron` | 定时触发器入口 |

依赖 `AI_API_URL` / `AI_API_KEY` / `AI_MODEL`。**未配置时自动降级为内置模板**，不会报错。

### 2.7 `deleteAccount`

| action | 作用 |
|---|---|
| `preview` | 返回影响范围（删哪些、留哪些），供前端二次确认 |
| `execute` | 执行注销 |

### 2.8 `profileStats`

`action: 'week'` —— 首页最近 7 天回顾（含今天，连续 7 个自然日）。身份只取自 `getWXContext()`。

### 2.9 `lifePlanner`

今天吃什么 / 今天去哪里，含种子数据管理：

| 分组 | action |
|---|---|
| 食谱 | `seedRecipes` `migrateRecipes` `diagnoseRecipes` `repairRecipes` `listRecipes` `randomMeal` `getRecipe` `saveRecipe` `regenerateRecipe` |
| 旅行 | `seedTravelPlaces` `diagnoseTravelPlaces` `repairTravelPlaces` `listTravelPlaces` `randomTravel` `getTravelPlace` `saveTravelPlace` `regenerateTravelPlace` |
| 今日决定 | `getDayChoice` `confirmDayChoice` |

> `regenerate*` 依赖外部 AI 接口，未配置时不可用（前端入口已隐藏）。

### 2.10 `reminderCheck`

无 `action`。定时触发器扫描当日 `daily_records`，对「开了提醒 + 未完成 + 未提醒过 + 到点」的目标
发送订阅消息，并把该目标标记为 `reminded: true`。

- 依赖 `TPL_REMIND`，**未配置则静默跳过**（不误发）。
- 默认**不配置触发器** —— 避免未经用户授权的真实通知。

### 2.11 `writing`

随笔 CRUD：`create` / `list` / `get` / `update` / `delete`。

---

## 3. 桌面侧（3 个 · 均未部署）

> ⚠️ **这三个函数从未上传到任何云环境**，真实链路 0 项验收。
> 上线前必读 [DESKTOP_HANDOVER.md](./DESKTOP_HANDOVER.md)。

### 3.1 `desktopAuthPublic`（HTTP）

| action | 作用 | 鉴权 |
|---|---|---|
| `create` | 创建登录会话，返回 `sessionId` + `nonce` + `pollSecret` + `expiresAt` | 无（公开） |
| `status` | 轮询登录状态 | `sessionId` + `pollSecret` |
| `consume` | 换取 `desktopToken` | `sessionId` + `pollSecret` |
| `validate` | 校验 token | `Authorization: Bearer` |
| `logout` | 撤销会话 | `Authorization: Bearer` |

已知缺口：**`create` 没有速率限制**（见 [SECURITY.md](../SECURITY.md)）。

### 3.2 `desktopAuthMiniapp`（小程序 callFunction）

| action | 作用 |
|---|---|
| `inspect` | 扫码后查看「哪台电脑在请求登录」 |
| `confirm` | 用户点确认，把会话置为 `approved` |
| `cancel` | 拒绝 |

身份取自 `getWXContext().OPENID` → `users.user_uid`；**必须与小程序同环境**。

### 3.3 `desktopDaily`（HTTP + Bearer）

| action | 作用 |
|---|---|
| `get` | 读某天的 `goals` / `todos` |
| `save` | 字段级合并这两个字段（`requestId` 幂等 + `revision` 乐观锁） |

- 身份：Bearer → `validateDesktopSession` → `user_uid` → `users._openid` 反查。
- **不碰** `segments` / `mood` / `wishes` / `score` / `readProgress` 等字段。
- `reminded` 由服务端继承，客户端传什么都不会生效（见 [DATA_MODEL.md](./DATA_MODEL.md) §5）。

---

## 4. 工具与迁移（2 个）

| 函数 | 说明 |
|---|---|
| `userIdentity` | 内部函数，`openid → user_uid` 的 ensure 接口；OPENID 只来自云上下文 |
| `userUidMigration` | 一次性迁移工具：`diagnose` / `dryRun` / `execute`，**默认只读**。执行前需维护者批准 |

> **`userUidMigration` 不需要为正常使用而运行**：`login` 已经会惰性补 `user_uid`。

---

## 5. 调用关系

```
微信小程序 ──callFunction──► login / bindCouple / dailyRecord / getPartnerView /
                             menstrual / aiSummary / deleteAccount / profileStats /
                             lifePlanner / writing / desktopAuthMiniapp / userIdentity

Windows 桌面 ──HTTPS──► desktopAuthPublic  （/desktop-auth）
             ──HTTPS──► desktopDaily       （/desktop-daily，带 Bearer）

定时触发器 ──► aiSummary.cron（每天 22:00）
           ──► menstrual.remindTick（每天 09:00）
           ──► reminderCheck（默认不配）

维护者手动 ──► userUidMigration（diagnose → dryRun → execute）
```

**没有横向调用**：`getPartnerView` 不会去调 `dailyRecord`，`desktopDaily` 也不会调 `login`。
共享逻辑一律通过「源码副本」实现（下一节）。

---

## 6. 共享模块结构

`cloudfunctions/` 根级的 6 个 `.js` **不是云函数**，是共享源码 + 测试锚点：

| 模块 | 作用 | 目录副本 |
|---|---|---|
| `loginSessionCore.js` | 登录会话状态机（pending→approved→consumed，5 分钟 TTL） | 3 |
| `desktopSessionCore.js` | 桌面会话（签发 / 校验 / 换发 / 撤销，30 天 TTL） | 2 |
| `cloudLoginSessionRepository.js` | 登录会话的云数据库适配层 | 2 |
| `cloudDesktopSessionRepository.js` | 桌面会话的云数据库适配层 | 2 |
| `loginSessionRepository.js` | 登录会话内存实现（仅供测试） | 0 |
| `desktopSessionRepository.js` | 桌面会话内存实现（仅供测试） | 0 |

**改动这些模块后必须同步目录副本**，否则测试绿、线上跑旧代码。
详见 [ARCHITECTURE.md](./ARCHITECTURE.md) §6，守卫测试：
`cloudfunction-shared-modules.test.js`、`core-consistency.test.js`、`deploy-isolation.test.js`。

---

## 7. 身份认证与权限校验

### 7.1 小程序侧（12 个函数）

```js
const { OPENID } = cloud.getWXContext()   // 唯一身份来源
```

- 客户端提交的 `openid` / `user_uid` / `coupleId` / `role` 一律**不看**；
- 写库前用服务端解析出的 `_openid` 作为 `where` 条件（不会写到别人名下）；
- 伴侣视角的可见性由服务端按 `coupleId` + 分享授权判定，不靠前端隐藏。

### 7.2 桌面侧

```
HTTP Authorization: Bearer <desktopToken>
  → hashToken(token) → desktop_sessions.tokenHash
  → 校验 status === 'active' 且 now < expiresAt
  → 取出 user_uid
  → users.where({ user_uid }) → _openid
```

`desktopDaily` 的每一次读写都走这条链，**不存在「跳过校验」的分支**。

---

## 8. 开发环境与生产环境

项目**没有内置 dev/prod 双环境机制**。每个函数都是：

```js
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
```

即「部署到哪个环境就绑哪个环境」。由此带来三条实践约束：

| 约束 | 说明 |
|---|---|
| 环境隔离靠**建两个云开发环境** | 想分离测试与生产，需要两个环境各部署一套（仓库未提供脚本，未验证） |
| 客户端只认 `config.local.js` 的 `CLOUD_ENV` | 指向哪个环境就连哪个；缺失时 fail-closed 拒绝初始化 |
| 桌面端只认 `DESKTOP_AUTH_BASE_URL` | 指向哪个环境的 HTTP 路由就连哪个；为空时 fail-closed |

**不要拿生产环境做试验**。改云函数前先在独立测试环境验证。

---

## 9. 部署前置条件

顺序不能颠倒（集合不存在时 `add()` 返回 `-502005`，不会自动建表）：

1. **建集合**（15 个业务集合 + 桌面 2 个），敏感集合权限设「仅云函数可读写」→ [DEPLOYMENT.md](./DEPLOYMENT.md) §2
2. **建索引**（见 §10）
3. **上传云函数**（每个目录右键「上传并部署：云端安装依赖」）
4. **配环境变量**（AI Key、订阅模板 ID）→ [DEPLOYMENT.md](./DEPLOYMENT.md) §5
5. **配触发器**（可选：`dailySummary`、`periodRemind`；`reminderCheck` 默认不配）
6. **配桌面 HTTP 路由**（仅当要跑桌面版）：`/desktop-auth`、`/desktop-daily`
7. **本地测试全绿** → [DEVELOPMENT.md](./DEVELOPMENT.md) §5

---

## 10. 数据库索引要求

### 10.1 业务集合（6 条，`scripts/create-indexes.ps1` 只覆盖前 4 条）

| 集合 | 索引名 | 字段 |
|---|---|---|
| `wishes` | `idx_openid_couple_created` | `_openid`↑ `coupleId`↑ `createdAt`↓ |
| `wishes` | `idx_openid_couple_wishdate` | `_openid`↑ `coupleId`↑ `wishDate`↑ `createdAt`↑ |
| `messages` | `idx_couple_created` | `coupleId`↑ `createdAt`↓ |
| `recipes` | `idx_enabled_category` | `enabled`↑ `category`↑ |
| `daily_records` | `idx_openid_couple_date` | `_openid`↑ `coupleId`↑ `date`↑ |
| `couple_todos` | `idx_couple_created` | `coupleId`↑ `createdAt`↓ |

> 后两条（`wishes` 的 `wishDate`、`couple_todos`）必须**在控制台手工建**，
> 脚本从未在本仓库验证执行过。

### 10.2 桌面认证（4 条，脚本**完全没有**覆盖，必须手工建）

| 集合 | 索引键 | 用途 | 缺失后果 |
|---|---|---|---|
| `login_sessions` | `sessionId` | 每次 create/status/consume 都查 | 全表扫描 |
| `desktop_sessions` | `tokenHash` | **最热路径**，每个桌面请求都查 | 每次日记读写扫全表 |
| `desktop_sessions` | `desktopSessionId` | 状态流转 CAS | 退出/过期落库变慢 |
| `desktop_sessions` | `loginSessionId` | 消费重放恢复 | 换发路径扫全表 |

---

## 11. 部署风险与回滚

| 风险 | 说明 | 回滚 |
|---|---|---|
| 共享模块副本漂移 | 改了根级忘了副本 → 线上旧逻辑 | 重新上传该函数 |
| 索引缺失 | 功能不报错，但随数据增长变慢 | 建索引即可，不影响数据 |
| 集合不存在 | `add()` 返回 `-502005` | 先建集合，再重试 |
| 权限设错 | 敏感集合被客户端直读 → 越权 | 立即改回「仅云函数可读写」 |
| 桌面路由错误 | 桌面端 fail-closed，小程序不受影响 | 删掉路径即可 |
| 小程序包超限 | 上传报 `80051` | 检查 `packOptions.ignore` |

**函数级回滚**：云开发控制台 → 云函数 → 版本管理 → 回滚到上一版本。
三个桌面函数互相独立，可单独回滚。

**影响面**：桌面 3 个函数是**新增**的，不改任何既有函数；`daily_records` 只被桌面按字段级
合并写入 `goals` / `todos`。既有小程序用户不受影响。

---

## 12. 关于桌面认证的现状（重要）

| 项 | 状态 |
|---|---|
| 代码 | ✅ 完整（含 35 个本地模拟用例） |
| 本地模拟联调 | ✅ 通过 |
| 部署到真实云环境 | ❌ **从未执行** |
| 真实扫码登录 | ❌ **UNVERIFIED** |
| 真实跨端日记同步 | ❌ **UNVERIFIED** |
| 速率限制 | ❌ **未实现**，正式对外前必办 |

**不要把「本地测试通过」当作「可以给用户用」。** 完整交接见
[DESKTOP_HANDOVER.md](./DESKTOP_HANDOVER.md)。
