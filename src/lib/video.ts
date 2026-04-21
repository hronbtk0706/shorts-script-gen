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
import {
  composeLayersToPng,
  composeLayerContentPng,
} from "./layerComposer";

export interface CaptionAsset {
  pngPath: string;
  start: number;
  end: number;
}

export interface TimedOverlayAsset {
  pngPath: string;
  start: number;
  end: number;
  xPct: number;
  yPct: number;
  widthPct: number;
  heightPct: number;
  rotation: number;
  zIndex: number;
  entryAnimation: string;
  entryDuration: number;
  exitAnimation: string;
  exitDuration: number;
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
  timedOverlays: TimedOverlayAsset[];
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
  startSec: number;
  endSec: number;
  entryAnimation: string;
  entryDuration: number;
  exitAnimation: string;
  exitDuration: number;
  videoLoop: boolean;
}

interface RustTimedOverlayInput {
  pngPath: string;
  start: number;
  end: number;
  xPct: number;
  yPct: number;
  widthPct: number;
  heightPct: number;
  rotation: number;
  zIndex: number;
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
  captions: RustCaptionInput[];
  audio_leading_pad: number;
  video_layers: RustVideoLayerInput[];
  timed_overlays: RustTimedOverlayInput[];
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
  options?: { manualMode?: boolean },
): Promise<VideoResult> {
  const manualMode = options?.manualMode === true;
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

  /** セグメントと重なるレイヤーを抽出（hidden は書き出しからも除外） */
  const layersForSegment = (seg: TemplateSegment | null): Layer[] => {
    if (!seg || !template) return [];
    return template.layers.filter(
      (l) =>
        !l.hidden && l.startSec < seg.endSec && l.endSec > seg.startSec,
    );
  };

  const allScenes = [
    {
      index: 0,
      narration: script.hook.text,
      visual: script.hook.visual,
      image_prompt: script.hook.image_prompt || fallbackImagePrompt(script.hook.visual),
      image_path: script.hook.image_path,
      // 手動モードではオーバーレイ/キャプションを出さない（レイヤーが描画済みなので）
      text_overlay: manualMode ? "" : script.hook.text,
      style: script.hook.subtitle_style,
      effects: resolveEffects(script.hook.effects, { isFirst: true }),
      skipCaption: manualMode,
      templateSegment: segmentByKey.get("hook_0") ?? null,
      templateLayers: layersForSegment(segmentByKey.get("hook_0") ?? null),
    },
    ...script.body.map((b, i) => ({
      index: i + 1,
      narration: b.narration,
      visual: b.visual,
      image_prompt: b.image_prompt || fallbackImagePrompt(b.visual),
      image_path: b.image_path,
      text_overlay: manualMode ? "" : b.text_overlay,
      style: b.subtitle_style,
      effects: resolveEffects(b.effects),
      skipCaption: manualMode,
      templateSegment: segmentByKey.get(`body_${i}`) ?? null,
      templateLayers: layersForSegment(segmentByKey.get(`body_${i}`) ?? null),
    })),
    {
      index: script.body.length + 1,
      narration: script.cta.text,
      visual: script.cta.text,
      image_prompt: script.cta.image_prompt || fallbackImagePrompt(script.cta.text),
      image_path: script.cta.image_path,
      text_overlay: manualMode ? "" : script.cta.text,
      style: script.cta.subtitle_style,
      effects: resolveEffects(script.cta.effects, { isLast: true }),
      skipCaption: true,
      templateSegment: segmentByKey.get("cta_0") ?? null,
      templateLayers: layersForSegment(segmentByKey.get("cta_0") ?? null),
    },
  ];

  const totalCount = allScenes.length;

  // 手動モードのシーン用に使いまわす無音 wav（1 度だけ生成）
  // 全シーンの最長尺より長く作っておけば Rust 側で -t により自動で切り詰められる
  let sharedSilentAudioPath: string | null = null;
  const maxSceneDuration = Math.max(
    ...allScenes.map((s) => {
      const seg = s.templateSegment;
      if (!seg) return 1;
      return Math.max(0.001, seg.endSec - seg.startSec);
    }),
    1,
  );

  for (const scene of allScenes) {
    let imagePath: string;
    // レイヤー合成（テンプレのセグメントに対応するレイヤー群が複雑な場合）
    const allSegLayers = scene.templateLayers;
    const seg = scene.templateSegment;

    // レイヤーを「常時表示」と「時間ゲート付き」に分割
    //   常時表示 = セグメント開始〜終了までフルで見えるレイヤー（ベース画像に焼き込み）
    //   時間ゲート付き = 一部時刻のみ表示（個別 PNG + enable filter）
    const alwaysVisibleLayers: Layer[] = [];
    const timeGatedLayers: Layer[] = [];
    if (seg) {
      const epsilon = 0.02;
      for (const l of allSegLayers) {
        if (l.type === "video") continue; // video は video_layers で別扱い
        const coversStart = l.startSec <= seg.startSec + epsilon;
        const coversEnd = l.endSec >= seg.endSec - epsilon;
        if (coversStart && coversEnd) {
          alwaysVisibleLayers.push(l);
        } else {
          timeGatedLayers.push(l);
        }
      }
    } else {
      // テンプレなし/セグメントなしなら全て常時表示扱い
      for (const l of allSegLayers) {
        if (l.type !== "video") alwaysVisibleLayers.push(l);
      }
    }

    // zIndex 正しさのため: タイムゲート付きの最低 zIndex より高い zIndex を持つ
    // 常時表示レイヤーは、常時表示のままだと下に埋もれてしまう（ベース焼き込み→後からoverlayで上書きされる）
    // → 常時表示から外して時間ゲート側に移動し、セグメント全期間で表示する
    if (timeGatedLayers.length > 0 && alwaysVisibleLayers.length > 0 && seg) {
      const minTimedZ = Math.min(...timeGatedLayers.map((l) => l.zIndex));
      const needsPromotion = alwaysVisibleLayers.filter((l) => l.zIndex > minTimedZ);
      if (needsPromotion.length > 0) {
        for (const l of needsPromotion) {
          const idx = alwaysVisibleLayers.indexOf(l);
          if (idx >= 0) alwaysVisibleLayers.splice(idx, 1);
          // セグメント全期間で表示するタイムドオーバーレイに変換
          timeGatedLayers.push({
            ...l,
            startSec: seg.startSec,
            endSec: seg.endSec,
          });
        }
      }
    }

    // タイムゲートレイヤーを zIndex ASC でソート（低い→高い順にオーバーレイ）
    timeGatedLayers.sort((a, b) => a.zIndex - b.zIndex);

    const segLayers = alwaysVisibleLayers;
    // ベース画像を「常時表示レイヤーの合成」で作るか判断。
    // 条件: 常時表示レイヤーがあり、かつ「auto 全画面1枚」だけではない場合
    const hasComplexBase =
      alwaysVisibleLayers.length > 0 &&
      !(
        alwaysVisibleLayers.length === 1 &&
        alwaysVisibleLayers[0].type === "image" &&
        alwaysVisibleLayers[0].source === "auto" &&
        alwaysVisibleLayers[0].x === 0 &&
        alwaysVisibleLayers[0].y === 0 &&
        alwaysVisibleLayers[0].width === 100 &&
        alwaysVisibleLayers[0].height === 100
      );

    // 時間ゲート付きレイヤー用も含めて auto 画像ソースを事前解決するため、全体で共有する
    // 手動モードでは AI 画像生成をスキップ（未指定は空のまま）
    const resolvedSources = new Map<string, string>();
    if (!manualMode) {
      for (const layer of allSegLayers) {
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
    }
    const resolveLayerSrc = async (layer: Layer): Promise<string | null> => {
      if (layer.source === "auto") {
        return resolvedSources.get(layer.id) ?? null;
      }
      if (layer.source && layer.source !== "user") {
        return layer.source;
      }
      return null;
    };

    if (scene.image_path) {
      onProgress({
        phase: "image",
        sceneIndex: scene.index,
        totalScenes: totalCount,
        message: `シーン ${scene.index + 1}/${totalCount}: ユーザー指定画像を使用`,
      });
      imagePath = scene.image_path;
    } else if (hasComplexBase || manualMode) {
      // 手動モードでは常にレイヤー合成のみ（ベース画像生成なし。未指定レイヤーは透過）
      onProgress({
        phase: "image",
        sceneIndex: scene.index,
        totalScenes: totalCount,
        message: `シーン ${scene.index + 1}/${totalCount}: レイヤー合成中...`,
      });
      imagePath = await composeLayersToPng(
        segLayers,
        resolveLayerSrc,
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

    let audioPath: string;
    let audioDuration: number;
    let leadingPad: number;
    let sceneDuration: number;

    if (manualMode) {
      // 手動モードでは comment テキストからの自動 TTS は行わない。
      // ナレーションは LayerPropertyPanel で明示生成して音声レイヤー化して
      // もらう（build_user_audio_track で最終ミックスされる）。
      // Rust 側の compose_video がシーンごとに audio_path を要求するため、
      // ここでは共通の無音 wav を 1 本だけ作って全シーンで使いまわす。
      const seg = scene.templateSegment;
      const segStart = seg?.startSec ?? 0;
      const segEnd = seg?.endSec ?? segStart;
      const finalSceneDuration = Math.max(0.001, segEnd - segStart);

      // 同一 session で既に作られていればキャッシュ再利用
      if (!sharedSilentAudioPath) {
        sharedSilentAudioPath = await invoke<string>("generate_silent_wav", {
          sessionId,
          duration: maxSceneDuration,
        });
      }
      audioPath = sharedSilentAudioPath;
      audioDuration = finalSceneDuration;
      leadingPad = 0;
      sceneDuration = finalSceneDuration;
    } else {
      audioPath = await ttsProvider.synthesize(
        {
          text: scene.narration,
          filename: `scene_${scene.index}`,
          sessionId,
        },
        settings,
      );
      audioDuration = await invoke<number>("get_audio_duration", { audioPath });
      leadingPad = scene.index === 0 ? 0 : AUDIO_LEADING_PAD_SECONDS;
      sceneDuration = audioDuration + leadingPad;
    }

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
    if (scene.templateLayers.length > 0 && scene.templateSegment) {
      const seg = scene.templateSegment;
      const segDur = Math.max(0.001, seg.endSec - seg.startSec);
      for (const l of scene.templateLayers) {
        if (
          l.type === "video" &&
          l.source &&
          l.source !== "auto" &&
          l.source !== "user"
        ) {
          // グローバル時刻→セグメント内相対→シーン内相対（leadingPad 加算）
          const relStartInSeg = Math.max(0, l.startSec - seg.startSec);
          const relEndInSeg = Math.min(segDur, l.endSec - seg.startSec);
          const sceneStart = leadingPad + relStartInSeg;
          const sceneEnd = leadingPad + Math.max(relStartInSeg, relEndInSeg);
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
            startSec: sceneStart,
            endSec: sceneEnd,
            entryAnimation: l.entryAnimation ?? "none",
            entryDuration: l.entryDuration ?? 0.3,
            exitAnimation: l.exitAnimation ?? "none",
            exitDuration: l.exitDuration ?? 0.3,
            videoLoop: (l.videoLoop ?? true) === true,
          });
        }
      }
    }

    // 時間ゲート付き静止レイヤー（image/text/color/shape/comment）を個別 PNG 化
    const timedOverlays: TimedOverlayAsset[] = [];
    if (timeGatedLayers.length > 0 && seg) {
      onProgress({
        phase: "overlay",
        sceneIndex: scene.index,
        totalScenes: totalCount,
        message: `シーン ${scene.index + 1}/${totalCount}: 時間ゲートレイヤー ${timeGatedLayers.length} 個を処理中...`,
      });
      const segDurLocal = Math.max(0.001, seg.endSec - seg.startSec);
      for (const l of timeGatedLayers) {
        const relStart = Math.max(0, l.startSec - seg.startSec);
        const relEnd = Math.min(segDurLocal, l.endSec - seg.startSec);
        if (relEnd <= relStart) continue;
        // シーン尺にクランプ（audio 尺がテンプレ segment より短い場合に外枠外へ出るのを防ぐ）
        const rawStart = leadingPad + relStart;
        const rawEnd = leadingPad + relEnd;
        const sceneStart = Math.min(rawStart, sceneDuration);
        const sceneEnd = Math.min(rawEnd, sceneDuration);
        if (sceneEnd - sceneStart < 0.05) {
          console.warn(
            `[video] timed layer ${l.id} skipped: range out of scene (${rawStart}-${rawEnd}s, scene=${sceneDuration}s)`,
          );
          continue;
        }
        try {
          const pngPath = await composeLayerContentPng(
            l,
            resolveLayerSrc,
            sessionId,
            `scene_${scene.index}_timed_${l.id}`,
          );
          timedOverlays.push({
            pngPath,
            start: sceneStart,
            end: sceneEnd,
            xPct: l.x,
            yPct: l.y,
            widthPct: l.width,
            heightPct: l.height,
            rotation: l.rotation ?? 0,
            zIndex: l.zIndex ?? 0,
            entryAnimation: l.entryAnimation ?? "none",
            entryDuration: l.entryDuration ?? 0.3,
            exitAnimation: l.exitAnimation ?? "none",
            exitDuration: l.exitDuration ?? 0.3,
          });
          console.log(
            `[video] timed layer ${l.id} rendered at ${sceneStart.toFixed(2)}-${sceneEnd.toFixed(2)}s (${l.type})`,
          );
        } catch (e) {
          console.error(
            `[video] failed to render timed layer ${l.id}:`,
            e,
          );
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
      timedOverlays,
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

  // ユーザー配置の音声レイヤーを集めて 1 本のトラックにミックス
  let userAudioTrackPath: string | null = null;
  if (template?.layers) {
    const audioLayers = template.layers.filter(
      (l) =>
        l.type === "audio" &&
        !l.hidden &&
        l.source &&
        l.source !== "auto" &&
        l.source !== "user",
    );
    if (audioLayers.length > 0) {
      const totalDuration = assets.reduce((acc, a) => acc + a.duration, 0);
      try {
        userAudioTrackPath = await invoke<string>("build_user_audio_track", {
          sessionId,
          filename: "user_audio_track",
          clips: audioLayers.map((l) => ({
            path: l.source as string,
            startSec: l.startSec,
            endSec: l.endSec,
            volume: l.volume ?? 1,
            fadeIn: l.audioFadeIn ?? 0,
            fadeOut: l.audioFadeOut ?? 0,
            loopAudio: !!l.audioLoop,
          })),
          totalDurationSec: totalDuration,
        });
      } catch (e) {
        console.warn("[video] user audio mix failed:", e);
      }
    }
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
      timed_overlays: a.timedOverlays.map((c) => ({
        pngPath: c.pngPath,
        start: c.start,
        end: c.end,
        xPct: c.xPct,
        yPct: c.yPct,
        widthPct: c.widthPct,
        heightPct: c.heightPct,
        rotation: c.rotation,
        zIndex: c.zIndex,
        entryAnimation: c.entryAnimation,
        entryDuration: c.entryDuration,
        exitAnimation: c.exitAnimation,
        exitDuration: c.exitDuration,
      })),
    }));

  const outputPath = await invoke<string>("compose_video", {
    sessionId,
    scenes: rustScenes,
    bgmPath,
    userAudioTrackPath,
    outputFilename: `video_${sessionId}.mp4`,
  });

  onProgress({
    phase: "done",
    totalScenes: totalCount,
    message: `完成！ ${outputPath}`,
  });

  return { outputPath, sessionId };
}
