import { useEffect, useState } from "react";
import type {
  ScriptInput,
  VideoTemplate,
  ExtractedComment,
  CommentBundle,
  Script,
} from "../types";
import { AUDIENCE_OPTIONS, TONE_OPTIONS } from "../lib/scriptOptions";
import { GroupedSelect } from "./GroupedSelect";
import { CommentPicker } from "./CommentPicker";
import { ManualLayerAssigner } from "./ManualLayerAssigner";
import { listTemplates } from "../lib/templateStore";
import { loadSettings, setDefaultTemplateId } from "../lib/storage";
import {
  applyManualAssignments,
  buildManualScript,
} from "../lib/manualScript";

export type GenerationMode = "auto" | "manual";

export interface ScriptFormSubmit {
  input: ScriptInput;
  mode: GenerationMode;
  prebuiltScript?: Script;
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

  // manual モード用の割り当て状態
  const [manualCommentAssign, setManualCommentAssign] = useState<
    Record<string, ExtractedComment | null>
  >({});
  const [manualSourceAssign, setManualSourceAssign] = useState<
    Record<string, string>
  >({});
  const [manualTextAssign, setManualTextAssign] = useState<
    Record<string, string>
  >({});
  const [manualGeometryAssign, setManualGeometryAssign] = useState<
    Record<string, { x: number; y: number; width: number; height: number }>
  >({});

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

    if (mode === "manual") {
      // テンプレをクローンして手動割り当てを適用、AIをスキップして Script を直接組み立てる
      const patchedTemplate = applyManualAssignments(
        selectedTemplate,
        manualCommentAssign,
        manualSourceAssign,
        manualTextAssign,
        manualGeometryAssign,
      );
      const prebuilt = buildManualScript(patchedTemplate, commentBundle);
      const input: ScriptInput = {
        topic:
          commentBundle?.videoTitle?.trim() ||
          topic.trim() ||
          "手動テンプレ動画",
        platform: "shorts",
        duration: Math.round(
          patchedTemplate.totalDuration,
        ) as ScriptInput["duration"],
        audience: audience || undefined,
        tone: tone || undefined,
        template: patchedTemplate,
        manualMode: true,
      };
      onSubmit({ input, mode, prebuiltScript: prebuilt });
      return;
    }

    const input: ScriptInput = {
      topic: topic.trim(),
      platform: "shorts",
      duration: Math.round(selectedTemplate.totalDuration) as ScriptInput["duration"],
      audience: audience || undefined,
      tone: tone || undefined,
      template: selectedTemplate,
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
            onClick={() => setMode("manual")}
            className={`px-3 py-2 rounded-lg border text-xs transition text-left ${
              mode === "manual"
                ? "bg-blue-50 dark:bg-blue-900/30 border-blue-500 ring-2 ring-blue-500/30"
                : "bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 hover:border-blue-400"
            }`}
          >
            <div className="font-semibold">✏️ 手動</div>
            <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
              AIなし・全手動割当
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

      {mode === "manual" && commentBundle?.videoTitle && (
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

      {mode === "manual" && (
        <div className="p-3 rounded-lg border border-purple-200 dark:border-purple-900/50 bg-purple-50/30 dark:bg-purple-900/10">
          <div className="text-xs font-semibold text-purple-800 dark:text-purple-300 mb-2">
            ✏️ 手動 — 取得したコメントから候補を選び、各レイヤーに割り当てる
          </div>
          <CommentPicker
            selected={selectedComments}
            onSelectedChange={setSelectedComments}
            onBundleChange={setCommentBundle}
          />
        </div>
      )}

      {mode === "manual" && selectedTemplate && (
        <div className="p-3 rounded-lg border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/30 dark:bg-emerald-900/10 space-y-3">
          <ManualLayerAssigner
            template={selectedTemplate}
            availableComments={selectedComments}
            commentAssignments={manualCommentAssign}
            sourceAssignments={manualSourceAssign}
            textAssignments={manualTextAssign}
            geometryAssignments={manualGeometryAssign}
            onCommentAssign={(id, c) =>
              setManualCommentAssign((prev) => ({ ...prev, [id]: c }))
            }
            onSourceAssign={(id, src) =>
              setManualSourceAssign((prev) => ({ ...prev, [id]: src }))
            }
            onTextAssign={(id, txt) =>
              setManualTextAssign((prev) => ({ ...prev, [id]: txt }))
            }
            onGeometryAssign={(id, g) =>
              setManualGeometryAssign((prev) => {
                if (g === null) {
                  const { [id]: _, ...rest } = prev;
                  return rest;
                }
                return { ...prev, [id]: g };
              })
            }
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
          (mode === "auto" && !topic.trim())
        }
        className="w-full py-3 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-medium transition"
      >
        {loading
          ? "生成中..."
          : mode === "manual"
            ? "動画を組み立てる"
            : "台本を生成"}
      </button>
    </form>
  );
}
