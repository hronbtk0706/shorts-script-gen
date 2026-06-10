/**
 * icon プリミティブ（curio-gen 依頼書「icon プリミティブ」）の実行時ロジック。
 *
 * 同梱データ iconData.ts（Lucide / ISC・ビルド時にベイク）を元に、
 *   - preview(DOM): inline <svg> マークアップを返す（同期・ベクター）
 *   - export/headless(Canvas): SVG 要素を Path2D に変換して stroke 描画（同期・ベクター）
 * の両系統を **完全に同期** で描く。非同期ロード（Image/dataURL）は使わない
 * （依頼書 §54-56: 描画時の非同期は「間に合わず空白」事故になるため禁止）。
 *
 * 取りこぼし（未知名）は空白にせず placeholder（破線四角＋名前）を描き、warn でログする。
 */
import { ICON_BODIES, ICON_ALIASES } from "./iconData";
export { ICON_NAMES } from "./iconData";

export const ICON_VIEWBOX = 24;
const DEFAULT_STROKE_WIDTH = 2;

/** 別名解決して正式名を返す（同梱されているとは限らない）。 */
export function resolveIconName(name: string | undefined | null): string {
  const n = (name ?? "").trim();
  return ICON_ALIASES[n] ?? n;
}

/** その名前のアイコンを同梱しているか（別名込み）。 */
export function iconExists(name: string | undefined | null): boolean {
  return !!ICON_BODIES[resolveIconName(name)];
}

/** アイコンの inner markup（要素列）を返す。無ければ null。 */
function iconBody(name: string | undefined | null): string | null {
  return ICON_BODIES[resolveIconName(name)] ?? null;
}

// ---- inline SVG（curio が直書きする派生アイコン）のサニタイズ -------------
//   dangerouslySetInnerHTML / Canvas 双方で安全に扱うため、描画前に
//   shape 要素（export の elementToPrimitive が解釈する種類）＋幾何/塗り属性のみへ
//   絞り込む。<script> や on* ハンドラ・直接子でない要素（g 入れ子等）は捨てる。
//   こうすることで preview(DOM)=export(Canvas) で描かれる図形が完全一致する。
const _SHAPE_TAGS = new Set([
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
]);
const _ALLOWED_ATTRS = new Set([
  "d",
  "points",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "width",
  "height",
  "fill",
]);
const _sanitizeCache = new Map<string, string | null>();

/**
 * inline SVG inner markup を「直接子の shape 要素＋幾何/塗り属性」だけへ正規化する。
 * 不正・空・解釈不能なら null（呼び出し側は placeholder にフォールバック）。
 * export の elementToPrimitive が拾う要素と同じ集合へ絞るので preview=export を保証。
 */
export function sanitizeIconSvgBody(svg: string | undefined | null): string | null {
  const raw = (svg ?? "").trim();
  if (!raw) return null;
  if (_sanitizeCache.has(raw)) return _sanitizeCache.get(raw) ?? null;
  let result: string | null = null;
  try {
    const doc = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg">${raw}</svg>`,
      "image/svg+xml",
    );
    if (!doc.querySelector("parsererror")) {
      const root = doc.documentElement;
      const parts: string[] = [];
      for (let i = 0; i < root.children.length; i++) {
        const el = root.children[i];
        const tag = el.tagName.toLowerCase();
        if (!_SHAPE_TAGS.has(tag)) continue;
        const attrs: string[] = [];
        for (let j = 0; j < el.attributes.length; j++) {
          const a = el.attributes[j];
          const an = a.name.toLowerCase();
          if (!_ALLOWED_ATTRS.has(an)) continue;
          const av = a.value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
          attrs.push(`${an}="${av}"`);
        }
        parts.push(`<${tag}${attrs.length ? " " + attrs.join(" ") : ""}/>`);
      }
      result = parts.length > 0 ? parts.join("") : null;
    }
  } catch {
    result = null;
  }
  _sanitizeCache.set(raw, result);
  return result;
}

/**
 * preview(DOM) 用の完全な <svg> マークアップ。viewBox + preserveAspectRatio で
 * object-fit:contain（縦横比保持・中央・切れない）を満たす。
 * `inlineSvg` を渡すと名前解決の代わりにそれ（サニタイズ後）を inner markup として使う。
 * 未知名 / inline 解釈不能は null。
 */
export function buildIconSvgMarkup(
  name: string | undefined | null,
  color: string,
  strokeWidth = DEFAULT_STROKE_WIDTH,
  inlineSvg?: string | undefined | null,
): string | null {
  const body =
    inlineSvg != null && inlineSvg.trim() !== ""
      ? sanitizeIconSvgBody(inlineSvg)
      : iconBody(name);
  if (body == null) return null;
  const sw = strokeWidth > 0 ? strokeWidth : DEFAULT_STROKE_WIDTH;
  // style の color で fill="currentColor" の要素も color に解決させる。
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}" ` +
    `width="100%" height="100%" fill="none" stroke="${color}" stroke-width="${sw}" ` +
    `stroke-linecap="round" stroke-linejoin="round" preserveAspectRatio="xMidYMid meet" ` +
    `style="color:${color};display:block">${body}</svg>`
  );
}

// ---- Canvas 描画 ----------------------------------------------------------

interface IconPrimitive {
  path: Path2D;
  /** true=fill / false=stroke（Lucide は基本 stroke）。 */
  fill: boolean;
}

const _primCache = new Map<string, IconPrimitive[] | null>();
const _warned = new Set<string>();

/** "x1,y1 x2,y2 ..." / "x1 y1 x2 y2 ..." を数値配列へ。 */
function parsePoints(s: string): number[] {
  return s
    .trim()
    .split(/[\s,]+/)
    .map((v) => parseFloat(v))
    .filter((v) => Number.isFinite(v));
}

/** 角丸矩形を Path2D に積む（Path2D.roundRect 非依存の自前実装）。 */
function roundRectInto(
  p: Path2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  p.moveTo(x + rr, y);
  p.lineTo(x + w - rr, y);
  p.arcTo(x + w, y, x + w, y + rr, rr);
  p.lineTo(x + w, y + h - rr);
  p.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  p.lineTo(x + rr, y + h);
  p.arcTo(x, y + h, x, y + h - rr, rr);
  p.lineTo(x, y + rr);
  p.arcTo(x, y, x + rr, y, rr);
  p.closePath();
}

/** SVG 1 要素を Path2D（+ fill 判定）へ。未対応要素は null。 */
function elementToPrimitive(el: Element): IconPrimitive | null {
  const tag = el.tagName.toLowerCase();
  const num = (a: string): number => parseFloat(el.getAttribute(a) ?? "0") || 0;
  const fillAttr = el.getAttribute("fill");
  const fill = !!fillAttr && fillAttr !== "none";
  let path: Path2D | null = null;
  switch (tag) {
    case "path": {
      const d = el.getAttribute("d");
      if (d) path = new Path2D(d);
      break;
    }
    case "circle": {
      path = new Path2D();
      path.arc(num("cx"), num("cy"), num("r"), 0, Math.PI * 2);
      break;
    }
    case "ellipse": {
      path = new Path2D();
      path.ellipse(num("cx"), num("cy"), num("rx"), num("ry"), 0, 0, Math.PI * 2);
      break;
    }
    case "rect": {
      path = new Path2D();
      const rx = el.hasAttribute("rx") ? num("rx") : el.hasAttribute("ry") ? num("ry") : 0;
      roundRectInto(path, num("x"), num("y"), num("width"), num("height"), rx);
      break;
    }
    case "line": {
      path = new Path2D();
      path.moveTo(num("x1"), num("y1"));
      path.lineTo(num("x2"), num("y2"));
      break;
    }
    case "polyline":
    case "polygon": {
      const pts = parsePoints(el.getAttribute("points") ?? "");
      if (pts.length >= 4) {
        path = new Path2D();
        path.moveTo(pts[0], pts[1]);
        for (let i = 2; i + 1 < pts.length; i += 2) path.lineTo(pts[i], pts[i + 1]);
        if (tag === "polygon") path.closePath();
      }
      break;
    }
  }
  return path ? { path, fill } : null;
}

/** inner markup（要素列）→ Path2D プリミティブ列（幾何のみ・色非依存・body 文字列でキャッシュ）。 */
function bodyToPrimitives(body: string): IconPrimitive[] | null {
  if (_primCache.has(body)) return _primCache.get(body) ?? null;
  let prims: IconPrimitive[] | null = null;
  try {
    const doc = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`,
      "image/svg+xml",
    );
    const root = doc.documentElement;
    const out: IconPrimitive[] = [];
    for (let i = 0; i < root.children.length; i++) {
      const prim = elementToPrimitive(root.children[i]);
      if (prim) out.push(prim);
    }
    prims = out.length > 0 ? out : null;
  } catch {
    prims = null;
  }
  _primCache.set(body, prims);
  return prims;
}

/** 正式名 → Path2D プリミティブ列。未知名/parse 失敗は null。 */
function iconPrimitives(name: string | undefined | null): IconPrimitive[] | null {
  const body = ICON_BODIES[resolveIconName(name)];
  if (body == null) return null;
  return bodyToPrimitives(body);
}

/** inline SVG（サニタイズ後）→ Path2D プリミティブ列。空/不正は null。 */
function inlineSvgPrimitives(svg: string | undefined | null): IconPrimitive[] | null {
  const body = sanitizeIconSvgBody(svg);
  return body == null ? null : bodyToPrimitives(body);
}

/**
 * アイコンを Canvas のレイヤー箱 (0,0)-(boxW,boxH) に contain 描画する。
 * `strokeWidth` は 24-viewBox 単位（SVG と同じ。アイコン拡大に従って太さも拡大）。
 * 未知名は placeholder（破線四角＋名前）を描き warn ログ。preview の buildIconSvgMarkup と一致。
 */
export function drawIconOnCanvas(
  ctx: CanvasRenderingContext2D,
  name: string | undefined | null,
  boxW: number,
  boxH: number,
  color: string,
  strokeWidth = DEFAULT_STROKE_WIDTH,
  inlineSvg?: string | undefined | null,
): void {
  const prims =
    inlineSvg != null && inlineSvg.trim() !== ""
      ? inlineSvgPrimitives(inlineSvg)
      : iconPrimitives(name);
  if (!prims) {
    drawIconPlaceholder(ctx, name, boxW, boxH, color);
    return;
  }
  const sw = strokeWidth > 0 ? strokeWidth : DEFAULT_STROKE_WIDTH;
  // contain: 24x24 を箱に収める最大倍率（短辺フィット・中央寄せ）。
  const scale = Math.min(boxW / ICON_VIEWBOX, boxH / ICON_VIEWBOX);
  const offX = (boxW - ICON_VIEWBOX * scale) / 2;
  const offY = (boxH - ICON_VIEWBOX * scale) / 2;
  ctx.save();
  ctx.translate(offX, offY);
  ctx.scale(scale, scale);
  ctx.lineWidth = sw; // 24-unit 空間で指定 → scale と一緒に拡大（SVG stroke-width と同じ）
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  for (const prim of prims) {
    if (prim.fill) ctx.fill(prim.path);
    else ctx.stroke(prim.path);
  }
  ctx.restore();
}

/** 未知名の可視 placeholder（破線四角＋名前）。サイレントに消さない（authoring ミス検知）。 */
function drawIconPlaceholder(
  ctx: CanvasRenderingContext2D,
  name: string | undefined | null,
  boxW: number,
  boxH: number,
  color: string,
): void {
  const label = (name ?? "").trim() || "icon?";
  if (!_warned.has(label)) {
    _warned.add(label);
    console.warn(`[icon] 未知のアイコン名「${label}」（placeholder を描画）`);
  }
  ctx.save();
  const inset = Math.max(1, Math.min(boxW, boxH) * 0.04);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = Math.max(1, Math.min(boxW, boxH) * 0.02);
  ctx.setLineDash([ctx.lineWidth * 3, ctx.lineWidth * 2]);
  ctx.strokeRect(inset, inset, boxW - inset * 2, boxH - inset * 2);
  ctx.setLineDash([]);
  const fontPx = Math.max(8, Math.min(boxH * 0.18, boxW / Math.max(4, label.length) * 1.4));
  ctx.fillStyle = color;
  ctx.font = `${fontPx}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, boxW / 2, boxH / 2, boxW - inset * 2);
  ctx.restore();
}
