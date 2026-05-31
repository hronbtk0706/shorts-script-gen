/**
 * ラウドネス正規化（エクスポート時 -14 LUFS）。
 *
 * 全 audio レイヤーをミックスダウンした「最終 AudioBuffer 全体」に対して 1 回だけ
 * ゲイン補正をかけ、動画間で体感音量を揃える。YouTube は再生時に約 -14 LUFS を基準に
 * ラウドネスを測り、それより大きい動画は自動で音量を下げて再生するため、エクスポート
 * 段階で -14 LUFS に揃えておくと意図どおりの音量で届く。
 *
 * 測定は ITU-R BS.1770(-4) の積分ラウドネス:
 *   K-weighting（2 段 IIR: high-shelf + RLB high-pass）→ 400ms ブロック(75% overlap) の
 *   平均二乗 → 絶対ゲート(-70 LUFS) → 相対ゲート(-10 LU) → ゲート後ブロックの加重平均。
 * これは YouTube の表示ラウドネス値とよく一致する。
 *
 * 補正は「目標 - 実測」の差分ゲインを全サンプルに乗算。ただしサンプルピークが上限
 * (既定 -1.0 dBTP) を超える場合はピーク優先でゲインを頭打ちにし、クリッピングを防ぐ。
 *
 * NOTE: これはエクスポート専用。preview の最終ミックスは存在しないので適用しない。
 */

import type { AudioNormalizeSettings } from "../types";

export const DEFAULT_TARGET_LUFS = -14;
export const DEFAULT_TRUE_PEAK_CEILING_DB = -1.0;

/** BS.1770 K-weighting フィルタ係数（48kHz 規格値）。他レートはバイリニア変換で再計算。 */
interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

// 48kHz における規格係数（ITU-R BS.1770-4 Table 1, 2）
const STAGE1_48K: BiquadCoeffs = {
  b0: 1.53512485958697,
  b1: -2.6916961894063807,
  b2: 1.1983928108862468,
  a1: -1.6906592931824103,
  a2: 0.7324807742158501,
};
const STAGE2_48K: BiquadCoeffs = {
  b0: 1.0,
  b1: -2.0,
  b2: 1.0,
  a1: -1.9900475013505913,
  a2: 0.9900722499002086,
};

/**
 * 48kHz 規格係数を任意レートへ写像する。BS.1770 のフィルタは
 * (high-shelf, high-pass) のアナログプロトタイプを 48kHz で双一次変換した離散係数なので、
 * 元のアナログ極/零を逆算してから対象レートで再離散化する。
 * 実運用では AUDIO_SAMPLE_RATE=48000 固定なので通常は STAGE*_48K がそのまま使われる。
 */
function coeffsForRate(base: BiquadCoeffs, sampleRate: number): BiquadCoeffs {
  if (Math.abs(sampleRate - 48000) < 1) return base;
  // 双一次変換の逆: 48kHz の離散係数 → アナログ s 領域 → 対象レートで再離散化。
  // ここでは極/零を z 平面から取り出し、プリワープして写像する簡易法を用いる。
  const k48 = 2 * 48000;
  // 分母 (極): a(z) = 1 + a1 z^-1 + a2 z^-2 → s 平面の係数へ
  const polesS = biquadDenToAnalog(base.a1, base.a2, k48);
  const zerosS = biquadNumToAnalog(base.b0, base.b1, base.b2, k48);
  // 対象レートで再離散化
  return analogToBiquad(zerosS, polesS, sampleRate);
}

// z 平面分母 (1, a1, a2) → アナログ分母係数 [c0,c1,c2]（s^2,s^1,s^0）
function biquadDenToAnalog(a1: number, a2: number, k: number) {
  // 双一次: z = (1 + s/k)/(1 - s/k) を 1 + a1 z^-1 + a2 z^-2 = 0 に代入し s の多項式へ
  const c2 = 1 - a1 + a2; // s^2 係数 (×1/k^2 は後で吸収)
  const c1 = 2 * (1 - a2); // s^1 係数 (×1/k)
  const c0 = 1 + a1 + a2; // s^0 係数
  return [c2 / (k * k), c1 / k, c0] as [number, number, number];
}
function biquadNumToAnalog(
  b0: number,
  b1: number,
  b2: number,
  k: number,
): [number, number, number] {
  const c2 = b0 - b1 + b2;
  const c1 = 2 * (b0 - b2);
  const c0 = b0 + b1 + b2;
  return [c2 / (k * k), c1 / k, c0];
}
function analogToBiquad(
  zeros: [number, number, number],
  poles: [number, number, number],
  sampleRate: number,
): BiquadCoeffs {
  const k = 2 * sampleRate;
  const [z2, z1, z0] = zeros;
  const [p2, p1, p0] = poles;
  // 双一次 s = k (1 - z^-1)/(1 + z^-1)
  const nb0 = z2 * k * k + z1 * k + z0;
  const nb1 = 2 * z0 - 2 * z2 * k * k;
  const nb2 = z2 * k * k - z1 * k + z0;
  const na0 = p2 * k * k + p1 * k + p0;
  const na1 = 2 * p0 - 2 * p2 * k * k;
  const na2 = p2 * k * k - p1 * k + p0;
  return {
    b0: nb0 / na0,
    b1: nb1 / na0,
    b2: nb2 / na0,
    a1: na1 / na0,
    a2: na2 / na0,
  };
}

/** Direct Form I biquad を 1 チャンネル分インプレース適用（新バッファを返す） */
function applyBiquad(input: Float32Array, c: BiquadCoeffs): Float32Array {
  const out = new Float32Array(input.length);
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 =
      c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

/**
 * BS.1770 積分ラウドネス（LUFS）を測定。無音/測定不能なら -Infinity を返す。
 */
export function measureIntegratedLufs(buffer: AudioBuffer): number {
  const sr = buffer.sampleRate;
  const stage1 = coeffsForRate(STAGE1_48K, sr);
  const stage2 = coeffsForRate(STAGE2_48K, sr);

  const numCh = buffer.numberOfChannels;
  if (numCh === 0) return -Infinity;

  // 各チャンネルに K-weighting を適用
  const weighted: Float32Array[] = [];
  for (let ch = 0; ch < numCh; ch++) {
    const data = buffer.getChannelData(ch);
    const s1 = applyBiquad(data, stage1);
    const s2 = applyBiquad(s1, stage2);
    weighted.push(s2);
  }

  // 400ms ブロック、75% overlap（step 100ms）でブロック平均二乗を算出
  const blockSize = Math.round(0.4 * sr);
  const stepSize = Math.round(0.1 * sr);
  const len = weighted[0].length;
  if (len < blockSize) return -Infinity;

  // チャンネル加重（L/R は 1.0）。BS.1770 のサラウンド重みは今回扱わない。
  const channelWeight = 1.0;

  // 各ブロックの加重平均二乗とブロックラウドネス
  const blockMeanSq: number[] = [];
  for (let start = 0; start + blockSize <= len; start += stepSize) {
    let sumWeighted = 0;
    for (let ch = 0; ch < numCh; ch++) {
      const w = weighted[ch];
      let sumSq = 0;
      for (let i = start; i < start + blockSize; i++) {
        const v = w[i];
        sumSq += v * v;
      }
      sumWeighted += channelWeight * (sumSq / blockSize);
    }
    blockMeanSq.push(sumWeighted);
  }
  if (blockMeanSq.length === 0) return -Infinity;

  const loudnessOf = (meanSq: number) =>
    meanSq > 0 ? -0.691 + 10 * Math.log10(meanSq) : -Infinity;

  // 絶対ゲート: ブロックラウドネス >= -70 LUFS
  const absGated = blockMeanSq.filter((ms) => loudnessOf(ms) >= -70);
  if (absGated.length === 0) return -Infinity;

  // 相対ゲート閾値 = (絶対ゲート後平均のラウドネス) - 10 LU
  const meanAbs =
    absGated.reduce((a, b) => a + b, 0) / absGated.length;
  const relThreshold = loudnessOf(meanAbs) - 10;

  const relGated = blockMeanSq.filter(
    (ms) => loudnessOf(ms) >= relThreshold,
  );
  if (relGated.length === 0) return -Infinity;

  const meanRel = relGated.reduce((a, b) => a + b, 0) / relGated.length;
  return loudnessOf(meanRel);
}

/** 全チャンネルを通したサンプルピーク（線形振幅）を返す */
export function measureSamplePeak(buffer: AudioBuffer): number {
  let peak = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

const dbToLinear = (db: number) => Math.pow(10, db / 20);

export interface NormalizeResult {
  applied: boolean;
  measuredLufs: number;
  appliedGainDb: number;
  /** ピーク上限に当たってゲインが制限されたか */
  peakLimited: boolean;
}

/**
 * 最終ミックスバッファを目標 LUFS に正規化（インプレースで全サンプルにゲイン乗算）。
 *
 * - 目標との差分ゲインを算出
 * - そのゲイン適用後にサンプルピークが上限(dBTP)を超えるなら、超えない範囲までゲインを下げる
 *   （ピーク優先。リミッタで潰すより自然。§6.3）
 * - 無音/測定不能ならゲインを掛けずそのまま返す
 */
export function normalizeLoudness(
  buffer: AudioBuffer,
  settings: AudioNormalizeSettings,
): NormalizeResult {
  const targetLufs = settings.targetLufs ?? DEFAULT_TARGET_LUFS;
  const ceilingDb = settings.truePeakCeilingDb ?? DEFAULT_TRUE_PEAK_CEILING_DB;

  const measuredLufs = measureIntegratedLufs(buffer);
  if (!Number.isFinite(measuredLufs)) {
    return {
      applied: false,
      measuredLufs,
      appliedGainDb: 0,
      peakLimited: false,
    };
  }

  let gainDb = targetLufs - measuredLufs;

  // ピーク頭打ち: 適用後ピーク = peak * 10^(gainDb/20) <= ceiling
  const peak = measureSamplePeak(buffer);
  let peakLimited = false;
  if (peak > 0) {
    const ceilingLinear = dbToLinear(ceilingDb);
    const maxGainLinear = ceilingLinear / peak;
    const maxGainDb = 20 * Math.log10(maxGainLinear);
    if (gainDb > maxGainDb) {
      gainDb = maxGainDb;
      peakLimited = true;
    }
  }

  // ゲインがほぼ 0 なら何もしない
  if (Math.abs(gainDb) < 0.01) {
    return {
      applied: false,
      measuredLufs,
      appliedGainDb: 0,
      peakLimited,
    };
  }

  const gainLinear = dbToLinear(gainDb);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      data[i] *= gainLinear;
    }
  }

  return { applied: true, measuredLufs, appliedGainDb: gainDb, peakLimited };
}
