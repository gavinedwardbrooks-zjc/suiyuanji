use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Duration;

const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const AUTH_PATH: &str = "/desktop-auth";

#[derive(Debug, Serialize)]
struct RequestBody<'a> {
    action: &'a str,
    // 字段名必须与服务端契约对齐（camelCase）：desktopAuthPublic 读
    // body.deviceId / body.deviceName / body.sessionId / body.pollSecret。
    // 2026-09-08 修复：此前无 rename 序列化为 snake_case 导致真云 500。
    #[serde(rename = "deviceId", skip_serializing_if = "Option::is_none")]
    device_id: Option<&'a str>,
    #[serde(rename = "deviceName", skip_serializing_if = "Option::is_none")]
    device_name: Option<&'a str>,
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    session_id: Option<&'a str>,
    #[serde(rename = "pollSecret", skip_serializing_if = "Option::is_none")]
    poll_secret: Option<&'a str>,
}

#[derive(Debug, Deserialize)]
struct ServiceResponse {
    ok: bool,
    #[serde(default)]
    code: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    nonce: Option<String>,
    #[serde(rename = "pollSecret")]
    poll_secret: Option<String>,
    #[serde(rename = "desktopToken")]
    desktop_token: Option<String>,
    #[serde(rename = "expiresAt")]
    expires_at: Option<i64>,
    status: Option<String>,
}

/// pending 登录会话的服务端握手凭据（仅驻留 Rust 内存；device 信息供 consume 复用）。
pub struct PendingLogin {
    pub session_id: String,
    pub poll_secret: String,
    pub device_id: String,
    pub device_name: String,
}

#[derive(Default)]
pub struct AuthState {
    pub base_url: String,
    /// true = 仅允许 HTTPS（生产）；false = 额外允许 localhost/127.0.0.1 HTTP（本地联调）
    pub production: bool,
    pub pending: Mutex<Option<PendingLogin>>,
    pub token: Mutex<Option<String>>,
}

/// 从 AuthState 取出当前 desktop token（未登录返回 DESKTOP_SESSION_INVALID）。
pub fn require_token(state: &AuthState) -> Result<String, String> {
    state
        .token
        .lock()
        .map_err(|_| "AUTH_SERVICE_UNAVAILABLE".to_string())?
        .clone()
        .ok_or_else(|| "DESKTOP_SESSION_INVALID".to_string())
}

/// 业务端点白名单：与 auth 共用同一 base_url，仅允许固定 path。
const ALLOWED_BUSINESS_PATHS: [&str; 1] = ["/desktop-daily"];

/// 通用 POST（仅限白名单 path），Bearer 可选；用于已登录 Desktop 的业务数据读写。
/// 解析统一业务响应 { ok: boolean, code?: string }；ok=false 时返回 code 作为 Err。
pub fn http_post(
    state: &AuthState,
    path: &str,
    body: &serde_json::Value,
    bearer: Option<&str>,
) -> Result<serde_json::Value, String> {
    if !ALLOWED_BUSINESS_PATHS.contains(&path) {
        return Err("AUTH_SERVICE_UNAVAILABLE".into());
    }
    let url = endpoint(&state.base_url, state.production)?;
    let base = url
        .strip_suffix(AUTH_PATH)
        .ok_or_else(|| "AUTH_SERVICE_UNAVAILABLE".to_string())?;
    let full_url = format!("{base}{path}");
    let client = Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| "AUTH_SERVICE_UNAVAILABLE")?;
    let mut req = client
        .post(full_url)
        .header("content-type", "application/json")
        .json(body);
    if let Some(value) = bearer {
        req = req.bearer_auth(value);
    }
    let response = req.send().map_err(|_| "NETWORK_ERROR")?;
    if !response.status().is_success() {
        return Err(if response.status().is_server_error() {
            "AUTH_SERVICE_UNAVAILABLE"
        } else {
            "LOGIN_REQUEST_INVALID"
        }
        .into());
    }
    let bytes = response.bytes().map_err(|_| "INVALID_RESPONSE")?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("INVALID_RESPONSE".into());
    }
    let parsed: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "INVALID_RESPONSE")?;
    if parsed.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let code = parsed
            .get("code")
            .and_then(|v| v.as_str())
            .unwrap_or("INVALID_RESPONSE");
        return Err(code.to_string());
    }
    Ok(parsed)
}

fn endpoint(base_url: &str, production: bool) -> Result<String, String> {
    let trimmed = base_url.trim_end_matches('/');
    if trimmed.is_empty() { return Err("AUTH_SERVICE_UNAVAILABLE".into()); }
    let is_local = trimmed.starts_with("http://localhost") || trimmed.starts_with("http://127.0.0.1");
    if production && !trimmed.starts_with("https://") { return Err("AUTH_SERVICE_UNAVAILABLE".into()); }
    if !production && !trimmed.starts_with("https://") && !is_local { return Err("AUTH_SERVICE_UNAVAILABLE".into()); }
    Ok(format!("{trimmed}{AUTH_PATH}"))
}

fn call(state: &AuthState, request: &RequestBody<'_>, token: Option<&str>, production: bool) -> Result<ServiceResponse, String> {
    let url = endpoint(&state.base_url, production)?;
    let log_url = url.clone(); // 仅诊断日志使用（url 随后被 post() move）
    let client = Client::builder().timeout(Duration::from_secs(8)).build().map_err(|_| "AUTH_SERVICE_UNAVAILABLE")?;
    let mut req = client.post(url).header("content-type", "application/json").json(request);
    if let Some(value) = token { req = req.bearer_auth(value); }
    // 临时开发诊断：仅打印 url 与底层错误；不打印 body/pollSecret/token/nonce，
    // 协议零改动，UI 仍只收到 NETWORK_ERROR（2026-09-08 debug 用，勿提交）
    let response = req.send().map_err(|e| {
        eprintln!("desktop auth request failed: url={}, error={:?}", log_url, e);
        "NETWORK_ERROR"
    })?;
    if !response.status().is_success() { return Err(if response.status().is_server_error() { "AUTH_SERVICE_UNAVAILABLE" } else { "LOGIN_REQUEST_INVALID" }.into()); }
    let bytes = response.bytes().map_err(|_| "INVALID_RESPONSE")?;
    if bytes.len() > MAX_RESPONSE_BYTES { return Err("INVALID_RESPONSE".into()); }
    let parsed: ServiceResponse = serde_json::from_slice(&bytes).map_err(|_| "INVALID_RESPONSE")?;
    if !parsed.ok { return Err(map_code(parsed.code.as_deref())); }
    Ok(parsed)
}

fn map_code(code: Option<&str>) -> String {
    match code.unwrap_or("") {
        "INVALID_DESKTOP_SESSION" => "DESKTOP_SESSION_INVALID",
        "INVALID_LOGIN_REQUEST" | "SESSION_EXPIRED" | "SESSION_NOT_APPROVED" => "LOGIN_REQUEST_INVALID",
        _ => "AUTH_SERVICE_UNAVAILABLE",
    }.into()
}

pub fn create(state: &AuthState, device_id: &str, device_name: &str, production: bool) -> Result<(String, String, String, i64), String> {
    let response = call(state, &RequestBody { action: "create", device_id: Some(device_id), device_name: Some(device_name), session_id: None, poll_secret: None }, None, production)?;
    let session_id = response.session_id.ok_or("INVALID_RESPONSE")?;
    let nonce = response.nonce.ok_or("INVALID_RESPONSE")?;
    let expires = response.expires_at.ok_or("INVALID_RESPONSE")?;
    let poll_secret = response.poll_secret.ok_or("INVALID_RESPONSE")?;
    *state.pending.lock().map_err(|_| "AUTH_SERVICE_UNAVAILABLE")? = Some(PendingLogin {
        session_id: session_id.clone(),
        poll_secret: poll_secret.clone(),
        device_id: device_id.to_string(),
        device_name: device_name.to_string(),
    });
    Ok((session_id, nonce, poll_secret, expires))
}

pub fn status(state: &AuthState, session_id: &str, production: bool) -> Result<String, String> {
    let pending = state.pending.lock().map_err(|_| "AUTH_SERVICE_UNAVAILABLE")?;
    let p = pending.as_ref().ok_or("LOGIN_REQUEST_INVALID")?;
    if p.session_id != session_id { return Err("LOGIN_REQUEST_INVALID".into()); }
    // pollSecret 走 body（服务端契约），不再放 Bearer
    let response = call(state, &RequestBody { action: "status", device_id: None, device_name: None, session_id: Some(session_id), poll_secret: Some(&p.poll_secret) }, None, production)?;
    response.status.ok_or("INVALID_RESPONSE".into())
}

pub fn consume(state: &AuthState, session_id: &str, production: bool) -> Result<i64, String> {
    let pending = state.pending.lock().map_err(|_| "AUTH_SERVICE_UNAVAILABLE")?;
    let p = pending.as_ref().ok_or("LOGIN_REQUEST_INVALID")?;
    if p.session_id != session_id { return Err("LOGIN_REQUEST_INVALID".into()); }
    // consume 需带 deviceId/deviceName（服务端创建 desktop_sessions 必填），pollSecret 走 body
    let response = call(state, &RequestBody { action: "consume", device_id: Some(&p.device_id), device_name: Some(&p.device_name), session_id: Some(session_id), poll_secret: Some(&p.poll_secret) }, None, production)?;
    let token = response.desktop_token.ok_or("INVALID_RESPONSE")?;
    let expires = response.expires_at.ok_or("INVALID_RESPONSE")?;
    drop(pending);
    *state.token.lock().map_err(|_| "AUTH_SERVICE_UNAVAILABLE")? = Some(token);
    *state.pending.lock().map_err(|_| "AUTH_SERVICE_UNAVAILABLE")? = None;
    Ok(expires)
}

pub fn validate(state: &AuthState, production: bool) -> Result<bool, String> {
    let token = state.token.lock().map_err(|_| "AUTH_SERVICE_UNAVAILABLE")?.clone().ok_or("DESKTOP_SESSION_INVALID")?;
    call(state, &RequestBody { action: "validate", device_id: None, device_name: None, session_id: None, poll_secret: None }, Some(&token), production)?;
    Ok(true)
}

pub fn logout(state: &AuthState, production: bool) -> Result<bool, String> {
    let token = state.token.lock().map_err(|_| "AUTH_SERVICE_UNAVAILABLE")?.clone().ok_or("DESKTOP_SESSION_INVALID")?;
    call(state, &RequestBody { action: "logout", device_id: None, device_name: None, session_id: None, poll_secret: None }, Some(&token), production)?;
    *state.token.lock().map_err(|_| "AUTH_SERVICE_UNAVAILABLE")? = None;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn production_rejects_http() { assert_eq!(endpoint("http://example.test", true), Err("AUTH_SERVICE_UNAVAILABLE".into())); }
    #[test]
    fn only_local_http_allowed_in_dev() { assert!(endpoint("http://localhost:3000", false).is_ok()); assert!(endpoint("http://example.test", false).is_err()); }
    #[test]
    fn error_mapping_is_safe() { assert_eq!(map_code(Some("INVALID_DESKTOP_SESSION")), "DESKTOP_SESSION_INVALID"); assert_eq!(map_code(Some("db stack")), "AUTH_SERVICE_UNAVAILABLE"); }
}
