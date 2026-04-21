import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  Layer,
  LayerShape,
  EntryAnimation,
  ExitAnimation,
  AmbientAnimation,
  CharAnimation,
  KineticAnimation,
  TextDecoration,
} from "../types";
import {
  VOICEVOX_SPEAKERS,
  OPENAI_TTS_VOICES,
  SOFTALK_VOICES,
} from "../lib/providers/tts";
import { loadSettings } from "../lib/storage";

const SAY_VOICES = [
  { id: "Kyoko", label: "Kyoko（女性・日本語）" },
  { id: "Otoya", label: "Otoya（男性・日本語）" },
];

const TTS_PROVIDER_OPTIONS = [
  { id: "openai", label: "OpenAI TTS（API キー・有料）" },
  { id: "voicevox", label: "VOICEVOX（要起動）" },
  { id: "softalk", label: "SofTalk（ゆっくり霊夢/魔理沙）" },
  { id: "say", label: "macOS say" },
];

function probeAudioDuration(path: string): Promise<number> {
  const url =
    path.startsWith("http") ||
    path.startsWith("data:") ||
    path.startsWith("blob:")
      ? path
      : convertFileSrc(path);
  return new Promise((resolve, reject) => {
    const a = new Audio();
    a.preload = "metadata";
    a.onloadedmetadata = () =>
      isFinite(a.duration) && a.duration > 0
        ? resolve(a.duration)
        : reject(new Error("invalid duration"));
    a.onerror = () => reject(new Error("loadedmetadata failed"));
    a.src = url;
  });
}

interface Props {
  /** 単一選択用（後方互換）。layers が渡されればそちらを優先 */
  layer?: Layer | null;
  /** 複数選択時は ≥2 要素。単一選択は 1 要素、未選択は空配列 */
  layers?: Layer[];
  onChange: (patch: Partial<Layer>) => void;
  /** テキストレイヤーからナレーション音声を生成（provider/voice を指定可能） */
  onGenerateNarration?: (
    layerId: string,
    provider: string,
    voice: string,
  ) => Promise<void>;
  /** ナレーション生成中のレイヤー id（ボタンのローディング表示用） */
  narrationBusyLayerId?: string | null;
}

const SHAPES: { id: LayerShape; label: string }[] = [
  { id: "rect", label: "長方形" },
  { id: "rounded", label: "角丸" },
  { id: "circle", label: "円形" },
];

const ENTRY_ANIMATIONS: { id: EntryAnimation; label: string }[] = [
  { id: "none", label: "なし" },
  { id: "fade", label: "フェードイン" },
  { id: "slide-left", label: "左からスライド" },
  { id: "slide-right", label: "右からスライド" },
  { id: "slide-up", label: "上からスライド" },
  { id: "slide-down", label: "下からスライド" },
  { id: "zoom-in", label: "ズームイン" },
  { id: "pop", label: "ポップ" },
  { id: "blur-in", label: "ブラー解除" },
  { id: "elastic-pop", label: "エラスティック" },
  { id: "flip-in", label: "フリップ（3D）" },
  { id: "stretch-in", label: "横伸び" },
  { id: "roll-in", label: "ロール" },
];

const EXIT_ANIMATIONS: { id: ExitAnimation; label: string }[] = [
  { id: "none", label: "なし" },
  { id: "fade", label: "フェードアウト" },
  { id: "slide-left", label: "左へスライド" },
  { id: "slide-right", label: "右へスライド" },
  { id: "slide-up", label: "上へスライド" },
  { id: "slide-down", label: "下へスライド" },
  { id: "zoom-out", label: "ズームアウト" },
  { id: "blur-out", label: "ブラーアウト" },
  { id: "flip-out", label: "フリップ（3D）" },
  { id: "stretch-out", label: "横縮み" },
  { id: "roll-out", label: "ロール" },
];

const AMBIENT_ANIMATIONS: { id: AmbientAnimation; label: string }[] = [
  { id: "none", label: "なし" },
  { id: "pulse", label: "パルス（呼吸）" },
  { id: "shake", label: "シェイク" },
  { id: "wiggle", label: "ウィグル" },
  { id: "bounce", label: "バウンス" },
  { id: "blink", label: "点滅" },
  { id: "glow-pulse", label: "発光呼吸" },
  { id: "rainbow", label: "レインボー" },
  { id: "float", label: "フロート" },
];

const CHAR_ANIMATIONS: { id: CharAnimation; label: string }[] = [
  { id: "none", label: "なし" },
  { id: "typewriter", label: "タイプライター" },
  { id: "stagger-fade", label: "スタッガーフェード" },
  { id: "wave", label: "ウェーブ（波打ち）" },
  { id: "color-shift", label: "カラーシフト" },
];

const KINETIC_ANIMATIONS: { id: KineticAnimation; label: string }[] = [
  { id: "none", label: "なし" },
  { id: "word-pop", label: "ワードポップ" },
  { id: "keyword-color", label: "キーワード強調色" },
  { id: "slide-stack", label: "スライドスタック" },
  { id: "zoom-talk", label: "ズームトーク" },
];

const TEXT_DECORATIONS: { id: TextDecoration; label: string }[] = [
  { id: "none", label: "なし" },
  { id: "highlight-bar", label: "ハイライト帯" },
  { id: "underline-sweep", label: "下線スイープ" },
  { id: "neon", label: "ネオン発光" },
  { id: "outline-reveal", label: "アウトライン展開" },
  { id: "shadow-drop", label: "影ドロップ" },
];

type SectionId =
  | "timing"
  | "geometry"
  | "shape"
  | "border"
  | "fill"
  | "text"
  | "source"
  | "audio"
  | "animation"
  | "decoration";

// 初期状態はすべて閉じる。ユーザーが開いたセクションは別レイヤーに移っても保持
const DEFAULT_OPEN: SectionId[] = [];

function Section({
  id,
  title,
  open,
  onToggle,
  children,
}: {
  id: SectionId;
  title: string;
  open: boolean;
  onToggle: (id: SectionId) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-gray-200 dark:border-gray-700">
      <button
        type="button"
        onClick={() => onToggle(id)}
        className="w-full flex items-center justify-between px-1 py-1 text-[10px] text-gray-500 font-semibold hover:bg-gray-50 dark:hover:bg-gray-800/50"
      >
        <span>{title}</span>
        <span className="text-gray-400">{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="px-1 pb-2 space-y-1">{children}</div>}
    </div>
  );
}

export function LayerPropertyPanel({
  layer,
  layers,
  onChange,
  onGenerateNarration,
  narrationBusyLayerId,
}: Props) {
  const list: Layer[] = layers ?? (layer ? [layer] : []);
  const [openSections, setOpenSections] = useState<Set<SectionId>>(
    new Set(DEFAULT_OPEN),
  );
  // ナレーション生成で使う TTS プロバイダ / 声の選択（設定からデフォルト読込）
  const [narrProvider, setNarrProvider] = useState<string>("openai");
  const [narrVoice, setNarrVoice] = useState<string>("alloy");
  useEffect(() => {
    loadSettings()
      .then((s) => {
        const prov =
          s.ttsProvider === "voicevox" ||
          s.ttsProvider === "say" ||
          s.ttsProvider === "openai" ||
          s.ttsProvider === "softalk"
            ? s.ttsProvider
            : "openai";
        setNarrProvider(prov);
        if (prov === "voicevox" && s.voicevoxSpeaker !== undefined) {
          setNarrVoice(String(s.voicevoxSpeaker));
        } else if (prov === "say" && s.sayVoice) {
          setNarrVoice(s.sayVoice);
        } else if (prov === "openai" && s.openaiTtsVoice) {
          setNarrVoice(s.openaiTtsVoice);
        } else if (prov === "softalk" && s.softalkVoice !== undefined) {
          setNarrVoice(String(s.softalkVoice));
        }
      })
      .catch(() => {
        /* 失敗時はデフォルト */
      });
  }, []);
  // プロバイダが変わったら、声候補の先頭をデフォルトに
  const voiceOptionsFor = (provider: string) => {
    if (provider === "openai") return OPENAI_TTS_VOICES;
    if (provider === "voicevox")
      return VOICEVOX_SPEAKERS.map((s) => ({
        id: String(s.id),
        label: s.label,
      }));
    if (provider === "softalk")
      return SOFTALK_VOICES.map((s) => ({
        id: String(s.id),
        label: s.label,
      }));
    return SAY_VOICES;
  };
  const toggle = (id: SectionId) => {
    setOpenSections((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const isOpen = (id: SectionId) => openSections.has(id);

  if (list.length === 0) {
    return (
      <div className="text-[11px] text-gray-400 text-center py-3">
        レイヤーを選択してください
      </div>
    );
  }

  const primary = list[0];
  const multi = list.length > 1;

  // 全レイヤーで共通値なら返す。異なれば undefined
  function common<K extends keyof Layer>(key: K): Layer[K] | undefined {
    const first = list[0][key];
    for (let i = 1; i < list.length; i++) {
      const v = list[i][key];
      // オブジェクト型（border 等）は shallow equal で判定
      if (typeof first === "object" && first !== null) {
        if (JSON.stringify(v) !== JSON.stringify(first)) return undefined;
      } else if (v !== first) {
        return undefined;
      }
    }
    return first;
  }

  const pickFile = async (kind: "image" | "video" | "audio") => {
    try {
      const exts =
        kind === "image"
          ? ["png", "jpg", "jpeg", "webp", "bmp"]
          : kind === "video"
            ? ["mp4", "mov", "webm", "m4v"]
            : ["mp3", "wav", "m4a", "ogg", "aac", "flac"];
      const labelMap = { image: "画像", video: "動画", audio: "音声" };
      const path = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: labelMap[kind], extensions: exts }],
      });
      if (typeof path !== "string") return;
      const patch: Partial<Layer> = { source: path };
      // 音声を単独選択で変えたとき、endSec を素材尺に合わせる
      if (kind === "audio" && list.length === 1) {
        try {
          const dur = await probeAudioDuration(path);
          patch.endSec = primary.startSec + dur;
        } catch (e) {
          console.warn("[LayerPropertyPanel] audio duration probe failed:", e);
        }
      }
      onChange(patch);
    } catch (e) {
      console.warn("[LayerPropertyPanel] pickFile failed:", e);
    }
  };

  const numInput = (
    label: string,
    value: number | undefined,
    setter: (v: number) => void,
    step = 1,
    unit = "",
  ) => {
    const precision = step < 1 ? 2 : 0;
    const mixed = value === undefined;
    const displayValue =
      !mixed && Number.isFinite(value as number)
        ? Number((value as number).toFixed(precision))
        : "";
    return (
      <div className="grid grid-cols-[70px_1fr] items-center gap-1 text-[11px]">
        <label className="text-gray-600 dark:text-gray-400">{label}</label>
        <div className="flex items-center gap-1">
          <input
            type="number"
            value={displayValue}
            placeholder={mixed ? "—" : ""}
            step={step}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") return; // 空欄はスキップ
              setter(Number(raw));
            }}
            className="flex-1 px-1 py-0.5 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
          />
          {unit && <span className="text-gray-400">{unit}</span>}
        </div>
      </div>
    );
  };

  // 複数選択時の表示条件（特定タイプだけの機能は全員同タイプなら表示）
  const allHaveType = (types: Layer["type"][]): boolean =>
    list.every((l) => types.includes(l.type));
  const showFill = allHaveType(["color", "shape"]);
  const showText = allHaveType(["comment"]);
  const showSource = allHaveType(["image", "video"]);
  const showAudio = allHaveType(["audio"]);
  // 音声のみ選択中は「位置・サイズ / 形状 / 枠線」は意味がないので非表示
  const allAudio = showAudio;

  return (
    <div className="text-xs">
      <div className="text-[11px] font-semibold text-gray-700 dark:text-gray-300 px-1 py-1">
        🛠 プロパティ{" "}
        {multi ? (
          <span className="text-blue-600 dark:text-blue-400">
            ({list.length} 個選択中)
          </span>
        ) : (
          <>({primary.type})</>
        )}
      </div>

      <Section id="timing" title="タイミング" open={isOpen("timing")} onToggle={toggle}>
        {numInput("開始", common("startSec"), (v) => onChange({ startSec: Math.max(0, v) }), 0.1, "s")}
        {numInput("終了", common("endSec"), (v) => onChange({ endSec: Math.max(0.1, v) }), 0.1, "s")}
      </Section>

      <Section id="animation" title="アニメーション" open={isOpen("animation")} onToggle={toggle}>
        <div className="grid grid-cols-[70px_1fr] items-center gap-1">
          <label className="text-gray-600">入場</label>
          <select
            value={common("entryAnimation") ?? ""}
            onChange={(e) => onChange({ entryAnimation: e.target.value as EntryAnimation })}
            className="px-1 py-0.5 text-[10px] rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
          >
            {common("entryAnimation") === undefined && (
              <option value="" disabled>—</option>
            )}
            {ENTRY_ANIMATIONS.map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </select>
        </div>
        {common("entryAnimation") && common("entryAnimation") !== "none" &&
          numInput("入場秒", common("entryDuration") ?? 0.3, (v) => onChange({ entryDuration: Math.max(0, v) }), 0.1, "s")}
        <div className="grid grid-cols-[70px_1fr] items-center gap-1">
          <label className="text-gray-600">退場</label>
          <select
            value={common("exitAnimation") ?? ""}
            onChange={(e) => onChange({ exitAnimation: e.target.value as ExitAnimation })}
            className="px-1 py-0.5 text-[10px] rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
          >
            {common("exitAnimation") === undefined && (
              <option value="" disabled>—</option>
            )}
            {EXIT_ANIMATIONS.map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </select>
        </div>
        {common("exitAnimation") && common("exitAnimation") !== "none" &&
          numInput("退場秒", common("exitDuration") ?? 0.3, (v) => onChange({ exitDuration: Math.max(0, v) }), 0.1, "s")}
        <div className="grid grid-cols-[70px_1fr] items-center gap-1 pt-1 border-t border-gray-200 dark:border-gray-700 mt-1">
          <label className="text-gray-600">持続</label>
          <select
            value={common("ambientAnimation") ?? "none"}
            onChange={(e) =>
              onChange({ ambientAnimation: e.target.value as AmbientAnimation })
            }
            className="px-1 py-0.5 text-[10px] rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
          >
            {AMBIENT_ANIMATIONS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        {common("ambientAnimation") && common("ambientAnimation") !== "none" &&
          numInput(
            "強度",
            common("ambientIntensity") ?? 1,
            (v) => onChange({ ambientIntensity: Math.max(0, Math.min(2, v)) }),
            0.1,
          )}
      </Section>

      {!allAudio && (
      <Section id="geometry" title="位置・サイズ" open={isOpen("geometry")} onToggle={toggle}>
        {numInput("X", common("x"), (v) => onChange({ x: v }), 1, "%")}
        {numInput("Y", common("y"), (v) => onChange({ y: v }), 1, "%")}
        {numInput("幅", common("width"), (v) => onChange({ width: v }), 1, "%")}
        {numInput("高さ", common("height"), (v) => onChange({ height: v }), 1, "%")}
        {numInput("回転", common("rotation") ?? 0, (v) => onChange({ rotation: v }), 1, "°")}
        {numInput("不透明度", common("opacity") ?? 1, (v) => onChange({ opacity: Math.max(0, Math.min(1, v)) }), 0.1)}
        {numInput("Z順", common("zIndex"), (v) => onChange({ zIndex: v }), 1)}
        <p className="text-[10px] text-gray-500">Z順: 大きいほど前面</p>
      </Section>
      )}

      {!allAudio && (
      <Section id="shape" title="形状" open={isOpen("shape")} onToggle={toggle}>
        <div className="flex gap-1">
          {SHAPES.map((s) => {
            const sel = common("shape");
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => onChange({ shape: s.id })}
                className={`flex-1 px-1.5 py-1 rounded border text-[10px] ${
                  sel === s.id
                    ? "bg-blue-100 dark:bg-blue-900/40 border-blue-500"
                    : "bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600"
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
        {common("shape") === "rounded" &&
          numInput("角丸 px", common("borderRadius") ?? 12, (v) => onChange({ borderRadius: v }), 1)}
      </Section>
      )}

      {!allAudio && (
      <Section id="border" title="枠線" open={isOpen("border")} onToggle={toggle}>
        <label className="flex items-center gap-1 text-[11px]">
          <input
            type="checkbox"
            checked={!!common("border")}
            onChange={(e) =>
              onChange({
                border: e.target.checked
                  ? { width: 2, color: "#ffffff" }
                  : undefined,
              })
            }
            className="h-3 w-3"
          />
          枠線を付ける
        </label>
        {!!common("border") && (
          <div className="ml-4 space-y-1">
            {numInput(
              "太さ",
              common("border")?.width,
              (v) =>
                onChange({
                  border: { width: Math.max(0, v), color: common("border")?.color ?? "#ffffff" },
                }),
              1,
              "px",
            )}
            <div className="grid grid-cols-[70px_1fr] items-center gap-1 text-[11px]">
              <label className="text-gray-600 dark:text-gray-400">色</label>
              <input
                type="color"
                value={common("border")?.color ?? "#ffffff"}
                onChange={(e) =>
                  onChange({
                    border: {
                      width: common("border")?.width ?? 2,
                      color: e.target.value,
                    },
                  })
                }
                className="w-full h-6 rounded border border-gray-300 dark:border-gray-600"
              />
            </div>
          </div>
        )}
      </Section>
      )}

      {showFill && (
        <Section id="fill" title="塗り色" open={isOpen("fill")} onToggle={toggle}>
          <div className="grid grid-cols-[70px_1fr] items-center gap-1 text-[11px]">
            <label className="text-gray-600 dark:text-gray-400">塗り色</label>
            <input
              type="color"
              value={
                (common("fillColor") ?? "#333333")?.startsWith("#")
                  ? common("fillColor") ?? "#333333"
                  : "#333333"
              }
              onChange={(e) => onChange({ fillColor: e.target.value })}
              className="w-full h-6 rounded border border-gray-300 dark:border-gray-600"
            />
          </div>
        </Section>
      )}

      {showText && (
        <Section id="decoration" title="テキスト演出" open={isOpen("decoration")} onToggle={toggle}>
          <div className="grid grid-cols-[70px_1fr] items-center gap-1 text-[11px]">
            <label className="text-gray-600">文字単位</label>
            <select
              value={common("charAnimation") ?? "none"}
              onChange={(e) =>
                onChange({ charAnimation: e.target.value as CharAnimation })
              }
              className="px-1 py-0.5 text-[10px] rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
            >
              {CHAR_ANIMATIONS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-[70px_1fr] items-center gap-1 text-[11px]">
            <label className="text-gray-600">キネティック</label>
            <select
              value={common("kineticAnimation") ?? "none"}
              onChange={(e) =>
                onChange({
                  kineticAnimation: e.target.value as KineticAnimation,
                })
              }
              className="px-1 py-0.5 text-[10px] rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
            >
              {KINETIC_ANIMATIONS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          {common("kineticAnimation") === "keyword-color" && (
            <div className="grid grid-cols-[70px_1fr] items-center gap-1 text-[11px]">
              <label className="text-gray-600">強調色</label>
              <input
                type="color"
                value={common("keywordColor") ?? "#ffe600"}
                onChange={(e) => onChange({ keywordColor: e.target.value })}
                className="w-full h-6 rounded border border-gray-300 dark:border-gray-600"
              />
            </div>
          )}
          <div className="grid grid-cols-[70px_1fr] items-center gap-1 text-[11px]">
            <label className="text-gray-600">装飾</label>
            <select
              value={common("textDecoration") ?? "none"}
              onChange={(e) =>
                onChange({
                  textDecoration: e.target.value as TextDecoration,
                })
              }
              className="px-1 py-0.5 text-[10px] rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
            >
              {TEXT_DECORATIONS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          <p className="text-[9px] text-gray-400">
            文字単位とキネティックは同時指定した場合キネティックが優先
          </p>
        </Section>
      )}

      {showText && (
        <Section id="text" title="テキスト" open={isOpen("text")} onToggle={toggle}>
          {!multi && (
            <div>
              <label className="block text-[11px] text-gray-600 dark:text-gray-400 mb-0.5">
                テキスト
              </label>
              <textarea
                value={primary.text ?? ""}
                onChange={(e) => onChange({ text: e.target.value })}
                rows={2}
                className="w-full px-1.5 py-0.5 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 resize-none"
              />
            </div>
          )}
          {numInput(
            "文字サイズ",
            common("fontSize") ?? (multi ? undefined : primary.fontSize ?? 48),
            (v) => onChange({ fontSize: Math.max(8, v) }),
            1,
            "px",
          )}
          <div className="grid grid-cols-[70px_1fr] items-center gap-1 text-[11px]">
            <label className="text-gray-600 dark:text-gray-400">文字色</label>
            <input
              type="color"
              value={common("fontColor") ?? "#FFFFFF"}
              onChange={(e) => onChange({ fontColor: e.target.value })}
              className="w-full h-6 rounded border border-gray-300 dark:border-gray-600"
            />
          </div>
          <label className="flex items-center gap-1 text-[11px] pt-1">
            <input
              type="checkbox"
              checked={!!common("fillColor")}
              onChange={(e) =>
                onChange({
                  fillColor: e.target.checked
                    ? common("fillColor") ?? "rgba(0,0,0,0.6)"
                    : undefined,
                })
              }
              className="h-3 w-3"
            />
            背景色を使う
          </label>
          {!!common("fillColor") && (
            <div className="grid grid-cols-[70px_1fr] items-center gap-1 text-[11px] ml-4">
              <label className="text-gray-600 dark:text-gray-400">背景色</label>
              <input
                type="color"
                value={
                  common("fillColor")?.startsWith("#")
                    ? common("fillColor") ?? "#000000"
                    : "#000000"
                }
                onChange={(e) => onChange({ fillColor: e.target.value })}
                className="w-full h-6 rounded border border-gray-300 dark:border-gray-600"
              />
            </div>
          )}
          {multi && (
            <p className="text-[10px] text-gray-400">
              テキスト本文は個別に編集してください
            </p>
          )}
          {/* ナレーション生成（単独選択・テキストあり時のみ） */}
          {!multi && onGenerateNarration && (primary.text ?? "").trim() && (
            <div className="pt-1 border-t border-gray-200 dark:border-gray-700 mt-1 space-y-1">
              <div className="grid grid-cols-[40px_1fr] items-center gap-1 text-[10px]">
                <label className="text-gray-600 dark:text-gray-400">
                  TTS
                </label>
                <select
                  value={narrProvider}
                  onChange={(e) => {
                    const next = e.target.value;
                    setNarrProvider(next);
                    // 声候補を先頭にリセット
                    const opts = voiceOptionsFor(next);
                    if (opts.length > 0) setNarrVoice(String(opts[0].id));
                  }}
                  className="px-1 py-0.5 text-[10px] rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
                >
                  {TTS_PROVIDER_OPTIONS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-[40px_1fr] items-center gap-1 text-[10px]">
                <label className="text-gray-600 dark:text-gray-400">
                  声
                </label>
                <select
                  value={narrVoice}
                  onChange={(e) => setNarrVoice(e.target.value)}
                  className="px-1 py-0.5 text-[10px] rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
                >
                  {voiceOptionsFor(narrProvider).map((v) => (
                    <option key={v.id} value={String(v.id)}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                disabled={narrationBusyLayerId === primary.id}
                onClick={() =>
                  onGenerateNarration(primary.id, narrProvider, narrVoice)
                }
                className="w-full px-2 py-1 rounded border text-[10px] border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 disabled:opacity-50"
                title={
                  primary.generatedNarrationLayerId
                    ? "最新のテキスト内容でナレーション音声を再生成（既存を置き換え）"
                    : "このテキストからナレーション音声を生成"
                }
              >
                {narrationBusyLayerId === primary.id
                  ? "🔊 生成中..."
                  : primary.generatedNarrationLayerId
                    ? "🔊 最新テキストで更新"
                    : "🔊 ナレーション生成"}
              </button>
              {primary.generatedNarrationLayerId && (
                <p className="text-[9px] text-gray-500">
                  生成済。テキストを更新してボタン押下で置き換え
                </p>
              )}
            </div>
          )}
        </Section>
      )}

      {showAudio && (
        <Section id="audio" title="音声" open={isOpen("audio")} onToggle={toggle}>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => pickFile("audio")}
              className="flex-1 px-1.5 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-[10px] hover:bg-blue-50"
            >
              📁 音声ファイル選択
            </button>
          </div>
          {primary.source &&
            primary.source !== "auto" &&
            primary.source !== "user" && (
              <div className="flex items-center gap-1">
                <p className="text-[10px] text-emerald-600 dark:text-emerald-400 truncate flex-1">
                  ✓ {primary.source.split(/[\\/]/).pop()}
                </p>
                <button
                  type="button"
                  onClick={() => onChange({ source: "user" })}
                  className="text-[10px] text-red-600 hover:underline"
                >
                  解除
                </button>
              </div>
            )}
          {numInput(
            "音量",
            common("volume") ?? 1,
            (v) => onChange({ volume: Math.max(0, Math.min(1, v)) }),
            0.1,
          )}
          {numInput(
            "フェードIn",
            common("audioFadeIn") ?? 0,
            (v) => onChange({ audioFadeIn: Math.max(0, v) }),
            0.1,
            "s",
          )}
          {numInput(
            "フェードOut",
            common("audioFadeOut") ?? 0,
            (v) => onChange({ audioFadeOut: Math.max(0, v) }),
            0.1,
            "s",
          )}
          <label className="flex items-center gap-1 text-[11px]">
            <input
              type="checkbox"
              checked={!!common("audioLoop")}
              onChange={(e) => onChange({ audioLoop: e.target.checked })}
              className="h-3 w-3"
            />
            短いときループ再生
          </label>
        </Section>
      )}

      {showSource && !multi && (
        <Section
          id="source"
          title={primary.type === "image" ? "画像ソース" : "動画ソース"}
          open={isOpen("source")}
          onToggle={toggle}
        >
          <div className="flex gap-1">
            {primary.type === "image" && (
              <button
                type="button"
                onClick={() => onChange({ source: "auto" })}
                className={`flex-1 px-1.5 py-1 rounded border text-[10px] ${
                  primary.source === "auto"
                    ? "bg-blue-100 dark:bg-blue-900/40 border-blue-500"
                    : "bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600"
                }`}
              >
                🤖 AI自動
              </button>
            )}
            <button
              type="button"
              onClick={() => pickFile(primary.type as "image" | "video")}
              className="flex-1 px-1.5 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-[10px] hover:bg-blue-50"
            >
              📁 ファイル選択
            </button>
          </div>
          {primary.source &&
            primary.source !== "auto" &&
            primary.source !== "user" && (
              <div className="flex items-center gap-1">
                <p className="text-[10px] text-emerald-600 dark:text-emerald-400 truncate flex-1">
                  ✓ {primary.source.split(/[\\/]/).pop()}
                </p>
                <button
                  type="button"
                  onClick={() =>
                    onChange({
                      source: primary.type === "image" ? "auto" : "user",
                    })
                  }
                  className="text-[10px] text-red-600 hover:underline"
                >
                  解除
                </button>
              </div>
            )}
          {primary.source === "user" && primary.type === "video" && (
            <p className="text-[10px] text-gray-400">ファイルを選択してください</p>
          )}
        </Section>
      )}
    </div>
  );
}
