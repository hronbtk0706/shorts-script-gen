/**
 * Audio Ducking（BGM 自動低音量化）の決定論的な計算。
 *
 * リアルタイム振幅検出ではなく、`duckBy` に列挙された layer の表示区間
 * [startSec, endSec] を基準に、時刻 t での音量倍率 (0..1) を返す。
 * preview (AudioLayerPlayer) と export (mixAudioLayers) の両系統で**同じ式**を使い、
 * 「見た目（聞こえ方）と出力が違う」を防ぐ。
 *
 * エンベロープ（1 区間 [s, e] あたり）:
 *   - t < s - attack         : 1.0（通常）
 *   - s - attack <= t < s    : 1.0 → amount へ線形に下げる（attack）
 *   - s <= t <= e            : amount（フル duck）
 *   - e < t <= e + release   : amount → 1.0 へ線形に戻す（release）
 *   - t > e + release        : 1.0
 * 複数区間は **最小値（=最大の下げ）を 1 回だけ適用**（多重 duck しない＝区間の和集合）。
 */

import type { Layer } from "../types";

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * layer のダッキング音量倍率 (0..1) を時刻 t で返す。duckBy 未指定なら常に 1。
 * allLayers は duckBy の id から区間 [startSec, endSec] を引くために必要。
 */
export function computeDuckMultiplier(
  layer: Layer,
  allLayers: Layer[],
  t: number,
): number {
  const ids = layer.duckBy;
  if (!ids || ids.length === 0) return 1;
  const amount = clamp01(layer.duckAmount ?? 0.3);
  if (amount >= 1) return 1;
  const attack = Math.max(0, (layer.duckAttackMs ?? 250) / 1000);
  const release = Math.max(0, (layer.duckReleaseMs ?? 800) / 1000);
  const idSet = new Set(ids);

  let gain = 1;
  for (const other of allLayers) {
    if (other.id === layer.id) continue; // 自分自身では duck しない
    if (!idSet.has(other.id)) continue;
    const s = other.startSec;
    const e = other.endSec;
    if (e < s) continue;
    let g: number;
    if (t < s - attack || t > e + release) {
      g = 1;
    } else if (t < s) {
      // attack: 1 → amount
      const p = attack > 0 ? (t - (s - attack)) / attack : 1;
      g = 1 + (amount - 1) * clamp01(p);
    } else if (t <= e) {
      g = amount;
    } else {
      // release: amount → 1
      const p = release > 0 ? (t - e) / release : 1;
      g = amount + (1 - amount) * clamp01(p);
    }
    if (g < gain) gain = g; // 最小（=最大の下げ）を採用
  }
  return gain;
}

/** layer がダッキング対象（duckBy が 1 件以上）かどうか。 */
export function layerHasDucking(layer: Layer): boolean {
  return Array.isArray(layer.duckBy) && layer.duckBy.length > 0;
}
