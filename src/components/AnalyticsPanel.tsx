import { useState, useEffect } from "react";
import {
  loadRecords,
  updateMetrics,
  deleteRecord,
  patchRecord,
  saveRecord,
  computeInsights,
  type PerformanceRecord,
} from "../lib/analytics";
import {
  getStoredTokens,
  startOAuthFlow,
  clearTokens,
} from "../lib/ytOAuth";
import {
  fetchVideoMeta,
  fetchVideoAnalytics,
  fetchMyRecentVideos,
  type VideoMeta,
} from "../lib/ytAnalytics";
import { loadSettings } from "../lib/storage";
import { analyzePerformance } from "../lib/analyticsAnalyzer";

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

function genId(): string {
  return `perf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function AnalyticsPanel() {
  const [records, setRecords] = useState<PerformanceRecord[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<EditState>({ views: 0, likes: 0, comments: 0, watchTimePercent: 0, ctr: 0 });
  const [saving, setSaving] = useState(false);

  const [connected, setConnected] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [ytError, setYtError] = useState<string | null>(null);
  const [syncBusyId, setSyncBusyId] = useState<string | null>(null);

  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [linkUrl, setLinkUrl] = useState("");

  const [recentBusy, setRecentBusy] = useState(false);
  const [recentVideos, setRecentVideos] = useState<VideoMeta[] | null>(null);

  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [analysisReport, setAnalysisReport] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const refresh = async () => {
    setRecords(await loadRecords());
  };

  const refreshAuth = async () => {
    const t = await getStoredTokens();
    setConnected(!!t);
  };

  useEffect(() => {
    refresh();
    refreshAuth();
  }, []);

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

  const handleConnect = async () => {
    setYtError(null);
    setAuthBusy(true);
    try {
      const settings = await loadSettings();
      if (!settings.youtubeOAuthClientId || !settings.youtubeOAuthClientSecret) {
        throw new Error(
          "先に設定画面で YouTube OAuth の Client ID と Client Secret を登録してください",
        );
      }
      await startOAuthFlow();
      await refreshAuth();
    } catch (e) {
      setYtError(e instanceof Error ? e.message : String(e));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm("YouTube 連携を解除しますか？")) return;
    await clearTokens();
    await refreshAuth();
  };

  const handleSyncRecord = async (r: PerformanceRecord) => {
    const videoId = r.youtubeVideoId;
    if (!videoId) return;
    setYtError(null);
    setSyncBusyId(r.id);
    try {
      const [meta, an] = await Promise.all([
        fetchVideoMeta(videoId),
        fetchVideoAnalytics(videoId),
      ]);
      await patchRecord(r.id, {
        views: an.views || meta.viewCountPublic,
        likes: an.likes || meta.likeCountPublic,
        comments: an.comments || meta.commentCountPublic,
        watchTimePercent: Number(an.averageViewPercentage.toFixed(1)),
        ctr: Number((an.impressionClickThroughRate * 100).toFixed(2)),
        uploadedAt: meta.publishedAt,
        metricsUpdatedAt: new Date().toISOString(),
        ytAnalytics: {
          shares: an.shares,
          subscribersGained: an.subscribersGained,
          subscribersLost: an.subscribersLost,
          averageViewDurationSec: an.averageViewDuration,
          impressions: an.impressions,
          fetchedAt: new Date().toISOString(),
        },
      });
      await refresh();
    } catch (e) {
      setYtError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncBusyId(null);
    }
  };

  const handleLinkSave = async (r: PerformanceRecord) => {
    const u = linkUrl.trim();
    if (!u) {
      setLinkingId(null);
      return;
    }
    setYtError(null);
    try {
      const meta = await fetchVideoMeta(u);
      await patchRecord(r.id, {
        youtubeVideoId: meta.videoId,
        topic: r.topic || meta.title,
        uploadedAt: meta.publishedAt,
      });
      setLinkingId(null);
      setLinkUrl("");
      await refresh();
      // すぐ成績取得も試行
      const record = (await loadRecords()).find((x) => x.id === r.id);
      if (record) await handleSyncRecord(record);
    } catch (e) {
      setYtError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleLoadMyRecent = async () => {
    setYtError(null);
    setRecentBusy(true);
    try {
      const list = await fetchMyRecentVideos(15);
      setRecentVideos(list);
    } catch (e) {
      setYtError(e instanceof Error ? e.message : String(e));
    } finally {
      setRecentBusy(false);
    }
  };

  const handleAddFromYouTube = async (v: VideoMeta) => {
    // 既存レコードにリンク済みかチェック
    const existing = records.find((r) => r.youtubeVideoId === v.videoId);
    if (existing) {
      await handleSyncRecord(existing);
      return;
    }
    // 新規レコード作成
    const newRecord: PerformanceRecord = {
      id: genId(),
      createdAt: new Date().toISOString(),
      topic: v.title,
      platform: "shorts",
      duration: v.durationSec <= 60 ? 60 : 60,
      views: v.viewCountPublic,
      likes: v.likeCountPublic,
      comments: v.commentCountPublic,
      watchTimePercent: 0,
      ctr: 0,
      uploadedAt: v.publishedAt,
      youtubeVideoId: v.videoId,
    };
    await saveRecord(newRecord);
    await refresh();
    await handleSyncRecord(newRecord);
  };

  const handleAnalyze = async () => {
    setAnalysisError(null);
    setAnalysisBusy(true);
    setAnalysisReport(null);
    try {
      const settings = await loadSettings();
      const report = await analyzePerformance(records, settings);
      setAnalysisReport(report);
    } catch (e) {
      setAnalysisError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalysisBusy(false);
    }
  };

  const insights = computeInsights(records);
  const hasEnoughDataForAnalysis =
    records.filter((r) => r.views > 0).length >= 3;

  return (
    <div className="space-y-5">
      {/* YouTube 連携パネル */}
      <div className="p-3 rounded-xl border border-red-200 dark:border-red-900/30 bg-red-50/50 dark:bg-red-950/20">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-sm font-medium text-red-800 dark:text-red-200">
            📊 YouTube 連携
          </div>
          {connected ? (
            <div className="flex gap-2 items-center">
              <span className="text-xs text-emerald-700 dark:text-emerald-300">
                ● 連携済み
              </span>
              <button
                onClick={handleLoadMyRecent}
                disabled={recentBusy}
                className="text-xs px-2 py-1 rounded bg-red-600 hover:bg-red-700 disabled:bg-gray-400 text-white"
              >
                {recentBusy ? "取得中..." : "🎞 自分の動画一覧を取得"}
              </button>
              <button
                onClick={handleDisconnect}
                className="text-xs px-2 py-1 rounded border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300"
              >
                連携解除
              </button>
            </div>
          ) : (
            <button
              onClick={handleConnect}
              disabled={authBusy}
              className="text-xs px-3 py-1 rounded bg-red-600 hover:bg-red-700 disabled:bg-gray-400 text-white"
            >
              {authBusy ? "ブラウザで認証中..." : "🔗 YouTube と連携する"}
            </button>
          )}
        </div>
        {!connected && (
          <p className="text-[11px] text-gray-600 dark:text-gray-400 mt-2">
            Google Cloud Console で作成した OAuth Client ID / Secret を設定画面で登録してから連携してください。連携後、動画URLを入力するか自分の動画一覧から取り込めば、再生数・視聴維持率・CTR等が自動取得されます。
          </p>
        )}
        {ytError && (
          <div className="mt-2 p-2 rounded bg-red-100 dark:bg-red-900/40 text-xs text-red-800 dark:text-red-200">
            {ytError}
          </div>
        )}
        {recentVideos && (
          <div className="mt-3 space-y-1 max-h-60 overflow-y-auto">
            <div className="text-[11px] text-gray-600 dark:text-gray-400">
              自分の最近の動画から取り込み（{recentVideos.length}件）:
            </div>
            {recentVideos.map((v) => {
              const existing = records.find((r) => r.youtubeVideoId === v.videoId);
              return (
                <div
                  key={v.videoId}
                  className="flex items-center gap-2 p-1.5 rounded bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 text-xs"
                >
                  {v.thumbnail && (
                    <img src={v.thumbnail} className="w-16 h-9 object-cover rounded" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium">{v.title}</div>
                    <div className="text-[10px] text-gray-500">
                      {v.viewCountPublic.toLocaleString()}回 / 👍 {v.likeCountPublic.toLocaleString()} / {Math.round(v.durationSec)}秒
                    </div>
                  </div>
                  <button
                    onClick={() => handleAddFromYouTube(v)}
                    className="px-2 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white text-[11px] shrink-0"
                  >
                    {existing ? "同期" : "追加"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* AI パターン分析 */}
      <div className="p-3 rounded-xl border border-purple-200 dark:border-purple-900/30 bg-purple-50/40 dark:bg-purple-950/20">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-sm font-medium text-purple-800 dark:text-purple-200">
            🧠 AI による全動画パターン分析
          </div>
          <button
            onClick={handleAnalyze}
            disabled={analysisBusy || !hasEnoughDataForAnalysis}
            className="text-xs px-3 py-1 rounded bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 text-white"
            title={
              hasEnoughDataForAnalysis
                ? "実績のある全動画をAIに分析させる"
                : "最低3本の成績データが必要です"
            }
          >
            {analysisBusy ? "分析中..." : "AIに分析させる"}
          </button>
        </div>
        {!hasEnoughDataForAnalysis && (
          <p className="text-[11px] text-gray-600 dark:text-gray-400 mt-1">
            最低3本の動画の成績データ（再生数 &gt; 0）が必要です
          </p>
        )}
        {analysisError && (
          <div className="mt-2 p-2 rounded bg-red-100 dark:bg-red-900/40 text-xs text-red-800 dark:text-red-200">
            {analysisError}
          </div>
        )}
        {analysisReport && (
          <div className="mt-3 p-3 rounded bg-white dark:bg-gray-900 border border-purple-200 dark:border-purple-900/40 text-sm whitespace-pre-wrap leading-relaxed max-h-[500px] overflow-y-auto">
            {analysisReport}
          </div>
        )}
      </div>

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
                    {r.youtubeVideoId && (
                      <>
                        &nbsp;|&nbsp;
                        <a
                          href={`https://youtube.com/watch?v=${r.youtubeVideoId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-red-600 hover:underline"
                        >
                          YT
                        </a>
                      </>
                    )}
                  </p>
                </div>
                <div className="flex gap-2 shrink-0 flex-wrap">
                  {connected && r.youtubeVideoId && (
                    <button
                      onClick={() => handleSyncRecord(r)}
                      disabled={syncBusyId === r.id}
                      className="text-xs px-2 py-1 rounded bg-red-600 hover:bg-red-700 disabled:bg-gray-400 text-white"
                      title="YouTube から最新データを取得"
                    >
                      {syncBusyId === r.id ? "取得中..." : "🔄 YT同期"}
                    </button>
                  )}
                  {!r.youtubeVideoId && (
                    <button
                      onClick={() => {
                        setLinkingId(r.id);
                        setLinkUrl("");
                      }}
                      className="text-xs px-2 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                    >
                      🔗 YTリンク
                    </button>
                  )}
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

              {linkingId === r.id && (
                <div className="mt-2 flex gap-1 text-xs">
                  <input
                    type="url"
                    value={linkUrl}
                    onChange={(e) => setLinkUrl(e.target.value)}
                    placeholder="YouTube 動画 URL"
                    className="flex-1 px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
                    autoFocus
                  />
                  <button
                    onClick={() => handleLinkSave(r)}
                    className="px-2 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white"
                  >
                    保存&取得
                  </button>
                  <button
                    onClick={() => {
                      setLinkingId(null);
                      setLinkUrl("");
                    }}
                    className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600"
                  >
                    ✕
                  </button>
                </div>
              )}

              {r.views > 0 && editing !== r.id && (
                <div className="mt-2 flex gap-4 text-xs text-gray-600 dark:text-gray-400 flex-wrap">
                  <span>{r.views.toLocaleString()} 再生</span>
                  <span>CTR {r.ctr}%</span>
                  <span>視聴維持 {r.watchTimePercent}%</span>
                  <span>👍 {r.likes}</span>
                  {r.ytAnalytics?.impressions !== undefined &&
                    r.ytAnalytics.impressions > 0 && (
                      <span>
                        IMP {r.ytAnalytics.impressions.toLocaleString()}
                      </span>
                    )}
                  {r.ytAnalytics?.averageViewDurationSec !== undefined &&
                    r.ytAnalytics.averageViewDurationSec > 0 && (
                      <span>
                        平均視聴 {Math.round(r.ytAnalytics.averageViewDurationSec)}s
                      </span>
                    )}
                  {r.ytAnalytics?.subscribersGained !== undefined &&
                    r.ytAnalytics.subscribersGained > 0 && (
                      <span>
                        登録+{r.ytAnalytics.subscribersGained}
                      </span>
                    )}
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
