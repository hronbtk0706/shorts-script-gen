import { useState } from "react";
import type { Duration, Platform, ScriptInput, Tone } from "../types";
import { TopicSuggestModal } from "./TopicSuggestModal";

interface Props {
  onSubmit: (input: ScriptInput) => void;
  loading: boolean;
}

export function ScriptForm({ onSubmit, loading }: Props) {
  const [topic, setTopic] = useState("");
  const [platform, setPlatform] = useState<Platform>("tiktok");
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [duration, setDuration] = useState<Duration>(30);
  const [showOptional, setShowOptional] = useState(false);
  const [audience, setAudience] = useState("");
  const [tone, setTone] = useState<Tone | "">("");
  const [goal, setGoal] = useState("");
  const [reference, setReference] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim()) return;
    onSubmit({
      topic: topic.trim(),
      platform,
      duration,
      audience: audience.trim() || undefined,
      tone: tone || undefined,
      goal: goal.trim() || undefined,
      reference: reference.trim() || undefined,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-sm font-medium">
            トピック <span className="text-red-500">*</span>
          </label>
          <button
            type="button"
            onClick={() => setSuggestOpen(true)}
            className="text-xs px-2 py-1 rounded-lg bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 hover:bg-purple-200 dark:hover:bg-purple-900/60 transition"
          >
            💡 AIに提案してもらう
          </button>
        </div>
        <textarea
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="例: プログラミング初心者がやりがちなミス"
          rows={2}
          className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          required
        />
      </div>

      <TopicSuggestModal
        open={suggestOpen}
        platform={platform}
        onClose={() => setSuggestOpen(false)}
        onSelect={(t) => setTopic(t)}
      />

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium mb-1">プラットフォーム</label>
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value as Platform)}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="tiktok">TikTok</option>
            <option value="reels">Instagram Reels</option>
            <option value="shorts">YouTube Shorts</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">尺</label>
          <select
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value) as Duration)}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value={15}>15秒</option>
            <option value={30}>30秒</option>
            <option value={60}>60秒</option>
          </select>
        </div>
      </div>

      <button
        type="button"
        onClick={() => setShowOptional(!showOptional)}
        className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
      >
        {showOptional ? "▼" : "▶"} 詳細オプション（任意）
      </button>

      {showOptional && (
        <div className="space-y-3 p-4 rounded-lg bg-gray-50 dark:bg-gray-800/50">
          <div>
            <label className="block text-sm font-medium mb-1">ターゲット層</label>
            <input
              type="text"
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              placeholder="例: 20代の社会人、ガジェット好き"
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">トーン</label>
            <select
              value={tone}
              onChange={(e) => setTone(e.target.value as Tone | "")}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">おまかせ</option>
              <option value="casual">カジュアル</option>
              <option value="educational">教育・解説</option>
              <option value="emotional">感動・共感</option>
              <option value="viral">バズ狙い</option>
              <option value="serious">真面目・ビジネス</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">目的</label>
            <input
              type="text"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="例: フォロワー獲得、商品紹介、認知拡大"
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">参考・補足</label>
            <input
              type="text"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="例: 具体例を入れたい、自分の体験を語る"
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      )}

      <button
        type="submit"
        disabled={loading || !topic.trim()}
        className="w-full py-3 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-medium transition"
      >
        {loading ? "生成中..." : "台本を生成"}
      </button>
    </form>
  );
}
