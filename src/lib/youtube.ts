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
