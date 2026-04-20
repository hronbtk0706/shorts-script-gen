import { Innertube } from "youtubei.js";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type {
  ReferenceVideo,
  ReferenceBundle,
  ExtractedComment,
  CommentBundle,
} from "../types";
import { loadSettings } from "./storage";

let ytInstance: Innertube | null = null;

// ブラウザと見分けがつかないように User-Agent を付けた fetch ラッパー
const browserLikeFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  if (!headers.has("user-agent")) {
    headers.set(
      "user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    );
  }
  if (!headers.has("accept-language")) {
    headers.set("accept-language", "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7");
  }
  return tauriFetch(input as string | URL, {
    ...init,
    headers,
  } as RequestInit);
};

async function getInnertube(): Promise<Innertube> {
  if (ytInstance) return ytInstance;
  ytInstance = await Innertube.create({
    fetch: browserLikeFetch as unknown as typeof fetch,
    // generate_session_locally を外し、YouTube から実セッションを取得させる
  });
  return ytInstance;
}

export function clearInnertubeCache() {
  ytInstance = null;
}

function extractHashtags(text: string): string[] {
  const matches = text.match(/#[^\s#]+/g) ?? [];
  return [...new Set(matches)].slice(0, 10);
}

async function fetchSingleReference(
  yt: Innertube,
  videoId: string,
  apiKey?: string,
): Promise<ReferenceVideo | null> {
  try {
    const info = await yt.getInfo(videoId);
    const basic = info.basic_info;
    const title = basic.title ?? "";
    const channelTitle = basic.channel?.name ?? "";
    const viewCount = typeof basic.view_count === "number" ? basic.view_count : 0;
    const likeCount =
      typeof (basic as unknown as { like_count?: number }).like_count === "number"
        ? (basic as unknown as { like_count: number }).like_count
        : undefined;
    const description =
      (basic as unknown as { short_description?: string }).short_description ??
      (info.secondary_info as unknown as { description?: { text?: string } })?.description?.text ??
      "";
    const hashtags = extractHashtags(description);

    let transcript = "";
    try {
      const tr = await info.getTranscript();
      const segments =
        (tr as unknown as {
          transcript?: { content?: { body?: { initial_segments?: unknown[] } } };
        }).transcript?.content?.body?.initial_segments ?? [];
      transcript = segments
        .map((s: unknown) => {
          const seg = s as { snippet?: { text?: string }; text?: string };
          return (seg.snippet?.text ?? seg.text ?? "").toString().trim();
        })
        .filter(Boolean)
        .join(" ");
    } catch {
      // transcript unavailable
    }

    let topComments: string[] = [];
    if (apiKey) {
      try {
        const extracted = await fetchCommentsViaDataApi(videoId, apiKey, 5);
        topComments = extracted
          .filter((c) => !c.isReply)
          .slice(0, 5)
          .map((c) => c.text.replace(/\s+/g, " ").slice(0, 200));
      } catch (e) {
        console.warn(`[youtube] Data API comments failed for ${videoId}:`, e);
      }
    }

    return {
      videoId,
      title,
      channelTitle,
      viewCount,
      likeCount,
      description: description.slice(0, 800),
      hashtags,
      transcript: transcript.slice(0, 3000),
      topComments,
      publishedAt:
        (basic as unknown as { publish_date?: string }).publish_date ?? undefined,
    };
  } catch (e) {
    console.warn(`[youtube.ts] failed to fetch ${videoId}:`, e);
    return null;
  }
}

function buildPromptText(videos: ReferenceVideo[]): string {
  if (videos.length === 0) return "";
  const lines: string[] = [];
  lines.push(
    "以下は同ジャンル・同キーワードで直近1週間に人気の YouTube ショート動画です。",
    "**コピーせず**、フックの型・構成の流れ・言い回し・感情の動かし方を参考にして、より独自性のある台本を作ってください。",
    "",
  );
  for (const [i, v] of videos.entries()) {
    lines.push(`── 参考動画 ${i + 1} ──`);
    lines.push(`タイトル: ${v.title}`);
    lines.push(`チャンネル: ${v.channelTitle}`);
    lines.push(`再生数: ${v.viewCount.toLocaleString()}`);
    if (v.likeCount) lines.push(`いいね: ${v.likeCount.toLocaleString()}`);
    if (v.publishedAt) lines.push(`投稿: ${v.publishedAt}`);
    if (v.description) lines.push(`説明: ${v.description}`);
    if (v.hashtags.length) lines.push(`ハッシュタグ: ${v.hashtags.join(" ")}`);
    if (v.transcript) {
      lines.push("[字幕全文]");
      lines.push(v.transcript);
    } else {
      lines.push("[字幕なし] → タイトル・説明のみをフック表現の参考に");
    }
    if (v.topComments.length) {
      lines.push("[トップコメント]");
      v.topComments.forEach((c, j) => lines.push(`${j + 1}. ${c}`));
    }
    lines.push("");
  }
  return lines.join("\n");
}

function extractVideoIdFromUrl(url: string): string | null {
  const clean = url.trim();
  if (!clean) return null;
  const patterns = [
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = clean.match(p);
    if (m) return m[1];
  }
  if (/^[a-zA-Z0-9_-]{11}$/.test(clean)) return clean;
  return null;
}

interface DataApiCommentSnippet {
  textDisplay?: string;
  authorDisplayName?: string;
  likeCount?: number;
  publishedAt?: string;
}

interface DataApiTopLevelComment {
  id: string;
  snippet: DataApiCommentSnippet;
}

interface DataApiCommentThread {
  id: string;
  snippet: {
    topLevelComment: DataApiTopLevelComment;
    totalReplyCount?: number;
  };
  replies?: {
    comments?: Array<{ id: string; snippet: DataApiCommentSnippet }>;
  };
}

interface DataApiCommentThreadList {
  items?: DataApiCommentThread[];
  nextPageToken?: string;
}

interface DataApiVideoSnippet {
  title?: string;
  channelTitle?: string;
}

interface DataApiVideoItem {
  snippet: DataApiVideoSnippet;
}

interface DataApiVideoList {
  items?: DataApiVideoItem[];
}

function decodeHtml(s: string): string {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<br\s*\/?>/gi, "\n");
}

/**
 * YouTube Data API v3 で特定動画のコメントを取得。
 * 無料枠 10,000 units/day、commentThreads.list = 1 call あたり 1 unit。
 */
export async function fetchCommentsViaDataApi(
  videoId: string,
  apiKey: string,
  maxCount: number,
  onProgress?: (fetched: number) => void,
): Promise<ExtractedComment[]> {
  const collected: ExtractedComment[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < 10 && collected.length < maxCount; page++) {
    const params = new URLSearchParams({
      part: "snippet,replies",
      videoId,
      maxResults: "100",
      order: "relevance",
      textFormat: "plainText",
      key: apiKey,
    });
    if (pageToken) params.set("pageToken", pageToken);

    const url = `https://www.googleapis.com/youtube/v3/commentThreads?${params}`;
    const res = await tauriFetch(url);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `YouTube Data API ${res.status}: ${text.slice(0, 300)}`,
      );
    }
    const data = (await res.json()) as DataApiCommentThreadList;

    for (const thread of data.items ?? []) {
      if (collected.length >= maxCount) break;
      const top = thread.snippet.topLevelComment;
      const topText = decodeHtml(top.snippet.textDisplay ?? "").trim();
      if (!topText) continue;
      collected.push({
        id: top.id,
        text: topText,
        author: top.snippet.authorDisplayName,
        likeCount: top.snippet.likeCount ?? 0,
        isReply: false,
        publishedAt: top.snippet.publishedAt,
      });
      onProgress?.(collected.length);

      for (const reply of thread.replies?.comments ?? []) {
        if (collected.length >= maxCount) break;
        const replyText = decodeHtml(reply.snippet.textDisplay ?? "").trim();
        if (!replyText) continue;
        collected.push({
          id: reply.id,
          text: replyText,
          author: reply.snippet.authorDisplayName,
          likeCount: reply.snippet.likeCount ?? 0,
          isReply: true,
          parentId: top.id,
          publishedAt: reply.snippet.publishedAt,
        });
        onProgress?.(collected.length);
      }
    }

    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  return collected.slice(0, maxCount);
}

async function fetchVideoMetaViaDataApi(
  videoId: string,
  apiKey: string,
): Promise<{ title?: string; channelTitle?: string }> {
  const params = new URLSearchParams({
    part: "snippet",
    id: videoId,
    key: apiKey,
  });
  const url = `https://www.googleapis.com/youtube/v3/videos?${params}`;
  const res = await tauriFetch(url);
  if (!res.ok) return {};
  const data = (await res.json()) as DataApiVideoList;
  const snippet = data.items?.[0]?.snippet;
  return {
    title: snippet?.title,
    channelTitle: snippet?.channelTitle,
  };
}

export async function fetchAllComments(
  url: string,
  maxCount = 200,
  onProgress?: (fetched: number) => void,
): Promise<CommentBundle | null> {
  const videoId = extractVideoIdFromUrl(url);
  if (!videoId) {
    throw new Error(`URL から videoId を抽出できません: ${url}`);
  }

  const settings = await loadSettings();
  const apiKey = settings.youtubeApiKey;
  if (!apiKey) {
    throw new Error(
      "YouTube Data API キーが設定されていません（⚙️設定 → YouTube API キー を登録してください）",
    );
  }

  try {
    const [comments, meta] = await Promise.all([
      fetchCommentsViaDataApi(videoId, apiKey, maxCount, onProgress),
      fetchVideoMetaViaDataApi(videoId, apiKey),
    ]);

    if (comments.length === 0) {
      throw new Error(
        "コメントを1件も取得できませんでした（動画のコメントが無効化されている可能性）",
      );
    }

    return {
      videoId,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      videoTitle: meta.title,
      channelTitle: meta.channelTitle,
      fetchedAt: new Date().toISOString(),
      comments,
    };
  } catch (e) {
    console.error("[youtube] fetchAllComments failed:", e);
    throw e instanceof Error ? e : new Error(String(e));
  }
}

export async function fetchReferenceVideos(
  query: string,
  maxVideos = 5,
): Promise<ReferenceBundle | null> {
  if (!query.trim()) return null;
  try {
    const yt = await getInnertube();
    const settings = await loadSettings();
    const apiKey = settings.youtubeApiKey || undefined;
    const searchResult = await yt.search(query, {
      type: "shorts",
      upload_date: "week",
      prioritize: "popularity",
    });

    const items =
      ((searchResult as unknown as { results?: unknown[] }).results ?? []) as unknown[];
    const videoIds: string[] = items
      .map((n) => {
        const node = n as { type?: string; id?: string; video_id?: string };
        return node.id ?? node.video_id ?? "";
      })
      .filter((id) => id.length > 0)
      .slice(0, Math.max(maxVideos * 2, maxVideos + 3));

    const fetched: ReferenceVideo[] = [];
    for (const id of videoIds) {
      if (fetched.length >= maxVideos) break;
      const v = await fetchSingleReference(yt, id, apiKey);
      if (v) fetched.push(v);
    }

    if (fetched.length === 0) return null;

    return {
      query,
      fetchedAt: new Date().toISOString(),
      videos: fetched,
      promptText: buildPromptText(fetched),
    };
  } catch (e) {
    console.error("[youtube.ts] fetchReferenceVideos failed:", e);
    return null;
  }
}

// ─────────────────────────────────────────
// 旧 YouTube Data API ベースの関数（互換維持）
// ─────────────────────────────────────────

interface YtSearchItem {
  id: { videoId: string };
  snippet: { title: string; channelTitle: string };
}

interface YtStatItem {
  id: string;
  statistics: { viewCount?: string; likeCount?: string };
}

export interface TrendInsights {
  summary: string;
}

function sevenDaysAgo(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString();
}

/**
 * @deprecated fetchReferenceVideos() を推奨。API キー不要・情報量も豊富。
 */
export async function fetchYouTubeTrends(
  apiKey: string,
  query: string,
): Promise<TrendInsights | null> {
  try {
    const after = encodeURIComponent(sevenDaysAgo());
    const q = encodeURIComponent(query);
    const searchUrl =
      `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${q}&type=video&videoDuration=short&order=viewCount&maxResults=10&publishedAfter=${after}&regionCode=JP&relevanceLanguage=ja&key=${apiKey}`;

    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) return null;
    const searchData = (await searchRes.json()) as { items?: YtSearchItem[] };
    if (!searchData.items?.length) return null;

    const ids = searchData.items.map((it) => it.id.videoId).join(",");
    const statsUrl =
      `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids}&key=${apiKey}`;
    const statsRes = await fetch(statsUrl);
    if (!statsRes.ok) return null;
    const statsData = (await statsRes.json()) as { items?: YtStatItem[] };

    const statsMap = new Map<string, YtStatItem["statistics"]>();
    for (const item of statsData.items ?? []) {
      statsMap.set(item.id, item.statistics);
    }

    const videos = searchData.items
      .map((it) => {
        const stats = statsMap.get(it.id.videoId);
        return {
          title: it.snippet.title,
          views: parseInt(stats?.viewCount ?? "0"),
        };
      })
      .sort((a, b) => b.views - a.views)
      .slice(0, 5);

    const lines = [
      `検索ワード「${query}」の直近7日間トップ動画:`,
      ...videos.map((v, i) => `${i + 1}. 「${v.title}」（${v.views.toLocaleString()}再生）`),
    ];

    return { summary: lines.join("\n") };
  } catch {
    return null;
  }
}
