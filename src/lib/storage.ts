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
const KEY_IMAGE_PROVIDER = "image_provider";
const KEY_POLLINATIONS_MODEL = "pollinations_model";
const KEY_CLOUDFLARE_ACCOUNT = "cloudflare_account_id";
const KEY_CLOUDFLARE_API = "cloudflare_api_key";
const KEY_CLOUDFLARE_MODEL = "cloudflare_model";

export type LlmProviderId = "gemini" | "groq" | "openai";
export type TtsProviderId = "say" | "edge" | "voicevox";
export type ImageProviderId = "pollinations" | "cloudflare";
export type PollinationsModel = "flux" | "turbo";

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
  imageProvider: ImageProviderId;
  pollinationsModel: PollinationsModel;
  cloudflareAccountId: string;
  cloudflareApiKey: string;
  cloudflareModel: string;
}

async function get<T>(key: string, fallback: T): Promise<T> {
  const v = await store.get<T>(key);
  return v ?? fallback;
}

export async function loadSettings(): Promise<AppSettings> {
  const rawTtsProvider = await get<string>(KEY_TTS_PROVIDER, "edge");
  let ttsProvider: TtsProviderId =
    rawTtsProvider === "say" ||
    rawTtsProvider === "edge" ||
    rawTtsProvider === "voicevox"
      ? (rawTtsProvider as TtsProviderId)
      : "edge";
  if (ttsProvider === "say" && !isMacOS()) {
    ttsProvider = "edge";
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
    imageProvider: await (async (): Promise<ImageProviderId> => {
      const raw = await get<string>(KEY_IMAGE_PROVIDER, "pollinations");
      return raw === "pollinations" || raw === "cloudflare"
        ? (raw as ImageProviderId)
        : "pollinations";
    })(),
    pollinationsModel: await get<PollinationsModel>(
      KEY_POLLINATIONS_MODEL,
      "flux",
    ),
    cloudflareAccountId: await get(KEY_CLOUDFLARE_ACCOUNT, ""),
    cloudflareApiKey: await get(KEY_CLOUDFLARE_API, ""),
    cloudflareModel: await get(
      KEY_CLOUDFLARE_MODEL,
      "@cf/black-forest-labs/flux-1-schnell",
    ),
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
  await store.set(KEY_IMAGE_PROVIDER, s.imageProvider);
  await store.set(KEY_POLLINATIONS_MODEL, s.pollinationsModel);
  await store.set(KEY_CLOUDFLARE_ACCOUNT, s.cloudflareAccountId);
  await store.set(KEY_CLOUDFLARE_API, s.cloudflareApiKey);
  await store.set(KEY_CLOUDFLARE_MODEL, s.cloudflareModel);
  await store.save();
}

export async function getApiKey(): Promise<string> {
  return get(KEY_GEMINI_API, "");
}

export async function setApiKey(key: string): Promise<void> {
  await store.set(KEY_GEMINI_API, key);
  await store.save();
}
