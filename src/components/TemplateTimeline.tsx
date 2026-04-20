import { useEffect, useRef, useState } from "react";
import type { Layer, TemplateSegment } from "../types";

interface Props {
  layers: Layer[];
  segments: TemplateSegment[];
  totalDuration: number;
  playheadSec: number;
  selectedLayerId: string | null;
  onLayerUpdate: (id: string, patch: Partial<Layer>) => void;
  onLayerSelect: (id: string | null) => void;
  onPlayheadChange: (t: number) => void;
}

const ROW_HEIGHT = 28;
const RULER_HEIGHT = 24;
const LABEL_WIDTH = 120;
const MIN_LAYER_DUR = 0.1;

type DragMode = "move" | "resize-left" | "resize-right";

interface DragState {
  layerId: string;
  mode: DragMode;
  initialMouseX: number;
  initialStart: number;
  initialEnd: number;
}

const LAYER_ICON: Record<string, string> = {
  image: "🖼",
  video: "🎬",
  text: "📝",
  color: "🎨",
  shape: "⬜",
  comment: "💬",
};

const SEGMENT_BG: Record<string, string> = {
  hook: "rgba(245, 158, 11, 0.12)",
  body: "rgba(59, 130, 246, 0.08)",
  cta: "rgba(16, 185, 129, 0.12)",
};

export function TemplateTimeline({
  layers,
  segments,
  totalDuration,
  playheadSec,
  selectedLayerId,
  onLayerUpdate,
  onLayerSelect,
  onPlayheadChange,
}: Props) {
  const trackAreaRef = useRef<HTMLDivElement>(null);
  const [trackWidth, setTrackWidth] = useState(0);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [playheadDragging, setPlayheadDragging] = useState(false);

  useEffect(() => {
    const measure = () => {
      if (trackAreaRef.current) {
        setTrackWidth(trackAreaRef.current.clientWidth);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (trackAreaRef.current) ro.observe(trackAreaRef.current);
    return () => ro.disconnect();
  }, []);

  const pxPerSec =
    trackWidth > 0 && totalDuration > 0 ? trackWidth / totalDuration : 0;
  const secToPx = (s: number) => s * pxPerSec;
  const pxToSec = (p: number) => (pxPerSec > 0 ? p / pxPerSec : 0);

  // スナップ: 他レイヤーの端 + セグメント境界 + 再生ヘッド + 0/全尺。
  // 10px以内の最近接点に吸い付く。
  const snapToPoint = (
    v: number,
    opts?: { excludeLayerId?: string; excludePlayhead?: boolean },
  ): number => {
    const tolerance = 10 / Math.max(pxPerSec, 1);
    const points: number[] = [0, totalDuration];
    if (!opts?.excludePlayhead) points.push(playheadSec);
    for (const seg of segments) {
      points.push(seg.startSec, seg.endSec);
    }
    for (const layer of layers) {
      if (layer.id === opts?.excludeLayerId) continue;
      points.push(layer.startSec, layer.endSec);
    }
    let best = v;
    let bestDist = tolerance;
    for (const p of points) {
      const d = Math.abs(p - v);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return best;
  };

  // グローバル mousemove/mouseup ハンドリング
  useEffect(() => {
    if (!drag) return;
    const onMouseMove = (e: MouseEvent) => {
      const deltaPx = e.clientX - drag.initialMouseX;
      const deltaSec = pxToSec(deltaPx);
      let newStart = drag.initialStart;
      let newEnd = drag.initialEnd;
      if (drag.mode === "move") {
        const len = drag.initialEnd - drag.initialStart;
        newStart = Math.max(
          0,
          Math.min(totalDuration - len, drag.initialStart + deltaSec),
        );
        newEnd = newStart + len;
      } else if (drag.mode === "resize-left") {
        newStart = Math.max(
          0,
          Math.min(drag.initialEnd - MIN_LAYER_DUR, drag.initialStart + deltaSec),
        );
      } else if (drag.mode === "resize-right") {
        newEnd = Math.max(
          drag.initialStart + MIN_LAYER_DUR,
          Math.min(totalDuration, drag.initialEnd + deltaSec),
        );
      }
      // スナップ（他レイヤーの端 + セグメント + 再生ヘッド、10px以内）
      // 自分自身は候補から除外
      if (drag.mode === "move") {
        // 移動時は左端・右端の両方でスナップを試し、より近い方を採用
        const snappedStart = snapToPoint(newStart, { excludeLayerId: drag.layerId });
        const snappedEnd = snapToPoint(newEnd, { excludeLayerId: drag.layerId });
        const distStart = Math.abs(snappedStart - newStart);
        const distEnd = Math.abs(snappedEnd - newEnd);
        const shift = distStart <= distEnd
          ? snappedStart - newStart
          : snappedEnd - newEnd;
        newStart += shift;
        newEnd += shift;
      } else if (drag.mode === "resize-left") {
        newStart = snapToPoint(newStart, { excludeLayerId: drag.layerId });
      } else {
        newEnd = snapToPoint(newEnd, { excludeLayerId: drag.layerId });
      }
      onLayerUpdate(drag.layerId, { startSec: newStart, endSec: newEnd });
    };
    const onMouseUp = () => setDrag(null);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [drag, pxPerSec, totalDuration, segments, layers, playheadSec, onLayerUpdate]);

  const startDrag = (
    e: React.MouseEvent,
    layer: Layer,
    mode: DragMode,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    onLayerSelect(layer.id);
    setDrag({
      layerId: layer.id,
      mode,
      initialMouseX: e.clientX,
      initialStart: layer.startSec,
      initialEnd: layer.endSec,
    });
  };

  const handleTrackClick = (e: React.MouseEvent) => {
    if (drag) return;
    if (!trackAreaRef.current) return;
    const rect = trackAreaRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const raw = Math.max(0, Math.min(totalDuration, pxToSec(x)));
    onPlayheadChange(snapToPoint(raw, { excludePlayhead: true }));
  };

  // Playhead ドラッグ
  useEffect(() => {
    if (!playheadDragging) return;
    const onMouseMove = (e: MouseEvent) => {
      if (!trackAreaRef.current) return;
      const rect = trackAreaRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const raw = Math.max(0, Math.min(totalDuration, pxToSec(x)));
      onPlayheadChange(snapToPoint(raw, { excludePlayhead: true }));
    };
    const onMouseUp = () => setPlayheadDragging(false);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "ew-resize";
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
    };
  }, [playheadDragging, pxPerSec, totalDuration, segments, layers, onPlayheadChange]);

  return (
    <div className="bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-800 rounded overflow-hidden text-[11px]">
      <div className="relative">
        {/* ルーラー */}
        <div className="flex">
          <div
            style={{ width: LABEL_WIDTH, height: RULER_HEIGHT }}
            className="shrink-0 bg-gray-100 dark:bg-gray-800 border-b border-r border-gray-200 dark:border-gray-700 flex items-center px-2 text-[10px] text-gray-500 font-medium"
          >
            タイムライン
          </div>
          <div
            ref={trackAreaRef}
            className="flex-1 relative border-b border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 cursor-pointer select-none"
            style={{ height: RULER_HEIGHT }}
            onClick={handleTrackClick}
          >
            {/* セグメント背景 */}
            {segments.map((s) => (
              <div
                key={s.id}
                className="absolute top-0 bottom-0 border-l border-gray-300 dark:border-gray-600"
                style={{
                  left: secToPx(s.startSec),
                  width: Math.max(2, secToPx(s.endSec - s.startSec)),
                  background: SEGMENT_BG[s.type] ?? "transparent",
                }}
              >
                <div className="text-[9px] text-gray-500 pl-1 pt-0.5">
                  {s.type}
                  {s.type === "body" && s.bodyIndex !== undefined
                    ? `[${s.bodyIndex}]`
                    : ""}
                </div>
              </div>
            ))}
            {/* 秒目盛り */}
            {Array.from({ length: Math.floor(totalDuration) + 1 }).map((_, s) => (
              <div
                key={s}
                className="absolute top-0 bottom-0"
                style={{ left: secToPx(s) }}
              >
                <div className="absolute top-0 w-px h-full bg-gray-300 dark:bg-gray-600" />
                {s % 5 === 0 && (
                  <div className="text-[9px] text-gray-500 absolute left-0.5 top-0">
                    {s}s
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* レイヤー行 */}
        {layers.length === 0 ? (
          <div className="px-3 py-4 text-center text-[11px] text-gray-400">
            レイヤーを追加するとタイムラインに表示されます
          </div>
        ) : (
          layers.map((layer) => {
            const isSelected = layer.id === selectedLayerId;
            const barLeft = secToPx(layer.startSec);
            const barWidth = Math.max(
              4,
              secToPx(layer.endSec - layer.startSec),
            );
            return (
              <div key={layer.id} className="flex">
                <div
                  style={{ width: LABEL_WIDTH, height: ROW_HEIGHT }}
                  className={`shrink-0 border-b border-r border-gray-200 dark:border-gray-700 flex items-center px-2 overflow-hidden truncate cursor-pointer ${
                    isSelected
                      ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-semibold"
                      : "bg-gray-100/60 dark:bg-gray-800/60 hover:bg-gray-200 dark:hover:bg-gray-700"
                  }`}
                  onClick={() => onLayerSelect(layer.id)}
                  title={layer.text || layer.type}
                >
                  <span className="mr-1 text-[10px]">
                    {LAYER_ICON[layer.type] ?? "◼"}
                  </span>
                  <span className="truncate">
                    {layer.text?.slice(0, 12) || layer.type}
                  </span>
                </div>
                <div
                  className="flex-1 relative border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 cursor-pointer"
                  style={{ height: ROW_HEIGHT }}
                  onClick={handleTrackClick}
                >
                  <div
                    onMouseDown={(e) => startDrag(e, layer, "move")}
                    className={`absolute top-1 bottom-1 rounded transition-shadow ${
                      isSelected
                        ? "bg-blue-500 hover:bg-blue-600 ring-2 ring-blue-300 dark:ring-blue-700"
                        : "bg-gray-400 hover:bg-gray-500 dark:bg-gray-600 dark:hover:bg-gray-500"
                    }`}
                    style={{
                      left: barLeft,
                      width: barWidth,
                      cursor: "grab",
                    }}
                    title={`${layer.startSec.toFixed(2)}s → ${layer.endSec.toFixed(2)}s`}
                  >
                    <div
                      onMouseDown={(e) => startDrag(e, layer, "resize-left")}
                      className="absolute left-0 top-0 bottom-0 w-2 bg-white/0 hover:bg-white/30"
                      style={{ cursor: "ew-resize" }}
                    />
                    <div
                      onMouseDown={(e) => startDrag(e, layer, "resize-right")}
                      className="absolute right-0 top-0 bottom-0 w-2 bg-white/0 hover:bg-white/30"
                      style={{ cursor: "ew-resize" }}
                    />
                    {barWidth >= 60 && (
                      <div className="absolute inset-0 flex items-center justify-center text-[9px] text-white/90 px-1 pointer-events-none">
                        {layer.startSec.toFixed(1)}–{layer.endSec.toFixed(1)}s
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}

        {/* Playhead（全行にわたる赤い縦線 + ドラッグ可能なハンドル） */}
        {trackWidth > 0 && (
          <div
            className="absolute top-0 z-20"
            style={{
              left: LABEL_WIDTH + secToPx(playheadSec),
              height: RULER_HEIGHT + layers.length * ROW_HEIGHT,
              pointerEvents: "none",
            }}
          >
            <div className="w-px h-full bg-red-500" />
            {/* ドラッグハンドル: ルーラー上にのみヒット領域を置き、下のレイヤー行のクリックは妨げない */}
            <div
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setPlayheadDragging(true);
              }}
              className="absolute top-0 -ml-2 w-4"
              style={{
                height: RULER_HEIGHT,
                cursor: "ew-resize",
                pointerEvents: "auto",
              }}
              title="ドラッグでシーク"
            >
              <div
                className={`w-3 h-3 rounded-full mx-auto -mt-1 shadow ${
                  playheadDragging
                    ? "bg-red-600 ring-2 ring-red-300"
                    : "bg-red-500 hover:bg-red-600"
                }`}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
