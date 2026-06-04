// 黒板チョークで漢字を書く見た目の検証（白チョーク on 緑黒板、新jitter込み）。
import { createCanvas } from "@napi-rs/canvas";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const HW = join(__dirname, "..", "public", "handwrite");

function shardName(cp) {
  if (cp >= 0x20 && cp <= 0x7e) return "ascii.json";
  if (cp >= 0x3040 && cp <= 0x30ff) return "kana.json";
  if ((cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff)) return `kanji-${(cp >> 8).toString(16)}.json`;
  return null;
}
const cache = new Map();
function getGlyph(cp) {
  if (cache.has(cp)) return cache.get(cp);
  const file = shardName(cp); if (!file) return null;
  let json; try { json = JSON.parse(readFileSync(join(HW, file), "utf8")); } catch { return null; }
  for (const [k, g] of Object.entries(json.glyphs)) {
    cache.set(Number(k), { advance: g.advance, strokes: g.strokes.map((f) => { const p = []; for (let i = 0; i + 1 < f.length; i += 2) p.push({ x: f[i], y: f[i + 1] }); return p; }) });
  }
  return cache.get(cp) ?? null;
}
function hashSeed(id){let h=2166136261;for(let i=0;i<id.length;i++){h^=id.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
function mulberry32(a){return ()=>{a|=0;a=(a+0x6d2b79f5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return ((t^(t>>>14))>>>0)/4294967296;};}
function makeWobble(rng){const f1=1+rng()*1.5,f2=2.5+rng()*2,p1=rng()*Math.PI*2,p2=rng()*Math.PI*2,bias=(rng()-0.5)*0.4;return (s)=>Math.sin(s*Math.PI*2*f1+p1)*0.6+Math.sin(s*Math.PI*2*f2+p2)*0.4+bias;}
function jitterPolyline(pts,amp,wob){const n=pts.length;if(n<2||amp<=0)return pts;const out=[];for(let i=0;i<n;i++){const s=i/(n-1);const a=pts[Math.max(0,i-1)],b=pts[Math.min(n-1,i+1)];const dx=b.x-a.x,dy=b.y-a.y;const len=Math.hypot(dx,dy)||1;const nx=-dy/len,ny=dx/len;const taper=Math.sin(Math.min(1,Math.max(0,s))*Math.PI);const off=wob(s)*amp*(0.3+0.7*taper);out.push({x:pts[i].x+nx*off,y:pts[i].y+ny*off});}return out;}

function render(text, p, fontSizeDesign) {
  const pxScale = 3, fontPx = fontSizeDesign * pxScale;
  const W = Math.ceil(text.length * fontPx + 80), H = Math.ceil(fontPx + 90);
  const cv = createCanvas(W, H), ctx = cv.getContext("2d");
  // 黒板（緑）＋ごく薄いノイズ感
  ctx.fillStyle = "#2E3D34"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#8b9c84"; // 木枠っぽい縁
  ctx.fillRect(0, 0, W, 10); ctx.fillRect(0, H - 10, W, 10); ctx.fillRect(0, 0, 10, H); ctx.fillRect(W - 10, 0, 10, H);

  const amp = 0.3 * fontPx * 0.018; // 新 jitter 既定
  const rng = mulberry32(hashSeed("hw-chalk"));
  const all = [];
  let x = 40; const cellTop = (H - fontPx) / 2;
  for (const ch of text) {
    const g = getGlyph(ch.codePointAt(0));
    if (!g) console.log(`  字形なし(char-sweepになる): ${ch} U+${ch.codePointAt(0).toString(16)}`);
    const adv = (g ? g.advance : 0.9) * fontPx;
    if (g) for (const s of g.strokes) {
      let pts = s.map((q) => ({ x: x + q.x * fontPx, y: cellTop + q.y * fontPx }));
      pts = jitterPolyline(pts, amp, makeWobble(rng));
      all.push(pts);
    }
    x += adv;
  }
  const drawCount = Math.round(p * all.length);
  const lineW = fontPx * 0.05;
  const ink = "#FAFAF0";
  ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.lineWidth = lineW;
  ctx.globalAlpha = 0.92;
  const frac = (x) => x - Math.floor(x);
  // layerComposer.drawChalkStroke と同じ
  function drawChalkStroke(pts) {
    const baseAlpha = ctx.globalAlpha;
    ctx.save(); ctx.globalAlpha = baseAlpha * 0.62; ctx.lineWidth = lineW * 0.82; ctx.strokeStyle = ink;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke(); ctx.restore();
    ctx.save(); ctx.fillStyle = ink;
    const step = Math.max(2, lineW * 0.45);
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i-1].x, ay = pts[i-1].y, bx = pts[i].x, by = pts[i].y;
      const segLen = Math.hypot(bx-ax, by-ay) || 1;
      const tx = (bx-ax)/segLen, ty = (by-ay)/segLen, nx = -ty, ny = tx;
      const nSteps = Math.max(1, Math.floor(segLen/step));
      for (let k = 0; k < nSteps; k++) {
        const f = (k+0.5)/nSteps, cx = ax+(bx-ax)*f, cy = ay+(by-ay)*f;
        const r = mulberry32(hashSeed(`${Math.round(cx)}_${Math.round(cy)}`));
        for (let g = 0; g < 2; g++) {
          if (r() < 0.12) continue;
          const off = (r()-0.5)*lineW*0.85, along = (r()-0.5)*step, rad = lineW*(0.08+r()*0.2);
          ctx.globalAlpha = baseAlpha*(0.25+r()*0.55);
          ctx.beginPath(); ctx.arc(cx+nx*off+tx*along, cy+ny*off+ty*along, rad, 0, Math.PI*2); ctx.fill();
        }
      }
    }
    ctx.restore();
  }
  function drawChalkDust(tip, t) {
    ctx.save(); ctx.fillStyle = ink; const fall = fontPx*0.45;
    for (let i = 0; i < 9; i++) {
      const r = mulberry32(hashSeed(`dust${i}`)); const r1=r(),r2=r(),r3=r();
      const phase = frac(t*(1.3+r1*0.8)+r1);
      const x = tip.x+(r2-0.5)*fontPx*0.16, y = tip.y+fontPx*0.1+phase*fall;
      const rad = Math.max(0.5, fontPx*0.012*(0.6+r3));
      ctx.globalAlpha = (1-phase)*0.45;
      ctx.beginPath(); ctx.arc(x,y,rad,0,Math.PI*2); ctx.fill();
    }
    ctx.restore();
  }
  for (let i = 0; i < drawCount && i < all.length; i++) drawChalkStroke(all[i]);
  // 途中なら最後に描いた画の終端をペン先として粉を出す
  if (p < 1 && drawCount > 0 && drawCount <= all.length) {
    const last = all[drawCount-1]; const tip = last[last.length-1];
    drawChalkDust(tip, p * 5); // 適当な時刻
  }
  return cv.toBuffer("image/png");
}

const target = process.argv[2] || "黒板に漢字を書く";
console.log(`render "${target}"`);
writeFileSync(join(__dirname, "..", "chalk-full.png"), render(target, 1, 56));
writeFileSync(join(__dirname, "..", "chalk-mid.png"), render(target, 0.5, 56));
console.log("wrote chalk-full.png / chalk-mid.png");
