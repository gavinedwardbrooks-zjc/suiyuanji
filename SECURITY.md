# 安全策略 · 碎愿集（Suiyuanji）

> 这个项目存的是两个人的私人记录（日记正文、心情、经期、悄悄话）。
> 安全问题在这里不是「合规问题」，是**真实的隐私伤害**。

---

## 1. 如何报告安全问题

**请勿开公开 Issue、请勿在 PR 描述里贴 PoC 细节、请勿贴真实数据。**

> ⚠️ **私下披露渠道：待维护者补充。**
> 仓库目前**没有**配置专用安全邮箱或 GitHub Security Advisory 入口，
> 本文不编造一个地址。维护者补充前，请通过仓库所有者的 GitHub 主页所列联系方式私信，
> **不要**把细节写进公开区域。

报告时请包含：

| 要素 | 说明 |
|---|---|
| 影响范围 | 能否读到别人的数据？能否越权写入？只影响自己？ |
| 复现路径 | 具体云函数 + `action` + 请求体（**脱敏后**） |
| 版本 | 提交号（`git rev-parse HEAD`） |
| 建议 | 有就写，没有也不影响受理 |

**受理后的处理**：确认 → 修复 → 在提交信息里说明影响面（不公开利用细节）→ 致谢（如你愿意）。

---

## 2. 哪些东西绝不能公开

### 2.1 已被 `.gitignore` 排除的文件

| 文件 | 为什么 |
|---|---|
| `config.local.js` | 真实云开发环境 ID |
| `project.private.config.json` | 真实小程序 AppID |
| `desktop/desktop.config.json`、`desktop.config.json` | 真实服务基址 |
| `.env` / `.env.*` | 可能含 AI Key、AppSecret |
| `desktop/src-tauri/.cargo/config.toml` | 含本机绝对路径 |
| `/docs/OPEN_SOURCE_RELEASE_REPORT.md` | 作者内部发布审计报告 |
| `/.local/` 整目录 | 调试报告、日志、临时清单 |
| `desktop/src-tauri/target/`、`desktop/dist/` | 构建产物 |

### 2.2 绝不能出现在任何地方（包括 Issue / 截图 / 日志）

- `AI_API_KEY`、`AppSecret`、任何服务端密钥；
- `desktopToken`、`pollSecret`、`nonce`；
- 用户的 `openid`、`user_uid`、`coupleId`；
- 日记正文、心情、经期数据、悄悄话内容；
- 完整的云环境 ID 与 HTTP 基址。

### 2.3 提交前自查

```powershell
git status --porcelain
git diff --cached --name-only
git diff --cached | Select-String -Pattern "cloud1-|wx[0-9a-f]{16}|sk-[A-Za-z0-9]{16,}|Bearer [A-Za-z0-9]|pollSecret"
```

最后一条**必须没有输出**。仓库已有静态守卫覆盖其中一部分：
`tests/config-local.test.js`（配置层不泄漏）、以及 `tests/private-terms.js`
（私有术语与私有路径的扫描实现，被 `desktop-phase1-contract.test.js` 与 `m1-gate.test.js` 使用）。

---

## 3. 开发者如何安全配置环境

### 3.1 三层配置，职责不能混

| 层 | 文件 | 允许放什么 |
|---|---|---|
| ① 跟踪文件 | `config.js` | **只有占位符**（`YOUR_CLOUD_ENV_ID` / `TEMPLATE_ID_HERE`） |
| ② 本地私有 | `config.local.js`（gitignore） | 云环境 ID、订阅消息模板 ID（**客户端标识，不是密钥**） |
| ③ 服务端 | 云函数环境变量 | AI API Key、任何密钥 |

**红线**：密钥只能待在 ③。客户端（小程序包、桌面 exe）里的任何东西都必须视为公开。

### 3.2 缺配置时是 fail-closed，不是「回落到默认」

- `config.local.js` 缺失或仍是占位符 → `app.js` **拒绝** `wx.cloud.init()`，
  控制台打印指引。**不会**省略 `env` 让微信回落到某个默认环境（那可能连到别人的线上环境）。
- 桌面端基址为空 → 所有联网命令返回 `AUTH_SERVICE_UNAVAILABLE`，**不会**内置任何地址。
- 生产模式下桌面端只接受 `https://`；只有显式设置 `DESKTOP_AUTH_PRODUCTION=0` 才允许
  `http://localhost` / `http://127.0.0.1`。

### 3.3 最小权限的数据集权限

| 集合 | 权限 |
|---|---|
| `record_shares` / `couple_todos` / `day_choices` | **仅云函数可读写**（客户端直读直写会让 `coupleId` / `enabled` / `done` 可伪造） |
| `login_sessions` / `desktop_sessions` | **仅云函数可读写** |
| 其余业务集合 | 建议「仅创建者可读写」，敏感判定仍由云函数做 |

---

## 4. 不要在生产环境做测试

- 云函数改动先部署到**独立测试环境**（建第二个云开发环境），验证后再动生产；
- 不要用真实用户账号跑「删除 / 注销 / 换绑」类实验；
- 不要在生产环境跑 `userUidMigration.execute`（它默认只读，`execute` 需显式授权）；
- 不要为调试临时放开集合权限 —— 很容易忘记改回来。

---

## 5. 桌面认证接口：已知部署前安全要求

桌面版**从未部署过**，以下是「要对外提供就必须先做」的清单：

| # | 要求 | 现状 |
|---|---|---|
| 1 | `desktopAuthPublic.create` 补速率限制（来源 IP + 时间窗，超限返回 `RATE_LIMITED`） | ❌ **未实现**（`safeError` 已预留该码） |
| 2 | 4 条索引必须建好（`login_sessions.sessionId`、`desktop_sessions.{tokenHash, desktopSessionId, loginSessionId}`） | ❌ 未建 |
| 3 | 两条 HTTP 路由必须存在且只映射到对应函数 | ❌ 未配 |
| 4 | `login_sessions` / `desktop_sessions` 权限必须「仅云函数可读写」 | ❌ 未设 |
| 5 | 基址必须走 https，且**只**通过环境变量或 exe 同目录配置提供 | ✅ 代码已强制 |
| 6 | 完成六项真实验收（含跨账号越权检查） | ❌ 全部 UNVERIFIED |

**为什么 `create` 限流是必办而不是可选**：不限流时任何人都能无限创建 `login_sessions` 文档
（每条 5 分钟自然过期，写入次数不受限），属存储/成本放大型风险。
它**不构成越权**（没有 `pollSecret` 就换不到 token），但作为公开 HTTP 接口不该裸奔。

---

## 6. 已经实施的安全机制（供审查者对照）

| 机制 | 实现位置 |
|---|---|
| 身份只认平台注入的 OPENID，不信任客户端字段 | 全部小程序云函数 |
| 桌面身份只认 Bearer → `user_uid` → `_openid` 反查 | `desktopDaily`、`desktopAuthPublic` |
| 二维码不含任何凭据（只有 `sessionId` + `nonce`） | `lib.rs` 的 `qr_text` + `utils/desktop-qr.js` |
| `pollSecret` 只在发起登录的机器内存里；比对用哈希 + 定时安全比较 | `loginSessionCore.safeEqualHash` |
| 登录会话一次性（`approved → consumed` CAS），5 分钟 TTL | `loginSessionCore` |
| 换发窗口收窄到登录会话有效期、不续期、旧 hash CAS | `desktopSessionCore` |
| 桌面 token 只存 Rust 内存，前端拿不到明文 | `auth_transport::AuthState` |
| 桌面会话 30 天硬过期，`validate` 不滑动续期 | `desktopSessionCore` |
| `reminded` 服务端维护，客户端不可写 | `desktopDaily.sanitizeGoals` + `inheritReminded` |
| 桌面只写 `goals` / `todos`，其余字段原样保留 | `desktopDaily` 字段级合并 |
| 写入幂等 + 乐观锁（`requestId` / `revision`） | `dailyRecord`、`menstrual`、`desktopDaily` |
| 分享默认关闭，`enabled === true` 才算授权，且绑定 `coupleId` | `getPartnerView/record-share.js` |
| 换绑后旧数据对新伴侣不可见（数据保留、不迁移） | `wish-scope.js` 等 |
| HTTP 响应体上限 64 KB、业务 path 白名单、8s 超时 | `auth_transport.rs` |
| 客户端配置 fail-closed（缺配置拒绝初始化，不回落默认环境） | `config.js`、`app.js` |
| 部署产物一致性守卫（副本漂移、跨目录 require） | `tests/cloudfunction-shared-modules.test.js`、`deploy-isolation.test.js` |

---

## 7. 支持范围

这是一个自用项目，**没有** LTS 分支或安全补丁 SLA。
发现问题的版本请以提交号指明（`git rev-parse HEAD`），默认只处理当前 `main`。
