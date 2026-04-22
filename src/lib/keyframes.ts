import type { KeyframeTrack, LayerKeyframes, Layer } from "../types";

/**
 * 1 プロパティのトラックから指定時刻 t の値を線形補間で求める。
 * トラックが無効 / 空 / undefined なら staticValue を返す。
 */
export function sampleTrack(
  track: KeyframeTrack | undefined,
  staticValue: number,
  t: number,
): number {
  if (!track || !track.enabled || track.frames.length === 0) return staticValue;
  const frames = [...track.frames].sort((a, b) => a.time - b.time);
  if (frames.length === 1) return frames[0].value;
  if (t <= frames[0].time) return frames[0].value;
  if (t >= frames[frames.length - 1].time)
    return frames[frames.length - 1].value;
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    if (t >= a.time && t <= b.time) {
      const span = b.time - a.time;
      if (span <= 0) return b.value;
      const k = (t - a.time) / span;
      return a.value + (b.value - a.value) * k;
    }
  }
  return staticValue;
}

/** そのレイヤーの時刻 t における有効プロパティ値を一括で取得する */
export function sampleLayerAt(layer: Layer, t: number): {
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  rotation: number;
  scale: number;
} {
  const kf: LayerKeyframes | undefined = layer.keyframes;
  const scale = sampleTrack(kf?.scale, 1, t);
  return {
    x: sampleTrack(kf?.x, layer.x, t),
    y: sampleTrack(kf?.y, layer.y, t),
    width: layer.width * scale,
    height: layer.height * scale,
    opacity: sampleTrack(kf?.opacity, layer.opacity ?? 1, t),
    rotation: sampleTrack(kf?.rotation, layer.rotation ?? 0, t),
    scale,
  };
}

/** あるプロパティが実際にアニメしているか（キーフレーム 2 点以上あり enabled） */
export function trackIsAnimating(track: KeyframeTrack | undefined): boolean {
  return !!track && track.enabled && track.frames.length >= 2;
}
