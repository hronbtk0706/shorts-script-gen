import { invoke } from "@tauri-apps/api/core";
import type { Layer } from "../types";

/** ランダム id */
function genId(prefix = "ps"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/** 保存されるプリセット本体 */
export interface LayerPreset {
  id: string;
  name: string;
  /** ISO 8601 */
  createdAt: string;
  /**
   * プリセットに含まれる原レイヤー群（id や時刻などはそのまま保持）。
   * 呼び出し時に id は再発行、時刻は playhead 基準に相対シフトする。
   */
  layers: Layer[];
}

export async function listPresets(): Promise<LayerPreset[]> {
  const raw = await invoke<string[]>("list_presets");
  const out: LayerPreset[] = [];
  for (const s of raw) {
    try {
      const p = JSON.parse(s) as LayerPreset;
      if (p && Array.isArray(p.layers)) out.push(p);
    } catch (e) {
      console.warn("[presetStore] parse failed:", e);
    }
  }
  // 新しい順
  out.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return out;
}

export async function savePreset(preset: LayerPreset): Promise<void> {
  await invoke("save_preset", {
    id: preset.id,
    json: JSON.stringify(preset, null, 2),
  });
}

export async function deletePreset(id: string): Promise<void> {
  await invoke("delete_preset", { id });
}

/** 選択レイヤーから新規プリセットを作る（保存はしない） */
export function createPresetFromLayers(
  name: string,
  layers: Layer[],
): LayerPreset {
  return {
    id: genId(),
    name: name.trim() || "無題プリセット",
    createdAt: new Date().toISOString(),
    layers: layers.map((l) => ({ ...l })),
  };
}

/**
 * プリセットを呼び出してレイヤー配列に変換する。
 * - 各レイヤー id を新規生成
 * - 時刻を playheadSec 基準に相対シフト
 *   （プリセット内最早 startSec を 0 と見なし、その差だけずらす）
 * - 既存の generatedNarrationLayerId は参照切れになるため除去
 */
export function instantiatePreset(
  preset: LayerPreset,
  playheadSec: number,
  totalDuration: number,
): Layer[] {
  if (preset.layers.length === 0) return [];
  const earliest = Math.min(...preset.layers.map((l) => l.startSec));
  const baseShift = playheadSec - earliest;
  return preset.layers.map((l) => {
    const newStart = Math.max(0, l.startSec + baseShift);
    const newEnd = Math.min(totalDuration, l.endSec + baseShift);
    const { generatedNarrationLayerId: _omit, ...rest } = l;
    void _omit;
    return {
      ...rest,
      id: genId("ly"),
      startSec: newStart,
      endSec: newEnd,
    } as Layer;
  });
}
