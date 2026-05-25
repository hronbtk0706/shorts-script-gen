import { LazyStore } from "@tauri-apps/plugin-store";
import { isMacOS } from "./platform";

const store = new LazyStore("settings.json");

const KEY_LLM_PROVIDER = "llm_provider";
const KEY_GEMINI_API = "gemini_api_key";
const KEY_GROQ_API = "groq_api_key";
const KEY_OPENAI_API = "openai_api_key";
const KEY_OPENAI_MODEL = "openai_model";
const KEY_TTS_PROVIDER = "tts_provider";
const KEY_SAY_VOICE = "tts_say_voice";
const KEY_EDGE_VOICE = "tts_edge_voice";
const KEY_VOICEVOX_SPEAKER = "tts_voicevox_speaker";
const KEY_OPENAI_TTS_VOICE = "tts_openai_voice";
const KEY_OPENAI_TTS_MODEL = "tts_openai_model";
const KEY_SOFTALK_PATH = "tts_softalk_path";
const KEY_SOFTALK_VOICE = "tts_softalk_voice";
const KEY_BGM_FILE_PATH = "bgm_file_path";
const KEY_PIXABAY_API_KEY = "pixabay_api_key";
const KEY_YOUTUBE_API_KEY = "youtube_api_key";
const KEY_CONTENT_NICHE = "content_niche";
const KEY_MULTI_CANDIDATE_ENABLED = "multi_candidate_enabled";
const KEY_MULTI_CANDIDATE_COUNT = "multi_candidate_count";
const KEY_REFERENCE_VIDEO_COUNT = "reference_video_count";
const KEY_DEFAULT_TEMPLATE_ID = "default_template_id";
const KEY_SE_FOLDER_PATH = "se_folder_path";
const KEY_YT_OAUTH_CLIENT_ID = "yt_oauth_client_id";
const KEY_YT_OAUTH_CLIENT_SECRET = "yt_oauth_client_secret";
const KEY_VIDEO_ENCODER = "video_encoder";
const KEY_AUTO_TEROP_FONT_SIZE = "auto_terop_font_size";
const KEY_AUTO_TEROP_FONT_COLOR = "auto_terop_font_color";
const KEY_AUTO_TEROP_OUTLINE_WIDTH = "auto_terop_outline_width";
const KEY_AUTO_TEROP_OUTLINE_COLOR = "auto_terop_outline_color";
const KEY_AUTO_TEROP_Y = "auto_terop_y";
const KEY_AUTO_TEROP_FILL_COLOR = "auto_terop_fill_color";
const KEY_AUTO_TEROP_FONT_FAMILY = "auto_terop_font_family";

export type LlmProviderId = "gemini" | "groq" | "openai";
export type TtsProviderId =
  | "say"
  | "edge"
  | "voicevox"
  | "openai"
  | "softalk";
export interface AppSettings {
  llmProvider: LlmProviderId;
  geminiApiKey: string;
  groqApiKey: string;
  openaiApiKey: string;
  openaiModel: string;
  ttsProvider: TtsProviderId;
  sayVoice: string;
  edgeVoice: string;
  voicevoxSpeaker: number;
  openaiTtsVoice: string;
  openaiTtsModel: string;
  softalkPath: string;
  softalkVoice: number;
  bgmFilePath: string;
  pixabayApiKey: string;
  youtubeApiKey: string;
  contentNiche: string;
  multiCandidateEnabled: boolean;
  multiCandidateCount: number;
  referenceVideoCount: number;
  defaultTemplateId: string;
  seFolderPath: string;
  youtubeOAuthClientId: string;
  youtubeOAuthClientSecret: string;
  /** 動画エクスポート時のエンコーダ。"libx264"=CPU, "h264_nvenc"=NVIDIA, "h264_qsv"=Intel iGPU */
  videoEncoder: "libx264" | "h264_nvenc" | "h264_qsv";
  /** 台本から自動配置するテロップのデフォルトスタイル */
  autoTeropFontSize: number;
  autoTeropFontColor: string;
  autoTeropOutlineWidth: number;
  autoTeropOutlineColor: string;
  /** 縦位置（% 0〜100、画面の上端=0/下端=100） */
  autoTeropY: number;
  /** 背景色（空文字 = 背景なし） */
  autoTeropFillColor: string;
  autoTeropFontFamily: string;
}

async function get<T>(key: string, fallback: T): Promise<T> {
  const v = await store.get<T>(key);
  return v ?? fallback;
}

export async function loadSettings(): Promise<AppSettings> {
  const rawTtsProvider = await get<string>(KEY_TTS_PROVIDER, "voicevox");
  let ttsProvider: TtsProviderId =
    rawTtsProvider === "say" ||
    rawTtsProvider === "edge" ||
    rawTtsProvider === "voicevox" ||
    rawTtsProvider === "openai" ||
    rawTtsProvider === "softalk"
      ? (rawTtsProvider as TtsProviderId)
      : "voicevox";
  if (ttsProvider === "say" && !isMacOS()) {
    ttsProvider = "voicevox";
  }
  // 一度だけ実行: 旧デフォルトで softalk を保存していたユーザを voicevox に戻す。
  // ユーザが明示的に softalk を選んでいる場合は不本意な書き換えになるが、
  // 設定モーダルからすぐ戻せる + 多くのユーザは VOICEVOX を期待しているため許容。
  // 同時に VOICEVOX のデフォルト声を「ずんだもん（ノーマル）」(speaker=3) に揃える。
  // フラグは v2 (v1 で SofTalk リセット済みでも、声のリセットを 1 回追加実行するため)
  const MIGRATION_KEY = "_migrated_voicevox_zundamon_default_v2";
  const alreadyMigrated = await get<boolean>(MIGRATION_KEY, false);
  if (!alreadyMigrated) {
    if (ttsProvider === "softalk") {
      ttsProvider = "voicevox";
      await store.set(KEY_TTS_PROVIDER, "voicevox");
    }
    await store.set(KEY_VOICEVOX_SPEAKER, 3);
    await store.set(MIGRATION_KEY, true);
  }
  const rawLlm = await get<string>(KEY_LLM_PROVIDER, "groq");
  const llmProvider: LlmProviderId =
    rawLlm === "gemini" || rawLlm === "groq" || rawLlm === "openai"
      ? (rawLlm as LlmProviderId)
      : "groq";
  return {
    llmProvider,
    geminiApiKey: await get(KEY_GEMINI_API, ""),
    groqApiKey: await get(KEY_GROQ_API, ""),
    openaiApiKey: await get(KEY_OPENAI_API, ""),
    openaiModel: await get(KEY_OPENAI_MODEL, "gpt-5-mini"),
    ttsProvider,
    sayVoice: await get(KEY_SAY_VOICE, "Kyoko"),
    edgeVoice: await get(KEY_EDGE_VOICE, "ja-JP-NanamiNeural"),
    voicevoxSpeaker: await get<number>(KEY_VOICEVOX_SPEAKER, 3),
    openaiTtsVoice: await get(KEY_OPENAI_TTS_VOICE, "alloy"),
    openaiTtsModel: await get(KEY_OPENAI_TTS_MODEL, "tts-1"),
    softalkPath: await get(KEY_SOFTALK_PATH, ""),
    softalkVoice: await get<number>(KEY_SOFTALK_VOICE, 0),
    bgmFilePath: await get(KEY_BGM_FILE_PATH, ""),
    pixabayApiKey: await get(KEY_PIXABAY_API_KEY, ""),
    youtubeApiKey: await get(KEY_YOUTUBE_API_KEY, ""),
    contentNiche: await get(KEY_CONTENT_NICHE, ""),
    multiCandidateEnabled: await get<boolean>(KEY_MULTI_CANDIDATE_ENABLED, true),
    multiCandidateCount: Math.max(
      2,
      Math.min(5, await get<number>(KEY_MULTI_CANDIDATE_COUNT, 3)),
    ),
    referenceVideoCount: Math.max(
      3,
      Math.min(10, await get<number>(KEY_REFERENCE_VIDEO_COUNT, 5)),
    ),
    defaultTemplateId: await get(KEY_DEFAULT_TEMPLATE_ID, ""),
    seFolderPath: await get(KEY_SE_FOLDER_PATH, ""),
    youtubeOAuthClientId: await get(KEY_YT_OAUTH_CLIENT_ID, ""),
    youtubeOAuthClientSecret: await get(KEY_YT_OAUTH_CLIENT_SECRET, ""),
    videoEncoder: await (async (): Promise<AppSettings["videoEncoder"]> => {
      const raw = await get<string>(KEY_VIDEO_ENCODER, "libx264");
      return raw === "h264_nvenc" || raw === "h264_qsv" || raw === "libx264"
        ? (raw as AppSettings["videoEncoder"])
        : "libx264";
    })(),
    autoTeropFontSize: await get<number>(KEY_AUTO_TEROP_FONT_SIZE, 48),
    autoTeropFontColor: await get(KEY_AUTO_TEROP_FONT_COLOR, "#FFFFFF"),
    autoTeropOutlineWidth: await get<number>(KEY_AUTO_TEROP_OUTLINE_WIDTH, 3),
    autoTeropOutlineColor: await get(KEY_AUTO_TEROP_OUTLINE_COLOR, "#000000"),
    autoTeropY: await get<number>(KEY_AUTO_TEROP_Y, 75),
    autoTeropFillColor: await get(KEY_AUTO_TEROP_FILL_COLOR, ""),
    autoTeropFontFamily: await get(KEY_AUTO_TEROP_FONT_FAMILY, ""),
  };
}

export async function saveSettings(s: AppSettings): Promise<void> {
  await store.set(KEY_LLM_PROVIDER, s.llmProvider);
  await store.set(KEY_GEMINI_API, s.geminiApiKey);
  await store.set(KEY_GROQ_API, s.groqApiKey);
  await store.set(KEY_OPENAI_API, s.openaiApiKey);
  await store.set(KEY_OPENAI_MODEL, s.openaiModel);
  await store.set(KEY_TTS_PROVIDER, s.ttsProvider);
  await store.set(KEY_SAY_VOICE, s.sayVoice);
  await store.set(KEY_EDGE_VOICE, s.edgeVoice);
  await store.set(KEY_VOICEVOX_SPEAKER, s.voicevoxSpeaker);
  await store.set(KEY_OPENAI_TTS_VOICE, s.openaiTtsVoice);
  await store.set(KEY_OPENAI_TTS_MODEL, s.openaiTtsModel);
  await store.set(KEY_SOFTALK_PATH, s.softalkPath);
  await store.set(KEY_SOFTALK_VOICE, s.softalkVoice);
  await store.set(KEY_BGM_FILE_PATH, s.bgmFilePath);
  await store.set(KEY_PIXABAY_API_KEY, s.pixabayApiKey);
  await store.set(KEY_YOUTUBE_API_KEY, s.youtubeApiKey);
  await store.set(KEY_CONTENT_NICHE, s.contentNiche);
  await store.set(KEY_MULTI_CANDIDATE_ENABLED, s.multiCandidateEnabled);
  await store.set(KEY_MULTI_CANDIDATE_COUNT, s.multiCandidateCount);
  await store.set(KEY_REFERENCE_VIDEO_COUNT, s.referenceVideoCount);
  await store.set(KEY_DEFAULT_TEMPLATE_ID, s.defaultTemplateId);
  await store.set(KEY_SE_FOLDER_PATH, s.seFolderPath);
  await store.set(KEY_YT_OAUTH_CLIENT_ID, s.youtubeOAuthClientId);
  await store.set(KEY_YT_OAUTH_CLIENT_SECRET, s.youtubeOAuthClientSecret);
  await store.set(KEY_VIDEO_ENCODER, s.videoEncoder);
  await store.set(KEY_AUTO_TEROP_FONT_SIZE, s.autoTeropFontSize);
  await store.set(KEY_AUTO_TEROP_FONT_COLOR, s.autoTeropFontColor);
  await store.set(KEY_AUTO_TEROP_OUTLINE_WIDTH, s.autoTeropOutlineWidth);
  await store.set(KEY_AUTO_TEROP_OUTLINE_COLOR, s.autoTeropOutlineColor);
  await store.set(KEY_AUTO_TEROP_Y, s.autoTeropY);
  await store.set(KEY_AUTO_TEROP_FILL_COLOR, s.autoTeropFillColor);
  await store.set(KEY_AUTO_TEROP_FONT_FAMILY, s.autoTeropFontFamily);
  await store.save();
}

export async function setDefaultTemplateId(id: string): Promise<void> {
  await store.set(KEY_DEFAULT_TEMPLATE_ID, id);
  await store.save();
}

export async function getApiKey(): Promise<string> {
  return get(KEY_GEMINI_API, "");
}

export async function setApiKey(key: string): Promise<void> {
  await store.set(KEY_GEMINI_API, key);
  await store.save();
}
