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
 * テンプレのセグメント区間ごとに、その区間内のコメント型レイヤーのテキストを
 * 連結してナレーション / text_overlay に入れる。
 */
export function buildManualScript(
  template: VideoTemplate,
  commentBundle: CommentBundle | null,
): Script {
  const hookSeg =
    template.segments.find((s) => s.type === "hook") ??
    { startSec: 0, endSec: 3 };
  const ctaSeg =
    template.segments.find((s) => s.type === "cta") ??
    { startSec: template.totalDuration - 3, endSec: template.totalDuration };
  const bodySegs = template.segments
    .filter((s) => s.type === "body")
    .sort((a, b) => a.startSec - b.startSec);

  // 指定時間帯に含まれる comment/text レイヤーのテキストを集める
  // template は applyManualAssignments で既にパッチ済みなので layer.text が最終値
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

  const body: BodySegment[] = bodySegs.map((seg) => {
    const texts = textsIn(seg.startSec, seg.endSec);
    return {
      seconds: fmtSeconds(seg.startSec, seg.endSec),
      narration: texts.join(" "),
      visual: "",
      image_prompt: "",
      text_overlay: texts.join("\n"),
      subtitle_style: DEFAULT_SUBTITLE_STYLE,
      effects: DEFAULT_EFFECTS,
    };
  });

  const hookTexts = textsIn(hookSeg.startSec, hookSeg.endSec);
  const ctaTexts = textsIn(ctaSeg.startSec, ctaSeg.endSec);

  return {
    title: commentBundle?.videoTitle?.trim() || template.name || "マニュアル台本",
    theme_vibe: template.themeVibe ?? "",
    hook: {
      seconds: fmtSeconds(hookSeg.startSec, hookSeg.endSec),
      text: hookTexts.join(" "),
      visual: "",
      image_prompt: "",
      subtitle_style: DEFAULT_SUBTITLE_STYLE,
      effects: DEFAULT_EFFECTS,
    },
    body,
    cta: {
      seconds: fmtSeconds(ctaSeg.startSec, ctaSeg.endSec),
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
 * - コメント型レイヤー: 選択されたコメントテキストを layer.text に入れる
 * - image/video 型レイヤー: ユーザーがファイル指定した場合 layer.source に入れる
 * - text 型レイヤー: 上書き入力があれば layer.text に入れる
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
  // セグメント未定義のテンプレは、hook/body/cta の既定3分割を自動補完
  const segments =
    template.segments.length > 0
      ? template.segments
      : (() => {
          const total = Math.max(3, template.totalDuration);
          const hookDur = Math.min(3, total * 0.1);
          const ctaDur = Math.min(3, total * 0.1);
          return [
            {
              id: "auto_hook",
              type: "hook" as const,
              startSec: 0,
              endSec: hookDur,
              transitionTo: "cut" as const,
              transitionDuration: 0,
            },
            {
              id: "auto_body",
              type: "body" as const,
              startSec: hookDur,
              endSec: total - ctaDur,
              bodyIndex: 0,
              transitionTo: "cut" as const,
              transitionDuration: 0,
            },
            {
              id: "auto_cta",
              type: "cta" as const,
              startSec: total - ctaDur,
              endSec: total,
              transitionTo: "cut" as const,
              transitionDuration: 0,
            },
          ];
        })();

  return {
    ...template,
    segments,
    layers: template.layers.map((l) => {
      const patched = { ...l };
      if (l.type === "comment") {
        // 編集済みテキスト優先、無ければDDLで選んだコメントの原文、それも無ければテンプレ既定
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
      // ジオメトリ上書き（現状は image/video のみ UI で設定されるが、どの型でも適用）
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
