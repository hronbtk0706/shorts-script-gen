import { invoke } from "@tauri-apps/api/core";
import type {
  Script,
  SubtitleStyle,
  SceneEffects,
  VideoTemplate,
  Layer,
  TemplateSegment,
} from "../types";
import { loadSettings } from "./storage";
import {
  canvasToBase64Png,
  renderCaptionCanvas,
  renderSubtitleCanvas,
} from "./subtitleRender";
import { getTtsProvider } from "./providers/tts";
import { getImageProvider } from "./providers/image";
import { fetchPixabayBgm } from "./providers/bgm";
import { resolveEffects } from "./effects";
import { composeLayersToPng } from "./layerComposer";

export interface CaptionAsset {
  pngPath: string;
  start: number;
  end: number;
}

export interface SceneAssets {
  index: number;
  imagePath: string;
  audioPath: string;
  overlayPngPath: string;
  duration: number;
  effects: SceneEffects;
  captions: CaptionAsset[];
  audioLeadingPad: number;
  videoLayers: RustVideoLayerInput[];
}

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

interface RustCaptionInput {
  png_path: string;
  start: number;
  end: number;
}

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
  captions: RustCaptionInput[];
  audio_leading_pad: number;
  video_layers: RustVideoLayerInput[];
}

const AUDIO_LEADING_PAD_SECONDS = 0.6;

function fallbackImagePrompt(visual: string): string {
  return `${visual}, vibrant, cinematic, vertical 9:16, high detail`;
}

async function renderAndSaveOverlay(
  text: string,
  style: SubtitleStyle,
  filename: string,
  sessionId: string,
): Promise<string> {
  const canvas = renderSubtitleCanvas(text, style, "top");
  const base64 = canvasToBase64Png(canvas);
  return invoke<string>("save_overlay_png", {
    sessionId,
    base64Data: base64,
    filename,
  });
}

async function renderAndSaveCaption(
  text: string,
  filename: string,
  sessionId: string,
): Promise<string> {
  const canvas = renderCaptionCanvas(text);
  const base64 = canvasToBase64Png(canvas);
  return invoke<string>("save_overlay_png", {
    sessionId,
    base64Data: base64,
    filename,
  });
}

function splitNarration(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const ch of text) {
    current += ch;
    if (ch === "。" || ch === "！" || ch === "？" || ch === "、") {
      const trimmed = current.trim();
      if (trimmed) chunks.push(trimmed);
      current = "";
    }
  }
  const trimmed = current.trim();
  if (trimmed) chunks.push(trimmed);
  return chunks.filter(
    (c) => c.replace(/[、。！？\s]/g, "").length > 0,
  );
}

function countNonPunct(text: string): number {
  return text.replace(/[、。！？\s]/g, "").length;
}

const PAUSE_SECONDS_BY_PUNCT: Record<string, number> = {
  "、": 0.15,
  "。": 0.3,
  "！": 0.3,
  "？": 0.3,
};

function trailingPunctPause(text: string): number {
  const last = text.trim().slice(-1);
  return PAUSE_SECONDS_BY_PUNCT[last] ?? 0;
}

function allocateCaptionTimings(
  chunks: string[],
  totalDuration: number,
): Array<{ text: string; start: number; end: number }> {
  if (chunks.length === 0 || totalDuration <= 0) return [];
  const info = chunks.map((c) => ({
    text: c,
    chars: countNonPunct(c),
    pause: trailingPunctPause(c),
  }));
  const totalChars = info.reduce((sum, c) => sum + c.chars, 0);
  const totalPause = info.reduce((sum, c) => sum + c.pause, 0);
  if (totalChars === 0) return [];
  const speechDuration = Math.max(0.1, totalDuration - totalPause);
  const tpc = speechDuration / totalChars;

  const result: Array<{ text: string; start: number; end: number }> = [];
  let cursor = 0;
  for (let i = 0; i < info.length; i++) {
    const { text, chars, pause } = info[i];
    const isLast = i === info.length - 1;
    const speechDur = chars * tpc;
    const start = cursor;
    const end = isLast
      ? totalDuration
      : Math.min(cursor + speechDur + pause, totalDuration);
    result.push({ text, start, end });
    cursor = end;
  }
  return result;
}

export interface VideoResult {
  outputPath: string;
  sessionId: string;
}

export async function generateVideo(
  _apiKey: string,
  script: Script,
  onProgress: ProgressCallback,
  template?: VideoTemplate,
): Promise<VideoResult> {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const sessionId = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const assets: SceneAssets[] = [];
  const settings = await loadSettings();
  const ttsProvider = getTtsProvider(settings.ttsProvider);
  const imageProvider = getImageProvider(settings.imageProvider);

  // template のセグメントを type/index で引けるよう Map 化、可視レイヤーを抽出
  const segmentByKey = new Map<string, TemplateSegment>();
  if (template) {
    const bodySegs = template.segments.filter((s) => s.type === "body");
    const hookSeg = template.segments.find((s) => s.type === "hook");
    const ctaSeg = template.segments.find((s) => s.type === "cta");
    if (hookSeg) segmentByKey.set("hook_0", hookSeg);
    bodySegs.forEach((s, i) => segmentByKey.set(`body_${i}`, s));
    if (ctaSeg) segmentByKey.set("cta_0", ctaSeg);
  }

  /** セグメントと重なるレイヤーを抽出（セグメント内の相対時刻情報付き） */
  const layersForSegment = (seg: TemplateSegment | null): Layer[] => {
    if (!seg || !template) return [];
    return template.layers.filter(
      (l) => l.startSec < seg.endSec && l.endSec > seg.startSec,
    );
  };

  const allScenes = [
    {
      index: 0,
      narration: script.hook.text,
      visual: script.hook.visual,
      image_prompt: script.hook.image_prompt || fallbackImagePrompt(script.hook.visual),
      image_path: script.hook.image_path,
      text_overlay: script.hook.text,
      style: script.hook.subtitle_style,
      effects: resolveEffects(script.hook.effects, { isFirst: true }),
      skipCaption: false,
      templateSegment: segmentByKey.get("hook_0") ?? null,
      templateLayers: layersForSegment(segmentByKey.get("hook_0") ?? null),
    },
    ...script.body.map((b, i) => ({
      index: i + 1,
      narration: b.narration,
      visual: b.visual,
      image_prompt: b.image_prompt || fallbackImagePrompt(b.visual),
      image_path: b.image_path,
      text_overlay: b.text_overlay,
      style: b.subtitle_style,
      effects: resolveEffects(b.effects),
      skipCaption: false,
      templateSegment: segmentByKey.get(`body_${i}`) ?? null,
      templateLayers: layersForSegment(segmentByKey.get(`body_${i}`) ?? null),
    })),
    {
      index: script.body.length + 1,
      narration: script.cta.text,
      visual: script.cta.text,
      image_prompt: script.cta.image_prompt || fallbackImagePrompt(script.cta.text),
      image_path: script.cta.image_path,
      text_overlay: script.cta.text,
      style: script.cta.subtitle_style,
      effects: resolveEffects(script.cta.effects, { isLast: true }),
      skipCaption: true,
      templateSegment: segmentByKey.get("cta_0") ?? null,
      templateLayers: layersForSegment(segmentByKey.get("cta_0") ?? null),
    },
  ];

  const totalCount = allScenes.length;

  for (const scene of allScenes) {
    let imagePath: string;
    // レイヤー合成（テンプレのセグメントに対応するレイヤー群が複雑な場合）
    const segLayers = scene.templateLayers;
    const hasComplexLayers =
      segLayers.length > 0 &&
      // 単一の auto 画像フルスクリーンのみなら従来の AI 画像生成で済ませる
      !(
        segLayers.length === 1 &&
        segLayers[0].type === "image" &&
        segLayers[0].source === "auto" &&
        segLayers[0].x === 0 &&
        segLayers[0].y === 0 &&
        segLayers[0].width === 100 &&
        segLayers[0].height === 100
      );

    if (scene.image_path) {
      onProgress({
        phase: "image",
        sceneIndex: scene.index,
        totalScenes: totalCount,
        message: `シーン ${scene.index + 1}/${totalCount}: ユーザー指定画像を使用`,
      });
      imagePath = scene.image_path;
    } else if (hasComplexLayers) {
      onProgress({
        phase: "image",
        sceneIndex: scene.index,
        totalScenes: totalCount,
        message: `シーン ${scene.index + 1}/${totalCount}: レイヤー合成中...`,
      });
      const resolvedSources = new Map<string, string>();
      for (const layer of segLayers) {
        if (
          (layer.type === "image" || layer.type === "video") &&
          layer.source === "auto"
        ) {
          const aiPath = await imageProvider.generate(
            {
              prompt: scene.image_prompt,
              seed:
                (now.getTime() + scene.index + Number(layer.id[0] ?? 0)) %
                1000000,
              filename: `scene_${scene.index}_layer_${layer.id}`,
              sessionId,
            },
            settings,
          );
          resolvedSources.set(layer.id, aiPath);
        }
      }
      imagePath = await composeLayersToPng(
        segLayers,
        async (layer: Layer) => {
          if (layer.source === "auto") {
            return resolvedSources.get(layer.id) ?? null;
          }
          if (layer.source && layer.source !== "user") {
            return layer.source;
          }
          return null;
        },
        sessionId,
        `scene_${scene.index}_composed`,
      );
    } else {
      onProgress({
        phase: "image",
        sceneIndex: scene.index,
        totalScenes: totalCount,
        message: `シーン ${scene.index + 1}/${totalCount}: 画像生成中（${imageProvider.label}）...`,
      });
      imagePath = await imageProvider.generate(
        {
          prompt: scene.image_prompt,
          seed: (now.getTime() + scene.index) % 1000000,
          filename: `scene_${scene.index}`,
          sessionId,
        },
        settings,
      );
    }

    onProgress({
      phase: "overlay",
      sceneIndex: scene.index,
      totalScenes: totalCount,
      message: `シーン ${scene.index + 1}/${totalCount}: テロップ生成中...`,
    });

    const overlayPngPath = await renderAndSaveOverlay(
      scene.text_overlay,
      scene.style,
      `overlay_${scene.index}`,
      sessionId,
    );

    onProgress({
      phase: "tts",
      sceneIndex: scene.index,
      totalScenes: totalCount,
      message: `シーン ${scene.index + 1}/${totalCount}: 音声合成中（${ttsProvider.label}）...`,
    });

    const audioPath = await ttsProvider.synthesize(
      {
        text: scene.narration,
        filename: `scene_${scene.index}`,
        sessionId,
      },
      settings,
    );

    const audioDuration = await invoke<number>("get_audio_duration", {
      audioPath,
    });

    const leadingPad =
      scene.index === 0 ? 0 : AUDIO_LEADING_PAD_SECONDS;
    const sceneDuration = audioDuration + leadingPad;

    const captions: CaptionAsset[] = [];
    if (!scene.skipCaption) {
      const captionChunks = splitNarration(scene.narration);
      const captionTimings = allocateCaptionTimings(
        captionChunks,
        audioDuration,
      );
      for (let ci = 0; ci < captionTimings.length; ci++) {
        const c = captionTimings[ci];
        const displayText = c.text.replace(/、$/, "");
        const pngPath = await renderAndSaveCaption(
          displayText,
          `caption_${scene.index}_${ci}`,
          sessionId,
        );
        captions.push({
          pngPath,
          start: c.start + leadingPad,
          end: c.end + leadingPad,
        });
      }
    }

    // 動画レイヤー（FFmpeg 側で動画として合成される）
    const videoLayers: RustVideoLayerInput[] = [];
    if (scene.templateLayers.length > 0) {
      for (const l of scene.templateLayers) {
        if (
          l.type === "video" &&
          l.source &&
          l.source !== "auto" &&
          l.source !== "user"
        ) {
          videoLayers.push({
            path: l.source,
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
          });
        }
      }
    }

    assets.push({
      index: scene.index,
      imagePath,
      audioPath,
      overlayPngPath,
      duration: sceneDuration,
      effects: scene.effects,
      captions,
      audioLeadingPad: leadingPad,
      videoLayers,
    });
  }

  onProgress({
    phase: "compose",
    totalScenes: totalCount,
    message: "動画を合成中（ffmpeg）...",
  });

  // BGM選択: 設定ファイル優先 → Pixabay自動取得
  let bgmPath: string | null = null;
  if (settings.bgmFilePath) {
    bgmPath = settings.bgmFilePath;
  } else if (settings.pixabayApiKey && script.bgm_mood) {
    bgmPath = await fetchPixabayBgm(settings.pixabayApiKey, script.bgm_mood, sessionId);
  }

  const rustScenes: RustSceneInput[] = assets
    .sort((a, b) => a.index - b.index)
    .map((a) => ({
      image_path: a.imagePath,
      audio_path: a.audioPath,
      overlay_png_path: a.overlayPngPath,
      duration: a.duration,
      motion: a.effects.motion,
      color: a.effects.color,
      audio_fade_in: a.effects.audio_fade_in,
      audio_fade_out: a.effects.audio_fade_out,
      transition_to_next: a.effects.transition_to_next,
      transition_duration: a.effects.transition_duration,
      captions: a.captions.map((c) => ({
        png_path: c.pngPath,
        start: c.start,
        end: c.end,
      })),
      audio_leading_pad: a.audioLeadingPad,
      video_layers: a.videoLayers,
    }));

  const outputPath = await invoke<string>("compose_video", {
    sessionId,
    scenes: rustScenes,
    bgmPath,
    outputFilename: `video_${sessionId}.mp4`,
  });

  onProgress({
    phase: "done",
    totalScenes: totalCount,
    message: `完成！ ${outputPath}`,
  });

  return { outputPath, sessionId };
}
