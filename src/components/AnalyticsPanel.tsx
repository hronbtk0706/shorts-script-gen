import { useState, useEffect } from "react";
import {
  loadRecords,
  updateMetrics,
  deleteRecord,
  computeInsights,
  type PerformanceRecord,
} from "../lib/analytics";

const PLATFORM_LABEL: Record<string, string> = {
  tiktok: "TikTok",
  reels: "Reels",
  shorts: "Shorts",
};

interface EditState {
  views: number;
  likes: number;
  comments: number;
  watchTimePercent: number;
  ctr: number;
}

function defaultEdit(r: PerformanceRecord): EditState {
  return {
    views: r.views,
    likes: r.likes,
    comments: r.comments,
    watchTimePercent: r.watchTimePercent,
    ctr: r.ctr,
  };
}

export function AnalyticsPanel() {
  const [records, setRecords] = useState<PerformanceRecord[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<EditState>({ views: 0, likes: 0, comments: 0, watchTimePercent: 0, ctr: 0 });
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    setRecords(await loadRecords());
  };

  useEffect(() => { refresh(); }, []);

  const startEdit = (r: PerformanceRecord) => {
    setEditing(r.id);
    setEditValues(defaultEdit(r));
  };

  const saveEdit = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      await updateMetrics(editing, editValues);
      await refresh();
      setEditing(null);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("このレコードを削除しますか？")) return;
    await deleteRecord(id);
    await refresh();
  };

  const setEdit = (key: keyof EditState, val: number) =>
    setEditValues((p) => ({ ...p, [key]: val }));

  const insights = computeInsights(records);

  return (
    <div className="space-y-5">
      {insights ? (
        <div className="p-4 rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 text-sm whitespace-pre-wrap text-blue-900 dark:text-blue-100 leading-relaxed">
          {insights}
        </div>
      ) : (
        <div className="p-4 rounded-xl bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 text-sm text-gray-500 dark:text-gray-400">
          動画を生成・アップロードしてから「成績入力」で再生数・CTR・視聴維持率を記録すると、AIが自動で改善ヒントを出します。
        </div>
      )}

      {records.length === 0 ? (
        <div className="text-center py-16 text-gray-400 text-sm">
          動画を生成すると実績が記録されます
        </div>
      ) : (
        <div className="space-y-3">
          {records.map((r) => (
            <div
              key={r.id}
              className="p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
            >
              <div className="flex justify-between items-start gap-2">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{r.topic}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {new Date(r.createdAt).toLocaleDateString("ja-JP")} &nbsp;|&nbsp;
                    {PLATFORM_LABEL[r.platform] ?? r.platform} {r.duration}秒
                    {r.tone && <>&nbsp;|&nbsp;{r.tone}</>}
                  </p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => startEdit(r)}
                    className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800"
                  >
                    成績入力
                  </button>
                  <button
                    onClick={() => handleDelete(r.id)}
                    className="text-xs px-2 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                  >
                    削除
                  </button>
                </div>
              </div>

              {r.views > 0 && editing !== r.id && (
                <div className="mt-2 flex gap-4 text-xs text-gray-600 dark:text-gray-400 flex-wrap">
                  <span>{r.views.toLocaleString()} 再生</span>
                  <span>CTR {r.ctr}%</span>
                  <span>視聴維持 {r.watchTimePercent}%</span>
                  <span>👍 {r.likes}</span>
                  {r.metricsUpdatedAt && (
                    <span className="text-gray-400">
                      更新: {new Date(r.metricsUpdatedAt).toLocaleDateString("ja-JP")}
                    </span>
                  )}
                </div>
              )}

              {editing === r.id && (
                <div className="mt-3 space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    {(
                      [
                        { key: "views", label: "再生数", step: 1 },
                        { key: "likes", label: "いいね数", step: 1 },
                        { key: "ctr", label: "CTR（%）", step: 0.1 },
                        { key: "watchTimePercent", label: "視聴維持率（%）", step: 1 },
                        { key: "comments", label: "コメント数", step: 1 },
                      ] as const
                    ).map(({ key, label, step }) => (
                      <div key={key}>
                        <label className="text-xs text-gray-500">{label}</label>
                        <input
                          type="number"
                          step={step}
                          value={editValues[key]}
                          onChange={(e) => setEdit(key, Number(e.target.value))}
                          className="w-full px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
                        />
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={saveEdit}
                      disabled={saving}
                      className="flex-1 py-1 rounded bg-blue-600 text-white text-sm disabled:bg-gray-400"
                    >
                      {saving ? "保存中..." : "保存"}
                    </button>
                    <button
                      onClick={() => setEditing(null)}
                      className="flex-1 py-1 rounded border border-gray-300 dark:border-gray-600 text-sm"
                    >
                      キャンセル
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
