export type Platform = "tiktok" | "reels" | "shorts";
export type Duration = 15 | 30 | 60;

export type LayerType =
  | "image"
  | "video"
  | "color"
  | "shape"
  | "comment"
  | "audio";

export type LayerShape = "rect" | "circle" | "rounded";

export interface LayerBorder {
  width: number;
  color: string;
}

export type EntryAnimation =
  | "none"
  | "fade"
  | "slide-left"
  | "slide-right"
  | "slide-up"
  | "slide-down"
  | "zoom-in"
  | "pop"
  | "blur-in"
  | "elastic-pop"
  | "flip-in"
  | "stretch-in"
  | "roll-in";

export type ExitAnimation =
  | "none"
  | "fade"
  | "slide-left"
  | "slide-right"
  | "slide-up"
  | "slide-down"
  | "zoom-out"
  | "blur-out"
  | "flip-out"
  | "stretch-out"
  | "roll-out";

/** 表示中ずっと続くアニメ（呼吸・揺れ・点滅等） */
export type AmbientAnimation =
  | "none"
  | "pulse"
  | "shake"
  | "wiggle"
  | "bounce"
  | "blink"
  | "glow-pulse"
  | "rainbow"
  | "float";

/** 文字単位のアニメ（テキスト専用） */
export type CharAnimation =
  | "none"
  | "typewriter"
  | "stagger-fade"
  | "wave"
  | "color-shift";

/** 単語単位のキネティック演出（テキスト専用） */
export type KineticAnimation =
  | "none"
  | "word-pop"
  | "keyword-color"
  | "slide-stack"
  | "zoom-talk";

/** テキスト装飾（背景帯・下線スイープ・ネオン等） */
export type TextDecoration =
  | "none"
  | "highlight-bar"
  | "underline-sweep"
  | "neon"
  | "outline-reveal"
  | "shadow-drop";

/** @deprecated v1 互換用。新コードは Layer を使用 */
export interface LayerV1 {
  id: string;
  type: LayerType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  opacity?: number;
  zIndex: number;
  shape?: LayerShape;
  borderRadius?: number;
  border?: LayerBorder;
  source?: "auto" | "user" | string;
  fillColor?: string;
  text?: string;
  fontSize?: number;
  fontColor?: string;
  motion?: Motion;
}

/** v2 Timeline 型レイヤー */
export interface Layer {
  id: string;
  type: LayerType;
  /** Canvas 内 % 座標（左上基準）。画面解像度非依存 */
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  opacity?: number;
  zIndex: number;
  shape?: LayerShape;
  borderRadius?: number;
  border?: LayerBorder;
  source?: "auto" | "user" | string;
  fillColor?: string;
  text?: string;
  fontSize?: number;
  fontColor?: string;
  motion?: Motion;
  /** タイムライン上の開始秒（動画全体の何秒目に表示開始） */
  startSec: number;
  /** タイムライン上の終了秒 */
  endSec: number;
  /** 入場アニメーション */
  entryAnimation?: EntryAnimation;
  /** 入場アニメーションの秒数（デフォルト 0.3） */
  entryDuration?: number;
  /** 退場アニメーション */
  exitAnimation?: ExitAnimation;
  /** 退場アニメーションの秒数 */
  exitDuration?: number;
  /** true のとき編集中は非表示かつ書き出しからも除外 */
  hidden?: boolean;
  /** true のときドラッグ/リサイズ/プロパティ編集を禁止 */
  locked?: boolean;
  /** 音声レイヤー専用: 0..1 の音量 */
  volume?: number;
  /** 音声レイヤー専用: フェードイン秒 */
  audioFadeIn?: number;
  /** 音声レイヤー専用: フェードアウト秒 */
  audioFadeOut?: number;
  /** 音声レイヤー専用: 素材が短いときにループ再生するか */
  audioLoop?: boolean;
  /** テキストレイヤー専用: このテキストから生成された音声レイヤーの id（置き換え用） */
  generatedNarrationLayerId?: string;
  /** 表示中ずっと続くアニメ（Ambient）。入退場と複合可 */
  ambientAnimation?: AmbientAnimation;
  /** Ambient の強度（0〜1 の倍率、デフォルト 1） */
  ambientIntensity?: number;
  /** 文字単位のアニメ（テキスト専用） */
  charAnimation?: CharAnimation;
  /** 単語単位のキネティック（テキスト専用） */
  kineticAnimation?: KineticAnimation;
  /** テキスト装飾 */
  textDecoration?: TextDecoration;
  /** キーワード強調時の色（keyword-color で使用） */
  keywordColor?: string;
}

export interface TemplateSegment {
  id: string;
  type: "hook" | "body" | "cta";
  /** type="body" のとき台本 body[i] の i */
  bodyIndex?: number;
  startSec: number;
  endSec: number;
  color?: ColorGrade;
  transitionTo?: TransitionType;
  transitionDuration?: number;
}

export interface VideoTemplate {
  version: 2;
  id: string;
  name: string;
  note?: string;
  sourceUrl?: string;
  sourceTitle?: string;
  sourceChannel?: string;
  createdAt: string;
  totalDuration: number;
  overallPacing?: string;
  narrationStyle?: string;
  themeVibe?: string;
  /** 全レイヤーを global timeline に配置 */
  layers: Layer[];
  /** 台本マッピング用のセグメント（hook/body/cta） */
  segments: TemplateSegment[];
}

export interface ReferenceVideo {
  videoId: string;
  title: string;
  channelTitle: string;
  viewCount: number;
  likeCount?: number;
  description: string;
  hashtags: string[];
  transcript: string;
  topComments: string[];
  publishedAt?: string;
}

export interface ReferenceBundle {
  query: string;
  fetchedAt: string;
  videos: ReferenceVideo[];
  promptText: string;
}

export interface ExtractedComment {
  id: string;
  text: string;
  author?: string;
  likeCount: number;
  isReply: boolean;
  parentId?: string;
  publishedAt?: string;
}

export interface CommentBundle {
  videoId: string;
  videoUrl: string;
  videoTitle?: string;
  channelTitle?: string;
  fetchedAt: string;
  comments: ExtractedComment[];
}

export interface ScriptInput {
  topic: string;
  platform: Platform;
  duration: Duration;
  audience?: string;
  tone?: string;
  goal?: string;
  reference?: string;
  trendInsights?: string;
  performanceInsights?: string;
  referenceBundle?: ReferenceBundle;
  template?: VideoTemplate;
  selectedComments?: ExtractedComment[];
  /** マニュアルモード（AI画像生成をスキップ、ユーザー指定レイヤーのみで合成） */
  manualMode?: boolean;
}

export interface SubtitleStyle {
  primary_color: string;
  outline_color: string;
  font_size: "md" | "lg" | "xl";
  emoji: string;
  background: "none" | "dark" | "highlight";
  emphasis_keyword: string;
}

export type Motion =
  | "static"
  | "zoom_in"
  | "zoom_out"
  | "pan_left"
  | "pan_right"
  | "pan_up"
  | "pan_down"
  | "ken_burns"
  | "push_in"
  | "zoom_punch"
  | "shake";

export type ColorGrade =
  | "none"
  | "sepia"
  | "bw"
  | "vintage"
  | "vivid"
  | "cool"
  | "warm"
  | "vignette"
  | "neon"
  | "high_contrast"
  | "soft_glow"
  | "film_grain";

export type TransitionType =
  | "cut"
  | "fade"
  | "fadeblack"
  | "fadewhite"
  | "fadegrays"
  | "flash"
  | "slideleft"
  | "slideright"
  | "slideup"
  | "slidedown"
  | "dissolve"
  | "zoomin"
  | "circleopen"
  | "circleclose"
  | "wipeleft"
  | "wiperight"
  | "wipeup"
  | "wipedown"
  | "pixelize"
  | "smoothleft"
  | "radial"
  | "hblur"
  | "squeezev"
  | "squeezeh"
  | "coverleft"
  | "coverright"
  | "coverup"
  | "coverdown"
  | "revealleft"
  | "revealright"
  | "revealup"
  | "revealdown"
  | "diagtl"
  | "diagtr"
  | "diagbl"
  | "diagbr";

export interface SceneEffects {
  motion: Motion;
  color: ColorGrade;
  audio_fade_in: boolean;
  audio_fade_out: boolean;
  transition_to_next: TransitionType;
  transition_duration: number;
}

export interface BodySegment {
  seconds: string;
  narration: string;
  visual: string;
  image_prompt: string;
  text_overlay: string;
  subtitle_style: SubtitleStyle;
  effects: SceneEffects;
  image_path?: string;
}

export interface Script {
  title: string;
  theme_vibe: string;
  hook: {
    seconds: string;
    text: string;
    visual: string;
    image_prompt: string;
    subtitle_style: SubtitleStyle;
    effects: SceneEffects;
    image_path?: string;
  };
  body: BodySegment[];
  cta: {
    seconds: string;
    text: string;
    image_prompt: string;
    subtitle_style: SubtitleStyle;
    effects: SceneEffects;
    image_path?: string;
  };
  hashtags: string[];
  bgm_mood: string;
}
