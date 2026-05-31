/**
 * 画面全体エフェクト Layer（type === "effect"）の計算。
 *
 * effect layer は pixel を出力せず、その [startSec, endSec] の間、**最終合成フレーム全体**に
 * 効果を適用する。preview (TemplateCanvas の合成 div) と export (exportTemplateWebCodecs の
 * OffscreenCanvas) で**同じ式**を使い、見た目と出力を一致させる。
 *
 * Phase 1: shake。Phase 2: flash / zoom-punch / vignette-pulse / blur-burst。
 *
 * 決定論性: shake の乱数 seed = floor(t * 30)。preview / export で同じパターンになる。
 * 複数の同種 layer が重なったら **効果値の最大を 1 回適用**（積算しない）。
 * px 系（shake 振幅 / blur 半径）は design(360) 基準で pxScale により描画解像度へ換算する
 * （preview=canvasWPx/360, export=FINAL_W/360）。zoom の scale 比と alpha は解像度非依存。
 */

import type { Layer } from "../types";

export interface ScreenShake {
  dx: number;
  dy: number;
}

/** 画面全体エフェクトの合成結果。各値は「その時刻の最終合成フレームへの適用量」。 */
export interface ScreenEffects {
  /** shake の平行移動（px, 解像度換算済み） */
  dx: number;
  dy: number;
  /** zoom-punch の拡大率（中心基準）。1.0 = 等倍 */
  scale: number;
  /** flash の白被せ alpha（0..1） */
  flashAlpha: number;
  /** vignette の端の黒 alpha（0..1）。中心は 0 */
  vignetteAlpha: number;
  /** blur-burst の blur 半径（px, 解像度換算済み） */
  blurPx: number;
}

/** proposal 指定の簡易 PRNG（-0.5..0.5 を返す決定論的乱数） */
function rng(n: number): number {
  return ((n * 9301 + 49297) % 233280) / 233280 - 0.5;
}

const clampI = (v: number | undefined) => Math.max(0, Math.min(2, v ?? 1));

/** layer の区間内なら 0..1 の進行度 p を返す。区間外は null。 */
function progress(L: Layer, t: number): number | null {
  if (t < L.startSec || t >= L.endSec) return null;
  const dur = Math.max(1e-6, L.endSec - L.startSec);
  return (t - L.startSec) / dur;
}

/** 立ち上がり即 → 余弦で戻る山型（zoom-punch 用）。attack まで線形上昇、以降は余弦で 1→0。 */
function punchHump(p: number, attack = 0.3): number {
  if (p <= attack) return p / attack;
  const q = (p - attack) / (1 - attack);
  return 0.5 * (1 + Math.cos(Math.PI * q));
}

/** 対称な山型（0→1→0、flash の減衰以外の vignette / blur 用） */
function bell(p: number): number {
  return Math.sin(Math.PI * Math.max(0, Math.min(1, p)));
}

/**
 * 時刻 t での画面シェイク量を返す。shake な effect layer が無ければ {0,0}。
 * （後方互換のため残置。新規は computeScreenEffects を使う）
 */
export function computeScreenShake(
  layers: Layer[],
  t: number,
  pxScale = 1,
): ScreenShake {
  let intensity = 0;
  for (const L of layers) {
    if (L.type !== "effect" || L.effectKind !== "shake") continue;
    if (progress(L, t) === null) continue;
    const i = clampI(L.effectIntensity);
    if (i > intensity) intensity = i;
  }
  if (intensity <= 0) return { dx: 0, dy: 0 };
  const seed = Math.floor(t * 30);
  const dx = rng(seed) * intensity * 16 * pxScale; // ±8px * intensity（design 基準）
  const dy = rng(seed + 1) * intensity * 16 * pxScale;
  return { dx, dy };
}

/**
 * 時刻 t での全画面エフェクトをまとめて算出。effect layer が無ければ恒等値を返す。
 * 同種が重なったら効果値の最大を採る（積算しない）。
 */
export function computeScreenEffects(
  layers: Layer[],
  t: number,
  pxScale = 1,
): ScreenEffects {
  const out: ScreenEffects = {
    dx: 0,
    dy: 0,
    scale: 1,
    flashAlpha: 0,
    vignetteAlpha: 0,
    blurPx: 0,
  };
  let shakeIntensity = 0;
  let zoomExtra = 0;

  for (const L of layers) {
    if (L.type !== "effect") continue;
    const p = progress(L, t);
    if (p === null) continue;
    const i = clampI(L.effectIntensity);
    if (i <= 0) continue;

    switch (L.effectKind) {
      case "shake":
        if (i > shakeIntensity) shakeIntensity = i;
        break;
      case "flash": {
        // 立ち上がり即時 → endSec へ向け alpha を intensity*0.9 → 0 へ線形減衰
        const a = i * 0.9 * (1 - p);
        if (a > out.flashAlpha) out.flashAlpha = a;
        break;
      }
      case "zoom-punch": {
        // 1.0 → 1.0 + intensity*0.06 へ急峻に立ち上がり ease-out で戻る
        const extra = i * 0.06 * punchHump(p);
        if (extra > zoomExtra) zoomExtra = extra;
        break;
      }
      case "vignette-pulse": {
        // 端 alpha = intensity*0.5 を山型に
        const a = i * 0.5 * bell(p);
        if (a > out.vignetteAlpha) out.vignetteAlpha = a;
        break;
      }
      case "blur-burst": {
        // 0 → intensity*8px → 0 の山型（design 基準 px を解像度換算）
        const b = i * 8 * bell(p) * pxScale;
        if (b > out.blurPx) out.blurPx = b;
        break;
      }
      default:
        break;
    }
  }

  if (shakeIntensity > 0) {
    const seed = Math.floor(t * 30);
    out.dx = rng(seed) * shakeIntensity * 16 * pxScale;
    out.dy = rng(seed + 1) * shakeIntensity * 16 * pxScale;
  }
  out.scale = 1 + zoomExtra;
  return out;
}

/** layers に「いずれかの時刻で効く」effect layer が含まれるか（早期スキップ用） */
export function hasScreenEffect(layers: Layer[]): boolean {
  return layers.some((l) => l.type === "effect");
}
