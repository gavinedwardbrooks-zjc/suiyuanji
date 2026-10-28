import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as QRCode from "qrcode";
import "./App.css";

const OPACITY_KEY = "v21.opacity";
const AOT_KEY = "v21.alwaysOnTop";
const PRESETS = [
  { label: "20%", value: 0.2 },
  { label: "35%", value: 0.35 },
  { label: "50%", value: 0.5 },
  { label: "70%", value: 0.7 },
  { label: "100%", value: 1.0 },
];
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

type Goal = { text: string; done: boolean; reminderOn: boolean; reminderTime: string };
type Todo = { text: string; done: boolean };
type Phase = "boot" | "anonymous" | "pending" | "authenticated";

function pad(n: number) {
  return String(n).padStart(2, "0");
}
function fmtDate(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function genRequestId() {
  return "req_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}
function emptyGoals(): Goal[] {
  return [
    { text: "", done: false, reminderOn: false, reminderTime: "21:00" },
    { text: "", done: false, reminderOn: false, reminderTime: "21:00" },
    { text: "", done: false, reminderOn: false, reminderTime: "21:00" },
  ];
}

type LoginResult = { ok: boolean; sessionId: string; qrText: string; expiresAt: number };
type DailyResult = {
  ok: boolean;
  record?: { goals?: Goal[]; todos?: Todo[]; revision?: number; updatedAt?: number | null } | null;
  revision?: number;
  code?: string;
  idempotent?: boolean;
};

function App() {
  const win = getCurrentWindow();

  // ---- native window 能力（保留自 PoC） ----
  const [opacity, setOpacityState] = useState(1);
  const [alwaysOnTop, setAlwaysOnTopState] = useState(false);
  const [winInfo, setWinInfo] = useState("");
  const [invokeOk, setInvokeOk] = useState("");
  const opacityRef = useRef(1);
  const aotRef = useRef(false);
  opacityRef.current = opacity;
  aotRef.current = alwaysOnTop;

  // ---- 登录与业务 ----
  const [phase, setPhase] = useState<Phase>("boot");
  const [loginBusy, setLoginBusy] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [loginHint, setLoginHint] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [today] = useState(() => new Date());

  const [goals, setGoals] = useState<Goal[]>(emptyGoals());
  const [todos, setTodos] = useState<Todo[]>([]);
  const [todoDraft, setTodoDraft] = useState("");
  const [cloudRevision, setCloudRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const pollTimer = useRef<number | null>(null);
  const dateStr = fmtDate(today);
  const dateLabel = `${today.getMonth() + 1}月${today.getDate()}日 星期${WEEK[today.getDay()]}`;

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const loadDaily = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setError("");
      setConflict(false);
      try {
        const r = await invoke<DailyResult>("daily_get", { date: dateStr });
        if (r.record) {
          setGoals(Array.isArray(r.record.goals) && r.record.goals.length ? r.record.goals : emptyGoals());
          setTodos(r.record.todos || []);
          setCloudRevision(typeof r.record.revision === "number" ? r.record.revision : 0);
        } else {
          setGoals(emptyGoals());
          setTodos([]);
          setCloudRevision(0);
        }
        setDirty(false);
      } catch (e) {
        if (!silent) setError("加载失败，请稍后重试");
        console.error("daily_get failed", e);
      } finally {
        setLoading(false);
      }
    },
    [dateStr]
  );

  const startLogin = useCallback(async () => {
    if (loginBusy) return;
    setLoginBusy(true);
    setError("");
    setLoginHint("");
    setQrDataUrl("");
    stopPolling();
    try {
      const r = await invoke<LoginResult>("auth_start_login");
      setPhase("pending");
      const url = await QRCode.toDataURL(r.qrText, {
        margin: 1,
        width: 230,
        color: { dark: "#4a3f35", light: "#fffdf7" },
      });
      setQrDataUrl(url);
      setCountdown(Math.max(0, Math.round((r.expiresAt - Date.now()) / 1000)));
      setLoginHint("用手机微信扫一扫，在小程序中确认登录");
    } catch (e) {
      const code = String(e);
      if (code.includes("AUTH_SERVICE_UNAVAILABLE")) {
        setError("登录服务尚未配置（缺少桌面版服务端地址），暂时无法扫码登录");
      } else if (code.includes("NETWORK_ERROR")) {
        setError("连不上登录服务，请检查网络后重试");
      } else {
        setError("连接服务失败，请稍后重试");
      }
      console.error("auth_start_login failed", e);
    } finally {
      setLoginBusy(false);
    }
  }, [loginBusy, stopPolling]);

  // pending 轮询：approved → consume → 已登录
  useEffect(() => {
    if (phase !== "pending") return;
    stopPolling();
    pollTimer.current = window.setInterval(async () => {
      try {
        const status = await invoke<string>("auth_login_status");
        if (status === "approved") {
          stopPolling();
          try {
            await invoke("auth_login_consume");
            setPhase("authenticated");
            void loadDaily(true);
          } catch (e) {
            setError("登录确认失败，请重新生成二维码");
            setPhase("anonymous");
            console.error("consume failed", e);
          }
        } else if (status === "cancelled") {
          stopPolling();
          setLoginHint("登录已取消");
          setPhase("anonymous");
        } else if (status === "expired") {
          stopPolling();
          setLoginHint("二维码已过期，请重新生成");
          setPhase("anonymous");
        }
      } catch (e) {
        const msg = String(e);
        if (msg === "SESSION_NOT_PENDING" || msg === "SESSION_EXPIRED" || msg === "LOGIN_REQUEST_INVALID") {
          stopPolling();
          setLoginHint("登录已失效，请重新生成二维码");
          setPhase("anonymous");
        } else {
          setLoginHint("网络似乎不太稳定，正在重试…");
          console.error("poll failed", e);
        }
      }
    }, 1500);
    return stopPolling;
  }, [phase, stopPolling, loadDaily]);

  // 倒计时（pending 时）
  useEffect(() => {
    if (phase !== "pending" || countdown <= 0) return;
    const t = window.setInterval(() => setCountdown((c) => Math.max(0, c - 1)), 1000);
    return () => window.clearInterval(t);
  }, [phase, countdown]);

  // 启动：恢复窗口能力 + 会话校验
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const savedOpacity = Number(localStorage.getItem(OPACITY_KEY) ?? "1");
        const savedAot = localStorage.getItem(AOT_KEY) === "1";
        const v = Math.min(1, Math.max(0.2, savedOpacity));
        if (!cancelled) setOpacityState(v);
        if (savedAot) {
          await win.setAlwaysOnTop(true);
          if (!cancelled) setAlwaysOnTopState(true);
        }
        await emitTo("main", "desktop-ui-ready", { opacity: v });
        if (!cancelled) setInvokeOk(`native opacity=${Math.round(v * 100)}%`);
      } catch (e) {
        if (!cancelled) setInvokeOk("启动恢复失败");
        console.error("boot restore failed", e);
      }
      try {
        const s = await invoke<string>("auth_session_state");
        if (!cancelled) setPhase(s === "authenticated" ? "authenticated" : "anonymous");
      } catch (e) {
        if (!cancelled) setPhase("anonymous");
        console.error("auth_session_state failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 已登录后加载今日
  useEffect(() => {
    if (phase === "authenticated") void loadDaily(true);
  }, [phase, loadDaily]);

  // 窗口状态轮询（仅设置面板打开时）
  useEffect(() => {
    if (!settingsOpen) return;
    const t = window.setInterval(async () => {
      try {
        const [s, p, aot] = await Promise.all([win.outerSize(), win.outerPosition(), win.isAlwaysOnTop()]);
        setWinInfo(`size=${Math.round(s.width)}x${Math.round(s.height)}  pos=(${Math.round(p.x)}, ${Math.round(p.y)})  alwaysOnTop=${aot}`);
      } catch {
        /* ignore */
      }
    }, 1000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen]);

  async function setOpacity(v: number) {
    const clamped = Math.min(1, Math.max(0.2, v));
    setOpacityState(clamped);
    localStorage.setItem(OPACITY_KEY, String(clamped));
    try {
      const r = await invoke<number>("set_current_window_opacity", { value: clamped });
      setInvokeOk(`opacity=${Math.round(r * 100)}% 已应用`);
    } catch (e) {
      setInvokeOk("opacity 应用失败");
      console.error(e);
    }
  }

  async function toggleAot() {
    const next = !aotRef.current;
    setAlwaysOnTopState(next);
    localStorage.setItem(AOT_KEY, next ? "1" : "0");
    try {
      await win.setAlwaysOnTop(next);
      setInvokeOk(`始终置顶 ${next ? "开" : "关"}`);
    } catch (e) {
      setInvokeOk("置顶切换失败");
      console.error(e);
    }
  }

  async function restoreDefault() {
    localStorage.removeItem(OPACITY_KEY);
    localStorage.removeItem(AOT_KEY);
    await setOpacity(1);
    try {
      await win.setAlwaysOnTop(false);
      setAlwaysOnTopState(false);
      setInvokeOk("已恢复默认：100% 不置顶");
    } catch (e) {
      setInvokeOk("恢复失败");
      console.error(e);
    }
  }

  // ---- 今日目标 ----
  function markDirty() {
    setDirty(true);
    setNotice("");
    setError("");
    setConflict(false);
  }
  function editGoal(i: number, text: string) {
    setGoals((gs) => gs.map((g, idx) => (idx === i ? { ...g, text } : g)));
    markDirty();
  }
  function toggleGoal(i: number) {
    setGoals((gs) => gs.map((g, idx) => (idx === i ? { ...g, done: !g.done } : g)));
    markDirty();
  }

  // ---- 今日小事 ----
  function addTodo() {
    const t = todoDraft.trim();
    if (!t) return;
    setTodos((ts) => [...ts, { text: t, done: false }]);
    setTodoDraft("");
    markDirty();
  }
  function toggleTodo(i: number) {
    setTodos((ts) => ts.map((t, idx) => (idx === i ? { ...t, done: !t.done } : t)));
    markDirty();
  }
  function removeTodo(i: number) {
    setTodos((ts) => ts.filter((_, idx) => idx !== i));
    markDirty();
  }

  // ---- 保存（requestId + revision 幂等契约） ----
  async function saveNow() {
    if (saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    setConflict(false);
    try {
      const r = await invoke<DailyResult>("daily_save", {
        date: dateStr,
        requestId: genRequestId(),
        revision: cloudRevision,
        goals,
        todos,
      });
      if (r.ok) {
        setCloudRevision(typeof r.revision === "number" ? r.revision : cloudRevision + 1);
        setDirty(false);
        setNotice("已保存");
      } else {
        setError("保存失败，请稍后重试");
      }
    } catch (e) {
      const msg = String(e);
      if (msg === "REV_CONFLICT") {
        setConflict(true);
      } else {
        setError("保存失败，请稍后重试");
        console.error("daily_save failed", e);
      }
    } finally {
      setSaving(false);
    }
  }

  async function logout() {
    if (!window.confirm("退出登录后，这台电脑需要重新扫码登录。确定退出吗？")) return;
    setLoginBusy(true);
    try {
      await invoke("auth_logout");
      setPhase("anonymous");
      setGoals(emptyGoals());
      setTodos([]);
      setCloudRevision(0);
      setDirty(false);
      setNotice("");
    } catch (e) {
      setError("退出失败，请稍后重试");
      console.error("logout failed", e);
    } finally {
      setLoginBusy(false);
    }
  }

  const doneGoals = goals.filter((g) => g.done).length;
  const loadingView = (
    <section className="paper-card boot-card">
      <p className="muted">正在唤醒小本子…</p>
    </section>
  );

  const loginView = (
    <section className="paper-card login-card">
      <h2 className="card-title">登录</h2>
      <p className="muted">在电脑上写下今天的目标和小事，手机上也能看到同一份记录。</p>
      {error && <p className="error-line">{error}</p>}
      {loginHint && !qrDataUrl && <p className="muted small">{loginHint}</p>}
      <button className="soft-btn primary wide" onClick={startLogin} disabled={loginBusy}>
        {loginBusy ? "正在连接…" : "使用微信登录"}
      </button>
      <p className="hint">扫码登录后，这台电脑读取的是你自己的手账数据</p>
    </section>
  );

  const pendingView = (
    <section className="paper-card login-card">
      <h2 className="card-title">扫码登录</h2>
      {qrDataUrl ? (
        <div className="qr-wrap">
          <img className="qr-img" src={qrDataUrl} alt="登录二维码" />
        </div>
      ) : (
        <div className="qr-wrap qr-empty">二维码生成中…</div>
      )}
      <p className="login-state">{loginHint || "等待手机确认…"}</p>
      {countdown > 0 && <p className="hint">二维码 {countdown} 秒后过期</p>}
      {error && <p className="error-line">{error}</p>}
      <div className="row-actions">
        <button className="soft-btn ghost" onClick={startLogin} disabled={loginBusy}>
          重新生成
        </button>
        <button
          className="soft-btn ghost"
          onClick={() => {
            stopPolling();
            setPhase("anonymous");
            setQrDataUrl("");
            setLoginHint("");
          }}
        >
          返回
        </button>
      </div>
      <p className="hint">用手机微信「扫一扫」读取二维码，在小程序中点确认</p>
    </section>
  );

  const homeView = (
    <>
      <div className="topline">
        <button
          className="text-btn"
          onClick={() => {
            setError("");
            void loadDaily(false);
          }}
        >
          {loading ? "刷新中…" : "刷新"}
        </button>
        <button className="soft-btn ghost small" onClick={logout} disabled={loginBusy}>
          退出登录
        </button>
      </div>
      {error && <p className="error-line">{error}</p>}
      {conflict && (
        <div className="conflict-banner">
          <span>这份记录在别处被修改过。</span>
          <div className="row-actions inline">
            <button
              className="soft-btn primary small"
              onClick={() => {
                setConflict(false);
                void loadDaily(false);
              }}
            >
              重新加载
            </button>
            <button className="soft-btn ghost small" onClick={() => setConflict(false)}>
              稍后处理
            </button>
          </div>
        </div>
      )}

      <div className="main-grid">
        <section className="paper-card goals-card">
          <h2 className="card-title">
            今日目标<span className="goal-count">{doneGoals}/{goals.length}</span>
          </h2>
          <div className="goal-list">
            {goals.map((g, i) => (
              <div className={`goal-row ${g.done ? "is-done" : ""}`} key={i}>
                <label className="check-dot" aria-label={g.done ? "取消完成" : "标记完成"}>
                  <input type="checkbox" checked={g.done} onChange={() => toggleGoal(i)} />
                  <span className="dot" />
                </label>
                <input
                  className="goal-input"
                  value={g.text}
                  maxLength={100}
                  placeholder="今天想完成什么？"
                  onChange={(e) => editGoal(i, e.target.value)}
                />
              </div>
            ))}
          </div>
          <p className="hint">点左边的圆点标记完成；完成后在手机上也一样</p>
        </section>

        <section className="paper-card todos-card">
          <h2 className="card-title">今日小事</h2>
          <div className="todo-compose">
            <input
              className="todo-input"
              value={todoDraft}
              maxLength={200}
              placeholder="还有什么事，随手记一笔"
              onChange={(e) => setTodoDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addTodo();
              }}
            />
            <button className="soft-btn primary" onClick={addTodo}>
              ＋
            </button>
          </div>
          <div className="todo-list">
            {todos.length === 0 && <p className="empty-line">还没有小事，记一件吧</p>}
            {todos.map((t, i) => (
              <div className={`todo-row ${t.done ? "is-done" : ""}`} key={i}>
                <label className="check-dot" aria-label={t.done ? "取消完成" : "标记完成"}>
                  <input type="checkbox" checked={t.done} onChange={() => toggleTodo(i)} />
                  <span className="dot" />
                </label>
                <span className="todo-text">{t.text}</span>
                <button className="del-btn" aria-label="删除" onClick={() => removeTodo(i)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="save-bar">
        <button className="soft-btn primary save-btn" onClick={saveNow} disabled={saving}>
          {saving ? "保存中…" : dirty ? "保存今日" : "已同步"}
        </button>
        {(notice || (dirty && !saving)) && (
          <span className="save-note">{dirty && !saving ? "有未保存的修改" : notice}</span>
        )}
      </div>

      <section className="paper-card settings-card">
        <button className="text-btn settings-toggle" onClick={() => setSettingsOpen((v) => !v)}>
          {settingsOpen ? "收起窗口设置 ▲" : "窗口设置 ▼"}
        </button>
        {settingsOpen && (
          <div className="settings-body">
            <h3 className="sub-title">窗口透明度</h3>
            <div className="slider-row">
              <span className="pct">{Math.round(opacity * 100)}%</span>
              <input
                className="slider"
                type="range"
                min={20}
                max={100}
                step={5}
                value={Math.round(opacity * 100)}
                onChange={(e) => setOpacity(Number(e.target.value) / 100)}
              />
            </div>
            <div className="presets">
              {PRESETS.map((p) => (
                <button key={p.label} className="chip" onClick={() => setOpacity(p.value)}>
                  {p.label}
                </button>
              ))}
            </div>
            <h3 className="sub-title">置顶</h3>
            <button className={`soft-btn ${alwaysOnTop ? "on" : "ghost"} wide`} onClick={toggleAot}>
              {alwaysOnTop ? "● 置顶中 — 点击关闭" : "○ 未置顶 — 点击开启"}
            </button>
            <div className="win-meta">
              <p className="mono dim">{winInfo || "打开设置以查看窗口状态"}</p>
              <p className="mono dim">{invokeOk || ""}</p>
              <button className="text-btn" onClick={restoreDefault}>
                恢复默认（100% · 不置顶）
              </button>
            </div>
          </div>
        )}
      </section>
    </>
  );

  return (
    <main className="container">
      <header className="app-head">
        <div>
          <h1>碎愿集</h1>
          <p className="date-line">
            {dateLabel} · 桌面小本子
            {phase === "authenticated" && <span className="conn-dot">已连接</span>}
            {phase === "anonymous" && <span className="conn-dot off">未登录</span>}
          </p>
        </div>
      </header>
      {phase === "boot" && loadingView}
      {phase === "anonymous" && loginView}
      {phase === "pending" && pendingView}
      {phase === "authenticated" && homeView}
      <footer className="foot">
        <p className="dim">碎愿集 · 桌面版</p>
      </footer>
    </main>
  );
}

export default App;
