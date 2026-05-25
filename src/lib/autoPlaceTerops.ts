import type { Layer, VideoTemplate } from "../types";
import { genLayerId, findFreeTrackZIndex } from "./layerUtils";
import { loadSettings } from "./storage";

export interface AutoPlaceProgress {
  current: number;
  total: number;
  message: string;
}

export interface AutoPlaceResult {
  template: VideoTemplate;
  insertedChunks: number;
  totalAddedSec: number;
}

/** 文字数から表示時間を推定する（日本語想定 ≈ 7文字/秒、最低 1.5 秒） */
function estimateDurationFromText(text: string): number {
  const charCount = text.replace(/\s+/g, "").length;
  return Math.max(1.5, charCount * 0.14); // 約 7文字/秒
}

/**
 * 台本テキストの各チャンクをテロップレイヤーとしてテンプレ末尾に追加して返す。
 * 分割ルール: 3つ以上連続する改行（= 2行以上の空行）でチャンクを区切る。
 * 1〜2 改行はチャンク内に保持され、テロップの 2 行表示に使われる。
 *
 * 表示時間は文字数から自動推定（≈ 7文字/秒、最低 1.5 秒）。
 */
export async function autoPlaceTeropsFromScript(
  template: VideoTemplate,
  script: string,
  onProgress?: (p: AutoPlaceProgress) => void,
): Promise<AutoPlaceResult> {
  const settings = await loadSettings();

  const trimmed = script.replace(/\r\n/g, "\n").trim();
  if (!trimmed) {
    return { template, insertedChunks: 0, totalAddedSec: 0 };
  }

  // 3つ以上の連続改行で分割。チャンク内の単一改行はそのまま残す
  const chunks = trimmed
    .split(/\n{3,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (chunks.length === 0) {
    return { template, insertedChunks: 0, totalAddedSec: 0 };
  }

  // 既存レイヤーの最後の終了秒を起点にする
  const existingEnd = template.layers.reduce(
    (m, l) => Math.max(m, l.endSec),
    0,
  );

  let cursor = existingEnd;
  const newLayers: Layer[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const text = chunks[i];
    onProgress?.({
      current: i + 1,
      total: chunks.length,
      message: `テロップ配置中（${i + 1}/${chunks.length}）...`,
    });

    const dur = estimateDurationFromText(text);
    const startSec = cursor;
    const endSec = cursor + dur;

    const textLayer: Layer = {
      id: genLayerId(),
      type: "comment",
      x: 10,
      y: settings.autoTeropY,
      width: 80,
      height: 12,
      zIndex: findFreeTrackZIndex(
        [...template.layers, ...newLayers],
        startSec,
        endSec,
        "video",
      ),
      shape: "rect",
      opacity: 1,
      rotation: 0,
      startSec,
      endSec,
      text,
      fontSize: settings.autoTeropFontSize,
      fontColor: settings.autoTeropFontColor,
      textOutlineWidth: settings.autoTeropOutlineWidth,
      textOutlineColor: settings.autoTeropOutlineColor,
      fontFamily: settings.autoTeropFontFamily || undefined,
      fillColor: settings.autoTeropFillColor || undefined,
    };
    newLayers.push(textLayer);

    cursor = endSec;
  }

  const newTotal = Math.max(template.totalDuration, cursor);
  const updated: VideoTemplate = {
    ...template,
    layers: [...template.layers, ...newLayers],
    totalDuration: newTotal,
  };

  return {
    template: updated,
    insertedChunks: chunks.length,
    totalAddedSec: cursor - existingEnd,
  };
}
