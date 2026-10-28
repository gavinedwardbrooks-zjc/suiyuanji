# 碎愿集 · 桌面版（Windows）

碎愿集桌面版是微信小程序「碎愿集」的 Windows 桌面客户端。它与小程序**共用同一份云数据库**：
桌面端写入的 `goals` / `todos` 会出现在小程序的当天记录里，反之亦然。

- 技术栈：**Tauri 2 + React 19 + Vite 7 + TypeScript 5.8 + Rust**
- 目标平台：Windows（窗口原生透明度、置顶能力依赖 Win32 API）
- 登录方式：手机微信扫二维码授权，无需在电脑上输入账号密码

---

## 1. 与小程序的关系

```
桌面端                              小程序
──────                              ──────
auth_start_login                    mine 页「电脑登录」→ wx.scanCode
  ↓ 创建 login session                ↓ 解析二维码（utils/desktop-qr.js）
显示二维码 suiyuanji://desktop-login   ↓ 进入 desktop-login-confirm 确认页
  ↓ 轮询 status                       ↓ 用户点「确认登录」
  ↓ consume → desktopToken           cloudfunctions/desktopAuthMiniapp
  ↓ 存入 Rust 内存                    ↓ 记录 approve
daily_get / daily_save
  ↓ Bearer token                      cloudfunctions/desktopDaily
  ↓ 服务端解出 user_uid → _openid     ↓ 读写 daily_records
```

### 云函数分工

| 云函数 | 触发方式 | 职责 |
| --- | --- | --- |
| `desktopAuthPublic` | HTTP（公开） | `create` / `status` / `consume` / `validate` / `logout`，桌面端唯一入口 |
| `desktopAuthMiniapp` | 小程序 callFunction | `inspect` / `confirm` / `cancel`，身份取自 `cloud.getWXContext().OPENID` |
| `desktopDaily` | HTTP（Bearer） | `get` / `save`，读写 `daily_records` 的 `goals` / `todos` |

`cloudfunctions/` 根目录下还有 6 个共享模块（`loginSessionCore.js`、`desktopSessionCore.js`、
`*Repository.js` 等）。它们既是各云函数的源码来源，也被根目录 `tests/` 直接 `require`。
修改时请同时更新云函数目录内的副本，保持两边一致。

---

## 2. 配置（重要）

桌面端**不包含任何真实云环境地址**。启动前必须由使用者自行提供，三档优先级：

1. 环境变量 `DESKTOP_AUTH_BASE_URL`
2. 可执行文件同目录的 `desktop.config.json` 的 `authBaseUrl`
3. 都没有 → 所有联网命令直接返回 `AUTH_SERVICE_UNAVAILABLE`（fail-closed，不会静默连到某个内置地址）

### 本地开发

```powershell
cd desktop
npm install

# 指向你自己的云环境
$env:DESKTOP_AUTH_BASE_URL = "https://<你的云环境地址>"
# 本地起 mock 服务时（允许 http://localhost）
$env:DESKTOP_AUTH_PRODUCTION = "0"

npm run tauri dev
```

### 打包后运行

把 `desktop.config.example.json` 复制成 `desktop.config.json`，填入真实地址，
放到 `desktop.exe` 同目录。该文件已被 `.gitignore` 忽略，**不要提交**。

### 协议安全约束

- `DESKTOP_AUTH_PRODUCTION` 默认为 `true`，此时只接受 `https://` 基址；`http://` 一律拒绝。
- 仅当显式设置 `DESKTOP_AUTH_PRODUCTION=0` 时才允许 `http://localhost` / `http://127.0.0.1`。
- 服务端凭据（AppSecret、AI API Key 等）只存在于云函数环境变量中，桌面端与小程序端都没有。

---

## 3. 目录结构

```
desktop/
├── index.html                  入口 HTML
├── package.json                npm 依赖与脚本
├── vite.config.ts              Vite 配置（固定端口 1420）
├── tsconfig.json
├── desktop.config.example.json 运行时配置模板（见 §2）
├── src/
│   ├── main.tsx                React 挂载
│   ├── App.tsx                 登录态机、今日目标/小事、设置面板、透明度与置顶
│   ├── App.css
│   └── vite-env.d.ts
└── src-tauri/
    ├── Cargo.toml              Rust 依赖
    ├── build.rs
    ├── tauri.conf.json         窗口、CSP、打包配置
    ├── capabilities/default.json  Tauri 2 权限声明
    ├── icons/                  应用图标
    ├── .cargo/config.example.toml  可选：把 target 缓存移到别的盘
    └── src/
        ├── main.rs             二进制入口
        ├── lib.rs              Tauri commands、窗口透明度、登录/业务命令
        └── auth_transport.rs   HTTP 传输层（endpoint 校验、Bearer、响应上限）
```

---

## 4. 安全模型

| 约束 | 实现位置 |
| --- | --- |
| `desktopToken` 只驻留 Rust 进程内存，前端拿不到明文 | `lib.rs` 的 `auth_*` 命令只返回 `expiresAt` / 状态字符串；`auth_transport::AuthState.token` 为 `Mutex<Option<String>>` |
| `pollSecret` 只在 Rust 内存，随 body 提交，不放 Bearer | `auth_transport::PendingLogin` |
| 二维码只含 `sessionId` + `nonce`，绝不含 token/secret/openid | `lib.rs` 的 `qr_text` |
| 小程序侧解析二维码 fail-closed（未知字段一律拒绝） | `utils/desktop-qr.js` |
| 服务端身份只认 Bearer → `user_uid` → `users._openid` 反查 | `cloudfunctions/desktopDaily/index.js` |
| 不信任客户端提交的 `openid` / `user_uid` / `coupleId` / `role` | 同上，全仓无 `event.openid` 取值 |
| 桌面端只写 `goals` / `todos`，不覆盖 `segments` / `mood` / `wishes` / `score` | `desktopDaily` 字段级合并 |
| 写入幂等 + 乐观锁 | `lastRequestId` 去重、`revision` CAS，冲突返回 `REV_CONFLICT` |
| 窗口透明度只能操作本应用主窗口，值强制 clamp 0.2–1.0 | `apply_window_opacity` |
| HTTP 响应体上限 64 KB，业务 path 白名单 | `auth_transport.rs` |

---

## 5. 构建

```powershell
cd desktop
npm install
npm run build          # tsc + vite build（前端产物到 desktop/dist）
npm run tauri build    # 打包（需要 Rust 工具链；产物在 src-tauri/target/release/bundle）
```

首次构建会拉取 Tauri 2 依赖，耗时较长。若希望把 `target` 缓存移出系统盘，
参考 `src-tauri/.cargo/config.example.toml`。

---

## 6. 已知限制

- **Windows 专属**：透明度和置顶走 `SetLayeredWindowAttributes`，非 Windows 平台只保留占位实现。
- **登录态不持久化**：`desktopToken` 只存在内存中，关掉应用需要重新扫码（这是安全取舍，不是缺陷）。
- **只同步今天的两个字段**：桌面端当前只处理 `goals` / `todos`，不提供日记正文、心情、评分、心愿的编辑。
- **云函数需自行部署**：本仓库只含源码，部署到你的云环境后才能在 `authBaseUrl` 指向它。
