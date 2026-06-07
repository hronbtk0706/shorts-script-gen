/**
 * Live2D キャラクタレイヤーを **オフラインで** 1 本の WebM (VP9 + alpha) に焼き出す。
 *
 * - レイヤー設定とリンク音声から `tickCharacter(t)` を 1 frame ずつ呼ぶ
 * - OffscreenCanvas + PIXI で frame を描画し、mediabunny + WebCodecs で VP9 alpha エンコード
 * - **プレビューと同じ tickCharacter を使う** ので「見た目と出力が違う」を回避できる
 * - 出力された .webm は既存の Rust エクスポートパイプラインに **video レイヤーとして** 渡せる
 *   (Cubism Core は触らないので合成段階に Live2D 依存は持ち込まない)
 */

import { Application } from "pixi.js";
import {
  Output,
  WebMOutputFormat,
  BufferTarget,
  CanvasSource,
  QUALITY_VERY_HIGH,
} from "mediabunny";
import { invoke } from "@tauri-apps/api/core";
import type { Layer } from "../types";
import { loadLive2DModel, type LoadedLive2D } from "./live2dLoader";
import {
  tickCharacter,
  createTickState,
  type TickableModel,
} from "./characterTick";
import { buildCompositeLipsyncSampler } from "./compositeLipsync";

export interface CharacterRenderOptions {
  layer: Layer;
  /**
   * リップシンク駆動元として候補にする音声レイヤー一覧。
   * - linkedAudioLayerId 指定時 → その 1 本だけが渡される
   * - 未指定 (auto) 時 → テンプレ内の全音声レイヤー (時刻 t で自動切替)
   */
  audiosForLipsync: Layer[];
  /** 出力ピクセル幅 (= レイヤーの static destination width) */
  outputWidth: number;
  outputHeight: number;
  /** 出力 fps */
  fps: number;
  /** Tauri セッション ID (中間ファイル保存先) */
  sessionId: string;
  /** 中間ファイル名のベース (拡張子なし) */
  baseName: string;
  /** 進捗コールバック (frame 単位) */
  onProgress?: (currentFrame: number, totalFrames: number) => void;
}

export interface CharacterRenderResult {
  /** 保存された WebM の絶対パス */
  outputPath: string;
  /** 動画の長さ (秒) */
  durationSec: number;
}

/**
 * キャラレイヤー 1 本を WebM に焼く。
 * 焼き上がった webm のパスを返すので、呼び元はこれを `kind: "video"` の
 * RustTemplateLayerInput として既存パイプラインに流すだけで合成できる。
 */
export async function composeCharacterLayerVideo(
  opts: CharacterRenderOptions,
): Promise<CharacterRenderResult> {
  const {
    layer,
    audiosForLipsync,
    outputWidth,
    outputHeight,
    fps,
    sessionId,
    baseName,
    onProgress,
  } = opts;

  if (!layer.modelPath) {
    throw new Error("Character layer has no modelPath");
  }

  const duration = Math.max(0.1, layer.endSec - layer.startSec);
  const totalFrames = Math.max(1, Math.ceil(duration * fps));
  const physicsDt = 1 / fps;

  // ---------- 1. OffscreenCanvas + PIXI Application ----------
  const canvas = new OffscreenCanvas(outputWidth, outputHeight);
  // PIXI v7 は OffscreenCanvas を view として受け付ける (型上は HTMLCanvasElement だが実装は OffscreenCanvas を許容)
  const app = new Application({
    view: canvas as unknown as HTMLCanvasElement,
    width: outputWidth,
    height: outputHeight,
    backgroundAlpha: 0,
    antialias: true,
    autoStart: false,
    preserveDrawingBuffer: true,
  });

  let loaded: LoadedLive2D | null = null;
  try {
    // ---------- 2. モデル読み込み + フィット ----------
    loaded = await loadLive2DModel(layer.modelPath);
    const mw = loaded.modelWidth || 1;
    const mh = loaded.modelHeight || 1;
    const scale = Math.min(outputWidth / mw, outputHeight / mh);
    loaded.model.scale.set(scale);
    const anchor = (
      loaded.model as unknown as {
        anchor?: { set(x: number, y: number): void };
      }
    ).anchor;
    if (anchor && typeof anchor.set === "function") {
      anchor.set(0.5, 0.5);
    }
    loaded.model.x = outputWidth / 2;
    loaded.model.y = outputHeight / 2;
    app.stage.addChild(loaded.model as unknown as never);

    // ---------- 3. リップシンクサンプラ構築 (複数音声を時刻で自動切替) ----------
    let lipsyncSampler:
      | ((t: number) => { openY: number; form: number })
      | null = null;
    const mode = layer.lipsyncMode ?? "voicevox";
    if (mode !== "off" && audiosForLipsync.length > 0) {
      lipsyncSampler = await buildCompositeLipsyncSampler(
        audiosForLipsync,
        mode === "rms" ? "rms" : "voicevox",
      );
    }
    const tickState = createTickState(layer, duration + 60);
    tickState.lipsyncSampler = lipsyncSampler;

    // ---------- 4. mediabunny output 構築 ----------
    const output = new Output({
      format: new WebMOutputFormat(),
      target: new BufferTarget(),
    });
    const videoSource = new CanvasSource(canvas, {
      codec: "vp9",
      // 最終 mp4 (exportTemplateWebCodecs) の引き上げに合わせ、キャラ事前焼きも高ビットレート化。
      bitrate: QUALITY_VERY_HIGH,
      alpha: "keep",
    });
    output.addVideoTrack(videoSource, { frameRate: fps });
    await output.start();

    // ---------- 5. フレームループ (実時間に依存しない frame-step) ----------
    for (let f = 0; f < totalFrames; f++) {
      // global テンプレ時刻 (リップシンクサンプラもこの時刻で引かれる)
      const tGlobal = layer.startSec + f / fps;
      tickCharacter(
        loaded.model as unknown as TickableModel,
        loaded.cubismModel,
        loaded.paramIndex,
        layer,
        loaded.paramMap,
        tGlobal,
        physicsDt,
        tickState,
      );
      app.render();

      // mediabunny の timestamp は動画内 (0 始まり) の秒
      const tFrame = f / fps;
      // backpressure を尊重するため await する
      await videoSource.add(tFrame, 1 / fps);

      if (onProgress && (f % 30 === 0 || f === totalFrames - 1)) {
        onProgress(f + 1, totalFrames);
      }
    }

    // ---------- 6. 完了 + バイト取得 ----------
    await output.finalize();
    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) throw new Error("BufferTarget produced no buffer");
    const bytes = new Uint8Array(buffer);

    // ---------- 7. Rust に渡してディスクへ書き出し ----------
    const outputPath = await invoke<string>("save_render_chunk", {
      sessionId,
      filename: `${baseName}.webm`,
      bytes,
    });

    return { outputPath, durationSec: duration };
  } finally {
    // モデル / PIXI の後片付け (失敗時もメモリリークさせない)
    try {
      app.destroy(false, { children: true, texture: true });
    } catch {
      /* noop */
    }
    void loaded;
  }
}
