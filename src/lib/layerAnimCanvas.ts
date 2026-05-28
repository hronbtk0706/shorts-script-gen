/**
 * Canvas 描画用のレイヤーアニメ計算。
 *
 * プレビュー (TemplateCanvas.tsx の `computeLayerAnimStyle`) は CSS string
 * (`translateX(50px) scale(0.8)` 等) を返すが、Canvas で扱うには数値が必要なので
 * 同じ式を Canvas 系の数値で返す姉妹実装を用意する。
 *
 * 数式は preview と完全一致させる (CLAUDE.md の「プレビューとエクスポートの一致」鉄則)。
 * 変更時は両方を必ずそろえて更新する。
 */

import type { Layer } from "../types";

export interface CanvasAnimTransform {
  /** layer base opacity に乗算する係数 (0..1) */
  opacity: number;
  /** 平行移動 (px、レイヤー w/h のスケール) */
  tx: number;
  ty: number;
  /** スケール (中心基準) */
  sx: number;
  sy: number;
  /** 回転 (radians、中心基準) */
  rot: number;
  /** ぼかし (px) */
  blur: number;
  /** hue-rotate (degrees) — rainbow ambient 用 */
  hueDeg: number;
  /** drop-shadow blur (px) — glow-pulse ambient 用 */
  glowBlur: number;
  /** drop-shadow color — glow-pulse ambient 用 */
  glowColor: string;
}

const IDENTITY: CanvasAnimTransform = {
  opacity: 1,
  tx: 0,
  ty: 0,
  sx: 1,
  sy: 1,
  rot: 0,
  blur: 0,
  hueDeg: 0,
  glowBlur: 0,
  glowColor: "",
};

/**
 * 入退場アニメーション + Ambient エフェクトを合成した変換を返す。
 * w/h はレイヤーピクセル寸法 (% の slide を実 px に変換するため必要)。
 */
export function computeCanvasAnim(
  layer: Layer,
  t: number,
  w: number,
  h: number,
): CanvasAnimTransform {
  const entryAnim = layer.entryAnimation ?? "none";
  const exitAnim = layer.exitAnimation ?? "none";
  const entryDur = Math.max(0.01, layer.entryDuration ?? 0.3);
  const exitDur = Math.max(0.01, layer.exitDuration ?? 0.3);
  const entryEnd = layer.startSec + entryDur;
  const exitStart = layer.endSec - exitDur;

  let opacity = 1;
  let tx = 0;
  let ty = 0;
  let sx = 1;
  let sy = 1;
  let rot = 0;
  let blur = 0;
  let hueDeg = 0;
  let glowBlur = 0;
  let glowColor = "";

  // ---- 入場 ----
  if (entryAnim !== "none" && t < entryEnd) {
    const raw = (t - layer.startSec) / entryDur;
    const p = Math.max(0, Math.min(1, raw));
    const e = 1 - Math.pow(1 - p, 2); // ease-out
    switch (entryAnim) {
      case "fade":
        opacity *= e;
        break;
      case "slide-left":
        tx = (1 - e) * -w;
        break;
      case "slide-right":
        tx = (1 - e) * w;
        break;
      case "slide-up":
        ty = (1 - e) * h;
        break;
      case "slide-down":
        ty = (1 - e) * -h;
        break;
      case "zoom-in":
        sx = sy = Math.max(0.001, e);
        break;
      case "pop": {
        const c1 = 1.70158;
        const c3 = c1 + 1;
        const eb = 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
        sx = sy = Math.max(0.001, eb);
        break;
      }
      case "blur-in":
        blur = (1 - e) * 20;
        opacity *= e;
        break;
      case "elastic-pop": {
        const c4 = (2 * Math.PI) / 3;
        const el =
          p === 0
            ? 0
            : p === 1
              ? 1
              : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * c4) + 1;
        sx = sy = Math.max(0.001, el);
        opacity *= e;
        break;
      }
      case "flip-in":
        // preview は perspective(500px) rotateY だが Canvas 2D は 3D 不可。
        // ffmpeg 側と同じく scaleX で近似 (audit の既知事項)
        sx = Math.max(0.001, e);
        opacity *= e;
        break;
      case "stretch-in":
        sx = Math.max(0.001, e);
        opacity *= e;
        break;
      case "roll-in":
        tx = (1 - e) * -w;
        rot = ((1 - e) * -180 * Math.PI) / 180;
        opacity *= e;
        break;
    }
  }

  // ---- 退場 ----
  if (exitAnim !== "none" && t >= exitStart) {
    const raw = (t - exitStart) / exitDur;
    const p = Math.max(0, Math.min(1, raw));
    const e = p * p; // ease-in
    switch (exitAnim) {
      case "fade":
        opacity *= 1 - e;
        break;
      case "slide-left":
        tx += e * -w;
        break;
      case "slide-right":
        tx += e * w;
        break;
      case "slide-up":
        ty += e * -h;
        break;
      case "slide-down":
        ty += e * h;
        break;
      case "zoom-out":
        sx *= Math.max(0.001, 1 - e);
        sy *= Math.max(0.001, 1 - e);
        break;
      case "blur-out":
        blur += e * 20;
        opacity *= 1 - e;
        break;
      case "flip-out":
        // preview は 3D rotateY だが Canvas 2D は 3D 不可。scaleX で近似
        sx *= Math.max(0.001, 1 - e);
        opacity *= 1 - e;
        break;
      case "stretch-out":
        sx *= Math.max(0.001, 1 - e);
        opacity *= 1 - e;
        break;
      case "roll-out":
        tx += e * w;
        rot += (e * 180 * Math.PI) / 180;
        opacity *= 1 - e;
        break;
    }
  }

  // ---- Ambient (常時かかるループ) ----
  // preview の computeLayerAmbientStyle と数式を一致させる。
  const ambient = layer.ambientAnimation ?? "none";
  if (ambient !== "none" && t >= layer.startSec && t < layer.endSec) {
    const k = Math.max(0, Math.min(2, layer.ambientIntensity ?? 1));
    switch (ambient) {
      case "pulse": {
        const s = 1 + 0.05 * k * Math.sin(t * Math.PI * 2);
        sx *= s;
        sy *= s;
        break;
      }
      case "shake": {
        tx += Math.sin(t * 30) * 2 * k;
        ty += Math.cos(t * 33) * 1.5 * k;
        break;
      }
      case "wiggle": {
        rot += (Math.sin(t * Math.PI * 2) * 2 * k * Math.PI) / 180;
        break;
      }
      case "bounce": {
        ty += -Math.abs(Math.sin(t * Math.PI * 2)) * 4 * k;
        break;
      }
      case "blink": {
        opacity *= Math.sin(t * Math.PI * 4) > 0 ? 1 : 0.3 + 0.7 * (1 - k);
        break;
      }
      case "float": {
        ty += Math.sin(t * Math.PI) * 3 * k;
        break;
      }
      case "rainbow": {
        hueDeg = (t * 60) % 360;
        break;
      }
      case "glow-pulse": {
        glowBlur = 4 + Math.sin(t * Math.PI * 2) * 4 * k;
        glowColor = "rgba(255,230,0,0.9)";
        break;
      }
    }
  }

  if (
    opacity === 1 &&
    tx === 0 &&
    ty === 0 &&
    sx === 1 &&
    sy === 1 &&
    rot === 0 &&
    blur === 0 &&
    hueDeg === 0 &&
    glowBlur === 0
  ) {
    return IDENTITY;
  }
  return { opacity, tx, ty, sx, sy, rot, blur, hueDeg, glowBlur, glowColor };
}

/**
 * ctx に anim 変換を適用する。
 * ctx は呼び出し前にレイヤー左上 (= 描画原点) に translate 済みであること。
 * w, h はレイヤーピクセル寸法。
 *
 * CSS の `transform-origin: 50% 50%` (デフォルト) を再現するため、scale/rotate は
 * 中心経由 (translate(w/2, h/2) → scale/rotate → translate(-w/2, -h/2)) で適用する。
 */
export function applyCanvasAnim(
  ctx: CanvasRenderingContext2D,
  anim: CanvasAnimTransform,
  w: number,
  h: number,
): void {
  if (anim === IDENTITY) return;
  if (anim.opacity !== 1) ctx.globalAlpha *= anim.opacity;
  if (anim.tx !== 0 || anim.ty !== 0) ctx.translate(anim.tx, anim.ty);
  if (anim.sx !== 1 || anim.sy !== 1 || anim.rot !== 0) {
    ctx.translate(w / 2, h / 2);
    if (anim.rot !== 0) ctx.rotate(anim.rot);
    if (anim.sx !== 1 || anim.sy !== 1) ctx.scale(anim.sx, anim.sy);
    ctx.translate(-w / 2, -h / 2);
  }
  // ctx.filter は blur + hue-rotate を 1 つの string で複数指定できる
  const filterParts: string[] = [];
  if (anim.blur > 0) filterParts.push(`blur(${anim.blur.toFixed(2)}px)`);
  if (anim.hueDeg !== 0) filterParts.push(`hue-rotate(${anim.hueDeg.toFixed(0)}deg)`);
  if (anim.glowBlur > 0) {
    filterParts.push(
      `drop-shadow(0 0 ${anim.glowBlur.toFixed(1)}px ${anim.glowColor})`,
    );
  }
  if (filterParts.length > 0) ctx.filter = filterParts.join(" ");
}
