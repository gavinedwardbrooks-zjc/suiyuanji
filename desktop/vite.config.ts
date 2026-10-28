import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// 默认监听地址必须显式写成 127.0.0.1，不能用 `false`：
//   Node 22 + Windows 下 `host: false` 只绑 `[::1]:1420`（纯 IPv6），
//   而 src-tauri/tauri.conf.json 的 build.devUrl 是 `http://localhost:1420`，
//   WebView2 把 localhost 解析成 IPv4 的 127.0.0.1 → 连接被拒 → 原生窗口白屏。
//   绑 127.0.0.1 后两条路径落在同一地址上，`npm run tauri dev` 才直接可用。
// 仍需对外暴露（真机/局域网调试）时，照旧用环境变量 TAURI_DEV_HOST 覆盖。
const DEFAULT_DEV_HOST = "127.0.0.1";
const devHost = host || DEFAULT_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    // 与 tauri.conf.json 的 devUrl（localhost:1420）对应：localhost → 127.0.0.1
    host: devHost,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
