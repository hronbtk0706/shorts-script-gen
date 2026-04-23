import { useEffect, useState } from "react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { VideoTemplate } from "../types";
import {
  cancelTemplateExport,
  exportTemplateToVideo,
} from "../lib/exportTemplate";
import type { ProgressUpdate, VideoQualityPreset } from "../lib/video";

const QUALITY_PRESET_LABEL: Record<
  VideoQualityPreset,
  { label: string; desc: string }
> = {
  low: { label: "低画質（テスト用）", desc: "CRF 28 / faster" },
  standard: { label: "標準（推奨）", desc: "CRF 23 / medium" },
  high: { label: "高画質（投稿用）", desc: "CRF 18 / slow（時間かかる）" },
};
const QUALITY_STORAGE_KEY = "video-quality-preset";

interface Props {
  open: boolean;
  template: VideoTemplate;
  onClose: () => void;
}

type Phase = "idle" | "running" | "cancelling" | "success" | "cancelled" | "error";

const PHASE_LABEL: Record<string, string> = {
  prompt: "準備中…",
  image: "画像・レイヤー合成中…",
  tts: "音声合成中…",
  overlay: "テロップ生成中…",
  compose: "動画を結合中（FFmpeg）…",
  done: "完了",
  error: "エラー",
};

export function ExportModal({ open, template, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [quality, setQuality] = useState<VideoQualityPreset>(() => {
    const saved =
      typeof window !== "undefined"
        ? localStorage.getItem(QUALITY_STORAGE_KEY)
        : null;
    if (saved === "low" || saved === "standard" || saved === "high") return saved;
    return "standard";
  });

  useEffect(() => {
    if (!open) {
      // モーダルを閉じたら状態をリセット
      setPhase("idle");
      setProgress(null);
      setLog([]);
      setOutputPath(null);
      setErrorMsg(null);
    }
  }, [open]);

  const handleStart = () => {
    if (phase === "running") return;
    try {
      localStorage.setItem(QUALITY_STORAGE_KEY, quality);
    } catch {
      /* localStorage が使えない環境なら無視 */
    }
    setPhase("running");
    setLog(["エクスポート開始: " + template.name]);
    setOutputPath(null);
    setErrorMsg(null);

    exportTemplateToVideo({
      template,
      quality,
      onProgress: (p) => {
        setProgress(p);
        if (p.message) {
          setLog((prev) => [...prev, p.message]);
        }
      },
    })
      .then((result) => {
        setOutputPath(result.outputPath);
        setPhase("success");
        setLog((prev) => [...prev, `完成: ${result.outputPath}`]);
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("cancelled")) {
          setPhase("cancelled");
          setLog((prev) => [...prev, "エクスポートをキャンセルしました"]);
        } else {
          setErrorMsg(msg);
          setPhase("error");
          setLog((prev) => [...prev, `失敗: ${msg}`]);
        }
      });
  };

  const handleCancel = async () => {
    if (phase !== "running") return;
    setPhase("cancelling");
    setLog((prev) => [...prev, "キャンセル中…"]);
    await cancelTemplateExport();
  };

  const handleOpenFolder = async () => {
    if (!outputPath) return;
    try {
      await revealItemInDir(outputPath);
    } catch (e) {
      console.warn("[ExportModal] reveal failed, fallback to openPath", e);
      try {
        await openPath(outputPath);
      } catch (e2) {
        console.error("[ExportModal] openPath also failed", e2);
      }
    }
  };

  if (!open) return null;

  const phaseLabel =
    progress?.phase && PHASE_LABEL[progress.phase]
      ? PHASE_LABEL[progress.phase]
      : "準備中…";
  const percent =
    progress && progress.totalScenes > 0 && progress.sceneIndex !== undefined
      ? Math.round(
          ((progress.sceneIndex + 1) / (progress.totalScenes + 1)) * 100,
        )
      : phase === "success"
        ? 100
        : 0;

  const isBusy = phase === "running" || phase === "cancelling";
  const isClosable = !isBusy;

  return (
    <div
      className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center p-4"
      onClick={(e) => {
        // 親画面ロック: モーダル内は操作可能、外側クリックは無視（書き出し中は特に）
        if (e.target === e.currentTarget && isClosable) {
          onClose();
        }
      }}
    >
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-lg w-full p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">
            🎬 動画エクスポート
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={!isClosable}
            className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 text-lg disabled:opacity-30 disabled:cursor-not-allowed"
            title={isClosable ? "閉じる" : "処理中は閉じられません"}
          >
            ✕
          </button>
        </div>

        <div className="text-xs text-gray-600 dark:text-gray-400">
          {template.name}（{template.totalDuration}秒 /{" "}
          {template.layers.length}レイヤー）
        </div>

        {/* 画質選択（idle 状態のみ操作可能） */}
        <div
          className={`rounded border border-gray-200 dark:border-gray-700 p-2 space-y-1.5 ${
            phase !== "idle" ? "opacity-60 pointer-events-none" : ""
          }`}
        >
          <div className="text-[11px] font-medium text-gray-700 dark:text-gray-300">
            画質
          </div>
          <div className="grid grid-cols-1 gap-1">
            {(["low", "standard", "high"] as VideoQualityPreset[]).map((q) => (
              <label
                key={q}
                className={`flex items-center gap-2 px-2 py-1 rounded cursor-pointer text-[11px] ${
                  quality === q
                    ? "bg-blue-50 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700"
                    : "border border-transparent hover:bg-gray-50 dark:hover:bg-gray-800"
                }`}
              >
                <input
                  type="radio"
                  name="quality"
                  value={q}
                  checked={quality === q}
                  onChange={() => setQuality(q)}
                />
                <div className="flex-1">
                  <div className="font-medium">
                    {QUALITY_PRESET_LABEL[q].label}
                  </div>
                  <div className="text-[10px] text-gray-500">
                    {QUALITY_PRESET_LABEL[q].desc}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* 開始ボタン（idle 状態のみ） */}
        {phase === "idle" && (
          <button
            type="button"
            onClick={handleStart}
            className="w-full py-2 rounded bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium"
          >
            🎬 エクスポート開始
          </button>
        )}

        {/* 進捗バー */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-gray-600 dark:text-gray-400">
              {phase === "success"
                ? "✅ 完了しました"
                : phase === "cancelled"
                  ? "⚠ キャンセルされました"
                  : phase === "error"
                    ? "❌ 失敗しました"
                    : phase === "cancelling"
                      ? "キャンセル中…"
                      : phaseLabel}
            </span>
            <span className="text-gray-500">{percent}%</span>
          </div>
          <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded overflow-hidden">
            <div
              className={`h-full transition-all ${
                phase === "success"
                  ? "bg-emerald-500"
                  : phase === "error"
                    ? "bg-red-500"
                    : phase === "cancelled"
                      ? "bg-amber-500"
                      : "bg-blue-500"
              }`}
              style={{ width: `${percent}%` }}
            />
          </div>
          {progress?.sceneIndex !== undefined && (
            <div className="text-[10px] text-gray-500">
              シーン {progress.sceneIndex + 1} / {progress.totalScenes}
            </div>
          )}
        </div>

        {/* ログ（最新 6 行） */}
        {log.length > 0 && (
          <div className="bg-gray-50 dark:bg-gray-800 rounded p-2 max-h-32 overflow-y-auto text-[10px] font-mono text-gray-700 dark:text-gray-300 space-y-0.5">
            {log.slice(-8).map((l, i) => (
              <div key={i} className="truncate">
                {l}
              </div>
            ))}
          </div>
        )}

        {errorMsg && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-[11px] rounded p-2 max-h-24 overflow-auto">
            {errorMsg}
          </div>
        )}

        {/* アクションボタン */}
        <div className="flex justify-end gap-2 pt-2 border-t border-gray-200 dark:border-gray-800">
          {phase === "running" && (
            <button
              type="button"
              onClick={handleCancel}
              className="px-3 py-1.5 rounded border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 text-xs hover:bg-red-50 dark:hover:bg-red-900/20"
            >
              キャンセル
            </button>
          )}
          {phase === "cancelling" && (
            <button
              type="button"
              disabled
              className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-xs text-gray-400"
            >
              キャンセル処理中…
            </button>
          )}
          {phase === "success" && (
            <>
              <button
                type="button"
                onClick={handleOpenFolder}
                className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-xs"
              >
                📂 フォルダを開く
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-xs"
              >
                閉じる
              </button>
            </>
          )}
          {(phase === "cancelled" || phase === "error") && (
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-xs"
            >
              閉じる
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
