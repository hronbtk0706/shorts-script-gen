/**
 * キャラクターレイヤーの「時刻 t における全パラメータ値」を計算してモデルに適用する。
 *
 * 重要: この関数は **プレビューとエクスポートで完全に同じ結果を返す** 必要がある。
 * 同じ (model, layer, t) を渡したら同じ絵が出る、という保証がエクスポートとの一致の根拠。
 *
 * - 副作用: model に直接 setParameterValueById で書き込み、最後に update() を呼ぶ
 * - 物理演算は dt 依存なので Phase 2 では preview ループで dt を渡す形だが、
 *   Phase 4 のオフライン描画では fps から固定ステップで進める (この関数自体は physicsDt を引数で受ける)
 */

import type { Layer, CubismParamMap, BlinkConfig, ExpressionKeyframe } from "../types";

/** Cubism Core が直接公開している Model (parameters.values 等を Float32Array で持つ) */
export interface CubismCoreNativeModel {
  parameters: {
    ids: string[];
    values: Float32Array;
    minimumValues: Float32Array;
    maximumValues: Float32Array;
  };
}

export interface TickableModel {
  internalModel?: {
    motionManager?: {
      expressionManager?: {
        setExpression(name: string): unknown;
      };
    };
  };
  update(deltaTime: number): void;
}

// -----------------------------------------------------------------------------
// 1) 抽象パラメータセッタ - paramMap で実 ID に解決し、paramIndex でインデックス引きして
//    Float32Array に直接書き込む。なければ silently skip。
// -----------------------------------------------------------------------------
function setParam(
  cubismModel: CubismCoreNativeModel,
  paramIndex: Record<string, number>,
  paramMap: CubismParamMap,
  key: keyof CubismParamMap,
  value: number,
): void {
  const id = paramMap[key];
  if (!id) return;
  const idx = paramIndex[id];
  if (idx === undefined) return;
  // min/max でクランプ (モデルが定義してる範囲外の値で破綻するのを防ぐ)
  const min = cubismModel.parameters.minimumValues[idx];
  const max = cubismModel.parameters.maximumValues[idx];
  let v = value;
  if (v < min) v = min;
  else if (v > max) v = max;
  cubismModel.parameters.values[idx] = v;
}

function getParam(
  cubismModel: CubismCoreNativeModel,
  paramIndex: Record<string, number>,
  id: string,
): number {
  const idx = paramIndex[id];
  if (idx === undefined) return 0;
  return cubismModel.parameters.values[idx];
}

// -----------------------------------------------------------------------------
// 2) シード付き決定論 PRNG (mulberry32)
//    同じ seed なら何度呼んでも同じ系列を返す。
// -----------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 瞬きタイムラインを生成 (時刻順の開始時刻配列)。
 * シードと設定が同じならプレビュー / エクスポートで完全一致する。
 */
function buildBlinkSchedule(config: BlinkConfig, maxDuration: number): number[] {
  if (!config.enabled) return [];
  const rand = mulberry32(config.seed);
  const times: number[] = [];
  let t = 1.5; // 開始直後すぐ瞬きしないよう少し offset
  // 過剰生成回避のためハードリミット (10000 回)
  for (let i = 0; i < 10000 && t < maxDuration; i++) {
    const jitter = (rand() * 2 - 1) * config.intervalJitter;
    const interval = Math.max(0.6, config.intervalMean + jitter);
    times.push(t);
    t += interval;
  }
  return times;
}

/**
 * 時刻 t における目の開き度 (1.0=全開, 0.0=完全に閉じる) を返す。
 * 各瞬き開始から duration 秒で「開→閉→開」のコサイン曲線を 1 周する。
 */
function blinkOpenness(schedule: number[], t: number, duration: number): number {
  // 二分探索する程の量ではないので線形でよい (10000 程度)
  // でも長尺対策で binary search にする
  let lo = 0;
  let hi = schedule.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = schedule[mid];
    if (v <= t) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (candidate < 0) return 1.0;
  const start = schedule[candidate];
  const local = t - start;
  if (local < 0 || local > duration) return 1.0;
  const phase = (local / duration) * 2 * Math.PI;
  return (Math.cos(phase) + 1) / 2; // 1 → 0 → 1
}

// -----------------------------------------------------------------------------
// 3) 呼吸 (絶対時刻ベースのサイン波。位相は常に同じ)
// -----------------------------------------------------------------------------
function breathValue(t: number): number {
  // 4 秒周期で 0..1 を往復
  return 0.5 + 0.5 * Math.sin((t / 4) * 2 * Math.PI);
}

// -----------------------------------------------------------------------------
// 4) 表情キーフレーム: 現時刻に該当する最後の expression を返す
// -----------------------------------------------------------------------------
function pickExpression(
  keyframes: ExpressionKeyframe[] | undefined,
  t: number,
): string | null {
  if (!keyframes || keyframes.length === 0) return null;
  let current: string | null = null;
  for (const kf of keyframes) {
    if (kf.time <= t) current = kf.expression;
    else break;
  }
  return current;
}

// -----------------------------------------------------------------------------
// 5) 母音 → (mouthOpenY, mouthForm) の標準マッピング (Phase 3 で使う想定)
//    Phase 2 ではリップシンク未実装なので口を閉じた状態にしておく。
// -----------------------------------------------------------------------------
export const VOWEL_MOUTH_SHAPES: Record<string, { openY: number; form: number }> = {
  a: { openY: 1.0, form: 0.0 },
  i: { openY: 0.3, form: 1.0 },
  u: { openY: 0.4, form: -0.5 },
  e: { openY: 0.6, form: 0.5 },
  o: { openY: 0.7, form: -0.3 },
  N: { openY: 0.05, form: 0.0 }, // 撥音
  silent: { openY: 0.0, form: 0.0 },
};

// -----------------------------------------------------------------------------
// 6) 任意パラメータの手動上書きトラック (KeyframeTrack) を時刻 t で線形補間して適用
// -----------------------------------------------------------------------------
function sampleTrack(track: { enabled: boolean; frames: { time: number; value: number }[] }, t: number, fallback: number): number {
  if (!track.enabled || track.frames.length === 0) return fallback;
  const frames = track.frames;
  if (t <= frames[0].time) return frames[0].value;
  if (t >= frames[frames.length - 1].time) return frames[frames.length - 1].value;
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    if (t >= a.time && t <= b.time) {
      const r = (t - a.time) / (b.time - a.time);
      return a.value + (b.value - a.value) * r;
    }
  }
  return fallback;
}

// -----------------------------------------------------------------------------
// メイン: tickCharacter
// -----------------------------------------------------------------------------

/**
 * 状態を持つ tick (前回の表情名を覚えておいて変化したときだけ setExpression を呼ぶ等)。
 * 1 つのキャラレイヤーごとに 1 つ生成して使い回す。
 */
export interface CharacterTickState {
  blinkSchedule: number[];
  lastExpression: string | null;
  /** Phase 3 で埋めるリップシンク用音素タイムライン。Phase 2 ではダミー */
  lipsyncSampler: ((t: number) => { openY: number; form: number }) | null;
}

export function createTickState(
  layer: Layer,
  totalDuration: number,
): CharacterTickState {
  return {
    blinkSchedule: layer.blinkConfig
      ? buildBlinkSchedule(layer.blinkConfig, totalDuration)
      : [],
    lastExpression: null,
    lipsyncSampler: null,
  };
}

/**
 * 時刻 t に対応する全パラメータをモデルに書き込み、最後に update() を呼ぶ。
 *
 * @param model         pixi-live2d-display の Live2DModel (描画 / 物理更新を呼ぶため)
 * @param cubismModel   Cubism Core ネイティブ Model (parameters.values の直接書き込み用)
 * @param paramIndex    parameter ID 文字列 → index マップ
 * @param layer         CharacterLayer 設定
 * @param paramMap      モデル読込時に検出した抽象名→実 ID マップ
 * @param t             グローバル時刻 (秒)
 * @param physicsDt     物理演算に渡す delta time (秒)。Phase 4 では 1/fps 固定、Phase 2 では実 dt
 * @param state         CharacterTickState (使い回し)
 */
export function tickCharacter(
  model: TickableModel,
  cubismModel: CubismCoreNativeModel,
  paramIndex: Record<string, number>,
  layer: Layer,
  paramMap: CubismParamMap,
  t: number,
  physicsDt: number,
  state: CharacterTickState,
): void {
  const internal = model.internalModel;

  // --- 表情切替 (キーフレーム上で前と違う場合のみ) ---
  const expr = pickExpression(layer.expressionKeyframes, t);
  if (expr !== state.lastExpression) {
    const expressionManager = internal?.motionManager?.expressionManager;
    if (expressionManager && expr) {
      try {
        expressionManager.setExpression(expr);
      } catch {
        // 表情ファイルが見つからない等は無視
      }
    }
    state.lastExpression = expr;
  }

  // --- 瞬き ---
  if (layer.blinkConfig?.enabled) {
    const open = blinkOpenness(
      state.blinkSchedule,
      t,
      layer.blinkConfig.duration,
    );
    setParam(cubismModel, paramIndex, paramMap, "eyeLOpen", open);
    setParam(cubismModel, paramIndex, paramMap, "eyeROpen", open);
  }

  // --- 呼吸 ---
  setParam(cubismModel, paramIndex, paramMap, "breath", breathValue(t));

  // --- リップシンク ---
  let mouthOpenY = 0;
  let mouthForm = 0;
  if (state.lipsyncSampler && layer.lipsyncMode !== "off") {
    const sample = state.lipsyncSampler(t);
    mouthOpenY = sample.openY;
    mouthForm = sample.form;
  }
  setParam(cubismModel, paramIndex, paramMap, "mouthOpenY", mouthOpenY);
  setParam(cubismModel, paramIndex, paramMap, "mouthForm", mouthForm);

  // --- 任意パラメータ手動上書き (paramOverrides が最優先で他を上書きする) ---
  if (layer.paramOverrides) {
    for (const [paramId, track] of Object.entries(layer.paramOverrides)) {
      if (!track) continue;
      const idx = paramIndex[paramId];
      if (idx === undefined) continue;
      const current = getParam(cubismModel, paramIndex, paramId);
      const value = sampleTrack(track, t, current);
      cubismModel.parameters.values[idx] = value;
    }
  }

  // --- 物理 / 描画更新 ---
  // pixi-live2d-display の update は ms 単位を期待する
  model.update(physicsDt * 1000);
}
