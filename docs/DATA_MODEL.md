# 数据模型 · 碎愿集（Suiyuanji）

> 只写源码能证实的事实。集合与索引的创建步骤见 [DEPLOYMENT.md](./DEPLOYMENT.md)，
> 权限判定的实现见 [ARCHITECTURE.md](./ARCHITECTURE.md) §5。

---

## 1. 集合总览（17 个）

| 集合 | 归属 | 客户端可直读直写 | 说明 |
|---|---|---|---|
| `users` | 个人 | 否（走云函数） | 用户档案、关系指针、配额记账 |
| `couples` | 关系 | 否 | 情侣关系状态机 |
| `daily_records` | 个人 | 否 | 每日记录（目标 / 小事 / 日记 / 心情 / 打分） |
| `wishes` | 个人（可共享） | 否 | 心愿，按业务日期归属 |
| `messages` | 关系 | 否 | 悄悄话（双向留言） |
| `menstrual` | 个人 | 否 | 经期记录与共享开关 |
| `profiles` | 个人 | 否 | 持续画像（供 AI 小结） |
| `weekly_reports` | 个人 | 否 | 周报 |
| `books` | 个人 | **是**（本地优先，见 §3.9） | 书架 / 阅读进度 |
| `recipes` | 全局 | 否 | 食谱种子数据 |
| `travel_places` | 全局 | 否 | 旅行地点种子数据 |
| `writings` | 个人 | 否 | 随笔 |
| `record_shares` | 关系（按日期） | **仅云函数** | 记录级分享授权 |
| `couple_todos` | 关系 | **仅云函数** | 双方共同待办 |
| `day_choices` | 关系（按日期） | **仅云函数** | 今日决定（吃 / 去） |
| `login_sessions` | 桌面登录 | 仅云函数 | 5 分钟登录会话（桌面） |
| `desktop_sessions` | 桌面登录 | 仅云函数 | 30 天桌面会话（桌面） |

> 后 3 个业务集合（`record_shares` / `couple_todos` / `day_choices`）如果权限设成「所有人可读」
> 或「创建者可读写」，`coupleId` / `enabled` / `done` 就能被伪造，越权模型直接失效。

---

## 2. 身份字段：`openid` / `user_uid` / `coupleId` / `role`

```
_openid（微信 openid，唯一真源，只由 getWXContext() 给出）
   │
   └─► users.user_uid（业务身份，'u_' 前缀，登录时惰性生成）
          └─► 桌面端只拿它，不接触 openid

users.coupleId ──► couples.coupleId（当前生效关系，未绑定为 null）
users.role = 'her' | 'him'（关系里的两个位置，**不是生理性别**）
```

| 字段 | 谁写 | 含义 | 备注 |
|---|---|---|---|
| `_openid` | 平台 / 云函数 | 微信身份 | 客户端**无法**伪造（`getWXContext` 注入） |
| `user_uid` | `login`（惰性） | 业务身份 | CAS 写入：`user_uid = null` 时才补，不会覆盖已有值 |
| `coupleId` | `bindCouple`（事务） | 当前生效关系 | 解绑 / 换绑后旧数据仍带旧 `coupleId`（历史证据） |
| `role` | `bindCouple` | `her` / `him` | 生成配对码的一方是 `her`；换绑会重写两侧 `role` |

**为什么双轨**：桌面端不该拿到 `openid`（微信侧标识），也不该能用它直接查库；
`user_uid` 是脱离微信也能表达的业务身份。`user_uid` 由 `login` 在用户首次请求时补齐，
**不需要单独跑迁移**（`userUidMigration` 只是给需要批量处理的场景准备的）。

---

## 3. 逐集合字段

### 3.1 `users`

| 字段 | 类型 | 说明 |
|---|---|---|
| `_openid` | string | 微信身份 |
| `user_uid` | string | 业务身份（登录时补） |
| `role` | `'her' \| 'him'` | 关系位置 |
| `nickName` | string | 默认 `'她'` / `'他'` |
| `partnerName` | string | **我给 TA 的称呼**（空 = 通用「TA」） |
| `avatarUrl` | string | 头像 |
| `coupleId` | string \| null | 当前生效关系 |
| `bindCode` | string | 8 位配对码；绑定成功后 `remove()` |
| `schemaVersion` | number | 当前为 `2` |
| `failCount` / `failWindowStart` | number | 配对码失败限流窗口 |
| `subQuota` | object | 订阅消息额度记账（按模板） |
| `createdAt` | number | 建档时间戳 |

### 3.2 `couples`

| 字段 | 说明 |
|---|---|
| `coupleId` | 关系主键（业务 ID，**不等于**文档 `_id`） |
| `herOpenid` / `himOpenid` | 两侧 openid（`himOpenid` 认领前为 `null`） |
| `status` | `pending` → `active`；终止态 `superseded` / `unbound` / `expired` |
| `requestId` | 生成 / 确认操作的幂等键 |
| `createdAt` / `approvedAt` / `unboundAt` | 时间戳 |

**换绑语义**：新关系生效时，任一方既有的 `active` 关系置 `superseded`（双方方向都查，
不只查 `herOpenid`）。历史数据**不迁移、不删除**。

### 3.3 `daily_records`（核心集合）

| 字段 | 类型 | 说明 |
|---|---|---|
| `_openid` | string | 属主 |
| `date` | string `YYYY-MM-DD` | 业务日期（北京自然日） |
| `goals` | array | 今日目标，最多 10 条，见 §5 |
| `todos` | array | 今日小事，最多 200 条，`{ text, done }` |
| `segments` | object | `{ life, work, growth }` 三段日记正文 |
| `mood` | object | `{ type, weather }` |
| `wishes` | array | 当日心愿原始文本（同步到 `wishes` 集合） |
| `score` | number \| null | 给对方打分 |
| `readProgress` | number | 阅读进度快照 |
| `readRequestIds` | string[] | `addRead` 幂等键（保留最近 N 条） |
| `coupleId` | string \| null | **只在创建时写一次**，之后任何保存都不改写 |
| `revision` | number | 乐观锁；新建为 1，每次成功保存 +1 |
| `lastRequestId` | string | 幂等键（同 `requestId` 不重复写） |
| `schemaVersion` | number | 当前为 `2` |
| `createdAt` / `updatedAt` | number | 时间戳 |

> `coupleId` 只在创建时写，是为了让「这条记录产生于哪一段关系」成为**不可变证据**。
> 读取侧（`getPartnerView` / `aiSummary`）据此判断能不能给伴侣看。

### 3.4 `wishes`

| 字段 | 说明 |
|---|---|
| `_openid` | 属主（只有本人能看见自己的心愿） |
| `coupleId` | 产生时的关系；未绑定为 `null`；**缺失 = 历史文档**（见 §6） |
| `wishDate` | 业务日期 = 记录自身的 `date`；**服务端写，客户端传不了，一经写入不改** |
| `type` / `text` | 心愿分类与正文 |
| `status` | `pending`（未安排）等 |
| `createdAt` | 真实写库时间（**不是**业务日期） |
| `createdNotifyAt` / `createdNotifySkipped` | 通知记账 |

判重键 = `_openid + coupleId + wishDate + type + text`（没有唯一索引参与判重）。

### 3.5 `messages`（悄悄话）

| 字段 | 说明 |
|---|---|
| `coupleId` | 归属关系 |
| `_openid` / `from` | 发送方 |
| `text` | 内容 |
| `createdAt` | 时间戳；读取按 `createdAt` 倒序，**上限 50 条，无分页** |
| `readAt` | 已读时间（`readMsg`） |

### 3.6 `menstrual`

| 字段 | 说明 |
|---|---|
| `_openid` | 属主 |
| 记录主体 | 最近一次开始日 / 周期长度等（算法集中在 `menstrual/dates.js`） |
| `sharePeriod` | 是否允许伴侣查看（**默认关闭**，只有本人能改） |
| `sharePrefsAt` | 偏好变更时间 |
| `revision` / `lastRequestId` | 与 `daily_records` 相同的幂等 + 乐观锁契约 |
| `schemaVersion` | 版本号 |

### 3.7 `record_shares`（记录级分享）

| 字段 | 说明 |
|---|---|
| `_id` | `sh_<ownerOpenid>_<date>`（确定性 ID） |
| `date` | 被分享的日期 |
| `enabled` | **严格布尔**才算授权；`'true'` / `1` 一律不算 |
| `coupleId` | 分享时生效的关系；关系变了旧授权立即失效 |
| `invalidated` | 显式失效标记 |

判定顺序（`getPartnerView/record-share.js`）：`enabled === true` → `coupleId` 与当前关系一致 →
`date` 匹配 → 未 `invalidated`。

### 3.8 `couple_todos`（双方共同待办）

| 字段 | 说明 |
|---|---|
| `coupleId` | 归属关系 |
| `text` | 内容（有长度上限与空值校验） |
| `done` / `doneAt` | 完成状态与时间 |
| `createdAt` | 创建时间 |

排序规则：未完成在前 → 完成时间倒序 → 创建时间倒序。
与个人待办（`daily_records.todos`）**完全隔离**，互不影响。

### 3.9 `books`

| 字段 | 说明 |
|---|---|
| `_openid` | 属主 |
| `minutes` | 累计阅读分钟（**只能在事务内 `inc`**，唯一写入方是 `dailyRecord.addRead`） |
| 其他 | 书名、进度等 |

> 阅读功能是「本地优先」：客户端会直接读写 `books` 集合（全仓唯一被小程序端直接访问的集合）。

### 3.10 `day_choices`（今日决定）

| 字段 | 说明 |
|---|---|
| `_id` | `dc_<date>_<m\|t>_<hash12(coupleId)>`（确定性 ID，同关系同日同类型恒等 → 覆盖更新） |
| `coupleId` | 归属关系（读取时会再比对一次，撞 ID 也只会 fail-closed） |
| `date` / `kind` | 日期与类型（吃 / 去） |
| 决定内容 | 选中的食谱组合 / 旅行地点 |

> 用 `coupleId` 的哈希而不是明文拼进 `_id`：ID 更短，也不把内部标识写进可读主键。

### 3.11 `login_sessions`（桌面登录会话）

| 字段 | 说明 |
|---|---|
| `sessionId` | 业务主键 `dls_…` |
| `nonceHash` | 二维码里 `nonce` 的哈希 |
| `pollSecretHash` | `pollSecret` 的哈希（**明文只存在于发起登录的那台桌面内存**） |
| `status` | `pending` → `approved` → `consumed`；或 `cancelled` / `expired` / `superseded` |
| `user_uid` | 确认登录的用户（`approved` 时写入） |
| `desktopDeviceId` / `desktopDeviceName` | 发起登录的机器 |
| `createdAt` / `expiresAt` | **TTL 5 分钟** |
| `approvedAt` / `consumedAt` / `cancelledAt` / `supersededAt` | 状态时间戳 |

### 3.12 `desktop_sessions`（桌面会话）

| 字段 | 说明 |
|---|---|
| `desktopSessionId` | 业务主键 `dss_…`（**不等于**文档 `_id`） |
| `tokenHash` | token 的 SHA-256（**明文 token 只在 Rust 内存**） |
| `user_uid` / `deviceId` / `deviceName` | 归属与设备 |
| `status` | `active` / `revoked` / `expired` |
| `loginSessionId` | 来源登录会话（用于响应丢失后的恢复） |
| `createdAt` / `expiresAt` / `lastSeenAt` / `revokedAt` | 时间戳；**TTL 30 天，不滑动续期** |

---

## 4. 数据归属与访问权限

| 数据 | 谁能读 | 谁能写 | 实现 |
|---|---|---|---|
| 三段日记正文 / 心情细节 | 只有本人 | 只有本人 | `dailyRecord` 按 `_openid` |
| 伴侣的打分 / 心愿 / 经期区间 | 伴侣，**且本人已授权** | 只有本人 | `getPartnerView` 服务端判定 |
| 某一天的完整记录 | 伴侣，**且该日 `enabled === true`** | 只有本人 | `record-share.js` |
| 悄悄话 | 关系双方 | 关系双方 | 按 `coupleId` |
| 共同待办 | 关系双方 | 关系双方 | 按 `coupleId` |
| 换绑前的旧数据 | **新伴侣看不到**（`coupleId` 不匹配） | 只有原属主 | 归属比对 |
| 桌面会话 | 只有持 token 的那台机器 | 服务端 | `desktopDaily` |

---

## 5. 日记、目标与提醒状态

### 5.1 目标（`daily_records.goals[]`）

```js
{
  text: string,          // ≤100 字
  done: boolean,
  reminderOn: boolean,   // 是否开启提醒
  reminderTime: string,  // 'HH:mm'，≤8 字符
  reminded: boolean      // ← 服务端状态，见 5.2
}
```

### 5.2 `reminded` 是**服务端维护**的状态

**定义**：这条目标「今天已经推送过提醒」。唯一写入方是定时触发的 `reminderCheck`，
它在**消息发送之后**把该目标标记为 `reminded: true`。

**为什么客户端不能写它**：

| 客户端若能写 | 后果 |
|---|---|
| 写成 `true` | 抑制自己当天的提醒 |
| 从 `true` 改回 `false` | `reminderCheck` 认为还没提醒过 → **同一条目标重复推送**，消耗微信一次性订阅消息额度 |

**现行规则**（`cloudfunctions/desktopDaily/index.js`）：

1. 客户端提交的 `reminded` **一律被丢弃**，服务端归一化为 `false`；
2. 服务端从旧记录里按「`text` + `reminderTime`」为同一性键，用**多重集**方式继承
   `reminded: true`；
3. 目标文本或提醒时刻改变 → 视为**另一条目标**，`reminded` 归零（应当重新提醒）；
4. 两条完全相同的目标 → 只有一条能继承，另一条仍会提醒。

> 小程序端保存走 `dailyRecord`，其 `goals` 是整体覆盖写入；桌面端走 `desktopDaily`，
> 强制上面这套继承规则。**新增任何写入目标数组的入口时，都必须沿用同一规则。**

---

## 6. 历史兼容机制

| 场景 | 机制 |
|---|---|
| `users` 无 `schemaVersion` | `login` 惰性迁移为 `2`（幂等，只补字段） |
| `users` 无 `user_uid` | `login` 用 CAS 补一个（`user_uid = null` 才写） |
| `users` 无 `bindCode` | `login` 补一个（不覆盖已有） |
| `daily_records` 无 `revision` | 保存前先补 `revision: 0`，使 CAS 可匹配（V1 兼容） |
| `wishes` 无 `wishDate` | 读取时退回 `createdAt` 的北京日期（**近似值**，不当作展示归属依据） |
| `wishes` 无 `coupleId` | 归为「未归属」（unattributed）→ 双方都不展示、不修改、不删除 |
| `menstrual` 无 `revision` | 同 `daily_records`，保存前补 0 |
| 桌面 `desktop_sessions` 文档 | 业务主键 `desktopSessionId` ≠ 文档 `_id`，查询必须按业务字段 |

**原则：历史数据不迁移、不补字段、不删除。** 读取侧降级，写入侧不猜。

---

## 7. 迁移注意事项

1. **不要批量补 `coupleId`**：它的语义是「产生时的关系」，事后补写等于伪造归属证据。
2. **不要批量补 `wishDate`**：`createdAt` 与业务日期不是一回事（补写历史日期时会错位）。
3. **`user_uid` 不必迁移**：`login` 已经在惰性补齐。
4. **`reminded` 不要批量重置**：重置会导致重复推送。
5. **索引先建再跑**：缺索引不会报错，只会随数据增长越来越慢。
6. **删除类操作人工确认**：仓库里没有批量删除脚本；`deleteAccount` 是唯一的注销入口，
   有 `preview` 步骤。
7. **本地测试库是内存 Mock**，不代表真实 SDK 行为 —— 迁移前先在测试环境验证。

---

## 8. 相关文档

- 集合与索引的创建步骤 → [DEPLOYMENT.md](./DEPLOYMENT.md) §2 §3
- 权限判定的代码位置 → [ARCHITECTURE.md](./ARCHITECTURE.md) §5
- 桌面会话字段如何被使用 → [DESKTOP_HANDOVER.md](./DESKTOP_HANDOVER.md) §B
