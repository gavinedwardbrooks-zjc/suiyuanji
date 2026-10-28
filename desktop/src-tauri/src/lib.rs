// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use serde::Deserialize;
use tauri::{Listener, Manager};

mod auth_transport;
use auth_transport::AuthState;

/// Desktop Auth 服务基址。仓库内**不含任何真实环境值**（无云环境 ID、无生产域名）。
///
/// 解析优先级（先命中先用）：
///   1. 环境变量 `DESKTOP_AUTH_BASE_URL`（本地联调可设为 http://localhost:PORT）
///   2. 可执行文件同目录的 `desktop.config.json` 中的 `authBaseUrl` 字段
///   3. 都没有 → 空串 → `auth_transport::endpoint` 返回 AUTH_SERVICE_UNAVAILABLE
///
/// fail-closed：未配置就明确失败，绝不回退到任何内置地址。
fn configured_auth_base_url() -> String {
    if let Ok(value) = std::env::var("DESKTOP_AUTH_BASE_URL") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let path = dir.join("desktop.config.json");
            if let Ok(raw) = std::fs::read_to_string(&path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if let Some(url) = json.get("authBaseUrl").and_then(|v| v.as_str()) {
                        let trimmed = url.trim();
                        if !trimmed.is_empty() {
                            return trimmed.to_string();
                        }
                    }
                }
            }
        }
    }
    String::new()
}

fn build_auth_state() -> AuthState {
    let base_url = configured_auth_base_url();
    let production = std::env::var("DESKTOP_AUTH_PRODUCTION")
        .map(|v| v != "0" && v.to_lowercase() != "false")
        .unwrap_or(true);
    AuthState {
        base_url,
        production,
        ..Default::default()
    }
}

/// 非安全用途的设备标识（仅记录/展示；authority 始终是服务端解析出的身份）。
fn make_device_id() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("dv_{:x}_{:x}", ms, std::process::id())
}

fn make_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Desktop".into())
}

#[allow(dead_code)]
fn auth_state_from_env() -> AuthState {
    build_auth_state()
}

#[derive(Debug, Deserialize)]
struct DesktopUiReadyPayload {
    opacity: f64,
}

/// Windows 下将当前主窗口设为 layered 并应用 native opacity（0.2~1.0）。
/// 安全约束：
///   - 仅操作本应用自己的主窗口 HWND（由 tauri 提供，前端不可传 HWND/PID/进程名）
///   - value 强制 clamp 0.2 ~ 1.0
/// 底层：SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA) —— 真正的
/// whole-window opacity（整个系统窗口统一变淡，包含 WebView 与标题栏）。
#[cfg(windows)]
fn apply_window_opacity(app: &tauri::AppHandle, value: f64) -> Result<f64, String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetLayeredWindowAttributes, SetWindowLongW, GWL_EXSTYLE, LWA_ALPHA, WS_EX_LAYERED,
    };

    let clamped = value.clamp(0.2, 1.0);
    let hwnd = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?
        .hwnd()
        .map_err(|e| format!("hwnd failed: {e}"))?;

    // tauri 返回 windows crate 的 HWND(pub *mut c_void) → 转 windows-sys 的 *mut c_void
    let hwnd_raw: *mut core::ffi::c_void = hwnd.0 as *mut core::ffi::c_void;
    eprintln!("native opacity target hwnd={}", hwnd_raw as usize);

    // 确保窗口带 WS_EX_LAYERED 扩展样式（SetLayeredWindowAttributes 的前置条件）
    let ex = unsafe { SetWindowLongW(hwnd_raw, GWL_EXSTYLE, 0) };
    unsafe {
        SetWindowLongW(hwnd_raw, GWL_EXSTYLE, ex | WS_EX_LAYERED as i32);
    }

    // 0.2~1.0 → 51~255（alpha 0-255）
    let alpha = (clamped * 255.0).round() as u8;
    let ok = unsafe { SetLayeredWindowAttributes(hwnd_raw, 0, alpha, LWA_ALPHA) };
    if ok == 0 {
        return Err("SetLayeredWindowAttributes failed".to_string());
    }
    Ok(clamped)
}

/// Windows 下将当前主窗口设为 layered 并应用 native opacity（0.2~1.0）。
/// 前端手动调节仍通过此 command，ready 事件则调用同一底层实现。
#[cfg(windows)]
#[tauri::command]
fn set_current_window_opacity(app: tauri::AppHandle, value: f64) -> Result<f64, String> {
    apply_window_opacity(&app, value)
}

/// 非 Windows 平台占位（保持跨平台编译）
#[cfg(not(windows))]
fn apply_window_opacity(_app: &tauri::AppHandle, value: f64) -> Result<f64, String> {
    Ok(value.clamp(0.2, 1.0))
}

#[cfg(not(windows))]
#[tauri::command]
fn set_current_window_opacity(app: tauri::AppHandle, value: f64) -> Result<f64, String> {
    apply_window_opacity(&app, value)
}

// ============ Desktop Auth commands（包装 auth_transport，协议零改动） ============

/// 发起登录：服务端 create login session；返回二维码文本（仅含 sessionId + nonce）
/// 与过期时间。pollSecret 仅驻留 Rust 内存，绝不返回前端。
#[tauri::command]
fn auth_start_login(state: tauri::State<'_, AuthState>) -> Result<serde_json::Value, String> {
    let device_id = make_device_id();
    let device_name = make_device_name();
    let production = state.production;
    let (session_id, nonce, _poll_secret, expires_at) =
        auth_transport::create(&state, &device_id, &device_name, production)?;
    let qr_text = format!("suiyuanji://desktop-login?v=1&sid={session_id}&nonce={nonce}");
    Ok(serde_json::json!({
        "ok": true,
        "sessionId": session_id,
        "qrText": qr_text,
        "expiresAt": expires_at
    }))
}

/// 轮询当前 pending 登录状态（pending/approved/cancelled/expired）。
#[tauri::command]
fn auth_login_status(state: tauri::State<'_, AuthState>) -> Result<String, String> {
    let production = state.production;
    let session_id = {
        let pending = state
            .pending
            .lock()
            .map_err(|_| "AUTH_SERVICE_UNAVAILABLE")?;
        pending
            .as_ref()
            .map(|p| p.session_id.clone())
            .ok_or_else(|| "LOGIN_REQUEST_INVALID".to_string())?
    };
    auth_transport::status(&state, &session_id, production)
}

/// 确认后换取 desktopToken（token 存入 Rust 内存；前端拿不到明文）。
#[tauri::command]
fn auth_login_consume(state: tauri::State<'_, AuthState>) -> Result<serde_json::Value, String> {
    let production = state.production;
    let session_id = {
        let pending = state
            .pending
            .lock()
            .map_err(|_| "AUTH_SERVICE_UNAVAILABLE")?;
        pending
            .as_ref()
            .map(|p| p.session_id.clone())
            .ok_or_else(|| "LOGIN_REQUEST_INVALID".to_string())?
    };
    let expires_at = auth_transport::consume(&state, &session_id, production)?;
    Ok(serde_json::json!({ "ok": true, "expiresAt": expires_at }))
}

/// 启动校验：token 有效返回 authenticated，否则清理并返回 anonymous。
#[tauri::command]
fn auth_session_state(state: tauri::State<'_, AuthState>) -> Result<String, String> {
    match auth_transport::validate(&state, state.production) {
        Ok(true) => Ok("authenticated".into()),
        Ok(false) | Err(_) => {
            if let Ok(mut token) = state.token.lock() {
                *token = None;
            }
            Ok("anonymous".into())
        }
    }
}

/// 显式退出：撤销当前 desktop session。
#[tauri::command]
fn auth_logout(state: tauri::State<'_, AuthState>) -> Result<bool, String> {
    auth_transport::logout(&state, state.production)
}

// ============ Desktop 业务 commands（desktopDaily HTTP 云函数） ============

/// 读取今日记录（date 形如 YYYY-MM-DD；身份由服务端从 desktopToken 解析）。
#[tauri::command]
fn daily_get(
    state: tauri::State<'_, AuthState>,
    date: String,
) -> Result<serde_json::Value, String> {
    let token = auth_transport::require_token(&state)?;
    let body = serde_json::json!({ "action": "get", "date": date });
    auth_transport::http_post(&state, "/desktop-daily", &body, Some(&token))
}

/// 保存今日 goals/todos（服务端字段级合并 + requestId 幂等 + revision 乐观锁）。
#[tauri::command]
fn daily_save(
    state: tauri::State<'_, AuthState>,
    date: String,
    request_id: String,
    revision: i64,
    goals: Vec<serde_json::Value>,
    todos: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let token = auth_transport::require_token(&state)?;
    let body = serde_json::json!({
        "action": "save",
        "date": date,
        "requestId": request_id,
        "revision": revision,
        "goals": goals,
        "todos": todos
    });
    auth_transport::http_post(&state, "/desktop-daily", &body, Some(&token))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(build_auth_state())
        .setup(|app| {
            let app_handle = app.handle().clone();
            let main_window = app
                .get_webview_window("main")
                .ok_or("main window not found during setup")?;
            main_window.once("desktop-ui-ready", move |event| {
                eprintln!("desktop-ui-ready received: {}", event.payload());
                let payload = match serde_json::from_str::<DesktopUiReadyPayload>(event.payload()) {
                    Ok(payload) => payload,
                    Err(error) => {
                        eprintln!("desktop-ui-ready payload rejected: {error}");
                        return;
                    }
                };

                let dispatch_handle = app_handle.clone();
                if let Err(error) = app_handle.run_on_main_thread(move || {
                    match apply_window_opacity(&dispatch_handle, payload.opacity) {
                        Ok(applied) => eprintln!(
                            "desktop-ui-ready: native opacity applied at {:.0}%",
                            applied * 100.0
                        ),
                        Err(error) => eprintln!("desktop-ui-ready opacity failed: {error}"),
                    }
                }) {
                    eprintln!("desktop-ui-ready main-thread dispatch failed: {error}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_current_window_opacity,
            auth_start_login,
            auth_login_status,
            auth_login_consume,
            auth_session_state,
            auth_logout,
            daily_get,
            daily_save
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
