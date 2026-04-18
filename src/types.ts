export type Platform = "tiktok" | "reels" | "shorts";
export type Duration = 15 | 30 | 60;

export interface ScriptInput {
  topic: string;
  platform: Platform;
  duration: Duration;
  audience?: string;
  tone?: string;
  goal?: string;
  reference?: string;
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
  };
  body: BodySegment[];
  cta: {
    seconds: string;
    text: string;
    image_prompt: string;
    subtitle_style: SubtitleStyle;
    effects: SceneEffects;
  };
  hashtags: string[];
  bgm_mood: string;
}
