import { useEffect, useState } from "react";
import type { CommentBundle, ExtractedComment } from "../types";
import { CommentPicker } from "./CommentPicker";

interface Props {
  open: boolean;
  /** 既にインポート済みのバンドル群（複数動画分） */
  existingBundles?: CommentBundle[];
  onImport: (
    comments: ExtractedComment[],
    bundles: CommentBundle[],
  ) => void;
  onClose: () => void;
}

export function ImportCommentsModal({
  open,
  existingBundles,
  onImport,
  onClose,
}: Props) {
  const [selected, setSelected] = useState<ExtractedComment[]>([]);
  const [bundles, setBundles] = useState<CommentBundle[]>(existingBundles ?? []);

  // open が false→true に変わったときだけテンプレ側の既存バンドルを反映する。
  // open 中に親 re-render で existingBundles 参照が変わっても無視する
  // （そうしないと取得途中でバンドルが古い状態に戻ってしまう）
  useEffect(() => {
    if (open) {
      setBundles(existingBundles ?? []);
    } else {
      setSelected([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const totalComments = bundles.reduce((acc, b) => acc + b.comments.length, 0);
  const canImport = selected.length > 0;

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
            複数の YouTube 動画からコメントを取得して保持できます。動画ごとに別のタブで切り替えて選択し、「インポート」でテンプレにまとめて登録します。
          </p>

          {bundles.length > 0 && (
            <div className="p-2 rounded bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 text-[11px] text-emerald-800 dark:text-emerald-300">
              📚 取得済み: {bundles.length} 動画 / 計 {totalComments} 件
            </div>
          )}

          <CommentPicker
            selected={selected}
            onSelectedChange={setSelected}
            onBundlesChange={setBundles}
            initialBundles={bundles}
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
              onImport(selected, bundles);
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
