import {
  brainstormAngles,
  getLlmProvider,
  selectBestScript,
  type ScriptAngle,
  type SelectionResult,
} from "./providers/llm";
import type { Script, ScriptInput } from "../types";
import type { AppSettings } from "./storage";

export type GenerationStage =
  | "idle"
  | "brainstorm"
  | "generate"
  | "select"
  | "done";

export interface PipelineProgress {
  stage: GenerationStage;
  detail?: string;
}

export interface PipelineResult {
  winner: Script;
  candidates: Script[];
  angles: ScriptAngle[];
  selection: SelectionResult;
}

export interface PipelineOptions {
  candidateCount?: number;
  angleCount?: number;
  onProgress?: (p: PipelineProgress) => void;
}

/**
 * 多段階生成パイプライン:
 *  1. ブレスト: 切り口を angleCount 個
 *  2. 候補生成: 上位 candidateCount 個の切り口それぞれで台本生成（並列）
 *  3. 選抜: 候補の中から最良を選ぶ
 */
export async function generateScriptWithPipeline(
  input: ScriptInput,
  settings: AppSettings,
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  const candidateCount = Math.max(1, Math.min(5, opts.candidateCount ?? 3));
  const angleCount = Math.max(candidateCount, opts.angleCount ?? 10);
  const report = (stage: GenerationStage, detail?: string) =>
    opts.onProgress?.({ stage, detail });

  report("brainstorm", `切り口を${angleCount}個ブレスト中...`);
  const angles = await brainstormAngles(input, settings, angleCount);
  if (angles.length === 0) {
    throw new Error("ブレスト結果が空です");
  }

  const topAngles = angles.slice(0, candidateCount);
  const provider = getLlmProvider(settings.llmProvider);

  const candidatePromises = topAngles.map(async (angle, i) => {
    report("generate", `候補 ${i + 1}/${candidateCount} 生成中...`);
    const angleNote = `【この台本で採用する切り口】\n- タイトル: ${angle.angle}\n- 感情フック: ${angle.hook_feeling}\n- 独自性: ${angle.why_original}`;
    const enriched: ScriptInput = {
      ...input,
      reference: input.reference
        ? `${input.reference}\n\n${angleNote}`
        : angleNote,
    };
    return provider.generateScript(enriched, settings);
  });
  const candidates = await Promise.all(candidatePromises);

  report("select", "候補を審査中...");
  const selection = await selectBestScript(candidates, input, settings);

  report("done");

  return {
    winner: candidates[selection.selected_index],
    candidates,
    angles,
    selection,
  };
}
