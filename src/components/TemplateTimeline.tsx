import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Layer, TemplateSegment } from "../types";
import { applyTrackAction, hasTimeConflictOnTrack } from "../lib/layerUtils";

/** レイヤーソース → Webview で表示可能な URL に変換（ローカルパスは convertFileSrc） */
function resolveLayerSrcForBar(src: string | undefined): string | null {
  if (!src) return null;
  if (src === "auto" || src === "user") return null;
  if (
    src.startsWith("http://") ||
    src.startsWith("https://") ||
    src.startsWith("data:") ||
    src.startsWith("blob:")
  ) {
    return src;
  }
  try {
    return convertFileSrc(src);
  } catch {
    return null;
  }
}

/** タイムラインバーのサムネ（画像はプレビュー、動画等はアイコン） */
function BarThumbnail({ layer }: { layer: Layer }) {
  if (layer.type === "image") {
    const resolved = resolveLayerSrcForBar(layer.source);
    if (resolved) {
      return (
        <div
          className="shrink-0 rounded-sm overflow-hidden border border-white/30"
          style={{
            width: 18,
            height: 18,
            backgroundImage: `url("${resolved}")`,
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
        />
      );
    }
  }
  if (layer.type === "color" || layer.type === "shape") {
    return (
      <div
        className="shrink-0 rounded-sm border border-white/30"
        style={{
          width: 14,
          height: 14,
          background: layer.fillColor ?? "#666",
        }}
      />
    );
  }
  // フォールバック: 絵文字アイコン
  const icon: Record<string, string> = {
    image: "🖼",
    video: "🎬",
    comment: "📝",
    color: "🎨",
    shape: "⬜",
    audio: "🎵",
  };
  return (
    <span className="shrink-0 text-[11px]">{icon[layer.type] ?? "◼"}</span>
  );
}

interface Props {
  layers: Layer[];
  segments: TemplateSegment[];
  totalDuration: number;
  playheadSec: number;
  selectedLayerId: string | null;
  /** 複数選択中の全 id（プライマリ含む）。未指定なら [selectedLayerId] 相当 */
  selectedLayerIds?: string[];
  onLayerUpdate: (id: string, patch: Partial<Layer>) => void;
  onLayerSelect: (
    id: string | null,
    modifier?: "shift" | "ctrl" | null,
  ) => void;
  onPlayheadChange: (t: number) => void;
  onLayersReorder?: (layers: Layer[]) => void;
}

const ROW_HEIGHT = 28;
const RULER_HEIGHT = 24;
const LABEL_WIDTH = 110;
const MIN_LAYER_DUR = 0.1;
const INSERT_THRESHOLD_PX = 7;
/** デフォルト横密度（px/s）。Ctrl+ホイール / Ctrl+=-0 でズーム可能 */
const DEFAULT_PX_PER_SEC = 20;
const MIN_PX_PER_SEC = 4;
const MAX_PX_PER_SEC = 200;
const ZOOM_FACTOR = 1.2;

type DragMode = "move" | "resize-left" | "resize-right";

type DragTarget =
  | { type: "row"; rowIdx: number }
  | { type: "insert"; beforeIdx: number };

interface DragState {
  layerId: string;
  mode: DragMode;
  initialMouseX: number;
  initialMouseY: number;
  initialStart: number;
  initialEnd: number;
  initialZIndex: number;
  initialRowIdx: number;
  previewTarget: DragTarget;
  /** 一括ドラッグ対象（modeがmoveかつマルチ選択時、このリストも同時に時間移動） */
  multi?: {
    id: string;
    initialStart: number;
    initialEnd: number;
    zIndex: number;
  }[];
}

const LAYER_ICON: Record<string, string> = {
  image: "🖼",
  video: "🎬",
  color: "🎨",
  shape: "⬜",
  comment: "📝",
  audio: "🎵",
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
  onLayersReorder,
  selectedLayerIds,
}: Props) {
  const selectedSet = new Set<string>(
    selectedLayerIds ?? (selectedLayerId ? [selectedLayerId] : []),
  );
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const trackAreaRef = useRef<HTMLDivElement>(null);
  const tracksContainerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [playheadDragging, setPlayheadDragging] = useState(false);
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);
  const pxPerSecRef = useRef(pxPerSec);
  useEffect(() => {
    pxPerSecRef.current = pxPerSec;
  }, [pxPerSec]);

  const trackContentWidth = Math.max(0, totalDuration * pxPerSec);
  const innerWidth = LABEL_WIDTH + trackContentWidth;

  // Ctrl+ホイールでズーム（カーソル位置の時刻を保ったままスケール）
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mouseXInContainer = e.clientX - rect.left;
      const mouseXInContent =
        el.scrollLeft + mouseXInContainer - LABEL_WIDTH;
      const timeUnderMouse =
        pxPerSecRef.current > 0 ? mouseXInContent / pxPerSecRef.current : 0;
      const factor = e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
      const newPx = Math.max(
        MIN_PX_PER_SEC,
        Math.min(MAX_PX_PER_SEC, pxPerSecRef.current * factor),
      );
      if (Math.abs(newPx - pxPerSecRef.current) < 0.01) return;
      setPxPerSec(newPx);
      requestAnimationFrame(() => {
        if (!scrollContainerRef.current) return;
        const newScrollLeft =
          timeUnderMouse * newPx + LABEL_WIDTH - mouseXInContainer;
        scrollContainerRef.current.scrollLeft = Math.max(0, newScrollLeft);
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Ctrl+= / Ctrl+- / Ctrl+0 でズーム
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      const zoomAtCenter = (newPx: number) => {
        const el = scrollContainerRef.current;
        if (!el) {
          setPxPerSec(newPx);
          return;
        }
        const centerXInContainer = el.clientWidth / 2;
        const centerXInContent =
          el.scrollLeft + centerXInContainer - LABEL_WIDTH;
        const timeCenter =
          pxPerSecRef.current > 0
            ? centerXInContent / pxPerSecRef.current
            : 0;
        setPxPerSec(newPx);
        requestAnimationFrame(() => {
          if (!scrollContainerRef.current) return;
          scrollContainerRef.current.scrollLeft = Math.max(
            0,
            timeCenter * newPx + LABEL_WIDTH - centerXInContainer,
          );
        });
      };
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomAtCenter(
          Math.min(MAX_PX_PER_SEC, pxPerSecRef.current * ZOOM_FACTOR),
        );
      } else if (e.key === "-") {
        e.preventDefault();
        zoomAtCenter(
          Math.max(MIN_PX_PER_SEC, pxPerSecRef.current / ZOOM_FACTOR),
        );
      } else if (e.key === "0") {
        e.preventDefault();
        zoomAtCenter(DEFAULT_PX_PER_SEC);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const secToPx = (s: number) => s * pxPerSec;
  const pxToSec = (p: number) => (pxPerSec > 0 ? p / pxPerSec : 0);

  const tracks = useMemo(() => {
    const byZ = new Map<number, Layer[]>();
    for (const l of layers) {
      if (!byZ.has(l.zIndex)) byZ.set(l.zIndex, []);
      byZ.get(l.zIndex)!.push(l);
    }
    return Array.from(byZ.entries())
      .map(([z, ls]) => ({
        zIndex: z,
        layers: [...ls].sort((a, b) => a.startSec - b.startSec),
        isAudio: z < 0,
      }))
      .sort((a, b) => b.zIndex - a.zIndex); // video(z>=0)が上、audio(z<0)が下
  }, [layers]);

  // video / audio の境界位置（映像トラック数 = 音声セクション開始 index）
  const videoTrackCount = tracks.filter((t) => !t.isAudio).length;

  const getTrackTimeBounds = (
    excludeId: string,
    zIndex: number,
    refStart: number,
    refEnd: number,
  ) => {
    const EPS = 0.001;
    let leftBound = 0;
    let rightBound = totalDuration;
    for (const l of layers) {
      if (l.id === excludeId || l.zIndex !== zIndex) continue;
      if (l.endSec <= refStart + EPS) {
        leftBound = Math.max(leftBound, l.endSec);
      }
      if (l.startSec >= refEnd - EPS) {
        rightBound = Math.min(rightBound, l.startSec);
      }
    }
    return { leftBound, rightBound };
  };

  const snapToPoint = (
    v: number,
    opts?: {
      excludeLayerId?: string;
      excludePlayhead?: boolean;
      /** スナップ許容 px。未指定なら 10px（レイヤー用）。プレイヘッドは小さめ */
      tolerancePx?: number;
    },
  ): number => {
    const tolerancePx = opts?.tolerancePx ?? 10;
    const tolerance = tolerancePx / Math.max(pxPerSec, 1);
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
  /** プレイヘッド専用のスナップ（より小さい許容 = 粘りにくい） */
  const snapPlayhead = (v: number) =>
    snapToPoint(v, { excludePlayhead: true, tolerancePx: 3 });

  const computeDragTarget = (mouseYInContainer: number): DragTarget => {
    const totalH = tracks.length * ROW_HEIGHT;
    if (mouseYInContainer <= INSERT_THRESHOLD_PX) {
      return { type: "insert", beforeIdx: 0 };
    }
    if (mouseYInContainer >= totalH - INSERT_THRESHOLD_PX) {
      return { type: "insert", beforeIdx: tracks.length };
    }
    for (let i = 1; i < tracks.length; i++) {
      const gapY = i * ROW_HEIGHT;
      if (Math.abs(mouseYInContainer - gapY) < INSERT_THRESHOLD_PX) {
        return { type: "insert", beforeIdx: i };
      }
    }
    const rowIdx = Math.max(
      0,
      Math.min(tracks.length - 1, Math.floor(mouseYInContainer / ROW_HEIGHT)),
    );
    return { type: "row", rowIdx };
  };

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

      const { leftBound, rightBound } = getTrackTimeBounds(
        drag.layerId,
        drag.initialZIndex,
        drag.initialStart,
        drag.initialEnd,
      );
      if (drag.mode === "move") {
        const len = drag.initialEnd - drag.initialStart;
        newStart = Math.max(leftBound, newStart);
        newEnd = Math.min(rightBound, newStart + len);
        newStart = newEnd - len;
      } else if (drag.mode === "resize-left") {
        newStart = Math.max(leftBound, newStart);
      } else if (drag.mode === "resize-right") {
        newEnd = Math.min(rightBound, newEnd);
      }

      // 動画レイヤー + videoLoop=false の場合は素材尺を超えないようクランプ
      const dragLayer = layers.find((l) => l.id === drag.layerId);
      if (
        dragLayer &&
        dragLayer.type === "video" &&
        dragLayer.videoLoop === false &&
        dragLayer.sourceDurationSec &&
        dragLayer.sourceDurationSec > 0
      ) {
        const maxDur = dragLayer.sourceDurationSec;
        if (drag.mode === "resize-right") {
          newEnd = Math.min(newEnd, newStart + maxDur);
        } else if (drag.mode === "resize-left") {
          // 左端を左に引っ張る = 長くする方向 → 制限
          if (newEnd - newStart > maxDur) {
            newStart = newEnd - maxDur;
          }
        }
      }

      if (drag.mode === "move") {
        const snappedStart = snapToPoint(newStart, {
          excludeLayerId: drag.layerId,
        });
        const snappedEnd = snapToPoint(newEnd, {
          excludeLayerId: drag.layerId,
        });
        const distStart = Math.abs(snappedStart - newStart);
        const distEnd = Math.abs(snappedEnd - newEnd);
        const shift =
          distStart <= distEnd
            ? snappedStart - newStart
            : snappedEnd - newEnd;
        newStart += shift;
        newEnd += shift;
        if (newStart < leftBound) {
          const d = leftBound - newStart;
          newStart += d;
          newEnd += d;
        }
        if (newEnd > rightBound) {
          const d = newEnd - rightBound;
          newStart -= d;
          newEnd -= d;
        }
      } else if (drag.mode === "resize-left") {
        newStart = snapToPoint(newStart, { excludeLayerId: drag.layerId });
        if (newStart < leftBound) newStart = leftBound;
      } else {
        newEnd = snapToPoint(newEnd, { excludeLayerId: drag.layerId });
        if (newEnd > rightBound) newEnd = rightBound;
      }
      onLayerUpdate(drag.layerId, { startSec: newStart, endSec: newEnd });

      // マルチドラッグ時は同じ time-delta を他の選択対象にも適用
      if (drag.mode === "move" && drag.multi && drag.multi.length > 0) {
        const delta = newStart - drag.initialStart;
        for (const m of drag.multi) {
          const len = m.initialEnd - m.initialStart;
          const ns = Math.max(
            0,
            Math.min(totalDuration - len, m.initialStart + delta),
          );
          onLayerUpdate(m.id, { startSec: ns, endSec: ns + len });
        }
      }

      // マルチドラッグ中はトラック変更（previewTarget）を計算しない（単独のみ許容）
      if (
        drag.mode === "move" &&
        (!drag.multi || drag.multi.length === 0) &&
        tracksContainerRef.current
      ) {
        const rect = tracksContainerRef.current.getBoundingClientRect();
        const yInContainer = e.clientY - rect.top;
        const target = computeDragTarget(yInContainer);
        const prev = drag.previewTarget;
        const same =
          prev.type === target.type &&
          ((prev.type === "row" &&
            target.type === "row" &&
            prev.rowIdx === target.rowIdx) ||
            (prev.type === "insert" &&
              target.type === "insert" &&
              prev.beforeIdx === target.beforeIdx));
        if (!same) {
          setDrag({ ...drag, previewTarget: target });
        }
      }
    };
    const onMouseUp = () => {
      if (drag.mode === "move") {
        const t = drag.previewTarget;
        const movingLayer = layers.find((l) => l.id === drag.layerId);
        if (movingLayer && onLayersReorder) {
          const isAudioMoving = movingLayer.type === "audio";
          if (t.type === "row" && t.rowIdx !== drag.initialRowIdx) {
            const targetTrack = tracks[t.rowIdx];
            const targetIsAudio = targetTrack?.isAudio ?? false;
            // セクション違いは拒否
            if (targetTrack && targetIsAudio === isAudioMoving) {
              const targetZ = targetTrack.zIndex;
              if (
                !hasTimeConflictOnTrack(
                  layers,
                  drag.layerId,
                  targetZ,
                  movingLayer.startSec,
                  movingLayer.endSec,
                )
              ) {
                // セクション相対 idx に変換
                const sectionIdx = isAudioMoving
                  ? t.rowIdx - videoTrackCount
                  : t.rowIdx;
                onLayersReorder(
                  applyTrackAction(layers, drag.layerId, {
                    type: "merge",
                    targetDisplayIdx: sectionIdx,
                  }),
                );
              }
            }
          } else if (t.type === "insert") {
            // 挿入位置がどちらのセクション境界かを判定
            const insertSection: "video" | "audio" =
              t.beforeIdx <= videoTrackCount ? "video" : "audio";
            const movingSection: "video" | "audio" = isAudioMoving ? "audio" : "video";
            if (insertSection === movingSection) {
              const sectionIdx = isAudioMoving
                ? Math.max(0, t.beforeIdx - videoTrackCount)
                : t.beforeIdx;
              onLayersReorder(
                applyTrackAction(layers, drag.layerId, {
                  type: "insert",
                  beforeDisplayIdx: sectionIdx,
                }),
              );
            }
          }
        }
      }
      setDrag(null);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, pxPerSec, totalDuration, segments, layers, playheadSec, tracks]);

  const startDrag = (
    e: React.MouseEvent,
    layer: Layer,
    mode: DragMode,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const modifier = e.shiftKey
      ? "shift"
      : e.ctrlKey || e.metaKey
        ? "ctrl"
        : null;
    // 修飾キー付き or 選択外のクリックは選択を更新。修飾なしで既に選択済みならドラッグのみ開始
    if (modifier || !selectedSet.has(layer.id)) {
      onLayerSelect(layer.id, modifier);
    }
    // 修飾キー付きクリック時はドラッグせず選択のみ
    if (modifier) return;
    // ロック済みレイヤーは選択のみ、ドラッグ/リサイズしない
    if (layer.locked) return;
    const initialRowIdx = tracks.findIndex((t) => t.zIndex === layer.zIndex);
    // マルチ選択時、move モードのみ一括対象を記録（リサイズは単独）
    let multi: DragState["multi"] = undefined;
    if (mode === "move" && selectedSet.size > 1 && selectedSet.has(layer.id)) {
      multi = layers
        .filter((l) => selectedSet.has(l.id) && l.id !== layer.id && !l.locked)
        .map((l) => ({
          id: l.id,
          initialStart: l.startSec,
          initialEnd: l.endSec,
          zIndex: l.zIndex,
        }));
    }
    setDrag({
      layerId: layer.id,
      mode,
      initialMouseX: e.clientX,
      initialMouseY: e.clientY,
      initialStart: layer.startSec,
      initialEnd: layer.endSec,
      initialZIndex: layer.zIndex,
      initialRowIdx,
      previewTarget: { type: "row", rowIdx: initialRowIdx },
      multi,
    });
  };

  const handleTrackBgMouseDown = (e: React.MouseEvent) => {
    if (drag) return;
    if (!trackAreaRef.current) return;
    const rect = trackAreaRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const raw = Math.max(0, Math.min(totalDuration, pxToSec(x)));
    onPlayheadChange(snapPlayhead(raw));
    // 以降 mousemove でシーク追従（選択解除は document 側でまとめて処理）
    setPlayheadDragging(true);
    e.preventDefault();
  };

  useEffect(() => {
    if (!playheadDragging) return;
    const onMouseMove = (e: MouseEvent) => {
      if (!trackAreaRef.current) return;
      const rect = trackAreaRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const raw = Math.max(0, Math.min(totalDuration, pxToSec(x)));
      onPlayheadChange(snapPlayhead(raw));
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

  const isDraggingMove = drag !== null && drag.mode === "move";

  return (
    <div
      ref={scrollContainerRef}
      className="bg-gray-50 dark:bg-gray-900/50 rounded text-[11px] overflow-auto"
      style={{ maxHeight: "100%" }}
    >
      <div
        className="relative"
        style={{ width: innerWidth }}
      >
          {/* ルーラー行（縦スクロールで top に sticky） */}
          <div
            className="flex sticky top-0 z-30"
            style={{ height: RULER_HEIGHT }}
          >
            <div
              style={{ width: LABEL_WIDTH, height: RULER_HEIGHT }}
              className="sticky left-0 z-40 shrink-0 bg-gray-100 dark:bg-gray-800 border-b border-r border-gray-200 dark:border-gray-700 flex items-center justify-between px-2 text-[10px] text-gray-500 font-medium"
              title={`ズーム ${(pxPerSec / DEFAULT_PX_PER_SEC).toFixed(2)}x (Ctrl+ホイール / Ctrl+=- / Ctrl+0)`}
            >
              <span>タイムライン</span>
              <span className="text-gray-400 tabular-nums">
                {(pxPerSec / DEFAULT_PX_PER_SEC).toFixed(1)}x
              </span>
            </div>
            <div
              ref={trackAreaRef}
              className="relative border-b border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 cursor-pointer select-none"
              style={{ width: trackContentWidth, height: RULER_HEIGHT }}
              onMouseDown={handleTrackBgMouseDown}
            >
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
              {Array.from({ length: Math.floor(totalDuration) + 1 }).map(
                (_, s) => (
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
                ),
              )}
            </div>
          </div>

          {/* トラック行 */}
          <div ref={tracksContainerRef} className="relative">
            {tracks.length === 0 ? (
              <div className="flex">
                <div
                  className="sticky left-0 z-20 shrink-0 bg-gray-100/60 dark:bg-gray-800/60 border-r border-gray-200 dark:border-gray-700"
                  style={{ width: LABEL_WIDTH }}
                />
                <div className="px-3 py-4 text-center text-[11px] text-gray-400 flex-1">
                  レイヤーを追加するとタイムラインに表示されます
                </div>
              </div>
            ) : (
              tracks.map((track, trackIdx) => {
                const isTargetRow =
                  drag != null &&
                  drag.mode === "move" &&
                  drag.previewTarget.type === "row" &&
                  drag.previewTarget.rowIdx === trackIdx &&
                  drag.initialRowIdx !== trackIdx;
                let dropValid = true;
                if (isTargetRow && drag) {
                  const movingLayer = layers.find((l) => l.id === drag.layerId);
                  if (movingLayer) {
                    const movingIsAudio = movingLayer.type === "audio";
                    // セクション違いは無効
                    if (track.isAudio !== movingIsAudio) {
                      dropValid = false;
                    } else {
                      dropValid = !hasTimeConflictOnTrack(
                        layers,
                        drag.layerId,
                        track.zIndex,
                        movingLayer.startSec,
                        movingLayer.endSec,
                      );
                    }
                  }
                }
                const isMainTrack = !track.isAudio && track.zIndex === 0;
                const isLastVideoTrack =
                  !track.isAudio &&
                  tracks[trackIdx + 1]?.isAudio === true;
                return (
                  <div key={track.zIndex} className="flex">
                    <div
                      style={{ width: LABEL_WIDTH, height: ROW_HEIGHT }}
                      className={`sticky left-0 z-20 shrink-0 border-b border-r border-gray-200 dark:border-gray-700 flex items-center px-2 text-[10px] text-gray-500 ${
                        isMainTrack
                          ? "bg-amber-100/80 dark:bg-amber-900/30"
                          : track.isAudio
                            ? "bg-purple-100/50 dark:bg-purple-900/20"
                            : "bg-gray-100/80 dark:bg-gray-800/80"
                      } ${
                        isLastVideoTrack
                          ? "border-b-2 border-b-amber-500 dark:border-b-amber-600"
                          : ""
                      }`}
                    >
                      <span className="font-medium">
                        {isMainTrack && "★ "}
                        {track.isAudio ? "🎵 " : ""}
                        トラック {trackIdx + 1}
                      </span>
                    </div>
                    <div
                      className={`relative border-b border-gray-200 dark:border-gray-700 cursor-pointer ${
                        isTargetRow
                          ? dropValid
                            ? "bg-blue-50 dark:bg-blue-900/20"
                            : "bg-red-50 dark:bg-red-900/20"
                          : isMainTrack
                            ? "bg-amber-50/40 dark:bg-amber-900/10"
                            : track.isAudio
                              ? "bg-purple-50/20 dark:bg-purple-900/5"
                              : "bg-white dark:bg-gray-900"
                      } ${
                        isLastVideoTrack
                          ? "border-b-2 border-b-amber-500 dark:border-b-amber-600"
                          : ""
                      }`}
                      style={{ width: trackContentWidth, height: ROW_HEIGHT }}
                      onMouseDown={handleTrackBgMouseDown}
                    >
                      {track.layers.map((layer) => {
                        const isSelected = selectedSet.has(layer.id);
                        const isCurrentlyDragging =
                          drag?.layerId === layer.id && drag?.mode === "move";
                        const barLeft = secToPx(layer.startSec);
                        const barWidth = Math.max(
                          4,
                          secToPx(layer.endSec - layer.startSec),
                        );
                        let rowTranslateY = 0;
                        if (isCurrentlyDragging && drag) {
                          if (drag.previewTarget.type === "row") {
                            rowTranslateY =
                              (drag.previewTarget.rowIdx - drag.initialRowIdx) *
                              ROW_HEIGHT;
                          } else {
                            rowTranslateY =
                              drag.previewTarget.beforeIdx * ROW_HEIGHT -
                              drag.initialRowIdx * ROW_HEIGHT -
                              ROW_HEIGHT / 2;
                          }
                        }
                        const cursorStyle = layer.locked
                          ? "not-allowed"
                          : isCurrentlyDragging
                            ? "grabbing"
                            : "grab";
                        return (
                          <div
                            key={layer.id}
                            data-layer-id={layer.id}
                            onMouseDown={(e) => startDrag(e, layer, "move")}
                            onClick={(e) => e.stopPropagation()}
                            className={`absolute top-1 bottom-1 rounded ${
                              isCurrentlyDragging
                                ? "opacity-90 z-30 shadow-lg"
                                : "transition-shadow"
                            } ${
                              isSelected
                                ? "bg-blue-500 hover:bg-blue-600 ring-2 ring-blue-300 dark:ring-blue-700"
                                : "bg-gray-400 hover:bg-gray-500 dark:bg-gray-600 dark:hover:bg-gray-500"
                            } ${layer.hidden ? "opacity-40" : ""}`}
                            style={{
                              left: barLeft,
                              width: barWidth,
                              transform: rowTranslateY
                                ? `translateY(${rowTranslateY}px)`
                                : undefined,
                              cursor: cursorStyle,
                              backgroundImage: layer.hidden
                                ? "repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(255,255,255,0.2) 4px, rgba(255,255,255,0.2) 8px)"
                                : undefined,
                            }}
                            title={`${LAYER_ICON[layer.type] ?? "◼"} ${
                              layer.text?.slice(0, 16) || layer.type
                            } | ${layer.startSec.toFixed(2)}s → ${layer.endSec.toFixed(2)}s${
                              layer.hidden ? " [非表示]" : ""
                            }${layer.locked ? " [ロック]" : ""}`}
                          >
                            <div
                              onMouseDown={(e) =>
                                startDrag(e, layer, "resize-left")
                              }
                              className="absolute left-0 top-0 bottom-0 w-2 bg-white/0 hover:bg-white/30"
                              style={{ cursor: "ew-resize" }}
                            />
                            <div
                              onMouseDown={(e) =>
                                startDrag(e, layer, "resize-right")
                              }
                              className="absolute right-0 top-0 bottom-0 w-2 bg-white/0 hover:bg-white/30"
                              style={{ cursor: "ew-resize" }}
                            />
                            {barWidth >= 32 && (
                              <div className="absolute inset-0 flex items-center text-[9px] text-white/90 px-1 pointer-events-none gap-1">
                                <BarThumbnail layer={layer} />
                                {barWidth >= 60 && (
                                  <span className="truncate flex-1">
                                    {layer.locked ? "🔒 " : layer.hidden ? "🙈 " : ""}
                                    {layer.text?.slice(0, 10) || layer.type}
                                  </span>
                                )}
                                {barWidth >= 90 && (
                                  <span className="shrink-0 opacity-80">
                                    {(layer.endSec - layer.startSec).toFixed(1)}s
                                  </span>
                                )}
                              </div>
                            )}
                            {(() => {
                              const isAudio = layer.type === "audio";
                              const entryDurSec = isAudio
                                ? layer.audioFadeIn ?? 0
                                : layer.entryAnimation &&
                                    layer.entryAnimation !== "none"
                                  ? layer.entryDuration ?? 0.3
                                  : 0;
                              const exitDurSec = isAudio
                                ? layer.audioFadeOut ?? 0
                                : layer.exitAnimation &&
                                    layer.exitAnimation !== "none"
                                  ? layer.exitDuration ?? 0.3
                                  : 0;
                              // バー幅の半分以上には広げない
                              const maxPx = barWidth / 2 - 2;
                              const entryPx = Math.min(
                                entryDurSec * pxPerSec,
                                maxPx,
                              );
                              const exitPx = Math.min(
                                exitDurSec * pxPerSec,
                                maxPx,
                              );
                              const arrowColor =
                                "rgba(255,255,255,0.95)";
                              return (
                                <>
                                  {entryPx >= 4 && (
                                    <>
                                      <div
                                        className="absolute pointer-events-none"
                                        style={{
                                          left: 0,
                                          top: 3,
                                          width: entryPx,
                                          height: 2,
                                          background: arrowColor,
                                          borderRadius: 1,
                                        }}
                                        title={`入場 ${entryDurSec.toFixed(2)}s`}
                                      />
                                      <div
                                        className="absolute pointer-events-none"
                                        style={{
                                          left: Math.max(0, entryPx - 4),
                                          top: 0,
                                          width: 0,
                                          height: 0,
                                          borderLeft: `4px solid ${arrowColor}`,
                                          borderTop:
                                            "4px solid transparent",
                                          borderBottom:
                                            "4px solid transparent",
                                        }}
                                      />
                                    </>
                                  )}
                                  {exitPx >= 4 && (
                                    <>
                                      <div
                                        className="absolute pointer-events-none"
                                        style={{
                                          right: 0,
                                          top: 3,
                                          width: exitPx,
                                          height: 2,
                                          background: arrowColor,
                                          borderRadius: 1,
                                        }}
                                        title={`退場 ${exitDurSec.toFixed(2)}s`}
                                      />
                                      <div
                                        className="absolute pointer-events-none"
                                        style={{
                                          right: Math.max(0, exitPx - 4),
                                          top: 0,
                                          width: 0,
                                          height: 0,
                                          borderRight: `4px solid ${arrowColor}`,
                                          borderTop:
                                            "4px solid transparent",
                                          borderBottom:
                                            "4px solid transparent",
                                        }}
                                      />
                                    </>
                                  )}
                                </>
                              );
                            })()}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            )}

            {/* 挿入インジケータ */}
            {isDraggingMove &&
              drag &&
              drag.previewTarget.type === "insert" &&
              (() => {
                const lineTop = drag.previewTarget.beforeIdx * ROW_HEIGHT;
                return (
                  <div
                    className="absolute pointer-events-none z-40"
                    style={{
                      top: Math.max(0, lineTop - 1),
                      left: LABEL_WIDTH,
                      width: trackContentWidth,
                      height: 3,
                    }}
                  >
                    <div
                      className="bg-blue-500 rounded"
                      style={{ height: "100%" }}
                    />
                  </div>
                );
              })()}
          </div>

          {/* Playhead（inner コンテナ内に絶対配置。横スクロールで一緒に動く） */}
          {trackContentWidth > 0 && (
            <div
              className="absolute top-0"
              style={{
                left: LABEL_WIDTH + secToPx(playheadSec),
                height:
                  RULER_HEIGHT +
                  Math.max(1, tracks.length) * ROW_HEIGHT,
                pointerEvents: "none",
                zIndex: 45,
              }}
            >
              <div className="w-px h-full bg-red-500" />
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

