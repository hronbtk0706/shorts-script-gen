import type { SceneEffects } from "../types";

export const DEFAULT_EFFECTS: SceneEffects = {
  motion: "static",
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
