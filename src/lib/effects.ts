import type {
  ColorGrade,
  Motion,
  SceneEffects,
  TransitionType,
} from "../types";

export const DEFAULT_EFFECTS: SceneEffects = {
  motion: "ken_burns",
  color: "none",
  audio_fade_in: false,
  audio_fade_out: false,
  transition_to_next: "fade",
  transition_duration: 0.5,
};

export function resolveEffects(
  effects: SceneEffects | undefined,
  opts: { isFirst?: boolean; isLast?: boolean } = {},
): SceneEffects {
  const base = { ...DEFAULT_EFFECTS, ...(effects ?? {}) };
  if (opts.isFirst) base.audio_fade_in = true;
  if (opts.isLast) {
    base.audio_fade_out = true;
    base.transition_to_next = "cut";
    base.transition_duration = 0;
  }
  return base;
}

export const MOTION_LABELS: Array<{ id: Motion; label: string }> = [
  { id: "static", label: "静止（動きなし）" },
  { id: "zoom_in", label: "ズームイン（じんわり近寄る）" },
  { id: "zoom_out", label: "ズームアウト（引いて広がる）" },
  { id: "push_in", label: "プッシュイン（ゆっくり寄る）" },
  { id: "zoom_punch", label: "ズームパンチ（冒頭で一気に寄る）" },
  { id: "ken_burns", label: "ケンバーンズ（斜めに動く）" },
  { id: "pan_left", label: "パン左" },
  { id: "pan_right", label: "パン右" },
  { id: "pan_up", label: "パン上" },
  { id: "pan_down", label: "パン下" },
  { id: "shake", label: "シェイク（揺れ・強調）" },
];

export const COLOR_LABELS: Array<{ id: ColorGrade; label: string }> = [
  { id: "none", label: "通常（無加工）" },
  { id: "vivid", label: "ヴィヴィッド（ポップ）" },
  { id: "warm", label: "ウォーム（温かみ）" },
  { id: "cool", label: "クール（知的・近未来）" },
  { id: "vintage", label: "ヴィンテージ（レトロ）" },
  { id: "sepia", label: "セピア（過去・回想）" },
  { id: "bw", label: "モノクロ（シリアス）" },
  { id: "vignette", label: "ヴィネット（ドラマチック）" },
  { id: "neon", label: "ネオン（サイバー／キラキラ）" },
  { id: "high_contrast", label: "ハイコントラスト（強調）" },
  { id: "soft_glow", label: "ソフトグロー（夢・柔らか）" },
  { id: "film_grain", label: "フィルムグレイン（エモ・フィルム調）" },
];

export const TRANSITION_LABELS: Array<{ id: TransitionType; label: string }> = [
  { id: "cut", label: "カット（瞬時切替）" },
  { id: "fade", label: "フェード（標準）" },
  { id: "flash", label: "フラッシュ（白い一瞬）" },
  { id: "fadewhite", label: "ホワイトフェード" },
  { id: "fadeblack", label: "ブラックフェード" },
  { id: "fadegrays", label: "モノクロフェード" },
  { id: "dissolve", label: "ディゾルブ（溶け込み）" },
  { id: "zoomin", label: "ズームイン切替" },
  { id: "hblur", label: "モーションブラー" },
  { id: "slideleft", label: "スライド左" },
  { id: "slideright", label: "スライド右" },
  { id: "slideup", label: "スライド上" },
  { id: "slidedown", label: "スライド下" },
  { id: "wipeleft", label: "ワイプ左" },
  { id: "wiperight", label: "ワイプ右" },
  { id: "wipeup", label: "ワイプ上" },
  { id: "wipedown", label: "ワイプ下" },
  { id: "coverleft", label: "カバー左（被せ）" },
  { id: "coverright", label: "カバー右" },
  { id: "coverup", label: "カバー上" },
  { id: "coverdown", label: "カバー下" },
  { id: "revealleft", label: "リヴィール左（めくり）" },
  { id: "revealright", label: "リヴィール右" },
  { id: "revealup", label: "リヴィール上" },
  { id: "revealdown", label: "リヴィール下" },
  { id: "diagtl", label: "斜め左上ワイプ" },
  { id: "diagtr", label: "斜め右上ワイプ" },
  { id: "diagbl", label: "斜め左下ワイプ" },
  { id: "diagbr", label: "斜め右下ワイプ" },
  { id: "circleopen", label: "サークルオープン" },
  { id: "circleclose", label: "サークルクローズ" },
  { id: "squeezev", label: "縦スクイーズ" },
  { id: "squeezeh", label: "横スクイーズ" },
  { id: "smoothleft", label: "スムーズ左" },
  { id: "pixelize", label: "ピクセル化" },
  { id: "radial", label: "ラジアル" },
];
