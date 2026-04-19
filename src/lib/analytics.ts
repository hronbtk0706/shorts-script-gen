import { LazyStore } from "@tauri-apps/plugin-store";
import type { Platform, Duration } from "../types";

const store = new LazyStore("analytics.json");
const KEY = "records";

export interface PerformanceRecord {
  id: string;
  createdAt: string;
  topic: string;
  platform: Platform;
  duration: Duration;
  audience?: string;
  tone?: string;
  goal?: string;
  videoPath?: string;
  views: number;
  likes: number;
  comments: number;
  watchTimePercent: number;
  ctr: number;
  uploadedAt?: string;
  metricsUpdatedAt?: string;
}

export async function saveRecord(record: PerformanceRecord): Promise<void> {
  const records = await loadRecords();
  const idx = records.findIndex((r) => r.id === record.id);
  if (idx >= 0) {
    records[idx] = record;
  } else {
    records.unshift(record);
  }
  await store.set(KEY, records);
  await store.save();
}

export async function loadRecords(): Promise<PerformanceRecord[]> {
  return (await store.get<PerformanceRecord[]>(KEY)) ?? [];
}

export async function updateMetrics(
  id: string,
  metrics: Partial<Pick<PerformanceRecord, "views" | "likes" | "comments" | "watchTimePercent" | "ctr" | "uploadedAt">>,
): Promise<void> {
  const records = await loadRecords();
  const idx = records.findIndex((r) => r.id === id);
  if (idx < 0) return;
  records[idx] = { ...records[idx], ...metrics, metricsUpdatedAt: new Date().toISOString() };
  await store.set(KEY, records);
  await store.save();
}

export async function deleteRecord(id: string): Promise<void> {
  const records = await loadRecords();
  await store.set(KEY, records.filter((r) => r.id !== id));
  await store.save();
}

export function computeInsights(records: PerformanceRecord[]): string {
  const withMetrics = records.filter((r) => r.views > 0);
  if (withMetrics.length === 0) return "";

  const sorted = [...withMetrics].sort((a, b) => b.views - a.views);
  const topN = Math.min(3, sorted.length);
  const top = sorted.slice(0, topN);
  const bottom = sorted.slice(-topN).reverse().filter((r) => !top.some((t) => t.id === r.id));

  const avgViews = Math.round(withMetrics.reduce((s, r) => s + r.views, 0) / withMetrics.length);
  const avgCtr = (withMetrics.reduce((s, r) => s + r.ctr, 0) / withMetrics.length).toFixed(1);
  const avgWatch = (withMetrics.reduce((s, r) => s + r.watchTimePercent, 0) / withMetrics.length).toFixed(0);

  const lines: string[] = [
    `【過去${withMetrics.length}本の動画実績】`,
    `平均: ${avgViews.toLocaleString()}再生 / CTR ${avgCtr}% / 視聴維持率 ${avgWatch}%`,
    "",
    "▶ 成績上位（このパターンを参考に）:",
    ...top.map((r, i) =>
      `${i + 1}. 「${r.topic}」→ ${r.views.toLocaleString()}再生, CTR ${r.ctr}%, 視聴維持 ${r.watchTimePercent}%${r.tone ? ` [${r.tone}]` : ""}${r.goal ? ` [${r.goal}]` : ""}`,
    ),
  ];

  if (bottom.length > 0) {
    lines.push(
      "",
      "▶ 成績下位（このパターンは避けて）:",
      ...bottom.map((r, i) =>
        `${i + 1}. 「${r.topic}」→ ${r.views.toLocaleString()}再生${r.tone ? ` [${r.tone}]` : ""}`,
      ),
    );
  }

  return lines.join("\n");
}
