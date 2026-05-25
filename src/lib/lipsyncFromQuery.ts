/**
 * VOICEVOX の audio_query JSON から、時刻 t に対応する口形状 (mouthOpenY, mouthForm) を
 * 返すサンプラを構築する。
 *
 * 流れ:
 *   1. voicevox_tts で wav と一緒に保存された .query.json を読む
 *   2. accent_phrases[].moras[] を時系列に並べてフラットなセグメント列に変換
 *   3. 母音文字 → (openY, form) のマッピングと、セグメント間 30ms クロスフェードで
 *      自然な口の動きを作る
 *   4. 戻り値の sampler(t) は global テンプレ時刻を受け取り、その時刻の
 *      口形状を返す (audio レイヤーの startSec / playbackRate を内部で考慮)
 */

import { invoke } from "@tauri-apps/api/core";
import type { Layer } from "../types";
import { VOWEL_MOUTH_SHAPES } from "./characterTick";

// -----------------------------------------------------------------------------
// VOICEVOX audio_query の最小型定義
// -----------------------------------------------------------------------------

interface VoicevoxMora {
  text: string;
  consonant: string | null;
  consonant_length: number | null;
  vowel: string;
  vowel_length: number;
  pitch: number;
}

interface VoicevoxAccentPhrase {
  moras: VoicevoxMora[];
  accent: number;
  pause_mora: VoicevoxMora | null;
  is_interrogative?: boolean;
}

export interface VoicevoxQuery {
  accent_phrases: VoicevoxAccentPhrase[];
  speedScale: number;
  pitchScale: number;
  intonationScale: number;
  volumeScale: number;
  prePhonemeLength: number;
  postPhonemeLength: number;
  outputSamplingRate?: number;
  outputStereo?: boolean;
  kana?: string;
}

// -----------------------------------------------------------------------------
// セグメント定義: 音声ファイル内 (audio-relative) の時間軸
// -----------------------------------------------------------------------------

interface Segment {
  /** audio-relative 開始時刻 (秒) */
  tStart: number;
  /** audio-relative 終了時刻 (秒) */
  tEnd: number;
  /** 'a' | 'i' | 'u' | 'e' | 'o' | 'N' | 'silent' */
  shape: keyof typeof VOWEL_MOUTH_SHAPES;
}

// -----------------------------------------------------------------------------
// クエリパス導出: audio.wav と同じ階層・同じファイル名根に .query.json
// -----------------------------------------------------------------------------

export function deriveQueryPath(audioPath: string): string {
  const dot = audioPath.lastIndexOf(".");
  const slash = Math.max(
    audioPath.lastIndexOf("/"),
    audioPath.lastIndexOf("\\"),
  );
  if (dot < 0 || dot < slash) return audioPath + ".query.json";
  return audioPath.substring(0, dot) + ".query.json";
}

// -----------------------------------------------------------------------------
// 1) ファイル読み込み (Rust 側の read_voicevox_query 経由で sandbox 制約を迂回)
// -----------------------------------------------------------------------------

export async function loadVoicevoxQuery(
  audioPath: string,
): Promise<VoicevoxQuery | null> {
  const queryPath = deriveQueryPath(audioPath);
  try {
    const text = await invoke<string | null>("read_voicevox_query", {
      path: queryPath,
    });
    if (!text) return null;
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.accent_phrases)) return null;
    return parsed as VoicevoxQuery;
  } catch (e) {
    console.warn("[lipsyncFromQuery] loadVoicevoxQuery failed:", e);
    return null;
  }
}

// -----------------------------------------------------------------------------
// 2) クエリをフラットなセグメント列に変換
//    pre/post の無音、子音区間も「直前母音から次母音への移行」として扱う
// -----------------------------------------------------------------------------

function vowelToShape(v: string): keyof typeof VOWEL_MOUTH_SHAPES {
  switch (v) {
    case "a":
    case "A":
      return "a";
    case "i":
    case "I":
      return "i";
    case "u":
    case "U":
      return "u";
    case "e":
    case "E":
      return "e";
    case "o":
    case "O":
      return "o";
    case "N":
    case "n":
      return "N";
    // pau (pause) / cl (sokuon) / その他は無音扱い
    default:
      return "silent";
  }
}

export function buildSegments(query: VoicevoxQuery): Segment[] {
  const segs: Segment[] = [];
  // speedScale で全長を割る (VOICEVOX の規約: 出力時間 = vowel_length / speedScale 等)
  // ただし voicevox_tts で speedScale をいじっていない場合は 1.0 になる
  const scale = query.speedScale && query.speedScale > 0 ? query.speedScale : 1.0;
  const div = (x: number) => x / scale;

  let t = 0;
  // 先頭の無音
  if (query.prePhonemeLength > 0) {
    segs.push({
      tStart: t,
      tEnd: t + div(query.prePhonemeLength),
      shape: "silent",
    });
    t += div(query.prePhonemeLength);
  }

  for (const phrase of query.accent_phrases) {
    for (const mora of phrase.moras) {
      const cLen = mora.consonant_length || 0;
      const vLen = mora.vowel_length || 0;
      // 子音区間: 「無音→次母音への移行」とみなして直前 shape のままにしておく
      // (実装簡略: 子音セグメントはスキップして母音セグメントだけ作り、
      //  サンプラ側で母音境界を 30ms クロスフェードする)
      if (cLen > 0) {
        // 子音は「次の母音への準備」として、shape は直前の状態を維持。
        // 直前の最後セグメントを延長する代わりに、明示的に "silent" 扱いで挿入。
        segs.push({
          tStart: t,
          tEnd: t + div(cLen),
          shape: "silent",
        });
        t += div(cLen);
      }
      if (vLen > 0) {
        segs.push({
          tStart: t,
          tEnd: t + div(vLen),
          shape: vowelToShape(mora.vowel),
        });
        t += div(vLen);
      }
    }
    if (phrase.pause_mora) {
      const pLen =
        (phrase.pause_mora.consonant_length || 0) +
        (phrase.pause_mora.vowel_length || 0);
      if (pLen > 0) {
        segs.push({ tStart: t, tEnd: t + div(pLen), shape: "silent" });
        t += div(pLen);
      }
    }
  }

  if (query.postPhonemeLength > 0) {
    segs.push({
      tStart: t,
      tEnd: t + div(query.postPhonemeLength),
      shape: "silent",
    });
  }

  return segs;
}

// -----------------------------------------------------------------------------
// 3) サンプラ: global テンプレ時刻 t を受け、その時刻の (openY, form) を返す
// -----------------------------------------------------------------------------

const CROSSFADE_SEC = 0.04; // 母音間の 40ms クロスフェード

/**
 * @param segments     buildSegments() の結果
 * @param audioStartSec 音声レイヤーの startSec (テンプレ上での再生開始時刻)
 * @param playbackRate 音声レイヤーの playbackRate (1.0 = 等速)
 */
export function buildLipsyncSamplerFromQuery(
  segments: Segment[],
  audioStartSec: number,
  playbackRate: number,
): (t: number) => { openY: number; form: number } {
  const rate = Math.max(0.01, playbackRate);
  // セグメントが多くなりがちなので二分探索準備
  const starts = segments.map((s) => s.tStart);

  // 二分探索で「t 以下の最大の tStart の index」を返す
  function indexAtTime(audioT: number): number {
    let lo = 0;
    let hi = starts.length - 1;
    let cand = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= audioT) {
        cand = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return cand;
  }

  return (t: number) => {
    // テンプレ時刻 → 音声内相対時刻
    const audioT = (t - audioStartSec) * rate;
    if (audioT < 0) return VOWEL_MOUTH_SHAPES.silent;
    if (segments.length === 0) return VOWEL_MOUTH_SHAPES.silent;
    const last = segments[segments.length - 1];
    if (audioT >= last.tEnd) return VOWEL_MOUTH_SHAPES.silent;

    const i = indexAtTime(audioT);
    if (i < 0) return VOWEL_MOUTH_SHAPES.silent;
    const seg = segments[i];
    const cur = VOWEL_MOUTH_SHAPES[seg.shape];

    // セグメント開始から CROSSFADE_SEC は前のセグメントから線形にブレンド
    const inLocal = audioT - seg.tStart;
    if (inLocal < CROSSFADE_SEC && i > 0) {
      const prev = VOWEL_MOUTH_SHAPES[segments[i - 1].shape];
      const k = inLocal / CROSSFADE_SEC; // 0..1
      return {
        openY: prev.openY + (cur.openY - prev.openY) * k,
        form: prev.form + (cur.form - prev.form) * k,
      };
    }
    return cur;
  };
}

/** 利便関数: audio path を渡せば一気にサンプラを返す。クエリ無ければ null */
export async function tryBuildSamplerFromAudioLayer(
  audioLayer: Layer,
): Promise<((t: number) => { openY: number; form: number }) | null> {
  if (typeof audioLayer.source !== "string") return null;
  const query = await loadVoicevoxQuery(audioLayer.source);
  if (!query) return null;
  const segs = buildSegments(query);
  if (segs.length === 0) return null;
  return buildLipsyncSamplerFromQuery(
    segs,
    audioLayer.startSec,
    audioLayer.playbackRate ?? 1,
  );
}
