import { useMemo, useState } from "react";
import type { ExtractedComment, VideoTemplate } from "../types";
import {
  autoPlaceTeropsFromScript,
  type AutoPlaceProgress,
} from "../lib/autoPlaceTerops";

interface Props {
  open: boolean;
  template: VideoTemplate;
  /** インポート済みコメント（フラット化したリスト）。台本素材として選択できる */
  importedComments?: ExtractedComment[];
  onApply: (template: VideoTemplate) => void;
  onClose: () => void;
}

export function AutoPlaceTeropsModal({
  open,
  template,
  importedComments,
  onApply,
  onClose,
}: Props) {
  const [script, setScript] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<AutoPlaceProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentSort, setCommentSort] = useState<"likes" | "replies" | "date">(
    "likes",
  );
  const [commentSearch, setCommentSearch] = useState("");
  const [includeReplies, setIncludeReplies] = useState(true);

  const sortedComments = useMemo(() => {
    if (!importedComments) return [];
    let list = includeReplies
      ? [...importedComments]
      : importedComments.filter((c) => !c.isReply);
    const q = commentSearch.trim().toLowerCase();
    if (q) {
      list = list.filter((c) => c.text.toLowerCase().includes(q));
    }
    list = [...list].sort((a, b) => {
      if (commentSort === "likes") return b.likeCount - a.likeCount;
      if (commentSort === "replies")
        return (b.replyCount ?? 0) - (a.replyCount ?? 0);
      return (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
    });
    return list;
  }, [importedComments, commentSort, commentSearch, includeReplies]);

  const appendCommentToScript = (text: string) => {
    setScript((s) => {
      const cleaned = text.replace(/\s+/g, " ").trim();
      if (!s.trim()) return cleaned;
      return `${s.trimEnd()}\n\n\n${cleaned}`;
    });
  };

  const appendAllVisibleComments = () => {
    const joined = sortedComments
      .map((c) => c.text.replace(/\s+/g, " ").trim())
      .filter((t) => t.length > 0)
      .join("\n\n\n");
    if (!joined) return;
    setScript((s) => (s.trim() ? `${s.trimEnd()}\n\n\n${joined}` : joined));
  };

  if (!open) return null;

  const chunkPreview = script
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n{3,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const handleRun = async () => {
    setError(null);
    setBusy(true);
    setProgress(null);
    try {
      console.log("[AutoPlace] start, script length:", script.length);
      const result = await autoPlaceTeropsFromScript(
        template,
        script,
        (p) => {
          console.log("[AutoPlace] progress:", p);
          setProgress(p);
        },
      );
      console.log("[AutoPlace] result:", result);
      if (result.insertedChunks === 0) {
        setError("台本が空です。テキストを入力してください。");
        return;
      }
      onApply(result.template);
      setScript("");
      onClose();
    } catch (e) {
      console.error("[AutoPlace] error:", e);
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      // エラーが見えにくい場合のフォールバック
      alert(`台本自動配置でエラー:\n\n${msg}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800">
          <div className="text-sm font-semibold">📝 台本から自動配置</div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 text-lg disabled:opacity-50"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <p className="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
            台本を貼り付けて「実行」を押すと、各チャンクのテロップをタイムラインの末尾に自動配置します。
            <br />
            <strong>区切り：2行空けて改行（3つ以上の連続改行）</strong>
            。1〜2 改行はチャンク内に保持されてテロップの2行表示などに使えます。
            <br />
            表示時間は文字数から自動算出（約 7 文字/秒、最低 1.5 秒）。
          </p>

          {/* インポート済みコメントから選択するパネル */}
          {importedComments && importedComments.length > 0 && (
            <div className="border border-purple-200 dark:border-purple-900/40 rounded bg-purple-50/40 dark:bg-purple-950/20">
              <button
                type="button"
                onClick={() => setCommentsOpen(!commentsOpen)}
                className="w-full px-3 py-2 text-left text-xs font-medium text-purple-800 dark:text-purple-200 flex items-center justify-between"
              >
                <span>
                  💬 インポート済みコメントから台本に追加（
                  {importedComments.length} 件 / 親{" "}
                  {importedComments.filter((c) => !c.isReply).length} ・ 返信{" "}
                  {importedComments.filter((c) => c.isReply).length}）
                </span>
                <span>{commentsOpen ? "▲" : "▼"}</span>
              </button>
              {commentsOpen && (
                <div className="border-t border-purple-200 dark:border-purple-900/40 p-2 space-y-2">
                  <div className="flex gap-1 items-center text-[11px]">
                    <input
                      type="text"
                      value={commentSearch}
                      onChange={(e) => setCommentSearch(e.target.value)}
                      placeholder="🔎 検索"
                      className="flex-1 px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
                    />
                    <select
                      value={commentSort}
                      onChange={(e) =>
                        setCommentSort(
                          e.target.value as "likes" | "replies" | "date",
                        )
                      }
                      className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
                    >
                      <option value="likes">いいね順</option>
                      <option value="replies">返信数順</option>
                      <option value="date">新着順</option>
                    </select>
                    <button
                      type="button"
                      onClick={appendAllVisibleComments}
                      disabled={busy}
                      className="px-2 py-1 rounded bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 text-white whitespace-nowrap"
                    >
                      全部追加
                    </button>
                  </div>
                  <label className="flex items-center gap-1.5 text-[10px] text-gray-600 dark:text-gray-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeReplies}
                      onChange={(e) => setIncludeReplies(e.target.checked)}
                      className="h-3 w-3"
                    />
                    返信コメントも含める
                  </label>
                  <div className="max-h-48 overflow-y-auto space-y-1">
                    {sortedComments.length === 0 ? (
                      <div className="text-[11px] text-gray-400 text-center py-2">
                        該当コメントなし
                      </div>
                    ) : (
                      sortedComments.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => appendCommentToScript(c.text)}
                          disabled={busy}
                          className="w-full text-left text-[11px] p-1.5 rounded bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 hover:border-purple-400 transition"
                          title="クリックで台本に追加"
                        >
                          <div className="flex items-center gap-2 text-[10px] text-gray-500 mb-0.5">
                            {c.isReply && (
                              <span className="text-blue-500">↪ 返信</span>
                            )}
                            {c.author && <span>@{c.author}</span>}
                            <span>👍 {c.likeCount}</span>
                            {c.replyCount ? <span>💬 {c.replyCount}</span> : null}
                          </div>
                          <div className="leading-relaxed break-words">
                            {c.text.length > 160 ? c.text.slice(0, 160) + "…" : c.text}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            disabled={busy}
            rows={10}
            placeholder={`例:\nこのシーンの反応\nエグすぎる\n\n\nコメント欄が\nもう壊れた\n\n\n全員ここで止まった`}
            className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm font-mono"
          />

          {chunkPreview.length > 0 && (
            <div className="text-[11px] text-gray-600 dark:text-gray-400">
              プレビュー: <strong>{chunkPreview.length} チャンク</strong> に分割されます
              <ul className="mt-1 space-y-0.5">
                {chunkPreview.slice(0, 8).map((c, i) => (
                  <li
                    key={i}
                    className="px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800"
                  >
                    {i + 1}. {c.replace(/\n/g, " / ").slice(0, 60)}
                    {c.length > 60 ? "…" : ""}
                  </li>
                ))}
                {chunkPreview.length > 8 && (
                  <li className="text-gray-400">…他 {chunkPreview.length - 8} 件</li>
                )}
              </ul>
            </div>
          )}

          {progress && (
            <div className="p-2 rounded bg-blue-50 dark:bg-blue-900/20 text-xs text-blue-800 dark:text-blue-200">
              {progress.message} ({progress.current}/{progress.total})
              <div className="mt-1 h-1 bg-blue-200 dark:bg-blue-900 rounded overflow-hidden">
                <div
                  className="h-full bg-blue-600 transition-all"
                  style={{
                    width: `${(progress.current / progress.total) * 100}%`,
                  }}
                />
              </div>
            </div>
          )}

          {error && (
            <div className="p-2 rounded bg-red-50 dark:bg-red-900/20 text-xs text-red-800 dark:text-red-200">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-3 border-t border-gray-200 dark:border-gray-800">
          <span className="mr-auto text-[11px] text-gray-500">
            既存レイヤー末尾（{template.layers.reduce((m, l) => Math.max(m, l.endSec), 0).toFixed(1)}s）から追加
          </span>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-xs disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={handleRun}
            disabled={busy || chunkPreview.length === 0}
            className="px-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-400 text-white text-xs"
          >
            {busy ? "生成中..." : `実行 (${chunkPreview.length} 件)`}
          </button>
        </div>
      </div>
    </div>
  );
}
