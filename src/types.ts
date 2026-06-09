export type Platform = "tiktok" | "reels" | "shorts";
export type Duration = 15 | 30 | 60;

export type LayerType =
  | "image"
  | "video"
  | "color"
  | "shape"
  | "comment"
  | "audio"
  | "character"
  | "effect"
  | "icon";

export type LayerShape =
  | "rect"
  | "circle"
  | "rounded"
  | "arc"
  | "star"
  | "heart"
  | "diamond"
  | "hexagon"
  // 手書き風マーカー注釈（背景の一点を指す）。box 内に内接 / 描画。draw-on で描き進む。
  | "marker-circle" // 丸囲み（楕円ループ）
  | "marker-arrow" // 矢印（markerFrom→markerTo + ヘッド）
  | "marker-line" // 線（markerFrom→markerTo。ヘッドは markerHead 既定 none。引き出し線に流用）
  | "marker-underline" // 下線（横ラフ線）
  | "marker-strike" // 取り消し線（中央を横切る）
  | "marker-check" // レ点
  | "marker-cross" // バツ
  | "marker-brackets" // フォーカスブラケット（四隅の [ ]）
  | "marker-burst" // 集中線（焦点へ放射状）
  // 数値サージ（curio-gen 依頼書 ④）。markerFrom→markerTo を急加速イージング(expo-out)で
  // 一気に描き、終端に三角ヘッド + 着弾フラッシュ。entryAnimation:"draw-on" で駆動。
  | "marker-surge"
  // 折れ線グラフ。graphData(数値配列)を箱内にスケールして結ぶ。entryAnimation:"draw-on" で
  // 左から描き進む。線色=fillColor、太さ=markerWidth、揺れ=markerRoughness(0で直線推奨)。
  | "marker-graph";

/** 画面全体エフェクトの種類（type === "effect" の layer.effectKind で指定）。
 *  effect layer は pixel を出力せず、[startSec, endSec] の間 最終合成フレーム全体に効果を適用する。 */
export type ScreenEffectKind =
  | "shake" // 全画面シェイク（地震風の微小 translate）
  | "flash" // 白フラッシュ（章切替・カット感）
  | "vignette-pulse" // 画面端を一瞬暗く（クライマックス）
  | "zoom-punch" // 全画面 1 瞬拡大（強調）
  | "blur-burst" // 全画面 1 瞬 blur（衝撃直前の予感）
  | "colorgrade" // 色調補正（tint=色被せ / grade=彩度コントラスト・§B 雰囲気系）
  | "grain" // フィルム粒子 / 走査線（§B 雰囲気系）
  | "blur"; // 全画面 blur（区間内一定・§B 雰囲気系）

/**
 * Phase2 §B-雰囲気: colorgrade のパラメータ（type:"effect" + effectKind:"colorgrade"）。
 * `tint`=単色被せ / `grade`=彩度・コントラスト調整。`duotone` は重いため未対応。
 */
export interface ScreenEffectParams {
  /** colorgrade のモード（既定 grade）。 */
  mode?: "tint" | "duotone" | "grade";
  /** tint の色（hex）。 */
  color?: string;
  /** duotone の [暗, 明]（未対応）。 */
  colors?: [string, string];
  /** 効果の強さ 0..1（既定 0.5）。 */
  strength?: number;
  /** grain の種類（grain=粒子 / scanlines=走査線・既定 grain）。 */
  type?: "grain" | "scanlines";
  /** 全画面 blur の半径（design 基準 px・既定 6）。 */
  radius?: number;
  /** grain のアニメ速度（既定 1）。 */
  speed?: number;
}

export interface LayerBorder {
  width: number;
  color: string;
}

/** 手書き（筆順）ペン先の種類（curio-gen 依頼書「手書き筆順テキスト」）。 */
export type HandwriteTip = "chalk" | "pen" | "marker" | "pencil";

/** 手書きの下地（書く面）プリセット。ink/tip の既定値を供給する。 */
export type SurfaceKind = "none" | "blackboard" | "whiteboard" | "notebook";

/**
 * 手書きの「書き上がり後」に同じ手書きタッチで追い書きする注釈。
 * 本文を全画書き終えた直後に、ペン先が続けて引く（draw-on と同じ進捗機構に乗る）。
 * - none: なし（既定）
 * - underline: 各行の下に手書きの下線
 * - box: 本文全体を囲むラフな手書き矩形
 * - strike: 各行の中央に取り消し線（1 本）
 * - double-strike: 各行の中央に「二本線で訂正」
 */
export type HandwriteAnnotate =
  | "none"
  | "underline"
  | "box"
  | "strike"
  | "double-strike";

/**
 * 手書き「筆順」ライトオン（curio-gen 依頼書・本命）。
 * これがある text(comment) レイヤーは文字を一画ずつ「書かれていく」アニメで描画する。
 * - 日本語（漢字・かな）は KanjiVG、ASCII は Hershey 単線フォントの筆順を使う（Phase B で同梱）。
 * - 字形データが無い文字は char-sweep（左→右の掃引出現）に自動フォールバック（絶対に壊れない）。
 * - `[startSec, startSec + writeDur]` で書き上がり、その後 endSec まで静止。停止/編集中は全文表示(p=1)。
 * - 決定論的（seed=layer.id）で preview/export 一致。
 */
export interface HandwriteSpec {
  /** 書き順（既定 "normal"＝読み順）。将来 "random" 等の拡張余地。 */
  order?: "normal";
  /** 自動算出した書き秒への倍率（既定 1。大きいほど速い）。 */
  speed?: number;
  /** ペン先表現（未指定は surface プリセットの既定）。 */
  tip?: HandwriteTip;
  /** 手書きの揺れ 0..2（既定 0.3・fontPx 比例で字形が崩れない程度に控えめ）。 */
  jitter?: number;
  /** 線の太さ design(360) 基準 px（未指定 ≒ fontSize*0.07）。 */
  strokeWidth?: number;
  /**
   * 書き味の緩急 0..1（既定 0・人による速度のばらつき）。
   * 画ごとに書く速度を決定論乱数（seed=layer.id）で揺らす。0=一定（従来どおり）、
   * 1=最も大きく緩急がつく。order(書き順)は変えない（ランダム筆順ではない）。
   */
  tempo?: number;
  /** 書き上がり後に追い書きする注釈（下線/囲み/取り消し/二本線訂正）。既定 none。 */
  annotate?: HandwriteAnnotate;
  /** 注釈の色（未指定なら本文インク色 ink を流用）。訂正を赤にしたい時などに使う。 */
  annotateColor?: string;
}

/**
 * native counter（curio-gen 依頼書 ①）。数字を from→to へ滑らかにカウントアップする。
 * comment レイヤーの `counter` に持たせる。`layer.text` より優先して表示文字列を決める。
 * - 進捗 p = clamp((tSec - startSec) / durationSec, 0, 1) を ease 適用 → value = from + (to-from)*easedP。
 * - 整形: decimals で四捨五入 → separator が true なら3桁区切り → prefix/suffix で前後を挟む。
 * - preview/export は同一の computeCounterText（src/lib/counterText.ts）で算出し一致させる。
 */
export interface CounterSpec {
  from: number;
  to: number;
  durationSec: number; // startSec 起点で from→to にかける秒数（<=0 は無効＝to を静的表示）
  prefix?: string; // 数値の前（例 "¥" "$"）
  suffix?: string; // 数値の後（例 "マルク" "円" "%"）
  separator?: boolean; // 3桁区切りカンマ（既定 true）
  decimals?: number; // 小数桁（既定 0）
  ease?: "out" | "linear" | "in" | "inout"; // 既定 "out"
  /** 表示方式。"roll"=オドメーター（各桁が縦にロールする機械式カウンター）。既定 "plain"（通常テキスト）。 */
  style?: "plain" | "roll";
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
  | "arc-sweep"
  // marker-* 専用。ペン先が entryDuration で進み、その進捗ぶんだけストロークが現れる
  | "draw-on"
  // テキスト専用（curio-gen 依頼書 ③）。縦に潰れて(scaleY 1→0)、中央で text→flipTo に
  // 差し替え、後半 0→1 で戻るパタパタ式の値札フリップ。flipTo / flipAtSec と併用。
  | "flip-swap"
  // 判子のように大きく現れて叩きつけ、わずかに反動して定位置に収まる（強調・インパクト）。
  | "stamp";

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
  | "float"
  | "spin"
  | "drift"
  | "sway"
  | "orbit"
  | "jelly";

/** 文字単位のアニメ（テキスト専用） */
export type CharAnimation =
  | "none"
  | "typewriter"
  | "stagger-fade"
  | "wave"
  | "color-shift"
  | "drop-in"
  | "bounce-in"
  | "rainbow"
  | "slide-left"
  | "slide-right"
  | "pop-each"
  | "shake-each"
  | "blink-each"
  | "scale-pulse-each";

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

/** テキストのグラデーション塗り（fontColor の代わり）。angle: 度（0=横 左→右 / 90=縦 上→下・既定90）。 */
export interface TextGradient {
  from: string;
  to: string;
  angle?: number;
}

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

/** easing 語彙（curio-gen アニメ仕様 §5）。未知値は linear フォールバック。 */
export type KeyframeEase =
  | "linear"
  | "easeInQuad"
  | "easeOutQuad"
  | "easeInOutQuad"
  | "easeInCubic"
  | "easeOutCubic"
  | "easeInOutCubic"
  | "easeInBack"
  | "easeOutBack"
  | "easeInOutBack"
  | "easeInElastic"
  | "easeOutElastic"
  | "easeInOutElastic"
  | "easeInBounce"
  | "easeOutBounce"
  | "easeInOutBounce";

/**
 * curio-gen アニメ仕様 (P0) のキーフレーム 1 点。
 * `t` は layer.startSec からの**相対秒**。指定したプロパティのみ補間対象。
 * `ease` は「直前 KF → この KF」区間のカーブ（先頭 KF の ease は無視）。
 * 既存のプロパティ別 `keyframes`(LayerKeyframes) とは別系統で、`kfs` があれば優先評価する。
 */
export interface AnimKeyframe {
  t: number;
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  opacity?: number;
  /** Phase2 §A2: 幅 %（キャンバス基準・絶対値）。anchor を基準に伸縮。scale と併用時はこちら優先。 */
  width?: number;
  /** Phase2 §A2: 高さ %（キャンバス基準・絶対値）。anchor を基準に伸縮。 */
  height?: number;
  /** Phase2 §A3: 塗り色（hex）。sRGB 線形補間。 */
  fillColor?: string;
  /** Phase2 §A3: 文字色（hex）。 */
  fontColor?: string;
  /** Phase2 §A3: 文字縁取り色（hex）。 */
  textOutlineColor?: string;
  /** Phase2 §A3: 角丸半径（数値・design 基準）。 */
  borderRadius?: number;
  ease?: KeyframeEase;
}

/**
 * Phase2 §A1: レイヤーの基準点（scale / width / height の伸縮の固定点）。
 * 既定 center。例: `left` ＋ width を 0→100% に補間 = 左端から右へ伸びるバー。
 * ※ 現状 rotation の基準点には適用しない（回帰回避のため scale/サイズのみ）。
 * フィールド未指定なら従来挙動（kfs scale は左上基準）を維持する。
 */
export type LayerAnchor =
  | "center"
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

/**
 * Phase2 §A6: レイヤー単体に掛ける視覚フィルタ（任意のサブセット指定）。
 * glow/blur/shadow は CSS/Canvas の filter 文字列（drop-shadow/blur）で preview=export 一致。
 * tint（着色）は filter 文字列では表現困難なため現状**未適用**（型では受ける）。
 * px 値（radius/blur/dx/dy）は design(360) 基準で、描画解像度へ pxScale 換算する。
 */
export interface LayerFilter {
  /** 発光。color＋strength(0..1, alpha化) で drop-shadow を重ねる。 */
  glow?: { color?: string; strength?: number; radius?: number };
  /** ぼかし。 */
  blur?: { radius?: number };
  /** 影。color は #RRGGBBAA 可。 */
  shadow?: { dx?: number; dy?: number; blur?: number; color?: string };
  /** 着色（現状未適用）。 */
  tint?: { color?: string; strength?: number };
}

/**
 * Phase2 §B: 描画系 effect（type:"effect" で領域にピクセルを描くオーバーレイ）。
 * 既存 `effectKind`（ScreenEffectKind＝全画面後処理）とは別系統で、こちらは zIndex 位置に描く。
 * 1 レイヤーで effect（描画系）か effectKind（後処理系）のどちらかを使う。
 */
export type DrawnEffectKind =
  | "speedlines"
  | "spotlight"
  | "particles"
  // 湯気/立ち上る粒子オーバーレイ（curio-gen 依頼書 ②）。origin から上へ昇って薄れる。
  | "steam";

/** 描画系 effect のパラメータ（effect ごとに使う項目が異なる・全て任意）。 */
export interface DrawnEffectParams {
  /** 中心 [x,y]（レイヤー領域に対する %・既定 [50,50]） */
  center?: [number, number];
  /** 線の色（speedlines） */
  color?: string;
  /** speedlines: 線の本数 */
  density?: number;
  /** speedlines: 線の太さ（design 基準 px） */
  thickness?: number;
  /** speedlines: 中心の空き半径比（0..1） */
  gapRatio?: number;
  /** spotlight: 明るい中心の半径（min(w,h) に対する %） */
  radius?: number;
  /** spotlight: 周辺の暗さ（0..1） */
  dim?: number;
  /** spotlight: 減光の柔らかさ（0..1） */
  softness?: number;
  /** アニメ（§B 拡張・アメコミ風・既定 none）。flicker=コマ送りちらつき / pulse=脈動 / spin=回転。 */
  animate?: "none" | "flicker" | "pulse" | "spin";
  /** アニメ速度倍率（既定 1）。 */
  speed?: number;
  // ---- particles 用（§D）----
  /** particles の種類。 */
  kind?:
    | "fall"
    | "confetti"
    | "sparkle"
    | "money"
    | "dust"
    | "heart"
    | "star"
    | "bubble"
    | "spark"
    | "snow"
    | "rain"
    | "leaves"
    | "petals"
    | "smoke";
  /** particles: 生成レート（個/秒）。 */
  rate?: number;
  /** particles: 生成総数の上限（必須級・上限到達で生成停止）。 */
  count?: number;
  /** particles: 重力（落下加速の倍率・既定1）。 */
  gravity?: number;
  /** particles: 横風（既定0）。 */
  wind?: number;
  /** particles: 生成領域 [x,y,w,h]（%・既定 画面上部外 [0,-5,100,10]）。 */
  region?: [number, number, number, number];
  /** particles: サイズ範囲 [min,max]（design px）。 */
  sizeRange?: [number, number];
  // ---- steam 用（§②・湯気/立ち上る粒子）----
  /** steam: 横揺れの広がり幅（design px・既定 26）。上昇に従って広がる。 */
  spread?: number;
  /** steam: 上昇量（design px。未指定ならレイヤー高さの約 60%）。 */
  rise?: number;
}

/**
 * curio-gen アニメ仕様 P1 (§6) の `kfs` ループ設定。
 * - `kfs` 列を生存中ループ再生する。1 ループ長 = 最終 KF の `t`。
 * - `restart`: 頭から繰り返し / `yoyo`: 順再生→逆再生で往復。
 * - `count`: 回数（yoyo は 1 往復 = 1 回）。`null`/省略で無限（生存区間いっぱい）。
 *   restart は count 回後に最終 KF 値で停止、yoyo は count 往復後に先頭 KF 値で停止。
 * 仕様書のフィールド名は `keyframeLoop` だが、shorts-script-gen は `kfs` と揃えた
 * `kfsLoop` を正とし、`keyframeLoop` もエイリアスで受ける（curio-gen がどちらで emit しても動く）。
 */
export interface KeyframeLoop {
  mode: "restart" | "yoyo";
  count?: number | null;
}

/**
 * curio-gen アニメ仕様 P3 (§8): 位置 (x,y) を Catmull-Rom 曲線で駆動。
 * - `points`: % 座標（layer.x/y と同じ・左上基準）の通過点。曲線はこれらを滑らかに通る。
 * - `scale`/`rotation`/`opacity` は kfs 側で指定する（motionPath は位置のみ）。
 * - kfs と x,y が両方あれば **motionPath を優先**（排他運用推奨）。
 * - `duration` 省略時 = 生存長（endSec - startSec）。`loop` で周回。
 */
export interface MotionPath {
  points: [number, number][];
  ease?: KeyframeEase;
  duration?: number;
  loop?: boolean;
}

/** reveal（ワイプ/クリップ表示）の方向（Phase2 §A4）。 */
export type RevealDirection =
  | "left-to-right"
  | "right-to-left"
  | "top-to-bottom"
  | "bottom-to-top"
  | "center-out"
  | "radial";

/**
 * curio-gen アニメ仕様 Phase2 §A4: reveal（クリップ/ワイプ表示）。
 * レイヤー内容を `direction` に沿って 0%→100% にクリップ表示する。
 * 細い矩形＝「線が描かれる」、バー＝「塗りで満ちる」、文字＝「ワイプで出る」。
 * `t`（既定0・startSec 相対秒）から `duration`（既定0.6s）かけて ease で進捗。
 * transform ではなくクリップなので keyframes/motionPath と併用可。
 */
export interface RevealSpec {
  direction: RevealDirection;
  t?: number;
  duration?: number;
  ease?: KeyframeEase;
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

/** 画像/動画を切り抜くマスクの形状（図形マスク用）。 */
export type MaskShapeKind =
  | "circle"
  | "rounded"
  | "rect"
  | "star"
  | "heart"
  | "diamond"
  | "hexagon";

/** 画像/動画レイヤーのマスク（文字型 or 図形型でくり抜く）。 */
export type LayerMask =
  | {
      type: "text";
      /** くり抜く文字。箱幅に自動フィットして大きく表示する。 */
      text: string;
      /** フォントファミリ（未指定 = システム既定スタック）。 */
      fontFamily?: string;
    }
  | {
      type: "shape";
      shape: MaskShapeKind;
      /** rounded の角丸半径（design 360 基準 px・既定 24）。 */
      borderRadius?: number;
    };

/** カメラ/グループ変換の基準点（名前指定）。グループのバウンディングボックス上の点に解決される。 */
export type StagePivot =
  | "center"
  | "top-left"
  | "top"
  | "top-right"
  | "left"
  | "right"
  | "bottom-left"
  | "bottom"
  | "bottom-right";

/**
 * カメラ変換のキーフレーム（Phase3 §2-2）。`t` はカメラの startSec 起点の相対秒。
 * scale=拡大率 / x,y=平行移動 %（キャンバス基準）/ opacity=倍率。
 */
export interface CameraKeyframe {
  t: number;
  scale?: number;
  x?: number;
  y?: number;
  opacity?: number;
  ease?: KeyframeEase;
}

/**
 * カメラ変換（Phase3 §2 C-1）。`groupId` 一致レイヤーの描画結果に、pivot 基準の
 * scale + 平行移動を「上から」乗算する。メンバー自身の entry/draw-on/kfs はそのまま生きる
 * （描きながらズーム、を同時実現）。`startSec` 外では恒等（変換なし）。kfs は startSec 起点の相対秒。
 */
export interface CameraSpec {
  groupId: string;
  /** カメラが有効な区間。startSec 未満は恒等。未指定なら kfs t を絶対秒として扱う。 */
  startSec?: number;
  endSec?: number;
  /** 変換の基準点（名前 or [x,y]%・既定 center＝グループ bbox 中心）。 */
  pivot?: StagePivot | [number, number];
  kfs: CameraKeyframe[];
}

/**
 * レイヤーグループ（ステージ）の変換キーフレーム（絶対秒 t で補間）。
 * offset は % (キャンバス基準)、scale 倍率、opacity 倍率。
 */
export interface LayerGroupKeyframe {
  t: number;
  offsetX?: number;
  offsetY?: number;
  scale?: number;
  opacity?: number;
  ease?: KeyframeEase;
}

/**
 * レイヤーグループ（ステージ）。`Layer.groupId` で所属させた複数レイヤーを
 * ひとまとまりとして一括で縮小/移動/フェードする。ctx 変換で包むので位置だけでなく
 * 文字サイズ・線幅も一緒に正しくスケールする。preview/export とも renderLayersOnContext で適用。
 */
export interface LayerGroup {
  id: string;
  /** 移動量 %（キャンバス基準・既定 0）。 */
  offsetX?: number;
  offsetY?: number;
  /** 拡大率（pivot 基準・既定 1）。 */
  scale?: number;
  /** 不透明度倍率（既定 1）。 */
  opacity?: number;
  /** 拡大の基準点（名前 or [x,y]%・既定はグループ bbox 中心）。 */
  pivot?: StagePivot | [number, number];
  /** 変換を時間で動かすキーフレーム（絶対秒）。あれば静的値より優先。 */
  kfs?: LayerGroupKeyframe[];
}

/**
 * 崩壊/砂化エフェクト（Phase3 §6・exit 系）。対象（text/image/shape/color）の描画ピクセルを
 * 粒に分解し、崩落/飛散させて消す。`color:"inherit"` で本体のピクセル色を継承（その物が崩れた感）。
 * `t`(startSec相対秒) で崩壊開始、`duration` で崩れ切り、以降 endSec まで非表示。kfs/entry と独立。
 */
export interface DisintegrateSpec {
  /** 崩壊開始（startSec 相対秒・既定 0）。 */
  t?: number;
  /** 崩れ切るまでの秒（既定 1.2）。 */
  duration?: number;
  /** 崩れ方（既定 "down"=落下 / "up"=舞い上がる / "scatter"=四散）。 */
  direction?: "down" | "up" | "scatter";
  /** 落下の強さ（既定 1）。 */
  gravity?: number;
  /** 粒のサイズ目安 px（design 360 基準・既定 8。小=砂 / 大=破片）。 */
  cell?: number;
  /** 粒の色。"inherit"(既定)=本体ピクセル色を継承 / "#hex"=単色。 */
  color?: "inherit" | string;
  /** 落ちながらフェードアウト（既定 true）。 */
  fade?: boolean;
  /** 動きのイージング（既定 easeInQuad）。 */
  ease?: KeyframeEase;
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
  /**
   * shape === "marker-*" のときのみ使用（手書き風マーカー注釈）。
   * 線色は fillColor（既定 赤 #FF3B30）。preview/export で同一 jitter（seed = layer.id）。
   */
  markerWidth?: number; // 線の太さ px（design 360 基準。描画時 *pxScale）。既定 6
  markerRoughness?: number; // 手書き揺れ量 0..2。既定 1.0
  markerFrom?: { x: number; y: number }; // marker-arrow/line 始点（box 内 %）。既定 左下
  markerTo?: { x: number; y: number }; // marker-arrow/line 終点（box 内 %）。既定 右上
  markerHead?: "none" | "triangle" | "open"; // marker-arrow/line の先端ヘッド。triangle=塗り三角 / open=手書き風の開いた矢じり(2本線)。既定 arrow=triangle / line=none
  markerCount?: number; // marker-burst の集中線本数。既定 12
  markerOvershoot?: number; // marker-surge の終端オーバーシュート量（線長比 0..0.5。既定 0.1）
  graphData?: number[]; // marker-graph 用のデータ値配列（最小2点）。箱内に min..max でスケール
  source?: "auto" | "user" | string;
  /**
   * type === "icon" 専用: 同梱 Lucide 線アイコンの名前（例 "coffee" / "wallet"）。
   * 別名（"yen"→"japanese-yen" 等）も解決する。未知名は placeholder（破線四角＋名前）で描画。
   * 線/塗りの色は `fillColor`（既定 #FFFFFF）、線の太さは `iconStrokeWidth`（24-viewBox 単位・既定 2）。
   * box 内は contain（縦横比保持・中央・切れない）。kfs の fillColor 補間で色アニメも可。
   */
  icon?: string;
  /** type === "icon" 専用: 線の太さ（24-viewBox 単位・既定 2）。アイコン拡大に従い太さも拡大。 */
  iconStrokeWidth?: number;
  fillColor?: string;
  /** color/shape の塗りをグラデーションに（fillColor より優先・rect/rounded/circle に適用）。 */
  fillGradient?: TextGradient;
  /**
   * 画像/動画レイヤーのクロマキー（指定色を透明化して背景と合成）。
   * threshold/smoothness は 0〜1（色距離の許容と境界のぼかし）。重いので必要時のみ。
   */
  chromaKey?: { color: string; threshold?: number; smoothness?: number };
  text?: string;
  /**
   * native counter（curio-gen 依頼書 ①）。これがある comment レイヤーは layer.text を無視し、
   * startSec 起点で from→to を durationSec かけて補間した文字列を毎フレーム表示する。
   * 停止/編集中（preview ドラッグ中・静的合成）は to（最終値）を表示してレイアウトを安定させる。
   * fontSize / fontColor / entry / ambient / textDecoration 等と独立に併用可。
   */
  counter?: CounterSpec;
  /** entryAnimation:"flip-swap" の切替後テキスト（③）。中央(scaleY=0)で text→flipTo に差し替え。 */
  flipTo?: string;
  /** flip-swap の切替タイミング（startSec 相対秒・既定 entryDuration/2＝scaleY が 0 になる中央）。 */
  flipAtSec?: number;
  /** 手書き（筆順）ライトオン。存在で手書きレンダラに切替（主に comment レイヤー）。 */
  handwrite?: HandwriteSpec;
  /** 手書きの下地（黒板/ホワイトボード/ノート/なし）。ink/tip の既定値を供給。 */
  surface?: SurfaceKind;
  fontSize?: number;
  fontColor?: string;
  /** テキストのグラデーション塗り（fontColor より優先・現状は静的テキストに適用）。 */
  textGradient?: TextGradient;
  /** テキストの縁取り（各文字の周囲を stroke）太さ px（0 or 未指定 = 縁取りなし） */
  textOutlineWidth?: number;
  /** テキストの縁取り色 */
  textOutlineColor?: string;
  /** テキストのフォントファミリ（CSS font-family 文字列。未指定 = システム既定スタック） */
  fontFamily?: string;
  motion?: Motion;
  /** 所属するレイヤーグループ（ステージ）の id。VideoTemplate.groups の id と対応。 */
  groupId?: string;
  /** 崩壊/砂化エフェクト（exit 系・自身のピクセルを粒に分解して崩落させる）。 */
  disintegrate?: DisintegrateSpec;
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
  /** type === "effect" 専用: 画面全体エフェクトの種類 */
  effectKind?: ScreenEffectKind;
  /** type === "effect" 専用: 強度 (0..2, default 1.0)。
   *  shake の translate 幅などを共通制御する。 */
  effectIntensity?: number;
  /** type === "effect" 専用: 描画系 effect の種類（speedlines/spotlight・§B）。
   *  effectKind（全画面後処理）とは別系統。これがあれば zIndex 位置に描画する。 */
  effect?: DrawnEffectKind;
  /** 描画系 effect のパラメータ（§B）。 */
  effectParams?: DrawnEffectParams;
  /** type === "effect" + effectKind:"colorgrade" 専用: 色調補正パラメータ（§B 雰囲気系）。 */
  screenEffectParams?: ScreenEffectParams;
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
  /**
   * Ambient の速度倍率（curio-gen アニメ仕様 §7・新規・デフォルト 1.0）。
   * 全 ambient の周期時間に乗算する（spin/drift だけでなく既存 pulse/shake 等にも効く）。
   */
  ambientSpeed?: number;
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
   * curio-gen アニメ仕様 P0 のキーフレーム列（時刻 t 昇順・startSec 相対秒・per-KF easing）。
   * これがあるレイヤーは entry/exit/motion を無視し kfs で駆動（ambient は加算）。
   * UI 編集の `keyframes`(LayerKeyframes) より優先。curio-gen が emit する用。
   */
  kfs?: AnimKeyframe[];
  /**
   * curio-gen アニメ仕様 P1 (§6): `kfs` のループ/往復設定。
   * `kfs` が無ければ無視。仕様書名 `keyframeLoop` もエイリアスで受ける（下記）。
   */
  kfsLoop?: KeyframeLoop;
  /** 仕様書 §6 の名称。`kfsLoop` 未指定時のフォールバックとして読む。 */
  keyframeLoop?: KeyframeLoop;
  /**
   * curio-gen アニメ仕様 P3 (§8): 位置を曲線で駆動する motionPath。
   * これがある層は位置を曲線で完全駆動するため entry/exit/motion を抑止（kfs と同様 _kfsDriven）。
   */
  motionPath?: MotionPath;
  /**
   * curio-gen アニメ仕様 Phase2 §A4: reveal（クリップ/ワイプ表示）。
   * transform ではなくクリップなので kfs/motionPath/entry 等と併用可。
   */
  reveal?: RevealSpec;
  /**
   * Phase2 §A1: scale / width / height の伸縮基準点（既定 center）。
   * 未指定なら従来挙動（kfs scale は左上基準）を維持。
   */
  anchor?: LayerAnchor;
  /** Phase2 §A6: レイヤー単体の視覚フィルタ（glow/blur/shadow。tint は未適用）。 */
  filter?: LayerFilter;
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
  /**
   * 画像/動画レイヤーを「文字の形」または「図形の形」でくり抜いて表示するマスク。
   * 内側だけ素材が見え、外は透明。canvas 経路（書き出し表示=export）で描く。
   * - text: 指定文字の形に素材を流し込む（フォントは箱幅に自動フィット）。
   * - shape: 円/角丸/星/ハート/ダイヤ/六角形/矩形の形にくり抜く。
   */
  mask?: LayerMask;

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

/**
 * Phase2 §C: 場面転換トランジション（top-level transitions[]）。
 * `atSec` を中心に ±duration/2 の窓で最終合成フレーム全体に適用する。
 * 実装済み: `fade-black`（暗転）/ `zoom`（ズーム切替）。
 * `wipe`/`push`/`dissolve` は前後フレーム合成が必要なため**未対応**（型では受けるが無視）。
 */
export type TransitionStyle =
  | "fade-black"
  | "wipe"
  | "push"
  | "zoom"
  | "dissolve"
  | "glitch"
  | "circle-wipe"
  | "blinds";

export interface TransitionSpec {
  atSec: number;
  style: TransitionStyle;
  /** 効果の長さ（秒・既定0.5）。atSec を中心に前後 duration/2。 */
  duration?: number;
  /** wipe/push の方向（現状未使用）。 */
  direction?: "left-to-right" | "right-to-left" | "up" | "down";
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
  /** Phase2 §C: 場面転換（fade-black/zoom のみ適用、wipe/push/dissolve は未対応）。 */
  transitions?: TransitionSpec[];
  /** レイヤーグループ（ステージ）。Layer.groupId で所属。一括縮小/移動/フェード用。 */
  groups?: LayerGroup[];
  /** カメラ変換（Phase3 C-1）。groupId 一致レイヤーに pivot 基準の scale+移動を上掛け。 */
  cameras?: CameraSpec[];
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
  /**
   * エクスポート時のラウドネス正規化設定。
   * 全 audio レイヤーをミックスダウンした最終バッファ全体に対し 1 回だけゲイン補正をかけ、
   * 動画間で体感音量を揃える（YouTube は約 -14 LUFS 基準）。
   * 未指定（旧テンプレ）は正規化なし＝従来挙動（前方互換）。
   * preview には適用しない（最終成果物の音量統一が目的のためエクスポート専用）。
   */
  audioNormalize?: AudioNormalizeSettings;
}

export interface AudioNormalizeSettings {
  /** 正規化を行うか。既定 true */
  enabled: boolean;
  /** 目標積分ラウドネス（LUFS）。既定 -14（YouTube 推奨） */
  targetLufs: number;
  /** トゥルーピーク（サンプルピーク）上限（dBTP）。既定 -1.0。これを超えないようゲインを頭打ち */
  truePeakCeilingDb: number;
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

