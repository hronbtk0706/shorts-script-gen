import { useEffect, useState } from "react";
import { ScriptForm } from "./components/ScriptForm";
import { ScriptResult } from "./components/ScriptResult";
import { SettingsModal } from "./components/SettingsModal";
import { VideoGenerator } from "./components/VideoGenerator";
import { getLlmProvider } from "./lib/providers/llm";
import { loadSettings, type AppSettings } from "./lib/storage";
import type { Script, ScriptInput } from "./types";

function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [script, setScript] = useState<Script | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshSettings = async () => {
    const s = await loadSettings();
    setSettings(s);
    return s;
  };

  useEffect(() => {
    refreshSettings().then((s) => {
      const keyMissing =
        (s.llmProvider === "gemini" && !s.geminiApiKey) ||
        (s.llmProvider === "groq" && !s.groqApiKey);
      if (keyMissing) setSettingsOpen(true);
    });
  }, []);

  const handleGenerate = async (input: ScriptInput) => {
    const s = settings ?? (await refreshSettings());
    const keyMissing =
      (s.llmProvider === "gemini" && !s.geminiApiKey) ||
      (s.llmProvider === "groq" && !s.groqApiKey);
    if (keyMissing) {
      setSettingsOpen(true);
      return;
    }
    setLoading(true);
    setError(null);
    setScript(null);
    try {
      const provider = getLlmProvider(s.llmProvider);
      const result = await provider.generateScript(input, s);
      setScript(result);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "予期しないエラーが発生しました",
      );
    } finally {
      setLoading(false);
    }
  };

  const videoApiKey = settings?.geminiApiKey ?? "";

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <header className="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <div className="max-w-5xl mx-auto px-6 py-4 flex justify-between items-center">
          <div>
            <h1 className="text-xl font-bold">ショート台本ジェネレーター</h1>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              AI がトピックから構造化された台本を生成します
            </p>
          </div>
          <button
            onClick={() => setSettingsOpen(true)}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
            title="設定"
          >
            ⚙️
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-2 gap-8">
        <section>
          <h2 className="text-lg font-semibold mb-4">入力</h2>
          <ScriptForm onSubmit={handleGenerate} loading={loading} />
          {error && (
            <div className="mt-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">
              {error}
            </div>
          )}
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-4">結果</h2>
          {loading && (
            <div className="flex items-center justify-center py-20 text-gray-500">
              <div className="animate-pulse">生成中...</div>
            </div>
          )}
          {!loading && !script && !error && (
            <div className="flex items-center justify-center py-20 text-gray-400 text-sm">
              トピックを入力して台本を生成してください
            </div>
          )}
          {script && (
            <div className="space-y-6">
              <ScriptResult script={script} onChange={setScript} />
              <VideoGenerator apiKey={videoApiKey} script={script} />
            </div>
          )}
        </section>
      </main>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={refreshSettings}
      />
    </div>
  );
}

export default App;
