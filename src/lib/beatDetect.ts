import { convertFileSrc } from "@tauri-apps/api/core";
import type { Keyframe } from "../types";

/**
 * 音ハメ（#8）: 音声の「拍（オンセット＝音量が急に立ち上がる瞬間）」を検出し、
 * レイヤーのキーフレームへ自動で書き込むための解析ユーティリティ。
 *
 * 設計方針:
 * - FFT テンポ推定は重く不正確なので採らない。短窓エネルギーの「正の増分（flux）」を
 *   適応閾値でピーク検出する、決定論的でシンプルな onset 検出にする。
 * - 同じ音源・同じパラメータなら毎回同じ拍列を返す（純粋なサンプル演算）。
 * - 出力は「音源先頭からの相対秒」配列。タイムライン配置（startSec/playbackRate）は
 *   呼び出し側で global 時刻に換算する。
 */

const decodeCache = new Map<string, { sampleRate: number; data: Float32Array }>();
const inflight = new Map<string, Promise<{ sampleRate: number; data: Float32Array }>>();

async function decodeMono(source: string): Promise<{ sampleRate: number; data: Float32Array }> {
  const cached = decodeCache.get(source);
  if (cached) return cached;
  const running = inflight.get(source);
  if (running) return running;

  const task = (async () => {
    try {
      const url =
        source.startsWith("http://") ||
        source.startsWith("https://") ||
        source.startsWith("data:") ||
        source.startsWith("blob:")
          ? source
          : convertFileSrc(source);
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      const AC =
        (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) throw new Error("AudioContext not supported");
      const ctx = new AC();
      try {
        const audio = await ctx.decodeAudioData(buf.slice(0));
        // モノラル化（全 ch 平均）。決定論。
        const len = audio.length;
        const mono = new Float32Array(len);
        const chN = audio.numberOfChannels;
        for (let c = 0; c < chN; c++) {
          const ch = audio.getChannelData(c);
          for (let i = 0; i < len; i++) mono[i] += ch[i] / chN;
        }
        const out = { sampleRate: audio.sampleRate, data: mono };
        decodeCache.set(source, out);
        return out;
      } finally {
        try {
          ctx.close();
        } catch {
          /* noop */
        }
      }
    } finally {
      inflight.delete(source);
    }
  })();

  inflight.set(source, task);
  return task;
}

export interface BeatDetectOptions {
  /** 感度 0..1（既定 0.5）。大きいほど多くの拍を拾う（閾値を下げる）。 */
  sensitivity?: number;
  /** 拍の最小間隔（秒・既定 0.2）。これ未満の連続検出は 1 つに間引く。 */
  minIntervalSec?: number;
}

/**
 * 音源先頭からの拍時刻（秒）配列を返す。
 * 短窓エネルギーの「正の増分(flux)」に対し、
 *  (1) ±0.07s の厳密な局所最大であること（密な小山を 1 つに）
 *  (2) 局所平均 + k×局所標準偏差 を超えること（持続音楽で拾い過ぎないよう std ベース）
 *  (3) 最小間隔を満たすこと
 * の 3 条件でピーク検出する。決定論（純サンプル演算）。
 * ※ ドキュメンタリー系など持続的な音楽で過検出しないよう、平均比ではなく std ベース
 *    閾値 + 窓内最大ピッキングを採用（単純な平均比だと毎秒 5〜7 拍に膨らむ）。
 */
export async function detectBeats(
  source: string,
  opts: BeatDetectOptions = {},
): Promise<number[]> {
  const sensitivity = Math.max(0, Math.min(1, opts.sensitivity ?? 0.5));
  const minInterval = Math.max(0.05, opts.minIntervalSec ?? 0.2);
  const { sampleRate, data } = await decodeMono(source);

  const hop = 512; // フレーム間隔（≒ sampleRate/512 fps）
  const win = 1024; // エネルギー窓
  const nFrames = Math.max(1, Math.floor((data.length - win) / hop));
  if (nFrames < 4) return [];

  // 1) 短窓 RMS エネルギー
  const energy = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const start = f * hop;
    let sum = 0;
    for (let i = 0; i < win; i++) {
      const v = data[start + i];
      sum += v * v;
    }
    energy[f] = Math.sqrt(sum / win);
  }

  // 2) 正の増分 flux（立ち上がりだけ拾う）
  const flux = new Float32Array(nFrames);
  for (let f = 1; f < nFrames; f++) {
    const d = energy[f] - energy[f - 1];
    flux[f] = d > 0 ? d : 0;
  }

  // 3) 局所最大ピッキング + (局所平均 + k×標準偏差) 閾値
  const fps = sampleRate / hop;
  const Wm = Math.max(2, Math.round(fps * 0.07)); // ±0.07s: 局所最大の判定窓
  const Wt = Math.max(4, Math.round(fps * 0.4)); // ±0.4s: 適応閾値の窓
  // sensitivity 0→1 を std 係数 3.2→0.6 に（高感度ほど閾値が低い）
  const k = 3.2 - 2.6 * sensitivity;
  const minGapFrames = Math.max(1, Math.round(minInterval * fps));

  const beats: number[] = [];
  let lastBeatFrame = -Infinity;
  for (let f = 1; f < nFrames - 1; f++) {
    // (1) ±Wm の厳密な局所最大か
    let isMax = true;
    for (let j = Math.max(0, f - Wm); j <= Math.min(nFrames - 1, f + Wm); j++) {
      if (flux[j] > flux[f]) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    // (2) 適応閾値: 局所平均 + k×局所標準偏差
    let mean = 0;
    let cnt = 0;
    for (let j = Math.max(0, f - Wt); j <= Math.min(nFrames - 1, f + Wt); j++) {
      mean += flux[j];
      cnt++;
    }
    mean /= cnt;
    let varSum = 0;
    for (let j = Math.max(0, f - Wt); j <= Math.min(nFrames - 1, f + Wt); j++) {
      const d = flux[j] - mean;
      varSum += d * d;
    }
    const std = Math.sqrt(varSum / cnt);
    const thr = mean + k * std;
    // (3) 閾値超え かつ 最小間隔
    if (flux[f] > thr && f - lastBeatFrame >= minGapFrames) {
      beats.push((f * hop) / sampleRate);
      lastBeatFrame = f;
    }
  }
  return beats;
}

export interface PulseOptions {
  /** ピーク時の scale（既定 1.15）。 */
  peak?: number;
  /** 立ち上がり秒（拍の手前・既定 0.05）。 */
  attackSec?: number;
  /** 戻り秒（拍の後・既定 0.18。次の拍までの間隔の 80% で頭打ち）。 */
  decaySec?: number;
}

/**
 * global 時刻の拍配列から scale パルスのキーフレームを組む。
 * 各拍 tb で 1 →(tb)→ peak →(tb+decay)→ 1 の山を作る。連続パルスは間で 1.0 に戻る。
 * - window [startSec, endSec] 内の拍だけ採用（対象レイヤーの生存区間でクランプ）。
 * - 時刻は厳密に増加するよう整える（重なりは間引き）。linear 補間前提。
 */
export function buildScalePulseKeyframes(
  globalBeatTimes: number[],
  window: { startSec: number; endSec: number },
  opts: PulseOptions = {},
): Keyframe[] {
  const peak = opts.peak ?? 1.15;
  const attack = Math.max(0.01, opts.attackSec ?? 0.05);
  const decay = Math.max(0.02, opts.decaySec ?? 0.18);

  const beats = globalBeatTimes
    .filter((t) => t >= window.startSec && t <= window.endSec)
    .sort((a, b) => a - b);
  if (beats.length === 0) return [];

  const frames: Keyframe[] = [];
  const push = (time: number, value: number) => {
    const last = frames[frames.length - 1];
    if (last && time <= last.time) {
      // 直前と同時刻以前なら上書き（重なり対策）。より強い値を優先。
      if (value > last.value) last.value = value;
      return;
    }
    frames.push({ time, value });
  };

  // 先頭は基準 1.0 から
  push(Math.max(window.startSec, beats[0] - attack), 1);
  for (let i = 0; i < beats.length; i++) {
    const tb = beats[i];
    const next = i + 1 < beats.length ? beats[i + 1] : Infinity;
    const gap = next - tb;
    const dec = Math.min(decay, gap * 0.8); // 次の拍に食い込まない
    push(Math.max(window.startSec, tb - attack), 1);
    push(tb, peak);
    push(Math.min(window.endSec, tb + dec), 1);
  }
  return frames;
}
