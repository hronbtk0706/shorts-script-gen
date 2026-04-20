import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { VideoTemplate } from "../types";
import { renderTemplatePreview } from "../lib/templatePreviewRunner";

interface Props {
  template: VideoTemplate;
  open: boolean;
  onClose: () => void;
}

export function TemplatePreviewModal({ template, open, onClose }: Props) {
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
    } catch (e) {
      setVideoError(e instanceof Error ? e.message : String(e));
    } finally {
      setVideoRendering(false);
    }
  };

  // プレビューを開くたびに自動生成
  useEffect(() => {
    if (!open) return;
    setVideoPath(null);
    setVideoError(null);
    handleRenderVideo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, template]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-[9999] p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-3xl max-h-[95vh] overflow-hidden flex flex-col"
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
            {videoPath && !videoRendering && (
              <button
                onClick={handleRenderVideo}
                className="px-3 py-1 rounded bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-xs"
              >
                🔄 再生成
              </button>
            )}
            <button
              onClick={onClose}
              className="px-3 py-1 rounded bg-gray-100 dark:bg-gray-800 text-sm"
            >
              閉じる
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto bg-gray-950 p-4 flex items-center justify-center flex-col gap-3">
          {videoPath ? (
            <video
              key={videoPath}
              src={convertFileSrc(videoPath)}
              controls
              autoPlay
              loop
              playsInline
              className="object-contain bg-black"
              style={{ maxHeight: "calc(95vh - 140px)", width: "auto" }}
            />
          ) : videoRendering ? (
            <div className="text-gray-300 text-sm text-center">
              <div className="animate-pulse">{videoProgress}</div>
              <div className="text-[10px] text-gray-500 mt-2">
                30秒〜1分ほどかかる場合があります
              </div>
            </div>
          ) : videoError ? (
            <div className="text-red-400 text-xs text-center max-w-lg whitespace-pre-wrap font-mono">
              {videoError}
              <div className="mt-3">
                <button
                  onClick={handleRenderVideo}
                  className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-xs"
                >
                  🔄 再試行
                </button>
              </div>
            </div>
          ) : (
            <div className="text-gray-400 text-sm">準備中...</div>
          )}
        </div>
      </div>
    </div>
  );
}
