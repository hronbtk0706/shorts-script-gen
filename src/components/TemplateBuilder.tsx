import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Layer, TemplateSegment, VideoTemplate } from "../types";
import { TemplateCanvas } from "./TemplateCanvas";
import { TemplateTimeline } from "./TemplateTimeline";
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
  const [saveMsg, setSaveMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setHeaderSlot(document.getElementById("app-header-slot"));
  }, []);

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
  // 時間外でも選択・編集できるよう、全レイヤーから探す
  const selectedLayer =
    template.layers.find((l) => l.id === selectedLayerId) ?? null;
  const selectedLayerInTime = selectedLayer
    ? visibleLayers.some((l) => l.id === selectedLayer.id)
    : false;

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
    const name = template.name.trim();
    if (!name) {
      setSaveMsg({ type: "err", text: "テンプレ名を入力してください" });
      return;
    }
    setSaving(true);
    setSaveMsg(null);
    try {
      const withName: VideoTemplate = { ...template, name };
      const toSave: VideoTemplate = editing
        ? withName
        : { ...withName, id: makeTemplateId(name) };
      toSave.layers = toSave.layers.map((l) => ({
        ...l,
        id: l.id || genLayerId(),
      }));
      await saveTemplate(toSave);
      setSaveMsg({ type: "ok", text: `保存しました: ${name}` });
      setTimeout(() => {
        onSaved();
      }, 400);
    } catch (e) {
      console.error("[TemplateBuilder] save failed:", e);
      setSaveMsg({
        type: "err",
        text: `保存失敗: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setSaving(false);
    }
  };

  // 画像2 = ヘッダーに portal で移動するツールバー（保存等）
  const headerToolbar = (
    <>
      <input
        type="text"
        value={template.name}
        placeholder="テンプレ名"
        onChange={(e) =>
          setTemplate((t) => ({ ...t, name: e.target.value }))
        }
        className="w-44 px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
      />
      <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
        尺
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
          className="w-14 px-1 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
        />
        <span className="text-[10px]">秒</span>
      </label>
      <button
        type="button"
        onClick={() => {
          setSelectedLayerId(null);
          setPreviewOpen(true);
        }}
        className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-xs"
      >
        🎬 プレビュー
      </button>
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1 rounded border border-gray-300 dark:border-gray-600 text-xs"
        >
          キャンセル
        </button>
      )}
      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs disabled:bg-gray-400"
      >
        {saving ? "保存中..." : editing ? "上書き保存" : "テンプレ保存"}
      </button>
    </>
  );

  return (
    <div className="space-y-1">
      {headerSlot && createPortal(headerToolbar, headerSlot)}

      {saveMsg && (
        <div
          className={`text-xs px-2 py-1 rounded ${
            saveMsg.type === "ok"
              ? "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
              : "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300"
          }`}
        >
          {saveMsg.text}
        </div>
      )}

      {/* 3 カラム (固定幅 + 中央寄せ) */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "380px 200px 240px",
          gap: "1rem",
          alignItems: "start",
          justifyContent: "center",
          margin: "0 auto",
        }}
      >
        {/* 左: キャンバス（＋画像1=undo/redo/grid/info の 2列コンパクト） */}
        <div className="min-w-0 space-y-1">
          <div
            className="grid gap-x-2 gap-y-0.5 items-center text-[11px]"
            style={{ gridTemplateColumns: "auto auto 1fr" }}
          >
            <button
              type="button"
              onClick={undo}
              disabled={!canUndo}
              className="px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 text-[11px] disabled:opacity-40"
            >
              ↶ 元に戻す
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={!canRedo}
              className="px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 text-[11px] disabled:opacity-40"
            >
              やり直す ↷
            </button>
            <span className="text-gray-500">
              {playheadSec.toFixed(1)}s / 表示中 {visibleLayers.length}/{template.layers.length}
            </span>
            <label className="flex items-center gap-1 cursor-pointer col-span-2">
              <input
                type="checkbox"
                checked={showGrid}
                onChange={(e) => setShowGrid(e.target.checked)}
                className="h-3 w-3"
              />
              グリッド
            </label>
            {selectedLayer && !selectedLayerInTime && (
              <span className="px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 text-[10px]">
                ⚠ 選択は非表示
              </span>
            )}
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

        {/* 右1: レイヤー一覧 */}
        <div className="min-w-0">
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
        </div>

        {/* 右2: プロパティパネル */}
        <div className="min-w-0">
          <LayerPropertyPanel
            layer={selectedLayer}
            onChange={(patch) => {
              if (selectedLayerId) updateLayer(selectedLayerId, patch);
            }}
          />
        </div>
      </div>

      {/* 下段: タイムライン（尺に比例。60秒=上段幅×1.2、それ以上は横スクロール） */}
      <div className="w-full overflow-x-auto">
        <div
          style={{
            // 上段幅 852px = 380+200+240 + 2*16gap、2割増を 60秒の幅とする
            width: (120 + (template.totalDuration * (852 - 120)) / 60) * 1.2,
            margin: "0 auto",
          }}
        >
          <TemplateTimeline
            layers={template.layers}
            segments={template.segments}
            totalDuration={template.totalDuration}
            playheadSec={playheadSec}
            selectedLayerId={selectedLayerId}
            onLayerUpdate={updateLayer}
            onLayerSelect={setSelectedLayerId}
            onPlayheadChange={setPlayheadSec}
          />
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
