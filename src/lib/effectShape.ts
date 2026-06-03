/**
 * curio-gen アニメ仕様 Phase2 §B-強調: 描画系 effect（speedlines / spotlight）の Canvas 描画。
 *
 * 既存 effectKind（全画面後処理）と別系統で、レイヤー領域 [0,w]×[0,h] に直接ピクセルを描く。
 * 単一レンダラなので可視プレビュー＝書き出しで同じ（drawLayerContentInBox から呼ばれる）。
 * canvas は常に FINAL 解像度で描かれるため、px 系は pxScale = FINAL_W/360 で換算する。
 *
 * アニメ（§B 拡張・アメコミ風）: animate = none/flicker/pulse/spin、速度 speed（既定1）。
 * 既定 none では従来の静的挙動と完全一致（t を使わない）。t は絶対秒（playhead）。
 *
 * 決定論性: jitter は seed=line index（flicker 時は時間量子化を加算）の簡易 PRNG。
 * preview/export で同じパターンになる。
 */

import type { DrawnEffectParams } from "../types";

/** 0..1 を返す決定論的 PRNG。 */
function rng(n: number): number {
  return ((n * 9301 + 49297) % 233280) / 233280;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * speedlines（集中線）: center へ収束する楔形の線を density 本、放射状に描く。
 * 中心は gapRatio ぶん空ける。animate で動かす:
 * - flicker: 一定間隔で線パターンが切り替わる（手描きコマ送り＝アメコミ風）
 * - spin: 全体がゆっくり回転
 * - pulse: 中心の空きが脈動（「ドン」と迫る勢い）
 */
export function drawSpeedlines(
  ctx: CanvasRenderingContext2D,
  p: DrawnEffectParams,
  w: number,
  h: number,
  pxScale = 1,
  t = 0,
): void {
  const cx = ((p.center?.[0] ?? 50) / 100) * w;
  const cy = ((p.center?.[1] ?? 50) / 100) * h;
  const density = Math.max(4, Math.min(400, Math.round(p.density ?? 40)));
  const color = p.color ?? "#FFFFFF";
  const gapRatio = clamp01(p.gapRatio ?? 0.35);
  const baseThick = Math.max(0.5, (p.thickness ?? 2) * pxScale);
  const animate = p.animate ?? "none";
  const speed = Math.max(0, p.speed ?? 1);

  // flicker: seed を時間で量子化（1秒に ~10*speed コマ）→ コマ送りでパターンが切り替わる
  const seedStep =
    animate === "flicker" ? Math.floor(t * 10 * Math.max(0.1, speed)) * 1000 : 0;
  // spin: 全角度に時間オフセット
  const angleOffset = animate === "spin" ? t * speed * 0.6 : 0;
  // pulse: 中心の空き比を脈動
  const gapMul =
    animate === "pulse" ? 1 + 0.28 * Math.sin(t * Math.PI * 2 * speed) : 1;

  const maxR = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)) * 1.15;
  const innerR = maxR * clamp01(gapRatio * gapMul);

  ctx.save();
  ctx.fillStyle = color;
  for (let i = 0; i < density; i++) {
    const base = (i / density) * Math.PI * 2 + angleOffset;
    // 隣の線との間で角度を揺らす（等間隔すぎないように）
    const ang =
      base + (rng(i * 97 + 13 + seedStep) - 0.5) * ((Math.PI * 2) / density) * 0.8;
    const halfW = baseThick * (0.6 + rng(i * 53 + 7 + seedStep) * 1.2);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const ix = cx + ca * innerR;
    const iy = cy + sa * innerR;
    const ox = cx + ca * maxR;
    const oy = cy + sa * maxR;
    const px = -sa * halfW; // 線に垂直な方向
    const py = ca * halfW;
    ctx.beginPath();
    ctx.moveTo(ix, iy); // 内側は収束点
    ctx.lineTo(ox + px, oy + py); // 外側の底辺 1
    ctx.lineTo(ox - px, oy - py); // 外側の底辺 2
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/**
 * spotlight: center を明るく残し周辺を dim ぶん暗くする放射状グラデーション。
 * animate: pulse=半径が脈動 / flicker=半径が微小にちらつく / spin=放射対称なので無効。
 */
export function drawSpotlight(
  ctx: CanvasRenderingContext2D,
  p: DrawnEffectParams,
  w: number,
  h: number,
  t = 0,
): void {
  const cx = ((p.center?.[0] ?? 50) / 100) * w;
  const cy = ((p.center?.[1] ?? 50) / 100) * h;
  const dim = clamp01(p.dim ?? 0.6);
  const softness = clamp01(p.softness ?? 0.4);
  const animate = p.animate ?? "none";
  const speed = Math.max(0, p.speed ?? 1);

  let radiusBase = ((p.radius ?? 25) / 100) * Math.min(w, h);
  if (animate === "pulse") {
    radiusBase *= 1 + 0.14 * Math.sin(t * Math.PI * 2 * speed);
  } else if (animate === "flicker") {
    radiusBase *=
      1 + 0.06 * (rng(Math.floor(t * 12 * Math.max(0.1, speed))) - 0.5) * 2;
  }
  const radius = Math.max(1, radiusBase);
  const r0 = Math.max(0, radius * (1 - softness * 0.5)); // 明るい中心
  const r1 = Math.max(r0 + 1, radius + softness * Math.max(w, h) * 0.6); // 減光完成半径

  ctx.save();
  const g = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, `rgba(0,0,0,${dim.toFixed(3)})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/**
 * §B 雰囲気系 grain: フィルム粒子（ノイズタイル + overlay 合成）or 走査線。
 * 全画面後処理として描画後に呼ぶ。t（秒）で seed が変わり粒子が動く（決定論）。
 */
export function drawGrain(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  g: { type: "grain" | "scanlines"; strength: number; speed: number },
  w: number,
  h: number,
  pxScale = 1,
  t = 0,
): void {
  if (g.type === "scanlines") {
    const gap = Math.max(2, 4 * pxScale);
    ctx.save();
    ctx.fillStyle = `rgba(0,0,0,${(g.strength * 0.35).toFixed(3)})`;
    for (let y = 0; y < h; y += gap * 2) ctx.fillRect(0, y, w, gap);
    ctx.restore();
    return;
  }
  // grain: 96px ノイズタイルを生成し pattern で全画面に overlay 合成（軽量）。
  const tile = 96;
  const oc = new OffscreenCanvas(tile, tile);
  const tctx = oc.getContext("2d");
  if (!tctx) return;
  const img = tctx.createImageData(tile, tile);
  const d = img.data;
  const seed = Math.floor(t * 20 * Math.max(0.1, g.speed)) * 7919;
  const alpha = Math.floor(g.strength * 90);
  for (let i = 0; i < tile * tile; i++) {
    const v = Math.floor(rng(seed + i) * 255);
    d[i * 4] = v;
    d[i * 4 + 1] = v;
    d[i * 4 + 2] = v;
    d[i * 4 + 3] = alpha;
  }
  tctx.putImageData(img, 0, 0);
  const pat = ctx.createPattern(oc, "repeat");
  if (!pat) return;
  ctx.save();
  ctx.globalCompositeOperation = "overlay";
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}
