import { GoogleGenAI, Type } from "@google/genai";
import type { VideoTemplate, TemplateSegment, Layer } from "../types";
import { withRetry } from "./retry";
import { makeTemplateId } from "./templateStore";
import { genLayerId, genSegmentId } from "./layerUtils";

interface AnalyzedCut {
  index: number;
  startSec: number;
  endSec: number;
  type: "hook" | "body" | "cta";
  shotType?: string;
  motion?: string;
  color?: string;
  textOverlay?: { position?: string; style?: string; hasText?: boolean } | null;
  transition?: string;
  transitionDuration?: number;
  description?: string;
}

export type AnalysisStage =
  | "validating"
  | "fetching"
  | "analyzing"
  | "formatting"
  | "done";

export interface AnalysisProgress {
  stage: AnalysisStage;
  detail?: string;
}

export class TemplateAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateAnalysisError";
  }
}

export function extractVideoId(url: string): string | null {
  const clean = url.trim();
  if (!clean) return null;
  const patterns = [
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = clean.match(p);
    if (m) return m[1];
  }
  if (/^[a-zA-Z0-9_-]{11}$/.test(clean)) return clean;
  return null;
}

const templateSchema = {
  type: Type.OBJECT,
  properties: {
    sourceTitle: { type: Type.STRING },
    sourceChannel: { type: Type.STRING },
    totalDuration: { type: Type.NUMBER },
    themeVibe: { type: Type.STRING },
    overallPacing: { type: Type.STRING },
    narrationStyle: { type: Type.STRING },
    suggestedName: { type: Type.STRING },
    cuts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          index: { type: Type.INTEGER },
          startSec: { type: Type.NUMBER },
          endSec: { type: Type.NUMBER },
          type: { type: Type.STRING, enum: ["hook", "body", "cta"] },
          shotType: { type: Type.STRING },
          motion: { type: Type.STRING },
          color: { type: Type.STRING },
          textOverlay: {
            type: Type.OBJECT,
            properties: {
              position: { type: Type.STRING },
              style: { type: Type.STRING },
              hasText: { type: Type.BOOLEAN },
            },
            required: ["position", "style", "hasText"],
            propertyOrdering: ["position", "style", "hasText"],
          },
          transition: { type: Type.STRING },
          transitionDuration: { type: Type.NUMBER },
          description: { type: Type.STRING },
        },
        required: [
          "index",
          "startSec",
          "endSec",
          "type",
          "shotType",
          "motion",
          "color",
          "textOverlay",
          "transition",
          "transitionDuration",
          "description",
        ],
        propertyOrdering: [
          "index",
          "startSec",
          "endSec",
          "type",
          "shotType",
          "motion",
          "color",
          "textOverlay",
          "transition",
          "transitionDuration",
          "description",
        ],
      },
    },
  },
  required: [
    "sourceTitle",
    "sourceChannel",
    "totalDuration",
    "themeVibe",
    "overallPacing",
    "narrationStyle",
    "suggestedName",
    "cuts",
  ],
  propertyOrdering: [
    "sourceTitle",
    "sourceChannel",
    "totalDuration",
    "themeVibe",
    "overallPacing",
    "narrationStyle",
    "suggestedName",
    "cuts",
  ],
};

function buildAnalysisPrompt(): string {
  return [
    "この動画（ショート動画）の構成・カット割り・編集パターンを解析し、**再利用可能な台本テンプレート**として JSON で出力してください。",
    "",
    "# 目的",
    "この動画と同じ「型」で、別の内容の台本を生成するためのテンプレートを作ります。",
    "**内容（セリフやトピック）ではなく、構成・尺配分・カット割り・演出パターン**を抽出してください。",
    "",
    "# 抽出する項目",
    "- sourceTitle: 動画のタイトル",
    "- sourceChannel: チャンネル名",
    "- totalDuration: 動画全体の秒数（小数可）",
    "- themeVibe: 動画全体の雰囲気（例: 『エモーショナル・ノスタルジック』『テンポ速いポップ』『シリアス・重い』など）",
    "- overallPacing: ペース感の文章説明（例: 『最初は速いカットで引き込み、中盤に1カット長めの感情ホールド、ラストは再び速い切替』）",
    "- narrationStyle: ナレーションの口調（例: 『口語・短文・語尾やわらかめ』『落ち着いた男性ナレ』『キャラクター声』『ナレーション無し・テロップのみ』）",
    "- suggestedName: このテンプレートの名前（20字以内、別トピックでも再利用できる汎用名）",
    "",
    "# cuts 配列（各カットの構造）",
    "動画をシーン切替（カット）ごとに区切り、以下を記録:",
    "- index: カット番号（0始まり）",
    "- startSec, endSec: カットの開始・終了秒",
    "- type: 'hook'（最初の3秒）/ 'body'（本編）/ 'cta'（最後の CTA 部分）",
    "- shotType: ショット種類（例: 『クローズアップ』『ミディアム』『ワイド』『テキストオンリー画面』『人物の表情』）",
    "- motion: カメラ/画像モーション（例: 'zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'static', 'ken_burns', 'shake', 'zoom_punch'）",
    "- color: 色調（例: 'none', 'vivid', 'sepia', 'bw', 'warm', 'cool', 'vintage', 'vignette', 'soft_glow'）",
    "- textOverlay: テロップ情報",
    "  - position: 'top', 'center', 'bottom', 'none'",
    "  - style: テロップのスタイル説明（例: 『大きい黄色・黒縁』『白文字・下部中央』）",
    "  - hasText: そのカットにテロップがあるか（true/false）",
    "- transition: 次のカットへの切替方法（'cut', 'fade', 'flash', 'dissolve', 'slideleft', 'zoomin' など）",
    "- transitionDuration: トランジションの秒数（cut なら 0、通常 0.3〜0.8）",
    "- description: そのカットの視覚的説明（1 文、内容ではなく『何が映っているか』）",
    "",
    "# 重要な注意",
    "- **具体的なトピック・セリフは抽出しない**（この動画のナレーションを書き起こす必要はない）",
    "- カット数は厳密に数える（映像が変わった瞬間＝カット）",
    "- 解析不明な項目は合理的な既定値を使う（例: color='none', transition='cut'）",
    "- テロップが一切無い動画なら全カットの textOverlay.hasText を false に",
  ].join("\n");
}

export async function analyzeTemplate(
  apiKey: string,
  url: string,
  options: {
    onProgress?: (p: AnalysisProgress) => void;
    customName?: string;
    note?: string;
  } = {},
): Promise<VideoTemplate> {
  const report = (stage: AnalysisStage, detail?: string) =>
    options.onProgress?.({ stage, detail });

  report("validating", "URL を検証中...");
  const videoId = extractVideoId(url);
  if (!videoId) {
    throw new TemplateAnalysisError(
      "有効な YouTube URL を指定してください（youtube.com/shorts/... または watch?v=...）",
    );
  }
  const normalizedUrl = `https://www.youtube.com/watch?v=${videoId}`;

  if (!apiKey) {
    throw new TemplateAnalysisError(
      "Gemini API キーが設定されていません（設定 → 台本生成AI → Gemini キー）",
    );
  }

  report("analyzing", "Gemini Vision で動画を解析中...（30〜60秒）");
  const ai = new GoogleGenAI({ apiKey });
  const response = await withRetry(
    () =>
      ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          {
            role: "user",
            parts: [
              {
                fileData: {
                  fileUri: normalizedUrl,
                  mimeType: "video/*",
                },
              },
              { text: buildAnalysisPrompt() },
            ],
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: templateSchema,
          temperature: 0.3,
        },
      }),
    { label: "templateAnalyzer", retries: 1 },
  );

  const text = response.text;
  if (!text) {
    throw new TemplateAnalysisError("Gemini から空応答が返りました");
  }

  report("formatting", "テンプレート整形中...");
  let parsed: {
    sourceTitle: string;
    sourceChannel: string;
    totalDuration: number;
    themeVibe: string;
    overallPacing: string;
    narrationStyle: string;
    suggestedName: string;
    cuts: AnalyzedCut[];
  };
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new TemplateAnalysisError(
      `JSON パース失敗: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!Array.isArray(parsed.cuts) || parsed.cuts.length === 0) {
    throw new TemplateAnalysisError("cuts が空または不正です");
  }

  // 解析された cuts を v2 の segments + layers に変換
  const segments: TemplateSegment[] = [];
  const layers: Layer[] = [];
  let bodyIdx = 0;
  parsed.cuts.forEach((c) => {
    segments.push({
      id: genSegmentId(),
      type: c.type,
      bodyIndex: c.type === "body" ? bodyIdx++ : undefined,
      startSec: c.startSec,
      endSec: c.endSec,
      color: c.color as TemplateSegment["color"],
      transitionTo: c.transition as TemplateSegment["transitionTo"],
      transitionDuration: c.transitionDuration,
    });
    // カット期間中に全画面で表示される auto 画像レイヤーをデフォルトで作成
    layers.push({
      id: genLayerId(),
      type: "image",
      source: "auto",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      zIndex: c.index,
      startSec: c.startSec,
      endSec: c.endSec,
      motion: (c.motion as Layer["motion"]) ?? undefined,
    });
  });

  const name = options.customName?.trim() || parsed.suggestedName || "untitled";
  const template: VideoTemplate = {
    version: 2,
    id: makeTemplateId(name),
    name,
    note: options.note,
    sourceUrl: normalizedUrl,
    sourceTitle: parsed.sourceTitle,
    sourceChannel: parsed.sourceChannel,
    createdAt: new Date().toISOString(),
    totalDuration: parsed.totalDuration,
    layers,
    segments,
    overallPacing: parsed.overallPacing,
    narrationStyle: parsed.narrationStyle,
    themeVibe: parsed.themeVibe,
  };

  report("done");
  return template;
}
