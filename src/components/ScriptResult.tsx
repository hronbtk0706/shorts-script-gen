import { useState } from "react";
import type { BodySegment, Script } from "../types";

interface Props {
  script: Script;
  onChange: (script: Script) => void;
}

function scriptToText(script: Script): string {
  const lines = [
    `【タイトル】${script.title}`,
    "",
    `【フック ${script.hook.seconds}】`,
    `ナレーション: ${script.hook.text}`,
    `映像: ${script.hook.visual}`,
    "",
    "【本編】",
  ];
  script.body.forEach((seg, i) => {
    lines.push(
      `${i + 1}. ${seg.seconds}`,
      `  ナレーション: ${seg.narration}`,
      `  映像: ${seg.visual}`,
      `  テロップ: ${seg.text_overlay}`,
    );
  });
  lines.push(
    "",
    `【CTA ${script.cta.seconds}】`,
    script.cta.text,
    "",
    `【ハッシュタグ】`,
    script.hashtags.join(" "),
    "",
    `【BGM】${script.bgm_mood}`,
  );
  return lines.join("\n");
}

function CopyButton({ text, label = "コピー" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={handleCopy}
      className="text-xs px-2 py-1 rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 transition"
    >
      {copied ? "✓ コピー済" : label}
    </button>
  );
}

const fieldLabelClass =
  "text-xs font-medium text-gray-500 dark:text-gray-400 mb-1";
const inputClass =
  "w-full bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400";
const textareaClass = `${inputClass} resize-y min-h-[48px]`;

function EditableField({
  label,
  value,
  onChange,
  multiline = false,
  rows = 2,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <div>
      <div className={fieldLabelClass}>{label}</div>
      {multiline ? (
        <textarea
          className={textareaClass}
          value={value}
          rows={rows}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className={inputClass}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

export function ScriptResult({ script, onChange }: Props) {
  const updateHook = (patch: Partial<Script["hook"]>) =>
    onChange({ ...script, hook: { ...script.hook, ...patch } });

  const updateCta = (patch: Partial<Script["cta"]>) =>
    onChange({ ...script, cta: { ...script.cta, ...patch } });

  const updateBody = (index: number, patch: Partial<BodySegment>) => {
    const body = script.body.map((seg, i) =>
      i === index ? { ...seg, ...patch } : seg,
    );
    onChange({ ...script, body });
  };

  const setHashtags = (raw: string) => {
    const tags = raw
      .split(/[\s　]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    onChange({ ...script, hashtags: tags });
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-start gap-4">
        <input
          className="flex-1 text-xl font-bold bg-transparent border-b border-transparent hover:border-gray-300 dark:hover:border-gray-600 focus:border-blue-400 focus:outline-none px-1 py-0.5"
          value={script.title}
          onChange={(e) => onChange({ ...script, title: e.target.value })}
        />
        <CopyButton text={scriptToText(script)} label="全文コピー" />
      </div>

      {/* フック */}
      <div className="p-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 space-y-3">
        <div className="flex justify-between items-center">
          <h3 className="font-semibold text-amber-800 dark:text-amber-200">
            フック · {script.hook.seconds}
          </h3>
          <CopyButton text={script.hook.text} />
        </div>
        <EditableField
          label="ナレーション／テロップ"
          value={script.hook.text}
          onChange={(v) => updateHook({ text: v })}
          multiline
        />
        <EditableField
          label="映像の説明（visual）"
          value={script.hook.visual}
          onChange={(v) => updateHook({ visual: v })}
          multiline
        />
        <EditableField
          label="画像プロンプト（image_prompt）"
          value={script.hook.image_prompt}
          onChange={(v) => updateHook({ image_prompt: v })}
          multiline
          rows={3}
          placeholder="空欄なら visual から自動生成"
        />
      </div>

      {/* 本編 */}
      <div className="space-y-3">
        <h3 className="font-semibold">本編</h3>
        {script.body.map((seg, i) => (
          <div
            key={i}
            className="p-4 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 space-y-3"
          >
            <div className="flex justify-between items-center">
              <span className="text-xs px-2 py-1 rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300">
                {seg.seconds}
              </span>
              <CopyButton text={seg.narration} />
            </div>
            <EditableField
              label="ナレーション"
              value={seg.narration}
              onChange={(v) => updateBody(i, { narration: v })}
              multiline
            />
            <EditableField
              label="テロップ"
              value={seg.text_overlay}
              onChange={(v) => updateBody(i, { text_overlay: v })}
              multiline
            />
            <EditableField
              label="映像の説明（visual）"
              value={seg.visual}
              onChange={(v) => updateBody(i, { visual: v })}
              multiline
            />
            <EditableField
              label="画像プロンプト（image_prompt）"
              value={seg.image_prompt}
              onChange={(v) => updateBody(i, { image_prompt: v })}
              multiline
              rows={3}
              placeholder="空欄なら visual から自動生成"
            />
          </div>
        ))}
      </div>

      {/* CTA */}
      <div className="p-4 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 space-y-3">
        <div className="flex justify-between items-center">
          <h3 className="font-semibold text-green-800 dark:text-green-200">
            CTA · {script.cta.seconds}
          </h3>
          <CopyButton text={script.cta.text} />
        </div>
        <EditableField
          label="ナレーション／テロップ"
          value={script.cta.text}
          onChange={(v) => updateCta({ text: v })}
          multiline
        />
        <EditableField
          label="画像プロンプト（image_prompt）"
          value={script.cta.image_prompt}
          onChange={(v) => updateCta({ image_prompt: v })}
          multiline
          rows={3}
          placeholder="空欄なら text から自動生成"
        />
      </div>

      {/* ハッシュタグ */}
      <div className="p-4 rounded-lg bg-gray-50 dark:bg-gray-800/50 space-y-2">
        <div className="flex justify-between items-center">
          <h3 className="font-semibold">ハッシュタグ</h3>
          <CopyButton text={script.hashtags.join(" ")} />
        </div>
        <input
          className={inputClass}
          value={script.hashtags.join(" ")}
          onChange={(e) => setHashtags(e.target.value)}
          placeholder="スペース区切り"
        />
      </div>

      {/* BGM */}
      <div className="space-y-1">
        <div className={fieldLabelClass}>🎵 BGM mood</div>
        <input
          className={inputClass}
          value={script.bgm_mood}
          onChange={(e) => onChange({ ...script, bgm_mood: e.target.value })}
        />
      </div>
    </div>
  );
}
