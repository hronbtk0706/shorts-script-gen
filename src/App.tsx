import { useEffect, useState } from "react";
import { ScriptForm, type ScriptFormSubmit } from "./components/ScriptForm";
import { ScriptResult } from "./components/ScriptResult";
import { SettingsModal } from "./components/SettingsModal";
import { AnalyticsPanel } from "./components/AnalyticsPanel";
import { CandidatePicker } from "./components/CandidatePicker";
import { TemplateManager } from "./components/TemplateManager";
import { ManualScriptSummary } from "./components/ManualScriptSummary";
import type { SelectionResult } from "./lib/providers/llm";
import { generateScriptWithPipeline } from "./lib/scriptGenerator";
import { loadSettings, type AppSettings } from "./lib/storage";
import { loadRecords, computeInsights } from "./lib/analytics";
import { fetchReferenceVideos } from "./lib/youtube";
import type { Script, ScriptInput } from "./types";

type Tab = "generate" | "templates" | "analytics";

function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("generate");
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("生成中...");
  const [script, setScript] = useState<Script | null>(null);
  const [scriptInput, setScriptInput] = useState<ScriptInput | null>(null);
  const [candidates, setCandidates] = useState<Script[] | null>(null);
  const [selection, setSelection] = useState<SelectionResult | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isManualMode, setIsManualMode] = useState(false);

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

  const buildInsights = async (
    s: AppSettings,
    topic: string | undefined,
    skipAutoFetch: boolean,
  ) => {
    const records = await loadRecords();
    const performanceInsights = computeInsights(records) || undefined;

    let trendInsights: string | undefined;
    let referenceBundle: import("./types").ReferenceBundle | undefined;
    if (!skipAutoFetch) {
      const searchKeyword = topic || s.contentNiche;
      if (searchKeyword) {
        setLoadingMsg("参考になるYouTubeショートを取得中...");
        const bundle = await fetchReferenceVideos(
          searchKeyword,
          s.referenceVideoCount,
        );
        if (bundle) {
          referenceBundle = bundle;
          trendInsights = bundle.promptText;
        }
      }
    }

    return { trendInsights, performanceInsights, referenceBundle };
  };

  const runGeneration = async (input: ScriptInput, s: AppSettings) => {
    const result = await generateScriptWithPipeline(input, s, {
      candidateCount: s.multiCandidateCount,
      onProgress: ({ stage, detail }) => {
        if (stage === "brainstorm") setLoadingMsg(detail ?? "切り口ブレスト中...");
        else if (stage === "generate") setLoadingMsg(detail ?? "候補を生成中...");
        else if (stage === "select") setLoadingMsg(detail ?? "候補を審査中...");
      },
    });
    setCandidates(result.candidates);
    setSelection(result.selection);
    setActiveIdx(result.selection.selected_index);
    setScript(result.winner);
  };

  const handleGenerate = async (submission: ScriptFormSubmit) => {
    const { input, mode, prebuiltScript } = submission;

    // 手動モード: AIをスキップして Script を直接セット
    if (mode === "manual" && prebuiltScript) {
      setError(null);
      setCandidates(null);
      setSelection(null);
      setIsManualMode(true);
      setScript(prebuiltScript);
      setScriptInput(input);
      return;
    }
    setIsManualMode(false);

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
    setCandidates(null);
    setSelection(null);
    try {
      const hasSelectedComments =
        (input.selectedComments?.length ?? 0) > 0;
      const { trendInsights, performanceInsights, referenceBundle } =
        await buildInsights(s, input.topic, hasSelectedComments);
      const enriched: ScriptInput = {
        ...input,
        trendInsights,
        performanceInsights,
        referenceBundle,
      };
      setLoadingMsg("台本を生成中...");
      await runGeneration(enriched, s);
      setScriptInput(enriched);
    } catch (e) {
      setError(e instanceof Error ? e.message : "予期しないエラーが発生しました");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <header className="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <div className="px-4 flex items-center gap-2">
          <div className="flex gap-1 shrink-0">
            {(["generate", "templates", "analytics"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  tab === t
                    ? "border-blue-600 text-blue-600 dark:text-blue-400"
                    : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                }`}
              >
                {t === "generate"
                  ? "台本生成"
                  : t === "templates"
                    ? "テンプレート管理"
                    : "実績管理"}
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
                  <p>左のフォームにトピックを入力して生成してください</p>
                </div>
              )}
              {script && (
                <div className="space-y-6">
                  {candidates && candidates.length > 1 && selection && (
                    <CandidatePicker
                      candidates={candidates}
                      activeIndex={activeIdx}
                      selection={selection}
                      onSelect={(i) => {
                        setActiveIdx(i);
                        setScript(candidates[i]);
                      }}
                    />
                  )}
                  {isManualMode && scriptInput ? (
                    <ManualScriptSummary scriptInput={scriptInput} />
                  ) : (
                    <ScriptResult script={script} onChange={setScript} />
                  )}
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    動画書き出しは「テンプレート管理」タブからテンプレートを開いて行ってください。
                  </p>
                </div>
              )}
            </section>
          </div>
        )}

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

export default App;
