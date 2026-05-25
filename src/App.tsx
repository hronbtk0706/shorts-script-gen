import { Component, useEffect, useState, type ReactNode } from "react";
import { SettingsModal } from "./components/SettingsModal";
import { AnalyticsPanel } from "./components/AnalyticsPanel";
import { TemplateManager } from "./components/TemplateManager";
import { loadSettings } from "./lib/storage";

type Tab = "templates" | "analytics";

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("templates");

  const refreshSettings = async () => {
    await loadSettings();
  };

  useEffect(() => {
    // 旧 templates/audio/{tid}/ → templates/assets/{tid}/audio/ への 1 回限りの移行。
    // 既に templates/audio/ が無ければ何もしないので毎回起動時に呼んで OK。
    import("./lib/assetImport")
      .then(({ migrateLegacyAudioDirs }) => migrateLegacyAudioDirs())
      .then((n) => {
        if (n > 0) console.info(`[migration] migrated audio for ${n} template(s)`);
      })
      .catch((e) => console.warn("[migration] failed:", e));
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <header className="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <div className="px-4 flex items-center gap-2">
          <div className="flex gap-1 shrink-0">
            {(["templates", "analytics"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  tab === t
                    ? "border-blue-600 text-blue-600 dark:text-blue-400"
                    : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                }`}
              >
                {t === "templates" ? "編集" : "実績管理"}
              </button>
            ))}
          </div>
          {/* 子コンポーネント（TemplateBuilder 等）がここにポータルで描画 */}
          <div
            id="app-header-slot"
            className="flex-1 flex justify-end items-center gap-2"
          />
          <button
            onClick={() => setSettingsOpen(true)}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 shrink-0"
            title="設定"
          >
            ⚙️
          </button>
        </div>
      </header>

      <main className="px-6 py-2">
        {tab === "templates" && (
          <div className="w-full">
            <TemplateManager />
          </div>
        )}

        {tab === "analytics" && (
          <div className="max-w-2xl">
            <h2 className="text-lg font-semibold mb-4">実績管理</h2>
            <AnalyticsPanel />
          </div>
        )}
      </main>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={refreshSettings}
      />
    </div>
  );
}

/** ルートレベルのエラーバウンダリ。React 描画中の例外で画面が真っ白になるのを防ぎ、
 *  原因メッセージ + スタックを表示してリロードボタンを出す。 */
class RootErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("[RootErrorBoundary] caught:", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "#1a1a1a",
            color: "#f87171",
            padding: 24,
            overflow: "auto",
            fontFamily: "monospace",
            fontSize: 12,
            whiteSpace: "pre-wrap",
          }}
        >
          <h1 style={{ fontSize: 16, marginBottom: 12 }}>
            ⚠ アプリケーションエラー
          </h1>
          <div style={{ marginBottom: 12 }}>
            {this.state.error.message}
          </div>
          <details>
            <summary style={{ cursor: "pointer" }}>スタックトレース</summary>
            <div style={{ marginTop: 8 }}>{this.state.error.stack}</div>
          </details>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: 16,
              padding: "6px 12px",
              background: "#3b82f6",
              color: "white",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            リロード
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function AppWithBoundary() {
  return (
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  );
}

export default AppWithBoundary;
