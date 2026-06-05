/**
 * native counter（curio-gen 依頼書 ①）の表示文字列を算出する共有ヘルパ。
 *
 * preview（TemplateCanvas.renderAnimatedText）と export（layerComposer の
 * drawText / drawAnimatedTextFrame）の両方がこの 1 関数を使うことで、
 * 「再生・書き出しで一致」（CLAUDE.md の preview=export 鉄則）を保証する。
 *
 * 整形は toLocaleString に頼らず手動の 3 桁区切りで完全決定論にする
 * （ICU 設定に依存しない・preview/export 同一 JS ランタイムでもブレない）。
 */

import type { CounterSpec, Layer } from "../types";

type CounterEase = NonNullable<CounterSpec["ease"]>;

function easeCounter(p: number, ease: CounterEase): number {
  switch (ease) {
    case "linear":
      return p;
    case "in":
      return p * p;
    case "inout":
      return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    case "out":
    default:
      return 1 - (1 - p) * (1 - p); // ease-out quad（既定）
  }
}

/** 整数部に 3 桁区切りカンマを入れる（"1234567" → "1,234,567"）。 */
function groupThousands(intDigits: string): string {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatValue(value: number, c: CounterSpec): string {
  const decimals = Math.max(0, Math.floor(c.decimals ?? 0));
  const separator = c.separator ?? true;
  const neg = value < 0;
  const fixed = Math.abs(value).toFixed(decimals); // "12345.6"
  const dot = fixed.indexOf(".");
  let intPart = dot >= 0 ? fixed.slice(0, dot) : fixed;
  const fracPart = dot >= 0 ? fixed.slice(dot + 1) : "";
  if (separator) intPart = groupThousands(intPart);
  let s = fracPart ? `${intPart}.${fracPart}` : intPart;
  if (neg) s = `-${s}`;
  return `${c.prefix ?? ""}${s}${c.suffix ?? ""}`;
}

/**
 * counter の表示文字列を返す。
 * @param localTimeSec startSec 相対秒（currentTimeSec - layer.startSec）。
 * @param playing 再生中か。false（停止・編集・静的合成）のときは p=1 とみなし to を表示する。
 */
export function computeCounterText(
  c: CounterSpec,
  localTimeSec: number,
  playing: boolean,
): string {
  const from = Number(c.from);
  const to = Number(c.to);
  const dur = Number(c.durationSec);
  // 不正値は安全にフォールバック（to → from → 0 の順で静的表示）。
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    const fallback = Number.isFinite(to) ? to : Number.isFinite(from) ? from : 0;
    return formatValue(fallback, c);
  }
  if (!Number.isFinite(dur) || dur <= 0) {
    return formatValue(to, c);
  }
  const p = !playing ? 1 : Math.max(0, Math.min(1, localTimeSec / dur));
  const eased = easeCounter(p, c.ease ?? "out");
  const value = from + (to - from) * eased;
  return formatValue(value, c);
}

/**
 * counter の「整形前の生の値」を返す（オドメーター描画など、文字列でなく数値が要る用）。
 * computeCounterText と同じ ease / clamp ロジックを共有する。
 */
export function computeCounterValue(
  c: CounterSpec,
  localTimeSec: number,
  playing: boolean,
): number {
  const from = Number(c.from);
  const to = Number(c.to);
  const dur = Number(c.durationSec);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return Number.isFinite(to) ? to : Number.isFinite(from) ? from : 0;
  }
  if (!Number.isFinite(dur) || dur <= 0) return to;
  const p = !playing ? 1 : Math.max(0, Math.min(1, localTimeSec / dur));
  return from + (to - from) * easeCounter(p, c.ease ?? "out");
}

/**
 * counter / flip-swap によって毎フレーム決まる「表示文字列」を返す。どちらでもなければ null。
 * preview（renderAnimatedText）と export（drawLayerContentInBox の comment 分岐）が共有し、
 * 表示文字列の決定を 1 か所に集約して preview=export を保証する。
 * @param localTimeSec startSec 相対秒。
 * @param playing 再生中か。false（停止・編集・静的合成）は最終状態を表示する。
 */
export function resolveDynamicText(
  layer: Layer,
  localTimeSec: number,
  playing: boolean,
): string | null {
  if (layer.counter) {
    return computeCounterText(layer.counter, localTimeSec, playing);
  }
  if (layer.entryAnimation === "flip-swap" && layer.flipTo != null) {
    const entryDur = Math.max(0.01, layer.entryDuration ?? 0.3);
    const swapAt = layer.flipAtSec != null ? layer.flipAtSec : entryDur / 2;
    // 停止/編集中は最終状態(flipTo)を表示。再生中は切替時刻で text→flipTo。
    const showFlip = !playing || localTimeSec >= swapAt;
    return showFlip ? layer.flipTo : layer.text ?? "";
  }
  return null;
}
