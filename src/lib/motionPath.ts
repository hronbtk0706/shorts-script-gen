/**
 * curio-gen アニメ仕様 P3 (§8): `motionPath`（位置 x,y を Catmull-Rom 曲線で駆動）の評価。
 *
 * - `points`（% 座標・layer.x/y と同じ空間）を滑らかに通る曲線を生成し、進捗 u∈[0,1] で位置を返す。
 * - 進捗 = ease(clamp(tRel/duration))。`duration` 省略時は生存長。`loop` 時は [0,1) を周回。
 * - 位置のみ。scale/rotation/opacity は kfs 側（layerComposer が両者を合成し motionPath の x,y を優先）。
 * - preview/export 共通（単一レンダラなので 1 実装）。easing は kfs と同じ easeOf を共有。
 */

import type { Layer } from "../types";
import { easeOf } from "./animKeyframes";

/** motionPath を持つレイヤーか（1 点以上） */
export function hasMotionPath(layer: Layer): boolean {
  return (
    !!layer.motionPath &&
    Array.isArray(layer.motionPath.points) &&
    layer.motionPath.points.length > 0
  );
}

/**
 * Catmull-Rom スプライン（uniform, tension 0.5）。p1→p2 区間を localT∈[0,1] で補間。
 * p0/p3 は前後の制御点（端は複製）。
 */
function catmull(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/**
 * motionPath を時刻（startSec 相対秒）で評価し位置 % を返す。
 */
export function sampleMotionPath(
  layer: Layer,
  tRel: number,
): { x: number; y: number } {
  const mp = layer.motionPath!;
  const pts = mp.points;
  const n = pts.length;
  if (n === 1) return { x: pts[0][0], y: pts[0][1] };

  // duration 省略時 = 生存長
  const dur =
    mp.duration && mp.duration > 0
      ? mp.duration
      : Math.max(0.0001, layer.endSec - layer.startSec);
  let u = tRel / dur;
  if (mp.loop) u = u - Math.floor(u); // [0,1) を周回
  else u = Math.max(0, Math.min(1, u));

  const eased = easeOf(mp.ease)(u); // Back/Elastic は端で軽くオーバーシュート（kfs と同挙動）
  const segCount = n - 1;
  const scaled = eased * segCount;
  let seg = Math.floor(scaled);
  if (seg < 0) seg = 0;
  if (seg > segCount - 1) seg = segCount - 1;
  const localT = scaled - seg;

  const p0 = pts[Math.max(0, seg - 1)];
  const p1 = pts[seg];
  const p2 = pts[seg + 1];
  const p3 = pts[Math.min(n - 1, seg + 2)];
  return {
    x: catmull(p0[0], p1[0], p2[0], p3[0], localT),
    y: catmull(p0[1], p1[1], p2[1], p3[1], localT),
  };
}
