/**
 * 音声ファイルの振幅 (RMS) からリップシンクサンプラを構築する。
 * VOICEVOX query が無い音源 (Edge TTS / OpenAI TTS / 録音) 用フォールバック。
 *
 * - 母音判別はできないので mouthForm は 0 固定、mouthOpenY だけ振幅で駆動する
 * - 50ms 窓で RMS を取り、最大値で正規化、attack/release を軽くかけて自然な開閉に
 * - 同じ source は一度デコードしてキャッシュする
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import type { Layer } from "../types";

const WINDOW_SEC = 0.05; // 50ms
const ATTACK_SEC = 0.04;
const RELEASE_SEC = 0.12;
const MAX_OPEN = 1.0;

interface RmsTrack {
  /** 各 bin の正規化後 openY (0..1) */
  values: Float32Array;
  /** bin 1 つあたりの秒数 */
  binSec: number;
  /** 元音声の総尺 (秒) */
  durationSec: number;
}

const trackCache = new Map<string, RmsTrack>();
const inflight = new Map<string, Promise<RmsTrack | null>>();

function resolveAudioUrl(source: string): string {
  if (
    source.startsWith("http://") ||
    source.startsWith("https://") ||
    source.startsWith("data:") ||
    source.startsWith("blob:")
  ) {
    return source;
  }
  return convertFileSrc(source);
}

export async function loadRmsTrack(source: string): Promise<RmsTrack | null> {
  const cached = trackCache.get(source);
  if (cached) return cached;
  const running = inflight.get(source);
  if (running) return running;

  const task = (async (): Promise<RmsTrack | null> => {
    try {
      const url = resolveAudioUrl(source);
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      const AC =
        (window as unknown as { AudioContext?: typeof AudioContext })
          .AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AC) return null;
      const ctx = new AC();
      try {
        const audio = await ctx.decodeAudioData(buf.slice(0));
        const sampleRate = audio.sampleRate;
        const ch = audio.getChannelData(0);
        const samplesPerBin = Math.max(1, Math.floor(WINDOW_SEC * sampleRate));
        const binCount = Math.ceil(ch.length / samplesPerBin);
        const raw = new Float32Array(binCount);

        // RMS 計算
        let peak = 0;
        for (let i = 0; i < binCount; i++) {
          const start = i * samplesPerBin;
          const end = Math.min(start + samplesPerBin, ch.length);
          let sumSq = 0;
          for (let j = start; j < end; j++) {
            const v = ch[j];
            sumSq += v * v;
          }
          const rms = Math.sqrt(sumSq / (end - start));
          raw[i] = rms;
          if (rms > peak) peak = rms;
        }

        // ピーク正規化 (静かな音声でも口が開くように)
        const norm = peak > 1e-6 ? 1 / peak : 1;
        for (let i = 0; i < binCount; i++) {
          // 0.05 以下の超小音量はノイズ扱いにして 0 に近づける
          let v = raw[i] * norm;
          if (v < 0.05) v *= 0.2;
          raw[i] = Math.min(MAX_OPEN, v);
        }

        // attack / release エンベロープ (人間の口の動きに近づける)
        const binSec = samplesPerBin / sampleRate;
        const attackCoef = Math.min(1, binSec / ATTACK_SEC);
        const releaseCoef = Math.min(1, binSec / RELEASE_SEC);
        let env = 0;
        const smoothed = new Float32Array(binCount);
        for (let i = 0; i < binCount; i++) {
          const target = raw[i];
          if (target > env) env += (target - env) * attackCoef;
          else env += (target - env) * releaseCoef;
          smoothed[i] = env;
        }

        const track: RmsTrack = {
          values: smoothed,
          binSec,
          durationSec: ch.length / sampleRate,
        };
        trackCache.set(source, track);
        return track;
      } finally {
        try {
          ctx.close();
        } catch {
          /* noop */
        }
      }
    } catch (e) {
      console.warn("[lipsyncFromRms] loadRmsTrack failed:", e);
      return null;
    } finally {
      inflight.delete(source);
    }
  })();

  inflight.set(source, task);
  return task;
}

/**
 * @param track       loadRmsTrack の結果
 * @param audioStartSec audio レイヤーの startSec
 * @param playbackRate audio レイヤーの playbackRate
 */
export function buildLipsyncSamplerFromRms(
  track: RmsTrack,
  audioStartSec: number,
  playbackRate: number,
): (t: number) => { openY: number; form: number } {
  const rate = Math.max(0.01, playbackRate);
  const { values, binSec, durationSec } = track;
  return (t: number) => {
    const audioT = (t - audioStartSec) * rate;
    if (audioT < 0 || audioT >= durationSec) {
      return { openY: 0, form: 0 };
    }
    // 線形補間で滑らかに
    const idx = audioT / binSec;
    const i = Math.floor(idx);
    const frac = idx - i;
    const a = values[i] ?? 0;
    const b = values[i + 1] ?? a;
    const openY = a + (b - a) * frac;
    return { openY, form: 0 };
  };
}

export async function tryBuildSamplerFromAudioRms(
  audioLayer: Layer,
): Promise<((t: number) => { openY: number; form: number }) | null> {
  if (typeof audioLayer.source !== "string") return null;
  const track = await loadRmsTrack(audioLayer.source);
  if (!track) return null;
  return buildLipsyncSamplerFromRms(
    track,
    audioLayer.startSec,
    audioLayer.playbackRate ?? 1,
  );
}
