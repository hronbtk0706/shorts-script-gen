import { useEffect, useState } from "react";
import { ScriptForm } from "./components/ScriptForm";
import { ScriptResult } from "./components/ScriptResult";
import { SettingsModal } from "./components/SettingsModal";
import { VideoGenerator } from "./components/VideoGenerator";
import { AnalyticsPanel } from "./components/AnalyticsPanel";
import { getLlmProvider } from "./lib/providers/llm";
import { loadSettings, type AppSettings } from "./lib/storage";
import { loadRecords, computeInsights } from "./lib/analytics";
import { fetchYouTubeTrends } from "./lib/youtube";
import type { Script, ScriptInput } from "./types";

type Tab = "generate" | "analytics";

function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("generate");
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("生成中...");
  const [script, setScript] = useState<Script | null>(null);
  const [scriptInput, setScriptInput] = useState<ScriptInput | null>(null);
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

  const buildInsights = async (s: AppSettings, topic?: string) => {
    const records = await loadRecords();
    const performanceInsights = computeInsights(records) || undefined;

    let trendInsights: string | undefined;
    const searchKeyword = topic || s.contentNiche;
    if (s.youtubeApiKey && searchKeyword) {
      setLoadingMsg("YouTubeトレンドを取得中...");
      const trend = await fetchYouTubeTrends(s.youtubeApiKey, searchKeyword);
      trendInsights = trend?.summary;
    }

    return { trendInsights, performanceInsights };
  };

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
    setLoadingMsg("台本を生成中...");
    setError(null);
    setScript(null);
    setScriptInput(null);
    try {
      const { trendInsights, performanceInsights } = await buildInsights(s, input.topic);
      const enriched: ScriptInput = { ...input, trendInsights, performanceInsights };
      setLoadingMsg("台本を生成中...");
      const provider = getLlmProvider(s.llmProvider);
      const result = await provider.generateScript(enriched, s);
      setScript(result);
      setScriptInput(enriched);
    } catch (e) {
      setError(e instanceof Error ? e.message : "予期しないエラーが発生しました");
    } finally {
      setLoading(false);
    }
  };

  const handleAutoGenerate = async () => {
    const s = settings ?? (await refreshSettings());
    const keyMissing =
      (s.llmProvider === "gemini" && !s.geminiApiKey) ||
      (s.llmProvider === "groq" && !s.groqApiKey);
    if (keyMissing) {
      setSettingsOpen(true);
      return;
    }
    if (!s.contentNiche) {
      setSettingsOpen(true);
      setError("設定でジャンル・キーワードを登録してください");
      return;
    }
    setLoading(true);
    setError(null);
    setScript(null);
    setScriptInput(null);
    try {
      const { trendInsights, performanceInsights } = await buildInsights(s);

      setLoadingMsg("今日のトピックを選定中...");
      const provider = getLlmProvider(s.llmProvider);
      const suggestions = await provider.suggestTopics(
        {
          platform: "shorts",
          category: s.contentNiche,
          count: 1,
          trendInsights,
          performanceInsights,
        },
        s,
      );
      const topic = suggestions[0]?.topic ?? s.contentNiche;

      setLoadingMsg("台本を生成中...");
      const input: ScriptInput = {
        topic,
        platform: "shorts",
        duration: 60,
        trendInsights,
        performanceInsights,
      };
      const result = await provider.generateScript(input, s);
      setScript(result);
      setScriptInput(input);
    } catch (e) {
      setError(e instanceof Error ? e.message : "予期しないエラーが発生しました");
    } finally {
      setLoading(false);
    }
  };

  const videoApiKey = settings?.geminiApiKey ?? "";

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <header className="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <div className="max-w-5xl mx-auto px-6 py-4 flex justify-between items-center gap-4">
          <div className="flex items-center gap-4 flex-1 min-w-0">
            <div className="min-w-0">
              <h1 className="text-xl font-bold">ショート台本ジェネレーター</h1>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                AI がトレンドと実績から最適な動画を自動生成
              </p>
            </div>

            <button
              onClick={handleAutoGenerate}
              disabled={loading}
              className="shrink-0 px-4 py-2 rounded-lg bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 disabled:from-gray-400 disabled:to-gray-400 text-white font-semibold text-sm shadow transition whitespace-nowrap"
            >
              {loading ? loadingMsg : "今日の動画を生成"}
            </button>
          </div>

          <button
            onClick={() => setSettingsOpen(true)}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 shrink-0"
            title="設定"
          >
            ⚙️
          </button>
        </div>

        <div className="max-w-5xl mx-auto px-6 flex gap-1 border-t border-gray-100 dark:border-gray-800">
          {(["generate", "analytics"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                tab === t
                  ? "border-blue-600 text-blue-600 dark:text-blue-400"
                  : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
              }`}
            >
              {t === "generate" ? "台本生成" : "実績管理"}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        {tab === "generate" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
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
                  <div className="animate-pulse">{loadingMsg}</div>
                </div>
              )}
              {!loading && !script && !error && (
                <div className="flex flex-col items-center justify-center py-20 text-gray-400 text-sm gap-3">
                  <p>トピックを入力するか「今日の動画を生成」を押してください</p>
                </div>
              )}
              {script && (
                <div className="space-y-6">
                  <ScriptResult script={script} onChange={setScript} />
                  <VideoGenerator
                    apiKey={videoApiKey}
                    script={script}
                    scriptInput={scriptInput ?? undefined}
                  />
                </div>
              )}
            </section>
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

export default App;
