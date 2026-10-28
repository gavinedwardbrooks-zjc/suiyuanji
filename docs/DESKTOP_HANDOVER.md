# 桌面版交接文档（Windows）· 碎愿集

> **状态：本地冻结，未部署。**
> 冻结基线：`aee3995`（`feat(desktop): complete M2 local integration and freeze`）
> 一句话：代码完整、本地模拟联调全通过、**真实云端 0 项验收**。
> 这不是一份「已完成」的交接，而是一份「从这里继续」的交接。

---

## A. 当前状态

### A.1 技术栈与目录

| 层 | 技术 | 位置 |
|---|---|---|
| 客户端外壳 | Tauri 2（Rust） | `desktop/src-tauri/` |
| 前端 | React 19 + TypeScript 5.8 + Vite 7 | `desktop/src/` |
| HTTP 传输 | `reqwest`（rustls，阻塞，8s 超时） | `src-tauri/src/auth_transport.rs` |
| 窗口能力 | Win32 `windows-sys`（透明度、置顶） | `src-tauri/src/lib.rs` |
| 服务端 | 微信云函数（3 个）+ 云数据库 | `cloudfunctions/desktop*/` |

```
desktop/
├── package.json                 npm 脚本：dev / build / preview / tauri
├── vite.config.ts               固定端口 1420、host 127.0.0.1（见 §F.6）
├── desktop.config.example.json  运行时配置模板（可提交）
├── index.html                   入口（内含静态启动兜底，见 A.2）
├── src/App.tsx                  登录态机、今日目标/小事、设置面板、透明度与置顶
└── src-tauri/
    ├── tauri.conf.json          窗口、CSP、打包
    ├── capabilities/default.json  Tauri 2 权限声明
    └── src/
        ├── lib.rs               Tauri commands + 窗口透明度
        └── auth_transport.rs    端点校验、Bearer、响应上限、错误码映射
```

### A.2 Windows 黑屏问题：三个根因与修复

已修复，且有三条回归守卫锁住（`tests/desktop-phase1-contract.test.js`）。

| # | 根因 | 修复 | 守卫 |
|---|---|---|---|
| 1 | `main_window.once("desktop-ui-ready", …)` + React **StrictMode 双执行** → 事件二次投递命中 tauri 内部断言 `attempted to call handler more than once`，**工作线程 panic** | 改成 `listen` + `AtomicBool` 去重：第二次投递被安静忽略 | `UI_READY_DUPLICATE_SAFE` |
| 2 | 前端包没加载成功时 `#root` 全空 → 用户只看到无信息的空白窗口 | `index.html` 的 `#root` 内嵌静态兜底（奶油底 +「正在启动碎愿集…」），React 挂载时整体接管 | `STATIC_BOOT_FALLBACK_PRESENT` |
| 3 | 无条件给窗口加 `WS_EX_LAYERED` → DWM 分层合成与 WebView2 的 DirectComposition 叠加，**整窗全黑** | 默认 100% 不透明时**完全不碰 layered**，只有用户把不透明度调到 <100% 才启用；顺带把 `SetWindowLongW(…, GWL_EXSTYLE, 0)` 反取旧样式改成 `GetWindowLongW`（避免清掉 `WS_EX_APPWINDOW` 导致任务栏闪烁） | `LAYERED_ONLY_WHEN_TRANSLUCENT` |

另外修掉一处体验误导：未配置服务端地址时点登录，旧文案是「连接服务失败」，
现在按错误码分流为「登录服务尚未配置（缺少桌面版服务端地址）」。

### A.3 完成到了哪一步

| 阶段 | 内容 | 状态 |
|---|---|---|
| Phase A | 只读审计（身份 / 扫码协议 / 日记协议 / 云部署边界） | ✅ 完成 |
| Phase B | 最小修复（会话仓库查询字段、consume 重放、`INVALID_ACTION`、错误映射） | ✅ 完成 |
| Phase C | 完整本地模拟联调（扫码 / 身份权限 / 日记同步） | ✅ 完成 |
| Phase D | 部署前安全审计 | ✅ 完成，结论「可以部署但必须先做 N 项」 |
| **Phase E** | **真实部署 + 真实云端验收** | ❌ **未执行**（决定暂不部署） |

### A.4 明确不在当前范围内

- **Windows 安装包**：仓库不含构建产物，也没有签名与分发流程。`npm run tauri build`
  能产出 bundle，但未验证分发。
- **Linux / 信创系统适配**：窗口透明度与置顶走 Win32 API，其他平台只有占位实现；
  未做任何国产化系统适配、未做 ARM 适配。
- **登录态持久化**：「记住这台电脑」是**新需求**，未批准、未实现。
- **桌面端功能扩展**：只同步当天 `goals` / `todos`，不做日记正文、心情、评分、心愿的编辑。

---

## B. 扫码登录

### B.1 整体流程

```
① 桌面点「使用微信登录」
   invoke('auth_start_login')
     → POST /desktop-auth  { action:'create', deviceId, deviceName }
     → 服务端建 login_session，返回 sessionId + nonce + pollSecret + expiresAt
     → Rust 把 pollSecret 存进内存；前端只拿到 qrText 与 expiresAt
     → 二维码内容：suiyuanji://desktop-login?v=1&sid=<sessionId>&nonce=<nonce>

② 手机扫这个二维码
   pages/desktop-login-confirm（utils/desktop-qr.js 解析，未知字段一律拒绝）
     → callFunction desktopAuthMiniapp { action:'inspect', sessionId, nonce }
     → 页面显示「哪台电脑在请求登录」
     → 用户点确认 → { action:'confirm' }，身份 = getWXContext().OPENID → users.user_uid
     → login_session 置 approved

③ 桌面轮询
   invoke('auth_login_status')  每 1.5s，状态 pending/approved/cancelled/expired
   变 approved → invoke('auth_login_consume')
     → POST /desktop-auth { action:'consume', sessionId, pollSecret, deviceId, deviceName }
     → 服务端交换机：approved → consumed，签 desktopToken
     → token 只进 Rust 内存（Mutex<Option<String>>），前端拿不到明文

④ 之后每次业务请求
   Authorization: Bearer <desktopToken>  →  POST /desktop-daily
```

**二维码里只有 `sessionId` + `nonce`**，没有 `pollSecret`、没有 token、没有 openid。
所以「拍照截图二维码」拿不到任何可换 token 的东西 —— 换 token 必须出示 `pollSecret`，
而 `pollSecret` 只存在于发起登录的那台机器的内存里。

### B.2 两套有效期，别搞混

| 凭据 | 位置 | TTL | 作用 |
|---|---|---|---|
| `login_session`（`sessionId` + `nonce` + `pollSecret`） | 云数据库 `login_sessions` | **5 分钟** | 只在「从点登录到拿到 token」这一段有效 |
| `desktopToken` | 云数据库 `desktop_sessions`（哈希）+ Rust 内存（明文） | **30 天** | 之后所有业务请求的凭据 |

- **5 分钟窗口结束就结束了**：`approved` 但没被 consume 的会话会过期，必须重新扫码。
- **30 天不会滑动续期**：`validate` 只更新 `lastSeenAt`（5 分钟节流一次），
  **从不改写 `expiresAt`**。用到第 30 天就到期，重新扫码即可。

### B.3 Token 的签发、换发、撤销、过期

| 场景 | 行为 |
|---|---|
| **签发** | 只在 `consume` 时发生。`login_session` 用 CAS `approved → consumed`，天然只成功一次 |
| **换发**（响应丢失恢复） | 见下方 §B.4 |
| **撤销**（退出登录） | `logout` → `active → revoked`（CAS）。重复撤销返回 `ALREADY_REVOKED`，不算错 |
| **过期** | `validate` 发现 `now >= expiresAt` 时把状态落库为 `expired`，并拒绝请求 |
| **失效即焚** | 换发后旧 token 的哈希立刻被覆盖 → 旧 token 立即无效 |

### B.4 重复 consume 的安全边界（本轮已加固）

`consume` 的响应可能在网络层丢失，客户端没收到 token。允许同一台机器重试，但边界很硬：

| 约束 | 实现 |
|---|---|
| 必须出示 `pollSecret` | 先 `assertPollSecret`，只比对哈希（timingSafeEqual），错误一律 `INVALID_LOGIN_REQUEST` |
| **换发窗口 = 登录会话的 5 分钟** | `now >= loginSession.expiresAt` 即拒（`DESKTOP_SESSION_ALREADY_USED`）。**不是** 30 天 |
| 换发不续期 | 返回原 `expiresAt`，换号不换期限 |
| 并发重放只有一个赢家 | `rotateToken` 的 CAS 条件包含**旧 `tokenHash`**，两个并发请求不会都收到「成功」 |
| 已撤销/已过期不能复活 | 记录状态不是 `active` 或已过 `expiresAt` → 直接拒 |
| 不新建第二条会话 | 重放路径只换 token，`desktop_sessions` 仍是 1 条 |

> 历史缺陷（已修）：早期实现只校验了 desktop session 的 30 天有效期，
> 没校验 login session 的 5 分钟，导致 `pollSecret` 变成 30 天内可无限换发的长期凭据。

### B.5 服务端身份与权限校验

```js
// desktopDaily 的每一次读写
Bearer token → sha256 → desktop_sessions.tokenHash
            → 校验 status==='active' 且 now < expiresAt
            → 取 user_uid
            → users.where({ user_uid }) → _openid
            → 只用这个 _openid 作为读写条件
```

- 客户端提交的 `openid` / `user_uid` / `coupleId` / `role` **全部不看**；
- 没有「跳过校验」的分支，也没有「内部调用免校验」的旁路；
- token 明文不落库、不写日志（日志只打 URL 与传输错误）。

### B.6 客户端错误码（Rust 侧统一映射）

| 服务端 / 传输 | 前端看到 | 含义 |
|---|---|---|
| `INVALID_DESKTOP_SESSION` | `DESKTOP_SESSION_INVALID` | token 无效，需重新登录 |
| `INVALID_LOGIN_REQUEST` / `SESSION_EXPIRED` / `SESSION_NOT_APPROVED` / `DESKTOP_SESSION_ALREADY_USED` | `LOGIN_REQUEST_INVALID` | 这次登录失效，重新扫码 |
| 网络失败 | `NETWORK_ERROR` | 连不上 |
| 基址为空 / 非 https（生产模式）/ 5xx | `AUTH_SERVICE_UNAVAILABLE` | 服务不可用或未配置 |
| 响应超 64 KB 或非 JSON | `INVALID_RESPONSE` | 对方不是我们的服务 |

前端只按这几个字符串分支渲染，**不会因为后端返回细节而黑屏**。

---

## C. 日记同步

### C.1 读写流程

```
桌面 App.tsx
  ├─ invoke('daily_get',  { date })          → POST /desktop-daily { action:'get', date }
  └─ invoke('daily_save', { date, requestId, revision, goals, todos })
                                             → POST /desktop-daily { action:'save', ... }
```

服务端 `desktopDaily`：

| 步骤 | 做的事 |
|---|---|
| 1 | 校验 Bearer → `user_uid` → `users._openid` |
| 2 | `daily_records.where({ _openid, date })` —— **归属条件由服务端拼** |
| 3 | `save` 时**只写** `goals` / `todos` + `revision` / `lastRequestId` / `updatedAt` |
| 4 | `segments` / `mood` / `wishes` / `score` / `readProgress` **原样保留**（字段级合并） |
| 5 | 新建记录时额外写 `coupleId`（只在创建时写一次，规则与小程序一致） |

### C.2 `reminded` 的继承规则（重点）

`reminded` 是**服务端状态**（`reminderCheck` 在提醒发出后写入），桌面端**不能决定它的值**：

1. 客户端提交的任何 `reminded` 一律被丢弃；
2. 服务端按「`text` + `reminderTime`」为同一性键，用**多重集**从旧记录继承 `true`；
3. 文本或提醒时刻改变 → 视为新目标，`reminded` 归零；
4. 两条完全相同的目标 → 只有一条能继承，另一条仍会提醒。

**为什么必须这样**：客户端若能把它改回 `false`，同一条目标会被重复推送，
直接消耗用户的一次性微信订阅消息额度。

### C.3 并发与错误处理

| 场景 | 处理 |
|---|---|
| 同一 `requestId` 重复提交 | 幂等：直接返回当前 `revision`，不重复写 |
| `revision` 过期（另一端先改了） | `409 REV_CONFLICT` + 当前 `revision`，前端提示「内容已被更新，请刷新」 |
| 新建时 `revision !== 0` 但记录已存在 | 同样 `REV_CONFLICT` |
| 云端写失败 | 明确错误码，**绝不假装成功**（不会前端显示「已保存」而库里没数据） |
| 日期格式非法 | `400 DATE_INVALID`（校验真实日历日，`2026-02-30` 也拒） |
| 未知 action | `400 INVALID_ACTION`（不再伪装成 500 内部错误） |
| 保存中重复点击 | 前端 `saving` 置位拦截 |

### C.4 本地模拟测试覆盖了什么

`tests/desktop-login-e2e.test.js` —— 35 个用例，驱动**真实云函数代码** + 内存 MockDB：

| 组 | 用例 | 覆盖 |
|---|---|---|
| E 扫码授权（14） | 创建 / 扫码 / 确认 / 轮询 / 消费 / 过期 / 取消 / 重复 / 并发 / 非法码 / 网络恢复 / 重放窗口 | 状态机与一次性语义 |
| I 身份与权限（6） | 冒充他人 / 伪造 `coupleId`·`role` / 无 token / 过期 / 撤销落库 / token 不明文 | 权限边界 |
| D 日记同步（15） | 读 / 建 / 跨端读改 / 幂等 / 冲突 / 写失败 / V1 历史记录 / 未知 action / 非法日期 / **reminded 四条** | 数据契约 |

**不覆盖**（必须真机验证）：微信扫码真实交互、`getWXContext()` 真实注入、云函数真实部署
与 HTTP 路由、网络时延与重试、真实 SDK 返回形状。

---

## D. 测试与构建（冻结时实测）

| 项 | 命令 | 结果 |
|---|---|---|
| 全量测试 | 逐个 `node tests/*.test.js` | **83 / 83 文件 PASS** |
| 桌面协议 e2e | `node tests\desktop-login-e2e.test.js` | **35 PASS / 0 FAIL** |
| 共享模块一致性 | `node tests\cloudfunction-shared-modules.test.js` | **3 PASS**（9 份副本逐字节一致） |
| 桌面静态契约 | `node tests\desktop-phase1-contract.test.js` | **24 test PASS**（含 `UI_READY_DUPLICATE_SAFE` / `LAYERED_ONLY_WHEN_TRANSLUCENT` / `STATIC_BOOT_FALLBACK_PRESENT`） |
| Rust 单元测试 | `cargo test --lib` | **3 passed / 0 failed** |
| 前端构建 | `npm run build` | **OK**（84 modules，~247 kB JS） |

### D.1 真实云端六项验收：**全部 UNVERIFIED**

| # | 项 | 判据 | 状态 |
|---|---|---|---|
| 1 | AUTH_PASS | 桌面出码 → 手机扫码 → 确认 → 桌面进入已登录 | **UNVERIFIED** |
| 2 | IDENTITY_PASS | 桌面解析出的账号与小程序当前账号是同一个 | **UNVERIFIED** |
| 3 | PERMISSION_PASS | A 账号桌面看不到 B 账号日记；退出后立刻 400 | **UNVERIFIED** |
| 4 | DAILY_READ_PASS | 桌面读到小程序今天写过的目标 / 小事 | **UNVERIFIED** |
| 5 | DAILY_WRITE_PASS | 桌面新建目标 → 小程序刷新可见；再改 → 桌面重进见新值 | **UNVERIFIED** |
| 6 | CROSS_CLIENT_SYNC_PASS | 两边修改不产生重复记录、不丢 `segments` / `mood` / `score` | **UNVERIFIED** |

> 附加需真实确认：造一条 08:00 提醒的目标，桌面保存后确认当天**不重复收到提醒**。

---

## E. 未来恢复开发（按顺序做，别跳步）

### E0. 从冻结基线开始

```powershell
cd C:\Users\admin\Desktop\suiyuanji
git rev-parse HEAD                 # 应为 aee3995
git status --porcelain             # 应为空
```

### E1. 重新检查依赖与配置

```powershell
cd desktop; npm install; npm run build
cd src-tauri; cargo test --lib
```

确认：Node（实测 v22.22.2）、Rust（实测 1.95.0）、`desktop.config.json` 或
`DESKTOP_AUTH_BASE_URL` 已就绪（**域名根，不带 `/desktop-auth`**）。

### E2. 补齐 `create` 的速率限制（**部署前必办**）

现状：`desktopAuthPublic.create` 无任何限流，任何人可无限建 `login_sessions` 文档
（每条 5 分钟自然过期，写入次数不受限）→ 存储/成本放大，**不构成越权**
（拿不到 `pollSecret` 就换不到 token）。`safeError` 白名单已预留 `RATE_LIMITED` 码但无实现。

建议做法：按「来源 IP + 时间窗」限流，超限返回 `RATE_LIMITED`；
注意云函数拿客户端 IP 需从 HTTP 事件头取，先在测试环境验证取到的确实是真实 IP。

### E3. 确认数据库索引（4 条，脚本没覆盖）

| 集合 | 索引键 | 用途 |
|---|---|---|
| `login_sessions` | `sessionId` | create/status/consume 都按它查 |
| `desktop_sessions` | `tokenHash` | **最热路径**，每个业务请求都查 |
| `desktop_sessions` | `desktopSessionId` | 状态流转 CAS |
| `desktop_sessions` | `loginSessionId` | 消费重放恢复 |

不建也能跑（全表扫描），但 `desktop_sessions` 会持续增长，必须建。

### E4. 审查云函数权限

- 3 个桌面函数是否是「新增部署」，没有覆盖既有函数；
- `desktopAuthPublic` / `desktopDaily` 的 HTTP 是否**未开启匿名越权**（Bearer 校验是否真的生效）；
- `login_sessions` / `desktop_sessions` 集合权限必须是「仅云函数可读写」。

### E5. 配置 HTTP 路由与服务基址

| 云函数 | 路径 |
|---|---|
| `desktopAuthPublic` | `/desktop-auth` |
| `desktopDaily` | `/desktop-daily` |

基址填 `DESKTOP_AUTH_BASE_URL`（或 exe 同目录 `desktop.config.json` 的 `authBaseUrl`）。
**基址是域名根**，Rust 自己拼上面两条 path。

### E6. 取得维护者批准后部署

上传顺序：`desktopAuthPublic` → `desktopAuthMiniapp` → `desktopDaily`。
**不要动** `login` / `dailyRecord` / `getPartnerView` 等既有函数。

### E7. 完成真实扫码与日记同步验收

跑完 §D.1 的六项，并把「验证前后当天记录条数」记下来（防重复写入）。

### E8. 再决定要不要做安装包 / 跨平台

| 事项 | 前提 |
|---|---|
| Windows 安装包与签名 | 六项验收通过 + 确认分发方式 |
| Linux / 信创适配 | 需要重做窗口透明度与置顶（Win32 → 各平台原语），不是改配置能解决的 |
| 「记住这台电脑」持久登录 | **新需求**，需明确安全取舍（token 落地磁盘 = 新增窃取面） |

---

## F. 已知风险与限制

| # | 风险 | 级别 | 说明 |
|---|---|---|---|
| F.1 | **部署完全没做过** | 高 | 3 个云函数、2 条 HTTP 路由、4 条索引全部未建 |
| F.2 | **真实用户旅程零验证** | 高 | 扫码、跨端同步、退出登录在真实环境一次都没跑过 |
| F.3 | `create` 无速率限制 | 中 | 成本放大，非越权；对外提供前必办 |
| F.4 | Token 只存内存 | 低（体验） | 每次启动重扫码。这是设计取舍，不是缺陷 |
| F.5 | **不透明度 <100% 时的 layered 窗口** | 低 | 启用 `WS_EX_LAYERED` 后，个别显卡驱动 / 时序下 WebView2 可能渲染异常（历史黑屏就是从这条路来的）。默认 100% 不碰 layered；用户主动调低才进入该路径。若真机上出现异常，先让用户调回 100% |
| F.6 | Vite dev host 必须是 `127.0.0.1` | 低 | Node 22 + Windows 下 `host: false` 只绑 `[::1]`，而 `devUrl` 是 `localhost`（WebView2 解析成 IPv4）→ 白屏。已固定在 `vite.config.ts`，别改回去 |
| F.7 | 单窗口假设 | 低 | `apply_window_opacity` 只操作名为 `main` 的主窗口；多窗口需重做 |
| F.8 | 云函数运行时为 UTC | 低 | 与本模块无关，但会影响「今天」的判定（北京时间 00:00–08:00 边界） |
| F.9 | 无自动化端到端 | 中 | 真实链路只能人工验收，没有 CI |
| F.10 | 桌面端功能面很窄 | — | 只同步 `goals` / `todos`，不做日记正文等 |

> **不要把 `LOCAL_READY` 读成「可以给用户用」。** 准确的表述是：
> 代码写完了、本地模拟都过了、真实环境一步没走。

---

## G. 相关文档

- 桌面端快速开始与安全模型 → [desktop/README.md](../desktop/README.md)
- 云函数职责与部署前提 → [CLOUD_FUNCTIONS.md](./CLOUD_FUNCTIONS.md)
- 集合与字段（含 `login_sessions` / `desktop_sessions`） → [DATA_MODEL.md](./DATA_MODEL.md)
- 部署清单与回滚 → [DEPLOYMENT.md](./DEPLOYMENT.md)
- 本地环境与排查 → [DEVELOPMENT.md](./DEVELOPMENT.md)
