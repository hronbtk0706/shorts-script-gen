/**
 * テンプレートのレイヤーから、YouTube 概要欄等に貼るためのクレジット文を組み立てる。
 *
 * - キャラレイヤーの credit (制作者 / 配布元 / 必須クレジット文) を集約
 * - VOICEVOX 音声を検出したら "VOICEVOX:キャラ名" を必ず追加 (使用条件)
 * - 東北ずん子・ずんだもんプロジェクトの URL を末尾に添える (キャラ系を使ってる場合)
 */

import type { VideoTemplate, Layer } from "../types";

// VOICEVOX で生成された音声か推測する。
// voicevox_tts は wav と一緒に .query.json を sidecar 保存しているので、
// ファイル名に "voicevox" が含まれているかは保証できないが、ヒューリスティックとして
// 「audio レイヤーで source が .wav かつ session asset 階層に存在」が VOICEVOX の典型。
// 簡易判定: source が ".wav" で終わる audio レイヤーを VOICEVOX 候補とする。
function looksLikeVoicevoxAudio(layer: Layer): boolean {
  if (layer.type !== "audio") return false;
  if (typeof layer.source !== "string") return false;
  return /\.wav$/i.test(layer.source);
}

export function buildCreditText(template: VideoTemplate): string {
  const lines: string[] = [];
  const characters = template.layers.filter(
    (l) => l.type === "character" && !l.hidden,
  );
  const audios = template.layers.filter((l) => l.type === "audio" && !l.hidden);
  const hasVoicevox = audios.some(looksLikeVoicevoxAudio);
  const hasZundamonContext = hasVoicevox || characters.length > 0;

  lines.push("●使用素材");

  // 音声 (VOICEVOX 検出時)
  if (hasVoicevox) {
    lines.push("・音声: VOICEVOX (https://voicevox.hiroshiba.jp/)");
  }

  // キャラ (Live2D)
  for (const c of characters) {
    const credit = c.credit;
    if (credit?.requiredCreditText) {
      // 配布元が必須クレジット文を指定してる場合はそれを優先
      lines.push(`・${credit.requiredCreditText}`);
    } else {
      const author = credit?.author?.trim();
      const url = credit?.sourceUrl?.trim();
      const fileName =
        c.modelPath?.split(/[\\/]/).pop()?.replace(/\.model3\.json$/i, "") ??
        "Live2D モデル";
      const parts: string[] = [`・Live2D モデル: ${fileName}`];
      if (author) parts.push(`(${author})`);
      if (url) parts.push(url);
      lines.push(parts.join(" "));
    }
  }

  // 東北ずん子・ずんだもんプロジェクト (公式リンクは載せておくと事故防止)
  if (hasZundamonContext) {
    lines.push(
      "・東北ずん子・ずんだもんプロジェクト: https://zunko.jp/",
    );
  }

  return lines.join("\n");
}
