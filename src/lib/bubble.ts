import type { BubbleShape, BubbleStyle } from "../types";

/**
 * 吹き出し（バルーン本体 + しっぽ）の SVG path 文字列を生成する。
 * プレビュー（SVG）とエクスポート（Canvas Path2D）で同じロジックを共有する。
 *
 * 座標系: レイヤー左上原点、幅 w / 高さ h のピクセル空間。
 */

/** バルーン本体の path（閉じた形） */
export function bubbleBodyPath(
  w: number,
  h: number,
  shape: BubbleShape,
  borderRadius: number = 12,
): string {
  switch (shape) {
    case "rect":
      return `M 0 0 H ${w} V ${h} H 0 Z`;
    case "rounded": {
      const r = Math.max(0, Math.min(borderRadius, w / 2, h / 2));
      return [
        `M ${r} 0`,
        `H ${w - r}`,
        `Q ${w} 0 ${w} ${r}`,
        `V ${h - r}`,
        `Q ${w} ${h} ${w - r} ${h}`,
        `H ${r}`,
        `Q 0 ${h} 0 ${h - r}`,
        `V ${r}`,
        `Q 0 0 ${r} 0`,
        "Z",
      ].join(" ");
    }
    case "ellipse": {
      const rx = w / 2;
      const ry = h / 2;
      return [
        `M 0 ${ry}`,
        `A ${rx} ${ry} 0 0 1 ${w} ${ry}`,
        `A ${rx} ${ry} 0 0 1 0 ${ry}`,
        "Z",
      ].join(" ");
    }
    case "cloud":
      return makeCloudPath(w, h);
    default:
      return `M 0 0 H ${w} V ${h} H 0 Z`;
  }
}

/**
 * 雲形（漫画風の吹き出し）。楕円を基準に外側へスカラップを生やす。
 */
function makeCloudPath(w: number, h: number): string {
  const bumps = 10;
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const bumpDepth = Math.min(w, h) * 0.08;
  let d = "";
  for (let i = 0; i < bumps; i++) {
    const a1 = (i / bumps) * Math.PI * 2;
    const a2 = ((i + 0.5) / bumps) * Math.PI * 2;
    const a3 = ((i + 1) / bumps) * Math.PI * 2;
    const x1 = cx + (rx - bumpDepth) * Math.cos(a1);
    const y1 = cy + (ry - bumpDepth) * Math.sin(a1);
    const x2 = cx + (rx + bumpDepth) * Math.cos(a2);
    const y2 = cy + (ry + bumpDepth) * Math.sin(a2);
    const x3 = cx + (rx - bumpDepth) * Math.cos(a3);
    const y3 = cy + (ry - bumpDepth) * Math.sin(a3);
    if (i === 0) d += `M ${x1.toFixed(2)} ${y1.toFixed(2)} `;
    d += `Q ${x2.toFixed(2)} ${y2.toFixed(2)} ${x3.toFixed(2)} ${y3.toFixed(2)} `;
  }
  d += "Z";
  return d;
}

/**
 * しっぽ先端 (tipX, tipY) から見た、バルーン外周上の最も近い点（根元中心）を求める。
 * 戻り値の tangent はその点での外周接線方向（単位ベクトル）。
 */
function findAnchorOnOutline(
  shape: BubbleShape,
  w: number,
  h: number,
  tipX: number,
  tipY: number,
): { x: number; y: number; tangent: { x: number; y: number } } {
  const cx = w / 2;
  const cy = h / 2;
  const dx = tipX - cx;
  const dy = tipY - cy;

  if (shape === "ellipse" || shape === "cloud") {
    // 楕円外周との交点（cloud も楕円で近似）
    const a = w / 2;
    const b = h / 2;
    const denom = Math.sqrt((dx / a) ** 2 + (dy / b) ** 2) || 1;
    const t = 1 / denom;
    const ax = cx + dx * t;
    const ay = cy + dy * t;
    // 接線は外周方向と垂直
    const tx = -dy / denom;
    const ty = dx / denom;
    const len = Math.hypot(tx, ty) || 1;
    return { x: ax, y: ay, tangent: { x: tx / len, y: ty / len } };
  }

  // rect / rounded: 矩形輪郭との交点（corner の丸みは無視して近似）
  const absDx = Math.abs(dx) || 1e-6;
  const absDy = Math.abs(dy) || 1e-6;
  const scaleX = (w / 2) / absDx;
  const scaleY = (h / 2) / absDy;
  const scale = Math.min(scaleX, scaleY);
  const ax = cx + dx * scale;
  const ay = cy + dy * scale;
  const tangent = scaleX < scaleY ? { x: 0, y: 1 } : { x: 1, y: 0 };
  return { x: ax, y: ay, tangent };
}

/** しっぽの三角形 path（単体） */
function tailPath(
  shape: BubbleShape,
  w: number,
  h: number,
  tail: NonNullable<BubbleStyle["tail"]>,
): string {
  const tipX = (tail.tipX / 100) * w;
  const tipY = (tail.tipY / 100) * h;
  const a = findAnchorOnOutline(shape, w, h, tipX, tipY);
  const halfBase = ((tail.baseWidth / 100) * Math.min(w, h)) / 2;
  const b1x = a.x + a.tangent.x * halfBase;
  const b1y = a.y + a.tangent.y * halfBase;
  const b2x = a.x - a.tangent.x * halfBase;
  const b2y = a.y - a.tangent.y * halfBase;
  return `M ${b1x.toFixed(2)} ${b1y.toFixed(2)} L ${tipX.toFixed(2)} ${tipY.toFixed(2)} L ${b2x.toFixed(2)} ${b2y.toFixed(2)} Z`;
}

/** バルーン本体 + しっぽの結合 path（fill-rule: nonzero 前提で両方塗られる） */
export function bubbleFullPath(
  w: number,
  h: number,
  style: BubbleStyle,
  borderRadius: number = 12,
): string {
  const body = bubbleBodyPath(w, h, style.shape, borderRadius);
  if (!style.tail) return body;
  const tail = tailPath(style.shape, w, h, style.tail);
  return `${body} ${tail}`;
}
