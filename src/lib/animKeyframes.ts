/**
 * curio-gen アニメ仕様 P0: `kfs`（AnimKeyframe[]）の評価。
 *
 * 既存のプロパティ別トラック（keyframes.ts の sampleLayerAt）とは別系統。
 * `kfs` は「全プロパティ混在・startSec 相対秒・per-KF easing」の配列で、curio-gen が emit する。
 * preview/export 共通で使う（単一レンダラなので 1 実装）。
 *
 * 補間ルール（仕様 §4）:
 * - 各 KF は指定したプロパティのみ補間対象。未指定は直前 KF の値を保持（無ければ base）。
 * - `ease` は「直前 KF → この KF」区間のカーブ。先頭 KF の ease は無視。
 * - t=0 の KF が無ければ t=0 の値は base。
 * - 最終 KF 以降は最終値を保持。
 */

import type {
  AnimKeyframe,
  KeyframeEase,
  KeyframeLoop,
  Layer,
  LayerAnchor,
} from "../types";

type EaseFn = (p: number) => number;

const c1 = 1.70158;
const c3 = c1 + 1;
const c4 = (2 * Math.PI) / 3;
const n1 = 7.5625;
const d1 = 2.75;

const EASES: Record<KeyframeEase, EaseFn> = {
  linear: (p) => p,
  easeInQuad: (p) => p * p,
  easeOutQuad: (p) => 1 - (1 - p) * (1 - p),
  easeInOutQuad: (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2),
  easeInCubic: (p) => p * p * p,
  easeOutCubic: (p) => 1 - Math.pow(1 - p, 3),
  easeInOutCubic: (p) =>
    p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2,
  easeOutBack: (p) => 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2),
  easeOutElastic: (p) =>
    p === 0
      ? 0
      : p === 1
        ? 1
        : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * c4) + 1,
  easeOutBounce: (p) => {
    if (p < 1 / d1) return n1 * p * p;
    if (p < 2 / d1) return n1 * (p -= 1.5 / d1) * p + 0.75;
    if (p < 2.5 / d1) return n1 * (p -= 2.25 / d1) * p + 0.9375;
    return n1 * (p -= 2.625 / d1) * p + 0.984375;
  },
};

/** 既定 ease（仕様 §5: 省略時 easeInOutQuad） */
const DEFAULT_EASE: KeyframeEase = "easeInOutQuad";

/** easing 名 → 関数（未知値は linear）。motionPath(§8) でも共有する。 */
export function easeOf(name: KeyframeEase | undefined): EaseFn {
  return EASES[name ?? DEFAULT_EASE] ?? EASES.linear;
}

export type AnimProp =
  | "x"
  | "y"
  | "scale"
  | "rotation"
  | "opacity"
  | "width"
  | "height"
  | "borderRadius";
const PROPS = ["x", "y", "scale", "rotation", "opacity"] as const;

/** §A3: 色トゥイーン対象プロパティ（文字列）。 */
type ColorProp = "fillColor" | "fontColor" | "textOutlineColor";
const COLOR_PROPS: ColorProp[] = [
  "fillColor",
  "fontColor",
  "textOutlineColor",
];

export interface AnimSample {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  /** §A2: kfs に width があれば % 絶対値。無ければ undefined（scale で算出）。 */
  width?: number;
  height?: number;
  /** §A3: kfs に定義があれば補間後の値。無ければ undefined（layer の静的値を使う）。 */
  fillColor?: string;
  fontColor?: string;
  textOutlineColor?: string;
  borderRadius?: number;
}

/** #RGB / #RRGGBB / #RRGGBBAA を [r,g,b,a] に。解釈不能は黒。 */
function parseHexColor(hex: string): [number, number, number, number] {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (h.length === 6 || h.length === 8) {
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    if (![r, g, b].some(Number.isNaN)) return [r, g, b, a];
  }
  return [0, 0, 0, 1];
}

/** §A3: 2 色を p で sRGB 線形補間し rgba() 文字列に。 */
function lerpColorStr(a: string, b: string, p: number): string {
  const A = parseHexColor(a);
  const B = parseHexColor(b);
  const r = Math.round(A[0] + (B[0] - A[0]) * p);
  const g = Math.round(A[1] + (B[1] - A[1]) * p);
  const bl = Math.round(A[2] + (B[2] - A[2]) * p);
  const al = A[3] + (B[3] - A[3]) * p;
  return `rgba(${r},${g},${bl},${al.toFixed(3)})`;
}

/** kfs を持つレイヤーか（2 点以上で実アニメ） */
export function hasAnimKfs(layer: Layer): boolean {
  return Array.isArray(layer.kfs) && layer.kfs.length > 0;
}

/**
 * 1 プロパティを時刻 tRel（startSec 相対秒）で評価。
 * 「指定プロパティのみ補間・未指定は直前値保持」を満たすため、各プロパティについて
 * そのプロパティが定義されている KF だけを拾って区間補間する。
 */
function sampleProp(
  kfs: AnimKeyframe[],
  prop: AnimProp,
  base: number,
  tRel: number,
): number {
  // prop は width/height も受ける（§A2）。以下のロジックはプロパティ非依存。
  // このプロパティを持つ KF のインデックス列
  let prevIdx = -1;
  let nextIdx = -1;
  for (let i = 0; i < kfs.length; i++) {
    if (kfs[i][prop] === undefined) continue;
    if (kfs[i].t <= tRel) prevIdx = i;
    else {
      nextIdx = i;
      break;
    }
  }
  // 区間外（前方）: 最初の定義 KF より前 → base（仕様: t=0 KF 省略時は base）
  if (prevIdx === -1) {
    if (nextIdx === -1) return base; // このプロパティの KF が無い
    // 最初の定義 KF より前は base のまま保持（その KF 時刻で値に到達）
    return base;
  }
  const prev = kfs[prevIdx];
  const prevVal = prev[prop] as number;
  // 区間外（後方）: 最後の定義値を保持
  if (nextIdx === -1) return prevVal;
  const next = kfs[nextIdx];
  const nextVal = next[prop] as number;
  const span = next.t - prev.t;
  if (span <= 0) return nextVal;
  const p = Math.max(0, Math.min(1, (tRel - prev.t) / span));
  // ease は「直前 KF → この(next) KF」区間 = next.ease を使う
  const e = easeOf(next.ease)(p);
  return prevVal + (nextVal - prevVal) * e;
}

/** §A3: 色プロパティを tRel で評価（指定 KF だけ辿り区間補間）。数値版 sampleProp と同ロジック。 */
function sampleColorProp(
  kfs: AnimKeyframe[],
  prop: ColorProp,
  base: string,
  tRel: number,
): string {
  let prevIdx = -1;
  let nextIdx = -1;
  for (let i = 0; i < kfs.length; i++) {
    if (kfs[i][prop] === undefined) continue;
    if (kfs[i].t <= tRel) prevIdx = i;
    else {
      nextIdx = i;
      break;
    }
  }
  if (prevIdx === -1) return base;
  const prevVal = kfs[prevIdx][prop] as string;
  if (nextIdx === -1) return prevVal;
  const next = kfs[nextIdx];
  const span = next.t - kfs[prevIdx].t;
  if (span <= 0) return next[prop] as string;
  const p = Math.max(0, Math.min(1, (tRel - kfs[prevIdx].t) / span));
  const e = easeOf(next.ease)(p);
  return lerpColorStr(prevVal, next[prop] as string, e);
}

/**
 * P1 (§6): kfsLoop（無ければ keyframeLoop エイリアス）を取り出す。
 */
function loopOf(layer: Layer): KeyframeLoop | undefined {
  return layer.kfsLoop ?? layer.keyframeLoop;
}

/**
 * P1 (§6): ループ設定に従い、生存相対秒 tRel を「kfs 1 周内の時刻」に折りたたむ。
 * - 1 ループ長 L = 最終 KF の t。L<=0（実質単点）はループ不能なので tRel をそのまま返す。
 * - restart: t = tRel mod L。count 回後は L（最終 KF 値）で停止。
 * - yoyo: 三角波で往復（周期 2L）。count 往復後は 0（先頭 KF 値）で停止。
 * tRel<=0 はループ前なので変換しない（base/先頭挙動はそのまま）。
 */
function foldLoopTime(layer: Layer, tRel: number, loopLen: number): number {
  const loop = loopOf(layer);
  if (!loop || loopLen <= 0 || tRel <= 0) return tRel;
  const count = loop.count == null ? null : Math.max(0, Math.floor(loop.count));
  if (loop.mode === "yoyo") {
    const period = loopLen * 2;
    if (count !== null && tRel >= count * period) return 0; // 往復終了 → 先頭 KF 値で停止
    const m = tRel % period;
    return m <= loopLen ? m : period - m; // 往路 0→L / 復路 L→0
  }
  // restart（既定）
  if (count !== null && tRel >= count * loopLen) return loopLen; // 終了 → 最終 KF 値で停止
  return tRel % loopLen;
}

/**
 * kfs を時刻（startSec 相対秒）で評価し、各 transform 値を返す。
 * base は layer のベース値（x/y/scale=1/rotation/opacity）。
 * kfsLoop/keyframeLoop があれば tRel をループ内時刻に折りたたんでから評価する（§6）。
 */
export function sampleAnimKfs(layer: Layer, tRel: number): AnimSample {
  const kfs = layer.kfs!;
  const loopLen = kfs.length > 0 ? kfs[kfs.length - 1].t : 0;
  tRel = foldLoopTime(layer, tRel, loopLen);
  const base = {
    x: layer.x,
    y: layer.y,
    scale: 1,
    rotation: layer.rotation ?? 0,
    opacity: layer.opacity ?? 1,
  };
  const out: AnimSample = { ...base };
  for (const prop of PROPS) {
    out[prop] = sampleProp(kfs, prop, base[prop], tRel);
  }
  // §A2: width/height は % 絶対。kfs に定義があるときだけ返す（anchor 基準で伸縮）。
  if (kfs.some((k) => k.width !== undefined)) {
    out.width = sampleProp(kfs, "width", layer.width, tRel);
  }
  if (kfs.some((k) => k.height !== undefined)) {
    out.height = sampleProp(kfs, "height", layer.height, tRel);
  }
  // §A3: borderRadius（数値）と色 3 種（文字列）。kfs に定義があるときだけ返す。
  if (kfs.some((k) => k.borderRadius !== undefined)) {
    out.borderRadius = sampleProp(
      kfs,
      "borderRadius",
      layer.borderRadius ?? 0,
      tRel,
    );
  }
  for (const cp of COLOR_PROPS) {
    if (kfs.some((k) => k[cp] !== undefined)) {
      out[cp] = sampleColorProp(kfs, cp, layer[cp] ?? "#000000", tRel);
    }
  }
  return out;
}

/**
 * §A1: アンカー基準で、箱サイズが (w0,h0)→(w1,h1) に変わったとき、アンカー辺を固定する
 * ように左上 (x,y)% をずらして返す。`anchor` 未指定（undefined）なら従来どおり左上固定
 * （ずらさない）＝既存挙動を完全維持。すべて % 単位。
 */
export function applyAnchorOffset(
  anchor: LayerAnchor | undefined,
  x: number,
  y: number,
  w0: number,
  h0: number,
  w1: number,
  h1: number,
): { x: number; y: number } {
  if (!anchor) return { x, y }; // 未指定 = 左上固定（従来挙動）
  const dx = w1 - w0;
  const dy = h1 - h0;
  let nx = x;
  let ny = y;
  // 水平方向の固定辺
  if (anchor === "center" || anchor === "top" || anchor === "bottom") {
    nx = x - dx / 2; // 水平中央固定
  } else if (
    anchor === "right" ||
    anchor === "top-right" ||
    anchor === "bottom-right"
  ) {
    nx = x - dx; // 右辺固定
  } // left / top-left / bottom-left は左辺固定 = nx 据え置き
  // 垂直方向の固定辺
  if (anchor === "center" || anchor === "left" || anchor === "right") {
    ny = y - dy / 2; // 垂直中央固定
  } else if (
    anchor === "bottom" ||
    anchor === "bottom-left" ||
    anchor === "bottom-right"
  ) {
    ny = y - dy; // 下辺固定
  } // top / top-left / top-right は上辺固定 = ny 据え置き
  return { x: nx, y: ny };
}
