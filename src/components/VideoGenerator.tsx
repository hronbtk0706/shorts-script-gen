import { useState } from "react";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { generateVideo, type ProgressUpdate } from "../lib/video";
import { saveRecord } from "../lib/analytics";
import type { Script, ScriptInput } from "../types";

interface Props {
  apiKey: string;
  script: Script;
  scriptInput?: ScriptInput;
  onVideoGenerated?: (sessionId: string, videoPath: string) => void;
}

function buildDescription(script: Script): string {
  const lines: string[] = [];
  if (script.cta.text) lines.push(script.cta.text);
  lines.push("");
  if (script.hashtags.length > 0) lines.push(script.hashtags.join(" "));
  if (!script.hashtags.some((h) => h.toLowerCase().includes("shorts"))) {
    lines.push("#Shorts");
  }
  return lines.join("\n").trim();
}

function buildTags(script: Script): string {
  return script.hashtags.map((h) => h.replace(/^#/, "")).join(", ");
}

export function VideoGenerator({ apiKey, script, scriptInput, onVideoGenerated }: Props) {
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [copied, setCopied] = useState<"title" | "desc" | "tags" | null>(null);

  const copyToClipboard = async (text: string, kind: "title" | "desc" | "tags") => {
    await navigator.clipboard.writeText(text);
    setCopied(kind);
    setTimeout(() => setCopied((c) => (c === kind ? null : c)), 1500);
  };

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    setVideoPath(null);
    setLog([]);
    try {
      const result = await generateVideo(
        apiKey,
        script,
        (p) => {
          setProgress(p);
          setLog((prev) => [...prev, p.message]);
        },
        scriptInput?.template,
        { manualMode: scriptInput?.manualMode === true },
      );
      setVideoPath(result.outputPath);
      if (scriptInput) {
        await saveRecord({
          id: result.sessionId,
          createdAt: new Date().toISOString(),
          topic: scriptInput.topic,
          platform: scriptInput.platform,
          duration: scriptInput.duration,
          audience: scriptInput.audience,
          tone: scriptInput.tone,
          goal: scriptInput.goal,
          videoPath: result.outputPath,
          views: 0,
          likes: 0,
          comments: 0,
          watchTimePercent: 0,
          ctr: 0,
        });
      }
      onVideoGenerated?.(result.sessionId, result.outputPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  const totalScenes = 1 + script.body.length + 1;

  return (
    <div className="space-y-4">
      <div className="p-4 rounded-lg bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800">
        <h3 className="font-semibold text-purple-800 dark:text-purple-200 mb-2">
          動画生成（実験的）
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
          台本の各シーンから AI 画像 + 音声合成 + テロップを生成し、ffmpegで縦型動画（1080×1920）に合成します。
        </p>
        <ul className="text-xs text-gray-500 dark:text-gray-500 space-y-1 mb-3">
          <li>• シーン数: {totalScenes}（フック + 本編{script.body.length} + CTA）</li>
          <li>• 画像: Pollinations.ai（無料）</li>
          <li>• 音声: macOS say コマンド（Kyoko）</li>
          <li>• 所要時間の目安: 1〜3分</li>
        </ul>

        <button
          onClick={handleGenerate}
          disabled={generating}
          className="w-full py-3 rounded-lg bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 text-white font-medium transition"
        >
          {generating ? "生成中..." : "🎬 動画を生成"}
        </button>
      </div>

      {progress && generating && (
        <div className="p-4 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
          <div className="font-medium text-sm mb-2 text-blue-800 dark:text-blue-200">
            {progress.message}
          </div>
          {progress.sceneIndex !== undefined && (
            <div className="w-full h-2 bg-blue-100 dark:bg-blue-950 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-600 transition-all"
                style={{
                  width: `${((progress.sceneIndex + 1) / progress.totalScenes) * 100}%`,
                }}
              />
            </div>
          )}
        </div>
      )}

      {log.length > 0 && (
        <details className="text-xs text-gray-500 dark:text-gray-400">
          <summary className="cursor-pointer">ログ ({log.length})</summary>
          <div className="mt-2 p-3 rounded bg-gray-100 dark:bg-gray-800 font-mono space-y-1 max-h-40 overflow-auto">
            {log.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        </details>
      )}

      {error && (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">
          <div className="font-medium mb-1">エラー</div>
          <div className="font-mono text-xs break-all">{error}</div>
        </div>
      )}

      {videoPath && (
        <div className="p-4 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
          <div className="font-semibold text-green-800 dark:text-green-200 mb-2">
            ✓ 動画が完成しました
          </div>
          <div className="text-xs font-mono break-all mb-3 text-gray-600 dark:text-gray-400">
            {videoPath}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => openPath(videoPath)}
              className="flex-1 py-2 rounded bg-green-600 hover:bg-green-700 text-white text-sm"
            >
              再生
            </button>
            <button
              onClick={() => revealItemInDir(videoPath)}
              className="flex-1 py-2 rounded border border-green-600 text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/40 text-sm"
            >
              Finderで表示
            </button>
          </div>
          <button
            onClick={async () => {
              await copyToClipboard(script.title, "title");
              await revealItemInDir(videoPath);
              await openUrl("https://www.youtube.com/upload");
            }}
            className="mt-2 w-full py-2 rounded bg-red-600 hover:bg-red-700 text-white text-sm font-medium flex items-center justify-center gap-2"
            title="タイトルをクリップボードにコピー、Finderで動画選択、YouTube上げ画面を開く"
          >
            <span>▶</span> YouTubeにアップロード（タイトルをコピー）
          </button>

          <div className="mt-3 space-y-2">
            <div className="text-xs font-medium text-gray-600 dark:text-gray-400">
              投稿メタデータ（コピー＆貼り付け用）
            </div>

            <div>
              <div className="flex justify-between items-center mb-1">
                <span className="text-[10px] text-gray-500">タイトル</span>
                <button
                  onClick={() => copyToClipboard(script.title, "title")}
                  className="text-[10px] px-2 py-0.5 rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600"
                >
                  {copied === "title" ? "✓ コピー済" : "タイトルコピー"}
                </button>
              </div>
              <div className="text-xs p-2 rounded bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 break-all">
                {script.title}
              </div>
            </div>

            <div>
              <div className="flex justify-between items-center mb-1">
                <span className="text-[10px] text-gray-500">説明</span>
                <button
                  onClick={() => copyToClipboard(buildDescription(script), "desc")}
                  className="text-[10px] px-2 py-0.5 rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600"
                >
                  {copied === "desc" ? "✓ コピー済" : "説明コピー"}
                </button>
              </div>
              <pre className="text-xs p-2 rounded bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 whitespace-pre-wrap break-all font-sans">
                {buildDescription(script)}
              </pre>
            </div>

            <div>
              <div className="flex justify-between items-center mb-1">
                <span className="text-[10px] text-gray-500">タグ（カンマ区切り）</span>
                <button
                  onClick={() => copyToClipboard(buildTags(script), "tags")}
                  className="text-[10px] px-2 py-0.5 rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600"
                >
                  {copied === "tags" ? "✓ コピー済" : "タグコピー"}
                </button>
              </div>
              <div className="text-xs p-2 rounded bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 break-all">
                {buildTags(script)}
              </div>
            </div>
          </div>

          <p className="mt-2 text-[10px] text-gray-500 dark:text-gray-400 leading-relaxed">
            使い方: アップロードボタン→Finderの動画をドラッグ→タイトル欄に ⌘V→説明コピー→説明欄に ⌘V→タグコピー→タグ欄に ⌘V
          </p>
        </div>
      )}
    </div>
  );
}
