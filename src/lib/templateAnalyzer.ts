import { GoogleGenAI, Type } from "@google/genai";
import type {
  VideoTemplate,
  Layer,
  LayerType,
  LayerShape,
  Motion,
  EntryAnimation,
  ExitAnimation,
  AmbientAnimation,
  CharAnimation,
  KineticAnimation,
  TextDecoration,
} from "../types";
import { withRetry } from "./retry";
import { makeTemplateId } from "./templateStore";
import { genLayerId } from "./layerUtils";

// 許可 enum（types.ts と同期。違反値は既定値にフォールバック）
const LAYER_TYPES: LayerType[] = ["image", "video", "color", "shape", "comment"];
const LAYER_SHAPES: LayerShape[] = ["rect", "rounded", "circle"];
const MOTIONS: Motion[] = [
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
];
const ENTRY_ANIMS: EntryAnimation[] = [
  "none",
  "fade",
  "slide-left",
  "slide-right",
  "slide-up",
  "slide-down",
  "zoom-in",
  "pop",
  "blur-in",
  "elastic-pop",
  "flip-in",
  "stretch-in",
  "roll-in",
];
const EXIT_ANIMS: ExitAnimation[] = [
  "none",
  "fade",
  "slide-left",
  "slide-right",
  "slide-up",
  "slide-down",
  "zoom-out",
  "blur-out",
  "flip-out",
  "stretch-out",
  "roll-out",
];
const AMBIENTS: AmbientAnimation[] = [
  "none",
  "pulse",
  "shake",
  "wiggle",
  "bounce",
  "blink",
  "glow-pulse",
  "rainbow",
  "float",
];
const CHAR_ANIMS: CharAnimation[] = [
  "none",
  "typewriter",
  "stagger-fade",
  "wave",
  "color-shift",
];
const KINETICS: KineticAnimation[] = [
  "none",
  "word-pop",
  "keyword-color",
  "slide-stack",
  "zoom-talk",
];
const TEXT_DECOS: TextDecoration[] = [
  "none",
  "highlight-bar",
  "underline-sweep",
  "neon",
  "outline-reveal",
  "shadow-drop",
];

function pick<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === "string" && (allowed as string[]).includes(value)
    ? (value as T)
    : fallback;
}

function pickNum(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

interface AnalyzedLayer {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  opacity?: number;
  zIndex?: number;
  shape?: string;
  borderRadius?: number;
  borderWidth?: number;
  borderColor?: string;
  text?: string;
  fontSize?: number;
  fontColor?: string;
  textOutlineWidth?: number;
  textOutlineColor?: string;
  fillColor?: string;
  startSec: number;
  endSec: number;
  motion?: string;
  entryAnimation?: string;
  entryDuration?: number;
  exitAnimation?: string;
  exitDuration?: number;
  ambientAnimation?: string;
  charAnimation?: string;
  kineticAnimation?: string;
  textDecoration?: string;
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

const layerSchema = {
  type: Type.OBJECT,
  properties: {
    type: { type: Type.STRING, enum: LAYER_TYPES as unknown as string[] },
    x: { type: Type.NUMBER },
    y: { type: Type.NUMBER },
    width: { type: Type.NUMBER },
    height: { type: Type.NUMBER },
    rotation: { type: Type.NUMBER },
    opacity: { type: Type.NUMBER },
    zIndex: { type: Type.INTEGER },
    shape: { type: Type.STRING, enum: LAYER_SHAPES as unknown as string[] },
    borderRadius: { type: Type.NUMBER },
    borderWidth: { type: Type.NUMBER },
    borderColor: { type: Type.STRING },
    text: { type: Type.STRING },
    fontSize: { type: Type.NUMBER },
    fontColor: { type: Type.STRING },
    textOutlineWidth: { type: Type.NUMBER },
    textOutlineColor: { type: Type.STRING },
    fillColor: { type: Type.STRING },
    startSec: { type: Type.NUMBER },
    endSec: { type: Type.NUMBER },
    motion: { type: Type.STRING, enum: MOTIONS as unknown as string[] },
    entryAnimation: {
      type: Type.STRING,
      enum: ENTRY_ANIMS as unknown as string[],
    },
    entryDuration: { type: Type.NUMBER },
    exitAnimation: {
      type: Type.STRING,
      enum: EXIT_ANIMS as unknown as string[],
    },
    exitDuration: { type: Type.NUMBER },
    ambientAnimation: {
      type: Type.STRING,
      enum: AMBIENTS as unknown as string[],
    },
    charAnimation: {
      type: Type.STRING,
      enum: CHAR_ANIMS as unknown as string[],
    },
    kineticAnimation: {
      type: Type.STRING,
      enum: KINETICS as unknown as string[],
    },
    textDecoration: {
      type: Type.STRING,
      enum: TEXT_DECOS as unknown as string[],
    },
    description: { type: Type.STRING },
  },
  required: [
    "type",
    "x",
    "y",
    "width",
    "height",
    "startSec",
    "endSec",
  ],
  propertyOrdering: [
    "type",
    "x",
    "y",
    "width",
    "height",
    "rotation",
    "opacity",
    "zIndex",
    "shape",
    "borderRadius",
    "borderWidth",
    "borderColor",
    "text",
    "fontSize",
    "fontColor",
    "textOutlineWidth",
    "textOutlineColor",
    "fillColor",
    "startSec",
    "endSec",
    "motion",
    "entryAnimation",
    "entryDuration",
    "exitAnimation",
    "exitDuration",
    "ambientAnimation",
    "charAnimation",
    "kineticAnimation",
    "textDecoration",
    "description",
  ],
};

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
    layers: { type: Type.ARRAY, items: layerSchema },
  },
  required: [
    "sourceTitle",
    "sourceChannel",
    "totalDuration",
    "themeVibe",
    "overallPacing",
    "narrationStyle",
    "suggestedName",
    "layers",
  ],
  propertyOrdering: [
    "sourceTitle",
    "sourceChannel",
    "totalDuration",
    "themeVibe",
    "overallPacing",
    "narrationStyle",
    "suggestedName",
    "layers",
  ],
};

function buildAnalysisPrompt(): string {
  return [
    "この YouTube ショート動画の**構成・レイヤー配置・演出パターン**を解析し、**再利用可能な台本テンプレート**として JSON で出力してください。",
    "",
    "# 目的",
    "この動画と同じ「型」で、別の内容（コメントや画像）を差し替えて量産できるテンプレートを作ります。",
    "**内容ではなく、構成・配置・演出の骨格**を抽出してください。",
    "",
    "# トップレベル項目",
    "- sourceTitle / sourceChannel: 動画タイトル・チャンネル名",
    "- totalDuration: 動画全体の秒数",
    "- themeVibe: 全体の雰囲気（例: 『反応集・テンポ速め』『エモーショナル』『シリアス重め』）",
    "- overallPacing: ペース感の文章説明",
    "- narrationStyle: ナレーションの口調（例: 『AI読み上げ風・短文テロップ多い』『ナレ無しテロップのみ』）",
    "- suggestedName: 20字以内の汎用名（別トピックで再利用可能な名前）",
    "",
    "# layers（動画全体の global timeline に配置するレイヤー）",
    "動画内で視覚的に区別できる要素を全てレイヤーとして抽出。背景画像、テロップ、コメント枠、アイコン、帯、図形などを分けて。",
    "**位置とサイズは 0-100 の % 座標（左上基準、1080×1920 縦動画前提）**。",
    "各レイヤーに:",
    "- type: 'image' | 'video' | 'color' | 'shape' | 'comment'",
    "  - 背景映像や写真 → 'image'",
    "  - 埋め込み動画 → 'video'",
    "  - 単色オーバーレイ/帯 → 'color'",
    "  - 装飾図形（角丸バブル・丸アイコン背景） → 'shape'",
    "  - テロップ・字幕・コメント風吹き出しなど文字系 → 'comment'",
    "- x, y, width, height: 0-100 % （画面比率に対する位置/サイズ。おおよそで可）",
    "- rotation: 度（水平 = 0）",
    "- opacity: 0-1",
    "- zIndex: 下から順に 0, 1, 2...（重なり順）",
    "- shape: 'rect' | 'rounded' | 'circle'（角丸なら rounded）",
    "- borderRadius: rounded 時の角丸 px（だいたい 8〜24）",
    "- borderWidth, borderColor: 枠線（なければ 0）",
    "- text: comment 型の文字列（テロップ本文。固有の言い回しは『内容』扱いなので '{{comment}}' 等の仮値でも可）",
    "- fontSize: px（1080×1920 基準の実寸。大きな見出しテロップなら 72〜120、本文コメントなら 36〜60 あたり）",
    "- fontColor: '#RRGGBB'",
    "- textOutlineWidth: 文字の縁取り太さ px（縁取りが見えるなら 2〜8、無ければ 0 or 省略）",
    "- textOutlineColor: 縁取り色 '#RRGGBB'（黒縁取りが一般的。白縁取りや赤縁取りもよく見る）",
    "- fillColor: 塗り色（color/shape は 'rgba(...)' 可、comment の背景帯も可。無色なら未指定）",
    "- startSec / endSec: **動画全体の絶対秒**（セグメント相対ではない）",
    "- motion: 画像/動画のカメラモーション（static/zoom_in/zoom_out/pan_*/ken_burns/push_in/zoom_punch/shake）",
    "- entryAnimation: 入場（none/fade/slide-left/slide-right/slide-up/slide-down/zoom-in/pop/blur-in/elastic-pop/flip-in/stretch-in/roll-in）",
    "- entryDuration: 入場秒（通常 0.2〜0.5）",
    "- exitAnimation: 退場（none/fade/slide-left/slide-right/slide-up/slide-down/zoom-out/blur-out/flip-out/stretch-out/roll-out）",
    "- exitDuration: 退場秒",
    "- ambientAnimation: 表示中の常時アニメ（none/pulse/shake/wiggle/bounce/blink/glow-pulse/rainbow/float）",
    "- charAnimation: 文字単位アニメ・comment 専用（none/typewriter/stagger-fade/wave/color-shift）",
    "- kineticAnimation: 単語単位キネティック・comment 専用（none/word-pop/keyword-color/slide-stack/zoom-talk）",
    "- textDecoration: テキスト装飾・comment 専用（none/highlight-bar/underline-sweep/neon/outline-reveal/shadow-drop）",
    "- description: そのレイヤーの 1 文説明",
    "",
    "# ルール",
    "- **必ず上記 enum のいずれかの値で返す**。該当が無ければ 'none' / 'static' / 'cut' / 'rect' 等の既定値を使う",
    "- 抽出不能な項目は省略（required のみ返せばOK）",
    "- **同じコメント枠が複数表示される反応集動画の場合、複数の 'comment' レイヤーを別個に返す**（位置・時刻が違う別レイヤーとして）",
    "- 背景画像が常時表示されるなら 1 レイヤー（startSec=0, endSec=totalDuration）",
    "- 位置・サイズは動画をよく観察して近似値で OK。ピクセル完璧である必要はない",
    "- ショート動画（9:16）前提で x/width は 0-100、y/height は 0-100 として解釈",
  ].join("\n");
}

function toLayer(al: AnalyzedLayer, totalDuration: number): Layer {
  const type = pick<LayerType>(al.type, LAYER_TYPES, "image");
  const x = pickNum(al.x, 0, 100, 0);
  const y = pickNum(al.y, 0, 100, 0);
  const width = pickNum(al.width, 0.1, 100, 100);
  const height = pickNum(al.height, 0.1, 100, 100);
  const startSec = pickNum(al.startSec, 0, totalDuration, 0);
  const endSec = pickNum(
    al.endSec,
    Math.min(startSec + 0.1, totalDuration),
    totalDuration,
    totalDuration,
  );
  const shape = pick<LayerShape>(al.shape, LAYER_SHAPES, "rect");

  const base: Layer = {
    id: genLayerId(),
    type,
    x,
    y,
    width,
    height,
    zIndex: typeof al.zIndex === "number" ? al.zIndex : 0,
    rotation: pickNum(al.rotation, -360, 360, 0),
    opacity: pickNum(al.opacity, 0, 1, 1),
    shape,
    startSec,
    endSec,
  };

  if (shape === "rounded") {
    base.borderRadius = pickNum(al.borderRadius, 0, 200, 12);
  }
  if (al.borderWidth && al.borderWidth > 0) {
    base.border = {
      width: pickNum(al.borderWidth, 0, 50, 2),
      color:
        typeof al.borderColor === "string" && al.borderColor
          ? al.borderColor
          : "#ffffff",
    };
  }
  if (al.motion) {
    base.motion = pick<Motion>(al.motion, MOTIONS, "static");
  }

  // アニメ群
  if (al.entryAnimation) {
    base.entryAnimation = pick<EntryAnimation>(
      al.entryAnimation,
      ENTRY_ANIMS,
      "none",
    );
  }
  if (typeof al.entryDuration === "number") {
    base.entryDuration = pickNum(al.entryDuration, 0, 5, 0.3);
  }
  if (al.exitAnimation) {
    base.exitAnimation = pick<ExitAnimation>(
      al.exitAnimation,
      EXIT_ANIMS,
      "none",
    );
  }
  if (typeof al.exitDuration === "number") {
    base.exitDuration = pickNum(al.exitDuration, 0, 5, 0.3);
  }
  if (al.ambientAnimation) {
    base.ambientAnimation = pick<AmbientAnimation>(
      al.ambientAnimation,
      AMBIENTS,
      "none",
    );
  }

  // 文字系（comment のときのみ意味を持たせる）
  if (type === "comment") {
    base.text = typeof al.text === "string" ? al.text : "";
    if (typeof al.fontSize === "number") {
      base.fontSize = pickNum(al.fontSize, 8, 500, 48);
    }
    if (typeof al.fontColor === "string" && al.fontColor) {
      base.fontColor = al.fontColor;
    } else {
      base.fontColor = "#FFFFFF";
    }
    // 文字の縁取り
    if (typeof al.textOutlineWidth === "number" && al.textOutlineWidth > 0) {
      base.textOutlineWidth = pickNum(al.textOutlineWidth, 0, 30, 3);
      base.textOutlineColor =
        typeof al.textOutlineColor === "string" && al.textOutlineColor
          ? al.textOutlineColor
          : "#000000";
    }
    if (al.charAnimation) {
      base.charAnimation = pick<CharAnimation>(
        al.charAnimation,
        CHAR_ANIMS,
        "none",
      );
    }
    if (al.kineticAnimation) {
      base.kineticAnimation = pick<KineticAnimation>(
        al.kineticAnimation,
        KINETICS,
        "none",
      );
    }
    if (al.textDecoration) {
      base.textDecoration = pick<TextDecoration>(
        al.textDecoration,
        TEXT_DECOS,
        "none",
      );
    }
  }

  // 塗り色（color/shape/comment の背景）
  if (
    (type === "color" || type === "shape" || type === "comment") &&
    typeof al.fillColor === "string" &&
    al.fillColor
  ) {
    base.fillColor = al.fillColor;
  } else if (type === "color" || type === "shape") {
    base.fillColor = "#333333";
  }

  // image/video は source="auto"（ユーザーが後で差し替え）
  if (type === "image") {
    base.source = "auto";
  } else if (type === "video") {
    base.source = "user";
  }

  return base;
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
          temperature: 0.2,
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
    layers: AnalyzedLayer[];
  };
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new TemplateAnalysisError(
      `JSON パース失敗: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const totalDuration = pickNum(parsed.totalDuration, 1, 600, 30);

  // layers は無くても OK（その場合は全画面背景を1枚デフォルト追加）
  let layers: Layer[] = [];
  if (Array.isArray(parsed.layers) && parsed.layers.length > 0) {
    // zIndex が全部同じ or 未指定でも衝突しにくいよう、受信順で再割り当て
    layers = parsed.layers.map((l, i) => {
      const converted = toLayer(l, totalDuration);
      if (converted.zIndex === 0 || converted.zIndex == null) {
        converted.zIndex = i;
      }
      return converted;
    });
  } else {
    layers.push({
      id: genLayerId(),
      type: "image",
      source: "auto",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      zIndex: 0,
      startSec: 0,
      endSec: totalDuration,
    });
  }

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
    totalDuration,
    layers,
    overallPacing: parsed.overallPacing,
    narrationStyle: parsed.narrationStyle,
    themeVibe: parsed.themeVibe,
  };

  report("done");
  return template;
}
