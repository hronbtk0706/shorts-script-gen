import { useEffect, useRef, useState } from "react";
import Moveable from "react-moveable";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Layer } from "../types";
import { sortedLayers } from "../lib/layerUtils";
import { sampleLayerAt } from "../lib/keyframes";
import { computeDuckMultiplier } from "../lib/ducking";
import { computeScreenShake } from "../lib/screenEffect";
import { bubbleFullPath } from "../lib/bubble";
import { TEXT_DEFAULT_FONT_STACK } from "../lib/layerComposer";
import { CharacterLayerContent } from "./CharacterLayerContent";
import { LayerErrorBoundary } from "./LayerErrorBoundary";

function resolveSrcForWebview(src: string | undefined): string | null {
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
  // ローカルファイルパス → Tauri webview で表示可能な URL に変換
  try {
    return convertFileSrc(src);
  } catch {
    return null;
  }
}

interface Props {
  layers: Layer[];
  selectedLayerId: string | null;
  /** 複数選択中の全 id。未指定なら [selectedLayerId] 相当 */
  selectedLayerIds?: string[];
  onLayerSelect: (
    id: string | null,
    modifier?: "shift" | "ctrl" | null,
  ) => void;
  onLayerUpdate: (id: string, patch: Partial<Layer>) => void;
  /** 背景色（キャンバス自体の背景、レイヤーなしでも見える色） */
  canvasBackground?: string;
  /** グリッド表示 */
  showGrid?: boolean;
  /** 指定時刻に可視なレイヤーだけ表示（未指定なら全レイヤー） */
  currentTimeSec?: number;
  /** タイムライン再生中かどうか（動画レイヤー再生同期用） */
  isPlaying?: boolean;
  /** 出力アスペクト比。未指定なら 9:16 (旧テンプレ互換) */
  aspect?: "vertical" | "horizontal";
}

/** 仮想キャンバスの最大サイズ。親幅／ビューポート高さに応じて拡縮 */
// 縦動画 (9:16) は横幅 720px 程度で十分 (高さで親コンテナを埋める)。
// 横動画 (16:9) は幅優先で大きく表示したいので最大値を 1280 まで許す。
// 実際の幅は親コンテナの実サイズで決まるので、ここはあくまで上限。
const CANVAS_MAX_W_PX = 1280;
const CANVAS_MIN_W_PX = 120;
/** キャンバスが占有してよいビューポート高さの割合 */
const CANVAS_HEIGHT_RATIO = 0.82;

export function TemplateCanvas({
  layers,
  selectedLayerId,
  selectedLayerIds,
  onLayerSelect,
  onLayerUpdate,
  canvasBackground = "#111",
  showGrid = false,
  currentTimeSec,
  isPlaying = false,
  aspect = "vertical",
}: Props) {
  // 縦 9:16, 横 16:9 のいずれか。CANVAS の縦横比をここから決める。
  const aspectRatioWH = aspect === "horizontal" ? 16 / 9 : 9 / 16;
  const selectedSet = new Set<string>(
    selectedLayerIds ?? (selectedLayerId ? [selectedLayerId] : []),
  );
  const isInTime = (l: Layer) =>
    currentTimeSec === undefined ||
    (currentTimeSec >= l.startSec && currentTimeSec < l.endSec);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement | null>(null);
  const [, forceRerender] = useState(0);
  const initW = Math.round(Math.min(CANVAS_MAX_W_PX, 360));
  const [canvasSize, setCanvasSize] = useState({
    w: initW,
    h: Math.round(initW / aspectRatioWH),
  });
  // Shift 押下中のみアスペクト比を固定する（通常ドラッグは自由変形）
  const [shiftHeld, setShiftHeld] = useState(false);
  // キャンバス上のテキスト編集中のレイヤー id (ダブルクリックで開始)
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(true);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(false);
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, []);

  // 親要素の実サイズ（flex レイアウトで決定）に合わせてアスペクト比を維持して拡縮
  useEffect(() => {
    if (!wrapperRef.current) return;
    const measure = () => {
      if (!wrapperRef.current) return;
      const availW = wrapperRef.current.clientWidth;
      // 親コンテナの実高さを優先。取得できなければビューポート基準にフォールバック
      const parentH = wrapperRef.current.clientHeight;
      const availH =
        parentH > 0 ? parentH : window.innerHeight * CANVAS_HEIGHT_RATIO;
      const wByWidth = availW;
      // height に収まる幅 = availH × (W/H)
      const wByHeight = availH * aspectRatioWH;
      const w = Math.max(
        CANVAS_MIN_W_PX,
        Math.min(CANVAS_MAX_W_PX, wByWidth, wByHeight),
      );
      const h = Math.round(w / aspectRatioWH);
      setCanvasSize({ w: Math.round(w), h });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrapperRef.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [aspectRatioWH]);

  const CANVAS_W_PX = canvasSize.w;
  const CANVAS_H_PX = canvasSize.h;

  // 表示中（in-time）でかつ selected のレイヤーだけ Moveable を出す。hidden/locked は除外
  const selected =
    layers.find(
      (l) =>
        l.id === selectedLayerId &&
        isInTime(l) &&
        !l.hidden &&
        !l.locked,
    ) ?? null;
  // selected が変わったら Moveable を再計算させる
  useEffect(() => {
    if (!selected) targetRef.current = null;
    forceRerender((n) => n + 1);
  }, [selectedLayerId, selected]);

  const pxToPercent = (px: number, dimension: "w" | "h") =>
    (px / (dimension === "w" ? CANVAS_W_PX : CANVAS_H_PX)) * 100;

  const handleBackgroundClick = (e: React.MouseEvent) => {
    // クリックした要素がレイヤーに属していないなら選択解除
    const hitLayer =
      e.target instanceof HTMLElement
        ? e.target.closest("[data-layer-id]")
        : null;
    if (!hitLayer) {
      onLayerSelect(null);
    }
  };

  // 画面全体エフェクト（type === "effect" の shake）。再生中のみ適用（編集中は
  // Moveable とのズレを避けるため静止）。export 側 (computeScreenShake) と同式・同 seed。
  const screenShake = isPlaying
    ? computeScreenShake(layers, currentTimeSec ?? 0, CANVAS_W_PX / 360)
    : { dx: 0, dy: 0 };
  const hasShake = screenShake.dx !== 0 || screenShake.dy !== 0;
  const screenShakeStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    transform: hasShake
      ? `translate(${screenShake.dx.toFixed(2)}px, ${screenShake.dy.toFixed(2)}px)`
      : undefined,
    willChange: hasShake ? "transform" : undefined,
  };

  return (
    <div
      ref={wrapperRef}
      className="w-full h-full flex justify-center items-start"
    >
    <div
      ref={containerRef}
      onMouseDown={handleBackgroundClick}
      className="relative overflow-hidden shadow-lg"
      style={{
        width: CANVAS_W_PX,
        height: CANVAS_H_PX,
        background: canvasBackground,
      }}
    >
      {showGrid && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            zIndex: 9999,
            backgroundImage:
              "linear-gradient(to right, rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.08) 1px, transparent 1px)",
            backgroundSize: `${CANVAS_W_PX / 10}px ${CANVAS_H_PX / 10}px`,
          }}
        />
      )}
      {/* レイヤー群は shake 用 inner div でラップ（グリッド/Moveable は揺らさない） */}
      <div style={screenShakeStyle}>
        {sortedLayers(layers)
          .filter(
            (layer) =>
              isInTime(layer) &&
              !layer.hidden &&
              layer.type !== "audio" &&
              layer.type !== "effect",
          )
          .map((layer) => (
            <LayerView
              key={layer.id}
              layer={layer}
              isSelected={selectedSet.has(layer.id)}
              isPrimary={layer.id === selectedLayerId}
              dimmed={false}
              canvasWPx={CANVAS_W_PX}
              canvasHPx={CANVAS_H_PX}
              currentTimeSec={currentTimeSec ?? 0}
              isPlaying={isPlaying}
              cssFilter=""
              allLayers={layers}
              editingLayerId={editingLayerId}
              onSelect={(modifier) => onLayerSelect(layer.id, modifier)}
              onUpdate={(patch) => onLayerUpdate(layer.id, patch)}
              onRefReady={(el) => {
                if (layer.id === selectedLayerId) {
                  targetRef.current = el;
                  forceRerender((n) => n + 1);
                }
              }}
              onEditStart={(id) => setEditingLayerId(id)}
              onEditEnd={() => setEditingLayerId(null)}
            />
          ))}
      </div>

      {/* 音声レイヤー（視覚なし、<audio> を playhead 同期） */}
      {layers
        .filter((l) => l.type === "audio" && !l.hidden && isInTime(l))
        .map((layer) => (
          <AudioLayerPlayer
            key={layer.id}
            layer={layer}
            currentTimeSec={currentTimeSec ?? 0}
            isPlaying={isPlaying}
            allLayers={layers}
          />
        ))}

      {selected && targetRef.current && (
        <Moveable
          // レイヤーの位置/サイズが変わるたびに Moveable を作り直して内部状態を同期
          key={`mv_${selected.id}_${selected.x.toFixed(2)}_${selected.y.toFixed(2)}_${selected.width.toFixed(2)}_${selected.height.toFixed(2)}_${selected.rotation ?? 0}`}
          target={targetRef.current}
          draggable
          resizable
          rotatable
          origin={false}
          // デフォルトは自由変形。Shift 押下中のみアスペクト比固定。
          keepRatio={shiftHeld}
          throttleDrag={0}
          throttleResize={0}
          throttleRotate={0}
          // 画面端・中央・他レイヤーにスナップ
          snappable
          snapThreshold={8}
          snapDirections={{
            top: true,
            right: true,
            bottom: true,
            left: true,
            center: true,
            middle: true,
          }}
          elementSnapDirections={{
            top: true,
            right: true,
            bottom: true,
            left: true,
            center: true,
            middle: true,
          }}
          verticalGuidelines={[0, CANVAS_W_PX / 2, CANVAS_W_PX]}
          horizontalGuidelines={[0, CANVAS_H_PX / 2, CANVAS_H_PX]}
          elementGuidelines={
            containerRef.current
              ? Array.from(
                  containerRef.current.querySelectorAll<HTMLElement>(
                    "[data-layer-id]",
                  ),
                ).filter((el) => el.dataset.layerId !== selected.id)
              : []
          }
          onDrag={(e) => {
            e.target.style.transform = e.transform;
          }}
          onDragEnd={(e) => {
            const el = e.target as HTMLElement;
            const dx = e.lastEvent?.translate?.[0] ?? 0;
            const dy = e.lastEvent?.translate?.[1] ?? 0;
            const baseLeft = (selected.x / 100) * CANVAS_W_PX;
            const baseTop = (selected.y / 100) * CANVAS_H_PX;
            const finalX = baseLeft + dx;
            const finalY = baseTop + dy;
            // transform をリセット（回転は保持）
            el.style.transform = selected.rotation
              ? `rotate(${selected.rotation}deg)`
              : "";
            onLayerUpdate(selected.id, {
              x: pxToPercent(finalX, "w"),
              y: pxToPercent(finalY, "h"),
            });
          }}
          onResize={(e) => {
            e.target.style.width = `${e.width}px`;
            e.target.style.height = `${e.height}px`;
            e.target.style.transform = e.drag.transform;
          }}
          onResizeEnd={(e) => {
            const el = e.target as HTMLElement;
            const widthPx = parseFloat(el.style.width);
            const heightPx = parseFloat(el.style.height);
            const dx = e.lastEvent?.drag?.translate?.[0] ?? 0;
            const dy = e.lastEvent?.drag?.translate?.[1] ?? 0;
            const baseLeft = (selected.x / 100) * CANVAS_W_PX;
            const baseTop = (selected.y / 100) * CANVAS_H_PX;
            const finalX = baseLeft + dx;
            const finalY = baseTop + dy;
            el.style.transform = selected.rotation
              ? `rotate(${selected.rotation}deg)`
              : "";
            onLayerUpdate(selected.id, {
              x: pxToPercent(finalX, "w"),
              y: pxToPercent(finalY, "h"),
              width: pxToPercent(widthPx, "w"),
              height: pxToPercent(heightPx, "h"),
            });
          }}
          onRotate={(e) => {
            e.target.style.transform = e.drag.transform;
          }}
          onRotateEnd={(e) => {
            onLayerUpdate(selected.id, {
              rotation: e.lastEvent?.rotate ?? 0,
            });
          }}
        />
      )}
    </div>
    </div>
  );
}

interface LayerViewProps {
  layer: Layer;
  isSelected: boolean;
  isPrimary?: boolean;
  dimmed?: boolean;
  canvasWPx: number;
  canvasHPx: number;
  currentTimeSec: number;
  isPlaying: boolean;
  cssFilter?: string;
  /** リップシンク等で他レイヤー (音声等) を参照するためのテンプレ全レイヤー */
  allLayers?: Layer[];
  /** インライン編集中のレイヤー id (キャンバス上テキスト編集) */
  editingLayerId?: string | null;
  onSelect: (modifier?: "shift" | "ctrl" | null) => void;
  onUpdate: (patch: Partial<Layer>) => void;
  onRefReady: (el: HTMLDivElement | null) => void;
  /** インライン編集の開始 / 終了 */
  onEditStart?: (id: string) => void;
  onEditEnd?: () => void;
}

function LayerView({
  layer: rawLayer,
  isSelected,
  isPrimary = false,
  dimmed = false,
  canvasWPx,
  canvasHPx,
  currentTimeSec,
  isPlaying,
  cssFilter,
  allLayers,
  editingLayerId,
  onSelect,
  onUpdate,
  onRefReady,
  onEditStart,
  onEditEnd,
}: LayerViewProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isSelected) onRefReady(ref.current);
  }, [isSelected, onRefReady]);

  // 再生中はキーフレーム補間値で表示（編集中は静的値のまま、ドラッグ等の操作を妨げない）
  const layer: Layer =
    isPlaying && rawLayer.keyframes
      ? (() => {
          const s = sampleLayerAt(rawLayer, currentTimeSec);
          return {
            ...rawLayer,
            x: s.x,
            y: s.y,
            width: s.width,
            height: s.height,
            rotation: s.rotation,
            opacity: s.opacity,
          };
        })()
      : rawLayer;

  const leftPx = (layer.x / 100) * canvasWPx;
  const topPx = (layer.y / 100) * canvasHPx;
  const widthPx = (layer.width / 100) * canvasWPx;
  const heightPx = (layer.height / 100) * canvasHPx;

  // 形状の borderRadius。外側（クリップ）と内側（border 描画）で共有する
  // layerComposer が borderRadius * (FINAL_W/360) で描画するため、プレビューも canvasWPx/360 倍する
  const dimScale = canvasWPx / 360;
  let borderRadius: string | number | undefined;
  if (layer.shape === "circle") {
    borderRadius = "50%";
  } else if (layer.shape === "rounded") {
    borderRadius = (layer.borderRadius ?? 12) * dimScale;
  }

  const outerStyle: React.CSSProperties = {};
  if (borderRadius !== undefined) outerStyle.borderRadius = borderRadius;

  const baseOpacity = layer.opacity ?? 1;
  // 入退場アニメ / motion / ambient は内側ラッパーに集約して Moveable の外側矩形を安定させる
  const anim = computeLayerAnimStyle(layer, currentTimeSec);
  // ambient の px 振幅は design(360) 基準 → プレビュー解像度 canvasWPx へ換算
  // (export computeCanvasAnim の pxScale=FINAL_W/360 と一致させる)
  const ambient = computeLayerAmbientStyle(layer, currentTimeSec, canvasWPx / 360);
  const effectiveOpacity =
    (dimmed ? baseOpacity * 0.25 : baseOpacity) *
    anim.opacity *
    ambient.opacity;
  if (effectiveOpacity !== 1) {
    outerStyle.opacity = effectiveOpacity;
  }
  // 時間外のレイヤーは点線枠で示す（border 有無に関わらず外側 outline として表示）
  if (dimmed) {
    outerStyle.outline = "2px dashed rgba(255,255,255,0.35)";
    outerStyle.outlineOffset = "-2px";
  }

  // 外側に乗せるのは rotation のみ（Moveable の rotatable が扱える）
  const outerTransform = layer.rotation
    ? `rotate(${layer.rotation}deg)`
    : undefined;

  // 吹き出し（comment + bubble）はしっぽが枠外に出られるよう overflow を visible にする
  const isBubbleLayer = layer.type === "comment" && !!layer.bubble;
  const style: React.CSSProperties = {
    position: "absolute",
    left: leftPx,
    top: topPx,
    width: widthPx,
    height: heightPx,
    transform: outerTransform,
    filter: cssFilter || undefined,
    cursor: "pointer",
    userSelect: "none",
    overflow: isBubbleLayer ? "visible" : "hidden",
    zIndex: layer.zIndex,
    ...outerStyle,
  };

  // エクスポート側（layerComposer.drawText）が fontSize * (FINAL_W/360) = fontSize * 3 で
  // 1080×1920 に描画するため、プレビューも同じ係数 (canvasWPx / 360) を掛けないと見た目が一致しない。
  const fontScale = canvasWPx / 360;
  const inner = renderLayerContent(layer, currentTimeSec, isPlaying, fontScale, allLayers);
  const motionTransform = computeLayerMotionTransform(layer, currentTimeSec);
  // 入退場 / motion / ambient の transform / filter を合成した内側 style
  const innerTransformParts: string[] = [];
  if (anim.transform) innerTransformParts.push(anim.transform);
  if (motionTransform) innerTransformParts.push(motionTransform);
  if (ambient.transform) innerTransformParts.push(ambient.transform);
  const innerTransform = innerTransformParts.join(" ");
  const innerFilterParts: string[] = [];
  if (anim.filter) innerFilterParts.push(anim.filter);
  if (ambient.filter) innerFilterParts.push(ambient.filter);
  const innerFilter = innerFilterParts.join(" ");

  // テキスト系レイヤー（comment）は renderAnimatedText 内で border を適用するためここでは省く
  // layerComposer が border.width * (FINAL_W/360) で描画するためプレビューも同じ係数に
  const innerBoxShadow =
    layer.border && layer.type !== "comment"
      ? `inset 0 0 0 ${(layer.border.width * dimScale).toFixed(2)}px ${layer.border.color}`
      : undefined;

  const innerStyle: React.CSSProperties = {
    width: "100%",
    height: "100%",
    borderRadius,
    boxShadow: innerBoxShadow,
    transform: innerTransform || undefined,
    transformOrigin: anim.transformOrigin ?? "center center",
    filter: innerFilter || undefined,
  };

  // 複数選択 (プライマリではない) には細いアウトラインを出す
  const multiSelectOutline =
    isSelected && !isPrimary
      ? "2px solid rgba(59, 130, 246, 0.9)"
      : undefined;
  const styleWithSelection: React.CSSProperties = multiSelectOutline
    ? { ...style, outline: multiSelectOutline, outlineOffset: "-2px" }
    : style;

  const isEditingThis =
    editingLayerId === layer.id && layer.type === "comment";

  return (
    <div
      ref={ref}
      data-layer-id={layer.id}
      style={styleWithSelection}
      onMouseDown={(e) => {
        e.stopPropagation();
        const modifier = e.shiftKey
          ? "shift"
          : e.ctrlKey || e.metaKey
            ? "ctrl"
            : null;
        onSelect(modifier);
      }}
      onDoubleClick={(e) => {
        if (layer.type === "comment" && onEditStart) {
          e.stopPropagation();
          onEditStart(layer.id);
        }
      }}
    >
      <div style={innerStyle}>
        {isEditingThis ? (
          <CanvasTextEditor
            layer={layer}
            fontScale={fontScale}
            onCommit={(text) => {
              onUpdate({ text });
              onEditEnd?.();
            }}
            onCancel={() => onEditEnd?.()}
          />
        ) : (
          inner
        )}
      </div>
      {/* 吹き出しのしっぽ先端ドラッグハンドル（選択中 & bubble.tail あり時のみ） */}
      {isSelected &&
        layer.type === "comment" &&
        layer.bubble?.tail && (
          <TailHandle
            tipX={layer.bubble.tail.tipX}
            tipY={layer.bubble.tail.tipY}
            onChange={(x, y) => {
              const bubble = layer.bubble;
              if (!bubble?.tail) return;
              onUpdate({
                bubble: {
                  ...bubble,
                  tail: { ...bubble.tail, tipX: x, tipY: y },
                },
              });
            }}
          />
        )}
    </div>
  );
}

/**
 * comment レイヤーをキャンバス上で直接編集するための textarea。
 * - フォントは layer.fontFamily / layer.fontSize で揃える
 * - Esc でキャンセル / Enter (Shift なし) で確定 / blur で確定
 */
function CanvasTextEditor({
  layer,
  fontScale,
  onCommit,
  onCancel,
}: {
  layer: Layer;
  fontScale: number;
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(layer.text ?? "");

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.focus();
    // テキスト全選択 (上書き入力しやすく)
    el.select();
  }, []);

  return (
    <textarea
      ref={taRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Enter は通常通り改行 (preventDefault しない)
        // Esc キャンセル / Ctrl+Enter で確定
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          onCommit(draft);
        }
      }}
      onBlur={() => onCommit(draft)}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        background: "rgba(0, 0, 0, 0.15)",
        color: layer.fontColor ?? "#ffffff",
        // renderAnimatedText と同じ式: fontSize * (canvasWPx / 360)
        // 編集中も確定後と同じサイズで表示するために fontScale をそのまま掛ける
        fontSize: `${(layer.fontSize ?? 48) * fontScale}px`,
        fontFamily: layer.fontFamily ?? "inherit",
        textAlign: "center",
        border: "2px solid #3b82f6",
        outline: "none",
        resize: "none",
        padding: 4,
        boxSizing: "border-box",
      }}
    />
  );
}

function renderLayerContent(
  layer: Layer,
  currentTimeSec: number,
  isPlaying: boolean,
  fontScale?: number,
  allLayers?: Layer[],
): React.ReactNode {
  switch (layer.type) {
    case "color":
      if (layer.shape === "arc") {
        return <ArcShapeSvg layer={layer} defaultFill="#333" currentTimeSec={currentTimeSec} />;
      }
      return (
        <div
          style={{
            width: "100%",
            height: "100%",
            background: layer.fillColor ?? "#333",
          }}
        />
      );
    case "shape":
      if (layer.shape === "arc") {
        return <ArcShapeSvg layer={layer} defaultFill="#FFE600" currentTimeSec={currentTimeSec} />;
      }
      return (
        <div
          style={{
            width: "100%",
            height: "100%",
            background: layer.fillColor ?? "#FFE600",
          }}
        />
      );
    case "image": {
      const resolved = resolveSrcForWebview(layer.source);
      if (!resolved) {
        return (
          <div
            style={{
              width: "100%",
              height: "100%",
              background: `repeating-linear-gradient(45deg, #444, #444 8px, #555 8px, #555 16px)`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#999",
              fontSize: 10,
            }}
          >
            🖼 画像(未設定)
          </div>
        );
      }
      // crop 対応: 枠を overflow:hidden にして、内部の img を crop 分だけ拡大＋ネガオフセットで
      // 「クロップ矩形だけが枠に見える」ように配置する。
      const crop = layer.crop;
      const cw = crop ? Math.max(1, crop.width) : 100;
      const ch = crop ? Math.max(1, crop.height) : 100;
      const cx = crop ? crop.x : 0;
      const cy = crop ? crop.y : 0;
      return (
        <div
          style={{
            width: "100%",
            height: "100%",
            position: "relative",
            overflow: "hidden",
          }}
        >
          <img
            src={resolved}
            style={{
              position: "absolute",
              width: `${(100 * 100) / cw}%`,
              height: `${(100 * 100) / ch}%`,
              top: `${(-cy * 100) / ch}%`,
              left: `${(-cx * 100) / cw}%`,
              objectFit: "cover",
              pointerEvents: "none",
              userSelect: "none",
            }}
            draggable={false}
            alt=""
          />
        </div>
      );
    }
    case "video": {
      return (
        <VideoLayerContent
          layer={layer}
          currentTimeSec={currentTimeSec}
          isPlaying={isPlaying}
        />
      );
    }
    case "comment":
      if (layer.bubble) {
        // 吹き出しモード: SVG で背景と枠を描画し、その上にテキストを重ねる
        return (
          <div
            style={{ width: "100%", height: "100%", position: "relative" }}
          >
            <BubbleSvg layer={layer} />
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 4,
                pointerEvents: "none",
              }}
            >
              {renderAnimatedText(
                { ...layer, fillColor: undefined, border: undefined },
                currentTimeSec,
                fontScale ?? 0.25,
              )}
            </div>
          </div>
        );
      }
      return renderAnimatedText(layer, currentTimeSec, fontScale ?? 0.25);
    case "audio":
      return null;
    case "character": {
      // リップシンク候補を決定:
      // - linkedAudioLayerIds 1 件以上 → その音声群だけ
      // - 0 件 (自動)             → テンプレ内の全音声
      // - 旧 linkedAudioLayerId    → [その 1 本] とみなす (後方互換)
      const explicitIds: string[] =
        layer.linkedAudioLayerIds && layer.linkedAudioLayerIds.length > 0
          ? layer.linkedAudioLayerIds
          : layer.linkedAudioLayerId
          ? [layer.linkedAudioLayerId]
          : [];
      let audiosForLipsync: Layer[] = [];
      if (allLayers) {
        if (explicitIds.length > 0) {
          const idSet = new Set(explicitIds);
          audiosForLipsync = allLayers.filter(
            (l) => l.type === "audio" && !l.hidden && idSet.has(l.id),
          );
        } else {
          audiosForLipsync = allLayers.filter(
            (l) => l.type === "audio" && !l.hidden,
          );
        }
      }
      return (
        <LayerErrorBoundary label={`character: ${layer.id}`}>
          <CharacterLayerContent
            layer={layer}
            currentTimeSec={currentTimeSec}
            isPlaying={isPlaying}
            audiosForLipsync={audiosForLipsync}
          />
        </LayerErrorBoundary>
      );
    }
  }
}

/** 吹き出し背景の SVG 描画コンポーネント */
/**
 * 扇形 / ドーナツセグメントを SVG path で描画する（layer.shape === "arc"）。
 * layerComposer.ts の drawArcShape と同じ仕様:
 * - 0° = 真上（12時方向）、時計回り
 * - 半径は box の min(w,h)/2 を 1.0 とする比率
 * - arcInnerRadius = 0 → 扇形（パイ）、> 0 → ドーナツセグメント
 * viewBox は正方形にして preserveAspectRatio="xMidYMid meet" で box の短辺に合わせる。
 */
function ArcShapeSvg({
  layer,
  defaultFill,
  currentTimeSec,
}: {
  layer: Layer;
  defaultFill: string;
  currentTimeSec?: number;
}) {
  const startDeg = layer.arcStart ?? 0;
  const rawEndDeg = layer.arcEnd ?? 360;
  // arc-sweep: 「1 本のペン先が 0° → 360° を一定速度で進む」方式。
  // 全ての arc-sweep layer は同じ startSec / entryDuration を共有し（curio-gen
  // 側の責任）、それぞれが「ペン先が自分の arcStart～arcEnd を通過するとき」
  // だけ徐々に塗られる。layer ごとに別ペンを持つ方式だとセグメント境界で
  // 「前ペン完了 → 次ペン出現」の切替が見えてしまうが、ペン先方式なら
  // ペン先は止まらず色だけが切り替わるのでシームレスに見える。
  let endDeg = rawEndDeg;
  if (layer.entryAnimation === "arc-sweep" && currentTimeSec !== undefined) {
    const entryDur = Math.max(0.01, layer.entryDuration ?? 0.3);
    const entryEnd = layer.startSec + entryDur;
    if (currentTimeSec < entryEnd) {
      const raw = (currentTimeSec - layer.startSec) / entryDur;
      const p = Math.max(0, Math.min(1, raw));
      // ペン先の角度（0° → 360° linear）。自セグ範囲でクランプして effectiveEnd を決める
      const penAngle = p * 360;
      endDeg = Math.max(startDeg, Math.min(rawEndDeg, penAngle));
    }
  }
  const outerScale = layer.arcOuterRadius ?? 1.0;
  const innerScale = layer.arcInnerRadius ?? 0.0;
  const fill = layer.fillColor ?? defaultFill;

  // 100x100 viewBox、中心 (50,50)、最大半径 50
  const cx = 50;
  const cy = 50;
  const maxR = 50;
  const oR = outerScale * maxR;
  const iR = innerScale * maxR;

  // 0° = 12時方向、時計回り → SVG math 角度 = (deg - 90)° 、sin/cos 通常通り
  const toRad = (deg: number) => ((deg - 90) * Math.PI) / 180;
  const sweep = endDeg - startDeg;
  const isFullCircle = Math.abs(sweep) >= 360 - 0.01;
  const largeArc = Math.abs(sweep) > 180 ? 1 : 0;

  let d = "";
  if (isFullCircle) {
    // 完全な円: A コマンドは始点=終点だと描かれないので 2 弧で構成
    if (iR > 0) {
      d =
        `M ${cx + oR},${cy} A ${oR},${oR} 0 1,1 ${cx - oR},${cy} ` +
        `A ${oR},${oR} 0 1,1 ${cx + oR},${cy} Z ` +
        `M ${cx + iR},${cy} A ${iR},${iR} 0 1,0 ${cx - iR},${cy} ` +
        `A ${iR},${iR} 0 1,0 ${cx + iR},${cy} Z`;
    } else {
      d =
        `M ${cx + oR},${cy} A ${oR},${oR} 0 1,1 ${cx - oR},${cy} ` +
        `A ${oR},${oR} 0 1,1 ${cx + oR},${cy} Z`;
    }
  } else {
    const sRad = toRad(startDeg);
    const eRad = toRad(endDeg);
    const sx = cx + oR * Math.cos(sRad);
    const sy = cy + oR * Math.sin(sRad);
    const ex = cx + oR * Math.cos(eRad);
    const ey = cy + oR * Math.sin(eRad);
    if (iR > 0) {
      const isx = cx + iR * Math.cos(sRad);
      const isy = cy + iR * Math.sin(sRad);
      const iex = cx + iR * Math.cos(eRad);
      const iey = cy + iR * Math.sin(eRad);
      d =
        `M ${sx},${sy} A ${oR},${oR} 0 ${largeArc},1 ${ex},${ey} ` +
        `L ${iex},${iey} A ${iR},${iR} 0 ${largeArc},0 ${isx},${isy} Z`;
    } else {
      d =
        `M ${cx},${cy} L ${sx},${sy} ` +
        `A ${oR},${oR} 0 ${largeArc},1 ${ex},${ey} Z`;
    }
  }

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      width="100%"
      height="100%"
      style={{ display: "block" }}
    >
      <path d={d} fill={fill} fillRule="evenodd" />
    </svg>
  );
}

function BubbleSvg({ layer }: { layer: Layer }) {
  const bubble = layer.bubble;
  if (!bubble) return null;
  const d = bubbleFullPath(100, 100, bubble, 12);
  const stroke = layer.border;
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      width="100%"
      height="100%"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        overflow: "visible",
      }}
    >
      <path
        d={d}
        fill={layer.fillColor || "rgba(255,255,255,0.95)"}
        stroke={stroke?.color || "transparent"}
        strokeWidth={stroke && stroke.width > 0 ? stroke.width * 0.5 : 0}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * 吹き出しのしっぽ先端ドラッグハンドル。
 * レイヤー枠内の (tipX%, tipY%) に丸点を表示し、ドラッグで tipX/tipY を更新する。
 */
function TailHandle({
  tipX,
  tipY,
  onChange,
}: {
  tipX: number;
  tipY: number;
  onChange: (x: number, y: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    setDragging(true);
    try {
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    // 可動域は制限なし（キャンバス端までどこへでも伸ばせる）
    onChange(x, y);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    setDragging(false);
    try {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  };
  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        position: "absolute",
        left: `${tipX}%`,
        top: `${tipY}%`,
        width: 14,
        height: 14,
        marginLeft: -7,
        marginTop: -7,
        borderRadius: "50%",
        background: dragging ? "#2563EB" : "#3B82F6",
        border: "2px solid white",
        cursor: "move",
        zIndex: 100,
        boxShadow: "0 0 4px rgba(0,0,0,0.5)",
      }}
      title="しっぽの先端位置（ドラッグで移動）"
    />
  );
}

/**
 * テキスト / コメントレイヤーを、文字単位アニメ・単語キネティック・装飾付きで描画する。
 * fontScale は プレビュー時等に縮小表示する場合の係数（キャンバス 1.0 / プレビュー 0.25 等）
 */
export function renderAnimatedText(
  layer: Layer,
  currentTimeSec: number,
  fontScale: number = 1,
): React.ReactNode {
  const text = layer.text ?? "テキスト";
  const baseFontSize = Math.max(8, (layer.fontSize ?? 48) * fontScale);
  const localTime = currentTimeSec - layer.startSec;
  const layerDur = Math.max(0.1, layer.endSec - layer.startSec);

  // fillColor 背景がある場合、inset box-shadow（innerStyle 側）が背景に隠れるため
  // border をここのコンテナに直接適用する
  // layerComposer と同じスケール（fontScale = canvasWPx/360）で太さを合わせる
  const borderBoxShadow = layer.border
    ? `inset 0 0 0 ${(layer.border.width * fontScale).toFixed(2)}px ${layer.border.color}`
    : undefined;

  const baseStyle: React.CSSProperties = {
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: layer.fillColor ?? "transparent",
    color: layer.fontColor ?? "#fff",
    fontSize: baseFontSize,
    padding: 4,
    textAlign: "center",
    fontWeight: "bold",
    wordBreak: "break-word",
    whiteSpace: "pre-wrap",
    overflow: "hidden",
    position: "relative",
    boxShadow: borderBoxShadow,
    fontFamily: layer.fontFamily
      ? `${layer.fontFamily}, ${TEXT_DEFAULT_FONT_STACK}`
      : TEXT_DEFAULT_FONT_STACK,
  };

  // 装飾：ネオン / アウトライン / 影ドロップ は text-shadow / -webkit-text-stroke で表現
  const decoration = layer.textDecoration ?? "none";
  const textStyleExtra: React.CSSProperties = {};

  // ユーザー設定の文字縁取り（textDecoration が none 系のときに適用。シャドウ/アウトライン装飾時はそちらを優先）
  const userOutlineWidth = layer.textOutlineWidth ?? 0;
  const userOutlineColor = layer.textOutlineColor ?? "#000000";
  if (
    userOutlineWidth > 0 &&
    decoration !== "outline-reveal" &&
    decoration !== "neon"
  ) {
    const scaledStroke = userOutlineWidth * fontScale;
    textStyleExtra.WebkitTextStroke = `${scaledStroke.toFixed(2)}px ${userOutlineColor}`;
    textStyleExtra.paintOrder = "stroke fill";
  }

  if (decoration === "neon") {
    // export (drawAnimatedToken/drawText) は白文字を #ffe600 に置換し、
    // 文字本体も glow も neon 色で描く。preview もそれに揃える
    // （白の text-shadow は背景次第で見えず不一致になるため）。
    const color =
      !layer.fontColor || layer.fontColor === "#fff" ? "#ffe600" : layer.fontColor;
    textStyleExtra.color = color;
    textStyleExtra.textShadow = `0 0 4px ${color}, 0 0 8px ${color}, 0 0 16px ${color}`;
  } else if (decoration === "outline-reveal") {
    // 時間に応じて stroke 幅を 0→3 に
    const strokeP = Math.min(1, localTime / Math.max(0.01, layer.entryDuration ?? 0.3));
    textStyleExtra.WebkitTextStroke = `${(strokeP * 3).toFixed(2)}px ${layer.fontColor ?? "#fff"}`;
    textStyleExtra.WebkitTextFillColor = "transparent";
  } else if (decoration === "shadow-drop") {
    const entryDur = Math.max(0.01, layer.entryDuration ?? 0.3);
    const p = Math.min(1, Math.max(0, localTime / entryDur));
    const dx = (1 - p) * -6 + p * 4;
    const dy = (1 - p) * -6 + p * 4;
    textStyleExtra.textShadow = `${dx.toFixed(1)}px ${dy.toFixed(1)}px 0 rgba(0,0,0,0.6)`;
  }

  // 描画ノード（本文部分）
  let contentNode: React.ReactNode;

  const kinetic = layer.kineticAnimation ?? "none";
  const charAnim = layer.charAnimation ?? "none";

  if (kinetic !== "none") {
    contentNode = renderKineticText(layer, text, localTime, layerDur);
  } else if (charAnim !== "none") {
    contentNode = renderCharAnimatedText(layer, text, localTime);
  } else {
    contentNode = text;
  }

  return (
    <div style={baseStyle}>
      {/* 装飾レイヤー（背景系） */}
      {decoration === "highlight-bar" && (
        <HighlightBar layer={layer} localTime={localTime} />
      )}
      {decoration === "underline-sweep" && (
        <UnderlineSweep layer={layer} localTime={localTime} />
      )}
      <span style={{ position: "relative", ...textStyleExtra }}>
        {contentNode}
      </span>
    </div>
  );
}

function HighlightBar({ layer, localTime }: { layer: Layer; localTime: number }) {
  const entryDur = Math.max(0.01, layer.entryDuration ?? 0.3);
  const p = Math.min(1, Math.max(0, localTime / entryDur));
  return (
    <div
      style={{
        position: "absolute",
        top: "10%",
        bottom: "10%",
        left: "5%",
        width: `${p * 90}%`,
        background: "rgba(255, 220, 0, 0.85)",
        zIndex: 0,
        transition: "none",
      }}
    />
  );
}

function UnderlineSweep({
  layer,
  localTime,
}: {
  layer: Layer;
  localTime: number;
}) {
  const entryDur = Math.max(0.01, layer.entryDuration ?? 0.3);
  const p = Math.min(1, Math.max(0, localTime / entryDur));
  return (
    <div
      style={{
        position: "absolute",
        bottom: "12%",
        left: "5%",
        width: `${p * 90}%`,
        height: 3,
        background: layer.fontColor ?? "#fff",
        zIndex: 0,
      }}
    />
  );
}

function renderCharAnimatedText(
  layer: Layer,
  text: string,
  localTime: number,
): React.ReactNode {
  const anim = layer.charAnimation ?? "none";
  const chars = Array.from(text);
  return (
    <span style={{ display: "inline-block" }}>
      {chars.map((ch, i) => {
        const style: React.CSSProperties = {
          display: "inline-block",
          whiteSpace: "pre",
        };
        switch (anim) {
          case "typewriter": {
            // 80ms per char
            const appearAt = i * 0.08;
            style.opacity = localTime >= appearAt ? 1 : 0;
            break;
          }
          case "stagger-fade": {
            const appearAt = i * 0.05;
            const p = Math.min(1, Math.max(0, (localTime - appearAt) / 0.3));
            style.opacity = p;
            style.transform = `translateY(${(1 - p) * 6}px)`;
            break;
          }
          case "wave": {
            const dy = Math.sin(localTime * Math.PI * 2 + i * 0.35) * 4;
            style.transform = `translateY(${dy.toFixed(2)}px)`;
            break;
          }
          case "color-shift": {
            style.color = `hsl(${(i * 30) % 360}, 100%, 60%)`;
            break;
          }
        }
        return (
          <span key={i} style={style}>
            {ch}
          </span>
        );
      })}
    </span>
  );
}

function renderKineticText(
  layer: Layer,
  text: string,
  localTime: number,
  _layerDur: number,
): React.ReactNode {
  const kinetic = layer.kineticAnimation ?? "none";
  const words = text.split(/(\s+)/); // スペースを保ったまま分割
  return (
    <span style={{ display: "inline-block" }}>
      {words.map((w, i) => {
        if (/^\s+$/.test(w)) return <span key={i}>{w}</span>;
        const style: React.CSSProperties = {
          display: "inline-block",
          whiteSpace: "pre",
        };
        const appearAt = i * 0.2;
        const p = Math.min(1, Math.max(0, (localTime - appearAt) / 0.3));
        switch (kinetic) {
          case "word-pop": {
            // easeOutBack
            const c1 = 1.70158;
            const c3 = c1 + 1;
            const eb = p === 0 ? 0 : 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
            style.transform = `scale(${Math.max(0.001, eb)})`;
            style.opacity = p > 0 ? 1 : 0;
            break;
          }
          case "keyword-color": {
            // i 番目が偶数ならベース、奇数なら keywordColor
            style.opacity = p;
            style.transform = `translateY(${(1 - p) * 6}px)`;
            if (i % 2 === 1) {
              style.color = layer.keywordColor ?? "#ffe600";
            }
            break;
          }
          case "slide-stack": {
            style.opacity = p;
            style.transform = `translateY(${(1 - p) * -16}px)`;
            break;
          }
          case "zoom-talk": {
            const zoom = p < 0.5 ? 1 + p * 0.6 : 1 + (1 - p) * 0.6;
            style.transform = `scale(${zoom.toFixed(3)})`;
            style.opacity = p > 0 ? 1 : 0;
            break;
          }
        }
        return (
          <span key={i} style={style}>
            {w}
          </span>
        );
      })}
    </span>
  );
}

/**
 * 入退場アニメーションを現在時刻に基づいて計算する。
 * 戻り値は opacity(0..1) と transform 文字列（scale/translate/rotate）、filter 文字列
 */
export function computeLayerAnimStyle(
  layer: Layer,
  currentTimeSec: number,
): { opacity: number; transform: string; filter: string; transformOrigin?: string } {
  const entryAnim = layer.entryAnimation ?? "none";
  const exitAnim = layer.exitAnimation ?? "none";
  const entryDur = Math.max(0.01, layer.entryDuration ?? 0.3);
  const exitDur = Math.max(0.01, layer.exitDuration ?? 0.3);
  const entryEnd = layer.startSec + entryDur;
  const exitStart = layer.endSec - exitDur;

  let opacity = 1;
  let transformOrigin: string | undefined;
  const parts: string[] = [];
  const filters: string[] = [];

  // ---- 入場 ----
  if (entryAnim !== "none" && currentTimeSec < entryEnd) {
    const raw = (currentTimeSec - layer.startSec) / entryDur;
    const p = Math.max(0, Math.min(1, raw));
    // ease-out (1 - (1-p)^2)
    const e = 1 - Math.pow(1 - p, 2);
    switch (entryAnim) {
      case "fade":
        opacity *= e;
        break;
      case "slide-left":
        parts.push(`translateX(${(1 - e) * -100}%)`);
        break;
      case "slide-right":
        parts.push(`translateX(${(1 - e) * 100}%)`);
        break;
      case "slide-up":
        parts.push(`translateY(${(1 - e) * 100}%)`);
        break;
      case "slide-down":
        parts.push(`translateY(${(1 - e) * -100}%)`);
        break;
      case "zoom-in":
        parts.push(`scale(${Math.max(0.001, e)})`);
        break;
      case "pop": {
        const c1 = 1.70158;
        const c3 = c1 + 1;
        const eb = 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
        parts.push(`scale(${Math.max(0.001, eb)})`);
        break;
      }
      case "blur-in": {
        const b = (1 - e) * 20;
        filters.push(`blur(${b.toFixed(2)}px)`);
        opacity *= e;
        break;
      }
      case "elastic-pop": {
        // easeOutElastic
        const c4 = (2 * Math.PI) / 3;
        const el =
          p === 0 ? 0 : p === 1 ? 1 : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * c4) + 1;
        parts.push(`scale(${Math.max(0.001, el)})`);
        opacity *= e;
        break;
      }
      case "flip-in":
        parts.push(`perspective(500px) rotateY(${(1 - e) * 90}deg)`);
        opacity *= e;
        break;
      case "stretch-in":
        parts.push(`scaleX(${Math.max(0.001, e)})`);
        opacity *= e;
        break;
      case "roll-in":
        parts.push(`translateX(${(1 - e) * -100}%) rotate(${(1 - e) * -180}deg)`);
        opacity *= e;
        break;
      // 「ちゃんと伸びる」: opacity を維持して端から伸ばす。棒グラフ用
      case "grow-up":
        parts.push(`scaleY(${Math.max(0.001, e)})`);
        transformOrigin = "center bottom";
        break;
      case "grow-down":
        parts.push(`scaleY(${Math.max(0.001, e)})`);
        transformOrigin = "center top";
        break;
      case "grow-right":
        parts.push(`scaleX(${Math.max(0.001, e)})`);
        transformOrigin = "left center";
        break;
      case "grow-left":
        parts.push(`scaleX(${Math.max(0.001, e)})`);
        transformOrigin = "right center";
        break;
      case "arc-sweep":
        // ArcShapeSvg 側で arcEnd を時間補間するため、ここでは transform を触らない。
        // entry 中も opacity 1.0 維持で「描かれていく」ように見せる。
        break;
    }
  }

  // ---- 退場 ----
  if (exitAnim !== "none" && currentTimeSec >= exitStart) {
    const raw = (currentTimeSec - exitStart) / exitDur;
    const p = Math.max(0, Math.min(1, raw));
    // ease-in (p^2)
    const e = p * p;
    switch (exitAnim) {
      case "fade":
        opacity *= 1 - e;
        break;
      case "slide-left":
        parts.push(`translateX(${e * -100}%)`);
        break;
      case "slide-right":
        parts.push(`translateX(${e * 100}%)`);
        break;
      case "slide-up":
        parts.push(`translateY(${e * -100}%)`);
        break;
      case "slide-down":
        parts.push(`translateY(${e * 100}%)`);
        break;
      case "zoom-out":
        parts.push(`scale(${Math.max(0.001, 1 - e)})`);
        break;
      case "blur-out":
        filters.push(`blur(${(e * 20).toFixed(2)}px)`);
        opacity *= 1 - e;
        break;
      case "flip-out":
        parts.push(`perspective(500px) rotateY(${e * 90}deg)`);
        opacity *= 1 - e;
        break;
      case "stretch-out":
        parts.push(`scaleX(${Math.max(0.001, 1 - e)})`);
        opacity *= 1 - e;
        break;
      case "roll-out":
        parts.push(`translateX(${e * 100}%) rotate(${e * 180}deg)`);
        opacity *= 1 - e;
        break;
    }
  }

  return {
    opacity,
    transform: parts.join(" "),
    filter: filters.join(" "),
    transformOrigin,
  };
}

/**
 * Ambient（表示中ずっと続くアニメ）の transform / filter / opacity を計算
 */
export function computeLayerAmbientStyle(
  layer: Layer,
  currentTimeSec: number,
  // ambient の絶対 px 振幅 (shake/bounce/float/glow) を design 基準(360)から
  // プレビュー描画解像度へ換算する係数 = canvasWPx/360 (= fontScale)。
  // export 側 computeCanvasAnim の pxScale (FINAL_W/360) と一致させる。
  pxScale = 1,
): { opacity: number; transform: string; filter: string } {
  const amb = layer.ambientAnimation ?? "none";
  if (amb === "none") return { opacity: 1, transform: "", filter: "" };
  const k = Math.max(0, Math.min(2, layer.ambientIntensity ?? 1));
  const t = currentTimeSec;
  const parts: string[] = [];
  const filters: string[] = [];
  let opacity = 1;
  switch (amb) {
    case "pulse": {
      const s = 1 + 0.05 * k * Math.sin(t * Math.PI * 2);
      parts.push(`scale(${s.toFixed(4)})`);
      break;
    }
    case "shake": {
      const x = Math.sin(t * 30) * 2 * k * pxScale;
      const y = Math.cos(t * 33) * 1.5 * k * pxScale;
      parts.push(`translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`);
      break;
    }
    case "wiggle": {
      const r = Math.sin(t * Math.PI * 2) * 2 * k;
      parts.push(`rotate(${r.toFixed(2)}deg)`);
      break;
    }
    case "bounce": {
      const y = -Math.abs(Math.sin(t * Math.PI * 2)) * 4 * k * pxScale;
      parts.push(`translateY(${y.toFixed(2)}px)`);
      break;
    }
    case "blink": {
      opacity = Math.sin(t * Math.PI * 4) > 0 ? 1 : 0.3 + 0.7 * (1 - k);
      break;
    }
    case "glow-pulse": {
      const g = (4 + Math.sin(t * Math.PI * 2) * 4 * k) * pxScale;
      filters.push(`drop-shadow(0 0 ${g.toFixed(1)}px rgba(255,230,0,0.9))`);
      break;
    }
    case "rainbow": {
      const hue = (t * 60) % 360;
      filters.push(`hue-rotate(${hue.toFixed(0)}deg)`);
      break;
    }
    case "float": {
      const y = Math.sin(t * Math.PI) * 3 * k * pxScale;
      parts.push(`translateY(${y.toFixed(2)}px)`);
      break;
    }
  }
  return { opacity, transform: parts.join(" "), filter: filters.join(" ") };
}

/**
 * Motion フィルタ (zoom/pan/ken_burns 等) を CSS transform で表現する。
 * レイヤーの可視期間 [startSec, endSec] の進捗 0..1 に応じて計算。
 */
export function computeLayerMotionTransform(
  layer: Layer,
  currentTimeSec: number,
): string {
  const motion = layer.motion;
  if (!motion || motion === "static") return "";

  const dur = Math.max(0.01, layer.endSec - layer.startSec);
  const tRaw = (currentTimeSec - layer.startSec) / dur;
  const t = Math.max(0, Math.min(1, tRaw));

  switch (motion) {
    case "zoom_in":
      return `scale(${1 + 0.2 * t})`;
    case "zoom_out":
      return `scale(${1.2 - 0.2 * t})`;
    case "pan_left":
      // コンテンツを拡大してから横方向に流す
      return `scale(1.15) translateX(${(0.5 - t) * 8}%)`;
    case "pan_right":
      return `scale(1.15) translateX(${(t - 0.5) * 8}%)`;
    case "pan_up":
      return `scale(1.15) translateY(${(0.5 - t) * 8}%)`;
    case "pan_down":
      return `scale(1.15) translateY(${(t - 0.5) * 8}%)`;
    case "ken_burns":
      return `scale(${1 + 0.15 * t}) translate(${(t - 0.5) * 4}%, ${(t - 0.5) * 4}%)`;
    case "push_in":
      return `scale(${1 + 0.25 * t * t})`;
    case "zoom_punch": {
      // 序盤に一瞬膨らむパルス
      const phase = Math.min(1, tRaw * 3);
      const pulse = Math.sin(phase * Math.PI) * 0.1;
      return `scale(${1 + pulse})`;
    }
    case "shake": {
      const f = currentTimeSec * 30;
      const x = Math.sin(f) * 0.5;
      const y = Math.cos(f * 1.3) * 0.5;
      return `translate(${x}%, ${y}%)`;
    }
    default:
      return "";
  }
}

/** 音声レイヤーを <audio> で playhead 同期再生（視覚表示なし） */
function AudioLayerPlayer({
  layer,
  currentTimeSec,
  isPlaying,
  allLayers = [],
}: {
  layer: Layer;
  currentTimeSec: number;
  isPlaying: boolean;
  allLayers?: Layer[];
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  // HTMLAudioElement.volume は 0..1 にクランプされるため、100% 超のボリュームは
  // Web Audio API の GainNode 経由で実現する（エクスポート側 ffmpeg `volume=` と一致させる）。
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const resolved = resolveSrcForWebview(layer.source);

  // Web Audio グラフを必要時に一度だけ構築（autoplay policy 対策で suspended の可能性あり）
  const ensureAudioGraph = (): GainNode | null => {
    if (gainNodeRef.current) return gainNodeRef.current;
    const a = audioRef.current;
    if (!a) return null;
    const AC: typeof AudioContext | undefined =
      (window as unknown as { AudioContext?: typeof AudioContext })
        .AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return null;
    try {
      const ctx = new AC();
      const source = ctx.createMediaElementSource(a);
      const gain = ctx.createGain();
      gain.gain.value = layer.volume ?? 1;
      source.connect(gain);
      gain.connect(ctx.destination);
      audioCtxRef.current = ctx;
      sourceNodeRef.current = source;
      gainNodeRef.current = gain;
      return gain;
    } catch {
      return null;
    }
  };

  // アンマウント時に Web Audio グラフを片付け
  useEffect(() => {
    return () => {
      try {
        gainNodeRef.current?.disconnect();
        sourceNodeRef.current?.disconnect();
        audioCtxRef.current?.close().catch(() => {});
      } catch {
        /* noop */
      }
      gainNodeRef.current = null;
      sourceNodeRef.current = null;
      audioCtxRef.current = null;
    };
  }, []);

  // currentTime を同期（scrub 中 / 再生停止中の追従）
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const rate = Math.max(0.05, Math.min(4, layer.playbackRate ?? 1));
    let target = (currentTimeSec - layer.startSec) * rate;
    const dur = a.duration;
    if (layer.audioLoop && dur && isFinite(dur) && target > dur) {
      target = target % dur;
    }
    if (target < 0) target = 0;
    if (Math.abs(a.currentTime - target) > 0.15) {
      try {
        a.currentTime = target;
      } catch {
        /* noop */
      }
    }
  }, [currentTimeSec, layer.startSec, layer.audioLoop, layer.playbackRate]);

  // 音量（GainNode 経由で 0..1 制約を回避してフェードを反映）
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const base = layer.volume ?? 1;
    const fadeIn = layer.audioFadeIn ?? 0;
    const fadeOut = layer.audioFadeOut ?? 0;
    const inLayer = currentTimeSec - layer.startSec;
    const toEnd = layer.endSec - currentTimeSec;
    let gain = base;
    if (fadeIn > 0 && inLayer < fadeIn) {
      gain *= Math.max(0, Math.min(1, inLayer / fadeIn));
    }
    if (fadeOut > 0 && toEnd < fadeOut) {
      gain *= Math.max(0, Math.min(1, toEnd / fadeOut));
    }
    // ダッキング: duckBy の layer が鳴っている時間帯は volume を下げる
    // （fade とは独立に積算）。export 側 mixAudioLayers と同じ computeDuckMultiplier を共有。
    gain *= computeDuckMultiplier(layer, allLayers, currentTimeSec);
    const volumeFinal = Math.max(0, gain);
    // 0..1 の通常音量は HTMLAudioElement 直結で鳴らす（Web Audio に通すと
    // AudioContext が suspended のままだと無音になる事故が起きるため）。
    // 100% 超が必要なときだけ Web Audio グラフを構築する。一度グラフを作ると
    // 要素出力は恒久的に Web Audio 経由になるので、既存グラフがある場合も Web Audio を使う。
    const needsWebAudio = volumeFinal > 1 || gainNodeRef.current != null;
    const gainNode = needsWebAudio ? ensureAudioGraph() : null;
    if (gainNode) {
      // Web Audio 経路: GainNode で実音量、HTMLAudioElement.volume は素通し
      gainNode.gain.value = volumeFinal;
      a.volume = 1;
      a.muted = volumeFinal === 0;
    } else {
      // 通常経路 / フォールバック: 0..1 にクランプして HTMLAudioElement に直接
      const clamped = Math.min(1, volumeFinal);
      a.volume = clamped;
      a.muted = clamped === 0;
    }
  }, [
    currentTimeSec,
    layer.volume,
    layer.audioFadeIn,
    layer.audioFadeOut,
    layer.startSec,
    layer.endSec,
    layer.id,
    layer.duckBy,
    layer.duckAmount,
    layer.duckAttackMs,
    layer.duckReleaseMs,
    allLayers,
  ]);

  // 再生速度
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const rate = Math.max(0.05, Math.min(4, layer.playbackRate ?? 1));
    a.playbackRate = rate;
    a.defaultPlaybackRate = rate;
  }, [layer.playbackRate, layer.id]);

  // play/pause（再生開始時に再生速度も再適用 — メタデータ読み込み前に設定したものが
  // ロード完了で 1.0 にリセットされるブラウザ実装の対策）
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (isPlaying) {
      // Web Audio グラフを既に構築済み（volume>1）の場合のみ resume。
      // autoplay policy で suspended になっている可能性があるため。
      // 通常音量レイヤーは直結なのでグラフを作らない（無音事故防止）。
      if (gainNodeRef.current) {
        audioCtxRef.current?.resume().catch(() => {});
      }
      const rate = Math.max(0.05, Math.min(4, layer.playbackRate ?? 1));
      a.playbackRate = rate;
      a.play()
        .then(() => {
          // play() 後にも再度設定（一部ブラウザは play で rate を 1 にリセットする）
          a.playbackRate = rate;
        })
        .catch(() => {
          /* autoplay 制約で失敗する可能性 */
        });
    } else {
      a.pause();
    }
  }, [isPlaying, layer.playbackRate]);

  if (!resolved) return null;

  return (
    <audio
      ref={audioRef}
      src={resolved}
      preload="auto"
      loop={!!layer.audioLoop}
      onLoadedMetadata={() => {
        const a = audioRef.current;
        if (!a) return;
        const rate = Math.max(0.05, Math.min(4, layer.playbackRate ?? 1));
        a.playbackRate = rate;
      }}
      style={{ display: "none" }}
    />
  );
}

/** 動画レイヤーを <video> として描画し、プレイヘッドと同期再生する */
function VideoLayerContent({
  layer,
  currentTimeSec,
  isPlaying,
}: {
  layer: Layer;
  currentTimeSec: number;
  isPlaying: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const resolved = resolveSrcForWebview(layer.source);

  // プレイヘッドが飛んだ / 停止中のスクラブで currentTime を同期
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const rate = Math.max(0.05, Math.min(4, layer.playbackRate ?? 1));
    let target = Math.max(0, (currentTimeSec - layer.startSec) * rate);
    // ループ ON で素材尺を超えたら、剰余を取って素材内に折り返す
    const loop = (layer.videoLoop ?? true) === true;
    const dur = v.duration;
    if (loop && dur && isFinite(dur) && dur > 0 && target > dur) {
      target = target % dur;
    }
    if (isFinite(target) && Math.abs(v.currentTime - target) > 0.15) {
      try {
        v.currentTime = target;
      } catch {
        // seek 前に metadata 未ロードの場合があるが、loadedmetadata で再設定される
      }
    }
  }, [currentTimeSec, layer.startSec, layer.playbackRate, layer.videoLoop]);

  // isPlaying に応じて play/pause
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (isPlaying) {
      v.play().catch(() => {
        /* user gesture 要件などで失敗する可能性あり。無視 */
      });
    } else {
      v.pause();
    }
  }, [isPlaying]);

  // 再生速度（video レイヤーでも音声と同じく playbackRate を反映）
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const rate = layer.playbackRate ?? 1;
    v.playbackRate = Math.max(0.05, Math.min(4, rate));
  }, [layer.playbackRate]);

  // src 変更時にメタデータロード後 seek を即反映
  const handleLoadedMetadata = () => {
    const v = videoRef.current;
    if (!v) return;
    const target = Math.max(0, currentTimeSec - layer.startSec);
    if (isFinite(target)) {
      try {
        v.currentTime = target;
      } catch {
        /* noop */
      }
    }
  };

  if (!resolved) {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          background:
            "repeating-linear-gradient(135deg, #222, #222 8px, #333 8px, #333 16px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#999",
          fontSize: 10,
        }}
      >
        🎬 動画(未設定)
      </div>
    );
  }

  // crop 対応（image と同じ「overflow:hidden + 子要素を拡大＆ネガオフセット」方式）
  const crop = layer.crop;
  const cw = crop ? Math.max(1, crop.width) : 100;
  const ch = crop ? Math.max(1, crop.height) : 100;
  const cx = crop ? crop.x : 0;
  const cy = crop ? crop.y : 0;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <video
        ref={videoRef}
        src={resolved}
        muted
        playsInline
        preload="auto"
        loop={(layer.videoLoop ?? true) === true}
        onLoadedMetadata={handleLoadedMetadata}
        style={{
          position: "absolute",
          width: `${(100 * 100) / cw}%`,
          height: `${(100 * 100) / ch}%`,
          top: `${(-cy * 100) / ch}%`,
          left: `${(-cx * 100) / cw}%`,
          objectFit: "cover",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
