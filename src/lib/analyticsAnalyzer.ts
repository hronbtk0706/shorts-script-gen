import { GoogleGenAI } from "@google/genai";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { PerformanceRecord } from "./analytics";
import type { AppSettings } from "./storage";

/**
 * 全動画の実績レコードをLLMに分析させ、改善に繋がる傾向・アクションを出す。
 * Markdown テキストで返す（箇条書き中心）。
 */
export async function analyzePerformance(
  records: PerformanceRecord[],
  settings: AppSettings,
): Promise<string> {
  const withData = records.filter((r) => r.views > 0);
  if (withData.length < 3) {
    throw new Error(
      "分析には最低3本の成績データが必要です（再生数が記録された動画）",
    );
  }

  const prompt = buildAnalyzePrompt(withData);

  // Gemini を第一選択、無ければ Groq/OpenAI
  if (settings.geminiApiKey) {
    const ai = new GoogleGenAI({ apiKey: settings.geminiApiKey });
    const res = await ai.models.generateContent({
      model: "gemini-2.5-flash-lite",
      contents: prompt,
      config: { temperature: 0.5 },
    });
    const text = res.text;
    if (!text) throw new Error("Geminiから応答が得られませんでした");
    return text;
  }
  if (settings.groqApiKey) {
    const res = await tauriFetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.groqApiKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.5,
      }),
    });
    if (!res.ok) throw new Error(`Groq: ${res.status}`);
    const json = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return json.choices?.[0]?.message?.content ?? "";
  }
  if (settings.openaiApiKey) {
    const res = await tauriFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: settings.openaiModel || "gpt-5-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.5,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI: ${res.status}`);
    const json = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return json.choices?.[0]?.message?.content ?? "";
  }
  throw new Error("Gemini / Groq / OpenAI いずれかの API キーを設定してください");
}

function buildAnalyzePrompt(records: PerformanceRecord[]): string {
  const table = records
    .map((r, i) => {
      const parts = [
        `${i + 1}. 「${r.topic}」`,
        `${r.views.toLocaleString()}再生`,
        `CTR ${r.ctr}%`,
        `維持率 ${r.watchTimePercent}%`,
        `👍 ${r.likes}`,
        `💬 ${r.comments}`,
      ];
      if (r.ytAnalytics?.impressions) {
        parts.push(`IMP ${r.ytAnalytics.impressions.toLocaleString()}`);
      }
      if (r.ytAnalytics?.averageViewDurationSec) {
        parts.push(`平均視聴 ${Math.round(r.ytAnalytics.averageViewDurationSec)}s`);
      }
      if (r.ytAnalytics?.subscribersGained !== undefined) {
        parts.push(`登録+${r.ytAnalytics.subscribersGained}`);
      }
      if (r.ytAnalytics?.shares) {
        parts.push(`共有 ${r.ytAnalytics.shares}`);
      }
      if (r.duration) parts.push(`${r.duration}秒`);
      if (r.tone) parts.push(`[${r.tone}]`);
      if (r.uploadedAt) {
        const d = new Date(r.uploadedAt);
        parts.push(d.toLocaleDateString("ja-JP"));
      }
      return parts.join(" / ");
    })
    .join("\n");

  const sorted = [...records].sort((a, b) => b.views - a.views);
  const avgViews = Math.round(
    records.reduce((s, r) => s + r.views, 0) / records.length,
  );
  const avgCtr = (
    records.reduce((s, r) => s + r.ctr, 0) / records.length
  ).toFixed(2);
  const avgRetention = (
    records.reduce((s, r) => s + r.watchTimePercent, 0) / records.length
  ).toFixed(1);

  return `あなたはショート動画（YouTube Shorts / TikTok / Reels）のグロース分析家です。
あるチャンネルの投稿実績データを見て、**数字の裏にあるパターンを読み取り、改善に直結するアクション**を出してください。

# チャンネルの投稿実績（${records.length}本）

全体平均: ${avgViews.toLocaleString()}再生 / CTR ${avgCtr}% / 視聴維持率 ${avgRetention}%
最高再生: ${sorted[0].views.toLocaleString()}（「${sorted[0].topic}」）
最低再生: ${sorted[sorted.length - 1].views.toLocaleString()}（「${sorted[sorted.length - 1].topic}」）

## 各動画データ

${table}

# 分析してほしいこと

以下の観点で、**データに根拠のある洞察**を出してください。憶測や一般論ではなく、必ずこのデータセット内の具体的な動画名を引用して根拠を示すこと。

## 1. 高成績動画の共通点
上位3〜5本の動画の共通点を抽出。タイトルの言い回し、題材ジャンル、動画の長さ、投稿タイミング、トーン等の観点から複数パターンを挙げる。

## 2. 低成績動画の共通点・地雷パターン
下位動画の共通点から「避けるべきパターン」を抽出する。

## 3. CTR と 視聴維持率 の分解分析
CTR が高いのに維持率が低い動画 → サムネ/タイトル詐欺の可能性
CTR が低いのに維持率が高い動画 → 内容は良いが入口が弱い
この2軸で動画を見て、どういう改善が必要かを動画別に指摘する。

## 4. 次に作るべき動画のヒント（具体的に3つ）
データから見える「まだ試していない有望パターン」や「高成績パターンの横展開」を提案。
ジャンル、タイトル例、狙い（なぜ伸びそうか）をセットで。

## 5. 一行サマリ
「このチャンネルを伸ばすための最優先アクション」を1行で。

# 出力形式

Markdown。見出しは ## レベル。太字と箇条書きを活用してスキャンしやすく。日本語で、数字は必ずそのまま引用。500〜800字程度に収める。`;
}
