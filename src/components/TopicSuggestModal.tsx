import { useState } from "react";
import { getLlmProvider } from "../lib/providers/llm";
import type { TopicSuggestion } from "../lib/providers/llm";
import { loadSettings } from "../lib/storage";
import type { Platform } from "../types";
import { CATEGORY_OPTIONS } from "../lib/scriptOptions";
import { GroupedSelect } from "./GroupedSelect";

interface Props {
  open: boolean;
  platform: Platform;
  onClose: () => void;
  onSelect: (topic: string) => void;
}

export function TopicSuggestModal({
  open,
  platform,
  onClose,
  onSelect,
}: Props) {
  const [category, setCategory] = useState("");
  const [customCategory, setCustomCategory] = useState("");
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<TopicSuggestion[]>([]);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleSuggest = async () => {
    setLoading(true);
    setError(null);
    setSuggestions([]);
    try {
      const settings = await loadSettings();
      const provider = getLlmProvider(settings.llmProvider);
      const categoryLabel = customCategory.trim() || category || "";
      const result = await provider.suggestTopics(
        {
          platform,
          category: categoryLabel || undefined,
          count: 5,
        },
        settings,
      );
      setSuggestions(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const handlePick = (topic: string) => {
    onSelect(topic);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-xl p-6 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold mb-4">💡 トピック提案</h2>

        <div className="space-y-3">
          <GroupedSelect
            label="ジャンル・方向性"
            value={category}
            onChange={(v) => {
              setCategory(v);
              setCustomCategory("");
            }}
            groups={CATEGORY_OPTIONS}
            placeholderOption="おまかせ（全ジャンル）"
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
          />

          <div>
            <label className="block text-sm font-medium mb-1">
              独自のテーマ（任意）
            </label>
            <input
              type="text"
              value={customCategory}
              onChange={(e) => setCustomCategory(e.target.value)}
              placeholder="例: 一人暮らしの知恵 / 副業 / キャンプ"
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
            />
          </div>

          <button
            onClick={handleSuggest}
            disabled={loading}
            className="w-full py-2 rounded-lg bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 text-white font-medium"
          >
            {loading ? "考え中..." : "🎲 トピックを提案してもらう"}
          </button>
        </div>

        {error && (
          <div className="mt-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {suggestions.length > 0 && (
          <div className="mt-6 space-y-3">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              クリックで選択 → 台本フォームに反映されます
            </p>
            {suggestions.map((sug, i) => (
              <button
                key={i}
                onClick={() => handlePick(sug.topic)}
                className="w-full text-left p-4 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 transition"
              >
                <div className="font-semibold mb-1">{sug.topic}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                  {sug.reason}
                </div>
                <div className="text-xs text-blue-600 dark:text-blue-400">
                  {sug.hashtags.slice(0, 5).join(" ")}
                </div>
              </button>
            ))}
          </div>
        )}

        <div className="mt-6 flex justify-end">
          <button
            onClick={onClose}
            className="py-2 px-4 rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
