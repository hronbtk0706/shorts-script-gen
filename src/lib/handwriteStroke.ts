/**
 * 手書き「筆順」テキスト（write-on）の幾何計算。
 *
 * preview（合成キャンバス＝書き出し経路）と export（WebCodecs）は同じ drawHandwriteShape
 * → computeHandwrite を通るので、見た目は自動的に一致する（markerShape と同じ単一レンダラ思想）。
 *
 * - 文字列をセルに並べ（行折返し・中央寄せ）、各文字を getGlyph で筆順ストロークに解決。
 * - 全ストロークを書き順に 1 列化し、各画の長さで重み付けした進捗窓に割り当て、
 *   marker の truncate/localP で「一画ずつ順に描く」を実現（draw-on の一般化）。
 * - 字形データが無い文字は char-sweep（左→右クリップ出現）にフォールバック。
 * - ペン先（チョーク/ペン/マーカー）は現在描いている画の先端に乗る。
 * - jitter は seed=layer.id の決定論（preview/export 一致・先付けしてから truncate）。
 */

import type { HandwriteTip, Layer, SurfaceKind } from "../types";
import {
  getAsciiBaselineNorm,
  getGlyph,
  type GlyphStrokes,
  type Pt,
} from "./handwriteGlyphs";
import { hashSeed, localP, makeWobble, mulberry32, truncate } from "./markerShape";

/** 文字列の幅を測る関数（フォント込み）。preview/export から ctx.measureText を注入。 */
export type MeasureFn = (text: string, fontPx: number) => number;

export interface HandwriteRender {
  /** 描くべきストローク（truncate 済みポリライン・box px）。 */
  strokes: Pt[][];
  /** ペン先（現在描いている画の先端）。idle / 完成時は null。 */
  penTip: { x: number; y: number; angle: number } | null;
  /** char-sweep フォールバック文字（box px・clip=0..1 の左→右出現率）。 */
  sweeps: { x: number; y: number; w: number; h: number; clip: number; ch: string; fontPx: number }[];
  /** notebook 罫線などの基準にする各行のベースライン Y（box px）。 */
  lineBaselines: number[];
  /** 書き上がり総秒（caller が p を時間から作る用にも使える）。 */
  writeDur: number;
}

export interface SurfacePreset {
  /** 背景塗り（null＝透明）。 */
  bg: string | null;
  /** 既定インク色（fontColor 未指定時）。 */
  ink: string;
  /** 既定ペン先。 */
  tip: HandwriteTip;
  /** 枠線色（whiteboard）。 */
  border?: string;
  /** ノート罫線を描くか。 */
  rule?: boolean;
}

export const SURFACE_PRESETS: Record<SurfaceKind, SurfacePreset> = {
  none: { bg: null, ink: "#FFFFFF", tip: "pen" },
  blackboard: { bg: "#2E3D34", ink: "#FAFAF0", tip: "chalk" },
  whiteboard: { bg: "#FAFAFA", ink: "#2B6CB0", tip: "marker", border: "#DDDDDD" },
  notebook: { bg: "#FFFEF7", ink: "#1A237E", tip: "pen", rule: true },
};

export function hasHandwrite(layer: Layer): boolean {
  return !!layer.handwrite;
}

/** surface プリセット＋レイヤー上書きから ink/tip/preset を解決。 */
export function resolveSurface(layer: Layer): {
  preset: SurfacePreset;
  ink: string;
  tip: HandwriteTip;
} {
  const preset = SURFACE_PRESETS[layer.surface ?? "none"];
  const ink = layer.fontColor ?? preset.ink;
  const tip = layer.handwrite?.tip ?? preset.tip;
  return { preset, ink, tip };
}

// ---- 内部ヘルパ ----

/** ポリラインを進捗 lp(0..1) の位置で補間し、点＋接線角を返す（truncate と同じ index 基準）。 */
function pointAtFraction(pts: Pt[], lp: number): { x: number; y: number; angle: number } {
  const n = pts.length;
  if (n === 0) return { x: 0, y: 0, angle: 0 };
  if (n === 1) return { x: pts[0].x, y: pts[0].y, angle: 0 };
  const clamped = Math.max(0, Math.min(1, lp));
  const fidx = clamped * (n - 1);
  const idx = Math.min(n - 2, Math.floor(fidx));
  const frac = fidx - idx;
  const a = pts[idx];
  const b = pts[idx + 1];
  return {
    x: a.x + (b.x - a.x) * frac,
    y: a.y + (b.y - a.y) * frac,
    angle: Math.atan2(b.y - a.y, b.x - a.x),
  };
}

/** ポリラインを法線方向に低周波 wobble させて手書き感を出す（端は絞る）。 */
function jitterPolyline(pts: Pt[], amp: number, wob: (s: number) => number): Pt[] {
  const n = pts.length;
  if (n < 2 || amp <= 0) return pts;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const s = i / (n - 1);
    // 局所接線→法線
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const taper = Math.sin(Math.min(1, Math.max(0, s)) * Math.PI); // 端 0・中央 1
    const off = wob(s) * amp * (0.3 + 0.7 * taper);
    out.push({ x: pts[i].x + nx * off, y: pts[i].y + ny * off });
  }
  return out;
}

function polylineLength(pts: Pt[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) {
    L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return L;
}

interface LaidChar {
  ch: string;
  cellLeft: number;
  advancePx: number;
  glyph?: GlyphStrokes; // 実データ。無ければ sweep
}

/**
 * 手書きレンダー情報を算出。
 * @param tRel    startSec 相対秒。
 * @param forceFull 停止/編集/静的合成なら true（p=1＝全文表示）。
 * @param pxScale design(360)→描画解像度（FINAL_W/360）。fontPx/jitter に使う。
 * @param measure ctx.measureText ラッパ（sweep 文字幅）。
 */
export function computeHandwrite(
  layer: Layer,
  w: number,
  h: number,
  tRel: number,
  forceFull: boolean,
  pxScale: number,
  measure: MeasureFn,
): HandwriteRender {
  const fontPx = Math.max(4, (layer.fontSize ?? 48) * pxScale);
  const padding = 4 * pxScale;
  const maxW = Math.max(1, w - padding * 2);
  const lineHeight = fontPx * 1.2;
  const text = layer.text ?? "";

  // --- 1) 行レイアウト（\n 尊重 + advance 折返し）---
  const advanceOf = (ch: string): { advancePx: number; glyph?: GlyphStrokes } => {
    const cp = ch.codePointAt(0) ?? 0;
    const glyph = getGlyph(cp);
    if (glyph && glyph.hasData) {
      return { advancePx: Math.max(1, glyph.advance * fontPx), glyph };
    }
    // sweep フォールバック: 実フォント幅（CJK は ≒ fontPx）。
    const m = measure(ch, fontPx);
    return { advancePx: m > 0 ? m : fontPx };
  };

  const lines: { chars: LaidChar[]; widthPx: number }[] = [];
  let curChars: LaidChar[] = [];
  let curW = 0;
  const pushLine = () => {
    lines.push({ chars: curChars, widthPx: curW });
    curChars = [];
    curW = 0;
  };
  for (const ch of text) {
    if (ch === "\n") {
      pushLine();
      continue;
    }
    const { advancePx, glyph } = advanceOf(ch);
    if (curW + advancePx > maxW && curChars.length > 0) pushLine();
    curChars.push({ ch, cellLeft: 0, advancePx, glyph });
    curW += advancePx;
  }
  pushLine();

  const lineCount = Math.max(1, lines.length);
  const totalH = lineCount * lineHeight;
  const startY = h / 2 - totalH / 2 + lineHeight / 2; // 1 行目の中心 Y
  const baselineNorm = getAsciiBaselineNorm();
  const lineBaselines: number[] = [];

  // --- 2) 全画/フォールバックを書き順に 1 列化（box px へ写像 + jitter）---
  type Seg =
    | { kind: "stroke"; pts: Pt[]; len: number }
    | { kind: "sweep"; x: number; y: number; w: number; h: number; ch: string; len: number };
  const segs: Seg[] = [];

  const jitterAmp = (layer.handwrite?.jitter ?? 0.5) * 1.2 * pxScale;
  const rng = mulberry32(hashSeed(layer.id || "handwrite"));

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const centerY = startY + li * lineHeight;
    const cellTop = centerY - fontPx / 2;
    lineBaselines.push(cellTop + baselineNorm * fontPx);
    let cellLeft = (w - line.widthPx) / 2;
    for (const c of line.chars) {
      if (c.glyph) {
        for (const stroke of c.glyph.strokes) {
          if (stroke.length < 1) continue;
          const px: Pt[] = stroke.map((p) => ({
            x: cellLeft + p.x * fontPx,
            y: cellTop + p.y * fontPx,
          }));
          const jittered = jitterPolyline(px, jitterAmp, makeWobble(rng));
          segs.push({ kind: "stroke", pts: jittered, len: Math.max(0.001, polylineLength(jittered)) });
        }
      } else {
        // sweep: 1 文字 = 1 擬似画（長さは控えめにして全体テンポを乱さない）
        segs.push({
          kind: "sweep",
          x: cellLeft,
          y: cellTop,
          w: c.advancePx,
          h: fontPx,
          ch: c.ch,
          len: Math.max(0.001, c.advancePx * 0.6),
        });
      }
      cellLeft += c.advancePx;
    }
  }

  // --- 3) 書き秒（writeDur）と進捗 p ---
  const strokeCount = Math.max(1, segs.length);
  const speed = Math.max(0.1, layer.handwrite?.speed ?? 1);
  const autoDur = Math.min(12, Math.max(0.6, 0.12 * strokeCount));
  const writeDur = (layer.entryDuration ?? autoDur) / speed;
  const p = forceFull ? 1 : Math.max(0, Math.min(1, tRel / Math.max(0.0001, writeDur)));

  // --- 4) 進捗窓（長さ重み + 画間ギャップ）---
  const totalLen = segs.reduce((s, seg) => s + seg.len, 0) || 1;
  const meanLen = totalLen / strokeCount;
  const gap = 0.1 * meanLen; // ペンを上げる間
  const denom = totalLen + strokeCount * gap;

  const outStrokes: Pt[][] = [];
  const outSweeps: HandwriteRender["sweeps"] = [];
  let penTip: HandwriteRender["penTip"] = null;

  let cum = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const start = (cum + i * gap) / denom;
    const end = (cum + seg.len + i * gap) / denom;
    cum += seg.len;
    const lp = localP(p, start, end);
    const active = !forceFull && p > start && p < end;
    if (seg.kind === "stroke") {
      if (lp >= 1) {
        outStrokes.push(seg.pts);
      } else if (lp > 0) {
        const tr = truncate(seg.pts, lp);
        if (tr.length) outStrokes.push(tr);
      }
      if (active) {
        penTip = pointAtFraction(seg.pts, lp);
      }
    } else {
      const clip = lp;
      if (clip > 0) {
        outSweeps.push({ x: seg.x, y: seg.y, w: seg.w, h: seg.h, clip, ch: seg.ch, fontPx });
      }
      if (active) {
        penTip = {
          x: seg.x + clip * seg.w,
          y: seg.y + baselineNorm * seg.h,
          angle: 0,
        };
      }
    }
  }

  return { strokes: outStrokes, penTip, sweeps: outSweeps, lineBaselines, writeDur };
}
