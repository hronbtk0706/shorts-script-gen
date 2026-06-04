// steam の見た目検証: effectShape.drawSteam と同じ式で 1 フレーム描いて PNG 出力。
import { createCanvas } from "@napi-rs/canvas";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

function rng(n) {
  let x = Math.trunc(n) | 0;
  x = (x ^ 61) ^ (x >>> 16);
  x = (x + (x << 3)) | 0;
  x = x ^ (x >>> 4);
  x = Math.imul(x, 0x27d4eb2d);
  x = x ^ (x >>> 15);
  return ((x >>> 0) % 1000000) / 1000000;
}
const frac = (x) => x - Math.floor(x);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
function withAlpha(hex, a) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function drawSteam(ctx, p, w, h, pxScale, t) {
  const count = Math.max(0, Math.min(400, Math.round(p.count ?? 24)));
  const center = p.center ?? [50, 82];
  const ox = (center[0] / 100) * w;
  const oy = (center[1] / 100) * h;
  const color = p.color ?? "#FFFFFF";
  const speed = Math.max(0.1, p.speed ?? 1);
  const spreadPx = (p.spread ?? 16) * pxScale;
  const riseDist = p.rise != null ? p.rise * pxScale : h * 0.6;
  const sizeRange = p.sizeRange ?? [10, 26];
  for (let i = 0; i < count; i++) {
    const r1 = rng(i * 17 + 1), r2 = rng(i * 17 + 2), r3 = rng(i * 17 + 3),
      r4 = rng(i * 17 + 4), r5 = rng(i * 17 + 5);
    const cycle = (2.6 * (0.7 + r2 * 0.8)) / speed;
    const prog = frac(t / cycle + r1);
    const y = oy - prog * riseDist;
    const sway = Math.sin(prog * Math.PI * (1.4 + r3 * 2.2) + r1 * 6.283) * spreadPx * (0.25 + prog * 0.9);
    const baseX = ox + (r5 - 0.5) * spreadPx * 0.5;
    const x = baseX + sway;
    const szBase = (sizeRange[0] + r4 * (sizeRange[1] - sizeRange[0])) * pxScale;
    const sz = szBase * (0.55 + prog * 1.1);
    const alpha = Math.sin(clamp01(prog) * Math.PI);
    const rr = sz * 0.5;
    const rx = rr * (0.55 + 0.1 * r4);
    const ry = rr * (1.5 + 0.6 * prog);
    const tilt = sway * 0.012;
    ctx.save();
    ctx.globalAlpha = alpha * 0.42;
    ctx.translate(x, y);
    ctx.rotate(tilt);
    const g = ctx.createRadialGradient(0, 0, rr * 0.05, 0, 0, ry);
    g.addColorStop(0, withAlpha(color, 0.7));
    g.addColorStop(0.55, withAlpha(color, 0.22));
    g.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

const W = 400, H = 400;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#1b1b1f";
ctx.fillRect(0, 0, W, H);
// カップを模した矩形
ctx.fillStyle = "#5a4636";
ctx.fillRect(W * 0.32, H * 0.7, W * 0.36, H * 0.18);
drawSteam(ctx, { center: [50, 78], count: 30, color: "#ffffff", speed: 1 }, W, H, 3, 1.7);
writeFileSync(join(__dirname, "..", "steam.png"), canvas.toBuffer("image/png"));
console.log("wrote steam.png");
