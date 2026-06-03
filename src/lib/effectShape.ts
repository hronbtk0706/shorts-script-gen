/**
 * curio-gen アニメ仕様 Phase2 §B-強調: 描画系 effect（speedlines / spotlight）の Canvas 描画。
 *
 * 既存 effectKind（全画面後処理）と別系統で、レイヤー領域 [0,w]×[0,h] に直接ピクセルを描く。
 * 単一レンダラなので可視プレビュー＝書き出しで同じ（drawLayerContentInBox から呼ばれる）。
 * canvas は常に FINAL 解像度で描かれるため、px 系は pxScale = FINAL_W/360 で換算する。
 *
 * アニメ（§B 拡張・アメコミ風）: animate = none/flicker/pulse/spin、速度 speed（既定1）。
 * 既定 none では従来の静的挙動と完全一致（t を使わない）。t は絶対秒（playhead）。
 *
 * 決定論性: jitter は seed=line index（flicker 時は時間量子化を加算）の簡易 PRNG。
 * preview/export で同じパターンになる。
 */

import type { DrawnEffectParams } from "../types";

/**
 * 0..1 を返す決定論的ハッシュ（Wang hash 系）。
 * 線形合同法(LCG)は seed を規則的に変えると出力が超平面に乗り、粒子が直線状に並ぶため、
 * seed が連続でも無相関になる整数ハッシュを使う。
 */
function rng(n: number): number {
  let x = Math.trunc(n) | 0;
  x = (x ^ 61) ^ (x >>> 16);
  x = (x + (x << 3)) | 0;
  x = x ^ (x >>> 4);
  x = Math.imul(x, 0x27d4eb2d);
  x = x ^ (x >>> 15);
  return ((x >>> 0) % 1000000) / 1000000;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * speedlines（集中線）: center へ収束する楔形の線を density 本、放射状に描く。
 * 中心は gapRatio ぶん空ける。animate で動かす:
 * - flicker: 一定間隔で線パターンが切り替わる（手描きコマ送り＝アメコミ風）
 * - spin: 全体がゆっくり回転
 * - pulse: 中心の空きが脈動（「ドン」と迫る勢い）
 */
export function drawSpeedlines(
  ctx: CanvasRenderingContext2D,
  p: DrawnEffectParams,
  w: number,
  h: number,
  pxScale = 1,
  t = 0,
): void {
  const cx = ((p.center?.[0] ?? 50) / 100) * w;
  const cy = ((p.center?.[1] ?? 50) / 100) * h;
  const density = Math.max(4, Math.min(400, Math.round(p.density ?? 40)));
  const color = p.color ?? "#FFFFFF";
  const gapRatio = clamp01(p.gapRatio ?? 0.35);
  const baseThick = Math.max(0.5, (p.thickness ?? 2) * pxScale);
  const animate = p.animate ?? "none";
  const speed = Math.max(0, p.speed ?? 1);

  // flicker: seed を時間で量子化（1秒に ~10*speed コマ）→ コマ送りでパターンが切り替わる
  const seedStep =
    animate === "flicker" ? Math.floor(t * 10 * Math.max(0.1, speed)) * 1000 : 0;
  // spin: 全角度に時間オフセット
  const angleOffset = animate === "spin" ? t * speed * 0.6 : 0;
  // pulse: 中心の空き比を脈動
  const gapMul =
    animate === "pulse" ? 1 + 0.28 * Math.sin(t * Math.PI * 2 * speed) : 1;

  const maxR = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)) * 1.15;
  const innerR = maxR * clamp01(gapRatio * gapMul);

  ctx.save();
  ctx.fillStyle = color;
  for (let i = 0; i < density; i++) {
    const base = (i / density) * Math.PI * 2 + angleOffset;
    // 隣の線との間で角度を揺らす（等間隔すぎないように）
    const ang =
      base + (rng(i * 97 + 13 + seedStep) - 0.5) * ((Math.PI * 2) / density) * 0.8;
    const halfW = baseThick * (0.6 + rng(i * 53 + 7 + seedStep) * 1.2);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const ix = cx + ca * innerR;
    const iy = cy + sa * innerR;
    const ox = cx + ca * maxR;
    const oy = cy + sa * maxR;
    const px = -sa * halfW; // 線に垂直な方向
    const py = ca * halfW;
    ctx.beginPath();
    ctx.moveTo(ix, iy); // 内側は収束点
    ctx.lineTo(ox + px, oy + py); // 外側の底辺 1
    ctx.lineTo(ox - px, oy - py); // 外側の底辺 2
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/**
 * spotlight: center を明るく残し周辺を dim ぶん暗くする放射状グラデーション。
 * animate: pulse=半径が脈動 / flicker=半径が微小にちらつく / spin=放射対称なので無効。
 */
export function drawSpotlight(
  ctx: CanvasRenderingContext2D,
  p: DrawnEffectParams,
  w: number,
  h: number,
  t = 0,
): void {
  const cx = ((p.center?.[0] ?? 50) / 100) * w;
  const cy = ((p.center?.[1] ?? 50) / 100) * h;
  const dim = clamp01(p.dim ?? 0.6);
  const softness = clamp01(p.softness ?? 0.4);
  const animate = p.animate ?? "none";
  const speed = Math.max(0, p.speed ?? 1);

  let radiusBase = ((p.radius ?? 25) / 100) * Math.min(w, h);
  if (animate === "pulse") {
    radiusBase *= 1 + 0.14 * Math.sin(t * Math.PI * 2 * speed);
  } else if (animate === "flicker") {
    radiusBase *=
      1 + 0.06 * (rng(Math.floor(t * 12 * Math.max(0.1, speed))) - 0.5) * 2;
  }
  const radius = Math.max(1, radiusBase);
  const r0 = Math.max(0, radius * (1 - softness * 0.5)); // 明るい中心
  const r1 = Math.max(r0 + 1, radius + softness * Math.max(w, h) * 0.6); // 減光完成半径

  ctx.save();
  const g = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, `rgba(0,0,0,${dim.toFixed(3)})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/**
 * §B 雰囲気系 grain: フィルム粒子（ノイズタイル + overlay 合成）or 走査線。
 * 全画面後処理として描画後に呼ぶ。t（秒）で seed が変わり粒子が動く（決定論）。
 */
export function drawGrain(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  g: { type: "grain" | "scanlines"; strength: number; speed: number },
  w: number,
  h: number,
  pxScale = 1,
  t = 0,
): void {
  if (g.type === "scanlines") {
    const gap = Math.max(2, 4 * pxScale);
    ctx.save();
    ctx.fillStyle = `rgba(0,0,0,${(g.strength * 0.35).toFixed(3)})`;
    for (let y = 0; y < h; y += gap * 2) ctx.fillRect(0, y, w, gap);
    ctx.restore();
    return;
  }
  // grain: 96px ノイズタイルを生成し pattern で全画面に overlay 合成（軽量）。
  const tile = 96;
  const oc = new OffscreenCanvas(tile, tile);
  const tctx = oc.getContext("2d");
  if (!tctx) return;
  const img = tctx.createImageData(tile, tile);
  const d = img.data;
  const seed = Math.floor(t * 20 * Math.max(0.1, g.speed)) * 7919;
  const alpha = Math.floor(g.strength * 90);
  for (let i = 0; i < tile * tile; i++) {
    const v = Math.floor(rng(seed + i) * 255);
    d[i * 4] = v;
    d[i * 4 + 1] = v;
    d[i * 4 + 2] = v;
    d[i * 4 + 3] = alpha;
  }
  tctx.putImageData(img, 0, 0);
  const pat = ctx.createPattern(oc, "repeat");
  if (!pat) return;
  ctx.save();
  ctx.globalCompositeOperation = "overlay";
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

const CONFETTI_PALETTE = [
  "#E5484D",
  "#FFD60A",
  "#34D399",
  "#5577BB",
  "#F472B6",
  "#FF8C42",
];

const HEART_PALETTE = ["#FF5C8A", "#FF3D6E", "#FF8FB3", "#E5484D"];

/** ハート形のパス（原点中心・サイズ s）。 */
function heartPath(ctx: CanvasRenderingContext2D, s: number): void {
  const k = s / 16;
  ctx.beginPath();
  ctx.moveTo(0, 5 * k);
  ctx.bezierCurveTo(-1 * k, 1 * k, -8 * k, -1 * k, -8 * k, -6 * k);
  ctx.bezierCurveTo(-8 * k, -11 * k, -2 * k, -11 * k, 0, -6 * k);
  ctx.bezierCurveTo(2 * k, -11 * k, 8 * k, -11 * k, 8 * k, -6 * k);
  ctx.bezierCurveTo(8 * k, -1 * k, 1 * k, 1 * k, 0, 5 * k);
  ctx.closePath();
}

/** 5 点星のパス（原点中心・外半径 r）。 */
function starPath(ctx: CanvasRenderingContext2D, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    const a2 = a + Math.PI / 5;
    if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    ctx.lineTo(Math.cos(a2) * r * 0.45, Math.sin(a2) * r * 0.45);
  }
  ctx.closePath();
}

/** hex 色を amt(>0:明 / <0:暗) に寄せた rgb 文字列。解釈不能はそのまま返す。 */
function shade(hex: string, amt: number): string {
  let hh = hex.trim().replace(/^#/, "");
  if (hh.length === 3) {
    hh = hh
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const r = parseInt(hh.slice(0, 2), 16);
  const g = parseInt(hh.slice(2, 4), 16);
  const b = parseInt(hh.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return hex;
  const tgt = amt > 0 ? 255 : 0;
  const k = Math.min(1, Math.abs(amt));
  return `rgb(${Math.round(r + (tgt - r) * k)},${Math.round(
    g + (tgt - g) * k,
  )},${Math.round(b + (tgt - b) * k)})`;
}

/**
 * §D particles: 降りもの・紙吹雪・きらめき・マネーレイン・塵。
 * 時刻 t から各粒子の状態を決定論計算して描く（ステートレス＝preview=export 一致・スクラブ対応）。
 * 仕様どおり count 上限で生成停止（リサイクルしない）。スプライト未指定は図形。
 * 質感: 遠近 depth（手前=大きく濃い / 奥=小さく薄い）・発光グロー・グラデ光沢で安っぽさを回避。
 */
const frac = (x: number): number => x - Math.floor(x);

export function drawParticles(
  ctx: CanvasRenderingContext2D,
  p: DrawnEffectParams,
  w: number,
  h: number,
  pxScale = 1,
  t = 0, // レイヤー生存相対秒
): void {
  const kind = p.kind ?? "confetti";
  // count = 同時に画面に出る粒子数（上限＝重さ制御）。各粒子は独立位相で循環し常に存在する。
  const count = Math.max(0, Math.min(2000, Math.round(p.count ?? 60)));
  const gravity = Math.max(0.1, p.gravity ?? 1);
  const wind = p.wind ?? 0;
  const region = p.region ?? [0, -5, 100, 10];
  const [rx, ry, rw] = region;
  const sizeRange = p.sizeRange ?? [6, 14];
  const slow = kind === "sparkle" || kind === "dust";
  const baseFall = slow ? 5.5 : 2.8; // 画面を縦断する基本秒（gravity で割る）
  const topY = (ry / 100) * h;
  const fallDist = h - topY + h * 0.15; // 画面下外まで

  ctx.save();
  for (let i = 0; i < count; i++) {
    // 粒子ごとに独立な乱数（位相・速度・横揺れ・回転方向すべてバラす → 筋にならない）
    const r1 = rng(i * 17 + 1); // 落下位相
    const r2 = rng(i * 17 + 2); // 周期ばらつき
    const r3 = rng(i * 17 + 3); // 回転方向/横揺れ
    const r4 = rng(i * 17 + 4); // 横揺れ周期/サイズ
    const r5 = rng(i * 17 + 5); // 横位置

    const cycle = (baseFall * (0.6 + r2 * 0.8)) / gravity; // 落下周期
    const prog = frac(t / cycle + r1); // 0..1 独立位相（常にどこかに居る）
    const y = topY + prog * fallDist;
    const baseX = ((rx + r5 * rw) / 100) * w;
    const swayFreq = 0.7 + r4 * 1.6;
    const amp = (slow ? 22 : 12) * (0.4 + r3) * pxScale;
    const x =
      baseX +
      wind * 40 * prog * pxScale +
      Math.sin(t * swayFreq + r2 * 6.283) * amp;
    const szBase = (sizeRange[0] + r4 * (sizeRange[1] - sizeRange[0])) * pxScale;
    // 遠近感: depth 小=奥(小さく薄い) / 大=手前(大きく濃い)
    const depth = rng(i * 17 + 6);
    const sz = szBase * (0.62 + depth * 0.78);
    const depthA = 0.45 + depth * 0.55;

    if (kind === "confetti" || kind === "money") {
      const spin = (r3 < 0.5 ? -1 : 1) * (1 + r1 * 4);
      const rot = t * spin + r2 * 6.283;
      // 立体的な翻り: 一軸を cos で潰して紙がひらひら裏返る
      const flip = Math.cos(t * (2.2 + r4 * 3.5) + r1 * 6.283);
      const back = flip < 0;
      const base =
        kind === "money"
          ? p.color ?? (r2 > 0.5 ? "#3FA34D" : "#2E7D32")
          : p.color ?? CONFETTI_PALETTE[i % CONFETTI_PALETTE.length];
      const ww = kind === "money" ? sz * 1.9 : r4 > 0.5 ? sz : sz * 0.6;
      const hh = kind === "money" ? sz * 0.92 : r4 > 0.5 ? sz * 0.6 : sz;
      ctx.save();
      ctx.globalAlpha = depthA;
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.scale(1, Math.max(0.04, Math.abs(flip)));
      // 上明→下暗のグラデで光沢・立体感
      const g = ctx.createLinearGradient(0, -hh / 2, 0, hh / 2);
      g.addColorStop(0, shade(base, 0.34));
      g.addColorStop(1, shade(base, -0.22));
      ctx.fillStyle = g;
      ctx.fillRect(-ww / 2, -hh / 2, ww, hh);
      if (kind === "money") {
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.fillRect(-ww / 2, -hh * 0.12, ww, hh * 0.24);
      }
      if (back) {
        ctx.fillStyle = "rgba(0,0,0,0.3)"; // 裏面の陰
        ctx.fillRect(-ww / 2, -hh / 2, ww, hh);
      }
      ctx.restore();
    } else if (kind === "heart" || kind === "star") {
      const rot = Math.sin(t * (0.8 + r3 * 1.5) + r1 * 6.283) * 0.5;
      const base =
        kind === "heart"
          ? p.color ?? HEART_PALETTE[i % HEART_PALETTE.length]
          : p.color ?? "#FFD60A";
      ctx.save();
      ctx.globalAlpha = depthA;
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.shadowColor = base; // 発光グロー
      ctx.shadowBlur = sz * 0.7;
      if (kind === "heart") heartPath(ctx, sz);
      else starPath(ctx, sz * 0.6);
      const g = ctx.createLinearGradient(0, -sz / 2, 0, sz / 2);
      g.addColorStop(0, shade(base, 0.4));
      g.addColorStop(1, shade(base, -0.12));
      ctx.fillStyle = g;
      ctx.fill();
      ctx.restore();
    } else if (kind === "bubble") {
      const rr = sz * 0.5;
      ctx.save();
      ctx.globalAlpha = depthA;
      // 半透明の球（中心ハイライト→縁色）
      const g = ctx.createRadialGradient(
        x - rr * 0.3,
        y - rr * 0.3,
        rr * 0.1,
        x,
        y,
        rr,
      );
      g.addColorStop(0, "rgba(255,255,255,0.55)");
      g.addColorStop(0.65, "rgba(190,233,255,0.10)");
      g.addColorStop(1, "rgba(150,205,255,0.30)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.5 * depthA;
      ctx.strokeStyle = "rgba(220,245,255,0.7)";
      ctx.lineWidth = Math.max(1, sz * 0.05);
      ctx.stroke();
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = "#FFFFFF";
      ctx.beginPath();
      ctx.arc(x - rr * 0.35, y - rr * 0.35, rr * 0.13, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (kind === "spark") {
      const tw = 0.3 + 0.7 * Math.abs(Math.sin(t * (7 + r2 * 6) + r1 * 6.283));
      const base = p.color ?? "#FFE38A";
      ctx.save();
      ctx.globalAlpha = tw * depthA;
      ctx.translate(x, y);
      ctx.rotate(r1 * 6.283);
      ctx.shadowColor = base; // 強い発光
      ctx.shadowBlur = sz * 1.3;
      ctx.fillStyle = base;
      ctx.beginPath();
      ctx.moveTo(0, -sz * 0.6);
      ctx.lineTo(sz * 0.12, 0);
      ctx.lineTo(0, sz * 0.6);
      ctx.lineTo(-sz * 0.12, 0);
      ctx.closePath();
      ctx.moveTo(-sz * 0.6, 0);
      ctx.lineTo(0, sz * 0.12);
      ctx.lineTo(sz * 0.6, 0);
      ctx.lineTo(0, -sz * 0.12);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#FFFFFF"; // 明るいコア
      ctx.beginPath();
      ctx.arc(0, 0, sz * 0.12, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (kind === "sparkle") {
      const tw = 0.3 + 0.7 * Math.abs(Math.sin(t * (4 + r2 * 5) + r1 * 6.283));
      const base = p.color ?? "#FFF3B0";
      ctx.save();
      ctx.globalAlpha = tw * depthA;
      ctx.fillStyle = base;
      ctx.shadowColor = base;
      ctx.shadowBlur = sz * 0.8;
      ctx.fillRect(x - sz / 2, y - sz * 0.1, sz, sz * 0.2);
      ctx.fillRect(x - sz * 0.1, y - sz / 2, sz * 0.2, sz);
      ctx.restore();
    } else if (kind === "dust") {
      ctx.save();
      ctx.globalAlpha = (0.18 + r3 * 0.28) * depthA;
      ctx.fillStyle = p.color ?? "#FFFFFF";
      ctx.beginPath();
      ctx.arc(x, y, sz * 0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else {
      // fall（雪の粒）柔らかく発光
      ctx.save();
      ctx.globalAlpha = 0.85 * depthA;
      ctx.fillStyle = p.color ?? "#FFFFFF";
      ctx.shadowColor = "rgba(255,255,255,0.85)";
      ctx.shadowBlur = sz * 0.5;
      ctx.beginPath();
      ctx.arc(x, y, sz * 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
  ctx.restore();
}
