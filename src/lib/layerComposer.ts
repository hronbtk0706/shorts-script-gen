import { invoke } from "@tauri-apps/api/core";
import type { Layer } from "../types";
import { sortedLayers } from "./layerUtils";

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
  opts: { skipVideoLayers?: boolean; atTimeSec?: number } = {},
): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = FINAL_W;
  canvas.height = FINAL_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context を取得できませんでした");

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, FINAL_W, FINAL_H);

  const t = opts.atTimeSec;
  for (const layer of sortedLayers(layers)) {
    if (layer.type === "video" && opts.skipVideoLayers) continue;
    // 指定時刻で不可視なら描画しない
    if (t !== undefined && (t < layer.startSec || t >= layer.endSec)) continue;
    await drawLayer(ctx, layer, resolveSrc);
  }

  return canvas.toDataURL("image/png");
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
          ctx.drawImage(img, 0, 0, w, h);
        } else {
          // fallback: グレーで埋めて「未設定」表示
          ctx.fillStyle = "#222";
          ctx.fillRect(0, 0, w, h);
        }
        break;
      }
      case "color":
      case "shape":
        ctx.fillStyle = layer.fillColor ?? "#333";
        ctx.fillRect(0, 0, w, h);
        break;
      case "text":
      case "comment":
        if (layer.type === "comment") {
          ctx.fillStyle = parseRgba(layer.fillColor ?? "rgba(0,0,0,0.6)");
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
  ctx.fillStyle = layer.fontColor ?? "#fff";
  ctx.font = `bold ${fontSize}px "Hiragino Sans", "Yu Gothic", "Noto Sans JP", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // 改行を考慮
  const lines = (layer.text ?? "").split(/\n/);
  const lineHeight = fontSize * 1.2;
  const totalHeight = lines.length * lineHeight;
  const startY = h / 2 - totalHeight / 2 + lineHeight / 2;
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
