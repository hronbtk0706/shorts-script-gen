/**
 * 手書き風マーカー注釈（shape: "marker-*"）の幾何計算。
 *
 * preview (TemplateCanvas の MarkerShapeSvg) と export (layerComposer の drawMarkerShape) で
 * **同じストローク点列**を使い、見た目と出力を一致させる（arc-sweep と同じ要件）。
 *
 * - 座標は box ピクセル空間 [0..w] × [0..h]。
 * - 手書き揺れ(jitter)は seed = layer.id の決定論的擬似乱数 + 低周波 wobble で生成。
 *   毎フレーム乱数だとチカチカするので、フルストロークの揺れを先に確定してから draw-on で切り詰める。
 * - draw-on: 進捗 p (0..1) ぶんだけ各ストロークを描く。複数ストローク(check/cross/arrow head)は
 *   p の区間に割り当てて順番に現れる。
 * - 線の太さ・jitter 振幅は design(360) 基準なので呼び出し側 / ここで pxScale を掛ける。
 */

import type { Layer } from "../types";

export interface Pt {
  x: number;
  y: number;
}

export interface MarkerRender {
  /** 描くべきストローク（ポリライン）の配列。box px 座標。 */
  strokes: Pt[][];
  /** marker-arrow / marker-surge のヘッド（塗りつぶす三角形）。無ければ null。 */
  arrowHead: Pt[] | null;
  /** marker-surge 終端の着弾フラッシュ（box px）。無ければ null。 */
  flash?: { x: number; y: number; r: number; alpha: number } | null;
}

const DEFAULT_COLOR = "#FF3B30";

export function markerColor(layer: Layer): string {
  return layer.fillColor || DEFAULT_COLOR;
}

/** FNV-1a で文字列 → 32bit seed */
export function hashSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 決定論 PRNG */
export function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 低周波の滑らかな揺れ（2 つの正弦波の合成）。s は 0..1。 */
export function makeWobble(rng: () => number): (s: number) => number {
  const f1 = 1 + rng() * 1.5; // 1.0〜2.5 周
  const f2 = 2.5 + rng() * 2; // 2.5〜4.5 周
  const p1 = rng() * Math.PI * 2;
  const p2 = rng() * Math.PI * 2;
  const bias = (rng() - 0.5) * 0.4;
  return (s: number) =>
    Math.sin(s * Math.PI * 2 * f1 + p1) * 0.6 +
    Math.sin(s * Math.PI * 2 * f2 + p2) * 0.4 +
    bias;
}

/** 折れ線を法線方向に wobble させた点列を生成（端は揺れを絞ってラフだが破綻させない）。 */
function jitterLine(
  a: Pt,
  b: Pt,
  amp: number,
  n: number,
  wob: (s: number) => number,
): Pt[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len; // 法線
  const ny = dx / len;
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const s = i / (n - 1);
    const taper = Math.sin(Math.min(1, s) * Math.PI); // 端で 0、中央で 1
    const off = wob(s) * amp * (0.35 + 0.65 * taper);
    pts.push({
      x: a.x + dx * s + nx * off,
      y: a.y + dy * s + ny * off,
    });
  }
  return pts;
}

/** 楕円ループを半径方向に wobble させた点列（startAng から sweepAng ぶん）。 */
function jitterEllipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  startAng: number,
  sweepAng: number,
  amp: number,
  n: number,
  wob: (s: number) => number,
): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const s = i / (n - 1);
    const ang = startAng + sweepAng * s;
    const off = wob(s) * amp;
    pts.push({
      x: cx + Math.cos(ang) * (rx + off),
      y: cy + Math.sin(ang) * (ry + off),
    });
  }
  return pts;
}

/** 点列を進捗 lp(0..1) ぶんに切り詰める（最後のセグメントは線形補間）。 */
export function truncate(pts: Pt[], lp: number): Pt[] {
  if (lp >= 1) return pts;
  if (lp <= 0) return [];
  const n = pts.length;
  const fidx = lp * (n - 1);
  const idx = Math.floor(fidx);
  const frac = fidx - idx;
  const out = pts.slice(0, idx + 1);
  if (idx + 1 < n && frac > 0) {
    const a = pts[idx];
    const b = pts[idx + 1];
    out.push({ x: a.x + (b.x - a.x) * frac, y: a.y + (b.y - a.y) * frac });
  }
  return out.length >= 2 ? out : [];
}

/** [start,end] 窓の中で全体進捗 p をローカル進捗に変換 */
export function localP(p: number, start: number, end: number): number {
  if (p <= start) return 0;
  if (p >= end) return 1;
  return (p - start) / (end - start);
}

/**
 * マーカー注釈の描画ストロークを算出。
 * @param w,h box ピクセル寸法
 * @param p draw-on 進捗 0..1（静的表示は 1）
 * @param pxScale design(360)→描画解像度の係数（jitter 振幅用）。preview=canvasWPx/360, export=FINAL_W/360
 */
export function computeMarker(
  layer: Layer,
  w: number,
  h: number,
  p: number,
  pxScale: number,
): MarkerRender {
  const rng = mulberry32(hashSeed(layer.id || "marker"));
  const wob = makeWobble(rng);
  const roughness = Math.max(0, Math.min(2, layer.markerRoughness ?? 1));
  const amp = roughness * 3 * pxScale; // design 3px 基準の揺れ
  const m = Math.min(w, h) * 0.1; // box 内マージン
  const cx = w / 2;
  const cy = h / 2;
  const shape = layer.shape;

  const strokes: Pt[][] = [];
  let arrowHead: Pt[] | null = null;
  let flash: MarkerRender["flash"] = null;

  switch (shape) {
    case "marker-circle": {
      const rx = Math.max(2, w / 2 - m);
      const ry = Math.max(2, h / 2 - m);
      const full = jitterEllipse(
        cx,
        cy,
        rx,
        ry,
        -Math.PI / 2,
        Math.PI * 2 * 1.08, // 1 周ちょいオーバーラップ
        amp,
        72,
        wob,
      );
      const t = truncate(full, p);
      if (t.length) strokes.push(t);
      break;
    }
    case "marker-arrow":
    case "marker-line": {
      const from = layer.markerFrom ?? { x: 15, y: 85 };
      const to = layer.markerTo ?? { x: 85, y: 15 };
      const a: Pt = { x: (from.x / 100) * w, y: (from.y / 100) * h };
      const b: Pt = { x: (to.x / 100) * w, y: (to.y / 100) * h };
      const full = jitterLine(a, b, amp * 0.6, 40, wob);
      const head =
        layer.markerHead ?? (shape === "marker-arrow" ? "triangle" : "none");
      if (head === "open") {
        // open: 矢じりも draw-on で手書きする。進捗を 軸(0〜0.8)→barb左(0.8〜0.9)→
        // barb右(0.9〜1.0) に割り当て、ペンが軸を描いてから矢じり2本を続けて描く。
        const ts = truncate(full, localP(p, 0, 0.8));
        if (ts.length) strokes.push(ts);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const px = -uy;
        const py = ux;
        const hd = Math.min(Math.max(len * 0.2, 12 * pxScale), 42 * pxScale);
        const wide = hd * 0.6;
        const tip: Pt = { x: b.x, y: b.y };
        const left: Pt = {
          x: b.x - ux * hd + px * wide,
          y: b.y - uy * hd + py * wide,
        };
        const right: Pt = {
          x: b.x - ux * hd - px * wide,
          y: b.y - uy * hd - py * wide,
        };
        // barb は「先端 → 外側」の向きに描く（ペン先が tip から払うイメージ）。
        const tl = truncate(jitterLine(tip, left, amp * 0.5, 6, wob), localP(p, 0.8, 0.9));
        const trb = truncate(jitterLine(tip, right, amp * 0.5, 6, wob), localP(p, 0.9, 1));
        if (tl.length) strokes.push(tl);
        if (trb.length) strokes.push(trb);
      } else {
        const t = truncate(full, p);
        if (t.length) strokes.push(t);
        // ヘッド有無: arrow 既定 triangle / line 既定 none。p>=0.85 で塗り三角を出す
        if (head === "triangle" && p >= 0.85) {
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          const ux = dx / len;
          const uy = dy / len;
          const px = -uy;
          const py = ux;
          const hd = Math.min(Math.max(len * 0.22, 12 * pxScale), 46 * pxScale);
          const back = hd * 0.9;
          const wide = hd * 0.5;
          arrowHead = [
            { x: b.x, y: b.y },
            { x: b.x - ux * back + px * wide, y: b.y - uy * back + py * wide },
            { x: b.x - ux * back - px * wide, y: b.y - uy * back - py * wide },
          ];
        }
      }
      break;
    }
    case "marker-surge": {
      // ④ 数値サージ: markerFrom→markerTo を急加速(expo-out)で一気に描く折れ線/矢印。
      // 入力 p（draw-on 線形進捗）を expo-out に再マップしてから truncate するので、
      // preview/export は同じ p で呼べば同じ見た目になる（イージングはここに集約）。
      const from = layer.markerFrom ?? { x: 12, y: 88 };
      const to = layer.markerTo ?? { x: 88, y: 12 };
      const a: Pt = { x: (from.x / 100) * w, y: (from.y / 100) * h };
      const b: Pt = { x: (to.x / 100) * w, y: (to.y / 100) * h };
      const overshoot = Math.max(0, Math.min(0.5, layer.markerOvershoot ?? 0.1));
      const bOver: Pt = {
        x: b.x + (b.x - a.x) * overshoot,
        y: b.y + (b.y - a.y) * overshoot,
      };
      // 方向・矢じり寸法を先に確定（線を矢じり根元で止めるのに使う）。
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const px = -uy;
      const py = ux;
      const head = layer.markerHead ?? "triangle";
      const hd = Math.min(Math.max(len * 0.18, 14 * pxScale), 52 * pxScale);
      const back = hd * 0.95;
      const wide = hd * 0.5;
      // 急加速イージング: expo-out。reach は b=1.0 / bOver=1+overshoot の単位。
      const ep = p >= 1 ? 1 : 1 - Math.pow(2, -10 * p);
      const reach =
        ep < 0.82
          ? ep / 0.82
          : 1 + overshoot * (1 - (ep - 0.82) / 0.18);
      let lineLen = reach / (1 + overshoot); // 静止時 tip=b
      // 矢じりを出すときは線を「矢じりの根元」で止める（半透明ヘッドを線が透けて
      // 突き抜けて見えるのを防ぐ）。base は a→bOver 上で (len-back) の位置。
      const showHead = head === "triangle" && ep >= 0.6;
      if (showHead) {
        const baseFrac = Math.max(0, (len - back) / (len * (1 + overshoot)));
        lineLen = Math.min(lineLen, baseFrac);
      }
      const full = jitterLine(a, bOver, amp * 0.1, 48, wob);
      const tr = truncate(full, lineLen);
      if (tr.length) strokes.push(tr);
      if (showHead) {
        arrowHead = [
          { x: b.x, y: b.y },
          { x: b.x - ux * back + px * wide, y: b.y - uy * back + py * wide },
          { x: b.x - ux * back - px * wide, y: b.y - uy * back - py * wide },
        ];
      }
      // 着弾フラッシュ: 描き終わり間際(ep 0.78→1)に閃光が咲いて消える（完了後 p=1→0 で消灯）。
      const fa = ep < 0.78 ? 0 : Math.sin(((ep - 0.78) / 0.22) * Math.PI);
      if (fa > 0.001) {
        flash = { x: b.x, y: b.y, r: Math.max(8, 26 * pxScale), alpha: fa };
      }
      break;
    }
    case "marker-graph": {
      // 折れ線グラフ: graphData を箱内に min..max でスケールして結ぶ。draw-on は p で truncate。
      const data = layer.graphData ?? [];
      if (data.length >= 2) {
        const gm = Math.min(w, h) * 0.08; // 箱内マージン
        let minV = Infinity;
        let maxV = -Infinity;
        for (const v of data) {
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
        }
        const range = maxV - minV || 1;
        const left = gm;
        const right = w - gm;
        const top = gm;
        const bottom = h - gm;
        const pts: Pt[] = data.map((v, idx) => ({
          x: left + (idx / (data.length - 1)) * (right - left),
          y: bottom - ((v - minV) / range) * (bottom - top), // 下=小 / 上=大
        }));
        // 各区間をサンプリングして jitter を乗せつつ 1 本のポリラインに連結（truncate がスムーズ）。
        const full: Pt[] = [];
        for (let s = 0; s < pts.length - 1; s++) {
          const seg = jitterLine(pts[s], pts[s + 1], amp * 0.4, 6, wob);
          if (s === 0) full.push(...seg);
          else full.push(...seg.slice(1));
        }
        const t = truncate(full, p);
        if (t.length) strokes.push(t);
      }
      break;
    }
    case "marker-underline": {
      const y = cy + (h / 2 - m) * 0.55;
      const full = jitterLine({ x: m, y }, { x: w - m, y }, amp, 36, wob);
      const t = truncate(full, p);
      if (t.length) strokes.push(t);
      break;
    }
    case "marker-strike": {
      const full = jitterLine({ x: m, y: cy }, { x: w - m, y: cy }, amp, 36, wob);
      const t = truncate(full, p);
      if (t.length) strokes.push(t);
      break;
    }
    case "marker-check": {
      // レ点: 短い下降 → 長い上昇
      const valley: Pt = { x: cx - w * 0.05, y: cy + (h / 2 - m) * 0.55 };
      const sa = jitterLine(
        { x: cx - w * 0.28, y: cy },
        valley,
        amp * 0.7,
        16,
        wob,
      );
      const sb = jitterLine(
        valley,
        { x: cx + w * 0.32, y: cy - (h / 2 - m) * 0.8 },
        amp * 0.7,
        28,
        wob,
      );
      const ta = truncate(sa, localP(p, 0, 0.35));
      const tb = truncate(sb, localP(p, 0.35, 1));
      if (ta.length) strokes.push(ta);
      if (tb.length) strokes.push(tb);
      break;
    }
    case "marker-cross": {
      const r = Math.min(w, h) / 2 - m;
      const sa = jitterLine(
        { x: cx - r, y: cy - r },
        { x: cx + r, y: cy + r },
        amp * 0.7,
        24,
        wob,
      );
      const sb = jitterLine(
        { x: cx + r, y: cy - r },
        { x: cx - r, y: cy + r },
        amp * 0.7,
        24,
        wob,
      );
      const ta = truncate(sa, localP(p, 0, 0.5));
      const tb = truncate(sb, localP(p, 0.5, 1));
      if (ta.length) strokes.push(ta);
      if (tb.length) strokes.push(tb);
      break;
    }
    case "marker-brackets": {
      // 四隅の [ ]（カメラ AF 風）。各隅は L 字（2 セグメント）。box 内側に少し寄せる。
      const x0 = m;
      const y0 = m;
      const x1 = w - m;
      const y1 = h - m;
      const armX = (x1 - x0) * 0.28; // アーム長
      const armY = (y1 - y0) * 0.28;
      // 各隅: [縦アーム終点, 角, 横アーム終点] の折れ線
      const corners: [Pt, Pt, Pt][] = [
        [{ x: x0, y: y0 + armY }, { x: x0, y: y0 }, { x: x0 + armX, y: y0 }], // 左上
        [{ x: x1 - armX, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y0 + armY }], // 右上
        [{ x: x1, y: y1 - armY }, { x: x1, y: y1 }, { x: x1 - armX, y: y1 }], // 右下
        [{ x: x0 + armX, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y1 - armY }], // 左下
      ];
      corners.forEach((c, i) => {
        const seg1 = jitterLine(c[0], c[1], amp * 0.5, 8, wob);
        const seg2 = jitterLine(c[1], c[2], amp * 0.5, 8, wob);
        const full = seg1.concat(seg2.slice(1));
        const lp = localP(p, i / 4, (i + 1) / 4);
        const tr = truncate(full, lp);
        if (tr.length) strokes.push(tr);
      });
      break;
    }
    case "marker-burst": {
      // 集中線: 焦点(中心)へ向かう放射状ラフ線。count 本を内側リング→外側へ。
      const count = Math.max(3, Math.min(60, Math.round(layer.markerCount ?? 12)));
      const rxOuter = w / 2 - m * 0.3;
      const ryOuter = h / 2 - m * 0.3;
      const innerRatio = 0.45; // 焦点まわりは空ける
      for (let i = 0; i < count; i++) {
        const ang = (i / count) * Math.PI * 2 + (rng() - 0.5) * 0.15;
        const dirx = Math.cos(ang);
        const diry = Math.sin(ang);
        const inner: Pt = {
          x: cx + dirx * rxOuter * innerRatio,
          y: cy + diry * ryOuter * innerRatio,
        };
        const outer: Pt = { x: cx + dirx * rxOuter, y: cy + diry * ryOuter };
        const full = jitterLine(inner, outer, amp * 0.4, 8, wob);
        // 本ごとに僅かな時間差で 0→1 に伸びる
        const lp = localP(p, (i / count) * 0.3, 1);
        const tr = truncate(full, lp);
        if (tr.length) strokes.push(tr);
      }
      break;
    }
    default:
      break;
  }

  return { strokes, arrowHead, flash };
}

/** shape が marker-* かどうか */
export function isMarkerShape(shape: LayerShapeLike): boolean {
  return typeof shape === "string" && shape.startsWith("marker-");
}
type LayerShapeLike = Layer["shape"];

/** ポリラインを SVG path の d 文字列に（preview 用） */
export function strokeToPath(pts: Pt[]): string {
  if (pts.length === 0) return "";
  let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) {
    d += ` L ${pts[i].x.toFixed(2)} ${pts[i].y.toFixed(2)}`;
  }
  return d;
}
