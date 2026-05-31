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
  /** スケール */
  sx: number;
  sy: number;
  /** scale/rotate の原点 (レイヤー w/h に対する 0..1 の割合、デフォルト 0.5 = 中心)。
   * grow-* の CSS transform-origin (端から伸びる) を Canvas で再現するために使う。 */
  originX: number;
  originY: number;
  /** 回転 (radians) */
  rot: number;
  /** flip (Y軸回り) の回転角 (度)。0 = flat。!=0 のとき呼び出し側が perspective rotateY を
   * 列スライス warp で正確に再現する（Canvas 2D の scale では 2D 近似になるため別扱い）。 */
  flipDeg: number;
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
  originX: 0.5,
  originY: 0.5,
  rot: 0,
  flipDeg: 0,
  blur: 0,
  hueDeg: 0,
  glowBlur: 0,
  glowColor: "",
};

/**
 * 入退場アニメーション + Ambient エフェクトを合成した変換を返す。
 * w/h はレイヤーピクセル寸法 (% の slide を実 px に変換するため必要)。
 * pxScale は ambient の絶対 px 振幅 (shake/bounce/float/glow) を design 基準(360)から
 * 描画解像度へ換算する係数 = 描画幅/360。preview の computeLayerAmbientStyle に
 * 渡す fontScale (canvasWPx/360) と一致させること（frame 比で同じ揺れ幅にする）。
 */
export function computeCanvasAnim(
  layer: Layer,
  t: number,
  w: number,
  h: number,
  pxScale = 1,
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
  let originX = 0.5;
  let originY = 0.5;
  let rot = 0;
  let flipDeg = 0;
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
        // preview の perspective(500px) rotateY((1-e)*90deg) を flipDeg で表現し、
        // 呼び出し側 (drawLayer) が列スライス warp で正確に再現する。
        flipDeg = (1 - e) * 90;
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
      // 「ちゃんと伸びる」: opacity を維持して端から伸ばす（棒グラフ用）。
      // preview computeLayerAnimStyle の transform-origin と一致させる。
      case "grow-up": // transform-origin: center bottom
        sy = Math.max(0.001, e);
        originY = 1;
        break;
      case "grow-down": // transform-origin: center top
        sy = Math.max(0.001, e);
        originY = 0;
        break;
      case "grow-right": // transform-origin: left center
        sx = Math.max(0.001, e);
        originX = 0;
        break;
      case "grow-left": // transform-origin: right center
        sx = Math.max(0.001, e);
        originX = 1;
        break;
      case "arc-sweep":
        // arcEnd の補間は drawArcShape 側で行う（shape:"arc" 専用）。
        // ここでは transform 無し / opacity 1 維持で「描かれていく」ように見せる。
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
        // preview の perspective(500px) rotateY(e*90deg) を flipDeg で表現（warp で再現）
        flipDeg = e * 90;
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
        // 絶対 px 振幅は design(360) 基準 → 描画解像度へ pxScale 換算
        tx += Math.sin(t * 30) * 2 * k * pxScale;
        ty += Math.cos(t * 33) * 1.5 * k * pxScale;
        break;
      }
      case "wiggle": {
        rot += (Math.sin(t * Math.PI * 2) * 2 * k * Math.PI) / 180;
        break;
      }
      case "bounce": {
        ty += -Math.abs(Math.sin(t * Math.PI * 2)) * 4 * k * pxScale;
        break;
      }
      case "blink": {
        opacity *= Math.sin(t * Math.PI * 4) > 0 ? 1 : 0.3 + 0.7 * (1 - k);
        break;
      }
      case "float": {
        ty += Math.sin(t * Math.PI) * 3 * k * pxScale;
        break;
      }
      case "rainbow": {
        hueDeg = (t * 60) % 360;
        break;
      }
      case "glow-pulse": {
        glowBlur = (4 + Math.sin(t * Math.PI * 2) * 4 * k) * pxScale;
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
    flipDeg === 0 &&
    blur === 0 &&
    hueDeg === 0 &&
    glowBlur === 0
  ) {
    return IDENTITY;
  }
  return {
    opacity,
    tx,
    ty,
    sx,
    sy,
    originX,
    originY,
    rot,
    flipDeg,
    blur,
    hueDeg,
    glowBlur,
    glowColor,
  };
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
    // transform-origin (デフォルト中心 0.5/0.5、grow-* は端) を基準に scale/rotate
    const ox = anim.originX * w;
    const oy = anim.originY * h;
    ctx.translate(ox, oy);
    if (anim.rot !== 0) ctx.rotate(anim.rot);
    if (anim.sx !== 1 || anim.sy !== 1) ctx.scale(anim.sx, anim.sy);
    ctx.translate(-ox, -oy);
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

/** カメラモーション (motion) の変換。scale は中心原点、tx/ty はレイヤー w/h に対する割合
 * (CSS translate % / 100 と同基準)。preview / export 共通の単一実装。 */
export interface MotionTransform {
  scale: number;
  txFrac: number;
  tyFrac: number;
}

const MOTION_IDENTITY: MotionTransform = { scale: 1, txFrac: 0, tyFrac: 0 };

/**
 * layer.motion (ken_burns / pan_* / zoom_* / push_in / zoom_punch / shake) の変換を数値で返す。
 * preview の computeLayerMotionTransform は CSS 文字列に整形し、export の drawLayer は applyMotion で
 * ctx に適用する。式は両系統で必ず一致させること。
 */
export function computeMotion(
  layer: Layer,
  currentTimeSec: number,
): MotionTransform {
  const motion = layer.motion;
  if (!motion || motion === "static") return MOTION_IDENTITY;
  const dur = Math.max(0.01, layer.endSec - layer.startSec);
  const tRaw = (currentTimeSec - layer.startSec) / dur;
  const t = Math.max(0, Math.min(1, tRaw));
  switch (motion) {
    case "zoom_in":
      return { scale: 1 + 0.2 * t, txFrac: 0, tyFrac: 0 };
    case "zoom_out":
      return { scale: 1.2 - 0.2 * t, txFrac: 0, tyFrac: 0 };
    case "pan_left":
      return { scale: 1.15, txFrac: (0.5 - t) * 0.08, tyFrac: 0 };
    case "pan_right":
      return { scale: 1.15, txFrac: (t - 0.5) * 0.08, tyFrac: 0 };
    case "pan_up":
      return { scale: 1.15, txFrac: 0, tyFrac: (0.5 - t) * 0.08 };
    case "pan_down":
      return { scale: 1.15, txFrac: 0, tyFrac: (t - 0.5) * 0.08 };
    case "ken_burns":
      return {
        scale: 1 + 0.15 * t,
        txFrac: (t - 0.5) * 0.04,
        tyFrac: (t - 0.5) * 0.04,
      };
    case "push_in":
      return { scale: 1 + 0.25 * t * t, txFrac: 0, tyFrac: 0 };
    case "zoom_punch": {
      const phase = Math.min(1, tRaw * 3);
      const pulse = Math.sin(phase * Math.PI) * 0.1;
      return { scale: 1 + pulse, txFrac: 0, tyFrac: 0 };
    }
    case "shake": {
      const f = currentTimeSec * 30;
      return {
        scale: 1,
        txFrac: Math.sin(f) * 0.005,
        tyFrac: Math.cos(f * 1.3) * 0.005,
      };
    }
    default:
      return MOTION_IDENTITY;
  }
}

/**
 * ctx にカメラモーションを適用（ctx はレイヤー左上に translate 済み、w/h はレイヤー px）。
 * CSS `scale(s) translate(tx%, ty%)` と同じ合成（scale を中心原点で外側に、translate を内側に）。
 */
export function applyMotion(
  ctx: CanvasRenderingContext2D,
  m: MotionTransform,
  w: number,
  h: number,
): void {
  if (m.scale === 1 && m.txFrac === 0 && m.tyFrac === 0) return;
  if (m.scale !== 1) {
    ctx.translate(w / 2, h / 2);
    ctx.scale(m.scale, m.scale);
    ctx.translate(-w / 2, -h / 2);
  }
  if (m.txFrac !== 0 || m.tyFrac !== 0) {
    ctx.translate(m.txFrac * w, m.tyFrac * h);
  }
}
