// 手書き ASCII の見た目検証: ascii.json を drawHandwriteShape と同じレイアウト/写像で
// 描いて PNG を出力する（人/エージェントが目視確認する用）。
import { createCanvas } from "@napi-rs/canvas";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(
  readFileSync(join(__dirname, "..", "public", "handwrite", "ascii.json"), "utf8"),
);

function glyph(ch) {
  return data.glyphs[ch.codePointAt(0)];
}

function render(text, p) {
  const W = 700;
  const H = 200;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  // blackboard
  ctx.fillStyle = "#2E3D34";
  ctx.fillRect(0, 0, W, H);

  const fontPx = 96;
  // レイアウト（中央寄せ）
  const cells = [];
  let totalAdv = 0;
  for (const ch of text) {
    const g = glyph(ch);
    const adv = (g ? g.advance : 0.4) * fontPx;
    cells.push({ ch, g, adv });
    totalAdv += adv;
  }
  let x = (W - totalAdv) / 2;
  const cellTop = H / 2 - fontPx / 2;

  // 全ストロークを 1 列化 → 長さ重みで p 進捗（drawHandwriteShape と同思想の簡易版）
  const allStrokes = [];
  for (const c of cells) {
    if (c.g) {
      for (const s of c.g.strokes) {
        const pts = [];
        for (let i = 0; i + 1 < s.length; i += 2) {
          pts.push({ x: x + s[i] * fontPx, y: cellTop + s[i + 1] * fontPx });
        }
        if (pts.length) allStrokes.push(pts);
      }
    }
    x += c.adv;
  }
  // p に応じて先頭から N 画ぶん描く（簡易: 画数等分）
  const n = allStrokes.length;
  const drawCount = Math.round(p * n);

  ctx.strokeStyle = "#FAFAF0";
  ctx.lineWidth = fontPx * 0.07;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = 0; i < drawCount && i < n; i++) {
    const pts = allStrokes[i];
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
    ctx.stroke();
  }
  return canvas.toBuffer("image/png");
}

writeFileSync(join(__dirname, "..", "hw-full.png"), render("10.000 M", 1));
writeFileSync(join(__dirname, "..", "hw-mid.png"), render("10.000 M", 0.5));
console.log("wrote hw-full.png / hw-mid.png");
