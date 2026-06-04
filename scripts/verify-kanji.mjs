// 日本語(KanjiVG)筆順の見た目検証。jitter 込みで「現状(ぐにゃぐにゃ)」と「修正案」を比較する。
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
  try { json = JSON.parse(readFileSync(join(HW, file), "utf8")); } catch { return null; }
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

// --- handwriteStroke.ts / markerShape.ts と同じ jitter ---
function hashSeed(id){let h=2166136261;for(let i=0;i<id.length;i++){h^=id.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
function mulberry32(a){return ()=>{a|=0;a=(a+0x6d2b79f5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return ((t^(t>>>14))>>>0)/4294967296;};}
function makeWobble(rng){const f1=1+rng()*1.5,f2=2.5+rng()*2,p1=rng()*Math.PI*2,p2=rng()*Math.PI*2,bias=(rng()-0.5)*0.4;return (s)=>Math.sin(s*Math.PI*2*f1+p1)*0.6+Math.sin(s*Math.PI*2*f2+p2)*0.4+bias;}
function jitterPolyline(pts,amp,wob){const n=pts.length;if(n<2||amp<=0)return pts;const out=[];for(let i=0;i<n;i++){const s=i/(n-1);const a=pts[Math.max(0,i-1)],b=pts[Math.min(n-1,i+1)];const dx=b.x-a.x,dy=b.y-a.y;const len=Math.hypot(dx,dy)||1;const nx=-dy/len,ny=dx/len;const taper=Math.sin(Math.min(1,Math.max(0,s))*Math.PI);const off=wob(s)*amp*(0.3+0.7*taper);out.push({x:pts[i].x+nx*off,y:pts[i].y+ny*off});}return out;}

// mode: "none" | "old" | "new"。fontSize は design px（テンプレ相当）。
function render(text, mode, fontSizeDesign) {
  const pxScale = 3;             // FINAL_W/360（縦1080）
  const fontPx = fontSizeDesign * pxScale;
  const W = Math.ceil(text.length * fontPx + 60);
  const H = Math.ceil(fontPx + 50);
  const cv = createCanvas(W, H);
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#FAFAFA"; ctx.fillRect(0, 0, W, H);

  const jitter = 0.5; // テンプレ未指定時の旧既定
  let amp;
  if (mode === "none") amp = 0;
  else if (mode === "old") amp = jitter * 1.2 * pxScale;        // 旧: フォントサイズ非依存（小字でぐにゃ）
  else amp = 0.3 * fontPx * 0.018;                              // 新: fontPx 比例で常に控えめ
  const rng = mulberry32(hashSeed("hw-jp"));

  let x = 30; const cellTop = (H - fontPx) / 2;
  ctx.strokeStyle = "#1A237E"; ctx.lineWidth = fontPx * 0.05; ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (const ch of text) {
    const g = getGlyph(ch.codePointAt(0));
    const adv = (g ? g.advance : 0.9) * fontPx;
    if (g) for (const s of g.strokes) {
      let pts = s.map((q) => ({ x: x + q.x * fontPx, y: cellTop + q.y * fontPx }));
      pts = jitterPolyline(pts, amp, makeWobble(rng));
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
      for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
      ctx.stroke();
    }
    x += adv;
  }
  return cv.toBuffer("image/png");
}

const txt = "お金は紙きれになった";
writeFileSync(join(__dirname, "..", "k-old.png"), render(txt, "old", 26));  // 現状（ぐにゃ）
writeFileSync(join(__dirname, "..", "k-new.png"), render(txt, "new", 26));  // 修正案
console.log("wrote k-old.png (現状) / k-new.png (修正案)");
