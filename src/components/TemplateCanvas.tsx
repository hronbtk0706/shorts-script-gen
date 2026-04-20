import { useEffect, useRef, useState } from "react";
import Moveable from "react-moveable";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Layer } from "../types";
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
  onLayerSelect: (id: string | null) => void;
  onLayerUpdate: (id: string, patch: Partial<Layer>) => void;
  /** 背景色（キャンバス自体の背景、レイヤーなしでも見える色） */
  canvasBackground?: string;
  /** グリッド表示 */
  showGrid?: boolean;
  /** 指定時刻に可視なレイヤーだけ表示（未指定なら全レイヤー） */
  currentTimeSec?: number;
}

/** 9:16 仮想キャンバス。横 360px 固定（高さ 640px）をデフォルトとする */
const CANVAS_W_PX = 360;
const CANVAS_H_PX = 640;

export function TemplateCanvas({
  layers,
  selectedLayerId,
  onLayerSelect,
  onLayerUpdate,
  canvasBackground = "#111",
  showGrid = false,
  currentTimeSec,
}: Props) {
  const filteredLayers =
    currentTimeSec === undefined
      ? layers
      : layers.filter(
          (l) => currentTimeSec >= l.startSec && currentTimeSec < l.endSec,
        );
  const containerRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement | null>(null);
  const [, forceRerender] = useState(0);

  const selected = layers.find((l) => l.id === selectedLayerId) ?? null;
  // selected が変わったら Moveable を再計算させる
  useEffect(() => {
    forceRerender((n) => n + 1);
  }, [selectedLayerId]);

  const pxToPercent = (px: number, dimension: "w" | "h") =>
    (px / (dimension === "w" ? CANVAS_W_PX : CANVAS_H_PX)) * 100;

  const handleBackgroundClick = (e: React.MouseEvent) => {
    if (e.target === containerRef.current) {
      onLayerSelect(null);
    }
  };

  return (
    <div
      ref={containerRef}
      onMouseDown={handleBackgroundClick}
      className="relative overflow-hidden mx-auto shadow-lg"
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
      {sortedLayers(filteredLayers).map((layer) => (
        <LayerView
          key={layer.id}
          layer={layer}
          isSelected={layer.id === selectedLayerId}
          onSelect={() => onLayerSelect(layer.id)}
          onRefReady={(el) => {
            if (layer.id === selectedLayerId) {
              targetRef.current = el;
              forceRerender((n) => n + 1);
            }
          }}
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
  );
}

function LayerView({
  layer,
  isSelected,
  onSelect,
  onRefReady,
}: {
  layer: Layer;
  isSelected: boolean;
  onSelect: () => void;
  onRefReady: (el: HTMLDivElement | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isSelected) onRefReady(ref.current);
  }, [isSelected, onRefReady]);

  const leftPx = (layer.x / 100) * CANVAS_W_PX;
  const topPx = (layer.y / 100) * CANVAS_H_PX;
  const widthPx = (layer.width / 100) * CANVAS_W_PX;
  const heightPx = (layer.height / 100) * CANVAS_H_PX;

  const shapeStyle: React.CSSProperties = {};
  if (layer.shape === "circle") {
    shapeStyle.borderRadius = "50%";
  } else if (layer.shape === "rounded") {
    shapeStyle.borderRadius = layer.borderRadius ?? 12;
  }
  if (layer.border) {
    shapeStyle.border = `${layer.border.width}px solid ${layer.border.color}`;
  }
  if (layer.opacity !== undefined && layer.opacity !== 1) {
    shapeStyle.opacity = layer.opacity;
  }

  const style: React.CSSProperties = {
    position: "absolute",
    left: leftPx,
    top: topPx,
    width: widthPx,
    height: heightPx,
    transform: layer.rotation ? `rotate(${layer.rotation}deg)` : undefined,
    cursor: "pointer",
    userSelect: "none",
    overflow: "hidden",
    ...shapeStyle,
  };

  const inner = renderLayerContent(layer);

  return (
    <div
      ref={ref}
      data-layer-id={layer.id}
      style={style}
      onMouseDown={(e) => {
        e.stopPropagation();
        onSelect();
      }}
    >
      {inner}
    </div>
  );
}

function renderLayerContent(layer: Layer): React.ReactNode {
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
      const resolved = resolveSrcForWebview(layer.source);
      return (
        <div
          style={{
            width: "100%",
            height: "100%",
            background: resolved
              ? `url("${resolved}") center/cover no-repeat`
              : "repeating-linear-gradient(135deg, #222, #222 8px, #333 8px, #333 16px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#999",
            fontSize: 10,
          }}
        >
          {!resolved && "🎬 動画(未設定)"}
        </div>
      );
    }
    case "text":
    case "comment":
      return (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background:
              layer.type === "comment"
                ? layer.fillColor ?? "rgba(0,0,0,0.6)"
                : "transparent",
            color: layer.fontColor ?? "#fff",
            fontSize: Math.max(8, (layer.fontSize ?? 48) * 0.25),
            padding: 4,
            textAlign: "center",
            fontWeight: "bold",
            wordBreak: "break-word",
            overflow: "hidden",
          }}
        >
          {layer.text ?? "テキスト"}
        </div>
      );
  }
}
