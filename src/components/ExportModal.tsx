import { useEffect, useRef, useState } from "react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { VideoTemplate } from "../types";
import type { ProgressUpdate } from "../lib/video";
import { exportTemplateWebCodecs } from "../lib/exportTemplateWebCodecs";
import { buildCreditText } from "../lib/buildCreditText";

// 画質プリセットは廃止: WebCodecs はビットレート指定のため画質を変えても
// エンコード速度はほぼ変わらず（所要時間は Canvas 合成が支配的）、常に高画質
// (QUALITY_HIGH) で書き出す。投稿用に十分な品質。

interface Props {
  open: boolean;
  template: VideoTemplate;
  onClose: () => void;
  /** エクスポート成功時にテンプレを自動保存するためのコールバック */
  onAutoSave?: () => Promise<void> | void;
}

type Phase = "idle" | "running" | "cancelling" | "success" | "cancelled" | "error";

const PHASE_LABEL: Record<string, string> = {
  prompt: "準備中…",
  image: "画像・レイヤー合成中…",
  tts: "音声合成中…",
  overlay: "テロップ生成中…",
  compose: "動画を書き出し中…",
  done: "完了",
  error: "エラー",
};

export function ExportModal({ open, template, onClose, onAutoSave }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [title, setTitle] = useState(template.name);
  const webCodecsAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) {
      // モーダルを閉じたら状態をリセット
      setPhase("idle");
      setProgress(null);
      setLog([]);
      setOutputPath(null);
      setErrorMsg(null);
    } else {
      // モーダルを開く度にテンプレ名でタイトルを初期化
      setTitle(template.name);
    }
  }, [open, template.name]);

  const handleStart = () => {
    if (phase === "running") return;
    setPhase("running");
    setLog([`エクスポート開始: ${template.name}`]);
    setOutputPath(null);
    setErrorMsg(null);

    // WebCodecs 経路: Canvas 合成 + h264/AAC encode（filter_complex を経由しない）
    const abortController = new AbortController();
    webCodecsAbortRef.current = abortController;
    exportTemplateWebCodecs({
      template,
      title,
      signal: abortController.signal,
      onProgress: (p) => {
        setProgress({
          phase:
            p.phase === "encoding"
              ? "compose"
              : p.phase === "saving"
                ? "compose"
                : "prompt",
          totalScenes: p.totalFrames ?? 0,
          sceneIndex: p.frame !== undefined ? p.frame - 1 : undefined,
          ratio: p.ratio,
          message: p.message ?? "",
        });
        if (p.message) {
          setLog((prev) => [...prev, p.message!]);
        }
      },
    })
      .then(async (result) => {
        setOutputPath(result.outputPath);
        setPhase("success");
        setLog((prev) => [...prev, `完成: ${result.outputPath}`]);
        if (onAutoSave) {
          try {
            await onAutoSave();
            setLog((prev) => [...prev, "テンプレを自動保存しました"]);
          } catch (e) {
            setLog((prev) => [
              ...prev,
              `テンプレ自動保存に失敗: ${e instanceof Error ? e.message : String(e)}`,
            ]);
          }
        }
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        const stack = e instanceof Error ? e.stack ?? "" : "";
        if (msg.includes("cancelled")) {
          setPhase("cancelled");
          setLog((prev) => [...prev, "エクスポートをキャンセルしました"]);
        } else {
          // スタックトレースまで含めて UI に表示 (release ビルドだと devtools 効かないため)
          setErrorMsg(stack ? `${msg}\n\n${stack}` : msg);
          setPhase("error");
          setLog((prev) => [...prev, `失敗: ${msg}`]);
        }
      })
      .finally(() => {
        webCodecsAbortRef.current = null;
      });
  };

  const handleCancel = async () => {
    if (phase !== "running") return;
    setPhase("cancelling");
    setLog((prev) => [...prev, "キャンセル中…"]);
    webCodecsAbortRef.current?.abort();
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
  // ratio (0.0〜1.0) が来ていればそれを優先（ffmpeg 結合中の time= ベース進捗）。
  // それ以外は従来通り sceneIndex/totalScenes から（overlay 等のフェーズ用）。
  const percent =
    progress && typeof progress.ratio === "number"
      ? Math.round(Math.max(0, Math.min(1, progress.ratio)) * 100)
      : progress && progress.totalScenes > 0 && progress.sceneIndex !== undefined
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

        {/* 出力タイトル */}
        <div
          className={`rounded border border-gray-200 dark:border-gray-700 p-2 space-y-1 ${
            phase !== "idle" ? "opacity-60 pointer-events-none" : ""
          }`}
        >
          <label className="text-[11px] font-medium text-gray-700 dark:text-gray-300">
            タイトル（出力ファイル名のベース）
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例: 銀魂_銀さん実写化_v1"
            className="w-full px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
          />
          <div className="text-[10px] text-gray-500">
            最終的なファイル名: <code>{title.trim() ? title.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 64) || "video" : "video"}_YYYYMMDD_HHMMSS.mp4</code>
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
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-[11px] rounded p-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono">
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
                onClick={async () => {
                  const text = buildCreditText(template);
                  if (!text) return;
                  try {
                    await navigator.clipboard.writeText(text);
                    setLog((prev) => [
                      ...prev,
                      "クレジット文をクリップボードにコピーしました",
                    ]);
                  } catch (e) {
                    setLog((prev) => [
                      ...prev,
                      `クリップボードコピー失敗: ${e}`,
                    ]);
                  }
                }}
                className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs"
                title="YouTube 概要欄に貼るためのクレジット文をクリップボードにコピー"
              >
                📋 概要欄テンプレをコピー
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
