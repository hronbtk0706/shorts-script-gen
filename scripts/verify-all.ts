// counter / flip-swap / marker-surge を「本物の実装関数」で描いて PNG 出力し目視確認する。
import { createCanvas } from "@napi-rs/canvas";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { computeCounterText, resolveDynamicText } from "../src/lib/counterText";
import { computeCanvasAnim } from "../src/lib/layerAnimCanvas";
import { computeMarker } from "../src/lib/markerShape";
import type { Layer } from "../src/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = (f: string) => join(__dirname, "..", f);

function baseLayer(p: Partial<Layer>): Layer {
  return {
    id: "L",
    type: "comment",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    zIndex: 1,
    startSec: 0,
    endSec: 8,
    ...p,
  } as Layer;
}

// ---------- counter ----------
{
  const c = { from: 5000, to: 10000, durationSec: 3, suffix: " M", separator: true } as const;
  // 値ロジックの確認（コンソール）
  for (const t of [0, 0.75, 1.5, 2.25, 3, 5]) {
    console.log(`counter t=${t}s ->`, computeCounterText(c, t, true));
  }
  console.log("counter JP suffix ->", computeCounterText({ ...c, suffix: "マルク" }, 1.5, true));
  console.log("counter decimals1 ->", computeCounterText({ from: 0, to: 3.5, durationSec: 2, decimals: 1, prefix: "$" }, 1, true));
  console.log("counter stopped(playing=false) ->", computeCounterText(c, 0, false));

  const W = 700, H = 160, cv = createCanvas(W, H), ctx = cv.getContext("2d");
  ctx.fillStyle = "#1b1b1f"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#ffe600"; ctx.font = "bold 72px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(computeCounterText(c, 1.5, true), W / 2, H / 2); // 中間値
  writeFileSync(out("v-counter.png"), cv.toBuffer("image/png"));
}

// ---------- flip-swap ----------
{
  const layer = baseLayer({ entryAnimation: "flip-swap", entryDuration: 0.8, text: "5000", flipTo: "10000" });
  const W = 720, H = 200, cv = createCanvas(W, H), ctx = cv.getContext("2d");
  ctx.fillStyle = "#1b1b1f"; ctx.fillRect(0, 0, W, H);
  const ps = [0.2, 0.5, 0.8];
  ps.forEach((p, i) => {
    const t = p * 0.8;
    const anim = computeCanvasAnim(layer, t, 200, 120, 1, false);
    const text = resolveDynamicText(layer, t, true) ?? "";
    const cx = (i + 0.5) * (W / ps.length), cy = H / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(anim.sx, anim.sy); // flip-swap は sy を潰す
    ctx.fillStyle = "#fff"; ctx.font = "bold 56px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, 0, 0);
    ctx.restore();
    ctx.fillStyle = "#888"; ctx.font = "16px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(`p=${p} sy=${anim.sy.toFixed(2)} "${text}"`, cx, H - 12);
  });
  writeFileSync(out("v-flip.png"), cv.toBuffer("image/png"));
}

// ---------- marker-surge ----------
{
  const layer = baseLayer({
    type: "shape", shape: "marker-surge", fillColor: "#ff3b30",
    markerFrom: { x: 10, y: 90 }, markerTo: { x: 90, y: 10 },
    markerHead: "triangle", markerWidth: 8, markerOvershoot: 0.12,
    entryAnimation: "draw-on", entryDuration: 1,
  });
  const boxW = 300, boxH = 300;
  const ps = [0.3, 0.6, 1.0];
  const W = boxW * ps.length, H = boxH, cv = createCanvas(W, H), ctx = cv.getContext("2d");
  ctx.fillStyle = "#101014"; ctx.fillRect(0, 0, W, H);
  ps.forEach((p, i) => {
    const ox = i * boxW;
    const { strokes, arrowHead, flash } = computeMarker(layer, boxW, boxH, p, 1);
    ctx.save();
    ctx.translate(ox, 0);
    ctx.strokeStyle = "#ff3b30"; ctx.fillStyle = "#ff3b30"; ctx.lineWidth = 8; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.globalAlpha = 0.85;
    for (const s of strokes) { if (s.length < 2) continue; ctx.beginPath(); ctx.moveTo(s[0].x, s[0].y); for (let j = 1; j < s.length; j++) ctx.lineTo(s[j].x, s[j].y); ctx.stroke(); }
    if (arrowHead && arrowHead.length === 3) { ctx.beginPath(); ctx.moveTo(arrowHead[0].x, arrowHead[0].y); ctx.lineTo(arrowHead[1].x, arrowHead[1].y); ctx.lineTo(arrowHead[2].x, arrowHead[2].y); ctx.closePath(); ctx.fill(); }
    if (flash && flash.alpha > 0.001) {
      ctx.globalAlpha = Math.min(1, flash.alpha);
      const g = ctx.createRadialGradient(flash.x, flash.y, 0, flash.x, flash.y, flash.r);
      g.addColorStop(0, "rgba(255,255,255,0.95)"); g.addColorStop(0.4, "#ff3b30"); g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(flash.x, flash.y, flash.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1; ctx.fillStyle = "#888"; ctx.font = "16px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(`p=${p}`, ox + boxW / 2, H - 10);
  });
  writeFileSync(out("v-surge.png"), cv.toBuffer("image/png"));
}

console.log("wrote v-counter.png / v-flip.png / v-surge.png");
