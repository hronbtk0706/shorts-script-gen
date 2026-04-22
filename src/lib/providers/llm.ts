import { GoogleGenAI, Type } from "@google/genai";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
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
  trendInsights?: string;
  performanceInsights?: string;
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
  if (input.trendInsights) {
    lines.push("", "# 今日のYouTubeトレンド（参考必須）", input.trendInsights);
  }
  if (input.performanceInsights) {
    lines.push("", "# 過去の実績データ（このチャンネルの傾向）", input.performanceInsights);
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

function buildPromptBody(input: ScriptInput): string {
  const lines = [
    `あなたはショート動画の構成作家です。「視聴者の反応・コメントを集めて見せる」タイプの${platformLabel[input.platform]}向け${input.duration}秒台本を日本語で作成してください。`,
    "",
    "# 重要：このタイプの本質",
    "**「実在の視聴者コメント・反応を集めて並べる」フォーマット**です。",
    "AI自身が解釈・考察を捏造するのではなく、**与えられた参考動画の実コメントを軸に組み立てる**ことが命です。",
    "",
    "# トピック（取り上げるシーン・出来事）",
    input.topic,
    "",
    "# 条件",
    `- プラットフォーム: ${platformLabel[input.platform]}`,
    `- 尺: ${input.duration}秒`,
  ];
  if (input.audience) lines.push(`- ターゲット層: ${input.audience}`);
  if (input.tone) lines.push(`- トーン: ${input.tone}`);
  if (input.goal) lines.push(`- 目的: ${input.goal}`);
  if (input.reference) lines.push(`- 参考・演出指示: ${input.reference}`);
  if (input.selectedComments && input.selectedComments.length > 0) {
    lines.push(
      "",
      "# ユーザーが手動選択した実コメント【本編素材の最優先源・これだけを使う】",
      "以下はユーザーが特定動画のコメント欄から厳選した反応です。",
      "**body[] の各要素は、この中から1つずつ選んで配置してください**（過不足があれば多少調整）。",
      "コメントに返信マーク `↪ 返信` があるものは、元スレッドへの返信であることを意識しつつ使ってよい。",
      "",
    );
    input.selectedComments.forEach((c, i) => {
      const marker = c.isReply ? "↪ 返信" : "コメント";
      const author = c.author ? ` (@${c.author})` : "";
      const likes = ` 👍${c.likeCount}`;
      lines.push(`[${i + 1}] ${marker}${author}${likes}: ${c.text}`);
    });
    lines.push("");
  } else if (input.trendInsights) {
    lines.push(
      "",
      "# 参考動画情報・実在コメント【本編素材の最重要源】",
      "↓ ここの【トップコメント】セクションが本編で使う「視聴者の反応」の実素材です。",
      "↓ 各 body[i] のシーンで、ここに書かれた実コメントを引用・短縮して使ってください。",
      "",
      input.trendInsights,
    );
  }
  if (input.performanceInsights) {
    lines.push("", "# 過去の動画パフォーマンス分析", input.performanceInsights);
  }

  if (input.template) {
    const t = input.template;
    const total = Math.max(1, t.totalDuration);
    const hookDur = Math.min(3, total * 0.1);
    const ctaDur = Math.min(3, total * 0.1);
    const bodyStart = hookDur;
    const bodyEnd = total - ctaDur;
    lines.push(
      "",
      "# 使用テンプレート【重要：構成・尺はこれに従う】",
      `- 名前: ${t.name}`,
      `- 全体尺: ${t.totalDuration}秒（厳守）`,
      `- body セグメント数: 1`,
      t.themeVibe ? `- 雰囲気: ${t.themeVibe}` : "",
      t.overallPacing ? `- ペース: ${t.overallPacing}` : "",
      t.narrationStyle ? `- ナレーション口調: ${t.narrationStyle}` : "",
      "",
      "## セグメント指定",
      `- hook: 0-${hookDur.toFixed(1)}s (${hookDur.toFixed(1)}秒)`,
      `- body[0]: ${bodyStart.toFixed(1)}-${bodyEnd.toFixed(1)}s (${(bodyEnd - bodyStart).toFixed(1)}秒)`,
      `- cta: ${bodyEnd.toFixed(1)}-${total.toFixed(1)}s (${ctaDur.toFixed(1)}秒)`,
    );
    lines.push(
      "",
      "## テンプレ適用ルール",
      "- body[] は **body セグメント数（1個）と同じ要素数**にする",
      "- 各 body[i] の seconds はテンプレの対応 body セグメントに一致",
      "- hook/cta の seconds も対応するセグメントに一致",
      "- ガイドラインとして柔軟に扱ってよいが、**セグメント数と全体尺は変えない**",
    );
  }

  lines.push(
    "",
    "# フック制作指示（最初の3秒）",
    "**反応集型のフックは「みんな同じこと思ってた感」「この反応リアル」を匂わせる**",
    "",
    "## 反応集型フックの良い型",
    "- 「[シーン名]、視聴者の反応がリアルすぎた」",
    "- 「『[コメントの一部引用、5〜10字]』このコメントが刺さりすぎる」",
    "- 「[シーン名]を見た人、全員ここで止まった」",
    "- 「コメント欄が[感情]で埋まったシーン」",
    "",
    "## NG ワード（フック共通）",
    "- 「驚きの」「衝撃の」「必見」「ヤバい」「最強」「豆知識」",
    "- 「10秒で」「3秒で」のような尺言及",
    "- 「え、」「ねえ、」だけの間投詞スタート",
    "",
    "# 本編制作指示（反応集モード固有・最重要）",
    "",
    "## 構成原則【純粋コメント並列型】",
    "- **body[] の各要素 = 実コメントを1つだけ提示する純粋な引用箱**",
    "- AI による合いの手・感想・補足・解説は**一切入れない**",
    "- 各 body のナレーションは「コメント本文そのもの」だけ。前置きも後置きも禁止",
    "- text_overlay も narration とほぼ同じテキスト（TTS とテロップが一致）",
    "- 過度に綺麗にまとめない。**本物のコメントの生っぽさ・口語の崩れを残す**ことが命",
    "- 上記【参考動画情報】の【トップコメント】から実コメントを抽出して使う",
    "",
    "## コメントの扱い",
    "- 完全コピーは避けるが、**原文の感情・言い回しは保つ**（細部を1〜3文字変える程度）",
    "- 1コメントあたり 10〜30 字程度に短縮（テンポ重視）",
    "- 鍵カッコ「」は付けても付けなくても可（自然なほうで）",
    "- **コメントが取得できなかった場合**: 視聴者目線の短い感想風セリフを生成（解説・考察NG、口語の短文のみ）",
    "",
    "## 各 body[i] のテンプレ",
    "narration: コメント本文そのもの。短く。AI の感想・補足は禁止",
    "  ✅ OK: narration = 「俺もここで号泣した」",
    "  ✅ OK: narration = 「『知ってる…』で全部持ってかれた」",
    "  ❌ NG: narration = 「これ言ってる人多かった。『俺もここで号泣した』って。本当それ。」",
    "  ❌ NG: narration = 「ファンが12年待った声『12年待ったわ』そのまま。」",
    "text_overlay: narration と同じ or その核心を 15字以内に",
    "  例: text_overlay = 「俺も号泣した」",
    "",
    "## hook / cta は AI の地の文 OK",
    "- hook (最初の3秒): 「視聴者の反応リアルすぎた」など導入文 OK",
    "- body[]: 純粋コメント並列のみ、AI の言葉禁止",
    "- cta: 「あなたはどう思った？」など問いかけ OK",
    "",
    "## NG → OK 比較",
    "- NG: 「視聴者は深い感動を覚えた」(抽象的・創作)",
    "  OK: 「俺も号泣した」(コメント本文のみ)",
    "- NG: 「『知ってる…』で全部持ってかれた、って人多かった」(余計な後置きあり)",
    "  OK: 「『知ってる…』で全部持ってかれた」(純粋引用)",
    "- NG: 「考察すると伏線が……」",
    "  OK: 「『12年待ったわこの再会』長年のファンの本音」",
    "",
    "## 構成の流れ（30秒の例）",
    "- hook (0-3s): フック",
    "- body[0] (3-8s): シーン状況の最短説明（実コメントへの導入）",
    "- body[1] (8-13s): 実コメント1引用＋共感",
    "- body[2] (13-18s): 実コメント2引用＋共感",
    "- body[3] (18-23s): 実コメント3引用＋共感",
    "- body[4] (23-27s): まとめ的反応 or 鳥肌系コメント",
    "- cta (27-30s): 「あなたはどう思った？」系",
    "",
    "# その他の指示",
    "- 秒数配分は合計が指定尺に収まるようにする",
    "- ナレーションは口語で、テロップは短く印象的に（20字以内）",
    "- ハッシュタグは5〜10個、日本語と英語を織り交ぜる",
    "",
    "# 画像プロンプト指示",
    "- 各シーンの image_prompt は英語で1文。Pollinations/Flux で縦型動画用画像を生成する",
    "- 必須含有: 'vertical 9:16', 'vibrant', 'cinematic', 'high detail'",
    "- 反応集なので、シーンの感情を象徴する1枚絵を選ぶ（人物のシルエット、表情、空気感など）",
    "",
    "# テロップ・デザイン指示",
    "- theme_vibe（全体の雰囲気）を最初に決めて、それに合うカラーパレットを選ぶ",
    "- text_overlay にはコメント引用部分を表示。引用感を出すため『」』記号を入れてもよい",
    "- primary_color は背景に対して高コントラストで目立つ色",
    "- emoji は反応の感情に合うもの（号泣=😭, 鳥肌=⚡, 共感=💯, 切ない=💔, 笑い=😂 など）",
    "- emphasis_keyword は引用コメントの最も刺さるワード",
    "",
    "# エフェクト指示（共通）",
    "- motion はシーンごとに変化させる。同じ motion を2連続で使わない",
    "- color は theme_vibe に合わせ、感情の山で1〜2回アクセント",
    "- audio_fade_in: hookのみ true、audio_fade_out: ctaのみ true",
    "- transition_to_next: 反応の切替なので cut 多めだが、感情の変わり目で fade/dissolve も使う",
    "- transition_duration: 0.3〜0.6秒（反応集はテンポ重視）",
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
        "push_in",
        "zoom_punch",
        "shake",
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
        "neon",
        "high_contrast",
        "soft_glow",
        "film_grain",
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
        "fadegrays",
        "flash",
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
        "wipeup",
        "wipedown",
        "pixelize",
        "smoothleft",
        "radial",
        "hblur",
        "squeezev",
        "squeezeh",
        "coverleft",
        "coverright",
        "coverup",
        "coverdown",
        "revealleft",
        "revealright",
        "revealup",
        "revealdown",
        "diagtl",
        "diagtr",
        "diagbl",
        "diagbr",
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
      "motion": "static|zoom_in|zoom_out|pan_left|pan_right|pan_up|pan_down|ken_burns|push_in|zoom_punch|shake",
      "color": "none|sepia|bw|vintage|vivid|cool|warm|vignette|neon|high_contrast|soft_glow|film_grain",
      "audio_fade_in": true,
      "audio_fade_out": false,
      "transition_to_next": "cut|fade|fadeblack|fadewhite|fadegrays|flash|slideleft|slideright|slideup|slidedown|dissolve|zoomin|circleopen|circleclose|wipeleft|wiperight|wipeup|wipedown|pixelize|smoothleft|radial|hblur|squeezev|squeezeh|coverleft|coverright|coverup|coverdown|revealleft|revealright|revealup|revealdown|diagtl|diagtr|diagbl|diagbr",
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
      tauriFetch("https://api.groq.com/openai/v1/chat/completions", {
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
      tauriFetch("https://api.openai.com/v1/chat/completions", {
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

// ─────────────────────────────────────────
// Multi-candidate pipeline helpers
// ─────────────────────────────────────────

export interface ScriptAngle {
  angle: string;
  hook_feeling: string;
  why_original: string;
}

export interface SelectionResult {
  selected_index: number;
  reason: string;
  improvements: string[];
}

/** provider-agnostic JSON completion (uses the settings-picked provider & model). */
async function completeJson<T>(
  settings: AppSettings,
  systemPrompt: string,
  userPrompt: string,
  label: string,
  temperature = 0.9,
): Promise<T> {
  const providerId = settings.llmProvider;
  let content = "";
  if (providerId === "openai") {
    if (!settings.openaiApiKey) throw new Error("OpenAI API キーが設定されていません");
    const model = settings.openaiModel || "gpt-5-mini";
    content = await callOpenAi(settings.openaiApiKey, model, systemPrompt, userPrompt, label);
  } else if (providerId === "groq") {
    if (!settings.groqApiKey) throw new Error("Groq API キーが設定されていません");
    content = await callGroq(settings.groqApiKey, systemPrompt, userPrompt, label);
  } else {
    if (!settings.geminiApiKey) throw new Error("Gemini API キーが設定されていません");
    const ai = new GoogleGenAI({ apiKey: settings.geminiApiKey });
    const response = await withRetry(
      () =>
        ai.models.generateContent({
          model: "gemini-2.5-flash-lite",
          contents: `${systemPrompt}\n\n${userPrompt}`,
          config: { responseMimeType: "application/json", temperature },
        }),
      { label },
    );
    content = response.text ?? "";
  }
  if (!content) throw new Error(`${label}: 空応答`);
  try {
    return JSON.parse(content) as T;
  } catch (e) {
    throw new Error(
      `${label}: JSON パース失敗 ${e instanceof Error ? e.message : String(e)}\n\n${content.slice(0, 400)}`,
    );
  }
}

function buildAngleBrainstormPrompt(input: ScriptInput, count: number): string {
  const lines = [
    `あなたはショート動画の構成作家です。「視聴者の反応・コメントを並べる」フォーマットで作る台本のために、**どのコメントテーマ・反応軸を中心に据えるか**の切り口を${count}個出してください。`,
    "",
    "# トピック",
    input.topic,
    `# プラットフォーム: ${platformLabel[input.platform]}`,
    `# 尺: ${input.duration}秒`,
  ];
  if (input.audience) lines.push(`# ターゲット層: ${input.audience}`);
  if (input.tone) lines.push(`# トーン: ${input.tone}`);
  if (input.trendInsights) {
    lines.push(
      "",
      "# 参考動画情報・実コメント（コメントテーマを抽出する素材）",
      input.trendInsights,
    );
  }
  if (input.performanceInsights) {
    lines.push("", "# 過去実績", input.performanceInsights);
  }
  lines.push(
    "",
    "# 指示",
    "- 各「切り口」は **「どんな反応・コメントを軸にする台本にするか」** という視点で出す",
    "- 例: 「号泣系コメント中心」「サボの『知ってる』への反応」「12年待ったファンの本音」「鳥肌コメント特集」「短いひとこと反応集」",
    "- **使ってはいけない空虚な語**: 驚きの〜 / 衝撃の〜 / 必見 / 豆知識 / まさかの〜",
    "- **秒数への言及禁止**: 「10秒で」「3秒で」は書かない",
    "- 「3語解析」「5点」のような列挙型は**禁止**",
    "- **AI 解釈・考察系の切り口は出さない**（反応集なので「視聴者の声をどう集めるか」に集中）",
    "- hook_feeling は視聴者が最初の3秒で感じる具体的な感情（共感/号泣/鳥肌/ノスタルジー/笑い など）",
    "",
    "# NG → OK",
    '- NG: 「サボの行動を考察する10ポイント」（解釈型）',
    '  OK: 「サボの〝知ってる…〟への号泣コメント集」（反応型）',
    '- NG: 「3つの伏線を解説」',
    '  OK: 「12年待ったファンの本音コメント」',
    "",
    "# 出力形式（JSON）",
    `{
  "angles": [
    {
      "angle": "切り口のタイトル（20字以内）",
      "hook_feeling": "視聴者が最初の3秒で感じる感情",
      "why_original": "なぜ並の切り口と違うか（40字以内）"
    }
  ]
}`,
  );
  return lines.join("\n");
}

export async function brainstormAngles(
  input: ScriptInput,
  settings: AppSettings,
  count = 10,
): Promise<ScriptAngle[]> {
  const systemPrompt =
    "純粋にJSONのみを返してください。JSONの前後にテキストや```を付けてはいけません。";
  const userPrompt = buildAngleBrainstormPrompt(input, count);
  const parsed = await completeJson<{ angles: ScriptAngle[] }>(
    settings,
    systemPrompt,
    userPrompt,
    "brainstormAngles",
    1.0,
  );
  return parsed.angles ?? [];
}

function buildSelectionPrompt(
  candidates: Script[],
  input: ScriptInput,
): string {
  const lines = [
    "あなたはショート動画のプロデューサーです。以下の台本候補の中から、最も視聴維持率・エンゲージメントが期待できる1本を選び、選定理由と改善ポイントを日本語で出してください。",
    "",
    "# 元のトピック",
    input.topic,
    `# プラットフォーム: ${platformLabel[input.platform]}`,
    `# 尺: ${input.duration}秒`,
    "",
    "# 評価基準（優先順位順）",
    "1. **フック（hook.text）の具体性と強さ【最重要】**",
    "   - 固有名詞・具体的数字・断定が入っているか",
    "   - 「驚きの〜」「衝撃の〜」「豆知識」など空虚な形容詞で中身を予告するだけのものは強く減点",
    "   - 尺への言及（「10秒で」「3秒で」）を含むフックも減点",
    "   - 中身を先に出し、続きを見たい具体的理由を作れているか",
    "2. **本編（body）の具体性【同等に最重要】**",
    "   - 各シーンに話数・セリフの引用・キャラ名＋具体動作・固有名詞のいずれかが入っているか",
    "   - 「象徴」「モチーフ」「意味を持つ」「繋がる」だけで具体描写がないシーンは強く減点",
    "   - 作中に存在しない造語・捏造用語が混じっていないか（混じっていれば最低評価）",
    "   - 「伏線①②」のような連番だけで中身が無いものは強く減点",
    "3. 構成の緊張と弛緩（盛り上がりの設計）",
    "4. 共感・意外性・感情の揺さぶり（固有名詞や体験ベースの具体性）",
    "5. 視聴後の余韻・シェアしたくなる度（CTA含む）",
    "",
    "# 候補",
  ];
  for (const [i, c] of candidates.entries()) {
    lines.push(
      `── 候補 ${i}（index=${i}） ──`,
      `タイトル: ${c.title}`,
      `テーマ雰囲気: ${c.theme_vibe}`,
      `フック: ${c.hook.text}（${c.hook.seconds}）`,
      `本編: ${c.body.map((b) => b.narration).join(" / ")}`,
      `CTA: ${c.cta.text}`,
      `ハッシュタグ: ${c.hashtags.join(" ")}`,
      "",
    );
  }
  lines.push(
    "# 出力形式（JSON）",
    `{
  "selected_index": 0,
  "reason": "なぜこれを選んだか（100字以内）",
  "improvements": ["さらに良くするための短い提案1", "提案2"]
}`,
  );
  return lines.join("\n");
}

export async function selectBestScript(
  candidates: Script[],
  input: ScriptInput,
  settings: AppSettings,
): Promise<SelectionResult> {
  if (candidates.length === 0) throw new Error("候補が空です");
  if (candidates.length === 1) {
    return { selected_index: 0, reason: "候補1本のみ", improvements: [] };
  }
  const systemPrompt =
    "純粋にJSONのみを返してください。JSONの前後にテキストや```を付けてはいけません。";
  const userPrompt = buildSelectionPrompt(candidates, input);
  const parsed = await completeJson<SelectionResult>(
    settings,
    systemPrompt,
    userPrompt,
    "selectBestScript",
    0.4,
  );
  const idx = Math.max(
    0,
    Math.min(candidates.length - 1, parsed.selected_index ?? 0),
  );
  return { ...parsed, selected_index: idx };
}
