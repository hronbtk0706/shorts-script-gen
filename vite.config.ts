import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // ヘッドレス描画用の 2 つ目の HTML エントリ（curio-gen D9 ゲート）。
  // main=編集アプリ / render=renderLayersOnContext だけ回す軽量ページ。
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        render: "render.html",
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri` やテンプレ/セッション等の生成物
      // （templates/*.json が書き変わる度に HMR でリロードされないように）
      ignored: [
        "**/src-tauri/**",
        "**/templates/**",
        "**/sessions/**",
      ],
    },
  },
}));
