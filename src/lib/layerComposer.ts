import { invoke } from "@tauri-apps/api/core";
import type { Layer } from "../types";
import { sortedLayers } from "./layerUtils";
import { sampleLayerAt } from "./keyframes";
import {
  applyAnchorOffset,
  easeOf,
  hasAnimKfs,
  sampleAnimKfs,
} from "./animKeyframes";
import { hasMotionPath, sampleMotionPath } from "./motionPath";
import { computeLayerFilterCss } from "./layerFilter";
import {
  drawSpeedlines,
  drawSpotlight,
  drawParticles,
  drawSteam,
} from "./effectShape";
import { resolveDynamicText } from "./counterText";
import { bubbleFullPath } from "./bubble";
import {
  computeMarker,
  hashSeed,
  isMarkerShape,
  markerColor,
  mulberry32,
} from "./markerShape";
import {
  computeHandwrite,
  hasHandwrite,
  resolveSurface,
} from "./handwriteStroke";
import {
  computeCanvasAnim,
  applyCanvasAnim,
  computeMotion,
  applyMotion,
} from "./layerAnimCanvas";

// 出力解像度（テンプレのアスペクトに応じて、composition 開始前に setCompositionCanvasDimensions で切替）。
// デフォルトは旧テンプレ互換の縦 (1080x1920)。
let FINAL_W = 1080;
let FINAL_H = 1920;

// 手書き（筆順）を全文表示で描くか。renderLayersOnContext 冒頭で opts から設定する
// （preview 停止/スクラブ時のみ true。レンダリングは逐次なので module 変数で安全）。
let staticHandwriteFlag = false;

/**
 * 合成コマンドを呼ぶ前に、テンプレの出力解像度をセットする。
 * 全 compose 関数 / drawText / drawAnimatedTextFrame 等の内部処理がこの値を参照する。
 * シーケンシャル前提（同時に複数テンプレを合成しない）。
 */
export function setCompositionCanvasDimensions(width: number, height: number) {
  FINAL_W = Math.max(2, Math.floor(width));
  FINAL_H = Math.max(2, Math.floor(height));
}

export function getCompositionCanvasDimensions(): { width: number; height: number } {
  return { width: FINAL_W, height: FINAL_H };
}

/** 1レイヤーの画像/動画ソースを解決する関数。動画は1フレーム目を静止画として使う想定 */
export type LayerSourceResolver = (layer: Layer) => Promise<string | null>;

/** Canvas で全レイヤーを合成し、PNG として保存した絶対パスを返す（実生成用・動画レイヤーは除外） */
export async function composeLayersToPng(
  layers: Layer[],
  resolveSrc: LayerSourceResolver,
  sessionId: string,
  filename: string,
  atTimeSec?: number,
): Promise<string> {
  const dataUrl = await composeLayersToDataUrl(layers, resolveSrc, {
    skipVideoLayers: true,
    atTimeSec,
  });
  const base64 = dataUrl.split(",", 2)[1];
  const savedPath = await invoke<string>("save_overlay_png", {
    sessionId,
    filename,
    base64Data: base64,
  });
  return savedPath;
}

/** Canvas で全レイヤーを合成し、data URL（PNG）を返す（プレビュー用） */
export async function composeLayersToDataUrl(
  layers: Layer[],
  resolveSrc: LayerSourceResolver,
  opts: {
    skipVideoLayers?: boolean;
    atTimeSec?: number;
    transparent?: boolean;
  } = {},
): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = FINAL_W;
  canvas.height = FINAL_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context を取得できませんでした");

  await renderLayersOnContext(ctx, layers, resolveSrc, opts);

  return canvas.toDataURL("image/png");
}

/**
 * 指定 ctx に時刻 t（opts.atTimeSec）で全レイヤーを合成する。
 * WebCodecs エクスポート等で canvas を使い回す経路から呼ぶ。
 * - opts.transparent=false（既定）なら黒背景でクリア。true なら透明クリア。
 * - opts.skipVideoLayers=true で video レイヤーを除外（preview の static PNG 焼き向け）。
 */
export async function renderLayersOnContext(
  ctx:
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D,
  layers: Layer[],
  resolveSrc: LayerSourceResolver,
  opts: {
    skipVideoLayers?: boolean;
    atTimeSec?: number;
    transparent?: boolean;
    /** layer.id → 現在フレームソース (HTMLVideoElement / OffscreenCanvas 等)。
     * WebCodecs 経路で video / character レイヤーを直接 drawImage するのに使う。 */
    videoFrameSources?: Map<string, CanvasImageSource>;
    /** true なら入退場アニメ等の動的変換を適用する (WebCodecs エクスポート用)。
     * 既存の PNG 焼き経路 (composeLayerContentPng) は false のまま使う。 */
    applyAnim?: boolean;
    /** 手書き（筆順）を全文表示(p=1)で描く。preview が停止/スクラブ中に渡す
     * （編集レイアウト安定用。実 export は渡さない＝時刻どおりに書き進む）。 */
    staticHandwrite?: boolean;
  } = {},
): Promise<void> {
  staticHandwriteFlag = opts.staticHandwrite === true;
  if (opts.transparent) {
    ctx.clearRect(0, 0, FINAL_W, FINAL_H);
  } else {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, FINAL_W, FINAL_H);
  }

  const t = opts.atTimeSec;
  for (const layer of sortedLayers(layers)) {
    if (layer.type === "video" && opts.skipVideoLayers) continue;
    // 指定時刻で不可視なら描画しない
    if (t !== undefined && (t < layer.startSec || t >= layer.endSec)) continue;
    // 時刻指定があればキーフレーム補間を反映
    const drawTarget = t !== undefined ? applyKeyframesAtTime(layer, t) : layer;
    await drawLayer(
      ctx as CanvasRenderingContext2D,
      drawTarget,
      resolveSrc,
      opts.videoFrameSources,
      opts.applyAnim ? t : undefined,
    );
  }
}

/** 指定時刻でのキーフレーム補間値を layer に適用した新しい Layer を返す（グローバル時刻 t） */
function applyKeyframesAtTime(layer: Layer, t: number): Layer {
  // curio-gen アニメ仕様の kfs(§4) / motionPath(§8) があれば優先。
  // どちらも startSec 相対秒・easing 付き。これらがある層は entry/exit/motion を無視し、
  // _kfsDriven フラグで drawLayer 側の computeCanvasAnim/computeMotion を抑止する
  // （ambient は別途加算され続ける）。kfs と motionPath の x,y が両方あれば motionPath を優先（§8）。
  const hasKfs = hasAnimKfs(layer);
  const hasPath = hasMotionPath(layer);
  if (hasKfs || hasPath) {
    const tRel = t - layer.startSec;
    let x = layer.x;
    let y = layer.y;
    let rotation = layer.rotation ?? 0;
    let opacity = layer.opacity ?? 1;
    // §A2: 最終サイズ %。kfs の width/height（絶対）優先、無ければ scale で算出。
    let wPct = layer.width;
    let hPct = layer.height;
    // §A3: 色 / borderRadius の補間値（kfs に定義があるときだけ上書き）。
    const colorOverrides: Partial<
      Pick<Layer, "fillColor" | "fontColor" | "textOutlineColor" | "borderRadius">
    > = {};
    if (hasKfs) {
      const s = sampleAnimKfs(layer, tRel);
      x = s.x;
      y = s.y;
      rotation = s.rotation;
      opacity = s.opacity;
      wPct = s.width !== undefined ? s.width : layer.width * s.scale;
      hPct = s.height !== undefined ? s.height : layer.height * s.scale;
      if (s.fillColor !== undefined) colorOverrides.fillColor = s.fillColor;
      if (s.fontColor !== undefined) colorOverrides.fontColor = s.fontColor;
      if (s.textOutlineColor !== undefined)
        colorOverrides.textOutlineColor = s.textOutlineColor;
      if (s.borderRadius !== undefined)
        colorOverrides.borderRadius = s.borderRadius;
    }
    if (hasPath) {
      const p = sampleMotionPath(layer, tRel); // 位置のみ・kfs の x,y より優先
      x = p.x;
      y = p.y;
    }
    // §A1: anchor 指定時のみ、サイズ変化分だけ x,y をずらしてアンカー辺を固定。
    // anchor 未指定なら従来どおり左上固定（既存挙動を完全維持）。
    const adj = applyAnchorOffset(
      layer.anchor,
      x,
      y,
      layer.width,
      layer.height,
      wPct,
      hPct,
    );
    return {
      ...layer,
      x: adj.x,
      y: adj.y,
      width: wPct,
      height: hPct,
      rotation,
      opacity,
      ...colorOverrides,
      _kfsDriven: true,
    } as Layer & { _kfsDriven: boolean };
  }
  if (!layer.keyframes) return layer;
  const s = sampleLayerAt(layer, t);
  return {
    ...layer,
    x: s.x,
    y: s.y,
    width: s.width,
    height: s.height,
    rotation: s.rotation,
    opacity: s.opacity,
  };
}

/** 単一レイヤーを透明背景の PNG として保存して絶対パスを返す（時間ゲート overlay 用） */
export async function composeSingleLayerToTransparentPng(
  layer: Layer,
  resolveSrc: LayerSourceResolver,
  sessionId: string,
  filename: string,
): Promise<string> {
  const dataUrl = await composeLayersToDataUrl([layer], resolveSrc, {
    skipVideoLayers: true,
    transparent: true,
  });
  const base64 = dataUrl.split(",", 2)[1];
  return invoke<string>("save_overlay_png", {
    sessionId,
    filename,
    base64Data: base64,
  });
}

/** composeLayerContentPng の戻り値 */
export interface LayerPngResult {
  path: string;
  /** 吹き出しのしっぽで枠外に描画した左/上/右/下のピクセル拡張量（それ以外は 0） */
  padL: number;
  padT: number;
  padR: number;
  padB: number;
}

/**
 * レイヤーの「中身だけ」をレイヤーピクセル寸法 (w×h) の透明 PNG に描画して保存する。
 * 位置と回転は PNG には含めない（Rust 側で overlay 時に適用する）。
 * 図形クリップ（circle/rounded）は PNG に焼き込む。
 *
 * 吹き出し（comment + bubble.tail）のしっぽが枠外に出る場合は PNG を拡張し、
 * 拡張量 (padL/padT/padR/padB) を返す。呼び出し側は overlay 位置/サイズをこの分だけ調整する。
 */
export async function composeLayerContentPng(
  layer: Layer,
  resolveSrc: LayerSourceResolver,
  sessionId: string,
  filename: string,
): Promise<LayerPngResult> {
  const w = Math.max(2, Math.round((layer.width / 100) * FINAL_W));
  const h = Math.max(2, Math.round((layer.height / 100) * FINAL_H));

  // 吹き出しのしっぽで枠外に出る場合、その分 PNG を拡張する
  const tail = layer.type === "comment" ? layer.bubble?.tail : undefined;
  let padL = 0;
  let padT = 0;
  let padR = 0;
  let padB = 0;
  if (tail) {
    if (tail.tipX < 0) padL = Math.ceil((-tail.tipX / 100) * w);
    if (tail.tipX > 100) padR = Math.ceil(((tail.tipX - 100) / 100) * w);
    if (tail.tipY < 0) padT = Math.ceil((-tail.tipY / 100) * h);
    if (tail.tipY > 100) padB = Math.ceil(((tail.tipY - 100) / 100) * h);
  }

  // 複数行テキストが layer の高さを超える場合、PNG を縦に拡張して全行が描画に収まるようにする
  // 手動改行 \n だけでなく、layer 幅での自動折り返し後の行数で判定する（プレビューと一致させる）
  if (layer.type === "comment" && layer.text) {
    const lines = computeLayerTextLines(layer, w);
    if (lines.length > 1) {
      const fontSize = (layer.fontSize ?? 48) * (FINAL_W / 360);
      const lineHeight = fontSize * 1.2;
      const totalTextH = lines.length * lineHeight;
      if (totalTextH > h) {
        const extra = Math.ceil((totalTextH - h) / 2);
        padT = Math.max(padT, extra);
        padB = Math.max(padB, extra);
      }
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = w + padL + padR;
  canvas.height = h + padT + padB;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context を取得できませんでした");

  if (padL || padT) ctx.translate(padL, padT);
  await drawLayerContentOnly(ctx, layer, w, h, resolveSrc);

  const base64 = canvas.toDataURL("image/png").split(",", 2)[1];
  const path = await invoke<string>("save_overlay_png", {
    sessionId,
    filename,
    base64Data: base64,
  });
  return { path, padL, padT, padR, padB };
}

/** レイヤーの中身（図形クリップ + 描画 + ボーダー）だけを (0,0)-(w,h) に描く。位置・回転は扱わない */
async function drawLayerContentOnly(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  w: number,
  h: number,
  resolveSrc: LayerSourceResolver,
): Promise<void> {
  ctx.save();
  // opacity は Rust 側で colorchannelmixer=aa=... により適用されるため、ここでは焼き込まない
  // （以前は二重適用で opacity 0.5 が出力 0.25 になる致命傷があった）
  ctx.globalAlpha = 1;
  // 吹き出しは shape ではなく bubble path で描画するので、矩形/circle クリップは適用しない
  // （tail が枠外に出る場合にクリップで切られてしまうのを防ぐ）
  if (!(layer.type === "comment" && layer.bubble)) {
    applyShapeClip(ctx, layer, w, h);
  }

  try {
    switch (layer.type) {
      case "image":
      case "video": {
        const src = await resolveSrc(layer);
        if (src) {
          const img = await loadImage(src);
          const imgW = img.width || (img as HTMLImageElement).naturalWidth || w;
          const imgH = img.height || (img as HTMLImageElement).naturalHeight || h;
          // crop: 素材に対する % で指定された矩形だけをソースとして使う
          const crop = layer.crop;
          const sx = crop ? (crop.x / 100) * imgW : 0;
          const sy = crop ? (crop.y / 100) * imgH : 0;
          const sw = crop ? (crop.width / 100) * imgW : imgW;
          const sh = crop ? (crop.height / 100) * imgH : imgH;
          const scale = Math.max(w / sw, h / sh);
          const drawW = sw * scale;
          const drawH = sh * scale;
          const dx = (w - drawW) / 2;
          const dy = (h - drawH) / 2;
          ctx.drawImage(img, sx, sy, sw, sh, dx, dy, drawW, drawH);
        }
        break;
      }
      case "color":
      case "shape":
        if (layer.shape === "arc") {
          drawArcShape(ctx, layer, w, h);
        } else {
          // preview と合わせるため shape 既定は #FFE600、color 既定は #333
          const def = layer.type === "shape" ? "#FFE600" : "#333";
          ctx.fillStyle = layer.fillGradient
            ? buildLinearGradient(ctx, layer.fillGradient, w, h)
            : layer.fillColor ?? def;
          ctx.fillRect(0, 0, w, h);
        }
        break;
      case "comment":
        if (layer.bubble) {
          // 吹き出し形状で背景と枠を描画（既存の shape/border 経路はスキップ）
          const path2d = new Path2D(
            bubbleFullPath(
              w,
              h,
              layer.bubble,
              (layer.borderRadius ?? 12) * (FINAL_W / 360),
            ),
          );
          ctx.fillStyle = layer.fillColor
            ? parseRgba(layer.fillColor)
            : "rgba(255,255,255,0.95)";
          ctx.fill(path2d);
          if (layer.border && layer.border.width > 0) {
            ctx.save();
            ctx.strokeStyle = layer.border.color;
            ctx.lineWidth = layer.border.width * (FINAL_W / 360);
            ctx.stroke(path2d);
            ctx.restore();
          }
        } else if (layer.fillColor) {
          ctx.fillStyle = parseRgba(layer.fillColor);
          ctx.fillRect(0, 0, w, h);
        }
        drawText(ctx, layer, w, h);
        break;
    }
  } catch (e) {
    console.warn("[layerComposer] layer content draw failed:", layer.id, e);
  }

  ctx.restore();

  // border は bubble で既に描画済みなのでスキップ。
  // preview の CSS `inset boxShadow` と一致させるため、stroke を枠内側に inset する
  // （Canvas の stroke は中心線基準で半分外側に出るため、そのままだと PNG 境界で切れる）
  if (!layer.bubble && layer.border && layer.border.width > 0) {
    ctx.save();
    const lw = layer.border.width * (FINAL_W / 360);
    ctx.strokeStyle = layer.border.color;
    ctx.lineWidth = lw;
    const inset = lw / 2;
    if (layer.shape === "circle") {
      ctx.beginPath();
      ctx.ellipse(w / 2, h / 2, Math.max(0, w / 2 - inset), Math.max(0, h / 2 - inset), 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (layer.shape === "rounded") {
      const r = (layer.borderRadius ?? 12) * (FINAL_W / 360);
      const innerR = Math.max(0, Math.min(r - inset, (w - lw) / 2, (h - lw) / 2));
      roundRectPath(ctx, inset, inset, Math.max(0, w - lw), Math.max(0, h - lw), innerR);
      ctx.stroke();
    } else {
      ctx.strokeRect(inset, inset, Math.max(0, w - lw), Math.max(0, h - lw));
    }
    ctx.restore();
  }
}

/** reveal(§A4) の進捗 0..1（ease 適用後）。reveal 無し / 時刻不明なら 1（全表示）。 */
function revealProgress(layer: Layer, animAtTimeSec?: number): number {
  const rv = layer.reveal;
  if (!rv) return 1;
  if (animAtTimeSec === undefined) return 1;
  const dur = rv.duration && rv.duration > 0 ? rv.duration : 0.6;
  const tRel = animAtTimeSec - layer.startSec - (rv.t ?? 0);
  const p = Math.max(0, Math.min(1, tRel / dur));
  return easeOf(rv.ease)(p);
}

/**
 * reveal(§A4) のクリップを現在のローカル箱 [0,w]×[0,h] に適用。
 * 進捗 p に応じて方向別に表示領域を絞る。p>=1 は何もしない（全表示）。
 */
function applyRevealClip(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  w: number,
  h: number,
  animAtTimeSec?: number,
): void {
  const rv = layer.reveal;
  if (!rv) return;
  const p = revealProgress(layer, animAtTimeSec);
  if (p >= 1) return;
  ctx.beginPath();
  switch (rv.direction) {
    case "right-to-left":
      ctx.rect(w * (1 - p), 0, w * p, h);
      break;
    case "top-to-bottom":
      ctx.rect(0, 0, w, h * p);
      break;
    case "bottom-to-top":
      ctx.rect(0, h * (1 - p), w, h * p);
      break;
    case "center-out":
      ctx.rect((w - w * p) / 2, (h - h * p) / 2, w * p, h * p);
      break;
    case "radial":
      ctx.arc(w / 2, h / 2, (p * Math.hypot(w, h)) / 2, 0, Math.PI * 2);
      break;
    case "left-to-right":
    default:
      ctx.rect(0, 0, w * p, h);
      break;
  }
  ctx.clip();
}

/**
 * per-layer filter(§A6) を現在の ctx.filter に結合適用（ambient/anim の filter を上書きせず連結）。
 * drawLayerContentInBox の前に呼ぶこと。
 */
function applyLayerFilter(ctx: CanvasRenderingContext2D, layer: Layer): void {
  const css = computeLayerFilterCss(layer, FINAL_W / 360);
  if (!css) return;
  const cur = ctx.filter && ctx.filter !== "none" ? ctx.filter + " " : "";
  ctx.filter = cur + css;
}

async function drawLayer(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  resolveSrc: LayerSourceResolver,
  videoFrameSources?: Map<string, CanvasImageSource>,
  animAtTimeSec?: number,
): Promise<void> {
  // effect レイヤー: 全画面後処理系（effectKind）は pixel を出さず合成段で適用するためスキップ。
  // 描画系（layer.effect = speedlines/spotlight・§B）はこの層で領域に描くので通常フローに通す。
  if (layer.type === "effect" && !layer.effect) return;

  const w = (layer.width / 100) * FINAL_W;
  const h = (layer.height / 100) * FINAL_H;
  const x = (layer.x / 100) * FINAL_W;
  const y = (layer.y / 100) * FINAL_H;

  ctx.save();
  ctx.globalAlpha = layer.opacity ?? 1;

  // 回転を含めた transform (layer の static rotation)
  if (layer.rotation) {
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate((layer.rotation * Math.PI) / 180);
    ctx.translate(-w / 2, -h / 2);
  } else {
    ctx.translate(x, y);
  }

  // 入退場/ambient と motion を計算（適用は flip 有無で分岐）。
  // preview の DOM 構造に合わせる:
  //   outer(rotation, overflow:hidden = 箱の矩形クリップ・固定) > inner(motion/anim/ambient
  //   transform, borderRadius)。よって非 flip では「固定の矩形クリップ → 内側で motion/anim →
  //   角丸クリップ → 中身描画」の順にする。これで motion/anim の拡大・移動が箱を越えて
  //   膨らむのを防ぐ（旧実装は motion を箱クリップの外で適用しており、zoom 系 motion を持つ
  //   color/shape カードが export で膨らんで見切れていた）。
  // kfs 駆動レイヤーは entry/exit/motion を無視（仕様 §4。位置/scale/opacity/rotation は
  // applyKeyframesAtTime で既に layer に反映済み）。ambient は加算で残す。
  const kfsDriven = (layer as Layer & { _kfsDriven?: boolean })._kfsDriven === true;
  let flipDeg = 0;
  let anim: ReturnType<typeof computeCanvasAnim> | null = null;
  if (animAtTimeSec !== undefined) {
    // ambient の絶対 px 振幅を design(360) → 出力解像度へ換算する係数 FINAL_W/360
    anim = computeCanvasAnim(layer, animAtTimeSec, w, h, FINAL_W / 360, kfsDriven);
    flipDeg = anim.flipDeg;
  }
  const motion =
    animAtTimeSec !== undefined && !kfsDriven
      ? computeMotion(layer, animAtTimeSec)
      : null;

  const isBubble = layer.type === "comment" && !!layer.bubble;
  // marker は箱で塗らずストロークが箱を少し越える（円の重なり・jitter）ので、
  // bubble と同様にクリップ・箱 border を適用しない。
  const noClip = isBubble || isMarkerShape(layer.shape);
  // ambient（揺れ/回転/円運動/伸縮）がある層は箱を越えて動くのが正しいので、固定の箱クリップを
  // 掛けない（中身の形は後段の shape クリップが保持する）。掛けると orbit/sway/pulse 等が見切れる。
  const hasMovingAmbient =
    !!layer.ambientAnimation && layer.ambientAnimation !== "none";

  // flip (perspective rotateY) は Canvas 2D の scale では 2D 近似になるため、
  // 中身を一旦平面でオフスクリーンに描き、列スライス warp で本物の 3D 見えを再現する。
  if (flipDeg !== 0) {
    if (motion) applyMotion(ctx, motion, w, h);
    if (anim) applyCanvasAnim(ctx, anim, w, h);
    applyLayerFilter(ctx, layer); // §A6: warp 像に glow/blur/shadow を適用
    const tw = Math.max(1, Math.ceil(w));
    const th = Math.max(1, Math.ceil(h));
    const temp = new OffscreenCanvas(tw, th);
    const tctx = temp.getContext("2d") as CanvasRenderingContext2D | null;
    if (tctx) {
      if (!noClip) applyShapeClip(tctx, layer, w, h);
      applyRevealClip(tctx, layer, w, h, animAtTimeSec);
      await drawLayerContentInBox(
        tctx,
        layer,
        w,
        h,
        resolveSrc,
        videoFrameSources,
        animAtTimeSec,
      );
      if (!noClip) {
        // perspective で枠外にはみ出す分は箱でクリップ（preview の outer overflow:hidden 相当）
        ctx.beginPath();
        ctx.rect(0, 0, w, h);
        ctx.clip();
      }
      drawFlipWarp(ctx, temp, w, h, flipDeg, 500 * (FINAL_W / 360));
    }
    ctx.restore();
    if (layer.border && layer.border.width > 0 && !noClip) {
      drawBorder(ctx, layer, x, y, w, h);
    }
    return;
  }

  const filterCss = computeLayerFilterCss(layer, FINAL_W / 360);
  if (filterCss) {
    // §A6: glow/shadow は要素の外側へ広がるため、箱クリップ後に描くと切れてしまう。
    // 中身を一旦オフスクリーンに（形状/reveal クリップ込みで）描き、箱の矩形クリップは掛けずに
    // ctx.filter 付きで本キャンバスへ合成 → 影/発光が箱の外へ出られる（CSS filter と同じ挙動）。
    if (motion) applyMotion(ctx, motion, w, h);
    if (anim) applyCanvasAnim(ctx, anim, w, h);
    const tw = Math.max(1, Math.ceil(w));
    const th = Math.max(1, Math.ceil(h));
    const temp = new OffscreenCanvas(tw, th);
    const tctx = temp.getContext("2d") as CanvasRenderingContext2D | null;
    if (tctx) {
      if (!noClip) applyShapeClip(tctx, layer, w, h);
      applyRevealClip(tctx, layer, w, h, animAtTimeSec);
      await drawLayerContentInBox(
        tctx,
        layer,
        w,
        h,
        resolveSrc,
        videoFrameSources,
        animAtTimeSec,
      );
      // ambient/anim の ctx.filter に layer filter を連結し、合成 blit に適用
      applyLayerFilter(ctx, layer);
      ctx.drawImage(temp, 0, 0, tw, th);
    }
  } else {
    // 1) preview の outer overflow:hidden 相当 = 箱の矩形クリップ（transform の外側で固定）。
    //    ただし ambient がある層は箱を越えて動く演出なのでスキップ（見切れ防止）。
    if (!noClip && !hasMovingAmbient) {
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.clip();
    }
    // 2) inner transform（motion → 入退場/ambient）。矩形クリップの内側なので箱を越えない
    if (motion) applyMotion(ctx, motion, w, h);
    if (anim) applyCanvasAnim(ctx, anim, w, h);
    // 3) preview の inner borderRadius 相当 = 形状クリップ（transform と一緒に動く）
    if (!noClip) {
      applyShapeClip(ctx, layer, w, h);
    }
    // 3.5) reveal(§A4) クリップ（形状クリップの内側でさらに方向ワイプ）
    applyRevealClip(ctx, layer, w, h, animAtTimeSec);
    await drawLayerContentInBox(
      ctx,
      layer,
      w,
      h,
      resolveSrc,
      videoFrameSources,
      animAtTimeSec,
    );
  }

  ctx.restore();

  // Border（クリップの外に描く必要があるため restore 後）。
  // 吹き出しの枠は drawBubbleShape が描くので、marker は箱枠を持たないのでスキップする。
  if (layer.border && layer.border.width > 0 && !noClip) {
    drawBorder(ctx, layer, x, y, w, h);
  }
}

/** #RGB/#RRGGBB を [r,g,b] に。解釈不能は null。 */
function hexToRgb(hex: string): [number, number, number] | null {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return null;
  return [r, g, b];
}

/** クロマキー: tctx 全体で keyColor 近傍ピクセルを透明化（境界は smoothness でぼかす）。 */
function applyChromaKey(
  tctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  w: number,
  h: number,
  ck: NonNullable<Layer["chromaKey"]>,
): void {
  const key = hexToRgb(ck.color);
  if (!key) return;
  const thr = (ck.threshold ?? 0.4) * 441.673; // 0..1 → RGB 距離（√3*255）
  const band = Math.max(1, (ck.smoothness ?? 0.1) * 441.673);
  const img = tctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const dist = Math.sqrt(
      (d[i] - key[0]) ** 2 + (d[i + 1] - key[1]) ** 2 + (d[i + 2] - key[2]) ** 2,
    );
    if (dist <= thr) d[i + 3] = 0;
    else if (dist < thr + band)
      d[i + 3] = Math.round(d[i + 3] * ((dist - thr) / band));
  }
  tctx.putImageData(img, 0, 0);
}

/** cover 描画。chromaKey があればオフスクリーンで色抜きしてから合成、無ければ直接 drawImage。 */
function drawImageMaybeChroma(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  layer: Layer,
  w: number,
  h: number,
): void {
  const ck = layer.chromaKey;
  if (!ck) {
    ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
    return;
  }
  const tw = Math.max(1, Math.ceil(w));
  const th = Math.max(1, Math.ceil(h));
  const temp = new OffscreenCanvas(tw, th);
  const tctx = temp.getContext("2d", { willReadFrequently: true });
  if (!tctx) {
    ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
    return;
  }
  tctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
  applyChromaKey(tctx, tw, th, ck);
  ctx.drawImage(temp, 0, 0);
}

/**
 * レイヤーの「中身」だけを ctx の現在原点 (= レイヤー左上) に [0,w]×[0,h] で描く。
 * 位置・回転・入退場 transform・クリップは呼び出し側の責務。
 * flip warp では一旦オフスクリーンへ平面描画するために切り出した。
 */
async function drawLayerContentInBox(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  w: number,
  h: number,
  resolveSrc: LayerSourceResolver,
  videoFrameSources?: Map<string, CanvasImageSource>,
  animAtTimeSec?: number,
): Promise<void> {
  try {
    switch (layer.type) {
      case "image":
      case "video":
      case "character": {
        // 動画 / キャラレイヤーで videoFrameSources に登録があれば、現在フレームを
        // 直接 drawImage する (WebCodecs エクスポート経路)。
        // character は事前に composeCharacterLayerVideo で焼いた .webm を
        // video と同じ VideoSampleSink 経路で流すので、ここでは frameSource として届く。
        const frameSource =
          layer.type === "video" || layer.type === "character"
            ? videoFrameSources?.get(layer.id)
            : undefined;
        if (frameSource) {
          // VideoFrame (WebCodecs): displayWidth/codedWidth を見る
          // HTMLVideoElement: videoWidth
          // HTMLImageElement: naturalWidth
          // ImageBitmap / OffscreenCanvas: width
          const fs = frameSource as unknown as {
            displayWidth?: number;
            displayHeight?: number;
            codedWidth?: number;
            codedHeight?: number;
            videoWidth?: number;
            videoHeight?: number;
            naturalWidth?: number;
            naturalHeight?: number;
            width?: number;
            height?: number;
          };
          const srcW =
            fs.displayWidth ||
            fs.codedWidth ||
            fs.videoWidth ||
            fs.naturalWidth ||
            fs.width ||
            w;
          const srcH =
            fs.displayHeight ||
            fs.codedHeight ||
            fs.videoHeight ||
            fs.naturalHeight ||
            fs.height ||
            h;
          const crop = layer.crop;
          const sx = crop ? (crop.x / 100) * srcW : 0;
          const sy = crop ? (crop.y / 100) * srcH : 0;
          const sw = crop ? (crop.width / 100) * srcW : srcW;
          const sh = crop ? (crop.height / 100) * srcH : srcH;
          const scale = Math.max(w / sw, h / sh);
          const drawW = sw * scale;
          const drawH = sh * scale;
          const dx = (w - drawW) / 2;
          const dy = (h - drawH) / 2;
          drawImageMaybeChroma(
            ctx,
            frameSource,
            sx,
            sy,
            sw,
            sh,
            dx,
            dy,
            drawW,
            drawH,
            layer,
            w,
            h,
          );
          break;
        }
        // character は事前焼き webm が frameSource として来る前提。
        // 無い場合（焼き失敗等）は画像ロード経路に乗せず透過のままにする。
        if (layer.type === "character") break;
        const src = await resolveSrc(layer);
        if (src) {
          const img = await loadImage(src);
          // cover フィット: 画像のアスペクト比を保ち、枠を完全に覆う最小倍率で描画（はみ出しはクリップ）
          const imgW = img.width || (img as HTMLImageElement).naturalWidth || w;
          const imgH = img.height || (img as HTMLImageElement).naturalHeight || h;
          const crop = layer.crop;
          const sx = crop ? (crop.x / 100) * imgW : 0;
          const sy = crop ? (crop.y / 100) * imgH : 0;
          const sw = crop ? (crop.width / 100) * imgW : imgW;
          const sh = crop ? (crop.height / 100) * imgH : imgH;
          const scale = Math.max(w / sw, h / sh);
          const drawW = sw * scale;
          const drawH = sh * scale;
          const dx = (w - drawW) / 2;
          const dy = (h - drawH) / 2;
          drawImageMaybeChroma(
            ctx,
            img,
            sx,
            sy,
            sw,
            sh,
            dx,
            dy,
            drawW,
            drawH,
            layer,
            w,
            h,
          );
        }
        // 未指定レイヤーは何も描画しない（透過）
        break;
      }
      case "color":
      case "shape":
        if (layer.shape === "arc") {
          drawArcShape(ctx, layer, w, h, animAtTimeSec);
        } else if (isMarkerShape(layer.shape)) {
          drawMarkerShape(ctx, layer, w, h, animAtTimeSec);
        } else {
          // preview と合わせるため shape 既定は #FFE600、color 既定は #333
          const def = layer.type === "shape" ? "#FFE600" : "#333";
          ctx.fillStyle = layer.fillGradient
            ? buildLinearGradient(ctx, layer.fillGradient, w, h)
            : layer.fillColor ?? def;
          ctx.fillRect(0, 0, w, h);
        }
        break;
      case "comment":
        // 手書き（筆順）ライトオン。これがあれば通常テキスト描画の代わりに筆順アニメで描く。
        if (hasHandwrite(layer)) {
          drawHandwriteShape(ctx, layer, w, h, animAtTimeSec);
          break;
        }
        if (layer.bubble) {
          // 吹き出し: 独自パスで塗り + 枠を描く（preview の BubbleSvg と一致）
          drawBubbleShape(ctx, layer, w, h);
        } else if (layer.fillColor) {
          ctx.fillStyle = parseRgba(layer.fillColor);
          ctx.fillRect(0, 0, w, h);
        }
        {
          // ① counter / ③ flip-swap: 表示文字列を毎フレーム差し替える（preview の
          // renderAnimatedText と同じ resolveDynamicText で算出して一致させる）。
          // animAtTimeSec あり=再生（時刻で補間/切替）、無し=静的合成（最終値を表示）。
          const dyn = resolveDynamicText(
            layer,
            (animAtTimeSec ?? layer.startSec) - layer.startSec,
            animAtTimeSec !== undefined,
          );
          const txtLayer = dyn != null ? { ...layer, text: dyn } : layer;
          // WebCodecs 経路（animAtTimeSec あり）でテキスト演出（char/kinetic/装飾）を
          // 持つレイヤーは、時刻対応版でフレームごとに描画する（preview の
          // renderAnimatedText / HighlightBar / UnderlineSweep 等と一致させる）。
          // 演出なし、または PNG 焼き経路（animAtTimeSec 未指定）は静的版 drawText。
          if (animAtTimeSec !== undefined && commentHasAnimatedText(txtLayer)) {
            drawAnimatedTextFrame(ctx, txtLayer, w, h, animAtTimeSec);
          } else {
            drawText(ctx, txtLayer, w, h);
          }
        }
        break;
      case "effect":
        // §B 描画系 effect（speedlines/spotlight）。canvas は FINAL 解像度なので pxScale=FINAL_W/360。
        if (layer.effect === "speedlines") {
          drawSpeedlines(
            ctx,
            layer.effectParams ?? {},
            w,
            h,
            FINAL_W / 360,
            animAtTimeSec ?? 0,
          );
        } else if (layer.effect === "spotlight") {
          drawSpotlight(ctx, layer.effectParams ?? {}, w, h, animAtTimeSec ?? 0);
        } else if (layer.effect === "particles") {
          // particles はレイヤー生存相対秒で駆動（絶対秒だと startSec>0 の層で
          // 粒子が既に落下しきっていて見えない）。
          const relT =
            animAtTimeSec === undefined ? 0 : animAtTimeSec - layer.startSec;
          drawParticles(ctx, layer.effectParams ?? {}, w, h, FINAL_W / 360, relT);
        } else if (layer.effect === "steam") {
          // ② steam（湯気）。particles 同様レイヤー生存相対秒で駆動（決定論・preview=export）。
          const relT =
            animAtTimeSec === undefined ? 0 : animAtTimeSec - layer.startSec;
          drawSteam(ctx, layer.effectParams ?? {}, w, h, FINAL_W / 360, relT);
        }
        break;
    }
  } catch (e) {
    console.warn("[layerComposer] layer draw failed:", layer.id, e);
  }
}

/** マスク図形のパスを箱 [0,0,w,h] の絶対座標で beginPath する（star/heart/diamond/hexagon）。 */
function maskShapePath(
  ctx: CanvasRenderingContext2D,
  shape: "star" | "heart" | "diamond" | "hexagon",
  w: number,
  h: number,
): void {
  const cx = w / 2;
  const cy = h / 2;
  const R = (Math.min(w, h) / 2) * 0.98;
  ctx.beginPath();
  if (shape === "diamond") {
    ctx.moveTo(cx, cy - R);
    ctx.lineTo(cx + R, cy);
    ctx.lineTo(cx, cy + R);
    ctx.lineTo(cx - R, cy);
    ctx.closePath();
  } else if (shape === "hexagon") {
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 3;
      const px = cx + Math.cos(a) * R;
      const py = cy + Math.sin(a) * R;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  } else if (shape === "star") {
    const r = R * 0.45;
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
      const a2 = a + Math.PI / 5;
      if (i === 0) ctx.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      else ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx.lineTo(cx + Math.cos(a2) * r, cy + Math.sin(a2) * r);
    }
    ctx.closePath();
  } else {
    // heart（箱中心。design 16 単位の心臓形をスケール）
    const s = Math.min(w, h) * 0.95;
    const k = s / 16;
    const X = (vx: number) => cx + vx * k;
    const Y = (vy: number) => cy + (vy + 3) * k; // 縦中央寄せ
    ctx.moveTo(X(0), Y(5));
    ctx.bezierCurveTo(X(-1), Y(1), X(-8), Y(-1), X(-8), Y(-6));
    ctx.bezierCurveTo(X(-8), Y(-11), X(-2), Y(-11), X(0), Y(-6));
    ctx.bezierCurveTo(X(2), Y(-11), X(8), Y(-11), X(8), Y(-6));
    ctx.bezierCurveTo(X(8), Y(-1), X(1), Y(1), X(0), Y(5));
    ctx.closePath();
  }
}

function applyShapeClip(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  w: number,
  h: number,
): void {
  if (layer.shape === "circle") {
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.clip();
  } else if (layer.shape === "rounded") {
    const r = (layer.borderRadius ?? 12) * (FINAL_W / 360); // キャンバスプレビュー縮尺 → 実寸
    roundRectPath(ctx, 0, 0, w, h, Math.min(r, w / 2, h / 2));
    ctx.clip();
  } else if (
    layer.shape === "star" ||
    layer.shape === "heart" ||
    layer.shape === "diamond" ||
    layer.shape === "hexagon"
  ) {
    // マスク図形（中身をその形にくり抜く）
    maskShapePath(ctx, layer.shape, w, h);
    ctx.clip();
  } else if (layer.shape === "arc") {
    // arc は形状自身が描画範囲を決めるためクリップ不要。何もしない。
    // （drawArcShape が直接 fill するので、矩形クリップを噛ますと逆に問題になる）
  } else {
    // "rect" or undefined: 矩形でクリップ（画像の cover フィットではみ出す分を切る）
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
  }
}

/**
 * CSS の `perspective(P px) rotateY(flipDeg)` を Canvas 2D で **厳密に** 再現する。
 *
 * rotateY は「ソース画像の各縦列 (lx 一定) を、画面上で固定 X 位置・一定縦スケールの
 * 縦線に写す」変換なので、列スライスを perspective 係数で並べれば近似でなく数学的に正確。
 * CSS 行列から導出: 点 (lx, ly) → w' = 1 + lx·sinθ/P, screenX = lx·cosθ/w', screenY = ly/w'。
 *
 * src は w×h（レイヤー実寸 px）に平面描画済みのオフスクリーン。
 * ctx はレイヤー左上を原点にした状態で呼ぶこと（描画は [0,w]×[0,h] 周辺に出る）。
 */
function drawFlipWarp(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  w: number,
  h: number,
  flipDeg: number,
  perspectivePx: number,
): void {
  const theta = (flipDeg * Math.PI) / 180;
  const sin = Math.sin(theta);
  const cos = Math.cos(theta);
  const cx = w / 2;
  const cy = h / 2;
  const sw = (src as unknown as { width: number }).width;
  const sh = (src as unknown as { height: number }).height;
  if (!sw || !sh) return;
  // ソース px s → element 空間 lx（中心原点, [-w/2, w/2]）
  const screenX = (lx: number): number => {
    const f = 1 / (1 + (lx * sin) / perspectivePx);
    return cx + lx * cos * f;
  };
  for (let s = 0; s < sw; s++) {
    const lxL = (s / sw - 0.5) * w;
    const lxR = ((s + 1) / sw - 0.5) * w;
    const sxL = screenX(lxL);
    const sxR = screenX(lxR);
    let destX = sxL;
    let destW = sxR - sxL;
    if (destW < 0) {
      destX = sxR;
      destW = -destW;
    }
    if (destW <= 0) continue;
    const lxC = (lxL + lxR) / 2;
    const fC = 1 / (1 + (lxC * sin) / perspectivePx);
    const destH = h * fC;
    const destY = cy - destH / 2;
    // 隣接スライスと僅かに重ねてサブピクセル境界のシームを防ぐ
    ctx.drawImage(src, s, 0, 1, sh, destX, destY, destW + 0.6, destH);
  }
}

/**
 * 扇形 / ドーナツセグメントを描画する。
 * - 角度: 度。0° = 真上（12時方向）、時計回りで増加（90° = 3時方向）→ Canvas の弧角度に変換するため -π/2 を加える
 * - 半径: box の min(w,h)/2 を 1.0 とする比率
 * - arcInnerRadius = 0 ならベタ塗りの扇形（パイ）。> 0 ならドーナツセグメント。
 * curio-gen が円グラフ／ドーナツチャートを native レイヤーで描くために使う。
 */
function drawArcShape(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  w: number,
  h: number,
  animAtTimeSec?: number,
): void {
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.min(w, h) / 2;
  const outerR = (layer.arcOuterRadius ?? 1.0) * maxR;
  const innerR = (layer.arcInnerRadius ?? 0.0) * maxR;
  const startDeg = layer.arcStart ?? 0;
  const rawEndDeg = layer.arcEnd ?? 360;
  // arc-sweep:「1 本のペン先が 0° → 360° を一定速度(linear)で進む」方式。
  // 全 arc-sweep レイヤーが同じ startSec / entryDuration を共有し（curio-gen 側責任）、
  // 各セグメントはペン先が自分の arcStart〜arcEnd を通過するときだけ徐々に塗られる。
  // preview ArcShapeSvg と式を完全一致させること（レイヤー毎 ease-out にしない）。
  let endDeg = rawEndDeg;
  if (layer.entryAnimation === "arc-sweep" && animAtTimeSec !== undefined) {
    const entryDur = Math.max(0.01, layer.entryDuration ?? 0.3);
    const entryEnd = layer.startSec + entryDur;
    if (animAtTimeSec < entryEnd) {
      const raw = (animAtTimeSec - layer.startSec) / entryDur;
      const p = Math.max(0, Math.min(1, raw));
      // ペン先の角度（0° → 360° linear）。自セグ範囲でクランプして effectiveEnd を決める
      const penAngle = p * 360;
      endDeg = Math.max(startDeg, Math.min(rawEndDeg, penAngle));
    }
  }
  const startRad = (startDeg * Math.PI) / 180 - Math.PI / 2;
  const endRad = (endDeg * Math.PI) / 180 - Math.PI / 2;
  ctx.beginPath();
  if (innerR > 0) {
    // ドーナツセグメント: 外周を時計回り → 内周を反時計回りで穴を空ける
    ctx.arc(cx, cy, outerR, startRad, endRad, false);
    ctx.arc(cx, cy, innerR, endRad, startRad, true);
    ctx.closePath();
  } else {
    // ベタ塗り扇形: 中心 → 弧 → 中心
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, outerR, startRad, endRad, false);
    ctx.closePath();
  }
  // preview の ArcShapeSvg と合わせて shape 既定は #FFE600、color 既定は #333
  const def = layer.type === "shape" ? "#FFE600" : "#333";
  ctx.fillStyle = layer.fillColor ?? def;
  ctx.fill();
}

/**
 * 手書き風マーカー注釈（shape: "marker-*"）を描画。
 * 幾何は markerShape.computeMarker（preview MarkerShapeSvg と共通）。
 * entryAnimation === "draw-on" のとき entryDuration かけて描き進む。
 */
function drawMarkerShape(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  w: number,
  h: number,
  animAtTimeSec?: number,
): void {
  let p = 1;
  if (layer.entryAnimation === "draw-on" && animAtTimeSec !== undefined) {
    const entryDur = Math.max(0.01, layer.entryDuration ?? 0.5);
    const raw = (animAtTimeSec - layer.startSec) / entryDur;
    p = Math.max(0, Math.min(1, raw));
  }
  const pxScale = FINAL_W / 360;
  const { strokes, arrowHead, flash } = computeMarker(layer, w, h, p, pxScale);
  const color = markerColor(layer);
  const lineW = (layer.markerWidth ?? 6) * pxScale;

  ctx.save();
  ctx.globalAlpha *= 0.85; // マーカーペン風の半透明
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineW;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const stroke of strokes) {
    if (stroke.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(stroke[0].x, stroke[0].y);
    for (let i = 1; i < stroke.length; i++) ctx.lineTo(stroke[i].x, stroke[i].y);
    ctx.stroke();
  }
  if (arrowHead && arrowHead.length === 3) {
    ctx.beginPath();
    ctx.moveTo(arrowHead[0].x, arrowHead[0].y);
    ctx.lineTo(arrowHead[1].x, arrowHead[1].y);
    ctx.lineTo(arrowHead[2].x, arrowHead[2].y);
    ctx.closePath();
    ctx.fill();
  }
  // marker-surge の着弾フラッシュ（白芯→色縁の放射グラデ）。preview MarkerShapeSvg と一致。
  if (flash && flash.alpha > 0.001) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, flash.alpha);
    const g = ctx.createRadialGradient(
      flash.x,
      flash.y,
      0,
      flash.x,
      flash.y,
      flash.r,
    );
    g.addColorStop(0, "rgba(255,255,255,0.95)");
    g.addColorStop(0.4, color);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(flash.x, flash.y, flash.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

/**
 * 手書き（筆順）ライトオンを描画。幾何は handwriteStroke.computeHandwrite（preview/export 共通）。
 * surface 背景 → 罫線 → ストローク（インク）→ sweep 文字 → ペン先 の順で描く。
 */
function drawHandwriteShape(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  w: number,
  h: number,
  animAtTimeSec?: number,
): void {
  const pxScale = FINAL_W / 360;
  const family = layer.fontFamily
    ? `${layer.fontFamily}, ${TEXT_DEFAULT_FONT_STACK}`
    : TEXT_DEFAULT_FONT_STACK;
  const measure = (text: string, fontPx: number): number => {
    ctx.save();
    ctx.font = `bold ${fontPx}px ${family}`;
    const m = ctx.measureText(text).width;
    ctx.restore();
    return m;
  };
  const tRel = (animAtTimeSec ?? layer.startSec) - layer.startSec;
  // 停止/スクラブ中（staticHandwriteFlag）or 静的合成（animAtTimeSec 無し）は全文表示。
  const forceFull = staticHandwriteFlag || animAtTimeSec === undefined;
  const render = computeHandwrite(layer, w, h, tRel, forceFull, pxScale, measure);
  const { preset, ink, tip } = resolveSurface(layer);

  ctx.save();

  // --- surface 背景 ---
  if (preset.bg) {
    ctx.fillStyle = preset.bg;
    ctx.fillRect(0, 0, w, h);
    if (preset.border) {
      ctx.strokeStyle = preset.border;
      ctx.lineWidth = 2 * pxScale;
      ctx.strokeRect(0, 0, w, h);
    }
  }
  // --- notebook 罫線（各行ベースライン + 赤マージン）---
  if (preset.rule) {
    ctx.save();
    ctx.strokeStyle = "rgba(120,170,210,0.55)";
    ctx.lineWidth = 1 * pxScale;
    for (const by of render.lineBaselines) {
      ctx.beginPath();
      ctx.moveTo(0, by + 2 * pxScale);
      ctx.lineTo(w, by + 2 * pxScale);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(220,90,90,0.5)";
    ctx.beginPath();
    ctx.moveTo(w * 0.08, 0);
    ctx.lineTo(w * 0.08, h);
    ctx.stroke();
    ctx.restore();
  }

  // --- インクストローク ---
  const lineW =
    (layer.handwrite?.strokeWidth ?? (layer.fontSize ?? 48) * 0.07) * pxScale;
  const chalk = tip === "chalk";
  ctx.strokeStyle = ink;
  ctx.lineWidth = Math.max(1, lineW);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalAlpha = layer.surface === "blackboard" ? 0.92 : 1;
  for (const stroke of render.strokes) {
    if (stroke.length < 2) {
      // 1 点だけの画は小さな点で（始筆）
      if (stroke.length === 1) {
        ctx.beginPath();
        ctx.arc(stroke[0].x, stroke[0].y, lineW * 0.5, 0, Math.PI * 2);
        ctx.fillStyle = ink;
        ctx.fill();
      }
      continue;
    }
    if (chalk) {
      // チョーク質感（ザラつき＋かすれ）。位置シードで毎フレーム安定。
      drawChalkStroke(ctx, stroke, lineW, ink);
    } else {
      ctx.beginPath();
      ctx.moveTo(stroke[0].x, stroke[0].y);
      for (let i = 1; i < stroke.length; i++) ctx.lineTo(stroke[i].x, stroke[i].y);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  // --- sweep フォールバック文字（左→右クリップ出現）---
  if (render.sweeps.length > 0) {
    ctx.fillStyle = ink;
    ctx.font = `bold ${Math.max(4, (layer.fontSize ?? 48) * pxScale)}px ${family}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const s of render.sweeps) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(s.x, s.y, Math.max(0, s.w * s.clip), s.h);
      ctx.clip();
      ctx.fillText(s.ch, s.x + s.w / 2, s.y + s.h / 2);
      ctx.restore();
    }
  }

  // --- ペン先 ＋ チョーク粉落ち ---
  if (render.penTip) {
    drawPenTip(ctx, render.penTip, tip, ink, (layer.fontSize ?? 48) * pxScale);
    if (chalk) {
      drawChalkDust(
        ctx,
        render.penTip,
        animAtTimeSec ?? 0,
        ink,
        (layer.fontSize ?? 48) * pxScale,
      );
    }
  }

  ctx.restore();
}

const _frac = (x: number): number => x - Math.floor(x);

/**
 * チョーク質感のストローク: 細い基本線＋パスに沿った粒子(grain)で「ザラつき・かすれ」を表現。
 * grain は位置シード（量子化座標）で決めるので、ストロークが伸びても既出部はチラつかない。
 */
function drawChalkStroke(
  ctx: CanvasRenderingContext2D,
  pts: { x: number; y: number }[],
  lineW: number,
  color: string,
): void {
  const baseAlpha = ctx.globalAlpha;
  // 基本のボディ（芯はやや残しつつ細め）
  ctx.save();
  ctx.globalAlpha = baseAlpha * 0.62;
  ctx.lineWidth = lineW * 0.82;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
  ctx.restore();
  // grain 粒子
  ctx.save();
  ctx.fillStyle = color;
  const step = Math.max(2, lineW * 0.45);
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1].x;
    const ay = pts[i - 1].y;
    const bx = pts[i].x;
    const by = pts[i].y;
    const segLen = Math.hypot(bx - ax, by - ay) || 1;
    const tx = (bx - ax) / segLen;
    const ty = (by - ay) / segLen;
    const nx = -ty;
    const ny = tx;
    const nSteps = Math.max(1, Math.floor(segLen / step));
    for (let k = 0; k < nSteps; k++) {
      const f = (k + 0.5) / nSteps;
      const cx = ax + (bx - ax) * f;
      const cy = ay + (by - ay) * f;
      const rng = mulberry32(hashSeed(`${Math.round(cx)}_${Math.round(cy)}`));
      for (let g = 0; g < 2; g++) {
        if (rng() < 0.12) continue; // かすれ（粒の抜け）
        const off = (rng() - 0.5) * lineW * 0.85; // 法線方向の散らばり
        const along = (rng() - 0.5) * step; // 接線方向の散らばり
        const r = lineW * (0.08 + rng() * 0.2);
        ctx.globalAlpha = baseAlpha * (0.25 + rng() * 0.55);
        ctx.beginPath();
        ctx.arc(cx + nx * off + tx * along, cy + ny * off + ty * along, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

/** チョーク粉落ち: ペン先から細かい粉が落ちて薄れて消える（時刻駆動・決定論）。 */
function drawChalkDust(
  ctx: CanvasRenderingContext2D,
  tip: { x: number; y: number },
  t: number,
  color: string,
  fontPx: number,
): void {
  const K = 9;
  const fall = fontPx * 0.45;
  ctx.save();
  ctx.fillStyle = color;
  for (let i = 0; i < K; i++) {
    const rng = mulberry32(hashSeed(`dust${i}`));
    const r1 = rng();
    const r2 = rng();
    const r3 = rng();
    const phase = _frac(t * (1.3 + r1 * 0.8) + r1);
    const x = tip.x + (r2 - 0.5) * fontPx * 0.16;
    const y = tip.y + fontPx * 0.1 + phase * fall;
    const r = Math.max(0.5, fontPx * 0.012 * (0.6 + r3));
    ctx.globalAlpha = (1 - phase) * 0.45;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** hex を明(+)/暗(-) に。書く道具の断面シェードに使う。 */
function shadeHex(hex: string, amt: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  if (amt >= 0) {
    r += (255 - r) * amt;
    g += (255 - g) * amt;
    b += (255 - b) * amt;
  } else {
    r *= 1 + amt;
    g *= 1 + amt;
    b *= 1 + amt;
  }
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

/**
 * 書いている道具（チョーク棒/ペン/マーカー/鉛筆）そのものを penTip に描く。
 * 一定の持ち角（右上がり）で本体を傾け、書く先端を penTip に合わせる。
 */
function drawPenTip(
  ctx: CanvasRenderingContext2D,
  tipPt: { x: number; y: number; angle: number },
  tip: "chalk" | "pen" | "marker" | "pencil",
  ink: string,
  fontPx: number,
): void {
  const ang = -0.6; // 右上がりに持つ（書き方向には追従させない＝手の角度は一定）
  const L = fontPx * 1.05; // 道具の長さ
  const W = fontPx * 0.17; // 太さ
  ctx.save();
  ctx.translate(tipPt.x, tipPt.y);
  ctx.rotate(ang);
  // 影（本体の少し下に薄く）
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.strokeStyle = "#000";
  ctx.lineCap = "round";
  ctx.lineWidth = W * 1.05;
  ctx.beginPath();
  ctx.moveTo(W * 0.6, W * 0.6);
  ctx.lineTo(L, W * 0.6);
  ctx.stroke();
  ctx.restore();

  const bodyGrad = (base: string): CanvasGradient => {
    const g = ctx.createLinearGradient(0, -W / 2, 0, W / 2);
    g.addColorStop(0, shadeHex(base, 0.3));
    g.addColorStop(0.5, base);
    g.addColorStop(1, shadeHex(base, -0.32));
    return g;
  };

  if (tip === "chalk") {
    ctx.strokeStyle = bodyGrad(ink);
    ctx.lineCap = "round";
    ctx.lineWidth = W;
    ctx.beginPath();
    ctx.moveTo(W * 0.45, 0);
    ctx.lineTo(L, 0);
    ctx.stroke();
    // 書く先端（粉っぽい発光）
    ctx.shadowColor = ink;
    ctx.shadowBlur = W * 0.6;
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.arc(0, 0, W * 0.34, 0, Math.PI * 2);
    ctx.fill();
  } else if (tip === "marker") {
    // 本体（ink 色のキャップ）
    ctx.strokeStyle = bodyGrad(ink);
    ctx.lineCap = "round";
    ctx.lineWidth = W * 1.2;
    ctx.beginPath();
    ctx.moveTo(W * 0.7, 0);
    ctx.lineTo(L, 0);
    ctx.stroke();
    // 首（灰）
    ctx.strokeStyle = "#d0d0d0";
    ctx.lineCap = "butt";
    ctx.lineWidth = W * 0.85;
    ctx.beginPath();
    ctx.moveTo(W * 0.4, 0);
    ctx.lineTo(W * 0.72, 0);
    ctx.stroke();
    // チゼル先端
    ctx.fillStyle = shadeHex(ink, -0.4);
    ctx.beginPath();
    ctx.moveTo(0, -W * 0.26);
    ctx.lineTo(W * 0.42, -W * 0.42);
    ctx.lineTo(W * 0.42, W * 0.42);
    ctx.lineTo(0, W * 0.26);
    ctx.closePath();
    ctx.fill();
  } else if (tip === "pencil") {
    // 木胴（黄）
    ctx.strokeStyle = bodyGrad("#EBB63E");
    ctx.lineCap = "round";
    ctx.lineWidth = W;
    ctx.beginPath();
    ctx.moveTo(W * 0.95, 0);
    ctx.lineTo(L, 0);
    ctx.stroke();
    // 削りのテーパー（木肌）
    ctx.fillStyle = "#D79B33";
    ctx.beginPath();
    ctx.moveTo(W * 0.28, -W * 0.5);
    ctx.lineTo(W * 0.95, -W * 0.5);
    ctx.lineTo(W * 0.95, W * 0.5);
    ctx.lineTo(W * 0.28, W * 0.5);
    ctx.closePath();
    ctx.fill();
    // 黒鉛の先端
    ctx.fillStyle = "#3a3a3a";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(W * 0.3, -W * 0.34);
    ctx.lineTo(W * 0.3, W * 0.34);
    ctx.closePath();
    ctx.fill();
  } else {
    // pen: 濃い胴＋金属コーン＋ペン先(ink)
    ctx.strokeStyle = bodyGrad("#2d2d34");
    ctx.lineCap = "round";
    ctx.lineWidth = W * 0.95;
    ctx.beginPath();
    ctx.moveTo(W * 0.6, 0);
    ctx.lineTo(L, 0);
    ctx.stroke();
    ctx.fillStyle = "#b9bcc4"; // 金属コーン
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(W * 0.62, -W * 0.4);
    ctx.lineTo(W * 0.62, W * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = ink; // ペン先
    ctx.beginPath();
    ctx.arc(0, 0, W * 0.16, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawBorder(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.save();
  const lw = layer.border!.width * (FINAL_W / 360);
  ctx.strokeStyle = layer.border!.color;
  ctx.lineWidth = lw;
  if (layer.rotation) {
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate((layer.rotation * Math.PI) / 180);
    ctx.translate(-w / 2, -h / 2);
  } else {
    ctx.translate(x, y);
  }
  // preview の CSS `inset boxShadow` と一致させるため枠内側に inset
  const inset = lw / 2;
  if (layer.shape === "circle") {
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, Math.max(0, w / 2 - inset), Math.max(0, h / 2 - inset), 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (layer.shape === "rounded") {
    const r = (layer.borderRadius ?? 12) * (FINAL_W / 360);
    const innerR = Math.max(0, Math.min(r - inset, (w - lw) / 2, (h - lw) / 2));
    roundRectPath(ctx, inset, inset, Math.max(0, w - lw), Math.max(0, h - lw), innerR);
    ctx.stroke();
  } else {
    ctx.strokeRect(inset, inset, Math.max(0, w - lw), Math.max(0, h - lw));
  }
  ctx.restore();
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// 日本語フォントを OS 横断で指定（Windows/macOS/Linux いずれでもフォールバック可能に）。
export const TEXT_DEFAULT_FONT_STACK = `"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Yu Gothic", "游ゴシック", "Meiryo", "メイリオ", "MS Gothic", "MSゴシック", "Noto Sans JP", "Noto Sans CJK JP", sans-serif`;

function buildTextFontString(layer: Layer): string {
  const fontSize = (layer.fontSize ?? 48) * (FINAL_W / 360);
  const family = layer.fontFamily
    ? `${layer.fontFamily}, ${TEXT_DEFAULT_FONT_STACK}`
    : TEXT_DEFAULT_FONT_STACK;
  return `bold ${fontSize}px ${family}`;
}

/**
 * プレビュー (HTML, white-space:pre-wrap + word-break:break-word) と同じく、
 * 1) 手動改行 \n を最優先で尊重しつつ、2) 各行が maxWidth を超える場合は
 * 文字単位で折り返して、最終的な描画行リストを返す。
 */
export function wrapTextLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const out: string[] = [];
  const paragraphs = text.split(/\n/);
  for (const para of paragraphs) {
    if (para === "") {
      out.push("");
      continue;
    }
    let current = "";
    for (const ch of Array.from(para)) {
      const test = current + ch;
      if (
        ctx.measureText(test).width > maxWidth &&
        current.length > 0
      ) {
        out.push(current);
        current = ch;
      } else {
        current = test;
      }
    }
    out.push(current);
  }
  return out;
}

/** 描画用 padding（プレビューの padding:4 を 1080px 基準にスケールしたもの。両端で 2 倍ぶん引く） */
function textInnerPadding(): number {
  return 4 * (FINAL_W / 360);
}

/**
 * 行中心 Y に「字面（グリフ）の中心」を合わせるための baseline Y を返す。
 *
 * Canvas の textBaseline="middle" は **em ボックス中央**基準で、和文フォントは em 内で
 * 字面が中央よりやや上にあるため「箱の中で文字が上寄り」に見える。preview の CSS
 * `align-items:center`（字面中央）に合わせるため、textBaseline="alphabetic" にして
 * baseline を `lineCenterY + (ascent - descent)/2` に置く（字面中心が lineCenterY に来る）。
 *
 * 文字列ごとにブレないよう、フォント固定のサンプル "永Ag0" のメトリクスを使う。
 * actualBoundingBox 非対応環境では fontSize*0.5 で近似（字面はほぼ baseline 上 0..fontSize）。
 * 呼び出し側は textBaseline="alphabetic" を設定し、各行で y = baselineYForLineCenter(ctx, lineCenterY, fontSize) を使う。
 */
function glyphCenterOffset(ctx: CanvasRenderingContext2D, fontSize: number): number {
  try {
    // 和文代表字「永」の字面で中心を測る（Latin の cap/descender で過補正しないため）。
    const m = ctx.measureText("永");
    const a = m.actualBoundingBoxAscent;
    const d = m.actualBoundingBoxDescent;
    if (Number.isFinite(a) && Number.isFinite(d) && (a > 0 || d > 0)) {
      return (a - d) / 2;
    }
  } catch {
    /* fall through */
  }
  // 近似: 和文は字面中心が baseline 上 ≈ 0.38em（descender ぶん下げる）
  return fontSize * 0.38;
}

/** layer の本来の描画幅 w に対して、改行込み・折り返し済みの行リストを返す（測定用 ctx を内部生成） */
function computeLayerTextLines(layer: Layer, w: number): string[] {
  const text = layer.text ?? "";
  if (!text) return [""];
  const c = document.createElement("canvas").getContext("2d");
  if (!c) return text.split(/\n/);
  c.font = buildTextFontString(layer);
  const maxW = Math.max(1, w - textInnerPadding() * 2);
  return wrapTextLines(c, text, maxW);
}

/**
 * テキストのグリフ塗り style を返す。textGradient があれば箱基準の線形グラデ、無ければ fallback。
 * angle: 度（0=横 左→右 / 90=縦 上→下）。
 */
/** 線形グラデを箱 [0,0,w,h] 基準で生成。angle: 度（0=横 左→右 / 90=縦 上→下）。 */
function buildLinearGradient(
  ctx: CanvasRenderingContext2D,
  spec: { from: string; to: string; angle?: number },
  w: number,
  h: number,
): CanvasGradient {
  const ang = ((spec.angle ?? 90) * Math.PI) / 180;
  const cx = w / 2;
  const cy = h / 2;
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  const half = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
  const g = ctx.createLinearGradient(
    cx - dx * half,
    cy - dy * half,
    cx + dx * half,
    cy + dy * half,
  );
  g.addColorStop(0, spec.from);
  g.addColorStop(1, spec.to);
  return g;
}

/** テキストのグリフ塗り style。textGradient があれば線形グラデ、無ければ fallback。 */
function resolveTextFill(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  w: number,
  h: number,
  fallback: string,
): string | CanvasGradient {
  return layer.textGradient
    ? buildLinearGradient(ctx, layer.textGradient, w, h)
    : fallback;
}

function drawText(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  w: number,
  h: number,
): void {
  const scale = FINAL_W / 360;
  const fontSize = (layer.fontSize ?? 48) * scale;
  ctx.font = buildTextFontString(layer);
  ctx.textAlign = "center";
  // 字面中央で揃える（preview の align-items:center と一致）。各行 y は字面中心補正済み。
  ctx.textBaseline = "alphabetic";

  const decoration = layer.textDecoration ?? "none";
  const fontColor = layer.fontColor ?? "#fff";

  // 手動改行 + 自動折り返し（プレビューの white-space:pre-wrap / word-break:break-word に合わせる）
  const maxTextW = Math.max(1, w - textInnerPadding() * 2);
  const lines = wrapTextLines(ctx, layer.text ?? "", maxTextW);
  const lineHeight = fontSize * 1.2;
  const totalHeight = lines.length * lineHeight;
  // startY = 各行の「中心」Y（帯の startY 計算と共有）。実際の baseline は +字面中心補正。
  const startY = h / 2 - totalHeight / 2 + lineHeight / 2;
  const glyphAdj = glyphCenterOffset(ctx, fontSize); // 行中心→baseline の補正量

  // === 装飾 (背景帯系): 文字の手前に描く前のレイヤー ===
  // PNG 焼き込みなので、プレビューの「entryDuration かけて伸びる」アニメは最終状態（フル表示）で焼く。
  if (decoration === "highlight-bar") {
    // テキストブロック (startY 起点 + 全行) の実高さに合わせる（複数行で文字を覆えるように）
    const blockTop = startY - lineHeight / 2;
    const blockH = lines.length * lineHeight;
    const padY = fontSize * 0.1;
    ctx.save();
    ctx.fillStyle = "rgba(255, 220, 0, 0.85)";
    ctx.fillRect(w * 0.05, blockTop - padY, w * 0.9, blockH + padY * 2);
    ctx.restore();
  } else if (decoration === "underline-sweep") {
    // 最終行の文字下端の少し下に引く（固定 h*0.88 だと複数行で 2 行目に重なる）
    const lastLineCenterY = startY + (lines.length - 1) * lineHeight;
    const underlineY = Math.min(lastLineCenterY + fontSize * 0.6, h - 4 * scale);
    ctx.save();
    ctx.fillStyle = fontColor;
    ctx.fillRect(w * 0.05, underlineY, w * 0.9, 3 * scale);
    ctx.restore();
  }

  // === 装飾本体: 文字描画 ===
  if (decoration === "outline-reveal") {
    // プレビュー: WebkitTextStroke (entry 完了時 3px) + WebkitTextFillColor: transparent
    // → 中抜き文字
    ctx.save();
    ctx.strokeStyle = fontColor;
    ctx.lineWidth = 3 * scale * 2; // strokeText は内側半分も塗るので倍
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    for (let i = 0; i < lines.length; i++) {
      ctx.strokeText(lines[i], w / 2, startY + i * lineHeight + glyphAdj);
    }
    ctx.restore();
    return;
  }

  if (decoration === "neon") {
    // プレビュー: text-shadow `0 0 4px ${color}, 0 0 8px ${color}, 0 0 16px ${color}`
    // Canvas には複数 shadow が無いので、ぼかし量を変えて 3 回重ね塗りで再現する。
    const color = fontColor === "#fff" ? "#ffe600" : fontColor;
    for (const blur of [16, 8, 4]) {
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = blur * scale;
      ctx.fillStyle = color;
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], w / 2, startY + i * lineHeight + glyphAdj);
      }
      ctx.restore();
    }
    // 芯のテキスト（影なし）
    ctx.fillStyle = color;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], w / 2, startY + i * lineHeight + glyphAdj);
    }
    return;
  }

  // shadow-drop: ドロップシャドウを先に描く（最終状態 dx=4, dy=4）
  if (decoration === "shadow-drop") {
    const dx = 4 * scale;
    const dy = 4 * scale;
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], w / 2 + dx, startY + i * lineHeight + dy + glyphAdj);
    }
    ctx.restore();
  }

  // ユーザー指定の縁取り（プレビューでは neon / outline-reveal の時はスキップされる）
  const outlineWidth = layer.textOutlineWidth ?? 0;
  const outlineColor = layer.textOutlineColor ?? "#000000";
  const scaledOutline = outlineWidth * scale;
  if (scaledOutline > 0) {
    ctx.strokeStyle = outlineColor;
    // preview は -webkit-text-stroke(幅 outlineWidth*fontScale) + paintOrder:stroke fill で
    // 内側半分が fill に隠れ「見える外側 = 幅/2」になる。Canvas も strokeText→fillText で
    // 内側が隠れるので、lineWidth は preview と同じ outlineWidth*scale にする（*2 は過剰で
    // export だけ 2 倍太くなり文字が潰れていた）。
    ctx.lineWidth = scaledOutline;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    for (let i = 0; i < lines.length; i++) {
      ctx.strokeText(lines[i], w / 2, startY + i * lineHeight + glyphAdj);
    }
  }

  // textGradient があればグラデ塗り（B テキスト演出）。無ければ従来の単色 fontColor。
  ctx.fillStyle = resolveTextFill(ctx, layer, w, h, fontColor);
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], w / 2, startY + i * lineHeight + glyphAdj);
  }
}

// ============================================================================
// === 文字単位 / 単語単位アニメ用: フレームごとに再描画する版 ===
// プレビューの renderAnimatedText / renderCharAnimatedText / renderKineticText
// (TemplateCanvas.tsx) を Canvas 2D に移植したもの。
// ============================================================================

interface CharLine {
  width: number;
  chars: { ch: string; globalIdx: number; xInLine: number }[];
}

interface KineticLine {
  width: number;
  tokens: { tok: string; idx: number; xInLine: number; isWs: boolean }[];
}

/** charAnimation 用: 各文字に globalIdx と行内 X を割り振る（手動改行 + 自動折り返し対応） */
function layoutCharTokens(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): CharLine[] {
  const result: CharLine[] = [];
  let line: CharLine = { width: 0, chars: [] };
  let globalIdx = 0;
  for (const ch of Array.from(text)) {
    if (ch === "\n") {
      result.push(line);
      line = { width: 0, chars: [] };
      globalIdx++;
      continue;
    }
    const chW = ctx.measureText(ch).width;
    if (line.width + chW > maxWidth && line.chars.length > 0) {
      result.push(line);
      line = { width: 0, chars: [] };
    }
    line.chars.push({ ch, globalIdx, xInLine: line.width });
    line.width += chW;
    globalIdx++;
  }
  result.push(line);
  return result;
}

/** kineticAnimation 用: text.split(/(\s+)/) と同じ index を保ったままトークン配置 */
function layoutKineticTokens(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): KineticLine[] {
  const result: KineticLine[] = [];
  let line: KineticLine = { width: 0, tokens: [] };
  // preview と完全一致させるため、空文字列も index に数える
  const tokens = text.split(/(\s+)/);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "") continue;
    const isWs = /^\s+$/.test(tok);
    if (isWs && tok.includes("\n")) {
      // 改行を含む空白トークン: 行を切る（複数 \n は空行を作る）
      result.push(line);
      const nlCount = (tok.match(/\n/g) || []).length;
      for (let nl = 1; nl < nlCount; nl++) {
        result.push({ width: 0, tokens: [] });
      }
      line = { width: 0, tokens: [] };
      continue;
    }
    const tokW = ctx.measureText(tok).width;
    // 単語が幅を超えるなら次行へ（空白では折り返さない）
    if (!isWs && line.width + tokW > maxWidth && line.tokens.length > 0) {
      result.push(line);
      line = { width: 0, tokens: [] };
    }
    line.tokens.push({ tok, idx: i, xInLine: line.width, isWs });
    line.width += tokW;
  }
  result.push(line);
  return result;
}

/**
 * charAnimation の 1 文字の見た目（opacity / dx / dy / scale / color）を時刻から計算する。
 * dx/dy は design(360) 基準（描画側で scalePx / fontScale 倍）。preview/export で共有（export 済み）。
 */
export function computeCharAnimState(
  anim: NonNullable<Layer["charAnimation"]>,
  globalIdx: number,
  localTime: number,
  baseColor: string,
): { opacity: number; dx: number; dy: number; scale: number; color: string } {
  const base = { opacity: 1, dx: 0, dy: 0, scale: 1, color: baseColor };
  switch (anim) {
    case "typewriter": {
      const appearAt = globalIdx * 0.08;
      return { ...base, opacity: localTime >= appearAt ? 1 : 0 };
    }
    case "stagger-fade": {
      const appearAt = globalIdx * 0.05;
      const p = Math.min(1, Math.max(0, (localTime - appearAt) / 0.3));
      return { ...base, opacity: p, dy: (1 - p) * 6 };
    }
    case "wave": {
      return {
        ...base,
        dy: Math.sin(localTime * Math.PI * 2 + globalIdx * 0.35) * 4,
      };
    }
    case "color-shift": {
      return { ...base, color: `hsl(${(globalIdx * 30) % 360}, 100%, 60%)` };
    }
    case "drop-in": {
      const appearAt = globalIdx * 0.05;
      const p = Math.min(1, Math.max(0, (localTime - appearAt) / 0.3));
      return { ...base, opacity: p, dy: -(1 - p) * 14 }; // 上から落ちる
    }
    case "bounce-in": {
      const appearAt = globalIdx * 0.05;
      const p = Math.min(1, Math.max(0, (localTime - appearAt) / 0.45));
      const eb = easeOf("easeOutBounce")(p);
      return { ...base, opacity: Math.min(1, p * 4), dy: (1 - eb) * 16 }; // 下から跳ねる
    }
    case "rainbow": {
      return {
        ...base,
        color: `hsl(${(globalIdx * 30 + localTime * 120) % 360}, 100%, 60%)`,
      };
    }
    case "slide-left": {
      const appearAt = globalIdx * 0.05;
      const p = Math.min(1, Math.max(0, (localTime - appearAt) / 0.3));
      return { ...base, opacity: p, dx: -(1 - easeOf("easeOutCubic")(p)) * 40 };
    }
    case "slide-right": {
      const appearAt = globalIdx * 0.05;
      const p = Math.min(1, Math.max(0, (localTime - appearAt) / 0.3));
      return { ...base, opacity: p, dx: (1 - easeOf("easeOutCubic")(p)) * 40 };
    }
    case "pop-each": {
      const appearAt = globalIdx * 0.05;
      const p = Math.min(1, Math.max(0, (localTime - appearAt) / 0.4));
      return { ...base, opacity: Math.min(1, p * 3), scale: easeOf("easeOutBack")(p) };
    }
    case "shake-each": {
      return {
        ...base,
        dx: Math.sin(localTime * 30 + globalIdx) * 1.5,
        dy: Math.cos(localTime * 33 + globalIdx) * 1.5,
      };
    }
    case "blink-each": {
      return {
        ...base,
        opacity: 0.35 + 0.65 * Math.abs(Math.sin(localTime * 6 + globalIdx * 0.6)),
      };
    }
    default:
      return base;
  }
}

/** kineticAnimation の 1 トークンの見た目（opacity, scale, dy, color）を時刻から計算する */
function computeKineticTokenState(
  anim: NonNullable<Layer["kineticAnimation"]>,
  tokenIdx: number,
  localTime: number,
  baseColor: string,
  keywordColor: string | undefined,
): { opacity: number; scale: number; dy: number; color: string } {
  const appearAt = tokenIdx * 0.2;
  const p = Math.min(1, Math.max(0, (localTime - appearAt) / 0.3));
  switch (anim) {
    case "word-pop": {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      const eb =
        p === 0 ? 0 : 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
      return {
        opacity: p > 0 ? 1 : 0,
        scale: Math.max(0.001, eb),
        dy: 0,
        color: baseColor,
      };
    }
    case "keyword-color": {
      return {
        opacity: p,
        scale: 1,
        dy: (1 - p) * 6,
        color: tokenIdx % 2 === 1 ? keywordColor ?? "#ffe600" : baseColor,
      };
    }
    case "slide-stack": {
      return { opacity: p, scale: 1, dy: (1 - p) * -16, color: baseColor };
    }
    case "zoom-talk": {
      const zoom = p < 0.5 ? 1 + p * 0.6 : 1 + (1 - p) * 0.6;
      return {
        opacity: p > 0 ? 1 : 0,
        scale: zoom,
        dy: 0,
        color: baseColor,
      };
    }
    default:
      return { opacity: 1, scale: 1, dy: 0, color: baseColor };
  }
}

/** 1 トークン（文字または単語）を、時刻状態と装飾を反映して描画 */
function drawAnimatedToken(
  ctx: CanvasRenderingContext2D,
  tok: string,
  x: number, // トークン左端
  y: number, // 行の中心（textBaseline = "middle"）
  opacity: number,
  scale: number,
  dy: number,
  dx: number,
  color: string,
  decoration: string,
  fontColor: string,
  scalePx: number,
  userOutlineWidth: number,
  userOutlineColor: string,
  localTime: number,
  entryDur: number,
): void {
  if (opacity <= 0) return;
  const tokW = ctx.measureText(tok).width;
  ctx.save();
  ctx.globalAlpha *= opacity;

  // scale はトークンの中心を原点に。dy は design(360) 基準なので scalePx で出力解像度へ換算
  // （preview 側 renderChar/KineticText は同値を fontScale 倍して CSS translateY に使う）。
  if (scale !== 1 || dy !== 0 || dx !== 0) {
    ctx.translate(x + dx * scalePx + tokW / 2, y + dy * scalePx);
    if (scale !== 1) ctx.scale(scale, scale);
    ctx.translate(-tokW / 2, 0);
  } else {
    ctx.translate(x, y);
  }

  // shadow-drop（時刻補間: -6,-6 → 4,4）
  if (decoration === "shadow-drop") {
    const p = Math.min(1, Math.max(0, localTime / entryDur));
    const dxS = ((1 - p) * -6 + p * 4) * scalePx;
    const dyS = ((1 - p) * -6 + p * 4) * scalePx;
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillText(tok, dxS, dyS);
    ctx.restore();
  }

  // outline-reveal（時刻でストローク幅 0→3 に成長、塗りなし）
  if (decoration === "outline-reveal") {
    const strokeP = Math.min(1, localTime / entryDur);
    ctx.strokeStyle = fontColor;
    ctx.lineWidth = strokeP * 3 * scalePx * 2;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.strokeText(tok, 0, 0);
    ctx.restore();
    return;
  }

  // neon（多重 shadowBlur）
  if (decoration === "neon") {
    const c = color === fontColor ? (fontColor === "#fff" ? "#ffe600" : color) : color;
    for (const blur of [16, 8, 4]) {
      ctx.save();
      ctx.shadowColor = c;
      ctx.shadowBlur = blur * scalePx;
      ctx.fillStyle = c;
      ctx.fillText(tok, 0, 0);
      ctx.restore();
    }
    ctx.fillStyle = c;
    ctx.fillText(tok, 0, 0);
    ctx.restore();
    return;
  }

  // ユーザー縁取り（neon / outline-reveal の時はプレビュー仕様で無効）
  // lineWidth は preview(-webkit-text-stroke + paintOrder:stroke fill, 見える外側=幅/2) と
  // 揃えるため userOutlineWidth*scalePx（*2 は過剰で export だけ 2 倍太かった）。
  if (userOutlineWidth > 0) {
    ctx.strokeStyle = userOutlineColor;
    ctx.lineWidth = userOutlineWidth * scalePx;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.strokeText(tok, 0, 0);
  }

  ctx.fillStyle = color;
  ctx.fillText(tok, 0, 0);
  ctx.restore();
}

/**
 * テキスト/コメントレイヤーを 1 フレーム分（指定時刻 timeSec）描画する。
 * 静的な fillColor / bubble / border は呼び出し側で既に描いておくこと。
 * このメソッドは「テキストと装飾」だけを描画する。
 */
function drawAnimatedTextFrame(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  w: number,
  h: number,
  timeSec: number,
): void {
  const text = layer.text ?? "";
  if (!text && !layer.textDecoration) return;

  const scalePx = FINAL_W / 360;
  const fontSize = (layer.fontSize ?? 48) * scalePx;
  ctx.font = buildTextFontString(layer);
  // 字面中央で揃える（drawText と同じ）。drawAnimatedToken はローカル 0 に描くので、
  // 呼び出し側で lineY に glyphAdj を足して渡す。
  ctx.textBaseline = "alphabetic";
  const glyphAdj = glyphCenterOffset(ctx, fontSize);

  const localTime = Math.max(0, timeSec - layer.startSec);
  const entryDur = Math.max(0.01, layer.entryDuration ?? 0.3);
  const decoration = layer.textDecoration ?? "none";
  const fontColor = layer.fontColor ?? "#fff";
  const charAnim = layer.charAnimation ?? "none";
  const kineticAnim = layer.kineticAnimation ?? "none";

  const padding = textInnerPadding();
  const maxTextW = Math.max(1, w - padding * 2);
  const lineHeight = fontSize * 1.2;

  // === 装飾の背景帯（時刻補間版） ===
  // 帯/下線をテキストブロックの実行位置に合わせる（複数行で文字に重ならないように）。
  // drawText と同じ wrapTextLines で行数・block 高さを求める（plain 行送り基準）。
  if (decoration === "highlight-bar" || decoration === "underline-sweep") {
    const decoLines = wrapTextLines(ctx, text, maxTextW);
    const decoStartY = h / 2 - (decoLines.length * lineHeight) / 2 + lineHeight / 2;
    const p = Math.min(1, localTime / entryDur);
    if (decoration === "highlight-bar") {
      const blockTop = decoStartY - lineHeight / 2;
      const blockH = decoLines.length * lineHeight;
      const padY = fontSize * 0.1;
      ctx.save();
      ctx.fillStyle = "rgba(255, 220, 0, 0.85)";
      ctx.fillRect(w * 0.05, blockTop - padY, w * 0.9 * p, blockH + padY * 2);
      ctx.restore();
    } else {
      const lastLineCenterY = decoStartY + (decoLines.length - 1) * lineHeight;
      const underlineY = Math.min(
        lastLineCenterY + fontSize * 0.6,
        h - 4 * scalePx,
      );
      ctx.save();
      ctx.fillStyle = fontColor;
      ctx.fillRect(w * 0.05, underlineY, w * 0.9 * p, 3 * scalePx);
      ctx.restore();
    }
  }

  // ユーザー指定縁取り（neon / outline-reveal は本体側で吸収）
  const userOutlineW = layer.textOutlineWidth ?? 0;
  const userOutlineColor = layer.textOutlineColor ?? "#000000";
  const userOutlineEffective =
    decoration === "neon" || decoration === "outline-reveal" ? 0 : userOutlineW;

  // テキスト本体の描画（ctx.textAlign は left を使ってトークンを手で並べる）
  ctx.textAlign = "left";

  if (kineticAnim !== "none") {
    const lines = layoutKineticTokens(ctx, text, maxTextW);
    const totalH = lines.length * lineHeight;
    const startY = h / 2 - totalH / 2 + lineHeight / 2;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const startX = (w - line.width) / 2;
      const lineY = startY + li * lineHeight + glyphAdj;
      for (const t of line.tokens) {
        if (t.isWs) continue;
        const st = computeKineticTokenState(
          kineticAnim,
          t.idx,
          localTime,
          fontColor,
          layer.keywordColor,
        );
        drawAnimatedToken(
          ctx,
          t.tok,
          startX + t.xInLine,
          lineY,
          st.opacity,
          st.scale,
          st.dy,
          0,
          st.color,
          decoration,
          fontColor,
          scalePx,
          userOutlineEffective,
          userOutlineColor,
          localTime,
          entryDur,
        );
      }
    }
    return;
  }

  if (charAnim !== "none") {
    const lines = layoutCharTokens(ctx, text, maxTextW);
    const totalH = lines.length * lineHeight;
    const startY = h / 2 - totalH / 2 + lineHeight / 2;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const startX = (w - line.width) / 2;
      const lineY = startY + li * lineHeight + glyphAdj;
      for (const c of line.chars) {
        const st = computeCharAnimState(charAnim, c.globalIdx, localTime, fontColor);
        drawAnimatedToken(
          ctx,
          c.ch,
          startX + c.xInLine,
          lineY,
          st.opacity,
          st.scale,
          st.dy,
          st.dx,
          st.color,
          decoration,
          fontColor,
          scalePx,
          userOutlineEffective,
          userOutlineColor,
          localTime,
          entryDur,
        );
      }
    }
    return;
  }

  // char/kinetic アニメ無し: 行ごとに 1 トークンとして時刻補間装飾を反映して描く
  const charLines = layoutCharTokens(ctx, text, maxTextW);
  // 文字単位で再構成して line ごとの string を作る
  const linesAsStrings = charLines.map((l) => l.chars.map((c) => c.ch).join(""));
  const totalH = linesAsStrings.length * lineHeight;
  const startY = h / 2 - totalH / 2 + lineHeight / 2;
  // drawAnimatedToken は left 基準で translate するため textAlign も left に揃える
  // （x に `w/2 - lineWidth/2` を渡すことでセンタリングしている）。
  // ここを "center" にすると二重センタリングで左にズレる。
  ctx.textAlign = "left";
  for (let li = 0; li < linesAsStrings.length; li++) {
    const lineText = linesAsStrings[li];
    const lineY = startY + li * lineHeight + glyphAdj;
    drawAnimatedToken(
      ctx,
      lineText,
      // textAlign center だが drawAnimatedToken は left 前提で translate するので元に戻す
      w / 2 - ctx.measureText(lineText).width / 2,
      lineY,
      1,
      1,
      0,
      0,
      fontColor,
      decoration,
      fontColor,
      scalePx,
      userOutlineEffective,
      userOutlineColor,
      localTime,
      entryDur,
    );
  }
}

/**
 * comment + bubble の吹き出し形状（塗り + 枠）を Canvas に描く。
 * preview の BubbleSvg と同じ bubbleFullPath を使い、WebCodecs drawLayer と
 * ffmpeg 焼き経路 drawAnimatedLayerStaticParts の両方で共有する。
 * w/h はレイヤーピクセル寸法。ctx はレイヤー左上に translate 済みであること。
 */
function drawBubbleShape(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  w: number,
  h: number,
): void {
  if (!layer.bubble) return;
  const path2d = new Path2D(
    bubbleFullPath(w, h, layer.bubble, (layer.borderRadius ?? 12) * (FINAL_W / 360)),
  );
  ctx.fillStyle = layer.fillColor
    ? parseRgba(layer.fillColor)
    : "rgba(255,255,255,0.95)";
  ctx.fill(path2d);
  if (layer.border && layer.border.width > 0) {
    ctx.save();
    ctx.strokeStyle = layer.border.color;
    ctx.lineWidth = layer.border.width * (FINAL_W / 360);
    ctx.stroke(path2d);
    ctx.restore();
  }
}

/** 静的レイヤー中身（fillColor / bubble shape / border）を 1 フレーム分描く */
function drawAnimatedLayerStaticParts(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  w: number,
  h: number,
): void {
  ctx.save();
  if (!(layer.type === "comment" && layer.bubble)) {
    applyShapeClip(ctx, layer, w, h);
  }
  if (layer.type === "comment" && layer.bubble) {
    drawBubbleShape(ctx, layer, w, h);
  } else if (layer.fillColor) {
    ctx.fillStyle = parseRgba(layer.fillColor);
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();

  if (!layer.bubble && layer.border && layer.border.width > 0) {
    ctx.save();
    const lw = layer.border.width * (FINAL_W / 360);
    ctx.strokeStyle = layer.border.color;
    ctx.lineWidth = lw;
    // preview の CSS `inset boxShadow` と一致させるため枠内側に inset
    const inset = lw / 2;
    if (layer.shape === "circle") {
      ctx.beginPath();
      ctx.ellipse(w / 2, h / 2, Math.max(0, w / 2 - inset), Math.max(0, h / 2 - inset), 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (layer.shape === "rounded") {
      const r = (layer.borderRadius ?? 12) * (FINAL_W / 360);
      const innerR = Math.max(0, Math.min(r - inset, (w - lw) / 2, (h - lw) / 2));
      roundRectPath(ctx, inset, inset, Math.max(0, w - lw), Math.max(0, h - lw), innerR);
      ctx.stroke();
    } else {
      ctx.strokeRect(inset, inset, Math.max(0, w - lw), Math.max(0, h - lw));
    }
    ctx.restore();
  }
}

/**
 * comment レイヤーが「フレームごとに時刻描画すべきテキスト演出」を持つか。
 * char/kinetic アニメに加え、時刻依存の装飾（highlight-bar 等のスイープ、
 * outline-reveal / shadow-drop の補間）も対象にする。
 * WebCodecs 経路（drawLayer）で drawText（静的）と drawAnimatedTextFrame（時刻）の
 * どちらを使うかの判定に使用。ffmpeg 経路の layerNeedsAnimatedTextVideo より広い。
 */
function commentHasAnimatedText(layer: Layer): boolean {
  if (layer.type !== "comment") return false;
  const ca = layer.charAnimation;
  const ka = layer.kineticAnimation;
  const dec = layer.textDecoration;
  return (
    (typeof ca === "string" && ca !== "none") ||
    (typeof ka === "string" && ka !== "none") ||
    (typeof dec === "string" && dec !== "none")
  );
}

/** comment/text 系で charAnimation または kineticAnimation を持つレイヤーかを判定 */
export function layerNeedsAnimatedTextVideo(layer: Layer): boolean {
  if (layer.type !== "comment") return false;
  const ca = layer.charAnimation;
  const ka = layer.kineticAnimation;
  return (
    (typeof ca === "string" && ca !== "none") ||
    (typeof ka === "string" && ka !== "none")
  );
}

const ANIMATED_VIDEO_FPS = 30;

/**
 * テキスト/コメントレイヤーを「フレームごとに描画 → qtrle 透過 .mov」に焼く。
 * Rust 側の encode_layer_animation_video コマンドを呼んで mov のパスを返す。
 * 戻り値は composeLayerContentPng と同じシェイプ（path + 拡張量）。
 */
export async function composeAnimatedTextLayerVideo(
  layer: Layer,
  sessionId: string,
  filename: string,
): Promise<LayerPngResult> {
  const w = Math.max(2, Math.round((layer.width / 100) * FINAL_W));
  const h = Math.max(2, Math.round((layer.height / 100) * FINAL_H));

  // 吹き出しのしっぽで枠外に出る場合の拡張（PNG 焼きと同じ計算）
  const tail = layer.type === "comment" ? layer.bubble?.tail : undefined;
  let padL = 0;
  let padT = 0;
  let padR = 0;
  let padB = 0;
  if (tail) {
    if (tail.tipX < 0) padL = Math.ceil((-tail.tipX / 100) * w);
    if (tail.tipX > 100) padR = Math.ceil(((tail.tipX - 100) / 100) * w);
    if (tail.tipY < 0) padT = Math.ceil((-tail.tipY / 100) * h);
    if (tail.tipY > 100) padB = Math.ceil(((tail.tipY - 100) / 100) * h);
  }
  // 折り返し後の行数で縦拡張（プレビュー一致）
  if (layer.type === "comment" && layer.text) {
    const lines = computeLayerTextLines(layer, w);
    if (lines.length > 1) {
      const fontSize = (layer.fontSize ?? 48) * (FINAL_W / 360);
      const lineHeight = fontSize * 1.2;
      const totalTextH = lines.length * lineHeight;
      if (totalTextH > h) {
        const extra = Math.ceil((totalTextH - h) / 2);
        padT = Math.max(padT, extra);
        padB = Math.max(padB, extra);
      }
    }
  }

  const canvasW = w + padL + padR;
  const canvasH = h + padT + padB;
  const canvas = document.createElement("canvas");
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context を取得できませんでした");

  const layerDur = Math.max(1 / ANIMATED_VIDEO_FPS, layer.endSec - layer.startSec);
  const frameCount = Math.max(1, Math.round(layerDur * ANIMATED_VIDEO_FPS));

  const frames: string[] = [];
  for (let i = 0; i < frameCount; i++) {
    ctx.clearRect(0, 0, canvasW, canvasH);
    ctx.save();
    if (padL || padT) ctx.translate(padL, padT);
    drawAnimatedLayerStaticParts(ctx, layer, w, h);
    const tSec = layer.startSec + i / ANIMATED_VIDEO_FPS;
    drawAnimatedTextFrame(ctx, layer, w, h, tSec);
    ctx.restore();
    const dataUrl = canvas.toDataURL("image/png");
    frames.push(dataUrl.split(",", 2)[1]);
  }

  const path = await invoke<string>("encode_layer_animation_video", {
    sessionId,
    filename,
    base64Frames: frames,
    fps: ANIMATED_VIDEO_FPS,
  });

  return { path, padL, padT, padR, padB };
}

function parseRgba(v: string): string {
  // Tailwind 形式の rgba 表記に対応
  if (v.startsWith("rgba") || v.startsWith("rgb")) return v;
  if (v.startsWith("#")) return v;
  return "rgba(0,0,0,0.6)";
}

// src ごとにロード済み HTMLImageElement をキャッシュ（毎フレーム再ロードを防ぐ。
// リアルタイム書き出しプレビューの rAF 合成や、export の繰り返し描画を高速化）。
const _imageCache = new Map<string, HTMLImageElement>();
function loadImage(src: string): Promise<HTMLImageElement> {
  const cached = _imageCache.get(src);
  if (cached && cached.complete && cached.naturalWidth > 0) {
    return Promise.resolve(cached);
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      _imageCache.set(src, img);
      resolve(img);
    };
    img.onerror = (e) => reject(e);
    // ファイルパスの場合、Tauri の convertFileSrc を使う
    if (
      !src.startsWith("http://") &&
      !src.startsWith("https://") &&
      !src.startsWith("data:") &&
      !src.startsWith("blob:")
    ) {
      import("@tauri-apps/api/core").then(({ convertFileSrc }) => {
        img.src = convertFileSrc(src);
      }).catch(reject);
    } else {
      img.src = src;
    }
  });
}
