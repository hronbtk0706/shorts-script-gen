import type {
  BodySegment,
  CommentBundle,
  ExtractedComment,
  Script,
  SubtitleStyle,
  SceneEffects,
  VideoTemplate,
} from "../types";

const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  primary_color: "#FFE600",
  outline_color: "#000000",
  font_size: "lg",
  emoji: "",
  background: "none",
  emphasis_keyword: "",
};

const DEFAULT_EFFECTS: SceneEffects = {
  motion: "static",
  color: "none",
  audio_fade_in: false,
  audio_fade_out: false,
  transition_to_next: "cut",
  transition_duration: 0,
};

function fmtSeconds(start: number, end: number): string {
  return `${start.toFixed(1)}-${end.toFixed(1)}`;
}

/**
 * マニュアルモード用の Script を組み立てる。
 * セグメントの概念を持たないテンプレートに対応：
 * テンプレート全体を1つのbodyとして扱い、コメント型レイヤーのテキストを連結する。
 */
export function buildManualScript(
  template: VideoTemplate,
  commentBundle: CommentBundle | null,
): Script {
  const total = Math.max(1, template.totalDuration);
  const hookDur = Math.min(3, total * 0.1);
  const ctaDur = Math.min(3, total * 0.1);
  const bodyStart = hookDur;
  const bodyEnd = total - ctaDur;

  // 指定時間帯に含まれる comment レイヤーのテキストを集める
  const textsIn = (startSec: number, endSec: number): string[] => {
    const hits: string[] = [];
    for (const layer of template.layers) {
      if (layer.type !== "comment") continue;
      if (layer.startSec >= endSec || layer.endSec <= startSec) continue;
      const txt = (layer.text ?? "").trim();
      if (txt) hits.push(txt);
    }
    return hits;
  };

  const hookTexts = textsIn(0, hookDur);
  const bodyTexts = textsIn(bodyStart, bodyEnd);
  const ctaTexts = textsIn(bodyEnd, total);

  const body: BodySegment[] = [
    {
      seconds: fmtSeconds(bodyStart, bodyEnd),
      narration: bodyTexts.join(" "),
      visual: "",
      image_prompt: "",
      text_overlay: bodyTexts.join("\n"),
      subtitle_style: DEFAULT_SUBTITLE_STYLE,
      effects: DEFAULT_EFFECTS,
    },
  ];

  return {
    title: commentBundle?.videoTitle?.trim() || template.name || "マニュアル台本",
    theme_vibe: template.themeVibe ?? "",
    hook: {
      seconds: fmtSeconds(0, hookDur),
      text: hookTexts.join(" "),
      visual: "",
      image_prompt: "",
      subtitle_style: DEFAULT_SUBTITLE_STYLE,
      effects: DEFAULT_EFFECTS,
    },
    body,
    cta: {
      seconds: fmtSeconds(bodyEnd, total),
      text: ctaTexts.join(" "),
      image_prompt: "",
      subtitle_style: DEFAULT_SUBTITLE_STYLE,
      effects: DEFAULT_EFFECTS,
    },
    hashtags: [],
    bgm_mood: "",
  };
}

/**
 * マニュアル割り当てをテンプレにパッチして返す（クローン）。
 */
export function applyManualAssignments(
  template: VideoTemplate,
  commentAssignments: Record<string, ExtractedComment | null>,
  sourceAssignments: Record<string, string>,
  textAssignments: Record<string, string>,
  geometryAssignments: Record<
    string,
    { x: number; y: number; width: number; height: number }
  > = {},
): VideoTemplate {
  return {
    ...template,
    layers: template.layers.map((l) => {
      const patched = { ...l };
      if (l.type === "comment") {
        const edited = textAssignments[l.id];
        if (edited !== undefined && edited.trim()) {
          patched.text = edited;
        } else {
          const c = commentAssignments[l.id];
          if (c) patched.text = c.text;
        }
      } else if (l.type === "image" || l.type === "video") {
        const src = sourceAssignments[l.id];
        if (src && src.trim()) patched.source = src;
      }
      const g = geometryAssignments[l.id];
      if (g) {
        patched.x = g.x;
        patched.y = g.y;
        patched.width = g.width;
        patched.height = g.height;
      }
      return patched;
    }),
  };
}
