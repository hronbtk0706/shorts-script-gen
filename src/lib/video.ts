import { invoke } from "@tauri-apps/api/core";
import type { VideoTemplate, Layer } from "../types";
import { loadSettings } from "./storage";
import { composeLayerContentPng } from "./layerComposer";

export interface ProgressUpdate {
  phase:
    | "prompt"
    | "image"
    | "tts"
    | "overlay"
    | "compose"
    | "done"
    | "error";
  sceneIndex?: number;
  totalScenes: number;
  message: string;
}

type ProgressCallback = (update: ProgressUpdate) => void;

export interface VideoResult {
  outputPath: string;
  sessionId: string;
}

// ============================================================================
// テンプレートのレイヤーだけで 1 本の動画を作る。
// シーン分割 / セグメント / hook-body-cta の概念を一切使わない。
// ============================================================================

interface RustKeyframe {
  time: number;
  value: number;
}
interface RustKeyframeTrack {
  enabled: boolean;
  frames: RustKeyframe[];
}
interface RustLayerKeyframes {
  x?: RustKeyframeTrack;
  y?: RustKeyframeTrack;
  scale?: RustKeyframeTrack;
  opacity?: RustKeyframeTrack;
  rotation?: RustKeyframeTrack;
}

interface RustCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RustTemplateLayerInput {
  kind: "static" | "video";
  path: string;
  xPx: number;
  yPx: number;
  wPx: number;
  hPx: number;
  rotation: number;
  opacity: number;
  zIndex: number;
  startSec: number;
  endSec: number;
  entryAnimation: string;
  entryDuration: number;
  exitAnimation: string;
  exitDuration: number;
  videoLoop: boolean;
  playbackRate: number;
  crop?: RustCrop;
  keyframes: RustLayerKeyframes;
}

interface RustTemplateAudioInput {
  path: string;
  startSec: number;
  endSec: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  audioLoop: boolean;
  playbackRate: number;
}

/**
 * テンプレートのレイヤーから 1 本の MP4 を生成する。
 * - 黒背景の上に全レイヤーを zIndex 昇順で overlay
 * - 総尺 = 最後に終わるレイヤーの endSec
 * - motion / color / xfade は一切使わない（レイヤー単位のアニメのみ）
 */
export type VideoQualityPreset = "low" | "standard" | "high";

const QUALITY_PRESET_MAP: Record<
  VideoQualityPreset,
  { crf: number; preset: string }
> = {
  low: { crf: 28, preset: "faster" },
  standard: { crf: 23, preset: "medium" },
  high: { crf: 18, preset: "slow" },
};

export async function generateVideoFromTemplate(
  template: VideoTemplate,
  onProgress: ProgressCallback,
  options?: { quality?: VideoQualityPreset },
): Promise<VideoResult> {
  const qualityKey = options?.quality ?? "standard";
  const { crf: videoCrf, preset: videoPreset } =
    QUALITY_PRESET_MAP[qualityKey];
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const sessionId = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const settings = await loadSettings();

  // hidden は書き出しから除外
  const visible = template.layers.filter((l) => !l.hidden);

  // ビジュアル系とオーディオ系に分ける
  const visualLayers = visible.filter((l) => l.type !== "audio");
  const audioLayers = visible.filter((l) => l.type === "audio");

  // 総尺 = 最も遅く終わるレイヤーの endSec
  const totalDuration = Math.max(
    1,
    ...visible.map((l) => l.endSec),
  );

  onProgress({
    phase: "overlay",
    totalScenes: visualLayers.length,
    message: `レイヤー ${visualLayers.length} 個を準備中...`,
  });

  const resolveLayerSrc = async (l: Layer): Promise<string | null> => {
    if (l.source === "auto") return null;
    if (l.source && l.source !== "user") return l.source;
    return null;
  };

  // ビジュアルレイヤー → Rust 入力形式に変換
  const rustLayers: RustTemplateLayerInput[] = [];
  let processed = 0;
  for (const layer of visualLayers) {
    processed++;
    onProgress({
      phase: "overlay",
      sceneIndex: processed - 1,
      totalScenes: visualLayers.length,
      message: `レイヤー ${processed}/${visualLayers.length} を処理中 (${layer.type})`,
    });

    const x_px = Math.round((layer.x / 100) * 1080);
    const y_px = Math.round((layer.y / 100) * 1920);
    const w_px = Math.max(2, Math.round((layer.width / 100) * 1080));
    const h_px = Math.max(2, Math.round((layer.height / 100) * 1920));

    const common = {
      xPx: x_px,
      yPx: y_px,
      wPx: w_px,
      hPx: h_px,
      rotation: layer.rotation ?? 0,
      opacity: layer.opacity ?? 1,
      zIndex: layer.zIndex ?? 0,
      startSec: layer.startSec,
      endSec: layer.endSec,
      entryAnimation: layer.entryAnimation ?? "none",
      entryDuration: layer.entryDuration ?? 0.3,
      exitAnimation: layer.exitAnimation ?? "none",
      exitDuration: layer.exitDuration ?? 0.3,
      keyframes: (layer.keyframes ?? {}) as RustLayerKeyframes,
    };

    if (
      layer.type === "video" &&
      layer.source &&
      layer.source !== "auto" &&
      layer.source !== "user"
    ) {
      rustLayers.push({
        ...common,
        kind: "video",
        path: layer.source,
        videoLoop: layer.videoLoop ?? true,
        playbackRate: layer.playbackRate ?? 1,
        crop: layer.crop,
      });
    } else {
      // static なレイヤーは PNG に焼き込む
      // （image / comment / text / color / shape。未指定 image は透過）
      const { path: pngPath, padL, padT, padR, padB } =
        await composeLayerContentPng(
          layer,
          resolveLayerSrc,
          sessionId,
          `layer_${layer.id}`,
        );
      // 吹き出しのしっぽで PNG を枠外に拡張したぶん overlay 位置とサイズを補正
      const hasPad = padL || padT || padR || padB;
      const adjXPx = hasPad ? x_px - padL : x_px;
      const adjYPx = hasPad ? y_px - padT : y_px;
      const adjWPx = hasPad ? w_px + padL + padR : w_px;
      const adjHPx = hasPad ? h_px + padT + padB : h_px;
      // キーフレームの x/y は % 値。PNG 拡張した場合は padL/padT のぶんだけシフトする。
      let adjKeyframes = common.keyframes;
      if (hasPad && (common.keyframes.x || common.keyframes.y)) {
        const dxPct = (padL / 1080) * 100;
        const dyPct = (padT / 1920) * 100;
        adjKeyframes = {
          ...common.keyframes,
          x: common.keyframes.x
            ? {
                ...common.keyframes.x,
                frames: common.keyframes.x.frames.map((f) => ({
                  ...f,
                  value: f.value - dxPct,
                })),
              }
            : undefined,
          y: common.keyframes.y
            ? {
                ...common.keyframes.y,
                frames: common.keyframes.y.frames.map((f) => ({
                  ...f,
                  value: f.value - dyPct,
                })),
              }
            : undefined,
        };
      }
      rustLayers.push({
        ...common,
        xPx: adjXPx,
        yPx: adjYPx,
        wPx: adjWPx,
        hPx: adjHPx,
        keyframes: adjKeyframes,
        kind: "static",
        path: pngPath,
        videoLoop: true,
        playbackRate: 1,
      });
    }
  }

  // 音声レイヤー → Rust 入力形式に変換（ソース未指定はスキップ）
  const rustAudio: RustTemplateAudioInput[] = audioLayers
    .filter(
      (l) =>
        l.source &&
        l.source !== "auto" &&
        l.source !== "user",
    )
    .map((l) => ({
      path: l.source as string,
      startSec: l.startSec,
      endSec: l.endSec,
      volume: l.volume ?? 1,
      fadeIn: l.audioFadeIn ?? 0,
      fadeOut: l.audioFadeOut ?? 0,
      audioLoop: !!l.audioLoop,
      playbackRate: l.playbackRate ?? 1,
    }));

  // BGM は設定ファイルから
  const bgmPath: string | null = settings.bgmFilePath || null;

  onProgress({
    phase: "compose",
    totalScenes: visualLayers.length,
    message: "動画を合成中（ffmpeg）...",
  });

  const outputPath = await invoke<string>("compose_template_video", {
    sessionId,
    totalDuration,
    layers: rustLayers,
    audioLayers: rustAudio,
    bgmPath,
    outputFilename: `video_${sessionId}.mp4`,
    videoCrf,
    videoPreset,
  });

  onProgress({
    phase: "done",
    totalScenes: visualLayers.length,
    message: `完成！ ${outputPath}`,
  });

  return { outputPath, sessionId };
}
