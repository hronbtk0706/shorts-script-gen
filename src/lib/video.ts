import { invoke } from "@tauri-apps/api/core";
import type { Script, SubtitleStyle, SceneEffects } from "../types";
import { loadSettings } from "./storage";
import {
  canvasToBase64Png,
  renderCaptionCanvas,
  renderSubtitleCanvas,
} from "./subtitleRender";
import { getTtsProvider } from "./providers/tts";
import { getImageProvider } from "./providers/image";
import { resolveEffects } from "./effects";

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
}

function fallbackImagePrompt(visual: string): string {
  return `${visual}, vibrant, cinematic, vertical 9:16, high detail`;
}

async function renderAndSaveOverlay(
  text: string,
  style: SubtitleStyle,
  filename: string,
): Promise<string> {
  const canvas = renderSubtitleCanvas(text, style, "top");
  const base64 = canvasToBase64Png(canvas);
  return invoke<string>("save_overlay_png", {
    base64Data: base64,
    filename,
  });
}

async function renderAndSaveCaption(
  text: string,
  filename: string,
): Promise<string> {
  const canvas = renderCaptionCanvas(text);
  const base64 = canvasToBase64Png(canvas);
  return invoke<string>("save_overlay_png", {
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

function allocateCaptionTimings(
  chunks: string[],
  totalDuration: number,
): Array<{ text: string; start: number; end: number }> {
  if (chunks.length === 0 || totalDuration <= 0) return [];
  const totalChars = chunks.reduce((sum, c) => sum + countNonPunct(c), 0);
  if (totalChars === 0) return [];
  const result: Array<{ text: string; start: number; end: number }> = [];
  let cursor = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chars = countNonPunct(chunks[i]);
    const isLast = i === chunks.length - 1;
    const dur = (chars / totalChars) * totalDuration;
    const start = cursor;
    const end = isLast ? totalDuration : Math.min(cursor + dur, totalDuration);
    result.push({ text: chunks[i], start, end });
    cursor = end;
  }
  return result;
}

export async function generateVideo(
  _apiKey: string,
  script: Script,
  onProgress: ProgressCallback,
): Promise<string> {
  const sessionId = Date.now().toString();
  const assets: SceneAssets[] = [];
  const settings = await loadSettings();
  const ttsProvider = getTtsProvider(settings.ttsProvider);
  const imageProvider = getImageProvider(settings.imageProvider);

  const allScenes = [
    {
      index: 0,
      narration: script.hook.text,
      visual: script.hook.visual,
      image_prompt: script.hook.image_prompt || fallbackImagePrompt(script.hook.visual),
      text_overlay: script.hook.text,
      style: script.hook.subtitle_style,
      effects: resolveEffects(script.hook.effects, { isFirst: true }),
      skipCaption: false,
    },
    ...script.body.map((b, i) => ({
      index: i + 1,
      narration: b.narration,
      visual: b.visual,
      image_prompt: b.image_prompt || fallbackImagePrompt(b.visual),
      text_overlay: b.text_overlay,
      style: b.subtitle_style,
      effects: resolveEffects(b.effects),
      skipCaption: false,
    })),
    {
      index: script.body.length + 1,
      narration: script.cta.text,
      visual: script.cta.text,
      image_prompt: script.cta.image_prompt || fallbackImagePrompt(script.cta.text),
      text_overlay: script.cta.text,
      style: script.cta.subtitle_style,
      effects: resolveEffects(script.cta.effects, { isLast: true }),
      skipCaption: true,
    },
  ];

  const totalCount = allScenes.length;

  for (const scene of allScenes) {
    onProgress({
      phase: "image",
      sceneIndex: scene.index,
      totalScenes: totalCount,
      message: `シーン ${scene.index + 1}/${totalCount}: 画像生成中（${imageProvider.label}）...`,
    });

    const imagePath = await imageProvider.generate(
      {
        prompt: scene.image_prompt,
        seed: parseInt(sessionId.slice(-6)) + scene.index,
        filename: `${sessionId}_scene_${scene.index}`,
      },
      settings,
    );

    onProgress({
      phase: "overlay",
      sceneIndex: scene.index,
      totalScenes: totalCount,
      message: `シーン ${scene.index + 1}/${totalCount}: テロップ生成中...`,
    });

    const overlayPngPath = await renderAndSaveOverlay(
      scene.text_overlay,
      scene.style,
      `${sessionId}_overlay_${scene.index}`,
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
        filename: `${sessionId}_scene_${scene.index}`,
      },
      settings,
    );

    const duration = await invoke<number>("get_audio_duration", {
      audioPath,
    });

    const captions: CaptionAsset[] = [];
    if (!scene.skipCaption) {
      const captionChunks = splitNarration(scene.narration);
      const captionTimings = allocateCaptionTimings(captionChunks, duration);
      for (let ci = 0; ci < captionTimings.length; ci++) {
        const c = captionTimings[ci];
        const displayText = c.text.replace(/、$/, "");
        const pngPath = await renderAndSaveCaption(
          displayText,
          `${sessionId}_caption_${scene.index}_${ci}`,
        );
        captions.push({ pngPath, start: c.start, end: c.end });
      }
    }

    assets.push({
      index: scene.index,
      imagePath,
      audioPath,
      overlayPngPath,
      duration,
      effects: scene.effects,
      captions,
    });
  }

  onProgress({
    phase: "compose",
    totalScenes: totalCount,
    message: "動画を合成中（ffmpeg）...",
  });

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
    }));

  const outputPath = await invoke<string>("compose_video", {
    scenes: rustScenes,
    bgmPath: null,
    outputFilename: `video_${sessionId}.mp4`,
  });

  onProgress({
    phase: "done",
    totalScenes: totalCount,
    message: `完成！ ${outputPath}`,
  });

  return outputPath;
}
