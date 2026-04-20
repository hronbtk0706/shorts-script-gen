import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { VideoTemplate, Layer } from "../types";
import { composeLayersToDataUrl } from "../lib/layerComposer";
import { renderTemplatePreview } from "../lib/templatePreviewRunner";

interface Props {
  template: VideoTemplate;
  open: boolean;
  onClose: () => void;
}

interface SegmentPreview {
  segmentIndex: number;
  type: string;
  bodyIndex?: number;
  startSec: number;
  endSec: number;
  dataUrl: string | null;
  error?: string;
}

export function TemplatePreviewModal({ template, open, onClose }: Props) {
  const [previews, setPreviews] = useState<SegmentPreview[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [videoMode, setVideoMode] = useState(false);
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [videoRendering, setVideoRendering] = useState(false);
  const [videoProgress, setVideoProgress] = useState("");
  const [videoError, setVideoError] = useState<string | null>(null);

  const handleRenderVideo = async () => {
    setVideoError(null);
    setVideoPath(null);
    setVideoRendering(true);
    setVideoProgress("準備中...");
    try {
      const result = await renderTemplatePreview(template, setVideoProgress);
      setVideoPath(result.videoPath);
      setVideoMode(true);
    } catch (e) {
      setVideoError(e instanceof Error ? e.message : String(e));
    } finally {
      setVideoRendering(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const initial: SegmentPreview[] = template.segments.map((s, i) => ({
        segmentIndex: i,
        type: s.type,
        bodyIndex: s.bodyIndex,
        startSec: s.startSec,
        endSec: s.endSec,
        dataUrl: null,
      }));
      setPreviews(initial);
      for (let i = 0; i < template.segments.length; i++) {
        if (cancelled) break;
        const seg = template.segments[i];
        try {
          // セグメント開始時刻で可視なレイヤーを合成
          const dataUrl = await composeLayersToDataUrl(
            template.layers,
            placeholderResolver,
            { atTimeSec: seg.startSec },
          );
          if (cancelled) break;
          setPreviews((prev) =>
            prev.map((p, idx) => (idx === i ? { ...p, dataUrl } : p)),
          );
        } catch (e) {
          if (cancelled) break;
          setPreviews((prev) =>
            prev.map((p, idx) =>
              idx === i
                ? { ...p, error: e instanceof Error ? e.message : String(e) }
                : p,
            ),
          );
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, template]);

  if (!open) return null;

  const active = previews[activeIdx];

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-5xl max-h-[95vh] overflow-hidden flex flex-col"
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800">
          <div>
            <h2 className="font-bold">🎬 プレビュー: {template.name}</h2>
            <p className="text-[11px] text-gray-500">
              {template.totalDuration}秒 / {template.layers.length}レイヤー ·
              {template.segments.length}セグメント · AI 画像はプレースホルダ
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded border border-gray-300 dark:border-gray-700 overflow-hidden">
              <button
                onClick={() => setVideoMode(false)}
                className={`px-3 py-1 text-xs ${
                  !videoMode
                    ? "bg-blue-600 text-white"
                    : "bg-white dark:bg-gray-800"
                }`}
              >
                🖼 静止画
              </button>
              <button
                onClick={() => setVideoMode(true)}
                className={`px-3 py-1 text-xs ${
                  videoMode
                    ? "bg-blue-600 text-white"
                    : "bg-white dark:bg-gray-800"
                }`}
              >
                🎥 動画
              </button>
            </div>
            <button
              onClick={onClose}
              className="px-3 py-1 rounded bg-gray-100 dark:bg-gray-800 text-sm"
            >
              閉じる
            </button>
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* 中央: 大プレビュー */}
          <div className="flex-1 flex items-center justify-center bg-gray-950 p-4 overflow-auto flex-col gap-3">
            {videoMode ? (
              <>
                {videoPath ? (
                  <video
                    key={videoPath}
                    src={convertFileSrc(videoPath)}
                    controls
                    autoPlay
                    loop
                    className="max-h-full max-w-full object-contain"
                    style={{ aspectRatio: "9/16" }}
                  />
                ) : videoRendering ? (
                  <div className="text-gray-300 text-sm text-center">
                    <div className="animate-pulse">{videoProgress}</div>
                    <div className="text-[10px] text-gray-500 mt-2">
                      30秒〜1分ほどかかる場合があります
                    </div>
                  </div>
                ) : (
                  <div className="text-gray-300 text-sm text-center">
                    <p className="mb-3">動画プレビューを生成できます</p>
                    <p className="text-[11px] text-gray-500 mb-3">
                      モーション・トランジション・動画レイヤーが実際に再生されます
                    </p>
                    <button
                      onClick={handleRenderVideo}
                      className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-sm"
                    >
                      🎥 動画プレビュー生成
                    </button>
                  </div>
                )}
                {videoError && (
                  <div className="text-red-400 text-xs text-center max-w-lg">
                    {videoError}
                  </div>
                )}
                {videoPath && !videoRendering && (
                  <button
                    onClick={handleRenderVideo}
                    className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-white text-xs"
                  >
                    🔄 再生成
                  </button>
                )}
              </>
            ) : active?.dataUrl ? (
              <img
                src={active.dataUrl}
                alt={`segment ${active.segmentIndex}`}
                className="max-h-full max-w-full object-contain"
                style={{ aspectRatio: "9/16" }}
              />
            ) : active?.error ? (
              <div className="text-red-400 text-sm">{active.error}</div>
            ) : (
              <div className="text-gray-400 text-sm">読み込み中...</div>
            )}
          </div>

          {/* 右: カットサムネイル一覧 */}
          <div className="w-44 border-l border-gray-200 dark:border-gray-800 overflow-y-auto bg-gray-50 dark:bg-gray-900/50 p-2 space-y-2">
            {previews.map((p, i) => (
              <button
                key={i}
                onClick={() => setActiveIdx(i)}
                className={`block w-full rounded border-2 overflow-hidden transition ${
                  i === activeIdx
                    ? "border-blue-500 ring-1 ring-blue-500/50"
                    : "border-gray-300 dark:border-gray-700 hover:border-blue-400"
                }`}
              >
                <div className="bg-gray-950 flex items-center justify-center h-40">
                  {p.dataUrl ? (
                    <img
                      src={p.dataUrl}
                      alt={`thumb ${p.segmentIndex}`}
                      className="max-h-full max-w-full object-contain"
                    />
                  ) : p.error ? (
                    <span className="text-red-400 text-[9px] p-1 text-center">
                      {p.error.slice(0, 40)}
                    </span>
                  ) : (
                    <span className="text-gray-500 text-[9px]">...</span>
                  )}
                </div>
                <div className="p-1 text-[10px] bg-white dark:bg-gray-800 text-left">
                  <div className="font-medium">
                    {p.type}
                    {p.bodyIndex !== undefined ? `[${p.bodyIndex}]` : ""}
                  </div>
                  <div className="text-gray-500">
                    {p.startSec}-{p.endSec}s
                  </div>
                </div>
              </button>
            ))}
            {loading && (
              <div className="text-[10px] text-gray-500 text-center pt-2">
                残り{" "}
                {previews.filter((p) => !p.dataUrl && !p.error).length} 生成中...
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

async function placeholderResolver(layer: Layer): Promise<string | null> {
  // 自動(AI) or 未設定 → プレースホルダのデータ URL を返す
  if (layer.source === "auto") return makePlaceholderPattern("AI自動");
  if (layer.source === "user" || !layer.source)
    return makePlaceholderPattern("未設定");
  // ローカルファイル・URL → そのまま返す（layerComposer 側で convertFileSrc される）
  return layer.source;
}

/** Canvas で簡易プレースホルダを作成して data URL で返す */
function makePlaceholderPattern(label: string): string {
  const c = document.createElement("canvas");
  c.width = 200;
  c.height = 200;
  const g = c.getContext("2d");
  if (!g) return "";
  g.fillStyle = "#333";
  g.fillRect(0, 0, 200, 200);
  g.strokeStyle = "#555";
  g.lineWidth = 2;
  for (let i = -200; i < 400; i += 30) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + 200, 200);
    g.stroke();
  }
  g.fillStyle = "#fff";
  g.font = "bold 20px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(`🖼 ${label}`, 100, 100);
  return c.toDataURL("image/png");
}
