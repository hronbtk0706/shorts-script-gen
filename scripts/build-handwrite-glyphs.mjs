// 手書き（筆順）グリフ字形データのビルド。
//
// Phase A: Hershey 単線フォント（futural）から ASCII の筆順ポリラインを生成し
//          public/handwrite/ascii.json に出力する。
// Phase B: ここに KanjiVG（CC BY-SA）のダウンロード＋ svg-path-properties サンプリング＋
//          codepoint シャード/gzip 出力を追加する（漢字・かな）。
//
// 実行: node scripts/build-handwrite-glyphs.mjs  （または npm run build:glyphs）
//
// 出力フォーマット（handwrite-glyphs-v1）:
//   { format, source, emHeight, baselineNorm, glyphs: { "<codepoint>": { advance, strokes } } }
//   - strokes: 1 画 = flat number 配列 [x0,y0,x1,y1,...]（0..1 正規化座標・y は下方向）
//   - advance: 1 em(=emHeight) を 1.0 とした横送り
//   - 全グリフ共通の emHeight / baseline で正規化するので互いに縦位置が揃う

import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdirSync, writeFileSync } from "fs";

const require = createRequire(import.meta.url);
const ht = require("hersheytext");

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "public", "handwrite");

const FONT = "futural"; // Hershey single-stroke sans（ASCII 向き）

/** SVG 風 d ("M9,1 L1,22 M9,1 L17,22") を 部分パス（点列）配列にパース。 */
function parsePathD(d) {
  const strokes = [];
  let cur = null;
  // トークン: コマンド(M/L) または 座標ペア "x,y"
  const tokens = d.trim().split(/\s+/);
  for (const tok of tokens) {
    if (tok === "M" || tok === "L") continue; // 単独コマンド（次に座標が続く形）
    let cmd = "";
    let coord = tok;
    if (tok[0] === "M" || tok[0] === "L") {
      cmd = tok[0];
      coord = tok.slice(1);
    }
    if (!coord) continue;
    const [xs, ys] = coord.split(",");
    const x = parseFloat(xs);
    const y = parseFloat(ys);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (cmd === "M" || cur === null) {
      cur = [];
      strokes.push(cur);
    }
    cur.push([x, y]);
  }
  return strokes.filter((s) => s.length >= 1);
}

function buildAscii() {
  // 印字可能 ASCII（32..126）を 1 文字ずつ取得
  const raw = []; // { cp, width, strokes:[[ [x,y],...], ... ] }
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let cp = 33; cp <= 126; cp++) {
    const ch = String.fromCharCode(cp);
    let arr;
    try {
      arr = ht.renderTextArray(ch, { font: FONT });
    } catch {
      arr = null;
    }
    if (!arr || !arr.length) continue;
    const g = arr[0];
    const strokes = parsePathD(g.d || "");
    for (const s of strokes) {
      for (const [, y] of s) {
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
    }
    raw.push({ cp, width: g.width ?? 10, strokes });
  }
  // 半角スペース（送りだけ）
  const spaceArr = ht.renderTextArray(" ", { font: FONT });
  const spaceWidth = (spaceArr && spaceArr[0] && spaceArr[0].width) || 8;

  if (!Number.isFinite(yMin) || !Number.isFinite(yMax) || yMax <= yMin) {
    yMin = 0;
    yMax = 25;
  }
  const emHeight = yMax - yMin;

  // baseline 推定: 'x'(120) または '0'(48) の最下点を正規化
  const baseGlyph =
    raw.find((r) => r.cp === 120) || raw.find((r) => r.cp === 48);
  let baselineNorm = 0.78;
  if (baseGlyph) {
    let by = -Infinity;
    for (const s of baseGlyph.strokes) for (const [, y] of s) if (y > by) by = y;
    if (Number.isFinite(by)) baselineNorm = (by - yMin) / emHeight;
  }

  const glyphs = {};
  for (const r of raw) {
    const flatStrokes = r.strokes.map((s) => {
      const out = [];
      for (const [x, y] of s) {
        out.push(
          Math.round(((x - 0) / emHeight) * 1000) / 1000, // x はそのまま emHeight 正規化（左サイドベアリング維持）
          Math.round(((y - yMin) / emHeight) * 1000) / 1000,
        );
      }
      return out;
    });
    glyphs[r.cp] = {
      advance: Math.round((r.width / emHeight) * 1000) / 1000,
      strokes: flatStrokes,
    };
  }
  // スペースは strokes 無し・advance のみ
  glyphs[32] = { advance: Math.round((spaceWidth / emHeight) * 1000) / 1000, strokes: [] };

  return {
    format: "handwrite-glyphs-v1",
    source: "hershey-futural (public domain)",
    emHeight: Math.round(emHeight * 1000) / 1000,
    baselineNorm: Math.round(baselineNorm * 1000) / 1000,
    glyphs,
  };
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const ascii = buildAscii();
  const path = join(OUT_DIR, "ascii.json");
  writeFileSync(path, JSON.stringify(ascii));
  const n = Object.keys(ascii.glyphs).length;
  console.log(`[build-handwrite-glyphs] wrote ${path} (${n} ASCII glyphs, emHeight=${ascii.emHeight}, baseline=${ascii.baselineNorm})`);
}

main();
