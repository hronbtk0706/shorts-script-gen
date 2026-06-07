/**
 * エクスポート進捗の共有型。
 *
 * かつてここには ffmpeg + filter_complex ベースの動画合成
 * (`generateVideoFromTemplate` → Rust `compose_template_video`) があったが、
 * WebCodecs 経路 (exportTemplateWebCodecs.ts) に一本化したため撤去した。
 * 画質プリセットは廃止（WebCodecs 固定）。ビットレートは YouTube 推奨を満たすため
 * QUALITY_VERY_HIGH（1080p で約 12 Mbps）固定（exportTemplateWebCodecs.ts / characterRender.ts）。
 * ProgressUpdate は ExportModal が進捗表示に使うため残している。
 */

export interface ProgressUpdate {
  phase:
    | "prompt"
    | "image"
    | "tts"
    | "overlay"
    | "compose"
    | "done"
    | "error";
  sceneIndex?: number;
  totalScenes: number;
  message: string;
  /** encode 中の進捗 0.0〜1.0 */
  ratio?: number;
}
