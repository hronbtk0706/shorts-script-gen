import { useEffect, useRef, useState } from "react";
import Moveable from "react-moveable";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ColorGrade, Layer, TemplateSegment } from "../types";
import { sortedLayers } from "../lib/layerUtils";

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
  /** セグメント一覧（Color グレード / トランジション算出用） */
  segments?: TemplateSegment[];
}

/** 9:16 仮想キャンバスの最大サイズ。親幅／ビューポート高さに応じて拡縮 */
const CANVAS_MAX_W_PX = 720;
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
  segments = [],
}: Props) {
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
    h: Math.round((initW * 16) / 9),
  });

  // 親要素の実サイズ（flex レイアウトで決定）に合わせて 9:16 を維持して拡縮
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
      const wByHeight = (availH * 9) / 16;
      const w = Math.max(
        CANVAS_MIN_W_PX,
        Math.min(CANVAS_MAX_W_PX, wByWidth, wByHeight),
      );
      const h = Math.round((w * 16) / 9);
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
  }, []);

  const CANVAS_W_PX = canvasSize.w;
  const CANVAS_H_PX = canvasSize.h;

  // 現在のセグメントから色効果を計算
  const colorEffects = computeSegmentColorEffects(segments, currentTimeSec ?? 0);
  // セグメント境界のトランジション表示
  const transitionOverlay = computeSegmentTransitionOverlay(
    segments,
    currentTimeSec ?? 0,
  );

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
      {sortedLayers(layers)
        .filter(
          (layer) =>
            isInTime(layer) && !layer.hidden && layer.type !== "audio",
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
            cssFilter={colorEffects.cssFilter}
            onSelect={(modifier) => onLayerSelect(layer.id, modifier)}
            onRefReady={(el) => {
              if (layer.id === selectedLayerId) {
                targetRef.current = el;
                forceRerender((n) => n + 1);
              }
            }}
          />
        ))}

      {colorEffects.vignette && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            zIndex: 9000,
            background:
              "radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.55) 100%)",
          }}
        />
      )}

      {/* 音声レイヤー（視覚なし、<audio> を playhead 同期） */}
      {layers
        .filter((l) => l.type === "audio" && !l.hidden && isInTime(l))
        .map((layer) => (
          <AudioLayerPlayer
            key={layer.id}
            layer={layer}
            currentTimeSec={currentTimeSec ?? 0}
            isPlaying={isPlaying}
          />
        ))}

      {transitionOverlay && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            zIndex: 9500,
            background: transitionOverlay.color,
            opacity: transitionOverlay.alpha,
          }}
        />
      )}

      {selected && targetRef.current && (
        <Moveable
          // レイヤーの位置/サイズが変わるたびに Moveable を作り直して内部状態を同期
          key={`mv_${selected.id}_${selected.x.toFixed(2)}_${selected.y.toFixed(2)}_${selected.width.toFixed(2)}_${selected.height.toFixed(2)}_${selected.rotation ?? 0}`}
          target={targetRef.current}
          draggable
          resizable
          rotatable
          origin={false}
          keepRatio={false}
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
  onSelect: (modifier?: "shift" | "ctrl" | null) => void;
  onRefReady: (el: HTMLDivElement | null) => void;
}

function LayerView({
  layer,
  isSelected,
  isPrimary = false,
  dimmed = false,
  canvasWPx,
  canvasHPx,
  currentTimeSec,
  isPlaying,
  cssFilter,
  onSelect,
  onRefReady,
}: LayerViewProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isSelected) onRefReady(ref.current);
  }, [isSelected, onRefReady]);

  const leftPx = (layer.x / 100) * canvasWPx;
  const topPx = (layer.y / 100) * canvasHPx;
  const widthPx = (layer.width / 100) * canvasWPx;
  const heightPx = (layer.height / 100) * canvasHPx;

  // 形状の borderRadius。外側（クリップ）と内側（border 描画）で共有する
  let borderRadius: string | number | undefined;
  if (layer.shape === "circle") {
    borderRadius = "50%";
  } else if (layer.shape === "rounded") {
    borderRadius = layer.borderRadius ?? 12;
  }

  const outerStyle: React.CSSProperties = {};
  if (borderRadius !== undefined) outerStyle.borderRadius = borderRadius;

  const baseOpacity = layer.opacity ?? 1;
  // 入退場アニメ / motion / ambient は内側ラッパーに集約して Moveable の外側矩形を安定させる
  const anim = computeLayerAnimStyle(layer, currentTimeSec);
  const ambient = computeLayerAmbientStyle(layer, currentTimeSec);
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
    overflow: "hidden",
    zIndex: layer.zIndex,
    ...outerStyle,
  };

  const inner = renderLayerContent(layer, currentTimeSec, isPlaying);
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

  // border を内側に inset box-shadow で描画 → アニメと一緒に動く
  const innerBoxShadow = layer.border
    ? `inset 0 0 0 ${layer.border.width}px ${layer.border.color}`
    : undefined;

  const innerStyle: React.CSSProperties = {
    width: "100%",
    height: "100%",
    borderRadius,
    boxShadow: innerBoxShadow,
    transform: innerTransform || undefined,
    transformOrigin: "center center",
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
    >
      <div style={innerStyle}>{inner}</div>
    </div>
  );
}

function renderLayerContent(
  layer: Layer,
  currentTimeSec: number,
  isPlaying: boolean,
): React.ReactNode {
  switch (layer.type) {
    case "color":
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
      return (
        <div
          style={{
            width: "100%",
            height: "100%",
            background: resolved
              ? `url("${resolved}") center/cover no-repeat`
              : `repeating-linear-gradient(45deg, #444, #444 8px, #555 8px, #555 16px)`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#999",
            fontSize: 10,
          }}
        >
          {!resolved && layer.source === "auto" && "🖼 画像(自動生成)"}
          {!resolved && (!layer.source || layer.source === "user") && "🖼 画像(未設定)"}
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
      return renderAnimatedText(layer, currentTimeSec, 0.25);
    case "audio":
      return null;
  }
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
  };

  // 装飾：ネオン / アウトライン / 影ドロップ は text-shadow / -webkit-text-stroke で表現
  const decoration = layer.textDecoration ?? "none";
  const textStyleExtra: React.CSSProperties = {};
  if (decoration === "neon") {
    const color = layer.fontColor ?? "#ffe600";
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
): { opacity: number; transform: string; filter: string } {
  const entryAnim = layer.entryAnimation ?? "none";
  const exitAnim = layer.exitAnimation ?? "none";
  const entryDur = Math.max(0.01, layer.entryDuration ?? 0.3);
  const exitDur = Math.max(0.01, layer.exitDuration ?? 0.3);
  const entryEnd = layer.startSec + entryDur;
  const exitStart = layer.endSec - exitDur;

  let opacity = 1;
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
  };
}

/**
 * Ambient（表示中ずっと続くアニメ）の transform / filter / opacity を計算
 */
export function computeLayerAmbientStyle(
  layer: Layer,
  currentTimeSec: number,
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
      const x = Math.sin(t * 30) * 2 * k;
      const y = Math.cos(t * 33) * 1.5 * k;
      parts.push(`translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`);
      break;
    }
    case "wiggle": {
      const r = Math.sin(t * Math.PI * 2) * 2 * k;
      parts.push(`rotate(${r.toFixed(2)}deg)`);
      break;
    }
    case "bounce": {
      const y = -Math.abs(Math.sin(t * Math.PI * 2)) * 4 * k;
      parts.push(`translateY(${y.toFixed(2)}px)`);
      break;
    }
    case "blink": {
      opacity = Math.sin(t * Math.PI * 4) > 0 ? 1 : 0.3 + 0.7 * (1 - k);
      break;
    }
    case "glow-pulse": {
      const g = 4 + Math.sin(t * Math.PI * 2) * 4 * k;
      filters.push(`drop-shadow(0 0 ${g.toFixed(1)}px rgba(255,230,0,0.9))`);
      break;
    }
    case "rainbow": {
      const hue = (t * 60) % 360;
      filters.push(`hue-rotate(${hue.toFixed(0)}deg)`);
      break;
    }
    case "float": {
      const y = Math.sin(t * Math.PI) * 3 * k;
      parts.push(`translateY(${y.toFixed(2)}px)`);
      break;
    }
  }
  return { opacity, transform: parts.join(" "), filter: filters.join(" ") };
}

/**
 * セグメント境界のトランジション (fade/fadeblack/fadewhite/flash) を
 * CSS オーバーレイ情報に変換する。該当なしなら null。
 */
function computeSegmentTransitionOverlay(
  segments: TemplateSegment[],
  currentTimeSec: number,
): { color: string; alpha: number } | null {
  const current = segments.find(
    (s) => currentTimeSec >= s.startSec && currentTimeSec < s.endSec,
  );
  if (!current) return null;
  const transType = current.transitionTo ?? "cut";
  const dur = current.transitionDuration ?? 0;
  if (transType === "cut" || dur <= 0) return null;

  const timeUntilEnd = current.endSec - currentTimeSec;
  if (timeUntilEnd > dur) return null;

  const p = Math.max(0, Math.min(1, 1 - timeUntilEnd / dur));

  switch (transType) {
    case "fade":
    case "dissolve":
    case "fadegrays":
      return { color: "#000", alpha: p * 0.5 };
    case "fadeblack":
      return { color: "#000", alpha: p };
    case "fadewhite":
      return { color: "#fff", alpha: p };
    case "flash": {
      const peak = 1 - Math.abs(p - 0.5) * 2;
      return { color: "#fff", alpha: peak };
    }
    default:
      // 未対応のトランジションは表示しない（タイムライン上の印で判別してもらう）
      return null;
  }
}

/**
 * セグメントの ColorGrade を CSS filter + オプションの vignette オーバーレイに変換する。
 */
function computeSegmentColorEffects(
  segments: TemplateSegment[],
  currentTimeSec: number,
): { cssFilter: string; vignette: boolean } {
  const seg = segments.find(
    (s) => currentTimeSec >= s.startSec && currentTimeSec < s.endSec,
  );
  const color: ColorGrade = seg?.color ?? "none";
  switch (color) {
    case "none":
      return { cssFilter: "", vignette: false };
    case "sepia":
      return { cssFilter: "sepia(1)", vignette: false };
    case "bw":
      return { cssFilter: "grayscale(1)", vignette: false };
    case "vintage":
      return {
        cssFilter: "sepia(0.4) contrast(0.85) saturate(0.7)",
        vignette: false,
      };
    case "vivid":
      return { cssFilter: "saturate(1.5) contrast(1.1)", vignette: false };
    case "cool":
      return {
        cssFilter: "hue-rotate(-10deg) saturate(1.1) brightness(0.95)",
        vignette: false,
      };
    case "warm":
      return {
        cssFilter: "hue-rotate(10deg) saturate(1.1) brightness(1.05)",
        vignette: false,
      };
    case "vignette":
      return { cssFilter: "", vignette: true };
    case "neon":
      return {
        cssFilter: "saturate(2) contrast(1.3) brightness(1.1)",
        vignette: false,
      };
    case "high_contrast":
      return { cssFilter: "contrast(1.4)", vignette: false };
    case "soft_glow":
      return {
        cssFilter: "brightness(1.1) saturate(1.1) blur(0.5px)",
        vignette: false,
      };
    case "film_grain":
      return { cssFilter: "contrast(1.05) sepia(0.1)", vignette: false };
    default:
      return { cssFilter: "", vignette: false };
  }
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
}: {
  layer: Layer;
  currentTimeSec: number;
  isPlaying: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const resolved = resolveSrcForWebview(layer.source);

  // currentTime を同期（scrub 中 / 再生停止中の追従）
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    let target = currentTimeSec - layer.startSec;
    const dur = a.duration;
    // ループ対応: 素材尺より長いレンジなら module で位置を算出
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
  }, [currentTimeSec, layer.startSec, layer.audioLoop]);

  // 音量を制御（音量 + フェードイン/アウトの簡易線形補間）
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
    a.volume = Math.max(0, Math.min(1, gain));
  }, [
    currentTimeSec,
    layer.volume,
    layer.audioFadeIn,
    layer.audioFadeOut,
    layer.startSec,
    layer.endSec,
  ]);

  // play/pause
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (isPlaying) {
      a.play().catch(() => {
        /* autoplay 制約で失敗する可能性 */
      });
    } else {
      a.pause();
    }
  }, [isPlaying]);

  if (!resolved) return null;

  return (
    <audio
      ref={audioRef}
      src={resolved}
      preload="auto"
      loop={!!layer.audioLoop}
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
    const target = Math.max(0, currentTimeSec - layer.startSec);
    if (isFinite(target) && Math.abs(v.currentTime - target) > 0.15) {
      try {
        v.currentTime = target;
      } catch {
        // seek 前に metadata 未ロードの場合があるが、loadedmetadata で再設定される
      }
    }
  }, [currentTimeSec, layer.startSec]);

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

  return (
    <video
      ref={videoRef}
      src={resolved}
      muted
      playsInline
      preload="auto"
      onLoadedMetadata={handleLoadedMetadata}
      style={{
        width: "100%",
        height: "100%",
        objectFit: "cover",
        pointerEvents: "none",
      }}
    />
  );
}
