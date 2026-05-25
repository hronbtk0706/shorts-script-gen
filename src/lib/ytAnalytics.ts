import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { getValidAccessToken } from "./ytOAuth";

/** YouTube Analytics API から取れる 1 動画分のメトリクス */
export interface VideoAnalytics {
  videoId: string;
  views: number;
  likes: number;
  dislikes: number;
  shares: number;
  comments: number;
  subscribersGained: number;
  subscribersLost: number;
  /** 平均視聴時間（秒） */
  averageViewDuration: number;
  /** 平均視聴維持率（%） */
  averageViewPercentage: number;
  /** インプレッション数 */
  impressions: number;
  /** インプレッションのクリック率（0〜1） */
  impressionClickThroughRate: number;
  /** 取得元の期間 */
  startDate: string;
  endDate: string;
}

/** YouTube Data API から取れる公開メタ情報 */
export interface VideoMeta {
  videoId: string;
  title: string;
  channelTitle: string;
  publishedAt: string;
  thumbnail?: string;
  durationSec: number;
  viewCountPublic: number;
  likeCountPublic: number;
  commentCountPublic: number;
}

/** チャンネル基本情報 */
export interface ChannelInfo {
  channelId: string;
  title: string;
  subscribersTotal: number;
  viewsTotal: number;
  videoCount: number;
}

function extractVideoId(urlOrId: string): string {
  const s = urlOrId.trim();
  // すでに 11 文字の ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(
    /(?:youtu\.be\/|youtube\.com\/(?:shorts\/|watch\?v=|embed\/|v\/))([a-zA-Z0-9_-]{11})/,
  );
  if (m) return m[1];
  throw new Error(`動画ID/URL を解釈できません: ${urlOrId}`);
}

function isoDuration(iso: string): number {
  // PT1H2M3S 形式 → 秒
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/);
  if (!m) return 0;
  const h = parseInt(m[1] ?? "0", 10);
  const mm = parseInt(m[2] ?? "0", 10);
  const ss = parseFloat(m[3] ?? "0");
  return h * 3600 + mm * 60 + ss;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getValidAccessToken();
  return { Authorization: `Bearer ${token}` };
}

/** 自分のチャンネル情報を取る（mine=true） */
export async function fetchOwnChannel(): Promise<ChannelInfo> {
  const headers = await authHeaders();
  const url =
    "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true";
  const res = await tauriFetch(url, { method: "GET", headers });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`channels.list: ${res.status} ${txt.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    items?: Array<{
      id: string;
      snippet?: { title?: string };
      statistics?: {
        subscriberCount?: string;
        viewCount?: string;
        videoCount?: string;
      };
    }>;
  };
  const item = json.items?.[0];
  if (!item) throw new Error("チャンネルが見つかりません");
  return {
    channelId: item.id,
    title: item.snippet?.title ?? "",
    subscribersTotal: parseInt(item.statistics?.subscriberCount ?? "0", 10),
    viewsTotal: parseInt(item.statistics?.viewCount ?? "0", 10),
    videoCount: parseInt(item.statistics?.videoCount ?? "0", 10),
  };
}

/** 動画の公開メタ情報（タイトル・再生数・高評価数など） */
export async function fetchVideoMeta(
  urlOrId: string,
): Promise<VideoMeta> {
  const videoId = extractVideoId(urlOrId);
  const headers = await authHeaders();
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${videoId}`;
  const res = await tauriFetch(url, { method: "GET", headers });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`videos.list: ${res.status} ${txt.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    items?: Array<{
      id: string;
      snippet?: {
        title?: string;
        channelTitle?: string;
        publishedAt?: string;
        thumbnails?: { medium?: { url?: string } };
      };
      contentDetails?: { duration?: string };
      statistics?: {
        viewCount?: string;
        likeCount?: string;
        commentCount?: string;
      };
    }>;
  };
  const item = json.items?.[0];
  if (!item) throw new Error(`動画が見つかりません: ${videoId}`);
  return {
    videoId,
    title: item.snippet?.title ?? "",
    channelTitle: item.snippet?.channelTitle ?? "",
    publishedAt: item.snippet?.publishedAt ?? "",
    thumbnail: item.snippet?.thumbnails?.medium?.url,
    durationSec: isoDuration(item.contentDetails?.duration ?? "PT0S"),
    viewCountPublic: parseInt(item.statistics?.viewCount ?? "0", 10),
    likeCountPublic: parseInt(item.statistics?.likeCount ?? "0", 10),
    commentCountPublic: parseInt(item.statistics?.commentCount ?? "0", 10),
  };
}

/**
 * YouTube Analytics API で 1 動画の詳細メトリクスを取得する。
 * 自分のチャンネルの動画のみ対象。投稿翌日以降データが揃ってくる。
 */
export async function fetchVideoAnalytics(
  urlOrId: string,
  opts?: { startDate?: string; endDate?: string },
): Promise<VideoAnalytics> {
  const videoId = extractVideoId(urlOrId);
  const headers = await authHeaders();

  // 期間: 未指定なら「動画投稿日 〜 今日」
  const endDate = opts?.endDate ?? today();
  let startDate = opts?.startDate;
  if (!startDate) {
    try {
      const meta = await fetchVideoMeta(urlOrId);
      startDate = (meta.publishedAt ?? "").slice(0, 10) || "2000-01-01";
    } catch {
      startDate = "2000-01-01";
    }
  }

  const metrics = [
    "views",
    "likes",
    "dislikes",
    "shares",
    "comments",
    "subscribersGained",
    "subscribersLost",
    "averageViewDuration",
    "averageViewPercentage",
  ].join(",");
  const url =
    `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3DMINE` +
    `&startDate=${startDate}&endDate=${endDate}` +
    `&metrics=${metrics}&filters=video%3D%3D${videoId}`;

  const res = await tauriFetch(url, { method: "GET", headers });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`analytics reports: ${res.status} ${txt.slice(0, 400)}`);
  }
  const json = (await res.json()) as {
    columnHeaders?: Array<{ name: string }>;
    rows?: Array<Array<number>>;
  };
  const row = json.rows?.[0] ?? [];
  const headers2 = json.columnHeaders ?? [];
  const get = (name: string): number => {
    const i = headers2.findIndex((h) => h.name === name);
    return i >= 0 && row[i] != null ? Number(row[i]) : 0;
  };

  // インプレッション / CTR は別クエリ（2015年以降データ）
  let impressions = 0;
  let ctr = 0;
  try {
    const ctrUrl =
      `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3DMINE` +
      `&startDate=${startDate}&endDate=${endDate}` +
      `&metrics=impressions,impressionsClickThroughRate&filters=video%3D%3D${videoId}`;
    const ctrRes = await tauriFetch(ctrUrl, { method: "GET", headers });
    if (ctrRes.ok) {
      const cj = (await ctrRes.json()) as {
        columnHeaders?: Array<{ name: string }>;
        rows?: Array<Array<number>>;
      };
      const r = cj.rows?.[0] ?? [];
      const h = cj.columnHeaders ?? [];
      impressions = Number(r[h.findIndex((x) => x.name === "impressions")] ?? 0);
      const ctrVal = Number(
        r[h.findIndex((x) => x.name === "impressionsClickThroughRate")] ?? 0,
      );
      // CTR はパーセンテージ(0〜100)で返る仕様 → 0〜1 に正規化して保存
      ctr = ctrVal > 1 ? ctrVal / 100 : ctrVal;
    }
  } catch {
    // CTR 取得に失敗しても基本メトリクスは返す
  }

  return {
    videoId,
    views: get("views"),
    likes: get("likes"),
    dislikes: get("dislikes"),
    shares: get("shares"),
    comments: get("comments"),
    subscribersGained: get("subscribersGained"),
    subscribersLost: get("subscribersLost"),
    averageViewDuration: get("averageViewDuration"),
    averageViewPercentage: get("averageViewPercentage"),
    impressions,
    impressionClickThroughRate: ctr,
    startDate,
    endDate,
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 自分のチャンネルの最近投稿した動画一覧 */
export async function fetchMyRecentVideos(
  limit = 10,
): Promise<VideoMeta[]> {
  const headers = await authHeaders();
  // channels.list で uploads プレイリストID を取る
  const chUrl =
    "https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true";
  const chRes = await tauriFetch(chUrl, { method: "GET", headers });
  if (!chRes.ok) {
    throw new Error(`channels.list: ${chRes.status}`);
  }
  const chJson = (await chRes.json()) as {
    items?: Array<{
      contentDetails?: { relatedPlaylists?: { uploads?: string } };
    }>;
  };
  const uploads =
    chJson.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error("アップロードプレイリストが見つかりません");

  // playlistItems.list で videoId リストを取る
  const plUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&playlistId=${uploads}&maxResults=${limit}`;
  const plRes = await tauriFetch(plUrl, { method: "GET", headers });
  if (!plRes.ok) throw new Error(`playlistItems.list: ${plRes.status}`);
  const plJson = (await plRes.json()) as {
    items?: Array<{ contentDetails?: { videoId?: string } }>;
  };
  const ids = (plJson.items ?? [])
    .map((i) => i.contentDetails?.videoId)
    .filter((id): id is string => !!id);
  if (ids.length === 0) return [];

  // まとめて videos.list
  const vUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${ids.join(",")}`;
  const vRes = await tauriFetch(vUrl, { method: "GET", headers });
  if (!vRes.ok) throw new Error(`videos.list: ${vRes.status}`);
  const vJson = (await vRes.json()) as {
    items?: Array<{
      id: string;
      snippet?: {
        title?: string;
        channelTitle?: string;
        publishedAt?: string;
        thumbnails?: { medium?: { url?: string } };
      };
      contentDetails?: { duration?: string };
      statistics?: {
        viewCount?: string;
        likeCount?: string;
        commentCount?: string;
      };
    }>;
  };
  return (vJson.items ?? []).map((item) => ({
    videoId: item.id,
    title: item.snippet?.title ?? "",
    channelTitle: item.snippet?.channelTitle ?? "",
    publishedAt: item.snippet?.publishedAt ?? "",
    thumbnail: item.snippet?.thumbnails?.medium?.url,
    durationSec: isoDuration(item.contentDetails?.duration ?? "PT0S"),
    viewCountPublic: parseInt(item.statistics?.viewCount ?? "0", 10),
    likeCountPublic: parseInt(item.statistics?.likeCount ?? "0", 10),
    commentCountPublic: parseInt(item.statistics?.commentCount ?? "0", 10),
  }));
}
