/**
 * エクスポート進捗の共有型。
 *
 * かつてここには ffmpeg + filter_complex ベースの動画合成
 * (`generateVideoFromTemplate` → Rust `compose_template_video`) があったが、
 * WebCodecs 経路 (exportTemplateWebCodecs.ts) に一本化したため撤去した。
 * 画質プリセットも廃止（WebCodecs は常に QUALITY_HIGH 固定）。
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
