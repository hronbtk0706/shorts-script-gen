import { invoke } from "@tauri-apps/api/core";
import type { VideoTemplate, Layer } from "../types";
import {
  composeLayersToPng,
  composeSingleLayerToTransparentPng,
} from "./layerComposer";

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
  startSec: number;
  endSec: number;
  entryAnimation: string;
  entryDuration: number;
  exitAnimation: string;
  exitDuration: number;
}

interface RustTimedOverlay {
  pngPath: string;
  start: number;
  end: number;
  entryAnimation: string;
  entryDuration: number;
  exitAnimation: string;
  exitDuration: number;
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
  timed_overlays: RustTimedOverlay[];
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

  // セグメント未定義のテンプレは、全尺を1つの body セグメントとして扱う
  const effectiveSegments =
    template.segments.length > 0
      ? template.segments
      : [
          {
            id: "auto_body",
            type: "body" as const,
            startSec: 0,
            endSec: template.totalDuration,
            transitionTo: "cut" as const,
            transitionDuration: 0,
          },
        ];

  const maxDuration =
    Math.max(...effectiveSegments.map((s) => s.endSec - s.startSec), 1) + 1;

  onProgress("無音音声を生成中...");
  const silentWav = await invoke<string>("generate_silent_wav", {
    sessionId,
    duration: maxDuration,
  });

  onProgress("ブランクオーバーレイ生成中...");
  const blankOverlay = await createBlankOverlay(sessionId);

  const placeholderImage = canvasToDataUrl(makePlaceholderCanvas("AI画像"));
  const placeholderUser = canvasToDataUrl(makePlaceholderCanvas("画像未設定"));

  const resolveSrc = async (layer: Layer): Promise<string | null> => {
    if (layer.source === "auto") return placeholderImage;
    if (layer.source === "user" || !layer.source) return placeholderUser;
    if (layer.type === "video") return null;
    return layer.source;
  };

  const rustScenes: RustSceneInput[] = [];
  for (let i = 0; i < effectiveSegments.length; i++) {
    const seg = effectiveSegments[i];
    const sceneDur = Math.max(0.001, seg.endSec - seg.startSec);
    onProgress(
      `セグメント ${i + 1}/${effectiveSegments.length} の合成画像を生成中...`,
    );

    // セグメントと重なるレイヤーを抽出
    const overlapping = template.layers.filter(
      (l) => l.startSec < seg.endSec && l.endSec > seg.startSec,
    );

    // 常時表示 / 時間ゲート に分類
    const epsilon = 0.02;
    const alwaysVisible: Layer[] = [];
    const timeGated: Layer[] = [];
    for (const l of overlapping) {
      if (l.type === "video") continue;
      const coversStart = l.startSec <= seg.startSec + epsilon;
      const coversEnd = l.endSec >= seg.endSec - epsilon;
      if (coversStart && coversEnd) alwaysVisible.push(l);
      else timeGated.push(l);
    }

    // zIndex 正しさのため: タイムゲートの最低 zIndex より高い常時表示レイヤーは
    // 常時表示のままだと下に埋もれるので、時間ゲート側に昇格（セグメント全期間で表示）
    if (timeGated.length > 0 && alwaysVisible.length > 0) {
      const minTimedZ = Math.min(...timeGated.map((l) => l.zIndex));
      const promote = alwaysVisible.filter((l) => l.zIndex > minTimedZ);
      for (const l of promote) {
        const idx = alwaysVisible.indexOf(l);
        if (idx >= 0) alwaysVisible.splice(idx, 1);
        timeGated.push({ ...l, startSec: seg.startSec, endSec: seg.endSec });
      }
    }
    timeGated.sort((a, b) => a.zIndex - b.zIndex);

    // ベース画像＝常時表示レイヤーのみを合成（時間指定なし）
    const basePngPath = await composeLayersToPng(
      alwaysVisible,
      resolveSrc,
      sessionId,
      `scene_${i}_composed`,
    );

    // 時間ゲート付きレイヤー → 個別の透明 PNG
    const timedOverlays: RustTimedOverlay[] = [];
    for (const l of timeGated) {
      const relStart = Math.max(0, l.startSec - seg.startSec);
      const relEnd = Math.min(sceneDur, l.endSec - seg.startSec);
      if (relEnd - relStart < 0.05) continue;
      try {
        const pngPath = await composeSingleLayerToTransparentPng(
          l,
          resolveSrc,
          sessionId,
          `scene_${i}_timed_${l.id}`,
        );
        timedOverlays.push({
          pngPath,
          start: relStart,
          end: relEnd,
          entryAnimation: l.entryAnimation ?? "none",
          entryDuration: l.entryDuration ?? 0.3,
          exitAnimation: l.exitAnimation ?? "none",
          exitDuration: l.exitDuration ?? 0.3,
        });
      } catch (e) {
        console.error(`[preview] timed layer ${l.id} failed:`, e);
      }
    }

    // 動画レイヤー（すべて時間ゲート付きで overlay）
    const videoLayers: RustVideoLayerInput[] = overlapping
      .filter(
        (l) =>
          l.type === "video" &&
          l.source &&
          l.source !== "auto" &&
          l.source !== "user",
      )
      .map((l) => {
        const relStart = Math.max(0, l.startSec - seg.startSec);
        const relEnd = Math.min(sceneDur, l.endSec - seg.startSec);
        return {
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
          startSec: relStart,
          endSec: relEnd,
          entryAnimation: l.entryAnimation ?? "none",
          entryDuration: l.entryDuration ?? 0.3,
          exitAnimation: l.exitAnimation ?? "none",
          exitDuration: l.exitDuration ?? 0.3,
        };
      });

    rustScenes.push({
      image_path: basePngPath,
      audio_path: silentWav,
      overlay_png_path: blankOverlay,
      duration: sceneDur,
      motion: "static",
      color: seg.color ?? "none",
      audio_fade_in: i === 0,
      audio_fade_out: i === effectiveSegments.length - 1,
      transition_to_next: seg.transitionTo ?? "cut",
      transition_duration: seg.transitionDuration ?? 0,
      captions: [],
      audio_leading_pad: 0,
      video_layers: videoLayers,
      timed_overlays: timedOverlays,
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
