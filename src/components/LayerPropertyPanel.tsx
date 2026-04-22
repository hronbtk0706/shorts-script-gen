import { useEffect, useRef, useState } from "react";
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
  KeyframeTrack,
  LayerKeyframes,
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

function probeVideoDuration(path: string): Promise<number> {
  const url =
    path.startsWith("http") ||
    path.startsWith("data:") ||
    path.startsWith("blob:")
      ? path
      : convertFileSrc(path);
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () =>
      isFinite(v.duration) && v.duration > 0
        ? resolve(v.duration)
        : reject(new Error("invalid video duration"));
    v.onerror = () => reject(new Error("video loadedmetadata failed"));
    v.src = url;
  });
}

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
  /** テンプレにインポート済みのコメント（comment レイヤー向け DDL に使う） */
  importedComments?: import("../types").ExtractedComment[];
  /** キーフレーム「現在位置で追加」に使う再生ヘッド時刻（秒） */
  playheadSec?: number;
}

type KeyframeProp = "x" | "y" | "scale" | "opacity" | "rotation";
const KEYFRAME_PROPS: Array<{ id: KeyframeProp; label: string; unit?: string; step?: number }> = [
  { id: "x", label: "X", unit: "%", step: 1 },
  { id: "y", label: "Y", unit: "%", step: 1 },
  { id: "scale", label: "拡大率", step: 0.1 },
  { id: "opacity", label: "不透明度", step: 0.1 },
  { id: "rotation", label: "回転", unit: "°", step: 1 },
];

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

/**
 * 数値入力フィールド。
 * - 空欄や "-" を一時的に受け入れる（ユーザーが全消しして入力し直せるように）
 * - 有効な数字が入った瞬間に setter を呼ぶ
 * - blur 時に無効値が残っていれば前の値に戻す
 */
/**
 * AE/Photoshop 風のラベルドラッグで値が変わるラベルコンポーネント。
 * numInput と組み合わせて「ラベル掴んでドラッグ = 数値変更」を実現。
 * Shift で粗く (×10)、Alt で細かく (×0.1)
 */
/**
 * マウスホイール対応のスライダー。
 * - 通常ホイール: step
 * - Shift+ホイール: step×10（大幅）
 * - Alt+ホイール: step×0.1（精密）
 */
function WheelSlider({
  value,
  onChange,
  min,
  max,
  step,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const latestRef = useRef({ value, onChange, min, max, step });
  useEffect(() => {
    latestRef.current = { value, onChange, min, max, step };
  }, [value, onChange, min, max, step]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const cur = latestRef.current;
      const dir = e.deltaY < 0 ? 1 : -1;
      const factor = e.shiftKey
        ? cur.step * 10
        : e.altKey
          ? cur.step * 0.1
          : cur.step;
      const next = cur.value + dir * factor;
      cur.onChange(Math.max(cur.min, Math.min(cur.max, next)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <input
      ref={ref}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full accent-blue-600"
      title="ドラッグ or マウスホイールで値を変更（Shift:大 / Alt:小）"
    />
  );
}

function ScrubbingLabel({
  text,
  value,
  setter,
  step,
}: {
  text: string;
  value: number | undefined;
  setter: (v: number) => void;
  step: number;
}) {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef<{ x: number; v: number } | null>(null);
  const labelRef = useRef<HTMLLabelElement>(null);
  // wheel 用に最新の value / setter / step を保持（イベントは passive:false 登録する）
  const latestRef = useRef({ value, setter, step });
  useEffect(() => {
    latestRef.current = { value, setter, step };
  }, [value, setter, step]);

  useEffect(() => {
    const el = labelRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const cur = latestRef.current;
      if (cur.value === undefined || !Number.isFinite(cur.value)) return;
      e.preventDefault();
      e.stopPropagation();
      const dir = e.deltaY < 0 ? 1 : -1;
      const s = cur.step;
      const factor = e.shiftKey ? s * 10 : e.altKey ? s * 0.1 : s;
      cur.setter(cur.value + dir * factor);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLLabelElement>) => {
    if (value === undefined || !Number.isFinite(value)) return;
    e.preventDefault();
    e.stopPropagation();
    startRef.current = { x: e.clientX, v: value };
    setDragging(true);
    try {
      (e.currentTarget as HTMLLabelElement).setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  };
  const onPointerMove = (e: React.PointerEvent<HTMLLabelElement>) => {
    if (!dragging || !startRef.current) return;
    const dx = e.clientX - startRef.current.x;
    const factor = e.shiftKey ? step * 10 : e.altKey ? step * 0.1 : step;
    setter(startRef.current.v + dx * factor);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLLabelElement>) => {
    setDragging(false);
    startRef.current = null;
    try {
      (e.currentTarget as HTMLLabelElement).releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  };

  return (
    <label
      ref={labelRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={`select-none ${
        dragging
          ? "text-blue-600 font-semibold"
          : "text-gray-600 dark:text-gray-400 hover:text-blue-600"
      }`}
      style={{ cursor: "ew-resize" }}
      title="左右ドラッグ or マウスホイールで値を変更（Shift:大 / Alt:小）"
    >
      {text}
    </label>
  );
}

function NumField({
  value,
  setter,
  step = 1,
  unit = "",
  mixed = false,
}: {
  value: number | undefined;
  setter: (v: number) => void;
  step?: number;
  unit?: string;
  mixed?: boolean;
}) {
  const precision = step < 1 ? 2 : 0;
  const formatted =
    !mixed && value !== undefined && Number.isFinite(value)
      ? Number(value.toFixed(precision)).toString()
      : "";
  // 編集中のローカル文字列（フォーカス中は external 値の変化を無視）
  const [local, setLocal] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setLocal(null);
  }, [formatted, focused]);
  const display = local ?? formatted;

  return (
    <div className="flex items-center gap-1">
      <input
        type="number"
        value={display}
        placeholder={mixed ? "—" : ""}
        step={step}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          // 無効値や空欄なら表示を formatted に戻す（state は不変）
          if (display === "" || display === "-" || !Number.isFinite(Number(display))) {
            setLocal(null);
          } else {
            setLocal(null);
          }
        }}
        onChange={(e) => {
          const raw = e.target.value;
          setLocal(raw);
          if (raw === "" || raw === "-") return; // 編集途中
          const n = Number(raw);
          if (Number.isFinite(n)) setter(n);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="w-20 px-1 py-0.5 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
      />
      {unit && <span className="text-gray-400">{unit}</span>}
    </div>
  );
}

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
  | "keyframes"
  | "decoration";

type PropTab = "basic" | "style" | "motion" | "detail";

const TAB_OF_SECTION: Record<SectionId, PropTab> = {
  timing: "basic",
  geometry: "basic",
  shape: "style",
  border: "style",
  fill: "style",
  text: "style",
  decoration: "style",
  animation: "motion",
  keyframes: "motion",
  source: "detail",
  audio: "detail",
};

const TABS: Array<{ id: PropTab; label: string }> = [
  { id: "basic", label: "基本" },
  { id: "style", label: "見た目" },
  { id: "motion", label: "動き" },
  { id: "detail", label: "詳細" },
];

// 初期状態はすべて閉じる。ユーザーが開いたセクションは別レイヤーに移っても保持
const DEFAULT_OPEN: SectionId[] = [];

function Section({
  id,
  title,
  open,
  onToggle,
  currentTab,
  children,
}: {
  id: SectionId;
  title: string;
  open: boolean;
  onToggle: (id: SectionId) => void;
  /** 現在アクティブなタブ。セクションの属するタブと一致しないときは非表示 */
  currentTab?: PropTab;
  children: React.ReactNode;
}) {
  if (currentTab && TAB_OF_SECTION[id] !== currentTab) return null;
  return (
    <div
      className={`border-b border-gray-200 dark:border-gray-700 border-l-[3px] transition-colors ${
        open ? "border-l-blue-500" : "border-l-transparent"
      }`}
    >
      <button
        type="button"
        onClick={() => onToggle(id)}
        className={`w-full flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold transition-colors ${
          open
            ? "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-200 hover:bg-blue-200 dark:hover:bg-blue-900/50"
            : "bg-gray-50 dark:bg-gray-800/30 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/50"
        }`}
        title={open ? "クリックで閉じる" : "クリックで開く"}
      >
        <span
          className={`inline-block w-3 text-center ${
            open ? "text-blue-600 dark:text-blue-400" : "text-gray-400"
          }`}
        >
          {open ? "▾" : "▸"}
        </span>
        <span className="flex-1 text-left">{title}</span>
      </button>
      {open && (
        <div className="px-2 py-2 space-y-1 bg-white dark:bg-gray-900">
          {children}
        </div>
      )}
    </div>
  );
}

export function LayerPropertyPanel({
  layer,
  layers,
  onChange,
  onGenerateNarration,
  narrationBusyLayerId,
  importedComments,
  playheadSec = 0,
}: Props) {
  const list: Layer[] = layers ?? (layer ? [layer] : []);
  const [openSections, setOpenSections] = useState<Set<SectionId>>(
    new Set(DEFAULT_OPEN),
  );
  const [activeTab, setActiveTab] = useState<PropTab>("basic");
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
          patch.sourceDurationSec = dur;
        } catch (e) {
          console.warn("[LayerPropertyPanel] audio duration probe failed:", e);
        }
      }
      // 動画も素材尺を測ってキャッシュ（ループOFF時の上限に使う）
      if (kind === "video" && list.length === 1) {
        try {
          const dur = await probeVideoDuration(path);
          patch.sourceDurationSec = dur;
          // ループOFF設定済みでレイヤー長 > 素材長なら素材長に合わせる
          if (primary.videoLoop === false) {
            const maxEnd = primary.startSec + dur;
            if (primary.endSec > maxEnd) patch.endSec = maxEnd;
          }
        } catch (e) {
          console.warn("[LayerPropertyPanel] video duration probe failed:", e);
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
    const mixed = value === undefined;
    return (
      <div className="grid grid-cols-[70px_1fr] items-center gap-1 text-[11px]">
        <ScrubbingLabel
          text={label}
          value={value}
          setter={setter}
          step={step}
        />
        <NumField
          value={value}
          setter={setter}
          step={step}
          unit={unit}
          mixed={mixed}
        />
      </div>
    );
  };

  /** 色ピッカー（ネイティブ color + テキスト併用） */
  const colorInput = (
    label: string,
    value: string | undefined,
    setter: (v: string) => void,
  ) => {
    const v = value ?? "#ffffff";
    // rgba() のようなものが来たら color input に渡せない → テキストのみ
    const isHex = /^#[0-9a-fA-F]{3,8}$/.test(v);
    return (
      <div className="grid grid-cols-[70px_1fr_80px] items-center gap-1 text-[11px]">
        <label className="text-gray-600 dark:text-gray-400">{label}</label>
        <input
          type="color"
          value={isHex ? v.slice(0, 7) : "#ffffff"}
          onChange={(e) => setter(e.target.value)}
          className="w-full h-5 rounded border border-gray-300 dark:border-gray-600 cursor-pointer"
        />
        <input
          type="text"
          value={v}
          onChange={(e) => setter(e.target.value)}
          className="px-1 py-0.5 text-[10px] rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
        />
      </div>
    );
  };

  /** スライダーと数値入力のハイブリッド（範囲が決まってるプロパティ用） */
  const sliderInput = (
    label: string,
    value: number | undefined,
    setter: (v: number) => void,
    min: number,
    max: number,
    step = 0.1,
    unit = "",
  ) => {
    const v = value ?? min;
    return (
      <div className="grid grid-cols-[70px_1fr_46px] items-center gap-1 text-[11px]">
        <ScrubbingLabel
          text={label}
          value={value}
          setter={setter}
          step={step}
        />
        <WheelSlider
          value={v}
          onChange={setter}
          min={min}
          max={max}
          step={step}
        />
        <div className="flex items-center justify-end gap-0.5">
          <input
            type="number"
            value={
              Number.isFinite(v)
                ? Number(v.toFixed(step < 1 ? 2 : 0))
                : ""
            }
            min={min}
            max={max}
            step={step}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (!Number.isFinite(n)) return;
              setter(Math.max(min, Math.min(max, n)));
            }}
            className="w-11 px-1 py-0.5 text-[10px] rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-right"
          />
          {unit && <span className="text-[9px] text-gray-500">{unit}</span>}
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

  const typeIcon: Record<Layer["type"], string> = {
    image: "🖼",
    video: "🎬",
    comment: "📝",
    color: "🎨",
    shape: "⬜",
    audio: "🎵",
  };
  const headerLabel = multi ? (
    <span className="text-blue-600 dark:text-blue-400">
      {list.length} 個選択中
    </span>
  ) : (
    <span>
      <span className="text-base mr-1">{typeIcon[primary.type]}</span>
      <span className="text-gray-600 dark:text-gray-400">{primary.type}</span>
    </span>
  );

  return (
    <div className="text-xs">
      {/* ==== 上部バー：常時表示 ==== */}
      <div className="sticky top-0 z-10 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-1.5 py-1.5 space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-semibold truncate">{headerLabel}</div>
          {!multi && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() =>
                  onChange({ hidden: !(primary.hidden ?? false) })
                }
                className="text-[11px] px-1.5 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
                title={primary.hidden ? "表示" : "非表示"}
              >
                {primary.hidden ? "🙈" : "👁"}
              </button>
              <button
                type="button"
                onClick={() =>
                  onChange({ locked: !(primary.locked ?? false) })
                }
                className="text-[11px] px-1.5 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
                title={primary.locked ? "ロック解除" : "ロック"}
              >
                {primary.locked ? "🔒" : "🔓"}
              </button>
            </div>
          )}
        </div>
        {/* レイヤータイプ別の「よく触る項目」を常時表示 */}
        {!multi && primary && primary.type === "comment" && (
          <>
            {sliderInput(
              "文字サイズ",
              common("fontSize") ?? 48,
              (v) => onChange({ fontSize: Math.max(8, v) }),
              8,
              200,
              1,
              "px",
            )}
            {colorInput("文字色", common("fontColor"), (v) =>
              onChange({ fontColor: v }),
            )}
          </>
        )}
        {!multi &&
          primary &&
          (primary.type === "color" || primary.type === "shape") &&
          colorInput("塗り色", common("fillColor"), (v) =>
            onChange({ fillColor: v }),
          )}
        {!multi && primary && primary.type === "audio" && (
          <>
            {sliderInput(
              "音量",
              common("volume") ?? 1,
              (v) => onChange({ volume: Math.max(0, Math.min(2, v)) }),
              0,
              2,
              0.05,
            )}
            {sliderInput(
              "再生速度",
              common("playbackRate") ?? 1,
              (v) => {
                const newRate = Math.max(0.5, Math.min(4, v));
                const patch: Partial<Layer> = { playbackRate: newRate };
                // 単一選択 & ループOFF & 素材尺が既知なら、タイムライン尺も連動
                if (
                  !multi &&
                  primary &&
                  !primary.audioLoop &&
                  primary.sourceDurationSec &&
                  primary.sourceDurationSec > 0
                ) {
                  const newDur = primary.sourceDurationSec / newRate;
                  patch.endSec = primary.startSec + newDur;
                }
                onChange(patch);
              },
              0.5,
              4,
              0.05,
              "x",
            )}
          </>
        )}
      </div>

      {/* ==== タブバー ==== */}
      <div className="flex sticky top-[calc(2.4rem+1px)] z-10 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActiveTab(t.id)}
            className={`flex-1 py-1.5 text-[11px] font-medium transition-colors ${
              activeTab === t.id
                ? "text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400 bg-blue-50/50 dark:bg-blue-900/10"
                : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 border-b-2 border-transparent"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Section id="timing" title="タイミング" open={isOpen("timing")} onToggle={toggle} currentTab={activeTab}>
        {numInput("開始", common("startSec"), (v) => onChange({ startSec: Math.max(0, v) }), 0.1, "s")}
        {numInput("終了", common("endSec"), (v) => onChange({ endSec: Math.max(0.1, v) }), 0.1, "s")}
      </Section>

      <Section id="animation" title="アニメーション" open={isOpen("animation")} onToggle={toggle} currentTab={activeTab}>
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
          sliderInput(
            "強度",
            common("ambientIntensity") ?? 1,
            (v) => onChange({ ambientIntensity: Math.max(0, Math.min(2, v)) }),
            0,
            2,
            0.05,
          )}
      </Section>

      {!multi && primary && !allAudio && (
        <Section
          id="keyframes"
          title="キーフレーム（補間アニメ）"
          open={isOpen("keyframes")}
          onToggle={toggle}
          currentTab={activeTab}
        >
          <div className="text-[10px] text-gray-500 mb-1 px-1">
            再生ヘッドを動かして「＋追加」を押すとその時刻に現在値が記録されます。
            2 点以上で線形補間されます。
          </div>
          <div className="space-y-1.5">
            {KEYFRAME_PROPS.map((p) => {
              const track: KeyframeTrack | undefined =
                primary.keyframes?.[p.id];
              const enabled = track?.enabled ?? false;
              const frames = track?.frames ?? [];
              const currentVal: number =
                p.id === "scale"
                  ? 1
                  : p.id === "opacity"
                    ? (primary.opacity ?? 1)
                    : p.id === "rotation"
                      ? (primary.rotation ?? 0)
                      : ((primary as any)[p.id] as number);

              const writeTrack = (next: KeyframeTrack | undefined) => {
                const nextKf: LayerKeyframes = {
                  ...(primary.keyframes ?? {}),
                };
                if (next) {
                  (nextKf as any)[p.id] = next;
                } else {
                  delete (nextKf as any)[p.id];
                }
                onChange({ keyframes: nextKf });
              };
              const toggleEnable = (v: boolean) => {
                writeTrack({
                  enabled: v,
                  frames: frames,
                });
              };
              const addAtPlayhead = () => {
                const cleaned = frames.filter(
                  (f) => Math.abs(f.time - playheadSec) > 0.01,
                );
                const next = {
                  enabled: true,
                  frames: [
                    ...cleaned,
                    { time: playheadSec, value: currentVal },
                  ].sort((a, b) => a.time - b.time),
                };
                writeTrack(next);
              };
              const editFrame = (
                idx: number,
                patch: Partial<{ time: number; value: number }>,
              ) => {
                const nextFrames = frames
                  .map((f, i) => (i === idx ? { ...f, ...patch } : f))
                  .sort((a, b) => a.time - b.time);
                writeTrack({
                  enabled: track?.enabled ?? true,
                  frames: nextFrames,
                });
              };
              const removeFrame = (idx: number) => {
                const nextFrames = frames.filter((_, i) => i !== idx);
                if (nextFrames.length === 0) {
                  writeTrack(undefined);
                } else {
                  writeTrack({
                    enabled: track?.enabled ?? true,
                    frames: nextFrames,
                  });
                }
              };

              return (
                <div
                  key={p.id}
                  className="border border-gray-200 dark:border-gray-700 rounded px-1.5 py-1"
                >
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-1 text-[10px]">
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) => toggleEnable(e.target.checked)}
                      />
                      <span className="font-medium">{p.label}</span>
                      {frames.length > 0 && (
                        <span className="text-gray-400">
                          ({frames.length}点)
                        </span>
                      )}
                    </label>
                    <button
                      type="button"
                      onClick={addAtPlayhead}
                      className="text-[9px] px-1.5 py-0.5 rounded bg-blue-100 hover:bg-blue-200 dark:bg-blue-900/40 dark:hover:bg-blue-900/70 text-blue-700 dark:text-blue-200"
                    >
                      + {playheadSec.toFixed(2)}s に追加
                    </button>
                  </div>
                  {frames.length > 0 && (
                    <div className="mt-1 space-y-0.5">
                      {frames.map((f, i) => (
                        <div
                          key={i}
                          className="grid grid-cols-[auto_60px_auto_70px_auto] items-center gap-1 text-[10px]"
                        >
                          <span className="text-gray-500">t=</span>
                          <input
                            type="number"
                            step="0.1"
                            value={f.time}
                            onChange={(e) =>
                              editFrame(i, {
                                time: Math.max(0, Number(e.target.value)),
                              })
                            }
                            className="px-1 py-0.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
                          />
                          <span className="text-gray-500">
                            = {p.unit ?? ""}
                          </span>
                          <input
                            type="number"
                            step={p.step ?? 0.1}
                            value={f.value}
                            onChange={(e) =>
                              editFrame(i, { value: Number(e.target.value) })
                            }
                            className="px-1 py-0.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
                          />
                          <button
                            type="button"
                            onClick={() => removeFrame(i)}
                            className="text-red-500 hover:text-red-700"
                            title="削除"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {!allAudio && (
      <Section id="geometry" title="位置・サイズ" open={isOpen("geometry")} onToggle={toggle} currentTab={activeTab}>
        {numInput("X", common("x"), (v) => onChange({ x: v }), 1, "%")}
        {numInput("Y", common("y"), (v) => onChange({ y: v }), 1, "%")}
        {numInput("幅", common("width"), (v) => onChange({ width: v }), 1, "%")}
        {numInput("高さ", common("height"), (v) => onChange({ height: v }), 1, "%")}
        {sliderInput(
          "回転",
          common("rotation") ?? 0,
          (v) => onChange({ rotation: v }),
          -180,
          180,
          1,
          "°",
        )}
        {sliderInput(
          "不透明度",
          common("opacity") ?? 1,
          (v) => onChange({ opacity: Math.max(0, Math.min(1, v)) }),
          0,
          1,
          0.01,
        )}
        {numInput("Z順", common("zIndex"), (v) => onChange({ zIndex: v }), 1)}
        <p className="text-[10px] text-gray-500">Z順: 大きいほど前面</p>
      </Section>
      )}

      {!allAudio && (
      <Section id="shape" title="形状" open={isOpen("shape")} onToggle={toggle} currentTab={activeTab}>
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
          sliderInput("角丸 px", common("borderRadius") ?? 12, (v) => onChange({ borderRadius: v }), 0, 60, 1, "px")}
      </Section>
      )}

      {!allAudio && (
      <Section id="border" title="枠線" open={isOpen("border")} onToggle={toggle} currentTab={activeTab}>
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
        <Section id="fill" title="塗り色" open={isOpen("fill")} onToggle={toggle} currentTab={activeTab}>
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
        <Section id="decoration" title="テキスト演出" open={isOpen("decoration")} onToggle={toggle} currentTab={activeTab}>
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
        <Section id="text" title="テキスト" open={isOpen("text")} onToggle={toggle} currentTab={activeTab}>
          {/* インポート済みコメントから挿入 DDL（comment レイヤー・単独選択時のみ） */}
          {!multi &&
            primary.type === "comment" &&
            importedComments &&
            importedComments.length > 0 && (
              <div className="pb-1 border-b border-gray-200 dark:border-gray-700 mb-1">
                <label className="block text-[10px] text-gray-500 mb-0.5">
                  📋 インポート済みコメントから挿入（{importedComments.length}件）
                </label>
                <select
                  value=""
                  onChange={(e) => {
                    const id = e.target.value;
                    if (!id) return;
                    const c = importedComments.find((x) => x.id === id);
                    if (c) onChange({ text: c.text });
                    // select はイベント後に値を空に戻す
                    e.target.value = "";
                  }}
                  className="w-full px-1.5 py-0.5 text-[11px] rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
                >
                  <option value="">— コメントを選んで挿入 —</option>
                  {importedComments.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.isReply ? "↪ " : ""}
                      {c.author ? `@${c.author}: ` : ""}
                      {c.text.length > 48 ? c.text.slice(0, 48) + "…" : c.text}
                    </option>
                  ))}
                </select>
              </div>
            )}
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

          {/* 文字縁取り */}
          <label className="flex items-center gap-1 text-[11px] pt-1">
            <input
              type="checkbox"
              checked={(common("textOutlineWidth") ?? 0) > 0}
              onChange={(e) =>
                onChange({
                  textOutlineWidth: e.target.checked
                    ? common("textOutlineWidth") ?? 3
                    : 0,
                  textOutlineColor:
                    common("textOutlineColor") ?? "#000000",
                })
              }
              className="h-3 w-3"
            />
            文字に縁取りをつける
          </label>
          {(common("textOutlineWidth") ?? 0) > 0 && (
            <div className="ml-4 space-y-1">
              {numInput(
                "縁 太さ",
                common("textOutlineWidth") ??
                  (multi ? undefined : primary.textOutlineWidth ?? 3),
                (v) => onChange({ textOutlineWidth: Math.max(0, v) }),
                1,
                "px",
              )}
              <div className="grid grid-cols-[70px_1fr] items-center gap-1 text-[11px]">
                <label className="text-gray-600 dark:text-gray-400">縁の色</label>
                <input
                  type="color"
                  value={common("textOutlineColor") ?? "#000000"}
                  onChange={(e) =>
                    onChange({ textOutlineColor: e.target.value })
                  }
                  className="w-full h-6 rounded border border-gray-300 dark:border-gray-600"
                />
              </div>
            </div>
          )}

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
        <Section id="audio" title="音声" open={isOpen("audio")} onToggle={toggle} currentTab={activeTab}>
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
          {sliderInput(
            "音量",
            common("volume") ?? 1,
            (v) => onChange({ volume: Math.max(0, Math.min(2, v)) }),
            0,
            2,
            0.05,
          )}
          {sliderInput(
            "再生速度",
            common("playbackRate") ?? 1,
            (v) => onChange({ playbackRate: Math.max(0.5, Math.min(4, v)) }),
            0.5,
            4,
            0.05,
            "x",
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
          currentTab={activeTab}
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
          {/* 動画レイヤー: ループ再生トグル */}
          {primary.type === "video" && (
            <div className="pt-1 mt-1 border-t border-gray-200 dark:border-gray-700 space-y-1">
              <label className="flex items-center gap-1 text-[11px] cursor-pointer">
                <input
                  type="checkbox"
                  checked={(primary.videoLoop ?? true) === true}
                  onChange={(e) => {
                    const loop = e.target.checked;
                    const patch: Partial<Layer> = { videoLoop: loop };
                    // OFFに切替時、素材尺を超えていれば endSec をクランプ
                    if (
                      !loop &&
                      primary.sourceDurationSec &&
                      primary.sourceDurationSec > 0
                    ) {
                      const maxEnd =
                        primary.startSec + primary.sourceDurationSec;
                      if (primary.endSec > maxEnd) patch.endSec = maxEnd;
                    }
                    onChange(patch);
                  }}
                  className="h-3 w-3"
                />
                🔁 短いときループ再生
              </label>
              {primary.videoLoop === false && primary.sourceDurationSec && (
                <p className="text-[10px] text-gray-500">
                  素材尺 {primary.sourceDurationSec.toFixed(2)}s
                  を超える長さは設定できません
                </p>
              )}
            </div>
          )}
        </Section>
      )}
    </div>
  );
}
