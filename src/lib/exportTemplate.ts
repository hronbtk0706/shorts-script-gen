import { invoke } from "@tauri-apps/api/core";
import type { VideoTemplate } from "../types";
import { generateVideoFromTemplate, type ProgressUpdate } from "./video";

export interface ExportOptions {
  template: VideoTemplate;
  onProgress: (p: ProgressUpdate) => void;
}

export interface ExportResult {
  outputPath: string;
  sessionId: string;
}

/**
 * テンプレ編集画面から単体のテンプレをそのまま 1 本の MP4 に書き出す。
 * 新方式: レイヤーだけで動画全体を 1 本の filter_complex で合成する。
 * シーン分割 / hook-body-cta / motion / color / xfade の概念は一切使わない。
 * キャンセルする場合は `invoke("cancel_export")` を呼ぶこと。
 */
export async function exportTemplateToVideo(
  opts: ExportOptions,
): Promise<ExportResult> {
  const { template, onProgress } = opts;
  return generateVideoFromTemplate(template, onProgress);
}

export async function cancelTemplateExport(): Promise<void> {
  try {
    await invoke("cancel_export");
  } catch (e) {
    console.warn("[exportTemplate] cancel_export failed:", e);
  }
}
