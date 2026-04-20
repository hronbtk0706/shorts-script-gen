import { useEffect, useState } from "react";
import {
  listTemplates,
  saveTemplate,
  deleteTemplate,
  duplicateTemplate,
} from "../lib/templateStore";
import {
  analyzeTemplate,
  type AnalysisProgress,
} from "../lib/templateAnalyzer";
import { loadSettings } from "../lib/storage";
import type { VideoTemplate } from "../types";
import { TemplateBuilder } from "./TemplateBuilder";

type ViewMode = "list" | "url-analyze" | "manual-builder";

export function TemplateManager() {
  const [mode, setMode] = useState<ViewMode>("list");
  const [editingTemplate, setEditingTemplate] = useState<VideoTemplate | null>(
    null,
  );

  const [templates, setTemplates] = useState<VideoTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState<AnalysisProgress | null>(null);

  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");

  const reload = async () => {
    setLoading(true);
    try {
      const list = await listTemplates();
      setTemplates(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  const handleAnalyze = async () => {
    if (!url.trim()) {
      setError("YouTube URL を入力してください");
      return;
    }
    setError(null);
    setAnalyzing(true);
    setAnalyzeProgress({ stage: "validating" });
    try {
      const settings = await loadSettings();
      const template = await analyzeTemplate(settings.geminiApiKey, url.trim(), {
        customName: name.trim() || undefined,
        note: note.trim() || undefined,
        onProgress: setAnalyzeProgress,
      });
      await saveTemplate(template);
      setUrl("");
      setName("");
      setNote("");
      await reload();
      setMode("list");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalyzing(false);
      setAnalyzeProgress(null);
    }
  };

  const handleDelete = async (t: VideoTemplate) => {
    if (!confirm(`テンプレート「${t.name}」を削除しますか?（復元不可）`)) return;
    try {
      await deleteTemplate(t.id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDuplicate = async (t: VideoTemplate) => {
    try {
      const dup = duplicateTemplate(t);
      await saveTemplate(dup);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleEditStart = (t: VideoTemplate) => {
    setEditingTemplate(t);
    setMode("manual-builder");
  };

  const handleCreateNew = () => {
    setEditingTemplate(null);
    setMode("manual-builder");
  };

  const handleBuilderSaved = async () => {
    await reload();
    setEditingTemplate(null);
    setMode("list");
  };

  const stageLabel = (s: AnalysisProgress["stage"]) =>
    ({
      validating: "URL 検証中",
      fetching: "動画情報取得中",
      analyzing: "Gemini Vision 解析中（30〜60秒）",
      formatting: "テンプレ整形中",
      done: "完了",
    })[s];

  // ─── manual-builder モード: キャンバスエディタを全画面表示 ───
  if (mode === "manual-builder") {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => setMode("list")}
            className="text-blue-600 hover:underline"
          >
            ← 一覧に戻る
          </button>
          <span className="text-gray-500">
            {editingTemplate ? `編集中: ${editingTemplate.name}` : "新規テンプレ作成"}
          </span>
        </div>
        <TemplateBuilder
          editing={editingTemplate}
          onSaved={handleBuilderSaved}
          onCancel={() => {
            setEditingTemplate(null);
            setMode("list");
          }}
        />
      </div>
    );
  }

  // ─── list / url-analyze モード ───
  return (
    <div className="space-y-4">
      {/* モード切替トグル */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setMode("url-analyze")}
          className={`px-3 py-1.5 rounded text-sm ${
            mode === "url-analyze"
              ? "bg-blue-600 text-white"
              : "bg-gray-100 dark:bg-gray-800 hover:bg-gray-200"
          }`}
        >
          📹 URL から作成
        </button>
        <button
          type="button"
          onClick={handleCreateNew}
          className="px-3 py-1.5 rounded text-sm bg-emerald-600 text-white hover:bg-emerald-700"
        >
          ✏️ 手動で作成
        </button>
        <button
          type="button"
          onClick={() => setMode("list")}
          className={`ml-auto px-3 py-1.5 rounded text-sm ${
            mode === "list"
              ? "bg-blue-600 text-white"
              : "bg-gray-100 dark:bg-gray-800 hover:bg-gray-200"
          }`}
        >
          📋 一覧
        </button>
      </div>

      {mode === "url-analyze" && (
        <section className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-3">
          <h3 className="font-semibold">URL から解析して作成</h3>
          <div>
            <label className="block text-sm mb-1">
              お手本動画の URL <span className="text-red-500">*</span>
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.youtube.com/shorts/..."
              disabled={analyzing}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm"
            />
            <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">
              90秒以下の動画を推奨。Gemini Vision で構成・カット割りを解析します。
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-sm mb-1">テンプレ名（任意）</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="空欄なら AI が自動命名"
                disabled={analyzing}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm mb-1">メモ（任意）</label>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="用途・ジャンル等"
                disabled={analyzing}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm"
              />
            </div>
          </div>
          <button
            onClick={handleAnalyze}
            disabled={analyzing || !url.trim()}
            className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white text-sm font-medium"
          >
            {analyzing
              ? analyzeProgress
                ? stageLabel(analyzeProgress.stage)
                : "解析中..."
              : "動画を解析してテンプレート化"}
          </button>
          {error && (
            <div className="p-2 rounded bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}
        </section>
      )}

      {mode === "list" && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold">
              保存済みテンプレート（{templates.length}）
            </h3>
            <button
              onClick={reload}
              disabled={loading}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
            >
              🔄 更新
            </button>
          </div>
          {loading && <div className="text-sm text-gray-500">読み込み中...</div>}
          {!loading && templates.length === 0 && (
            <div className="text-sm text-gray-500 py-8 text-center">
              テンプレート未作成。上のボタンから作成してください。
            </div>
          )}
          <div className="space-y-2">
            {templates.map((t) => (
              <div
                key={t.id}
                className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div
                    className="flex-1 min-w-0 cursor-pointer"
                    onClick={() => handleEditStart(t)}
                  >
                    <div className="font-medium text-sm truncate">{t.name}</div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                      {t.totalDuration}秒 / {t.layers.length}レイヤー ·{" "}
                      {t.segments.length}セグメント
                      {t.themeVibe && ` / ${t.themeVibe}`}
                    </div>
                    {t.note && (
                      <div className="text-[11px] text-gray-400 italic mt-0.5">
                        {t.note}
                      </div>
                    )}
                    {t.sourceTitle && (
                      <div className="text-[10px] text-gray-400 mt-1 truncate">
                        元: {t.sourceTitle}
                        {t.sourceChannel && ` (${t.sourceChannel})`}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button
                      onClick={() => handleEditStart(t)}
                      className="p-1.5 text-xs rounded hover:bg-gray-100 dark:hover:bg-gray-800"
                      title="編集"
                    >
                      ✏️
                    </button>
                    <button
                      onClick={() => handleDuplicate(t)}
                      className="p-1.5 text-xs rounded hover:bg-gray-100 dark:hover:bg-gray-800"
                      title="複製"
                    >
                      📋
                    </button>
                    <button
                      onClick={() => handleDelete(t)}
                      className="p-1.5 text-xs rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600"
                      title="削除"
                    >
                      🗑
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
