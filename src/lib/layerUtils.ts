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
    case "comment":
      return {
        ...base,
        height: 6,
        text: "テキストを入力",
        fontSize: 48,
        fontColor: "#FFFFFF",
        // fillColor は既定で未設定（= 背景なし）。PropertyPanel でトグル可能
      };
    case "audio":
      return {
        ...base,
        // キャンバス上は非可視だが座標は仮置き（タイムラインのみで操作）
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        source: "user",
        volume: 1,
        audioFadeIn: 0,
        audioFadeOut: 0,
        audioLoop: false,
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

/**
 * 指定時間範囲 [startSec, endSec) でそのトラック (zIndex) に他レイヤーが占有している区間があるか
 */
export function hasTimeConflictOnTrack(
  layers: Layer[],
  excludeLayerId: string | null,
  zIndex: number,
  startSec: number,
  endSec: number,
): boolean {
  const EPS = 0.001;
  return layers.some(
    (l) =>
      l.id !== excludeLayerId &&
      l.zIndex === zIndex &&
      l.startSec < endSec - EPS &&
      l.endSec > startSec + EPS,
  );
}

/**
 * 指定時間範囲で競合しない最も下 (zIndex 最小) のトラックを返す。
 * どのトラックも競合するなら max(zIndex)+1 の新トラックを作る。
 * section="video" なら zIndex>=0、"audio" なら zIndex<0 の範囲で探す。
 */
export function findFreeTrackZIndex(
  layers: Layer[],
  startSec: number,
  endSec: number,
  section: "video" | "audio" = "video",
): number {
  const candidate = layers.filter((l) =>
    section === "video" ? l.zIndex >= 0 : l.zIndex < 0,
  );
  const zIndices = Array.from(new Set(candidate.map((l) => l.zIndex))).sort(
    (a, b) => a - b,
  );
  for (const z of zIndices) {
    if (!hasTimeConflictOnTrack(candidate, null, z, startSec, endSec)) return z;
  }
  if (zIndices.length === 0) {
    return section === "video" ? 0 : -1;
  }
  return section === "video"
    ? Math.max(...zIndices) + 1
    : Math.min(...zIndices) - 1;
}

/**
 * 旧 "text" タイプを "comment" に移行（fillColor は未設定 = 背景なし）。
 * 旧 text レイヤーは背景無しだったので fillColor を強制的に undefined にする。
 */
export function migrateTextToComment(layers: Layer[]): Layer[] {
  return layers.map((l) => {
    // 旧 text 型（types.ts から削除済みなので string 比較）
    if ((l as { type: string }).type === "text") {
      return { ...l, type: "comment" as const, fillColor: undefined };
    }
    return l;
  });
}

/**
 * 読み込み時に、音声レイヤーが zIndex >= 0 にあれば負値に再マップする。
 * video は元のまま。
 */
export function migrateAudioToNegativeZ(layers: Layer[]): Layer[] {
  const audioLayers = layers.filter((l) => l.type === "audio");
  if (audioLayers.every((l) => l.zIndex < 0)) return layers;
  // audio 同士で重複を避けつつ、-1, -2, ... に再割当
  let nextZ = -1;
  const map = new Map<string, number>();
  for (const a of audioLayers) {
    if (a.zIndex < 0) {
      map.set(a.id, a.zIndex);
      continue;
    }
    // 使用中の負値を避ける
    while (
      Array.from(map.values()).includes(nextZ) ||
      audioLayers.some((x) => x.zIndex === nextZ && x.zIndex < 0)
    ) {
      nextZ -= 1;
    }
    map.set(a.id, nextZ);
    nextZ -= 1;
  }
  return layers.map((l) =>
    l.type === "audio" && map.has(l.id)
      ? { ...l, zIndex: map.get(l.id)! }
      : l,
  );
}

/**
 * タイムラインのトラック操作を適用し、移動レイヤーの所属セクション内で zIndex を正規化する。
 * - 映像セクション (type != "audio"): zIndex は 0..N-1（上=高い）
 * - 音声セクション (type == "audio"): zIndex は -1..-N（上=-1、下に行くほど小さい）
 * - targetDisplayIdx / beforeDisplayIdx はセクション内の相対インデックス
 */
export function applyTrackAction(
  layers: Layer[],
  layerId: string,
  action:
    | { type: "merge"; targetDisplayIdx: number }
    | { type: "insert"; beforeDisplayIdx: number },
): Layer[] {
  const moving = layers.find((l) => l.id === layerId);
  if (!moving) return layers;
  const isAudio = moving.type === "audio";
  const inSameSection = (l: Layer) => (l.type === "audio") === isAudio;

  // 同じセクション内のトラックだけ集める
  const byZ = new Map<number, Layer[]>();
  for (const l of layers) {
    if (!inSameSection(l)) continue;
    if (!byZ.has(l.zIndex)) byZ.set(l.zIndex, []);
    byZ.get(l.zIndex)!.push(l);
  }
  const tracks = Array.from(byZ.entries())
    .map(([z, ls]) => ({ zIndex: z, layers: ls }))
    .sort((a, b) => b.zIndex - a.zIndex);

  const movingOrigIdx = tracks.findIndex((t) =>
    t.layers.some((l) => l.id === layerId),
  );
  const movingTrackWasSolo =
    movingOrigIdx >= 0 && tracks[movingOrigIdx].layers.length === 1;

  const withoutMoving: Layer[][] = tracks
    .map((t) => t.layers.filter((l) => l.id !== layerId))
    .filter((ls) => ls.length > 0);

  if (action.type === "merge") {
    const targetZ = tracks[action.targetDisplayIdx]?.zIndex;
    if (targetZ === undefined) return layers;
    const idx = withoutMoving.findIndex(
      (ls) => ls.length > 0 && ls[0].zIndex === targetZ,
    );
    if (idx < 0) {
      withoutMoving.splice(
        Math.min(action.targetDisplayIdx, withoutMoving.length),
        0,
        [moving],
      );
    } else {
      withoutMoving[idx].push(moving);
    }
  } else {
    let insertIdx = action.beforeDisplayIdx;
    if (movingTrackWasSolo && movingOrigIdx < insertIdx) {
      insertIdx -= 1;
    }
    insertIdx = Math.max(0, Math.min(withoutMoving.length, insertIdx));
    withoutMoving.splice(insertIdx, 0, [moving]);
  }

  // セクション内で zIndex を正規化
  const N = withoutMoving.length;
  const zMap = new Map<string, number>();
  withoutMoving.forEach((ls, idx) => {
    const z = isAudio ? -(idx + 1) : N - 1 - idx;
    for (const l of ls) zMap.set(l.id, z);
  });
  return layers.map((l) =>
    inSameSection(l) && zMap.has(l.id)
      ? { ...l, zIndex: zMap.get(l.id)! }
      : l,
  );
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
