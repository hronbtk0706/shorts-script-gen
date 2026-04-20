import type { Layer, LayerType, TemplateSegment, VideoTemplate } from "../types";

export function genLayerId(): string {
  return `ly_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export function genSegmentId(): string {
  return `sg_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

interface NewLayerDefaults {
  type: LayerType;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  startSec?: number;
  endSec?: number;
}

export function makeLayer(defaults: NewLayerDefaults, zIndex: number): Layer {
  const base: Layer = {
    id: genLayerId(),
    type: defaults.type,
    x: defaults.x ?? 20,
    y: defaults.y ?? 30,
    width: defaults.width ?? 60,
    height: defaults.height ?? 40,
    zIndex,
    shape: "rect",
    opacity: 1,
    rotation: 0,
    startSec: defaults.startSec ?? 0,
    endSec: defaults.endSec ?? 3,
  };
  switch (defaults.type) {
    case "image":
      return { ...base, source: "auto" };
    case "video":
      return { ...base, source: "user" };
    case "color":
      return { ...base, fillColor: "#333333", x: 0, y: 0, width: 100, height: 100 };
    case "shape":
      return {
        ...base,
        fillColor: "#FFE600",
        shape: "rounded",
        borderRadius: 8,
      };
    case "text":
      return {
        ...base,
        text: "テキストを入力",
        fontSize: 64,
        fontColor: "#FFFFFF",
      };
    case "comment":
      return {
        ...base,
        x: 10,
        y: 70,
        width: 80,
        height: 18,
        shape: "rounded",
        borderRadius: 12,
        fillColor: "rgba(0,0,0,0.6)",
        text: "コメント引用",
        fontSize: 48,
        fontColor: "#FFFFFF",
      };
  }
}

export function makeSegment(
  type: "hook" | "body" | "cta",
  startSec: number,
  endSec: number,
  bodyIndex?: number,
): TemplateSegment {
  return {
    id: genSegmentId(),
    type,
    startSec,
    endSec,
    bodyIndex,
    transitionTo: type === "hook" ? "flash" : "cut",
    transitionDuration: type === "hook" ? 0.15 : 0,
  };
}

/** 指定時刻に可視なレイヤーを返す */
export function visibleLayersAt(layers: Layer[], tSec: number): Layer[] {
  return layers.filter((l) => tSec >= l.startSec && tSec < l.endSec);
}

export function cloneLayer(layer: Layer): Layer {
  return { ...layer, id: genLayerId() };
}

export function sortedLayers(layers: Layer[]): Layer[] {
  return [...layers].sort((a, b) => a.zIndex - b.zIndex);
}

export function moveLayerZ(
  layers: Layer[],
  layerId: string,
  direction: "up" | "down" | "top" | "bottom",
): Layer[] {
  const sorted = sortedLayers(layers);
  const idx = sorted.findIndex((l) => l.id === layerId);
  if (idx < 0) return layers;
  const newOrder = [...sorted];
  const [picked] = newOrder.splice(idx, 1);
  let targetIdx: number;
  switch (direction) {
    case "up":
      targetIdx = Math.min(sorted.length - 1, idx + 1);
      break;
    case "down":
      targetIdx = Math.max(0, idx - 1);
      break;
    case "top":
      targetIdx = sorted.length - 1;
      break;
    case "bottom":
      targetIdx = 0;
      break;
  }
  newOrder.splice(targetIdx, 0, picked);
  return newOrder.map((l, i) => ({ ...l, zIndex: i }));
}

/** v1 以外のテンプレは読み込まず除外（マイグレーション無し） */
export function isValidV2Template(t: unknown): t is VideoTemplate {
  if (!t || typeof t !== "object") return false;
  const tpl = t as Record<string, unknown>;
  return (
    tpl.version === 2 &&
    typeof tpl.id === "string" &&
    Array.isArray(tpl.layers) &&
    Array.isArray(tpl.segments)
  );
}

/** 新規空テンプレを作成（hook/body/cta の 3 セグメント付き） */
export function newBlankTemplateData(name: string, id: string): VideoTemplate {
  const totalDuration = 30;
  return {
    version: 2,
    id,
    name,
    createdAt: new Date().toISOString(),
    totalDuration,
    themeVibe: "",
    overallPacing: "",
    narrationStyle: "",
    layers: [],
    segments: [
      makeSegment("hook", 0, 3),
      makeSegment("body", 3, 27, 0),
      makeSegment("cta", 27, 30),
    ],
  };
}
