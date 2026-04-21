import type { ScriptInput } from "../types";

interface Props {
  scriptInput: ScriptInput;
}

const TYPE_ICON: Record<string, string> = {
  image: "🖼",
  video: "🎬",
  text: "📝",
  comment: "💬",
  color: "🎨",
  shape: "⬜",
};

const TYPE_LABEL: Record<string, string> = {
  image: "画像",
  video: "動画",
  text: "テキスト",
  comment: "コメント枠",
  color: "単色",
  shape: "図形",
};

export function ManualScriptSummary({ scriptInput }: Props) {
  const template = scriptInput.template;
  if (!template) return null;
  const layers = [...template.layers].sort(
    (a, b) => a.startSec - b.startSec || a.zIndex - b.zIndex,
  );

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3 space-y-2">
      <div className="text-sm font-semibold">
        📋 レイヤー ({layers.length})
      </div>
      <div className="space-y-1">
        {layers.map((l) => {
          const fileName =
            l.source && l.source !== "auto" && l.source !== "user"
              ? l.source.split(/[\\/]/).pop()
              : null;
          return (
            <div
              key={l.id}
              className="flex items-center gap-2 text-xs p-1.5 rounded bg-gray-50 dark:bg-gray-800/50"
            >
              <span className="text-sm">{TYPE_ICON[l.type] ?? "◼"}</span>
              <span className="text-gray-500 font-medium w-20 shrink-0">
                {TYPE_LABEL[l.type] ?? l.type}
              </span>
              <span className="text-gray-400 w-20 shrink-0">
                {l.startSec.toFixed(1)}–{l.endSec.toFixed(1)}s
              </span>
              <span className="flex-1 truncate text-gray-700 dark:text-gray-300">
                {l.type === "comment"
                  ? l.text || "(空)"
                  : l.type === "image" || l.type === "video"
                    ? fileName || `(${l.source ?? "未設定"})`
                    : l.fillColor || "—"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
