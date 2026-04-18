import { GoogleGenAI, Type } from "@google/genai";
import type { Script, ScriptInput, Platform } from "../../types";
import { withRetry } from "../retry";
import type { AppSettings } from "../storage";

export interface TopicSuggestion {
  topic: string;
  reason: string;
  hashtags: string[];
}

export interface TopicSuggestInput {
  platform: Platform;
  category?: string;
  count?: number;
}

export interface LlmProvider {
  id: string;
  label: string;
  generateScript(input: ScriptInput, settings: AppSettings): Promise<Script>;
  suggestTopics(
    input: TopicSuggestInput,
    settings: AppSettings,
  ): Promise<TopicSuggestion[]>;
}

function buildTopicPrompt(input: TopicSuggestInput): string {
  const count = input.count ?? 5;
  const platform =
    input.platform === "tiktok"
      ? "TikTok"
      : input.platform === "reels"
        ? "Instagram Reels"
        : "YouTube Shorts";
  const lines = [
    "あなたはショート動画のトレンド分析家です。バズりやすいトピックを提案してください。",
    "",
    "# 条件",
    `- プラットフォーム: ${platform}`,
    `- 提案数: ${count}個`,
  ];
  if (input.category) {
    lines.push(`- カテゴリ・方向性: ${input.category}`);
  } else {
    lines.push("- カテゴリ: おまかせ（幅広く多様性のあるジャンルから）");
  }
  lines.push(
    "",
    "# 指示",
    "- 視聴維持率の高いフック力のあるトピック",
    "- 数字・具体性・感情を刺激する言葉を使う",
    "- 「知らないと損する」「〇〇の人がやってる」「【悲報】」のようなパターンは定番だが多用しない",
    "- バリエーションを持たせる（教育系・エンタメ系・共感系・ハウツー系を混ぜる）",
    "- ハッシュタグは日本語+英語で5〜7個",
    "",
    "# 出力形式（JSON）",
    `{
  "topics": [
    {
      "topic": "トピックタイトル（20字以内）",
      "reason": "なぜバズるか（40字程度）",
      "hashtags": ["#タグ1", "#tag2"]
    }
  ]
}`,
  );
  return lines.join("\n");
}

const platformLabel = {
  tiktok: "TikTok",
  reels: "Instagram Reels",
  shorts: "YouTube Shorts",
} as const;

const toneLabel = {
  casual: "カジュアル・親しみやすい",
  educational: "教育・解説系",
  emotional: "感動・共感系",
  viral: "バズ狙い・フック強め",
  serious: "真面目・ビジネス",
} as const;

function buildPromptBody(input: ScriptInput): string {
  const lines = [
    `あなたはショート動画の構成作家 兼 モーショングラフィックデザイナーです。以下の条件で${platformLabel[input.platform]}向けの${input.duration}秒動画台本を日本語で作成し、各シーンに映えるテロップのデザインと演出も提案してください。`,
    "",
    "# トピック",
    input.topic,
    "",
    "# 条件",
    `- プラットフォーム: ${platformLabel[input.platform]}`,
    `- 尺: ${input.duration}秒`,
  ];
  if (input.audience) lines.push(`- ターゲット層: ${input.audience}`);
  if (input.tone) lines.push(`- トーン: ${toneLabel[input.tone]}`);
  if (input.goal) lines.push(`- 目的: ${input.goal}`);
  if (input.reference) lines.push(`- 参考: ${input.reference}`);

  lines.push(
    "",
    "# 指示",
    "- 最初の3秒で視聴者を引き込むフックを作る",
    "- 秒数配分は合計が指定尺に収まるようにする",
    "- ナレーションは口語で、テロップは短く印象的に（20字以内）",
    "- ハッシュタグは5〜10個、日本語と英語を織り交ぜる",
    "",
    "# 画像プロンプト指示",
    "- 各シーンの image_prompt は英語で1文。Pollinations/Flux で縦型動画用画像を生成する",
    "- 必須含有: 'vertical 9:16', 'vibrant', 'cinematic', 'high detail'",
    "- 被写体は画面中央、背景は情景を描写",
    "",
    "# テロップ・デザイン指示",
    "- theme_vibe（全体の雰囲気）を最初に決めて、それに合うカラーパレットを選ぶ",
    "- 各シーンの subtitle_style は theme_vibe と一貫性を保ちつつ、シーンの意味・感情に応じて変化させる",
    "- primary_color は背景に対して高コントラストで目立つ色（例: ポップなら #FFE600 #FF3366 #00E1FF）",
    "- emoji はシーンの内容に合うもの1つ（驚き=⚡️, NG=⚠️, OK=✨, 本=📖, 時間=⏰, 重要=🔥 など）",
    "- emphasis_keyword は text_overlay 内の最も強調すべき短い部分（数字・キーワード）",
    "",
    "# エフェクト指示",
    "- motion: 静止画に動きを付ける。盛り上がり→zoom_in、落ち着き→ken_burns/static、広がり→pan系",
    "- color: 過去→sepia、シリアス→bw、レトロ→vintage、ポップ→vivid、近未来→cool、温かみ→warm、ドラマチック→vignette、通常→none",
    "- audio_fade_in: 最初のシーン（hook）のみ true、それ以外は false",
    "- audio_fade_out: 最後のシーン（cta）のみ true、それ以外は false",
    "- transition_to_next: テンポ速い→cut、滑らか→fade/dissolve、章切替→fadeblack、意外性→slide系/zoomin/circleopen。最後は必ず cut",
    "- transition_duration: 0.3〜0.8秒、cutなら 0",
  );
  return lines.join("\n");
}

// ─────────────────────────────────────────
// Gemini Provider
// ─────────────────────────────────────────

const subtitleStyleSchema = {
  type: Type.OBJECT,
  properties: {
    primary_color: { type: Type.STRING },
    outline_color: { type: Type.STRING },
    font_size: { type: Type.STRING, enum: ["md", "lg", "xl"] },
    emoji: { type: Type.STRING },
    background: { type: Type.STRING, enum: ["none", "dark", "highlight"] },
    emphasis_keyword: { type: Type.STRING },
  },
  required: [
    "primary_color",
    "outline_color",
    "font_size",
    "emoji",
    "background",
    "emphasis_keyword",
  ],
  propertyOrdering: [
    "primary_color",
    "outline_color",
    "font_size",
    "emoji",
    "background",
    "emphasis_keyword",
  ],
};

const effectsSchema = {
  type: Type.OBJECT,
  properties: {
    motion: {
      type: Type.STRING,
      enum: [
        "static",
        "zoom_in",
        "zoom_out",
        "pan_left",
        "pan_right",
        "pan_up",
        "pan_down",
        "ken_burns",
      ],
    },
    color: {
      type: Type.STRING,
      enum: [
        "none",
        "sepia",
        "bw",
        "vintage",
        "vivid",
        "cool",
        "warm",
        "vignette",
      ],
    },
    audio_fade_in: { type: Type.BOOLEAN },
    audio_fade_out: { type: Type.BOOLEAN },
    transition_to_next: {
      type: Type.STRING,
      enum: [
        "cut",
        "fade",
        "fadeblack",
        "fadewhite",
        "slideleft",
        "slideright",
        "slideup",
        "slidedown",
        "dissolve",
        "zoomin",
        "circleopen",
        "circleclose",
        "wipeleft",
        "wiperight",
        "pixelize",
        "smoothleft",
        "radial",
      ],
    },
    transition_duration: { type: Type.NUMBER },
  },
  required: [
    "motion",
    "color",
    "audio_fade_in",
    "audio_fade_out",
    "transition_to_next",
    "transition_duration",
  ],
  propertyOrdering: [
    "motion",
    "color",
    "audio_fade_in",
    "audio_fade_out",
    "transition_to_next",
    "transition_duration",
  ],
};

const geminiResponseSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    theme_vibe: { type: Type.STRING },
    hook: {
      type: Type.OBJECT,
      properties: {
        seconds: { type: Type.STRING },
        text: { type: Type.STRING },
        visual: { type: Type.STRING },
        image_prompt: { type: Type.STRING },
        subtitle_style: subtitleStyleSchema,
        effects: effectsSchema,
      },
      required: [
        "seconds",
        "text",
        "visual",
        "image_prompt",
        "subtitle_style",
        "effects",
      ],
      propertyOrdering: [
        "seconds",
        "text",
        "visual",
        "image_prompt",
        "subtitle_style",
        "effects",
      ],
    },
    body: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          seconds: { type: Type.STRING },
          narration: { type: Type.STRING },
          visual: { type: Type.STRING },
          image_prompt: { type: Type.STRING },
          text_overlay: { type: Type.STRING },
          subtitle_style: subtitleStyleSchema,
          effects: effectsSchema,
        },
        required: [
          "seconds",
          "narration",
          "visual",
          "image_prompt",
          "text_overlay",
          "subtitle_style",
          "effects",
        ],
        propertyOrdering: [
          "seconds",
          "narration",
          "visual",
          "image_prompt",
          "text_overlay",
          "subtitle_style",
          "effects",
        ],
      },
    },
    cta: {
      type: Type.OBJECT,
      properties: {
        seconds: { type: Type.STRING },
        text: { type: Type.STRING },
        image_prompt: { type: Type.STRING },
        subtitle_style: subtitleStyleSchema,
        effects: effectsSchema,
      },
      required: [
        "seconds",
        "text",
        "image_prompt",
        "subtitle_style",
        "effects",
      ],
      propertyOrdering: [
        "seconds",
        "text",
        "image_prompt",
        "subtitle_style",
        "effects",
      ],
    },
    hashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
    bgm_mood: { type: Type.STRING },
  },
  required: [
    "title",
    "theme_vibe",
    "hook",
    "body",
    "cta",
    "hashtags",
    "bgm_mood",
  ],
  propertyOrdering: [
    "title",
    "theme_vibe",
    "hook",
    "body",
    "cta",
    "hashtags",
    "bgm_mood",
  ],
};

const topicSuggestSchema = {
  type: Type.OBJECT,
  properties: {
    topics: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          topic: { type: Type.STRING },
          reason: { type: Type.STRING },
          hashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ["topic", "reason", "hashtags"],
        propertyOrdering: ["topic", "reason", "hashtags"],
      },
    },
  },
  required: ["topics"],
  propertyOrdering: ["topics"],
};

const geminiProvider: LlmProvider = {
  id: "gemini",
  label: "Gemini 2.5 Flash Lite（20/日・日本語◎）",
  async generateScript(input, settings) {
    if (!settings.geminiApiKey) {
      throw new Error("Gemini API キーが設定されていません");
    }
    const ai = new GoogleGenAI({ apiKey: settings.geminiApiKey });
    const response = await withRetry(
      () =>
        ai.models.generateContent({
          model: "gemini-2.5-flash-lite",
          contents: buildPromptBody(input),
          config: {
            responseMimeType: "application/json",
            responseSchema: geminiResponseSchema,
            temperature: 0.9,
          },
        }),
      { label: "gemini.generateScript" },
    );
    const text = response.text;
    if (!text) throw new Error("Geminiから応答が得られませんでした");
    return JSON.parse(text) as Script;
  },
  async suggestTopics(input, settings) {
    if (!settings.geminiApiKey) {
      throw new Error("Gemini API キーが設定されていません");
    }
    const ai = new GoogleGenAI({ apiKey: settings.geminiApiKey });
    const response = await withRetry(
      () =>
        ai.models.generateContent({
          model: "gemini-2.5-flash-lite",
          contents: buildTopicPrompt(input),
          config: {
            responseMimeType: "application/json",
            responseSchema: topicSuggestSchema,
            temperature: 1.0,
          },
        }),
      { label: "gemini.suggestTopics" },
    );
    const text = response.text;
    if (!text) throw new Error("Geminiから応答が得られませんでした");
    const parsed = JSON.parse(text) as { topics: TopicSuggestion[] };
    return parsed.topics;
  },
};

// ─────────────────────────────────────────
// Groq Provider (OpenAI-compatible)
// ─────────────────────────────────────────

const JSON_TEMPLATE = `{
  "title": "string",
  "theme_vibe": "string",
  "hook": {
    "seconds": "0-3s",
    "text": "string",
    "visual": "string (日本語)",
    "image_prompt": "string (英語, 'vertical 9:16, vibrant, cinematic, high detail' を含む)",
    "subtitle_style": {
      "primary_color": "#RRGGBB",
      "outline_color": "#RRGGBB",
      "font_size": "md|lg|xl",
      "emoji": "🔥",
      "background": "none|dark|highlight",
      "emphasis_keyword": "string"
    },
    "effects": {
      "motion": "static|zoom_in|zoom_out|pan_left|pan_right|pan_up|pan_down|ken_burns",
      "color": "none|sepia|bw|vintage|vivid|cool|warm|vignette",
      "audio_fade_in": true,
      "audio_fade_out": false,
      "transition_to_next": "cut|fade|fadeblack|fadewhite|slideleft|slideright|slideup|slidedown|dissolve|zoomin|circleopen|circleclose|wipeleft|wiperight|pixelize|smoothleft|radial",
      "transition_duration": 0.5
    }
  },
  "body": [
    {
      "seconds": "3-10s",
      "narration": "string",
      "visual": "string (日本語)",
      "image_prompt": "string (英語)",
      "text_overlay": "string (20字以内)",
      "subtitle_style": { "...subtitle_style と同じ構造..." },
      "effects": { "...effects と同じ構造..." }
    }
  ],
  "cta": {
    "seconds": "55-60s",
    "text": "string",
    "image_prompt": "string (英語)",
    "subtitle_style": { "..." },
    "effects": { "..., audio_fade_out: true, transition_to_next: \\"cut\\"" }
  },
  "hashtags": ["#タグ1", "#tag2"],
  "bgm_mood": "string"
}`;

async function callGroq(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  label: string,
  maxTokens = 6000,
): Promise<string> {
  const res = await withRetry(
    () =>
      fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          response_format: { type: "json_object" },
          temperature: 0.85,
          max_tokens: maxTokens,
        }),
      }).then(async (r) => {
        if (!r.ok) {
          const err = await r.text();
          throw new Error(`Groq ${r.status}: ${err.slice(0, 300)}`);
        }
        return r.json();
      }),
    { label },
  );
  const content = res?.choices?.[0]?.message?.content as string | undefined;
  if (!content) throw new Error("Groqから応答が得られませんでした");
  return content;
}

const groqProvider: LlmProvider = {
  id: "groq",
  label: "Groq Llama 3.3 70B（14,400/日・爆速）",
  async generateScript(input, settings) {
    if (!settings.groqApiKey) {
      throw new Error("Groq API キーが設定されていません");
    }
    const systemPrompt =
      `あなたは純粋にJSONのみを返すAPIです。以下のJSON構造に厳密に従って台本を生成してください。JSONの前後にテキストや\`\`\`を付けてはいけません。\n\n# JSON構造\n${JSON_TEMPLATE}`;
    const content = await callGroq(
      settings.groqApiKey,
      systemPrompt,
      buildPromptBody(input),
      "groq.generateScript",
    );
    try {
      return JSON.parse(content) as Script;
    } catch (e) {
      throw new Error(
        `Groqの応答JSONパース失敗: ${e instanceof Error ? e.message : String(e)}\n\n応答: ${content.slice(0, 500)}`,
      );
    }
  },
  async suggestTopics(input, settings) {
    if (!settings.groqApiKey) {
      throw new Error("Groq API キーが設定されていません");
    }
    const systemPrompt =
      "純粋にJSONのみを返してください。JSONの前後にテキストや```を付けてはいけません。";
    const content = await callGroq(
      settings.groqApiKey,
      systemPrompt,
      buildTopicPrompt(input),
      "groq.suggestTopics",
      1500,
    );
    try {
      const parsed = JSON.parse(content) as { topics: TopicSuggestion[] };
      return parsed.topics ?? [];
    } catch (e) {
      throw new Error(
        `Groqの応答JSONパース失敗: ${e instanceof Error ? e.message : String(e)}\n\n応答: ${content.slice(0, 500)}`,
      );
    }
  },
};

// ─────────────────────────────────────────
// OpenAI Provider
// ─────────────────────────────────────────

async function callOpenAi(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  label: string,
): Promise<string> {
  const res = await withRetry(
    () =>
      fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          response_format: { type: "json_object" },
        }),
      }).then(async (r) => {
        if (!r.ok) {
          const err = await r.text();
          throw new Error(`OpenAI ${r.status}: ${err.slice(0, 300)}`);
        }
        return r.json();
      }),
    { label },
  );
  const content = res?.choices?.[0]?.message?.content as string | undefined;
  if (!content) throw new Error("OpenAIから応答が得られませんでした");
  return content;
}

const openaiProvider: LlmProvider = {
  id: "openai",
  label: "OpenAI GPT（高品質・従量課金）",
  async generateScript(input, settings) {
    if (!settings.openaiApiKey) {
      throw new Error("OpenAI API キーが設定されていません");
    }
    const model = settings.openaiModel || "gpt-5-mini";
    const systemPrompt =
      `あなたは純粋にJSONのみを返すAPIです。以下のJSON構造に厳密に従って台本を生成してください。JSONの前後にテキストや\`\`\`を付けてはいけません。\n\n# JSON構造\n${JSON_TEMPLATE}`;
    const content = await callOpenAi(
      settings.openaiApiKey,
      model,
      systemPrompt,
      buildPromptBody(input),
      "openai.generateScript",
    );
    try {
      return JSON.parse(content) as Script;
    } catch (e) {
      throw new Error(
        `OpenAI応答のJSONパース失敗: ${e instanceof Error ? e.message : String(e)}\n\n応答: ${content.slice(0, 500)}`,
      );
    }
  },
  async suggestTopics(input, settings) {
    if (!settings.openaiApiKey) {
      throw new Error("OpenAI API キーが設定されていません");
    }
    const model = settings.openaiModel || "gpt-5-mini";
    const systemPrompt =
      "純粋にJSONのみを返してください。JSONの前後にテキストや```を付けてはいけません。";
    const content = await callOpenAi(
      settings.openaiApiKey,
      model,
      systemPrompt,
      buildTopicPrompt(input),
      "openai.suggestTopics",
    );
    try {
      const parsed = JSON.parse(content) as { topics: TopicSuggestion[] };
      return parsed.topics ?? [];
    } catch (e) {
      throw new Error(
        `OpenAI応答のJSONパース失敗: ${e instanceof Error ? e.message : String(e)}\n\n応答: ${content.slice(0, 500)}`,
      );
    }
  },
};

export const OPENAI_MODELS = [
  { id: "gpt-5-mini", label: "GPT-5 mini（推奨・安い・高品質）" },
  { id: "gpt-5", label: "GPT-5（最高品質・高め）" },
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini（安定・安い）" },
  { id: "gpt-4.1", label: "GPT-4.1（高品質・中価格）" },
];

export const LLM_PROVIDERS: Record<string, LlmProvider> = {
  gemini: geminiProvider,
  groq: groqProvider,
  openai: openaiProvider,
};

export function getLlmProvider(id: string): LlmProvider {
  return LLM_PROVIDERS[id] ?? geminiProvider;
}
