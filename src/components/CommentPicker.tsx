import { useMemo, useState } from "react";
import { fetchAllComments } from "../lib/youtube";
import type { CommentBundle, ExtractedComment } from "../types";

interface Props {
  selected: ExtractedComment[];
  onSelectedChange: (comments: ExtractedComment[]) => void;
  /** 取得済みバンドル全体の変更通知（保存用） */
  onBundlesChange?: (bundles: CommentBundle[]) => void;
  /** 既存の取得済みバンドル（モーダル再オープン時に復元） */
  initialBundles?: CommentBundle[];
  maxCount?: number;
}

type SortKey = "likes" | "replies" | "date";

export function CommentPicker({
  selected,
  onSelectedChange,
  onBundlesChange,
  initialBundles,
  maxCount = 500,
}: Props) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  // initialBundles は mount 時のみ初期値として使用する（以後は内部 state のみで管理）。
  // 親の再レンダーで参照だけ変わっても reset しないようにして、
  // 取得途中にソート切替などで state が巻き戻るのを防ぐ
  const [bundles, setBundles] = useState<CommentBundle[]>(initialBundles ?? []);
  const [activeVideoId, setActiveVideoId] = useState<string | null>(
    initialBundles && initialBundles.length > 0 ? initialBundles[0].videoId : null,
  );

  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("likes");
  const [showReplies, setShowReplies] = useState(true);
  const [fetchAllReplies, setFetchAllReplies] = useState(false);

  const updateBundles = (next: CommentBundle[]) => {
    setBundles(next);
    onBundlesChange?.(next);
  };

  const handleFetch = async () => {
    if (!url.trim()) {
      setError("YouTube URL を入力してください");
      return;
    }
    setError(null);
    setLoading(true);
    setProgress(0);
    try {
      const result = await fetchAllComments(
        url.trim(),
        maxCount,
        setProgress,
        fetchAllReplies,
      );
      if (!result) {
        setError("コメントを取得できませんでした");
      } else {
        // 同じ videoId があれば置換、なければ追加
        const existingIdx = bundles.findIndex((b) => b.videoId === result.videoId);
        const next =
          existingIdx >= 0
            ? bundles.map((b, i) => (i === existingIdx ? result : b))
            : [...bundles, result];
        updateBundles(next);
        setActiveVideoId(result.videoId);
        setUrl("");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`エラー: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveBundle = (videoId: string) => {
    if (!confirm("この動画のコメントリストを削除しますか?")) return;
    const next = bundles.filter((b) => b.videoId !== videoId);
    // 削除対象のコメントを選択からも外す
    const removedIds = new Set(
      bundles.find((b) => b.videoId === videoId)?.comments.map((c) => c.id) ?? [],
    );
    onSelectedChange(selected.filter((c) => !removedIds.has(c.id)));
    updateBundles(next);
    if (activeVideoId === videoId) {
      setActiveVideoId(next[0]?.videoId ?? null);
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

  const activeBundle = useMemo(
    () => bundles.find((b) => b.videoId === activeVideoId) ?? null,
    [bundles, activeVideoId],
  );

  // アクティブなバンドルから表示用リストを構築
  const grouped = useMemo(() => {
    if (!activeBundle) return [];
    const parents = activeBundle.comments.filter((c) => !c.isReply);
    const byParent = new Map<string, ExtractedComment[]>();
    for (const c of activeBundle.comments) {
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
      if (sortBy === "replies") {
        const ar = a.parent.replyCount ?? a.replies.length;
        const br = b.parent.replyCount ?? b.replies.length;
        return br - ar;
      }
      return (b.parent.publishedAt ?? "").localeCompare(
        a.parent.publishedAt ?? "",
      );
    });

    return items;
  }, [activeBundle, search, sortBy]);

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
      <label className="flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-400 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={fetchAllReplies}
          onChange={(e) => setFetchAllReplies(e.target.checked)}
          disabled={loading}
          className="h-3.5 w-3.5"
        />
        💬 返信もすべて取得（YouTube 標準だと最大5件まで。多いコメントの全返信を見たい時に。API 消費が増えます）
      </label>

      {error && (
        <div className="p-2 rounded bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {bundles.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-800 pb-1">
          {bundles.map((b) => {
            const isActive = b.videoId === activeVideoId;
            const selCount = b.comments.filter((c) => selectedIds.has(c.id)).length;
            return (
              <div
                key={b.videoId}
                className={`group flex items-center gap-1 px-2 py-1 rounded-t text-[11px] cursor-pointer transition ${
                  isActive
                    ? "bg-blue-100 dark:bg-blue-900/40 text-blue-900 dark:text-blue-100"
                    : "bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700"
                }`}
                onClick={() => setActiveVideoId(b.videoId)}
                title={b.videoTitle ?? b.videoUrl}
              >
                <span className="truncate max-w-[160px]">
                  📹 {b.videoTitle ?? b.videoId}
                </span>
                <span className="text-[10px] text-gray-500">
                  ({b.comments.length}
                  {selCount > 0 ? ` / 選${selCount}` : ""})
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemoveBundle(b.videoId);
                  }}
                  className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-500 px-0.5"
                  title="削除"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}

      {activeBundle && (
        <>
          <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">
            📹 {activeBundle.videoTitle ?? activeBundle.videoId}
            {activeBundle.channelTitle && ` / ${activeBundle.channelTitle}`}
            {" — "}
            取得 {activeBundle.comments.length} 件
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
              <option value="replies">返信数順</option>
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
          {!comment.isReply && comment.replyCount !== undefined && comment.replyCount > 0 && (
            <span>💬 {comment.replyCount.toLocaleString()}</span>
          )}
        </div>
        <div className="mt-0.5 leading-relaxed break-words whitespace-pre-wrap">
          {comment.text}
        </div>
      </div>
    </label>
  );
}
