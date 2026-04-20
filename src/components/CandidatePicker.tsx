import type { Script } from "../types";
import type { SelectionResult } from "../lib/providers/llm";

interface Props {
  candidates: Script[];
  activeIndex: number;
  selection: SelectionResult;
  onSelect: (index: number) => void;
}

export function CandidatePicker({
  candidates,
  activeIndex,
  selection,
  onSelect,
}: Props) {
  return (
    <div className="rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50/40 dark:bg-amber-900/10 p-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
          多候補生成: {candidates.length}案から選べます（AI推奨 ★）
        </p>
      </div>
      <div className="flex flex-wrap gap-2 mb-2">
        {candidates.map((c, i) => {
          const isActive = i === activeIndex;
          const isRecommended = i === selection.selected_index;
          return (
            <button
              key={i}
              onClick={() => onSelect(i)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium border transition ${
                isActive
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:border-blue-400"
              }`}
              title={c.title}
            >
              {isRecommended && "★ "}
              候補{i + 1}: {c.title.slice(0, 14)}
              {c.title.length > 14 ? "…" : ""}
            </button>
          );
        })}
      </div>
      <div className="text-[11px] text-amber-800/80 dark:text-amber-300/80 leading-relaxed">
        <div>
          <span className="font-semibold">AI の選定理由:</span> {selection.reason}
        </div>
        {selection.improvements.length > 0 && (
          <div className="mt-1">
            <span className="font-semibold">改善アイデア:</span>{" "}
            {selection.improvements.join(" / ")}
          </div>
        )}
      </div>
    </div>
  );
}
