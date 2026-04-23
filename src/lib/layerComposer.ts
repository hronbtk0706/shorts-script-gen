import { invoke } from "@tauri-apps/api/core";
import type { Layer } from "../types";
import { sortedLayers } from "./layerUtils";
import { sampleLayerAt } from "./keyframes";
import { bubbleFullPath } from "./bubble";

const FINAL_W = 1080;
const FINAL_H = 1920;

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

  if (!opts.transparent) {
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
    await drawLayer(ctx, drawTarget, resolveSrc);
  }

  return canvas.toDataURL("image/png");
}

/** 指定時刻でのキーフレーム補間値を layer に適用した新しい Layer を返す */
function applyKeyframesAtTime(layer: Layer, t: number): Layer {
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
  ctx.globalAlpha = layer.opacity ?? 1;
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
        ctx.fillStyle = layer.fillColor ?? "#333";
        ctx.fillRect(0, 0, w, h);
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

  // border は bubble で既に描画済みなのでスキップ
  if (!layer.bubble && layer.border && layer.border.width > 0) {
    ctx.save();
    ctx.strokeStyle = layer.border.color;
    ctx.lineWidth = layer.border.width * (FINAL_W / 360);
    if (layer.shape === "circle") {
      ctx.beginPath();
      ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (layer.shape === "rounded") {
      const r = (layer.borderRadius ?? 12) * (FINAL_W / 360);
      roundRectPath(ctx, 0, 0, w, h, Math.min(r, w / 2, h / 2));
      ctx.stroke();
    } else {
      ctx.strokeRect(0, 0, w, h);
    }
    ctx.restore();
  }
}

async function drawLayer(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  resolveSrc: LayerSourceResolver,
): Promise<void> {
  const w = (layer.width / 100) * FINAL_W;
  const h = (layer.height / 100) * FINAL_H;
  const x = (layer.x / 100) * FINAL_W;
  const y = (layer.y / 100) * FINAL_H;

  ctx.save();
  ctx.globalAlpha = layer.opacity ?? 1;

  // 回転を含めた transform
  if (layer.rotation) {
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate((layer.rotation * Math.PI) / 180);
    ctx.translate(-w / 2, -h / 2);
  } else {
    ctx.translate(x, y);
  }

  // 形状クリップ
  applyShapeClip(ctx, layer, w, h);

  // 中身描画
  try {
    switch (layer.type) {
      case "image":
      case "video": {
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
          ctx.drawImage(img, sx, sy, sw, sh, dx, dy, drawW, drawH);
        }
        // 未指定レイヤーは何も描画しない（透過）
        break;
      }
      case "color":
      case "shape":
        ctx.fillStyle = layer.fillColor ?? "#333";
        ctx.fillRect(0, 0, w, h);
        break;
      case "comment":
        if (layer.fillColor) {
          ctx.fillStyle = parseRgba(layer.fillColor);
          ctx.fillRect(0, 0, w, h);
        }
        drawText(ctx, layer, w, h);
        break;
    }
  } catch (e) {
    console.warn("[layerComposer] layer draw failed:", layer.id, e);
  }

  ctx.restore();

  // Border（クリップの外に描く必要があるため restore 後）
  if (layer.border && layer.border.width > 0) {
    drawBorder(ctx, layer, x, y, w, h);
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
  } else {
    // "rect" or undefined: 矩形でクリップ（画像の cover フィットではみ出す分を切る）
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
  }
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
  ctx.strokeStyle = layer.border!.color;
  ctx.lineWidth = layer.border!.width * (FINAL_W / 360);
  if (layer.rotation) {
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate((layer.rotation * Math.PI) / 180);
    ctx.translate(-w / 2, -h / 2);
  } else {
    ctx.translate(x, y);
  }
  if (layer.shape === "circle") {
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (layer.shape === "rounded") {
    const r = (layer.borderRadius ?? 12) * (FINAL_W / 360);
    roundRectPath(ctx, 0, 0, w, h, Math.min(r, w / 2, h / 2));
    ctx.stroke();
  } else {
    ctx.strokeRect(0, 0, w, h);
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

function drawText(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  w: number,
  h: number,
): void {
  const fontSize = (layer.fontSize ?? 48) * (FINAL_W / 360);
  // 日本語フォントを OS 横断で指定（Windows/macOS/Linux いずれでもフォールバック可能に）。
  // layer.fontFamily があれば優先し、末尾にデフォルトスタックを付けて fallback を担保する。
  const DEFAULT_STACK = `"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Yu Gothic", "游ゴシック", "Meiryo", "メイリオ", "MS Gothic", "MSゴシック", "Noto Sans JP", "Noto Sans CJK JP", sans-serif`;
  const family = layer.fontFamily
    ? `${layer.fontFamily}, ${DEFAULT_STACK}`
    : DEFAULT_STACK;
  ctx.font = `bold ${fontSize}px ${family}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // 縁取り（stroke）を先に描いてから塗り（fill）を重ねる
  const outlineWidth = layer.textOutlineWidth ?? 0;
  const outlineColor = layer.textOutlineColor ?? "#000000";
  const scaledOutline = outlineWidth * (FINAL_W / 360);

  // 改行を考慮
  const lines = (layer.text ?? "").split(/\n/);
  const lineHeight = fontSize * 1.2;
  const totalHeight = lines.length * lineHeight;
  const startY = h / 2 - totalHeight / 2 + lineHeight / 2;

  if (scaledOutline > 0) {
    // 縁取りはライン重ね描きで太さを出す（strokeText は内側も描画される）
    ctx.strokeStyle = outlineColor;
    ctx.lineWidth = scaledOutline * 2;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    for (let i = 0; i < lines.length; i++) {
      ctx.strokeText(lines[i], w / 2, startY + i * lineHeight);
    }
  }

  ctx.fillStyle = layer.fontColor ?? "#fff";
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], w / 2, startY + i * lineHeight);
  }
}

function parseRgba(v: string): string {
  // Tailwind 形式の rgba 表記に対応
  if (v.startsWith("rgba") || v.startsWith("rgb")) return v;
  if (v.startsWith("#")) return v;
  return "rgba(0,0,0,0.6)";
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
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
