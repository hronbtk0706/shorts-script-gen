import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  type Live2DModelMeta,
  listLive2DModels,
  importLive2DGlobal,
  deleteLive2DModel,
  updateLive2DModelMeta,
} from "../lib/live2dLibrary";

interface Props {
  open: boolean;
  onClose: () => void;
  /** ユーザがモデルを選択 (= レイヤー追加) したときに呼ばれる */
  onPick: (meta: Live2DModelMeta) => void;
}

/**
 * グローバル Live2D モデルライブラリの選択モーダル。
 * - 登録済みモデルをカード一覧で表示
 * - 各カードは ファイル名 / 制作者 / 配布元 URL / 削除ボタン / 「使用」ボタン
 * - 「＋ 新規追加」で .model3.json をピック → ライブラリに登録 → 同モーダルでそのまま選べる
 * - クレジット情報はカード内で編集可
 */
export function Live2DPickerModal({ open, onClose, onPick }: Props) {
  const [models, setModels] = useState<Live2DModelMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 各モデルごとのクレジット編集中の値 (ローカル下書き)。保存時に確定する。
  const [drafts, setDrafts] = useState<
    Record<string, { author: string; sourceUrl: string; requiredCreditText: string }>
  >({});

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listLive2DModels();
      setModels(list);
      // ドラフトを最新値で初期化
      const next: typeof drafts = {};
      for (const m of list) {
        next[m.name] = {
          author: m.author ?? "",
          sourceUrl: m.sourceUrl ?? "",
          requiredCreditText: m.requiredCreditText ?? "",
        };
      }
      setDrafts(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const handleAdd = async () => {
    if (adding) return;
    try {
      const path = await openDialog({
        multiple: false,
        directory: false,
        filters: [
          { name: "Live2D モデル", extensions: ["model3.json", "json"] },
        ],
      });
      if (typeof path !== "string") return;
      if (!path.toLowerCase().endsWith(".model3.json")) {
        setError(".model3.json を選んでください");
        return;
      }
      setAdding(true);
      setError(null);
      await importLive2DGlobal(path, {});
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (name: string) => {
    const ok = confirm(
      `モデル "${name}" を削除します (フォルダごと削除されます)。OK?`,
    );
    if (!ok) return;
    try {
      await deleteLive2DModel(name);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleSaveCredit = async (name: string) => {
    const d = drafts[name];
    if (!d) return;
    try {
      await updateLive2DModelMeta(name, d);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const handlePick = (m: Live2DModelMeta) => {
    onPick(m);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[85vh] bg-white dark:bg-gray-900 rounded-lg shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-sm font-bold flex items-center gap-2">
            <span>🎭</span>
            <span>Live2D モデルライブラリ</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 text-lg leading-none"
            title="閉じる"
          >
            ✕
          </button>
        </div>

        <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-200 dark:border-gray-700">
          <button
            type="button"
            onClick={handleAdd}
            disabled={adding}
            className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-xs"
          >
            {adding ? "追加中..." : "＋ 新規追加 (.model3.json)"}
          </button>
          <button
            type="button"
            onClick={refresh}
            className="px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-xs"
          >
            🔄 再読込
          </button>
          {loading && (
            <span className="text-[10px] text-gray-500">読み込み中...</span>
          )}
          {error && (
            <span className="text-[10px] text-red-500 truncate">{error}</span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {models.length === 0 && !loading && (
            <div className="text-center text-xs text-gray-500 py-8">
              モデル未登録。「＋ 新規追加」から .model3.json を取り込んでください。
            </div>
          )}
          {models.map((m) => {
            const d = drafts[m.name] ?? {
              author: "",
              sourceUrl: "",
              requiredCreditText: "",
            };
            return (
              <div
                key={m.name}
                className="border border-gray-200 dark:border-gray-700 rounded p-3 flex flex-col gap-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-bold truncate">{m.name}</div>
                    <div className="text-[10px] text-gray-500 truncate">
                      {m.modelPath}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handlePick(m)}
                    className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-xs whitespace-nowrap"
                  >
                    使用
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(m.name)}
                    className="px-2 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 text-xs"
                    title="ライブラリから削除"
                  >
                    🗑
                  </button>
                </div>

                <details className="text-[10px]">
                  <summary className="cursor-pointer text-gray-500">
                    クレジット情報
                  </summary>
                  <div className="flex flex-col gap-1 mt-1 pl-2">
                    <input
                      type="text"
                      placeholder="制作者名"
                      value={d.author}
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [m.name]: { ...d, author: e.target.value },
                        }))
                      }
                      className="px-1.5 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
                    />
                    <input
                      type="text"
                      placeholder="配布元 URL"
                      value={d.sourceUrl}
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [m.name]: { ...d, sourceUrl: e.target.value },
                        }))
                      }
                      className="px-1.5 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
                    />
                    <textarea
                      placeholder="概要欄に貼る指定文 (任意)"
                      value={d.requiredCreditText}
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [m.name]: {
                            ...d,
                            requiredCreditText: e.target.value,
                          },
                        }))
                      }
                      rows={2}
                      className="px-1.5 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 resize-y"
                    />
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() => handleSaveCredit(m.name)}
                        className="px-2 py-1 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 text-[10px]"
                      >
                        💾 保存
                      </button>
                    </div>
                  </div>
                </details>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
