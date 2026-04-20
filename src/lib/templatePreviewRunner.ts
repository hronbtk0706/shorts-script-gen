import { invoke } from "@tauri-apps/api/core";
import type { VideoTemplate, Layer } from "../types";
import { composeLayersToPng } from "./layerComposer";

interface RustVideoLayerInput {
  path: string;
  xPct: number;
  yPct: number;
  widthPct: number;
  heightPct: number;
  zIndex: number;
  shape: string;
  borderRadiusPct: number;
  opacity: number;
  rotation: number;
  borderWidthPct: number;
  borderColor: string;
}

interface RustSceneInput {
  image_path: string;
  audio_path: string;
  overlay_png_path: string;
  duration: number;
  motion: string;
  color: string;
  audio_fade_in: boolean;
  audio_fade_out: boolean;
  transition_to_next: string;
  transition_duration: number;
  captions: never[];
  audio_leading_pad: number;
  video_layers: RustVideoLayerInput[];
}

function makePlaceholderCanvas(label: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 400;
  c.height = 400;
  const g = c.getContext("2d");
  if (!g) return c;
  g.fillStyle = "#2c2c2c";
  g.fillRect(0, 0, 400, 400);
  g.strokeStyle = "#444";
  g.lineWidth = 3;
  for (let i = -400; i < 800; i += 40) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + 400, 400);
    g.stroke();
  }
  g.fillStyle = "rgba(0,0,0,0.5)";
  g.fillRect(80, 160, 240, 80);
  g.fillStyle = "#fff";
  g.font = "bold 26px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(`🖼 ${label}`, 200, 200);
  return c;
}

function canvasToDataUrl(c: HTMLCanvasElement): string {
  return c.toDataURL("image/png");
}

async function createBlankOverlay(sessionId: string): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  ctx?.clearRect(0, 0, 1, 1);
  const base64 = canvas.toDataURL("image/png").split(",", 2)[1];
  return await invoke<string>("save_overlay_png", {
    sessionId,
    filename: "preview_blank_overlay",
    base64Data: base64,
  });
}

export interface PreviewResult {
  videoPath: string;
  sessionId: string;
}

export async function renderTemplatePreview(
  template: VideoTemplate,
  onProgress: (msg: string) => void,
): Promise<PreviewResult> {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const sessionId = `preview_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const maxDuration =
    Math.max(...template.segments.map((s) => s.endSec - s.startSec), 1) + 1;

  onProgress("無音音声を生成中...");
  const silentWav = await invoke<string>("generate_silent_wav", {
    sessionId,
    duration: maxDuration,
  });

  onProgress("ブランクオーバーレイ生成中...");
  const blankOverlay = await createBlankOverlay(sessionId);

  const placeholderImage = canvasToDataUrl(makePlaceholderCanvas("AI画像"));
  const placeholderUser = canvasToDataUrl(makePlaceholderCanvas("画像未設定"));

  const rustScenes: RustSceneInput[] = [];
  for (let i = 0; i < template.segments.length; i++) {
    const seg = template.segments[i];
    onProgress(
      `セグメント ${i + 1}/${template.segments.length} の合成画像を生成中...`,
    );

    // セグメント開始時刻で可視なレイヤーを抽出
    const visibleAtStart = template.layers.filter(
      (l) => l.startSec <= seg.startSec && l.endSec > seg.startSec,
    );

    const basePngPath = await composeLayersToPng(
      template.layers,
      async (layer: Layer) => {
        if (layer.source === "auto") return placeholderImage;
        if (layer.source === "user" || !layer.source) return placeholderUser;
        if (layer.type === "video") {
          return null;
        }
        return layer.source;
      },
      sessionId,
      `scene_${i}_composed`,
      seg.startSec,
    );

    const videoLayers: RustVideoLayerInput[] = visibleAtStart
      .filter(
        (l) =>
          l.type === "video" &&
          l.source &&
          l.source !== "auto" &&
          l.source !== "user",
      )
      .map((l) => ({
        path: l.source as string,
        xPct: l.x,
        yPct: l.y,
        widthPct: l.width,
        heightPct: l.height,
        zIndex: l.zIndex,
        shape: l.shape ?? "rect",
        borderRadiusPct: l.borderRadius ?? 0,
        opacity: l.opacity ?? 1,
        rotation: l.rotation ?? 0,
        borderWidthPct: l.border?.width ?? 0,
        borderColor: l.border?.color ?? "white",
      }));

    rustScenes.push({
      image_path: basePngPath,
      audio_path: silentWav,
      overlay_png_path: blankOverlay,
      duration: seg.endSec - seg.startSec,
      motion: "static",
      color: seg.color ?? "none",
      audio_fade_in: i === 0,
      audio_fade_out: i === template.segments.length - 1,
      transition_to_next: seg.transitionTo ?? "cut",
      transition_duration: seg.transitionDuration ?? 0,
      captions: [],
      audio_leading_pad: 0,
      video_layers: videoLayers,
    });
  }

  onProgress("動画を合成中（FFmpeg）...");
  const outputPath = await invoke<string>("compose_video", {
    sessionId,
    scenes: rustScenes,
    bgmPath: null,
    outputFilename: `preview_${sessionId}.mp4`,
  });

  return { videoPath: outputPath, sessionId };
}
