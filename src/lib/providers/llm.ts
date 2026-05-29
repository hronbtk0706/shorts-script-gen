/**
 * かつてここには LLM による完全自動台本生成（generateScript / brainstormAngles /
 * selectBestScript / 各プロバイダ実装）があったが、精度が低く使われなくなったため
 * 2026-05-29 に撤去した（UI: ScriptForm/ScriptResult/CandidatePicker、
 * パイプライン: scriptGenerator も同時に削除済み）。
 *
 * 現在 live で参照されるのは SettingsModal の OpenAI モデル選択ドロップダウンだけなので、
 * その定数のみ残す。プロバイダ ID 型は storage.ts の LlmProviderId。
 */

export const OPENAI_MODELS = [
  { id: "gpt-5-mini", label: "GPT-5 mini（推奨・安い・高品質）" },
  { id: "gpt-5", label: "GPT-5（最高品質・高め）" },
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini（安定・安い）" },
  { id: "gpt-4.1", label: "GPT-4.1（高品質・中価格）" },
];
