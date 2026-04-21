import { useEffect, useState } from "react";
import type { CommentBundle, ExtractedComment } from "../types";
import { CommentPicker } from "./CommentPicker";

interface Props {
  open: boolean;
  /** 既にインポート済みのコメント（表示用。再取得すると置換されるが、UIで確認できるようにする） */
  existingComments?: ExtractedComment[];
  existingSource?: {
    videoUrl: string;
    videoTitle?: string;
    channelTitle?: string;
    fetchedAt: string;
  };
  onImport: (
    comments: ExtractedComment[],
    source: {
      videoUrl: string;
      videoTitle?: string;
      channelTitle?: string;
      fetchedAt: string;
    },
  ) => void;
  onClose: () => void;
}

export function ImportCommentsModal({
  open,
  existingComments,
  existingSource,
  onImport,
  onClose,
}: Props) {
  const [selected, setSelected] = useState<ExtractedComment[]>([]);
  const [bundle, setBundle] = useState<CommentBundle | null>(null);

  useEffect(() => {
    if (!open) {
      // 閉じたら状態リセット
      setSelected([]);
      setBundle(null);
    }
  }, [open]);

  if (!open) return null;

  const canImport = selected.length > 0 && bundle;

  return (
    <div
      className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800">
          <div className="text-sm font-semibold">
            💬 YouTube コメント取り込み
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 text-lg"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <p className="text-[11px] text-gray-500 dark:text-gray-400">
            YouTube 動画 URL
            を入力してコメントを取得し、テンプレ内のコメントレイヤーに挿入したいものを選んで「インポート」してください。前回取得したコメントは上書きされます。
          </p>

          {existingComments && existingComments.length > 0 && existingSource && (
            <div className="p-2 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-[11px] text-amber-800 dark:text-amber-300">
              ⚠ 現在インポート済み: {existingComments.length}{" "}
              件（{existingSource.videoTitle ?? existingSource.videoUrl}
              ）— 新規取得で置き換わります
            </div>
          )}

          <CommentPicker
            selected={selected}
            onSelectedChange={setSelected}
            onBundleChange={setBundle}
          />
        </div>

        <div className="flex items-center justify-end gap-2 p-3 border-t border-gray-200 dark:border-gray-800">
          <span className="mr-auto text-[11px] text-gray-500">
            {selected.length > 0 && `${selected.length} 件選択`}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-xs"
          >
            キャンセル
          </button>
          <button
            type="button"
            disabled={!canImport}
            onClick={() => {
              if (!bundle) return;
              onImport(selected, {
                videoUrl: bundle.videoUrl,
                videoTitle: bundle.videoTitle,
                channelTitle: bundle.channelTitle,
                fetchedAt: bundle.fetchedAt,
              });
              onClose();
            }}
            className="px-4 py-1.5 rounded bg-fuchsia-600 hover:bg-fuchsia-700 disabled:bg-gray-400 text-white text-xs"
          >
            インポート ({selected.length})
          </button>
        </div>
      </div>
    </div>
  );
}
