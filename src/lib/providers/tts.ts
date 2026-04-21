import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../storage";

export interface TtsInput {
  text: string;
  filename: string;
  sessionId: string;
}

export interface TtsProvider {
  id: string;
  label: string;
  synthesize(input: TtsInput, settings: AppSettings): Promise<string>;
}

const sayProvider: TtsProvider = {
  id: "say",
  label: "macOS say（無料・無制限）",
  async synthesize({ text, filename, sessionId }, settings) {
    return invoke<string>("generate_tts", {
      sessionId,
      text,
      voice: settings.sayVoice || "Kyoko",
      filename,
    });
  },
};

const edgeProvider: TtsProvider = {
  id: "edge",
  label: "Edge TTS（無料・無制限・高品質）",
  async synthesize({ text, filename, sessionId }, settings) {
    const voice = settings.edgeVoice || "ja-JP-NanamiNeural";
    return invoke<string>("edge_tts", { sessionId, text, voice, filename });
  },
};

const voicevoxProvider: TtsProvider = {
  id: "voicevox",
  label: "VOICEVOX（ローカル・キャラ声・要起動）",
  async synthesize({ text, filename, sessionId }, settings) {
    const speaker = settings.voicevoxSpeaker ?? 3;
    return invoke<string>("voicevox_tts", { sessionId, text, speaker, filename });
  },
};

const openaiProvider: TtsProvider = {
  id: "openai",
  label: "OpenAI TTS（API キー必要・有料）",
  async synthesize({ text, filename, sessionId }, settings) {
    const voice = settings.openaiTtsVoice || "alloy";
    const model = settings.openaiTtsModel || "tts-1";
    return invoke<string>("openai_tts", {
      sessionId,
      text,
      voice,
      model,
      apiKey: settings.openaiApiKey,
      filename,
    });
  },
};

const softalkProvider: TtsProvider = {
  id: "softalk",
  label: "SofTalk（ゆっくり霊夢/魔理沙・要 SofTalk.exe）",
  async synthesize({ text, filename, sessionId }, settings) {
    const voice = settings.softalkVoice ?? 0;
    const softalkPath = settings.softalkPath ?? "";
    return invoke<string>("softalk_tts", {
      sessionId,
      text,
      voice,
      filename,
      softalkPath,
    });
  },
};

export const TTS_PROVIDERS: Record<string, TtsProvider> = {
  say: sayProvider,
  edge: edgeProvider,
  voicevox: voicevoxProvider,
  openai: openaiProvider,
  softalk: softalkProvider,
};

export function getTtsProvider(id: string): TtsProvider {
  return TTS_PROVIDERS[id] ?? sayProvider;
}

export const SOFTALK_VOICES = [
  { id: 0, label: "女声1（霊夢風）" },
  { id: 1, label: "男声1（魔理沙風）" },
  { id: 2, label: "男声2" },
  { id: 3, label: "機械1" },
  { id: 4, label: "高声" },
  { id: 5, label: "低声" },
  { id: 6, label: "真面目" },
];

export const OPENAI_TTS_VOICES = [
  { id: "alloy", label: "Alloy（中性・自然）" },
  { id: "nova", label: "Nova（女性・明るい）" },
  { id: "shimmer", label: "Shimmer（女性・柔らか）" },
  { id: "echo", label: "Echo（男性・落ち着き）" },
  { id: "fable", label: "Fable（男性・英国風）" },
  { id: "onyx", label: "Onyx（男性・低音）" },
];

export const EDGE_VOICES = [
  { id: "ja-JP-NanamiNeural", label: "Nanami（女性・ナチュラル／推奨）" },
  { id: "ja-JP-KeitaNeural", label: "Keita（男性・ナチュラル）" },
  { id: "ja-JP-AoiNeural", label: "Aoi（女性・若い）" },
  { id: "ja-JP-DaichiNeural", label: "Daichi（男性・大人）" },
  { id: "ja-JP-MayuNeural", label: "Mayu（女性・明るい）" },
  { id: "ja-JP-NaokiNeural", label: "Naoki（男性・ニュース向き）" },
  { id: "ja-JP-ShioriNeural", label: "Shiori（女性・落ち着き）" },
];

export const VOICEVOX_SPEAKERS = [
  { id: 3, label: "ずんだもん（ノーマル）" },
  { id: 1, label: "ずんだもん（あまあま）" },
  { id: 7, label: "ずんだもん（ツンツン）" },
  { id: 2, label: "四国めたん（ノーマル）" },
  { id: 0, label: "四国めたん（あまあま）" },
  { id: 6, label: "四国めたん（ツンツン）" },
  { id: 8, label: "春日部つむぎ（ノーマル）" },
  { id: 10, label: "雨晴はう（ノーマル）" },
  { id: 11, label: "玄野武宏（ノーマル・男性）" },
  { id: 12, label: "白上虎太郎（ふつう・男性）" },
  { id: 13, label: "青山龍星（ノーマル・男性）" },
  { id: 14, label: "冥鳴ひまり（ノーマル）" },
  { id: 16, label: "九州そら（ノーマル）" },
  { id: 20, label: "もち子さん（ノーマル）" },
  { id: 9, label: "波音リツ（ノーマル）" },
];
