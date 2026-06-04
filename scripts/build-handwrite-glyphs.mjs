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
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { gunzipSync } from "zlib";

const require = createRequire(import.meta.url);
const ht = require("hersheytext");
const { svgPathProperties } = require("svg-path-properties");

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "public", "handwrite");
const CACHE_DIR = join(__dirname, ".cache");
// KanjiVG 結合 XML（CC BY-SA 3.0）。cache に無ければ DL する。
const KANJIVG_URL =
  "https://github.com/KanjiVG/kanjivg/releases/download/r20250816/kanjivg-20250816.xml.gz";
const KANJIVG_GZ = join(CACHE_DIR, "kanjivg.xml.gz");

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

  // Hershey の width(送り) は実インク幅より狭く、そのまま使うと文字が重なる。
  // 各グリフの実インク x 範囲を取り、min を 0 に寄せて「インク幅＋左右ベアリング」を送りにする。
  const BEARING = 2.2; // 左右の余白（raw 単位・emHeight≈32 基準）
  const glyphs = {};
  for (const r of raw) {
    let xMin = Infinity;
    let xMax = -Infinity;
    for (const s of r.strokes)
      for (const [x] of s) {
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
      }
    if (!Number.isFinite(xMin)) {
      xMin = 0;
      xMax = 0;
    }
    const shift = BEARING - xMin; // インク左端を BEARING に寄せる
    const flatStrokes = r.strokes.map((s) => {
      const out = [];
      for (const [x, y] of s) {
        out.push(
          Math.round(((x + shift) / emHeight) * 1000) / 1000,
          Math.round(((y - yMin) / emHeight) * 1000) / 1000,
        );
      }
      return out;
    });
    const inkW = xMax - xMin;
    const advance = (inkW + BEARING * 2) / emHeight; // 実インク幅＋左右ベアリング
    glyphs[r.cp] = {
      advance: Math.round(advance * 1000) / 1000,
      strokes: flatStrokes,
    };
  }
  // スペースは strokes 無し・advance のみ（Hershey の送りをそのまま）
  glyphs[32] = { advance: Math.round((spaceWidth / emHeight) * 1000) / 1000, strokes: [] };

  return {
    format: "handwrite-glyphs-v1",
    source: "hershey-futural (public domain)",
    emHeight: Math.round(emHeight * 1000) / 1000,
    baselineNorm: Math.round(baselineNorm * 1000) / 1000,
    glyphs,
  };
}

// ---- KanjiVG（漢字・かな）----

/** svg path d を 0..1 正規化ポリラインへサンプリング（KanjiVG viewBox 109）。 */
function samplePath(d) {
  const props = new svgPathProperties(d);
  const L = props.getTotalLength();
  if (!(L > 0)) return null;
  const n = Math.max(5, Math.min(40, Math.ceil(L / 3.2) + 1));
  const out = [];
  for (let i = 0; i < n; i++) {
    const pt = props.getPointAtLength((L * i) / (n - 1));
    out.push(
      Math.round((pt.x / 109) * 1000) / 1000,
      Math.round((pt.y / 109) * 1000) / 1000,
    );
  }
  return out;
}

/** codepoint → 出力シャードのファイル名（handwriteGlyphs.shardForCodepoint と一致させる）。 */
function shardName(cp) {
  if (cp >= 0x3040 && cp <= 0x30ff) return "kana.json";
  if ((cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff)) {
    return `kanji-${(cp >> 8).toString(16)}.json`;
  }
  return null; // 対象外
}

function buildKanjiVG() {
  if (!existsSync(KANJIVG_GZ)) {
    console.error(
      `[build-handwrite-glyphs] KanjiVG cache 無し: ${KANJIVG_GZ}\n` +
        `  先に DL してください: curl -sL "${KANJIVG_URL}" -o "${KANJIVG_GZ}"`,
    );
    return;
  }
  const xml = gunzipSync(readFileSync(KANJIVG_GZ)).toString("utf8");
  // base エントリのみ（variant 接尾辞付き id は除外）
  const kanjiRe = /<kanji id="kvg:kanji_([0-9a-fA-F]+)">([\s\S]*?)<\/kanji>/g;
  const pathRe = /<path[^>]*\sd="([^"]+)"/g;
  const shards = new Map(); // filename → glyphs{}
  let count = 0;
  let m;
  while ((m = kanjiRe.exec(xml)) !== null) {
    const cp = parseInt(m[1], 16);
    const file = shardName(cp);
    if (!file) continue;
    const body = m[2];
    const strokes = [];
    let pm;
    pathRe.lastIndex = 0;
    while ((pm = pathRe.exec(body)) !== null) {
      try {
        const s = samplePath(pm[1]);
        if (s && s.length >= 4) strokes.push(s);
      } catch {
        /* 壊れた path はスキップ */
      }
    }
    if (strokes.length === 0) continue;
    if (!shards.has(file)) shards.set(file, {});
    shards.get(file)[cp] = { advance: 1, strokes };
    count++;
  }
  for (const [file, glyphs] of shards) {
    const json = {
      format: "handwrite-glyphs-v1",
      source: "KanjiVG (CC BY-SA 3.0)",
      glyphs,
    };
    writeFileSync(join(OUT_DIR, file), JSON.stringify(json));
  }
  console.log(
    `[build-handwrite-glyphs] wrote ${shards.size} KanjiVG shards, ${count} glyphs (漢字・かな)`,
  );
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const ascii = buildAscii();
  const path = join(OUT_DIR, "ascii.json");
  writeFileSync(path, JSON.stringify(ascii));
  const n = Object.keys(ascii.glyphs).length;
  console.log(`[build-handwrite-glyphs] wrote ${path} (${n} ASCII glyphs, emHeight=${ascii.emHeight}, baseline=${ascii.baselineNorm})`);
  buildKanjiVG();
}

main();
