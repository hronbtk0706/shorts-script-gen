import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Layer, TemplateSegment, VideoTemplate } from "../types";
import { TemplateCanvas } from "./TemplateCanvas";
import { LayerPanel } from "./LayerPanel";
import { LayerPropertyPanel } from "./LayerPropertyPanel";
import { TemplatePreviewModal } from "./TemplatePreviewModal";
import {
  genLayerId,
  newBlankTemplateData,
  visibleLayersAt,
  makeSegment,
} from "../lib/layerUtils";
import { saveTemplate, makeTemplateId } from "../lib/templateStore";

interface Props {
  editing?: VideoTemplate | null;
  onSaved: () => void;
  onCancel?: () => void;
}

export function TemplateBuilder({ editing, onSaved, onCancel }: Props) {
  const initial = useMemo(
    () =>
      editing ??
      newBlankTemplateData("新規テンプレート", makeTemplateId("new-template")),
    [editing],
  );

  const [template, setTemplateState] = useState<VideoTemplate>(initial);
  const [history, setHistory] = useState<VideoTemplate[]>([initial]);
  const [historyIdx, setHistoryIdx] = useState(0);
  const skipHistoryRef = useRef(false);

  const [playheadSec, setPlayheadSec] = useState(0);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [showGrid, setShowGrid] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    if (skipHistoryRef.current) {
      skipHistoryRef.current = false;
      return;
    }
    setHistory((h) => [...h.slice(0, historyIdx + 1), template]);
    setHistoryIdx((i) => i + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template]);

  useEffect(() => {
    skipHistoryRef.current = true;
    setTemplateState(initial);
    setHistory([initial]);
    setHistoryIdx(0);
  }, [initial]);

  const setTemplate: React.Dispatch<
    React.SetStateAction<VideoTemplate>
  > = useCallback((updater) => {
    setTemplateState(updater);
  }, []);

  const undo = useCallback(() => {
    if (historyIdx <= 0) return;
    skipHistoryRef.current = true;
    setHistoryIdx((i) => i - 1);
    setTemplateState(history[historyIdx - 1]);
  }, [historyIdx, history]);

  const redo = useCallback(() => {
    if (historyIdx >= history.length - 1) return;
    skipHistoryRef.current = true;
    setHistoryIdx((i) => i + 1);
    setTemplateState(history[historyIdx + 1]);
  }, [historyIdx, history]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isUndo =
        (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z";
      const isRedo =
        (e.ctrlKey || e.metaKey) &&
        ((e.shiftKey && e.key.toLowerCase() === "z") ||
          e.key.toLowerCase() === "y");
      if (isUndo) {
        e.preventDefault();
        undo();
      } else if (isRedo) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo]);

  const canUndo = historyIdx > 0;
  const canRedo = historyIdx < history.length - 1;

  const visibleLayers = useMemo(
    () => visibleLayersAt(template.layers, playheadSec),
    [template.layers, playheadSec],
  );
  const selectedLayer =
    visibleLayers.find((l) => l.id === selectedLayerId) ?? null;

  const updateLayer = (layerId: string, patch: Partial<Layer>) => {
    setTemplate((t) => ({
      ...t,
      layers: t.layers.map((l) => (l.id === layerId ? { ...l, ...patch } : l)),
    }));
  };

  const setLayers = (layers: Layer[]) => {
    setTemplate((t) => ({ ...t, layers }));
  };

  const addSegment = (type: "hook" | "body" | "cta") => {
    setTemplate((t) => {
      const last = t.segments[t.segments.length - 1];
      const start = last ? last.endSec : 0;
      const dur = type === "hook" ? 3 : type === "cta" ? 3 : 5;
      const end = Math.min(start + dur, t.totalDuration);
      const bodyIndex =
        type === "body"
          ? t.segments.filter((s) => s.type === "body").length
          : undefined;
      return {
        ...t,
        segments: [...t.segments, makeSegment(type, start, end, bodyIndex)],
      };
    });
  };

  const updateSegment = (id: string, patch: Partial<TemplateSegment>) => {
    setTemplate((t) => ({
      ...t,
      segments: t.segments.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));
  };

  const removeSegment = (id: string) => {
    if (!confirm("セグメントを削除しますか?")) return;
    setTemplate((t) => {
      const next = t.segments.filter((s) => s.id !== id);
      // body index を連番化
      let bi = 0;
      return {
        ...t,
        segments: next.map((s) =>
          s.type === "body" ? { ...s, bodyIndex: bi++ } : s,
        ),
      };
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const toSave: VideoTemplate = editing
        ? template
        : { ...template, id: makeTemplateId(template.name) };
      toSave.layers = toSave.layers.map((l) => ({
        ...l,
        id: l.id || genLayerId(),
      }));
      await saveTemplate(toSave);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const segmentTypeColor = (type: TemplateSegment["type"]) =>
    type === "hook"
      ? "bg-purple-400"
      : type === "cta"
        ? "bg-pink-400"
        : "bg-blue-400";

  return (
    <div className="space-y-3">
      {/* ヘッダ */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3 space-y-2">
        <div className="grid grid-cols-[1fr_100px] gap-2">
          <div>
            <label className="block text-[11px] text-gray-600 dark:text-gray-400 mb-0.5">
              テンプレ名 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={template.name}
              onChange={(e) =>
                setTemplate((t) => ({ ...t, name: e.target.value }))
              }
              className="w-full px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
            />
          </div>
          <div>
            <label className="block text-[11px] text-gray-600 dark:text-gray-400 mb-0.5">
              尺 (秒)
            </label>
            <input
              type="number"
              min={5}
              max={300}
              value={template.totalDuration}
              onChange={(e) =>
                setTemplate((t) => ({
                  ...t,
                  totalDuration: Number(e.target.value) || 30,
                }))
              }
              className="w-full px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
            />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <input
            type="text"
            placeholder="雰囲気"
            value={template.themeVibe ?? ""}
            onChange={(e) =>
              setTemplate((t) => ({ ...t, themeVibe: e.target.value }))
            }
            className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
          />
          <input
            type="text"
            placeholder="ペース"
            value={template.overallPacing ?? ""}
            onChange={(e) =>
              setTemplate((t) => ({ ...t, overallPacing: e.target.value }))
            }
            className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
          />
          <input
            type="text"
            placeholder="ナレーション口調"
            value={template.narrationStyle ?? ""}
            onChange={(e) =>
              setTemplate((t) => ({ ...t, narrationStyle: e.target.value }))
            }
            className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
          />
        </div>

        {/* セグメントバー（background: 時間帯を色分け） */}
        <div className="flex w-full h-4 bg-gray-200 dark:bg-gray-800 rounded overflow-hidden text-[9px]">
          {template.segments.map((s) => {
            const width =
              ((s.endSec - s.startSec) / template.totalDuration) * 100;
            return (
              <div
                key={s.id}
                className={`${segmentTypeColor(s.type)} text-white text-center overflow-hidden whitespace-nowrap`}
                style={{ width: `${width}%` }}
                title={`${s.type}${s.bodyIndex !== undefined ? `[${s.bodyIndex}]` : ""} ${s.startSec}-${s.endSec}s`}
              >
                {s.type}
                {s.bodyIndex !== undefined ? `#${s.bodyIndex}` : ""}
              </div>
            );
          })}
        </div>

        {/* プレイヘッド（現在時刻スクラブ） */}
        <div className="flex items-center gap-2 text-xs">
          <span>現在:</span>
          <input
            type="range"
            min={0}
            max={template.totalDuration}
            step={0.1}
            value={playheadSec}
            onChange={(e) => setPlayheadSec(Number(e.target.value))}
            className="flex-1"
          />
          <span className="w-12 text-right">{playheadSec.toFixed(1)}s</span>
        </div>
      </div>

      {/* 3 カラム */}
      <div className="grid grid-cols-[200px_1fr_260px] gap-3">
        {/* 左: セグメント一覧 */}
        <div className="space-y-1">
          <div className="text-[11px] font-semibold text-gray-700 dark:text-gray-300">
            セグメント ({template.segments.length})
          </div>
          <div className="grid grid-cols-3 gap-1">
            <button
              type="button"
              onClick={() => addSegment("hook")}
              className="text-[10px] py-1 rounded bg-purple-100 dark:bg-purple-900/30 hover:bg-purple-200"
            >
              +hook
            </button>
            <button
              type="button"
              onClick={() => addSegment("body")}
              className="text-[10px] py-1 rounded bg-blue-100 dark:bg-blue-900/30 hover:bg-blue-200"
            >
              +body
            </button>
            <button
              type="button"
              onClick={() => addSegment("cta")}
              className="text-[10px] py-1 rounded bg-pink-100 dark:bg-pink-900/30 hover:bg-pink-200"
            >
              +cta
            </button>
          </div>
          <div className="max-h-[550px] overflow-y-auto space-y-1">
            {template.segments.map((s) => (
              <div
                key={s.id}
                className="p-1.5 rounded bg-gray-50 dark:bg-gray-800 text-[11px] space-y-1"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    {s.type}
                    {s.bodyIndex !== undefined ? `[${s.bodyIndex}]` : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeSegment(s.id)}
                    className="p-0.5 hover:bg-red-100 rounded text-red-600"
                  >
                    🗑
                  </button>
                </div>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    step={0.1}
                    value={s.startSec}
                    onChange={(e) =>
                      updateSegment(s.id, { startSec: Number(e.target.value) })
                    }
                    className="w-14 px-1 py-0.5 text-[10px] rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
                  />
                  <span className="text-gray-400">〜</span>
                  <input
                    type="number"
                    step={0.1}
                    value={s.endSec}
                    onChange={(e) =>
                      updateSegment(s.id, { endSec: Number(e.target.value) })
                    }
                    className="w-14 px-1 py-0.5 text-[10px] rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 中央: キャンバス */}
        <div className="space-y-2">
          <div className="text-[11px] text-gray-500">
            現在 {playheadSec.toFixed(1)}s で表示中のレイヤー:{" "}
            {visibleLayers.length}
          </div>
          <TemplateCanvas
            layers={template.layers}
            selectedLayerId={selectedLayerId}
            onLayerSelect={setSelectedLayerId}
            onLayerUpdate={updateLayer}
            showGrid={showGrid}
            currentTimeSec={playheadSec}
          />
        </div>

        {/* 右: レイヤー操作 */}
        <div className="space-y-3">
          <LayerPanel
            layers={template.layers}
            selectedLayerId={selectedLayerId}
            onLayersChange={setLayers}
            onLayerSelect={setSelectedLayerId}
            newLayerDefaults={{
              startSec: playheadSec,
              endSec: Math.min(playheadSec + 3, template.totalDuration),
            }}
          />
          <div className="border-t border-gray-200 dark:border-gray-700 pt-2">
            <LayerPropertyPanel
              layer={selectedLayer}
              onChange={(patch) => {
                if (selectedLayerId) updateLayer(selectedLayerId, patch);
              }}
            />
          </div>
        </div>
      </div>

      {/* フッタ */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={undo}
            disabled={!canUndo}
            className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-xs disabled:opacity-40"
          >
            ↶ 元に戻す
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={!canRedo}
            className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-xs disabled:opacity-40"
          >
            やり直す ↷
          </button>
          <label className="flex items-center gap-1 text-xs ml-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showGrid}
              onChange={(e) => setShowGrid(e.target.checked)}
              className="h-3 w-3"
            />
            グリッド
          </label>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-sm"
          >
            🎬 プレビュー
          </button>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-sm"
            >
              キャンセル
            </button>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !template.name.trim()}
            className="px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white text-sm disabled:bg-gray-400"
          >
            {saving ? "保存中..." : editing ? "上書き保存" : "テンプレ保存"}
          </button>
        </div>
      </div>

      <TemplatePreviewModal
        template={template}
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
      />
    </div>
  );
}
