/**
 * 複数の音声レイヤーを時刻 t に応じて切り替えるコンポジット・リップシンクサンプラ。
 *
 * - 各音声レイヤーごとに query / RMS でサンプラを構築し、配列で保持
 * - サンプル時、時刻 t を含む startSec..endSec の音声を 1 つ選んで使う
 * - 重なってる場合は startSec が早い方を優先
 * - どの音声にも該当しない時刻 = 無音 (口閉じ)
 */

import type { Layer } from "../types";
import { tryBuildSamplerFromAudioLayer } from "./lipsyncFromQuery";
import { tryBuildSamplerFromAudioRms } from "./lipsyncFromRms";

type Sampler = (t: number) => { openY: number; form: number };

interface SegmentedSampler {
  startSec: number;
  endSec: number;
  sampler: Sampler;
}

/**
 * 1 音声レイヤーから lipsyncMode に応じてサンプラを作る。
 * - "voicevox" → query 優先 / RMS フォールバック
 * - "rms" → RMS のみ
 * - 失敗時は null
 */
async function buildSamplerForAudio(
  audio: Layer,
  mode: "voicevox" | "rms",
): Promise<Sampler | null> {
  if (audio.type !== "audio") return null;
  if (mode === "voicevox") {
    const s = await tryBuildSamplerFromAudioLayer(audio);
    if (s) return s;
    return await tryBuildSamplerFromAudioRms(audio);
  }
  return await tryBuildSamplerFromAudioRms(audio);
}

/**
 * 複数の音声レイヤーから 1 つのコンポジットサンプラを作る。
 * 並列でサンプラを構築するので長尺・大量音声でも初期化が遅くなりにくい。
 */
export async function buildCompositeLipsyncSampler(
  audios: Layer[],
  mode: "voicevox" | "rms",
): Promise<Sampler | null> {
  const audioLayers = audios.filter((a) => a.type === "audio" && !a.hidden);
  if (audioLayers.length === 0) return null;

  const built = await Promise.all(
    audioLayers.map(async (a) => {
      const sampler = await buildSamplerForAudio(a, mode);
      if (!sampler) return null;
      return {
        startSec: a.startSec,
        endSec: a.endSec,
        sampler,
      } as SegmentedSampler;
    }),
  );
  const valid = built.filter((x): x is SegmentedSampler => x !== null);
  if (valid.length === 0) return null;

  // startSec 早い順 (= 重なり時の優先度)
  valid.sort((a, b) => a.startSec - b.startSec);

  return (t: number) => {
    for (const seg of valid) {
      if (t >= seg.startSec && t < seg.endSec) {
        return seg.sampler(t);
      }
    }
    return { openY: 0, form: 0 };
  };
}
