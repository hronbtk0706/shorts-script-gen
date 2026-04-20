import { useEffect, useState } from "react";
import type {
  ScriptInput,
  VideoTemplate,
  ExtractedComment,
  CommentBundle,
} from "../types";
import { AUDIENCE_OPTIONS, TONE_OPTIONS } from "../lib/scriptOptions";
import { GroupedSelect } from "./GroupedSelect";
import { CommentPicker } from "./CommentPicker";
import { listTemplates } from "../lib/templateStore";
import { loadSettings, setDefaultTemplateId } from "../lib/storage";

export type GenerationMode = "auto" | "manual-select";

export interface ScriptFormSubmit {
  input: ScriptInput;
  mode: GenerationMode;
}

interface Props {
  onSubmit: (submission: ScriptFormSubmit) => void;
  loading: boolean;
}

export function ScriptForm({ onSubmit, loading }: Props) {
  const [topic, setTopic] = useState("");
  const [showOptional, setShowOptional] = useState(false);
  const [audience, setAudience] = useState("");
  const [tone, setTone] = useState("");
  const [templates, setTemplates] = useState<VideoTemplate[]>([]);
  const [templateId, setTemplateId] = useState<string>("");
  const [mode, setMode] = useState<GenerationMode>("auto");
  const [selectedComments, setSelectedComments] = useState<ExtractedComment[]>(
    [],
  );
  const [commentBundle, setCommentBundle] = useState<CommentBundle | null>(null);

  useEffect(() => {
    (async () => {
      const [list, settings] = await Promise.all([
        listTemplates(),
        loadSettings(),
      ]);
      setTemplates(list);
      const preferred = list.find((t) => t.id === settings.defaultTemplateId);
      if (preferred) {
        setTemplateId(preferred.id);
      } else if (list.length > 0) {
        setTemplateId(list[0].id);
      }
    })();
  }, []);

  const selectedTemplate = templates.find((t) => t.id === templateId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTemplate) return;
    if (mode === "auto" && !topic.trim()) return;
    await setDefaultTemplateId(templateId);
    const derivedTopic =
      mode === "auto"
        ? topic.trim()
        : commentBundle?.videoTitle?.trim() || topic.trim() || "動画反応集";
    const input: ScriptInput = {
      topic: derivedTopic,
      platform: "shorts",
      duration: Math.round(selectedTemplate.totalDuration) as ScriptInput["duration"],
      audience: audience || undefined,
      tone: tone || undefined,
      template: selectedTemplate,
      selectedComments:
        mode === "manual-select" && selectedComments.length > 0
          ? selectedComments
          : undefined,
    };
    onSubmit({ input, mode });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">生成モード</label>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setMode("auto")}
            className={`px-3 py-2 rounded-lg border text-xs transition text-left ${
              mode === "auto"
                ? "bg-blue-50 dark:bg-blue-900/30 border-blue-500 ring-2 ring-blue-500/30"
                : "bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 hover:border-blue-400"
            }`}
          >
            <div className="font-semibold">⚡ 自動</div>
            <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
              AI 全自動
            </div>
          </button>
          <button
            type="button"
            onClick={() => setMode("manual-select")}
            className={`px-3 py-2 rounded-lg border text-xs transition text-left ${
              mode === "manual-select"
                ? "bg-blue-50 dark:bg-blue-900/30 border-blue-500 ring-2 ring-blue-500/30"
                : "bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 hover:border-blue-400"
            }`}
          >
            <div className="font-semibold">🎯 コメント選択</div>
            <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
              選んだコメントで AI 生成
            </div>
          </button>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">
          使用テンプレート <span className="text-red-500">*</span>
        </label>
        {templates.length === 0 ? (
          <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-300">
            テンプレートが1つもありません。上の「テンプレート管理」タブから作成してください。
          </div>
        ) : (
          <>
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm"
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.totalDuration}秒・{t.layers.length}レイヤー)
                </option>
              ))}
            </select>
            {selectedTemplate && (
              <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">
                {selectedTemplate.themeVibe && `${selectedTemplate.themeVibe} / `}
                {selectedTemplate.narrationStyle}
              </p>
            )}
          </>
        )}
      </div>

      {mode === "auto" && (
        <div>
          <label className="block text-sm font-medium mb-1">
            トピック <span className="text-red-500">*</span>
          </label>
          <textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="例: ルフィとサボの12年ぶりの再会シーン（ドレスローザ編・原作794話）"
            rows={2}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            required
          />
        </div>
      )}

      {mode !== "auto" && commentBundle?.videoTitle && (
        <div className="p-2 rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700">
          <div className="text-[11px] text-gray-500 dark:text-gray-400">
            📹 題材（URL の動画から自動取得）
          </div>
          <div className="text-sm truncate">{commentBundle.videoTitle}</div>
          {commentBundle.channelTitle && (
            <div className="text-[11px] text-gray-400 truncate">
              {commentBundle.channelTitle}
            </div>
          )}
        </div>
      )}

      {mode === "manual-select" && (
        <div className="p-3 rounded-lg border border-purple-200 dark:border-purple-900/50 bg-purple-50/30 dark:bg-purple-900/10">
          <div className="text-xs font-semibold text-purple-800 dark:text-purple-300 mb-2">
            🎯 コメント選択 — この動画のコメントから本編素材を選ぶ
          </div>
          <CommentPicker
            selected={selectedComments}
            onSelectedChange={setSelectedComments}
            onBundleChange={setCommentBundle}
          />
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowOptional(!showOptional)}
        className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
      >
        {showOptional ? "▼" : "▶"} 詳細オプション（任意）
      </button>

      {showOptional && (
        <div className="space-y-3 p-4 rounded-lg bg-gray-50 dark:bg-gray-800/50">
          <GroupedSelect
            label="ターゲット層"
            value={audience}
            onChange={setAudience}
            groups={AUDIENCE_OPTIONS}
          />
          <GroupedSelect
            label="トーン"
            value={tone}
            onChange={setTone}
            groups={TONE_OPTIONS}
          />
        </div>
      )}

      <button
        type="submit"
        disabled={
          loading ||
          !selectedTemplate ||
          (mode === "auto" && !topic.trim()) ||
          (mode === "manual-select" && selectedComments.length === 0)
        }
        className="w-full py-3 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-medium transition"
      >
        {loading
          ? "生成中..."
          : mode === "manual-select" && selectedComments.length === 0
            ? "コメントを選択してください"
            : mode !== "auto" && !commentBundle
              ? "動画 URL を取得してください"
              : "台本を生成"}
      </button>
    </form>
  );
}
