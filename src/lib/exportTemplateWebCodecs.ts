/**
 * WebCodecs ベースの完全エクスポート経路 (映像 + 音声 + 動画レイヤー)。
 *
 * 既存の ffmpeg + filter_complex パイプラインは 362 layer 級で 90 分超かかる
 * (CPU 32% で頭打ち。filtergraph の framesync 待ちがボトルネック)。
 *
 * このモジュールはプレビュー側と同じ Canvas 合成コードで全フレームを焼き、
 * WebCodecs (h264 + AAC) で encode → mp4 mux する。
 * - filter_complex を完全に経由しない
 * - preview コードを再利用するので preview/export mismatch が原理的に発生しない
 * - GTX 1660 Ti の NVIDIA NVENC が WebCodecs から透過的に使われる
 * - 音声は OfflineAudioContext で全 audio レイヤーを 1 トラックにミックス → AAC
 * - 動画レイヤーは HTMLVideoElement を事前ロード、フレームごとに seek → drawImage
 *
 * Phase 3 の制限:
 * - character (Live2D) レイヤーは未対応 (次フェーズ: composeCharacterLayerVideo で pre-render)
 */

import {
  Output,
  Mp4OutputFormat,
  BufferTarget,
  CanvasSource,
  AudioBufferSource,
  QUALITY_HIGH,
  Input,
  BlobSource,
  Mp4InputFormat,
  WebMInputFormat,
  MatroskaInputFormat,
  QuickTimeInputFormat,
  VideoSampleSink,
  type VideoSample,
} from "mediabunny";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { VideoTemplate, Layer } from "../types";
import { templateDimensions } from "../types";
import {
  renderLayersOnContext,
  setCompositionCanvasDimensions,
} from "./layerComposer";

const FPS = 30;
const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_BITRATE = 128_000;

export interface WebCodecsExportProgress {
  phase: "preparing" | "encoding" | "finalizing" | "saving" | "done";
  frame?: number;
  totalFrames?: number;
  ratio?: number;
  message?: string;
}

export interface WebCodecsExportOptions {
  template: VideoTemplate;
  onProgress?: (p: WebCodecsExportProgress) => void;
  signal?: AbortSignal;
  /** 出力ファイル名のベース (.mp4 自動付与)。省略時は template.name */
  title?: string;
}

export interface WebCodecsExportResult {
  outputPath: string;
}

export async function exportTemplateWebCodecs(
  opts: WebCodecsExportOptions,
): Promise<WebCodecsExportResult> {
  const { template, onProgress, signal, title } = opts;

  onProgress?.({ phase: "preparing", message: "準備中..." });

  // 解像度設定 (preview/PNG 焼き経路と共有のグローバル FINAL_W/H に書き込む)
  const dims = templateDimensions(template);
  setCompositionCanvasDimensions(dims.width, dims.height);

  const totalDuration = template.totalDuration;
  const totalFrames = Math.max(1, Math.ceil(totalDuration * FPS));

  // OffscreenCanvas で合成 (メインスレッドの React DOM に影響しない)
  const canvas = new OffscreenCanvas(dims.width, dims.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("OffscreenCanvas の 2D context を取得できない");
  }

  // resolveSrc: 既存 video.ts の resolveLayerSrc と同等。auto/user 等の特殊値は null。
  const resolveSrc = async (l: Layer): Promise<string | null> => {
    if (l.source === "auto") return null;
    if (l.source && l.source !== "user") return l.source;
    return null;
  };

  // mediabunny: Mp4OutputFormat + h264 (avc) で BufferTarget に焼く
  const output = new Output({
    format: new Mp4OutputFormat(),
    target: new BufferTarget(),
  });
  const videoSource = new CanvasSource(canvas, {
    codec: "avc", // h264
    bitrate: QUALITY_HIGH,
  });
  output.addVideoTrack(videoSource, { frameRate: FPS });

  // 音声: 非空 audio レイヤーがあれば AAC トラックを追加
  const audioLayers = template.layers.filter(
    (l) =>
      l.type === "audio" &&
      !l.hidden &&
      l.source != null &&
      l.source !== "auto" &&
      l.source !== "user" &&
      l.source !== "",
  );
  const audioSource: AudioBufferSource | null =
    audioLayers.length > 0
      ? new AudioBufferSource({
          codec: "aac",
          bitrate: AUDIO_BITRATE,
        })
      : null;
  if (audioSource) {
    output.addAudioTrack(audioSource);
  }

  await output.start();

  // 音声ミックスは時間がかかるので、video の encode と並行で進める
  const audioPromise: Promise<AudioBuffer | null> =
    audioSource && audioLayers.length > 0
      ? mixAudioLayers(audioLayers, totalDuration, signal).catch((e) => {
          console.warn("[WebCodecs] audio mix failed, skipping audio:", e);
          return null;
        })
      : Promise.resolve(null);

  const visibleLayers = template.layers.filter((l) => !l.hidden);

  // 動画レイヤー: mediabunny の VideoSampleSink + samplesAtTimestamps で順次デコード。
  // HTMLVideoElement seek (GOP 遡り) より圧倒的に速い (10× 程度)。
  // 各レイヤーごとに「このレイヤーが可視なフレームの local time 一覧」を生成し、
  // sink.samplesAtTimestamps() に渡すと監視最適化されたデコードイテレータが得られる。
  onProgress?.({ phase: "preparing", message: "動画レイヤーを準備中..." });
  const videoLayerInfos = visibleLayers.filter(
    (l) =>
      l.type === "video" &&
      l.source &&
      l.source !== "auto" &&
      l.source !== "user",
  );

  interface VideoStream {
    layer: Layer;
    iter: AsyncIterator<VideoSample | null>;
    /** 各フレームでこのレイヤーが可視か (visibleByFrame[f] = true なら iter.next() を呼ぶ) */
    visibleByFrame: boolean[];
  }
  const videoStreams: VideoStream[] = [];
  for (const layer of videoLayerInfos) {
    if (!layer.source) continue;
    try {
      const url =
        layer.source.startsWith("http://") ||
        layer.source.startsWith("https://") ||
        layer.source.startsWith("data:") ||
        layer.source.startsWith("blob:")
          ? layer.source
          : convertFileSrc(layer.source);
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(
          `[WebCodecs] video layer ${layer.id} fetch failed: ${response.status}`,
        );
        continue;
      }
      const blob = await response.blob();
      const input = new Input({
        source: new BlobSource(blob),
        formats: [
          new Mp4InputFormat(),
          new QuickTimeInputFormat(),
          new WebMInputFormat(),
          new MatroskaInputFormat(),
        ],
      });
      const videoTrack = await input.getPrimaryVideoTrack();
      if (!videoTrack) {
        console.warn(`[WebCodecs] video layer ${layer.id}: no video track`);
        continue;
      }
      const videoDuration = await videoTrack.computeDuration();
      const sink = new VideoSampleSink(videoTrack);

      // 各フレームで「このレイヤーが可視か」と対応する local time を計算
      const rate = Math.max(0.05, Math.min(4, layer.playbackRate ?? 1));
      const timestamps: number[] = [];
      const visibleByFrame: boolean[] = new Array(totalFrames).fill(false);
      for (let f = 0; f < totalFrames; f++) {
        const t = f / FPS;
        if (t < layer.startSec || t >= layer.endSec) continue;
        let localT = (t - layer.startSec) * rate;
        if (
          videoDuration > 0 &&
          isFinite(videoDuration) &&
          layer.videoLoop
        ) {
          localT = localT % videoDuration;
        } else if (videoDuration > 0 && isFinite(videoDuration)) {
          // ループしない場合、動画長を超えたら最終フレーム手前で固定
          if (localT > videoDuration - 1 / FPS) {
            localT = Math.max(0, videoDuration - 1 / FPS);
          }
        }
        if (localT < 0) localT = 0;
        timestamps.push(localT);
        visibleByFrame[f] = true;
      }
      if (timestamps.length === 0) continue;

      const iter = sink.samplesAtTimestamps(timestamps)[Symbol.asyncIterator]();
      videoStreams.push({ layer, iter, visibleByFrame });
    } catch (e) {
      console.warn(`[WebCodecs] video layer ${layer.id} setup failed:`, e);
    }
  }

  try {
    onProgress?.({
      phase: "encoding",
      frame: 0,
      totalFrames,
      ratio: 0,
      message: `フレーム 0 / ${totalFrames}`,
    });

    for (let f = 0; f < totalFrames; f++) {
      if (signal?.aborted) {
        throw new Error("cancelled");
      }
      const t = f / FPS;

      // 各 video stream から「このフレームの sample」を順次取得
      const videoFrameSources = new Map<string, CanvasImageSource>();
      const samplesToClose: VideoSample[] = [];
      if (videoStreams.length > 0) {
        const pulls = videoStreams
          .filter((s) => s.visibleByFrame[f])
          .map(async (s) => {
            const next = await s.iter.next();
            if (next.done || !next.value) return null;
            return { stream: s, sample: next.value };
          });
        const results = await Promise.all(pulls);
        for (const r of results) {
          if (!r) continue;
          videoFrameSources.set(
            r.stream.layer.id,
            r.sample.toCanvasImageSource(),
          );
          samplesToClose.push(r.sample);
        }
      }

      // フレーム合成 (preview と同じ drawLayer 経路 + 入退場アニメ)
      await renderLayersOnContext(ctx, visibleLayers, resolveSrc, {
        skipVideoLayers: false,
        atTimeSec: t,
        videoFrameSources:
          videoFrameSources.size > 0 ? videoFrameSources : undefined,
        applyAnim: true,
      });

      // mediabunny にフレーム追加 (backpressure を尊重するため await)
      const tFrame = f / FPS;
      await videoSource.add(tFrame, 1 / FPS);

      // CanvasSource が canvas を読み終わったので VideoSample のメモリを解放
      for (const s of samplesToClose) {
        try {
          s.close();
        } catch {
          /* noop */
        }
      }

      if (onProgress && (f % 15 === 0 || f === totalFrames - 1)) {
        onProgress({
          phase: "encoding",
          frame: f + 1,
          totalFrames,
          ratio: (f + 1) / totalFrames,
          message: `フレーム ${f + 1} / ${totalFrames}`,
        });
      }
    }

    // 音声ミックスを待ち、得られたら encode
    onProgress?.({ phase: "finalizing", message: "音声を encode 中..." });
    let audioBuffer: AudioBuffer | null;
    try {
      audioBuffer = await audioPromise;
    } catch (e) {
      throw wrapError(e, "audio mix await");
    }
    if (audioSource && audioBuffer) {
      try {
        await audioSource.add(audioBuffer);
      } catch (e) {
        throw wrapError(e, "audioSource.add(audioBuffer)");
      }
    }

    onProgress?.({ phase: "finalizing", message: "mp4 をまとめ中..." });

    try {
      await output.finalize();
    } catch (e) {
      throw wrapError(e, "output.finalize()");
    }
    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) throw new Error("mediabunny BufferTarget produced no buffer");
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(buffer);
    } catch (e) {
      throw wrapError(
        e,
        `new Uint8Array(buffer) — buffer.byteLength=${buffer.byteLength}`,
      );
    }

    onProgress?.({
      phase: "saving",
      message: `ファイル保存中... (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB)`,
    });

    // 出力ファイル名 (既存 video.ts のフォーマットと揃える)
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const titleBase = sanitizeFilename(title ?? template.name ?? "", "video");
    const filename = `${titleBase}_${timestamp}.mp4`;

    // Tauri IPC は JSON 経由で 数百 MB の Uint8Array を一度に送ると
    // RangeError: Invalid array length で死ぬ。8MB チャンクで分割送信する。
    const CHUNK_SIZE = 8 * 1024 * 1024;
    let outputPath = "";
    const totalChunks = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_SIZE));
    for (let i = 0; i < bytes.byteLength; i += CHUNK_SIZE) {
      if (signal?.aborted) throw new Error("cancelled");
      const end = Math.min(i + CHUNK_SIZE, bytes.byteLength);
      const chunk = bytes.subarray(i, end);
      const isFirst = i === 0;
      try {
        outputPath = await invoke<string>("save_final_video", {
          filename,
          bytes: chunk,
          append: !isFirst,
        });
      } catch (e) {
        throw wrapError(
          e,
          `save_final_video chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${totalChunks} (${(chunk.byteLength / 1024 / 1024).toFixed(1)}MB)`,
        );
      }
      const chunkIdx = Math.floor(i / CHUNK_SIZE) + 1;
      onProgress?.({
        phase: "saving",
        message: `ファイル保存中 ${chunkIdx}/${totalChunks}`,
      });
    }

    onProgress?.({
      phase: "done",
      message: `完成: ${outputPath}`,
    });

    return { outputPath };
  } catch (e) {
    // 出力リソースをクリーンアップ
    try {
      // mediabunny の finalize 前にエラーで抜けた場合のリソース解放
      // (Output に直接 cancel/abort API があれば呼ぶ。なければ noop。)
      const cancellable = output as unknown as { cancel?: () => Promise<void> };
      await cancellable.cancel?.();
    } catch {
      /* noop */
    }
    throw e;
  }
}

/**
 * 全 audio レイヤーを OfflineAudioContext で 1 本の AudioBuffer にミックスダウン。
 *
 * 各レイヤーごとに:
 *   - layer.source を fetch → decodeAudioData → AudioBuffer
 *   - AudioBufferSourceNode に渡し、playbackRate / loop を反映
 *   - GainNode で volume + fade in/out のエンベロープを適用
 *   - layer.startSec で .start(), (endSec - startSec) で duration 制限
 *   - destination に接続
 *
 * preview の `<audio>` 経路と同じ式 (volume, fade, atempo) を Web Audio で実現するので、
 * 「preview と export で音が違う」が原理的に起きない。
 */
async function mixAudioLayers(
  audioLayers: Layer[],
  totalDuration: number,
  signal: AbortSignal | undefined,
): Promise<AudioBuffer | null> {
  if (audioLayers.length === 0) return null;
  const ctx = new OfflineAudioContext(
    2,
    Math.max(1, Math.ceil(totalDuration * AUDIO_SAMPLE_RATE)),
    AUDIO_SAMPLE_RATE,
  );

  let scheduledCount = 0;

  for (const layer of audioLayers) {
    if (signal?.aborted) throw new Error("cancelled");
    if (!layer.source) continue;
    try {
      // ファイルパスは convertFileSrc で Tauri webview 用 URL に変換
      const url =
        layer.source.startsWith("http://") ||
        layer.source.startsWith("https://") ||
        layer.source.startsWith("data:") ||
        layer.source.startsWith("blob:")
          ? layer.source
          : convertFileSrc(layer.source);
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(
          `[WebCodecs] audio layer ${layer.id} fetch failed: ${response.status}`,
        );
        continue;
      }
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

      const sourceNode = ctx.createBufferSource();
      sourceNode.buffer = audioBuffer;
      // playbackRate は AudioBufferSourceNode が直接持つ (atempo 相当)
      const rate = Math.max(0.05, Math.min(4, layer.playbackRate ?? 1));
      sourceNode.playbackRate.value = rate;
      sourceNode.loop = !!layer.audioLoop;

      // 音量 + フェード
      const gainNode = ctx.createGain();
      const baseVol = Math.max(0, layer.volume ?? 1);
      const fadeIn = Math.max(0, layer.audioFadeIn ?? 0);
      const fadeOut = Math.max(0, layer.audioFadeOut ?? 0);
      const startT = Math.max(0, layer.startSec);
      const endT = Math.min(totalDuration, layer.endSec);
      const visibleDur = Math.max(0.01, endT - startT);

      // フェードイン
      if (fadeIn > 0.001) {
        gainNode.gain.setValueAtTime(0, startT);
        gainNode.gain.linearRampToValueAtTime(
          baseVol,
          startT + Math.min(fadeIn, visibleDur),
        );
      } else {
        gainNode.gain.setValueAtTime(baseVol, startT);
      }
      // フェードアウト
      if (fadeOut > 0.001) {
        const fadeOutStart = Math.max(
          startT + fadeIn,
          endT - Math.min(fadeOut, visibleDur),
        );
        gainNode.gain.setValueAtTime(baseVol, fadeOutStart);
        gainNode.gain.linearRampToValueAtTime(0, endT);
      }

      sourceNode.connect(gainNode);
      gainNode.connect(ctx.destination);

      // 再生スケジュール: when=startT, offset=0, duration=visibleDur
      // loop=true のときは visibleDur 経過後に自動停止 (sourceNode.stop)
      sourceNode.start(startT, 0, visibleDur);
      sourceNode.stop(endT);
      scheduledCount++;
    } catch (e) {
      console.warn(`[WebCodecs] audio layer ${layer.id} skipped:`, e);
    }
  }

  if (scheduledCount === 0) {
    return null;
  }

  return await ctx.startRendering();
}

/** エラーに「どのステップで」を付加する。スタックは元エラーのものを保持。 */
function wrapError(e: unknown, location: string): Error {
  const msg = e instanceof Error ? e.message : String(e);
  const wrapped = new Error(`[${location}] ${msg}`);
  if (e instanceof Error && e.stack) {
    wrapped.stack = `[${location}] ${e.stack}`;
  }
  return wrapped;
}

function sanitizeFilename(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : fallback;
}
