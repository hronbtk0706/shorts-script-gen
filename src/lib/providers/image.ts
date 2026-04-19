import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  ImageStylePreset,
  PollinationsModel,
} from "../storage";

export interface ImageInput {
  prompt: string;
  seed: number;
  filename: string;
  sessionId: string;
}

export interface ImageProvider {
  id: string;
  label: string;
  generate(input: ImageInput, settings: AppSettings): Promise<string>;
}

const STYLE_PRESETS: Record<ImageStylePreset, string> = {
  "": "",
  kawaii:
    "kawaii, super cute, chibi style, pastel colors, soft lighting, adorable character design, ",
  anime:
    "anime style, clean lineart, vibrant colors, detailed character illustration, manga aesthetic, ",
  chibi:
    "chibi, super deformed, big head, cute expression, simple background, adorable, ",
  watercolor:
    "watercolor painting, soft brush strokes, gentle gradients, warm paper texture, artistic, ",
  picture_book:
    "children's picture book illustration, flat colors, friendly, heartwarming, storybook art style, ",
  pastel:
    "pastel colors, soft tones, dreamy atmosphere, gentle lighting, ",
  ghibli:
    "Studio Ghibli inspired, whimsical, nostalgic, soft painted background, warm palette, ",
  toon:
    "cartoon style, bold outline, flat shading, simplified shapes, playful, ",
  pixelart: "pixel art, 8-bit, retro game style, crisp pixels, ",
  realistic:
    "photorealistic, cinematic composition, 8k, highly detailed, professional photography, ",
};

export const STYLE_PRESET_OPTIONS: Array<{
  id: ImageStylePreset;
  label: string;
}> = [
  { id: "", label: "なし（そのまま）" },
  { id: "kawaii", label: "Kawaii（超可愛い・チビキャラ）" },
  { id: "anime", label: "アニメ（王道マンガ風）" },
  { id: "chibi", label: "Chibi（デフォルメ大頭身）" },
  { id: "pastel", label: "パステル（夢かわ）" },
  { id: "watercolor", label: "水彩画" },
  { id: "picture_book", label: "絵本イラスト" },
  { id: "ghibli", label: "ジブリ風（ノスタルジック）" },
  { id: "toon", label: "トゥーン（フラット・アメコミ系）" },
  { id: "pixelart", label: "ピクセルアート（8bit）" },
  { id: "realistic", label: "リアル（写真風）" },
];

function applyStylePreset(prompt: string, preset: ImageStylePreset): string {
  const prefix = STYLE_PRESETS[preset] ?? "";
  return prefix + prompt;
}

function pollinationsUrl(
  prompt: string,
  seed: number,
  model: PollinationsModel,
): string {
  const encoded = encodeURIComponent(prompt);
  return `https://image.pollinations.ai/prompt/${encoded}?width=1080&height=1920&nologo=true&seed=${seed}&model=${model}`;
}

const pollinationsProvider: ImageProvider = {
  id: "pollinations",
  label: "Pollinations.ai（無料・無制限）",
  async generate({ prompt, seed, filename, sessionId }, settings) {
    const finalPrompt = applyStylePreset(prompt, settings.imageStylePreset);
    const url = pollinationsUrl(finalPrompt, seed, settings.pollinationsModel);
    return invoke<string>("download_image", { sessionId, url, filename });
  },
};

const NSFW_RISKY_WORDS = [
  "intimate",
  "romantic",
  "sensual",
  "seductive",
  "seduce",
  "naked",
  "nude",
  "provocative",
  "passionate",
  "lingerie",
  "erotic",
  "kiss",
  "kissing",
  "embrace",
  "embracing",
  "flirtatious",
  "flirting",
  "suggestive",
  "cleavage",
  "revealing",
  "bedroom",
  "shirtless",
];

function sanitizeForCloudflare(prompt: string): string {
  const pattern = new RegExp(`\\b(${NSFW_RISKY_WORDS.join("|")})\\b`, "gi");
  const stripped = prompt
    .replace(pattern, "")
    .replace(/\s+/g, " ")
    .trim();
  return `wholesome, family friendly, tasteful illustration, non-intimate, soft expression, ${stripped}`;
}

function isCloudflareNsfwError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /NSFW|"code":\s*3030/i.test(msg);
}

async function callCloudflare(
  sessionId: string,
  accountId: string,
  apiKey: string,
  model: string,
  promptText: string,
  seed: number,
  filename: string,
): Promise<string> {
  const body: Record<string, unknown> = { prompt: promptText, seed };
  const isSdxl =
    model.includes("stable-diffusion-xl") || model.includes("dreamshaper");
  if (isSdxl) {
    body.width = 1024;
    body.height = 1536;
    body.num_steps = 8;
  } else {
    body.steps = 4;
  }

  return invoke<string>("cloudflare_generate_image", {
    sessionId,
    accountId,
    apiKey,
    model,
    bodyJson: JSON.stringify(body),
    filename,
  });
}

const cloudflareProvider: ImageProvider = {
  id: "cloudflare",
  label: "Cloudflare Workers AI（10,000/日・無料）",
  async generate({ prompt, seed, filename, sessionId }, settings) {
    if (!settings.cloudflareAccountId || !settings.cloudflareApiKey) {
      throw new Error(
        "Cloudflare のアカウントID と API キーを設定してください",
      );
    }
    const model =
      settings.cloudflareModel || "@cf/black-forest-labs/flux-1-schnell";
    const finalPrompt = applyStylePreset(prompt, settings.imageStylePreset);

    try {
      return await callCloudflare(
        sessionId,
        settings.cloudflareAccountId,
        settings.cloudflareApiKey,
        model,
        finalPrompt,
        seed,
        filename,
      );
    } catch (e) {
      if (!isCloudflareNsfwError(e)) throw e;
      const sanitized = sanitizeForCloudflare(finalPrompt);
      try {
        return await callCloudflare(
          sessionId,
          settings.cloudflareAccountId,
          settings.cloudflareApiKey,
          model,
          sanitized,
          seed,
          filename,
        );
      } catch (retryErr) {
        const msg =
          retryErr instanceof Error ? retryErr.message : String(retryErr);
        throw new Error(
          `Cloudflare NSFW フィルタで弾かれました（浄化後の再試行も失敗）。画像プロンプトを手動で編集してください。\n詳細: ${msg}`,
        );
      }
    }
  },
};

export const CLOUDFLARE_MODELS = [
  {
    id: "@cf/black-forest-labs/flux-1-schnell",
    label: "FLUX Schnell（推奨・速い・高品質）",
  },
  {
    id: "@cf/bytedance/stable-diffusion-xl-lightning",
    label: "SDXL Lightning（超速・リアル系）",
  },
  {
    id: "@cf/stabilityai/stable-diffusion-xl-base-1.0",
    label: "SDXL Base（定番・汎用）",
  },
  {
    id: "@cf/lykon/dreamshaper-8-lcm",
    label: "DreamShaper 8 LCM（イラスト・アニメ寄り）",
  },
];

export const IMAGE_PROVIDERS: Record<string, ImageProvider> = {
  pollinations: pollinationsProvider,
  cloudflare: cloudflareProvider,
};

export function getImageProvider(id: string): ImageProvider {
  return IMAGE_PROVIDERS[id] ?? pollinationsProvider;
}
