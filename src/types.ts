export type Platform = "tiktok" | "reels" | "shorts";
export type Duration = 15 | 30 | 60;

export type LayerType =
  | "image"
  | "video"
  | "color"
  | "shape"
  | "comment"
  | "audio"
  | "character";

export type LayerShape = "rect" | "circle" | "rounded" | "arc";

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
  | "roll-in"
  // 棒の「ちゃんと伸びる」用。scale + transform-origin で端から伸びる（opacity 1 維持）
  | "grow-up"
  | "grow-down"
  | "grow-right"
  | "grow-left"
  // shape:"arc" 専用。entry 中 arcEnd を arcStart→arcEnd まで補間して時計回りに描画
  | "arc-sweep";

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

/** 吹き出し（comment レイヤーに紐づく）の形状・しっぽ指定 */
export type BubbleShape = "rect" | "rounded" | "ellipse" | "cloud";

export interface BubbleTail {
  /** しっぽ先端のレイヤー枠内 % 座標（0〜100） */
  tipX: number;
  tipY: number;
  /** 根元の幅（レイヤー短辺に対する %、0〜40 程度） */
  baseWidth: number;
}

export interface BubbleStyle {
  shape: BubbleShape;
  tail?: BubbleTail;
}

/** キーフレーム補間の 1 点（グローバル時刻 / 値） */
export interface Keyframe {
  /** グローバル時刻 (秒) */
  time: number;
  /** そのプロパティの値 */
  value: number;
}

/** 1 プロパティ分のキーフレームトラック */
export interface KeyframeTrack {
  /** false なら無効化（レイヤーの静的値を使う） */
  enabled: boolean;
  /** 時刻順に並んでいることが望ましい（表示/エクスポート時にソートされる） */
  frames: Keyframe[];
}

/** レイヤーの各プロパティ別キーフレームトラック */
export interface LayerKeyframes {
  x?: KeyframeTrack;
  y?: KeyframeTrack;
  /** 追加倍率（1.0 = 等倍）。width/height にこれを掛けて描画される */
  scale?: KeyframeTrack;
  opacity?: KeyframeTrack;
  rotation?: KeyframeTrack;
}

/**
 * 素材のクレジット情報。
 * Live2D モデル / 音声合成キャラ / 画像素材など、
 * YouTube 概要欄に転記する必要がある素材すべてに共通。
 */
export interface AssetCredit {
  /** 制作者名 */
  author?: string;
  /** 配布元 URL */
  sourceUrl?: string;
  /** ライセンス全文（モデルに同梱されている README の内容など） */
  licenseText?: string;
  /** 動画概要欄に貼るためのクレジット表記（例: "Live2D モデル: ◯◯氏 / VOICEVOX:ずんだもん"） */
  requiredCreditText?: string;
}

/**
 * Cubism モデルが持つ標準パラメータの抽象名 → 実モデルの Parameter ID への対応表。
 * モデルによって命名 (ParamMouthOpenY / PARAM_MOUTH_OPEN_Y / Mouth_Open 等) が異なるため、
 * モデル読み込み時に自動検出してこのテーブルを埋める。
 */
export interface CubismParamMap {
  mouthOpenY?: string;
  mouthForm?: string;
  /** 母音別の口形状パラメータ（モデルが持っていれば優先利用、無ければ MouthOpenY/Form で合成） */
  mouthA?: string;
  mouthI?: string;
  mouthU?: string;
  mouthE?: string;
  mouthO?: string;
  eyeLOpen?: string;
  eyeROpen?: string;
  eyeBallX?: string;
  eyeBallY?: string;
  angleX?: string;
  angleY?: string;
  angleZ?: string;
  bodyAngleX?: string;
  bodyAngleY?: string;
  bodyAngleZ?: string;
  breath?: string;
  browLY?: string;
  browRY?: string;
}

/** 瞬きの設定。決定的な乱数で同じ系列を再現できるよう seed を持つ */
export interface BlinkConfig {
  enabled: boolean;
  /** 瞬き 1 回の継続時間 (秒)。標準 0.15 */
  duration: number;
  /** 瞬きの平均間隔 (秒)。標準 4。シードと組み合わせて時刻列を生成 */
  intervalMean: number;
  /** 間隔の揺らぎ (秒、±)。標準 1.5 */
  intervalJitter: number;
  /** 乱数シード。同じ値ならプレビューとエクスポートで瞬きタイミング完全一致 */
  seed: number;
}

/** リップシンクのソース */
export type LipsyncMode =
  /** リンク音声の VOICEVOX query JSON からモーラ駆動 (最高精度) */
  | "voicevox"
  /** リンク音声の振幅から MouthOpenY のみ駆動 (フォールバック) */
  | "rms"
  /** 完全に手動 (キーフレーム or 静止) */
  | "off";

/** 表情切替の 1 ポイント。Live2D の .exp3.json ファイル名で指定 */
export interface ExpressionKeyframe {
  /** グローバル時刻 (秒) */
  time: number;
  /** モデルが持つ expression のファイル名 (例: "smile.exp3.json") */
  expression: string;
  /** クロスフェード秒。0 で即時切替 */
  fadeIn?: number;
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
  /**
   * shape === "arc" のときのみ使用。扇形 / ドーナツセグメント描画用。
   * 角度は度。0° = 真上（12時方向）、時計回りで増加（90° = 3時方向）。
   * 半径は box の min(width, height)/2 を 1.0 とした比率。
   * arcInnerRadius = 0 ならベタ塗りの扇形（パイ）。> 0 なら中空のドーナツセグメント。
   * curio-gen のドーナツ／円グラフ用に追加。
   */
  arcStart?: number;
  arcEnd?: number;
  arcInnerRadius?: number;
  arcOuterRadius?: number;
  source?: "auto" | "user" | string;
  fillColor?: string;
  text?: string;
  fontSize?: number;
  fontColor?: string;
  /** テキストの縁取り（各文字の周囲を stroke）太さ px（0 or 未指定 = 縁取りなし） */
  textOutlineWidth?: number;
  /** テキストの縁取り色 */
  textOutlineColor?: string;
  /** テキストのフォントファミリ（CSS font-family 文字列。未指定 = システム既定スタック） */
  fontFamily?: string;
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
  /** 音声レイヤー専用: ダッキング（BGM 自動低音量化）。
   *  duckBy に列挙した layer の表示期間中、この layer の volume を duckAmount 倍に下げる。
   *  attack/release ms で線形補間して急な切替を避ける。複数 layer が同時に鳴る場合は
   *  最大下げを 1 回だけ適用（多重 duck しない）。audioFadeIn/Out とは独立に積算。 */
  duckBy?: string[];
  /** 下げ後の音量倍率 (0..1)、default 0.3 ≒ -10.5dB */
  duckAmount?: number;
  /** 下げ始める応答時間 ms (default 250) */
  duckAttackMs?: number;
  /** 戻す応答時間 ms (default 800) */
  duckReleaseMs?: number;
  /** 音声/動画レイヤー: 再生速度倍率。1.0 = 等速、0.5 = 半分、2.0 = 倍速 */
  playbackRate?: number;
  /** 動画レイヤー専用: 素材が短いときにループ再生するか（default: true） */
  videoLoop?: boolean;
  /** 動画/音声レイヤー: 素材の秒数（ファイル読み込み時にキャッシュ。ループOFF時の長さ制限に使用） */
  sourceDurationSec?: number;
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
  /** キーフレームアニメーション（最小版: x / y / scale / opacity / rotation、linear 補間） */
  keyframes?: LayerKeyframes;
  /**
   * 画像/動画の表示範囲（クロップ）。値は素材ピクセルに対する 0〜100 の % 値。
   * 未指定 = 全体表示。{x:10, y:10, width:80, height:80} なら周囲 10% を切り落とす。
   */
  crop?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /**
   * comment レイヤー用の吹き出しスタイル（バルーン形状 + しっぽ）。
   * 未指定 = 既存の shape/borderRadius 挙動（通常の矩形テキストボックス）。
   */
  bubble?: BubbleStyle;

  // -----------------------------------------------------------------------
  // character レイヤー専用フィールド (type === "character" のときのみ意味を持つ)
  // -----------------------------------------------------------------------
  /** Live2D モデルの .model3.json への絶対パス */
  modelPath?: string;
  /** @deprecated linkedAudioLayerIds に統合。読込互換のため残す */
  linkedAudioLayerId?: string;
  /**
   * リップシンク駆動元の音声レイヤー id 配列。
   * - 空 / 未指定 → 自動 (テンプレ内の全音声に時刻ベースで同期)
   * - 1 件以上指定 → その音声群だけに反応 (時刻ベース切替)
   *
   * 同じテンプレに複数キャラを置いて、キャラごとにセリフを振り分けたい時や、
   * BGM 等にキャラを反応させたくない時に使う。
   */
  linkedAudioLayerIds?: string[];
  /** リップシンクのモード */
  lipsyncMode?: LipsyncMode;
  /** モデル読み込み時に自動検出されたパラメータ名マッピング */
  cubismParamMap?: CubismParamMap;
  /** 瞬きの設定 */
  blinkConfig?: BlinkConfig;
  /** 表情のタイムライン (時刻順、複数可) */
  expressionKeyframes?: ExpressionKeyframe[];
  /** 任意の Cubism パラメータの手動上書きトラック (パラメータ ID → トラック) */
  paramOverrides?: Record<string, KeyframeTrack>;
  /**
   * 物理演算の固定ステップ FPS。
   * プレビューとエクスポートで同じ値を使うことで、髪揺れ等の物理状態が一致する。
   * 既定はテンプレートの出力 FPS と同じにする。
   */
  physicsFps?: number;
  /** 素材のクレジット情報 (モデル登録時に必須化する想定) */
  credit?: AssetCredit;
}

/** テンプレートのアスペクト。新規作成時に決定、後から変更不可。 */
export type TemplateAspect = "vertical" | "horizontal";

/** アスペクトに対応する出力解像度（編集座標系もこの値を使う）。 */
export const ASPECT_DIMENSIONS: Record<
  TemplateAspect,
  { width: number; height: number }
> = {
  vertical: { width: 1080, height: 1920 },
  horizontal: { width: 1920, height: 1080 },
};

/** テンプレに aspect が無い旧データは縦扱い（後方互換） */
export function templateAspectOf(t: { aspect?: TemplateAspect }): TemplateAspect {
  return t.aspect ?? "vertical";
}

export function templateDimensions(t: { aspect?: TemplateAspect }): {
  width: number;
  height: number;
} {
  return ASPECT_DIMENSIONS[templateAspectOf(t)];
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
  /** 縦/横。未指定 (旧テンプレ) は縦扱い */
  aspect?: TemplateAspect;
  overallPacing?: string;
  narrationStyle?: string;
  themeVibe?: string;
  /** 全レイヤーを global timeline に配置 */
  layers: Layer[];
  /** @deprecated 旧版互換: 単一動画のインポート結果。新版は importedCommentBundles を使用 */
  importedComments?: ExtractedComment[];
  /** @deprecated 旧版互換: 上の取得元情報 */
  importedCommentsSource?: {
    videoUrl: string;
    videoTitle?: string;
    channelTitle?: string;
    fetchedAt: string;
  };
  /** テンプレにインポート済みの YouTube コメント（複数動画分を保持） */
  importedCommentBundles?: CommentBundle[];
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
  /** このコメントへの返信数（トップレベルコメントのみ。返信自身は undefined） */
  replyCount?: number;
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

