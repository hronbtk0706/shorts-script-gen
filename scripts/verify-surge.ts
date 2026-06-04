// marker-surge をテンプレ実寸で描いて確認（p=0.5 途中 / 0.85 オーバーシュート / 1.0 静止）。
import { createCanvas } from "@napi-rs/canvas";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { computeMarker } from "../src/lib/markerShape";
import type { Layer } from "../src/types";

const __dirname = dirname(fileURLToPath(import.meta.url));

const layer = {
  id: "surge1", type: "shape", shape: "marker-surge", fillColor: "#ff3b30",
  markerFrom: { x: 12, y: 88 }, markerTo: { x: 88, y: 14 },
  markerHead: "triangle", markerWidth: 7, markerOvershoot: 0.08,
  entryAnimation: "draw-on", entryDuration: 1.2,
  x: 14, y: 51, width: 72, height: 17, zIndex: 4, startSec: 1.5, endSec: 8,
} as Layer;

// テンプレ実寸（縦1080x1920）
const boxW = Math.round(0.72 * 1080); // 778
const boxH = Math.round(0.17 * 1920); // 326
const pxScale = 3;
const ps = [0.5, 0.85, 1.0];
const W = boxW, H = boxH * ps.length;
const cv = createCanvas(W, H);
const ctx = cv.getContext("2d");
ctx.fillStyle = "#1b1b1f"; ctx.fillRect(0, 0, W, H);

ps.forEach((p, i) => {
  const oy = i * boxH;
  const { strokes, arrowHead, flash } = computeMarker(layer, boxW, boxH, p, pxScale);
  ctx.save();
  ctx.translate(0, oy);
  ctx.strokeStyle = "#ff3b30"; ctx.fillStyle = "#ff3b30";
  ctx.lineWidth = 7 * pxScale; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.globalAlpha = 0.85;
  for (const s of strokes) { if (s.length < 2) continue; ctx.beginPath(); ctx.moveTo(s[0].x, s[0].y); for (let j = 1; j < s.length; j++) ctx.lineTo(s[j].x, s[j].y); ctx.stroke(); }
  if (arrowHead && arrowHead.length === 3) { ctx.beginPath(); ctx.moveTo(arrowHead[0].x, arrowHead[0].y); ctx.lineTo(arrowHead[1].x, arrowHead[1].y); ctx.lineTo(arrowHead[2].x, arrowHead[2].y); ctx.closePath(); ctx.fill(); }
  if (flash && flash.alpha > 0.001) {
    ctx.globalAlpha = Math.min(1, flash.alpha);
    const g = ctx.createRadialGradient(flash.x, flash.y, 0, flash.x, flash.y, flash.r);
    g.addColorStop(0, "rgba(255,255,255,0.95)"); g.addColorStop(0.4, "#ff3b30"); g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(flash.x, flash.y, flash.r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  ctx.globalAlpha = 1; ctx.fillStyle = "#888"; ctx.font = "20px sans-serif";
  ctx.fillText(`p=${p}`, 12, oy + 26);
});
writeFileSync(join(__dirname, "..", "surge.png"), cv.toBuffer("image/png"));
console.log("wrote surge.png");
