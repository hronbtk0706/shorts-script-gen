import { invoke } from "@tauri-apps/api/core";
import type { Script, VideoTemplate } from "../types";
import { applyManualAssignments, buildManualScript } from "./manualScript";
import { generateVideo, type ProgressUpdate } from "./video";

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
 * 内部では manual モード相当で Script を合成してから generateVideo を呼ぶ。
 * キャンセルする場合は `invoke("cancel_export")` を呼ぶこと。
 */
export async function exportTemplateToVideo(
  opts: ExportOptions,
): Promise<ExportResult> {
  const { template, onProgress } = opts;

  // manualScript と同じ経路で hook/body/cta セグメントを補完しつつテンプレをクローン
  const patched = applyManualAssignments(template, {}, {}, {}, {});
  const prebuilt: Script = buildManualScript(patched, null);

  const result = await generateVideo(
    "",
    prebuilt,
    onProgress,
    patched,
    { manualMode: true },
  );
  return result;
}

export async function cancelTemplateExport(): Promise<void> {
  try {
    await invoke("cancel_export");
  } catch (e) {
    console.warn("[exportTemplate] cancel_export failed:", e);
  }
}
