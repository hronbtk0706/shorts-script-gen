/**
 * 画面全体エフェクト Layer（type === "effect"）の計算。
 *
 * effect layer は pixel を出力せず、その [startSec, endSec] の間、**最終合成フレーム全体**に
 * 効果を適用する。preview (TemplateCanvas の合成 div) と export (exportTemplateWebCodecs の
 * OffscreenCanvas) で**同じ式**を使い、見た目と出力を一致させる。
 *
 * Phase 1: shake。Phase 2: flash / zoom-punch / vignette-pulse / blur-burst。
 *
 * 決定論性: shake の乱数 seed = floor(t * 30)。preview / export で同じパターンになる。
 * 複数の同種 layer が重なったら **効果値の最大を 1 回適用**（積算しない）。
 * px 系（shake 振幅 / blur 半径）は design(360) 基準で pxScale により描画解像度へ換算する
 * （preview=canvasWPx/360, export=FINAL_W/360）。zoom の scale 比と alpha は解像度非依存。
 */

import type { Layer, TransitionSpec } from "../types";

export interface ScreenShake {
  dx: number;
  dy: number;
}

/** 画面全体エフェクトの合成結果。各値は「その時刻の最終合成フレームへの適用量」。 */
export interface ScreenEffects {
  /** shake の平行移動（px, 解像度換算済み） */
  dx: number;
  dy: number;
  /** zoom-punch の拡大率（中心基準）。1.0 = 等倍 */
  scale: number;
  /** flash の白被せ alpha（0..1） */
  flashAlpha: number;
  /** vignette の端の黒 alpha（0..1）。中心は 0 */
  vignetteAlpha: number;
  /** blur-burst の blur 半径（px, 解像度換算済み） */
  blurPx: number;
  /** colorgrade grade の ctx.filter 文字列（"" なら無し）。描画前に blur と合成して適用。 */
  gradeFilter: string;
  /** colorgrade tint の色（null なら無し）。描画後にオーバーレイ。 */
  tintColor: string | null;
  /** colorgrade tint の alpha（0..1）。 */
  tintAlpha: number;
  /** grain（フィルム粒子/走査線）。null なら無し。描画後にオーバーレイ。 */
  grain: { type: "grain" | "scanlines"; strength: number; speed: number } | null;
}

/** proposal 指定の簡易 PRNG（-0.5..0.5 を返す決定論的乱数） */
function rng(n: number): number {
  return ((n * 9301 + 49297) % 233280) / 233280 - 0.5;
}

const clampI = (v: number | undefined) => Math.max(0, Math.min(2, v ?? 1));

/** layer の区間内なら 0..1 の進行度 p を返す。区間外は null。 */
function progress(L: Layer, t: number): number | null {
  if (t < L.startSec || t >= L.endSec) return null;
  const dur = Math.max(1e-6, L.endSec - L.startSec);
  return (t - L.startSec) / dur;
}

/** 立ち上がり即 → 余弦で戻る山型（zoom-punch 用）。attack まで線形上昇、以降は余弦で 1→0。 */
function punchHump(p: number, attack = 0.3): number {
  if (p <= attack) return p / attack;
  const q = (p - attack) / (1 - attack);
  return 0.5 * (1 + Math.cos(Math.PI * q));
}

/** 対称な山型（0→1→0、flash の減衰以外の vignette / blur 用） */
function bell(p: number): number {
  return Math.sin(Math.PI * Math.max(0, Math.min(1, p)));
}

/**
 * 時刻 t での画面シェイク量を返す。shake な effect layer が無ければ {0,0}。
 * （後方互換のため残置。新規は computeScreenEffects を使う）
 */
export function computeScreenShake(
  layers: Layer[],
  t: number,
  pxScale = 1,
): ScreenShake {
  let intensity = 0;
  for (const L of layers) {
    if (L.type !== "effect" || L.effectKind !== "shake") continue;
    if (progress(L, t) === null) continue;
    const i = clampI(L.effectIntensity);
    if (i > intensity) intensity = i;
  }
  if (intensity <= 0) return { dx: 0, dy: 0 };
  const seed = Math.floor(t * 30);
  const dx = rng(seed) * intensity * 16 * pxScale; // ±8px * intensity（design 基準）
  const dy = rng(seed + 1) * intensity * 16 * pxScale;
  return { dx, dy };
}

/**
 * 時刻 t での全画面エフェクトをまとめて算出。effect layer が無ければ恒等値を返す。
 * 同種が重なったら効果値の最大を採る（積算しない）。
 */
export function computeScreenEffects(
  layers: Layer[],
  t: number,
  pxScale = 1,
): ScreenEffects {
  const out: ScreenEffects = {
    dx: 0,
    dy: 0,
    scale: 1,
    flashAlpha: 0,
    vignetteAlpha: 0,
    blurPx: 0,
    gradeFilter: "",
    tintColor: null,
    tintAlpha: 0,
    grain: null,
  };
  let shakeIntensity = 0;
  let zoomExtra = 0;

  for (const L of layers) {
    if (L.type !== "effect") continue;
    const p = progress(L, t);
    if (p === null) continue;
    const i = clampI(L.effectIntensity);
    if (i <= 0) continue;

    switch (L.effectKind) {
      case "shake":
        if (i > shakeIntensity) shakeIntensity = i;
        break;
      case "flash": {
        // 立ち上がり即時 → endSec へ向け alpha を intensity*0.9 → 0 へ線形減衰
        const a = i * 0.9 * (1 - p);
        if (a > out.flashAlpha) out.flashAlpha = a;
        break;
      }
      case "zoom-punch": {
        // 1.0 → 1.0 + intensity*0.06 へ急峻に立ち上がり ease-out で戻る
        const extra = i * 0.06 * punchHump(p);
        if (extra > zoomExtra) zoomExtra = extra;
        break;
      }
      case "vignette-pulse": {
        // 端 alpha = intensity*0.5 を山型に
        const a = i * 0.5 * bell(p);
        if (a > out.vignetteAlpha) out.vignetteAlpha = a;
        break;
      }
      case "blur-burst": {
        // 0 → intensity*8px → 0 の山型（design 基準 px を解像度換算）
        const b = i * 8 * bell(p) * pxScale;
        if (b > out.blurPx) out.blurPx = b;
        break;
      }
      case "colorgrade": {
        // §B 雰囲気系: 区間内は一定で適用（脈動なし）。strength は params。
        const pr = L.screenEffectParams ?? {};
        const st = Math.max(0, Math.min(1, pr.strength ?? 0.5));
        if (st <= 0) break;
        const mode = pr.mode ?? "grade";
        if (mode === "grade") {
          // 彩度・コントラストを強める（CSS/Canvas filter）
          out.gradeFilter = `saturate(${(1 + st).toFixed(3)}) contrast(${(
            1 +
            st * 0.4
          ).toFixed(3)})`;
        } else if (mode === "tint") {
          out.tintColor = pr.color ?? "#1E3A5F";
          out.tintAlpha = st;
        }
        // duotone は全ピクセル処理で重いため未対応（無視）。
        break;
      }
      case "blur": {
        // 全画面 blur（区間内一定）。描画前 ctx.filter の blurPx に合算（max）。
        const r = (L.screenEffectParams?.radius ?? 6) * pxScale;
        if (r > out.blurPx) out.blurPx = r;
        break;
      }
      case "grain": {
        const pr = L.screenEffectParams ?? {};
        const st = Math.max(0, Math.min(1, pr.strength ?? 0.5));
        if (st > 0) {
          out.grain = {
            type: pr.type ?? "grain",
            strength: st,
            speed: Math.max(0, pr.speed ?? 1),
          };
        }
        break;
      }
      default:
        break;
    }
  }

  if (shakeIntensity > 0) {
    const seed = Math.floor(t * 30);
    out.dx = rng(seed) * shakeIntensity * 16 * pxScale;
    out.dy = rng(seed + 1) * shakeIntensity * 16 * pxScale;
  }
  out.scale = 1 + zoomExtra;
  return out;
}

/** layers に「いずれかの時刻で効く」effect layer が含まれるか（早期スキップ用） */
export function hasScreenEffect(layers: Layer[]): boolean {
  return layers.some((l) => l.type === "effect");
}

/** Phase2 §C 場面転換の最終合成への適用量。 */
export interface TransitionFx {
  /** fade-black の黒被せ alpha（0..1）。中心(atSec)で最大。 */
  blackAlpha: number;
  /** zoom の拡大率（中心基準）。1.0 = 等倍。 */
  scale: number;
}

/**
 * 時刻 t での transition 適用量。atSec を中心に ±duration/2 の窓で bell 型（中心=最大）。
 * fade-black=黒被せ / zoom=拡大。wipe/push/dissolve は前後フレーム合成が必要なため未対応（無視）。
 * 同時刻に複数該当したら効果値の最大を採る。
 */
export function computeTransition(
  transitions: TransitionSpec[] | undefined,
  t: number,
): TransitionFx {
  const out: TransitionFx = { blackAlpha: 0, scale: 1 };
  if (!transitions || transitions.length === 0) return out;
  let zoomExtra = 0;
  for (const tr of transitions) {
    const dur = Math.max(0.05, tr.duration ?? 0.5);
    const half = dur / 2;
    if (t < tr.atSec - half || t > tr.atSec + half) continue;
    const p = (t - (tr.atSec - half)) / dur; // 0..1
    const b = bell(p); // 中心で 1
    if (tr.style === "fade-black") {
      if (b > out.blackAlpha) out.blackAlpha = b;
    } else if (tr.style === "zoom") {
      const e = 0.2 * b; // 中心で +20% 拡大
      if (e > zoomExtra) zoomExtra = e;
    }
    // wipe / push / dissolve は computeSnapshotTransition + composeSnapshotTransition で別途処理。
  }
  out.scale = 1 + zoomExtra;
  return out;
}

/** wipe/push/dissolve のアクティブ窓情報（前後フレーム合成が必要なトランジション）。 */
export interface SnapshotTransition {
  atSec: number;
  /** 窓開始時刻（= 前シーンのスナップ時刻）。 */
  ts: number;
  /** 窓終了時刻（= 後シーンのスナップ時刻）。 */
  te: number;
  style:
    | "wipe"
    | "push"
    | "dissolve"
    | "glitch"
    | "circle-wipe"
    | "blinds";
  /** 窓内 0..1（前→後の遷移度）。 */
  progress: number;
  direction: "left-to-right" | "right-to-left" | "up" | "down";
}

/**
 * 時刻 t でアクティブな wipe/push/dissolve トランジションを返す（無ければ null）。
 * atSec 中心 ±duration/2 の窓。複数該当時は最初のものを採る。
 */
export function computeSnapshotTransition(
  transitions: TransitionSpec[] | undefined,
  t: number,
): SnapshotTransition | null {
  if (!transitions) return null;
  const SNAPSHOT_STYLES = [
    "wipe",
    "push",
    "dissolve",
    "glitch",
    "circle-wipe",
    "blinds",
  ];
  for (const tr of transitions) {
    if (!SNAPSHOT_STYLES.includes(tr.style)) continue;
    const dur = Math.max(0.05, tr.duration ?? 0.5);
    const half = dur / 2;
    if (t < tr.atSec - half || t > tr.atSec + half) continue;
    return {
      atSec: tr.atSec,
      ts: tr.atSec - half,
      te: tr.atSec + half,
      style: tr.style as SnapshotTransition["style"],
      progress: Math.max(0, Math.min(1, (t - (tr.atSec - half)) / dur)),
      direction: tr.direction ?? "left-to-right",
    };
  }
  return null;
}

type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * 前シーン(prev) と 後シーン(cur) を style/progress に従って ctx に合成する。
 * ctx は呼び出し側でクリア済みであること。prev/cur は同サイズの canvas。
 */
export function composeSnapshotTransition(
  ctx: AnyCtx,
  prev: CanvasImageSource,
  cur: CanvasImageSource,
  s: SnapshotTransition,
  w: number,
  h: number,
): void {
  const p = s.progress;
  const D = s.direction;
  if (s.style === "dissolve") {
    ctx.drawImage(cur, 0, 0);
    ctx.save();
    ctx.globalAlpha = 1 - p; // 前シーンが薄れて後シーンへ
    ctx.drawImage(prev, 0, 0);
    ctx.restore();
    return;
  }
  if (s.style === "push") {
    // 前が方向へ抜け、後が同方向から入る
    let pdx = 0;
    let pdy = 0;
    let cdx = 0;
    let cdy = 0;
    if (D === "left-to-right") {
      pdx = p * w;
      cdx = (p - 1) * w;
    } else if (D === "right-to-left") {
      pdx = -p * w;
      cdx = (1 - p) * w;
    } else if (D === "up") {
      pdy = -p * h;
      cdy = (1 - p) * h;
    } else {
      pdy = p * h;
      cdy = (p - 1) * h;
    }
    ctx.drawImage(cur, cdx, cdy);
    ctx.drawImage(prev, pdx, pdy);
    return;
  }
  if (s.style === "circle-wipe") {
    // 中心から円が広がって後シーンが現れる
    ctx.drawImage(prev, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, (p * Math.hypot(w, h)) / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(cur, 0, 0);
    ctx.restore();
    return;
  }
  if (s.style === "blinds") {
    // 複数の横帯が同時に開いて後シーンが現れる
    ctx.drawImage(prev, 0, 0);
    ctx.save();
    const n = 12;
    const bandH = h / n;
    ctx.beginPath();
    for (let k = 0; k < n; k++) ctx.rect(0, k * bandH, w, bandH * p);
    ctx.clip();
    ctx.drawImage(cur, 0, 0);
    ctx.restore();
    return;
  }
  if (s.style === "glitch") {
    // 中盤でグリッチ最大。横スライスをランダムにずらして prev↔cur を混ぜる
    const base = p < 0.5 ? prev : cur;
    const other = p < 0.5 ? cur : prev;
    ctx.drawImage(base, 0, 0);
    const intensity = 1 - Math.abs(p - 0.5) * 2; // 0→1→0
    if (intensity > 0.05) {
      const slices = 14;
      const sliceH = h / slices;
      const phase = Math.floor(p * 24); // コマ送り
      for (let k = 0; k < slices; k++) {
        const r =
          Math.abs(Math.sin((k + 1) * 12.9898 + phase * 78.233) * 43758.5453) %
          1;
        if (r < intensity * 0.8) {
          const dx = (r - 0.5) * w * 0.18 * intensity;
          ctx.drawImage(
            other,
            0,
            k * sliceH,
            w,
            sliceH,
            dx,
            k * sliceH,
            w,
            sliceH,
          );
        }
      }
    }
    return;
  }
  // wipe(slide-in): 前シーンを下に敷き、後シーンを画面端から境界まで「中身ごと」流し込む。
  // （後シーンが定位置で露出する reveal 型ではなく、端からスライドして入ってくる）
  ctx.drawImage(prev, 0, 0);
  ctx.save();
  ctx.beginPath();
  let cdx = 0;
  let cdy = 0;
  if (D === "right-to-left") {
    ctx.rect((1 - p) * w, 0, p * w, h); // 右側が見える領域
    cdx = (1 - p) * w; // 後シーンが右から入る
  } else if (D === "up") {
    ctx.rect(0, (1 - p) * h, w, p * h); // 下側が見える領域
    cdy = (1 - p) * h; // 後シーンが下から入る
  } else if (D === "down") {
    ctx.rect(0, 0, w, p * h); // 上側が見える領域
    cdy = (p - 1) * h; // 後シーンが上から入る
  } else {
    ctx.rect(0, 0, p * w, h); // 左側が見える領域（left-to-right）
    cdx = (p - 1) * w; // 後シーンが左から入る
  }
  ctx.clip();
  ctx.drawImage(cur, cdx, cdy);
  ctx.restore();
}
