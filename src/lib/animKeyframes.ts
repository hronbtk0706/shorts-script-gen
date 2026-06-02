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

import type { AnimKeyframe, KeyframeEase, Layer } from "../types";

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

function easeOf(name: KeyframeEase | undefined): EaseFn {
  return EASES[name ?? DEFAULT_EASE] ?? EASES.linear;
}

export type AnimProp = "x" | "y" | "scale" | "rotation" | "opacity";
const PROPS: AnimProp[] = ["x", "y", "scale", "rotation", "opacity"];

export interface AnimSample {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
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

/**
 * kfs を時刻（startSec 相対秒）で評価し、各 transform 値を返す。
 * base は layer のベース値（x/y/scale=1/rotation/opacity）。
 */
export function sampleAnimKfs(layer: Layer, tRel: number): AnimSample {
  const kfs = layer.kfs!;
  const base = {
    x: layer.x,
    y: layer.y,
    scale: 1,
    rotation: layer.rotation ?? 0,
    opacity: layer.opacity ?? 1,
  };
  const out = { ...base };
  for (const prop of PROPS) {
    out[prop] = sampleProp(kfs, prop, base[prop], tRel);
  }
  return out;
}
