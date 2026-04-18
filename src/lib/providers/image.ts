import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, PollinationsModel } from "../storage";

export interface ImageInput {
  prompt: string;
  seed: number;
  filename: string;
}

export interface ImageProvider {
  id: string;
  label: string;
  generate(input: ImageInput, settings: AppSettings): Promise<string>;
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
  async generate({ prompt, seed, filename }, settings) {
    const url = pollinationsUrl(prompt, seed, settings.pollinationsModel);
    return invoke<string>("download_image", { url, filename });
  },
};

const cloudflareProvider: ImageProvider = {
  id: "cloudflare",
  label: "Cloudflare Workers AI（10,000/日・無料）",
  async generate({ prompt, seed, filename }, settings) {
    if (!settings.cloudflareAccountId || !settings.cloudflareApiKey) {
      throw new Error(
        "Cloudflare のアカウントID と API キーを設定してください",
      );
    }
    const model =
      settings.cloudflareModel || "@cf/black-forest-labs/flux-1-schnell";

    const body: Record<string, unknown> = { prompt, seed };
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
      accountId: settings.cloudflareAccountId,
      apiKey: settings.cloudflareApiKey,
      model,
      bodyJson: JSON.stringify(body),
      filename,
    });
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
