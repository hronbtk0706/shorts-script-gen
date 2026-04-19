import { invoke } from "@tauri-apps/api/core";

function moodToQuery(mood: string): string {
  const m = mood.toLowerCase();
  if (m.includes("upbeat") || m.includes("明るい") || m.includes("楽し") || m.includes("ポップ")) return "upbeat happy";
  if (m.includes("calm") || m.includes("穏やか") || m.includes("落ち着") || m.includes("リラ")) return "calm relaxing";
  if (m.includes("dramatic") || m.includes("ドラマ") || m.includes("感動") || m.includes("epic") || m.includes("壮大")) return "cinematic dramatic";
  if (m.includes("inspir") || m.includes("やる気") || m.includes("モチベ") || m.includes("motivat")) return "inspiring motivational";
  if (m.includes("fun") || m.includes("funny") || m.includes("コミカル") || m.includes("cute")) return "playful fun";
  if (m.includes("sad") || m.includes("哀") || m.includes("悲し")) return "sad emotional";
  if (m.includes("mysterious") || m.includes("神秘") || m.includes("dark") || m.includes("ダーク")) return "mysterious ambient";
  if (m.includes("corporate") || m.includes("ビジネス") || m.includes("professional")) return "corporate background";
  return mood;
}

interface PixabayHit {
  audio: string;
  title: string;
  duration: number;
}

interface PixabayResponse {
  hits: PixabayHit[];
}

export async function fetchPixabayBgm(
  apiKey: string,
  mood: string,
  sessionId: string,
): Promise<string | null> {
  const query = encodeURIComponent(moodToQuery(mood));
  const url = `https://pixabay.com/api/?key=${apiKey}&q=${query}&media_type=music&per_page=5&order=popular`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Pixabay API error: ${res.status}`);
    const data: PixabayResponse = await res.json();
    if (!data.hits || data.hits.length === 0) return null;

    // 60秒以上の曲を優先
    const hit = data.hits.find((h) => h.duration >= 60) ?? data.hits[0];
    if (!hit.audio) return null;

    return await invoke<string>("download_bgm", {
      sessionId,
      url: hit.audio,
    });
  } catch {
    return null;
  }
}
