// 日本語（KanjiVG）筆順の見た目検証: 必要シャードを読み、computeHandwrite と同じ
// レイアウト/写像で "お金は紙きれ" を描いて PNG 出力。p=1（全文）と p=0.45（途中）。
import { createCanvas } from "@napi-rs/canvas";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HW = join(__dirname, "..", "public", "handwrite");

function shardName(cp) {
  if (cp >= 0x20 && cp <= 0x7e) return "ascii.json";
  if (cp >= 0x3040 && cp <= 0x30ff) return "kana.json";
  if ((cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff))
    return `kanji-${(cp >> 8).toString(16)}.json`;
  return null;
}
const cache = new Map();
function getGlyph(cp) {
  if (cache.has(cp)) return cache.get(cp);
  const file = shardName(cp);
  if (!file) return null;
  let json;
  try {
    json = JSON.parse(readFileSync(join(HW, file), "utf8"));
  } catch {
    return null;
  }
  for (const [k, g] of Object.entries(json.glyphs)) {
    const strokes = g.strokes.map((flat) => {
      const pts = [];
      for (let i = 0; i + 1 < flat.length; i += 2) pts.push({ x: flat[i], y: flat[i + 1] });
      return pts;
    });
    cache.set(Number(k), { strokes, advance: g.advance });
  }
  return cache.get(cp) ?? null;
}

function render(text, p) {
  const fontPx = 110;
  const W = text.length * fontPx + 40;
  const H = fontPx + 60;
  const cv = createCanvas(W, H);
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#FAFAFA";
  ctx.fillRect(0, 0, W, H);

  // 全画を 1 列化
  const all = [];
  let x = 20;
  const cellTop = (H - fontPx) / 2;
  for (const ch of text) {
    const g = getGlyph(ch.codePointAt(0));
    const adv = (g ? g.advance : 0.9) * fontPx;
    if (g) {
      for (const s of g.strokes) {
        const pts = s.map((q) => ({ x: x + q.x * fontPx, y: cellTop + q.y * fontPx }));
        all.push(pts);
      }
    }
    x += adv;
  }
  const drawCount = Math.round(p * all.length);
  ctx.strokeStyle = "#1A237E";
  ctx.lineWidth = fontPx * 0.05;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = 0; i < drawCount && i < all.length; i++) {
    const pts = all[i];
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
    ctx.stroke();
  }
  return cv.toBuffer("image/png");
}

writeFileSync(join(__dirname, "..", "k-full.png"), render("お金は紙きれ", 1));
writeFileSync(join(__dirname, "..", "k-mid.png"), render("お金は紙きれ", 0.45));
console.log("wrote k-full.png / k-mid.png");
