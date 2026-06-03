/**
 * curio-gen アニメ仕様 Phase2 §A6: per-layer filter（glow / blur / shadow）を
 * CSS/Canvas 共通の `filter` 文字列に変換する。preview(CSS filter)=export(ctx.filter) で同一。
 *
 * - glow: 発光。color + strength(0..1, alpha 化) の drop-shadow を発光感のため 2 回重ねる。
 * - blur: ぼかし。
 * - shadow: 影。color は #RRGGBBAA 可（そのまま drop-shadow へ）。
 * - tint: 着色は filter 文字列で表現困難なため**未対応**（型では受けるが無視）。
 *
 * px 値（radius/blur/dx/dy）は design(360) 基準。pxScale（preview=canvasWPx/360,
 * export=FINAL_W/360）で描画解像度へ換算する（他の px 振幅と同じ規約）。
 */

import type { Layer } from "../types";

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** #RGB / #RRGGBB / #RRGGBBAA を rgba() に変換（alpha は strength で上書き）。 */
function hexToRgba(hex: string, alpha: number): string {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (h.length >= 6) {
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
      return `rgba(${r},${g},${b},${clamp01(alpha).toFixed(3)})`;
    }
  }
  // 解釈不能ならそのまま（フォールバック）
  return hex;
}

/**
 * layer.filter を filter 文字列に。filter 無し / 有効項目無しなら ""。
 */
export function computeLayerFilterCss(layer: Layer, pxScale = 1): string {
  const f = layer.filter;
  if (!f) return "";
  const parts: string[] = [];
  if (f.shadow) {
    const dx = (f.shadow.dx ?? 0) * pxScale;
    const dy = (f.shadow.dy ?? 0) * pxScale;
    const b = Math.max(0, (f.shadow.blur ?? 0) * pxScale);
    const col = f.shadow.color ?? "rgba(0,0,0,0.5)";
    parts.push(
      `drop-shadow(${dx.toFixed(2)}px ${dy.toFixed(2)}px ${b.toFixed(2)}px ${col})`,
    );
  }
  if (f.glow) {
    const r = Math.max(0, (f.glow.radius ?? 8) * pxScale).toFixed(2);
    const col = hexToRgba(f.glow.color ?? "#FFFFFF", f.glow.strength ?? 1);
    // 1 回だと弱いので 2 回重ねて発光らしさを出す
    parts.push(`drop-shadow(0 0 ${r}px ${col})`);
    parts.push(`drop-shadow(0 0 ${r}px ${col})`);
  }
  if (f.blur) {
    parts.push(`blur(${Math.max(0, (f.blur.radius ?? 0) * pxScale).toFixed(2)}px)`);
  }
  // tint は未対応（§A6・filter 文字列で表現困難）。
  return parts.join(" ");
}
