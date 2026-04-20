import { useMemo, useState } from "react";
import { fetchAllComments } from "../lib/youtube";
import type { CommentBundle, ExtractedComment } from "../types";

interface Props {
  selected: ExtractedComment[];
  onSelectedChange: (comments: ExtractedComment[]) => void;
  onBundleChange?: (bundle: CommentBundle | null) => void;
  maxCount?: number;
}

type SortKey = "likes" | "date";

export function CommentPicker({
  selected,
  onSelectedChange,
  onBundleChange,
  maxCount = 200,
}: Props) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [bundle, setBundle] = useState<CommentBundle | null>(null);

  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("likes");
  const [showReplies, setShowReplies] = useState(true);

  const handleFetch = async () => {
    if (!url.trim()) {
      setError("YouTube URL を入力してください");
      return;
    }
    setError(null);
    setLoading(true);
    setProgress(0);
    setBundle(null);
    onSelectedChange([]);
    onBundleChange?.(null);
    try {
      const result = await fetchAllComments(url.trim(), maxCount, setProgress);
      if (!result) {
        setError("コメントを取得できませんでした");
      } else {
        setBundle(result);
        onBundleChange?.(result);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`エラー: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const selectedIds = useMemo(
    () => new Set(selected.map((c) => c.id)),
    [selected],
  );

  const toggleComment = (c: ExtractedComment) => {
    if (selectedIds.has(c.id)) {
      onSelectedChange(selected.filter((s) => s.id !== c.id));
    } else {
      onSelectedChange([...selected, c]);
    }
  };

  // Build grouped view: parents with children
  const grouped = useMemo(() => {
    if (!bundle) return [];
    const parents = bundle.comments.filter((c) => !c.isReply);
    const byParent = new Map<string, ExtractedComment[]>();
    for (const c of bundle.comments) {
      if (c.isReply && c.parentId) {
        const list = byParent.get(c.parentId) ?? [];
        list.push(c);
        byParent.set(c.parentId, list);
      }
    }

    let items: { parent: ExtractedComment; replies: ExtractedComment[] }[] =
      parents.map((p) => ({
        parent: p,
        replies: byParent.get(p.id) ?? [],
      }));

    // Filter
    const s = search.trim().toLowerCase();
    if (s) {
      items = items.filter((it) => {
        if (it.parent.text.toLowerCase().includes(s)) return true;
        return it.replies.some((r) => r.text.toLowerCase().includes(s));
      });
    }

    // Sort parents
    items.sort((a, b) => {
      if (sortBy === "likes") return b.parent.likeCount - a.parent.likeCount;
      return (b.parent.publishedAt ?? "").localeCompare(
        a.parent.publishedAt ?? "",
      );
    });

    return items;
  }, [bundle, search, sortBy]);

  const visibleCount = grouped.reduce(
    (acc, it) => acc + 1 + (showReplies ? it.replies.length : 0),
    0,
  );

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="YouTube 動画 URL（shorts/watch どちらでも）"
          disabled={loading}
          className="flex-1 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm"
        />
        <button
          type="button"
          onClick={handleFetch}
          disabled={loading || !url.trim()}
          className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white text-sm font-medium whitespace-nowrap"
        >
          {loading ? `取得中 (${progress})` : "コメント取得"}
        </button>
      </div>

      {error && (
        <div className="p-2 rounded bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {bundle && (
        <>
          <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">
            📹 {bundle.videoTitle ?? bundle.videoId}
            {bundle.channelTitle && ` / ${bundle.channelTitle}`}
            {" — "}
            取得 {bundle.comments.length} 件
          </div>

          <div className="flex items-center gap-2 text-xs">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="🔎 検索"
              className="flex-1 px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
            />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortKey)}
              className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
            >
              <option value="likes">いいね順</option>
              <option value="date">新着順</option>
            </select>
            <label className="flex items-center gap-1 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showReplies}
                onChange={(e) => setShowReplies(e.target.checked)}
                className="h-3 w-3"
              />
              返信表示
            </label>
          </div>

          <div className="flex items-center justify-between text-[11px] text-gray-600 dark:text-gray-400">
            <span>
              選択: <strong>{selected.length}</strong> / 表示 {visibleCount}
            </span>
            {selected.length > 0 && (
              <button
                type="button"
                onClick={() => onSelectedChange([])}
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                選択解除
              </button>
            )}
          </div>

          <div className="max-h-[480px] overflow-y-auto border border-gray-200 dark:border-gray-800 rounded-lg divide-y divide-gray-100 dark:divide-gray-800">
            {grouped.length === 0 && (
              <div className="p-4 text-xs text-gray-500 text-center">
                該当コメントなし
              </div>
            )}
            {grouped.map((it) => (
              <div key={it.parent.id}>
                <CommentRow
                  comment={it.parent}
                  selected={selectedIds.has(it.parent.id)}
                  onToggle={() => toggleComment(it.parent)}
                />
                {showReplies &&
                  it.replies.map((r) => (
                    <CommentRow
                      key={r.id}
                      comment={r}
                      selected={selectedIds.has(r.id)}
                      onToggle={() => toggleComment(r)}
                    />
                  ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function CommentRow({
  comment,
  selected,
  onToggle,
}: {
  comment: ExtractedComment;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className={`flex items-start gap-2 p-2 cursor-pointer text-xs transition ${
        selected
          ? "bg-blue-50 dark:bg-blue-900/20"
          : "hover:bg-gray-50 dark:hover:bg-gray-800/50"
      } ${comment.isReply ? "pl-8 bg-gray-50/50 dark:bg-gray-900/30" : ""}`}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        className="mt-0.5 h-3.5 w-3.5 shrink-0"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-[10px] text-gray-500 dark:text-gray-400">
          {comment.isReply && <span className="text-blue-500">↪ 返信</span>}
          {comment.author && (
            <span className="truncate max-w-[120px]">@{comment.author}</span>
          )}
          <span>👍 {comment.likeCount.toLocaleString()}</span>
        </div>
        <div className="mt-0.5 leading-relaxed break-words whitespace-pre-wrap">
          {comment.text}
        </div>
      </div>
    </label>
  );
}
