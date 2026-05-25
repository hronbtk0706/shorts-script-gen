import { useEffect, useState } from "react";

/**
 * 色ピッカー用のプリセット + 最近使った色の swatch 行。
 * `<input type="color">` の代わりではなく、補助として直下に置く想定。
 *
 * 利用例:
 *   <input type="color" value={c} onChange={...} />
 *   <ColorSwatches value={c} onChange={(v) => { setColor(v); recordColorUsed(v); }} />
 */

// よく使う色のプリセット（編集アプリの王道セット）
const PRESETS: readonly string[] = [
  // モノクロ
  "#ffffff",
  "#cccccc",
  "#888888",
  "#444444",
  "#000000",
  // ビビッド（テキスト/装飾でよく使う）
  "#ff3838", // 赤
  "#ff8fb1", // ピンク
  "#ffa500", // オレンジ
  "#ffe600", // 黄
  "#22c55e", // 緑
  "#5cc6ee", // 水色
  "#3b82f6", // 青
  "#a855f7", // 紫
];

const RECENT_KEY = "color-swatches-recent";
const MAX_RECENT = 10;
const RECENTS_EVENT = "color-recents-updated";

// 旧バグ (color input のドラッグ中に毎フレーム recents に追加してた) で
// 似た色が大量に溜まったストアを 1 回だけクリアする。
const RECENT_RESET_FLAG_KEY = "color-swatches-reset-v2";
function maybeResetRecentsOnce() {
  try {
    if (localStorage.getItem(RECENT_RESET_FLAG_KEY) === "1") return;
    localStorage.removeItem(RECENT_KEY);
    localStorage.setItem(RECENT_RESET_FLAG_KEY, "1");
  } catch {
    /* localStorage 不可なら無視 */
  }
}
maybeResetRecentsOnce();

function normalizeHex(c: string): string | null {
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(c)) {
    return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`.toLowerCase();
  }
  return null;
}

function loadRecent(): string[] {
  try {
    const s = localStorage.getItem(RECENT_KEY);
    if (!s) return [];
    const v = JSON.parse(s);
    if (!Array.isArray(v)) return [];
    return v
      .filter((c): c is string => typeof c === "string")
      .map((c) => normalizeHex(c))
      .filter((c): c is string => !!c)
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function saveRecent(colors: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(colors.slice(0, MAX_RECENT)));
  } catch {
    /* no-op */
  }
}

/**
 * ユーザーが何らかの方法で色を選んだ時に呼ぶ（color input / text input / swatch クリック等）。
 * 重複は除いた最新順で MAX_RECENT 個まで localStorage に保存。
 */
export function recordColorUsed(c: string | undefined) {
  if (!c) return;
  const norm = normalizeHex(c);
  if (!norm) return;
  // PRESETS にあるものは「最近使った」に入れない（重複した swatch になる）
  if (PRESETS.includes(norm)) return;
  const current = loadRecent();
  const next = [norm, ...current.filter((x) => x !== norm)].slice(0, MAX_RECENT);
  saveRecent(next);
  window.dispatchEvent(new CustomEvent(RECENTS_EVENT));
}

// モジュールスコープに置かないと、ColorSwatches が再レンダリングされる度に
// 新しい関数として React に認識されて DOM ノードが unmount/remount される。
// その結果、クリック直後に document level の click ハンドラ側で e.target が
// 切り離されたノードを指してしまい、closest() が null を返してレイヤー選択が
// 解除されてしまう（[data-keep-selection] 判定が機能しなくなる）。
function Swatch({
  c,
  selected,
  onPick,
}: {
  c: string;
  selected: boolean;
  onPick: (c: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(c)}
      className={`shrink-0 w-3.5 h-3.5 rounded-sm border ${
        selected
          ? "ring-2 ring-blue-500 border-blue-500"
          : "border-gray-300 dark:border-gray-600 hover:border-gray-500 dark:hover:border-gray-400"
      }`}
      style={{ background: c }}
      title={c}
    />
  );
}

export function ColorSwatches({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (c: string) => void;
}) {
  const [recents, setRecents] = useState<string[]>(() => loadRecent());

  useEffect(() => {
    const h = () => setRecents(loadRecent());
    window.addEventListener(RECENTS_EVENT, h);
    return () => window.removeEventListener(RECENTS_EVENT, h);
  }, []);

  const selected = value ? normalizeHex(value) : null;

  return (
    <div className="flex flex-wrap items-center gap-0.5 mt-1">
      {PRESETS.map((c) => (
        <Swatch key={`p-${c}`} c={c} selected={selected === c} onPick={onChange} />
      ))}
      {recents.length > 0 && (
        <>
          <span
            className="w-px self-stretch bg-gray-300 dark:bg-gray-600 mx-1"
            aria-hidden
          />
          {recents.map((c) => (
            <Swatch key={`r-${c}`} c={c} selected={selected === c} onPick={onChange} />
          ))}
        </>
      )}
    </div>
  );
}
