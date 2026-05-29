/**
 * 画面全体エフェクト Layer（type === "effect"）の計算。
 *
 * effect layer は pixel を出力せず、その [startSec, endSec] の間、**最終合成フレーム全体**に
 * 効果を適用する（Phase 1 は shake のみ）。preview (TemplateCanvas の合成 div) と
 * export (exportTemplateWebCodecs の OffscreenCanvas) で**同じ式**を使い、見た目と出力を一致させる。
 *
 * 決定論性: 乱数 seed = floor(t * 30)。preview / export で同じ振動パターンになる。
 * 複数 shake layer は **最大強度を採用**（積算しない）。
 */

import type { Layer } from "../types";

export interface ScreenShake {
  dx: number;
  dy: number;
}

/** proposal 指定の簡易 PRNG（-0.5..0.5 を返す決定論的乱数） */
function rng(n: number): number {
  return ((n * 9301 + 49297) % 233280) / 233280 - 0.5;
}

/**
 * 時刻 t での画面シェイク量を返す。shake な effect layer が無ければ {0,0}。
 * pxScale は design(360) 基準の px 振幅を描画解像度へ換算する係数（preview=canvasWPx/360,
 * export=FINAL_W/360）。ambient(B1) と同じ考え方で frame 比の見え方を揃える。
 */
export function computeScreenShake(
  layers: Layer[],
  t: number,
  pxScale = 1,
): ScreenShake {
  let intensity = 0;
  for (const L of layers) {
    if (L.type !== "effect" || L.effectKind !== "shake") continue;
    if (t < L.startSec || t >= L.endSec) continue;
    const i = Math.max(0, Math.min(2, L.effectIntensity ?? 1));
    if (i > intensity) intensity = i;
  }
  if (intensity <= 0) return { dx: 0, dy: 0 };
  const seed = Math.floor(t * 30);
  const dx = rng(seed) * intensity * 16 * pxScale; // ±8px * intensity（design 基準）
  const dy = rng(seed + 1) * intensity * 16 * pxScale;
  return { dx, dy };
}

/** layers に「いずれかの時刻で効く」effect layer が含まれるか（早期スキップ用） */
export function hasScreenEffect(layers: Layer[]): boolean {
  return layers.some((l) => l.type === "effect");
}
