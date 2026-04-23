import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import type { Layer, VideoTemplate } from "../types";
import { TemplateCanvas } from "./TemplateCanvas";
import { TemplateTimeline } from "./TemplateTimeline";
import { LayerPanel } from "./LayerPanel";
import { LayerPropertyPanel } from "./LayerPropertyPanel";
import { LayerPreview } from "./LayerPreview";
import { ExportModal } from "./ExportModal";
import { ImportCommentsModal } from "./ImportCommentsModal";
import {
  genLayerId,
  newBlankTemplateData,
  visibleLayersAt,
  findFreeTrackZIndex,
  migrateAudioToNegativeZ,
  migrateTextToComment,
  makeLayer,
} from "../lib/layerUtils";
import { saveTemplate, makeTemplateId } from "../lib/templateStore";
import {
  createPresetFromLayers,
  deletePreset,
  instantiatePreset,
  listPresets,
  savePreset,
  type LayerPreset,
} from "../lib/presetStore";
import { loadSettings } from "../lib/storage";
import { getTtsProvider } from "../lib/providers/tts";

function probeAudioDurationPath(url: string): Promise<number> {
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
  editing?: VideoTemplate | null;
  /** 保存が走ったときに親に通知（list 更新用）。editing 差し替えには使わない */
  onSaved: (saved?: VideoTemplate) => void;
  onCancel?: () => void;
  /** 未保存状態が変わるたびに通知（親が離脱前確認ダイアログで使う） */
  onDirtyChange?: (dirty: boolean) => void;
}

export function TemplateBuilder({ editing, onSaved, onCancel, onDirtyChange }: Props) {
  const initial = useMemo(() => {
    const base =
      editing ??
      newBlankTemplateData("新規テンプレート", makeTemplateId("new-template"));
    // 旧 text 型を comment に移行 → 音声 zIndex を負値に正規化
    const migrated = migrateTextToComment(base.layers);
    return { ...base, layers: migrateAudioToNegativeZ(migrated) };
  }, [editing]);

  const [template, setTemplateState] = useState<VideoTemplate>(initial);
  const [history, setHistory] = useState<VideoTemplate[]>([initial]);
  const [historyIdx, setHistoryIdx] = useState(0);
  const skipHistoryRef = useRef(false);
  // Undo/Redo の挙動修正用:
  //   マウス押下中（ドラッグ / リサイズ / 回転）は pointer event が離されるまで
  //   history に push しない。離したタイミングで最後の template を 1 件だけ commit する。
  //   これでドラッグ 1 回 = history 1 件になり、Ctrl+Z 1 回で操作 1 回分戻せる。
  const isPointerDownRef = useRef(false);
  const pendingCommitRef = useRef<VideoTemplate | null>(null);
  // setTimeout 等のコールバックから最新の historyIdx を参照するため
  const historyIdxRef = useRef(0);
  useEffect(() => {
    historyIdxRef.current = historyIdx;
  }, [historyIdx]);

  const [playheadSec, setPlayheadSec] = useState(0);
  const [selectedLayerIds, setSelectedLayerIds] = useState<string[]>([]);
  // プライマリ選択（最後に選んだもの。PropertyPanel 等の単一参照用）
  const selectedLayerId =
    selectedLayerIds[selectedLayerIds.length - 1] ?? null;
  // 単一選択の簡易 setter（従来呼び出し互換）
  const setSelectedLayerId = useCallback((id: string | null) => {
    setSelectedLayerIds(id === null ? [] : [id]);
  }, []);
  const [showGrid, setShowGrid] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [importCommentsOpen, setImportCommentsOpen] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [presetList, setPresetList] = useState<LayerPreset[]>([]);
  const [newPresetName, setNewPresetName] = useState("");
  const clipboardRef = useRef<Layer[]>([]);
  // このセッション中に保存が完了したテンプレの id（新規初回保存後もここに入る）
  const [committedId, setCommittedId] = useState<string | null>(
    editing?.id ?? null,
  );
  useEffect(() => {
    setCommittedId(editing?.id ?? null);
  }, [editing?.id]);
  // 未保存変更フラグ
  const [dirty, setDirty] = useState(false);
  const dirtySetSkipRef = useRef(true); // 初期マウント時は dirty を立てない
  const [seFolderPath, setSeFolderPath] = useState("");

  useEffect(() => {
    setHeaderSlot(document.getElementById("app-header-slot"));
  }, []);

  useEffect(() => {
    loadSettings().then((s) => setSeFolderPath(s.seFolderPath ?? ""));
  }, []);

  // ウィンドウのどこでも空白クリックしたら選択解除。
  // ただしテキスト範囲選択のようにドラッグ開始点がパネル内 → 外で離すケースは解除しない
  useEffect(() => {
    let mouseDownTarget: HTMLElement | null = null;
    const keeps = (el: HTMLElement | null) => {
      if (!el || typeof el.closest !== "function") return false;
      return Boolean(
        el.closest("[data-layer-id]") ||
          el.closest("[data-keep-selection]") ||
          el.closest('[class*="moveable-"]'),
      );
    };
    const onMouseDown = (e: MouseEvent) => {
      mouseDownTarget = e.target as HTMLElement | null;
    };
    const onDocClick = (e: MouseEvent) => {
      // mousedown 起点が維持対象ならスキップ（テキスト選択ドラッグ等）
      if (keeps(mouseDownTarget)) return;
      if (keeps(e.target as HTMLElement | null)) return;
      setSelectedLayerId(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("click", onDocClick);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("click", onDocClick);
    };
  }, []);

  useEffect(() => {
    if (skipHistoryRef.current) {
      skipHistoryRef.current = false;
      return;
    }
    if (isPointerDownRef.current) {
      // ドラッグ/リサイズ中は最新 snapshot を pending に保持するだけ。
      // pointer up のタイミングでまとめて 1 件だけ commit する。
      pendingCommitRef.current = template;
      return;
    }
    const idx = historyIdxRef.current;
    setHistory((h) => [...h.slice(0, idx + 1), template]);
    setHistoryIdx(idx + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template]);

  // マウス/タッチ/ペンのボタン押下中はドラッグと見なして history 抑制。
  // 離したタイミングに pending があれば history へ commit する。
  useEffect(() => {
    const onDown = () => {
      isPointerDownRef.current = true;
    };
    const onUp = () => {
      isPointerDownRef.current = false;
      const snap = pendingCommitRef.current;
      if (!snap) return;
      pendingCommitRef.current = null;
      const idx = historyIdxRef.current;
      setHistory((h) => [...h.slice(0, idx + 1), snap]);
      setHistoryIdx(idx + 1);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  // template が変わったら dirty フラグを立てる（マウント時 / state reset 時は立てない）
  useEffect(() => {
    if (dirtySetSkipRef.current) {
      dirtySetSkipRef.current = false;
      return;
    }
    setDirty(true);
  }, [template]);

  // 未保存状態を親に通知（新規で未保存のときだけ true）
  const needsConfirmLeave =
    dirty && !editing?.id && !committedId && template.layers.length > 0;
  useEffect(() => {
    onDirtyChange?.(needsConfirmLeave);
  }, [needsConfirmLeave, onDirtyChange]);

  useEffect(() => {
    skipHistoryRef.current = true;
    dirtySetSkipRef.current = true;
    setTemplateState(initial);
    setHistory([initial]);
    setHistoryIdx(0);
    setDirty(false);
  }, [initial]);

  const setTemplate: React.Dispatch<
    React.SetStateAction<VideoTemplate>
  > = useCallback((updater) => {
    setTemplateState(updater);
  }, []);

  const undo = useCallback(() => {
    if (historyIdx <= 0) return;
    skipHistoryRef.current = true;
    setHistoryIdx((i) => i - 1);
    setTemplateState(history[historyIdx - 1]);
  }, [historyIdx, history]);

  const redo = useCallback(() => {
    if (historyIdx >= history.length - 1) return;
    skipHistoryRef.current = true;
    setHistoryIdx((i) => i + 1);
    setTemplateState(history[historyIdx + 1]);
  }, [historyIdx, history]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isUndo =
        (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z";
      const isRedo =
        (e.ctrlKey || e.metaKey) &&
        ((e.shiftKey && e.key.toLowerCase() === "z") ||
          e.key.toLowerCase() === "y");
      if (isUndo) {
        e.preventDefault();
        undo();
      } else if (isRedo) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo]);

  const canUndo = historyIdx > 0;
  const canRedo = historyIdx < history.length - 1;

  // requestAnimationFrame でタイムライン再生
  useEffect(() => {
    if (!isPlaying) return;
    let rafId = 0;
    let lastTs = performance.now();
    const tick = (ts: number) => {
      const dt = (ts - lastTs) / 1000;
      lastTs = ts;
      setPlayheadSec((prev) => {
        const next = prev + dt;
        if (next >= template.totalDuration) {
          // ループ: 先頭に戻す（停止したければ setIsPlaying(false) にする）
          return 0;
        }
        return next;
      });
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, template.totalDuration]);

  const togglePlay = () => {
    // 末尾にいる時は先頭からリスタート
    if (!isPlaying && playheadSec >= template.totalDuration - 0.05) {
      setPlayheadSec(0);
    }
    setIsPlaying((p) => !p);
  };

  // スペースキーで再生/停止（入力フォーカス中は無視）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const target = e.target as HTMLElement;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      togglePlay();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, playheadSec, template.totalDuration]);

  const visibleLayers = useMemo(
    () => visibleLayersAt(template.layers, playheadSec),
    [template.layers, playheadSec],
  );
  // 時間外でも選択・編集できるよう、全レイヤーから探す
  const selectedLayer =
    template.layers.find((l) => l.id === selectedLayerId) ?? null;
  const selectedLayerInTime = selectedLayer
    ? visibleLayers.some((l) => l.id === selectedLayer.id)
    : false;

  const updateLayer = (layerId: string, patch: Partial<Layer>) => {
    setTemplate((t) => ({
      ...t,
      layers: t.layers.map((l) => (l.id === layerId ? { ...l, ...patch } : l)),
    }));
  };

  const setLayers = (layers: Layer[]) => {
    setTemplate((t) => ({ ...t, layers }));
  };

  const [narrationBusy, setNarrationBusy] = useState<string | null>(null);

  const handleGenerateNarration = useCallback(
    async (textLayerId: string, providerId: string, voice: string) => {
      const textLayer = template.layers.find((l) => l.id === textLayerId);
      if (!textLayer) return;
      const text = (textLayer.text ?? "").trim();
      if (!text) {
        setSaveMsg({ type: "err", text: "テキストが空です" });
        return;
      }
      setNarrationBusy(textLayerId);
      setSaveMsg(null);
      try {
        // 設定を基に provider/voice を差し替え
        const baseSettings = await loadSettings();
        const settings = {
          ...baseSettings,
          ttsProvider: providerId as typeof baseSettings.ttsProvider,
          edgeVoice: providerId === "edge" ? voice : baseSettings.edgeVoice,
          sayVoice: providerId === "say" ? voice : baseSettings.sayVoice,
          voicevoxSpeaker:
            providerId === "voicevox"
              ? Number(voice)
              : baseSettings.voicevoxSpeaker,
          openaiTtsVoice:
            providerId === "openai" ? voice : baseSettings.openaiTtsVoice,
          softalkVoice:
            providerId === "softalk"
              ? Number(voice)
              : baseSettings.softalkVoice,
        };
        const provider = getTtsProvider(providerId);
        const tempSessionId = `narration_${Date.now()}`;
        const tempPath = await provider.synthesize(
          {
            text,
            filename: `tts_${textLayerId}`,
            sessionId: tempSessionId,
          },
          settings,
        );
        const templateId = editing?.id ?? committedId ?? template.id;
        const savedPath = await invoke<string>("save_template_narration", {
          templateId,
          layerId: textLayerId,
          sourcePath: tempPath,
        });
        // 生成音声の尺を取得
        const { convertFileSrc } = await import("@tauri-apps/api/core");
        const url = convertFileSrc(savedPath);
        let dur = 3;
        try {
          dur = await probeAudioDurationPath(url);
        } catch {
          /* フォールバック 3s */
        }
        const startSec = textLayer.startSec;
        const endSec = Math.min(startSec + dur, template.totalDuration);
        // 既存ナレーションがあれば置き換え
        const oldAudioId = textLayer.generatedNarrationLayerId;
        setTemplate((t) => {
          const withoutOld = oldAudioId
            ? t.layers.filter((l) => l.id !== oldAudioId)
            : t.layers;
          const nextZ = findFreeTrackZIndex(
            withoutOld,
            startSec,
            endSec,
            "audio",
          );
          const base = makeLayer({ type: "audio", startSec, endSec }, nextZ);
          const audioLayer: Layer = { ...base, source: savedPath };
          // text レイヤーに紐付け id を保存
          const updatedLayers = withoutOld.map((l) =>
            l.id === textLayerId
              ? { ...l, generatedNarrationLayerId: audioLayer.id }
              : l,
          );
          return { ...t, layers: [...updatedLayers, audioLayer] };
        });
        setSaveMsg({ type: "ok", text: "✓ ナレーションを生成しました" });
        setTimeout(() => setSaveMsg(null), 2000);
      } catch (e) {
        console.error("[narration] failed:", e);
        setSaveMsg({
          type: "err",
          text: `ナレーション生成失敗: ${e instanceof Error ? e.message : String(e)}`,
        });
      } finally {
        setNarrationBusy(null);
      }
    },
    [template, editing?.id, committedId],
  );

  const handleSave = async () => {
    const name = template.name.trim();
    if (!name) {
      setSaveMsg({ type: "err", text: "テンプレ名を入力してください" });
      return;
    }
    setSaving(true);
    setSaveMsg(null);
    try {
      const effectiveId = editing?.id ?? committedId;
      const withName: VideoTemplate = { ...template, name };
      const toSave: VideoTemplate = effectiveId
        ? { ...withName, id: effectiveId }
        : { ...withName, id: makeTemplateId(name) };
      toSave.layers = toSave.layers.map((l) => ({
        ...l,
        id: l.id || genLayerId(),
      }));
      await saveTemplate(toSave);
      setCommittedId(toSave.id);
      setDirty(false);
      setSaveMsg({ type: "ok", text: `保存しました: ${name}` });
      // list 更新のためだけに通知（親は editingTemplate を差し替えない）
      onSaved(toSave);
      setTimeout(() => setSaveMsg(null), 2000);
    } catch (e) {
      console.error("[TemplateBuilder] save failed:", e);
      setSaveMsg({
        type: "err",
        text: `保存失敗: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setSaving(false);
    }
  };

  // 自動保存（初回保存済み 以降のみ。新規未保存は対象外）
  const autoSaveRef = useRef<{ busy: boolean }>({ busy: false });
  useEffect(() => {
    const effectiveId = editing?.id ?? committedId;
    if (!effectiveId) return;
    if (!template.name.trim()) return;
    if (!dirty) return;
    const timer = setTimeout(async () => {
      if (autoSaveRef.current.busy) return;
      autoSaveRef.current.busy = true;
      try {
        const toSave: VideoTemplate = {
          ...template,
          id: effectiveId,
          layers: template.layers.map((l) => ({
            ...l,
            id: l.id || genLayerId(),
          })),
        };
        await saveTemplate(toSave);
        setDirty(false);
        // 成功時は何も表示しない（Breadcrumb の dirty ドット消滅だけで充分）
      } catch (e) {
        console.warn("[TemplateBuilder] auto-save failed:", e);
        setSaveMsg({ type: "err", text: "自動保存失敗" });
      } finally {
        autoSaveRef.current.busy = false;
      }
    }, 1500);
    return () => clearTimeout(timer);
  }, [template, editing?.id, committedId, dirty]);

  // --- キーボードショートカット用のヘルパー ---
  // Shift/Ctrl 修飾に対応した選択ハンドラ
  const handleLayerSelect = useCallback(
    (id: string | null, modifier: "shift" | "ctrl" | null = null) => {
      if (id === null) {
        setSelectedLayerIds([]);
        return;
      }
      if (modifier === "ctrl") {
        setSelectedLayerIds((prev) =>
          prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        );
        return;
      }
      if (modifier === "shift") {
        setSelectedLayerIds((prev) => {
          const sorted = [...template.layers].sort(
            (a, b) => b.zIndex - a.zIndex,
          );
          const ids = sorted.map((l) => l.id);
          const last = prev[prev.length - 1];
          const lastIdx = last ? ids.indexOf(last) : -1;
          const nextIdx = ids.indexOf(id);
          if (lastIdx < 0 || nextIdx < 0) return [id];
          const [from, to] =
            lastIdx <= nextIdx ? [lastIdx, nextIdx] : [nextIdx, lastIdx];
          return ids.slice(from, to + 1);
        });
        return;
      }
      setSelectedLayerIds([id]);
    },
    [template.layers],
  );

  const deleteSelected = useCallback(() => {
    if (selectedLayerIds.length === 0) return;
    // ロック中のレイヤーは残す
    const toDelete = new Set(
      selectedLayerIds.filter(
        (id) => !template.layers.find((l) => l.id === id)?.locked,
      ),
    );
    if (toDelete.size === 0) return;
    setTemplateState((t) => ({
      ...t,
      layers: t.layers.filter((l) => !toDelete.has(l.id)),
    }));
    setSelectedLayerIds([]);
  }, [selectedLayerIds, template.layers]);

  const duplicateSelected = useCallback(() => {
    if (selectedLayerIds.length === 0) return;
    const srcList = selectedLayerIds
      .map((id) => template.layers.find((l) => l.id === id))
      .filter((l): l is Layer => !!l);
    if (srcList.length === 0) return;
    const copies: Layer[] = [];
    const working: Layer[] = [...template.layers];
    for (const src of srcList) {
      const section = src.type === "audio" ? "audio" : "video";
      const nextZ = findFreeTrackZIndex(
        working,
        src.startSec,
        src.endSec,
        section,
      );
      const copy: Layer = {
        ...src,
        id: genLayerId(),
        x: Math.min(src.x + 3, 90),
        y: Math.min(src.y + 3, 90),
        zIndex: nextZ,
      };
      working.push(copy);
      copies.push(copy);
    }
    setTemplateState((t) => ({ ...t, layers: [...t.layers, ...copies] }));
    setSelectedLayerIds(copies.map((c) => c.id));
  }, [selectedLayerIds, template.layers]);

  const copySelected = useCallback(() => {
    const srcs = selectedLayerIds
      .map((id) => template.layers.find((l) => l.id === id))
      .filter((l): l is Layer => !!l);
    if (srcs.length === 0) return;
    clipboardRef.current = srcs;
  }, [selectedLayerIds, template.layers]);

  // プリセット
  const reloadPresets = useCallback(async () => {
    try {
      const list = await listPresets();
      setPresetList(list);
    } catch (e) {
      console.warn("[TemplateBuilder] listPresets failed:", e);
    }
  }, []);
  useEffect(() => {
    if (presetOpen) reloadPresets();
  }, [presetOpen, reloadPresets]);

  const handleCreatePreset = useCallback(async () => {
    const srcs = selectedLayerIds
      .map((id) => template.layers.find((l) => l.id === id))
      .filter((l): l is Layer => !!l);
    if (srcs.length === 0) {
      setSaveMsg({ type: "err", text: "レイヤーを選択してから保存してください" });
      return;
    }
    const preset = createPresetFromLayers(newPresetName, srcs);
    try {
      await savePreset(preset);
      setNewPresetName("");
      await reloadPresets();
      setSaveMsg({ type: "ok", text: `プリセット「${preset.name}」を保存しました` });
    } catch (e) {
      setSaveMsg({
        type: "err",
        text: e instanceof Error ? e.message : "保存失敗",
      });
    }
  }, [selectedLayerIds, template.layers, newPresetName, reloadPresets]);

  const handleInsertPreset = useCallback(
    (preset: LayerPreset) => {
      const newLayers = instantiatePreset(
        preset,
        playheadSec,
        template.totalDuration,
      );
      if (newLayers.length === 0) return;
      setTemplateState((t) => ({
        ...t,
        layers: [...t.layers, ...newLayers],
      }));
      setSelectedLayerIds(newLayers.map((l) => l.id));
      setPresetOpen(false);
    },
    [playheadSec, template.totalDuration],
  );

  const handleDeletePreset = useCallback(
    async (preset: LayerPreset) => {
      if (!confirm(`プリセット「${preset.name}」を削除しますか?`)) return;
      try {
        await deletePreset(preset.id);
        await reloadPresets();
      } catch (e) {
        console.warn("[TemplateBuilder] deletePreset failed:", e);
      }
    },
    [reloadPresets],
  );

  const pasteClipboard = useCallback(() => {
    const srcs = clipboardRef.current;
    if (srcs.length === 0) return;
    // コピー元の最古の startSec を基準に、playhead へスライドする相対オフセットを計算
    const origin = Math.min(...srcs.map((s) => s.startSec));
    const offset = playheadSec - origin;
    const working: Layer[] = [...template.layers];
    const pasted: Layer[] = [];
    for (const src of srcs) {
      const dur = Math.max(0.1, src.endSec - src.startSec);
      const newStart = Math.max(
        0,
        Math.min(template.totalDuration - 0.1, src.startSec + offset),
      );
      const newEnd = Math.min(newStart + dur, template.totalDuration);
      if (newEnd - newStart < 0.1) continue;
      const section = src.type === "audio" ? "audio" : "video";
      const nextZ = findFreeTrackZIndex(
        working,
        newStart,
        newEnd,
        section,
      );
      const copy: Layer = {
        ...src,
        id: genLayerId(),
        startSec: newStart,
        endSec: newEnd,
        zIndex: nextZ,
      };
      working.push(copy);
      pasted.push(copy);
    }
    if (pasted.length === 0) return;
    setTemplateState((t) => ({ ...t, layers: [...t.layers, ...pasted] }));
    setSelectedLayerIds(pasted.map((p) => p.id));
  }, [playheadSec, template.layers, template.totalDuration]);

  const nudgeSelectedLayer = useCallback(
    (deltaSec: number) => {
      if (selectedLayerIds.length === 0) return;
      setTemplateState((t) => {
        const updates = new Map<string, Partial<Layer>>();
        for (const id of selectedLayerIds) {
          const l = t.layers.find((x) => x.id === id);
          if (!l) continue;
          const len = l.endSec - l.startSec;
          const newStart = Math.max(
            0,
            Math.min(t.totalDuration - len, l.startSec + deltaSec),
          );
          updates.set(id, {
            startSec: newStart,
            endSec: newStart + len,
          });
        }
        return {
          ...t,
          layers: t.layers.map((x) =>
            updates.has(x.id) ? { ...x, ...updates.get(x.id)! } : x,
          ),
        };
      });
    },
    [selectedLayerIds],
  );

  // キーボードショートカット
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // 入力系にフォーカス中はスキップ
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        // Escape は blur のために素通り（ブラウザ既定）
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      // Ctrl 系
      if (ctrl && !e.shiftKey && key === "d") {
        e.preventDefault();
        duplicateSelected();
        return;
      }
      if (ctrl && !e.shiftKey && key === "c") {
        e.preventDefault();
        copySelected();
        return;
      }
      if (ctrl && !e.shiftKey && key === "v") {
        e.preventDefault();
        pasteClipboard();
        return;
      }
      if (ctrl && !e.shiftKey && key === "s") {
        e.preventDefault();
        handleSave();
        return;
      }
      if (ctrl && !e.shiftKey && key === "a") {
        e.preventDefault();
        // 全レイヤー選択
        setSelectedLayerIds(template.layers.map((l) => l.id));
        return;
      }

      // 単独キー
      if (key === "delete" || key === "backspace") {
        if (selectedLayerIds.length > 0) {
          e.preventDefault();
          deleteSelected();
        }
        return;
      }
      if (key === "escape") {
        setSelectedLayerId(null);
        setShortcutsOpen(false);
        return;
      }
      // ? キー（多くの配列で Shift+/）でショートカット一覧を開閉
      if (key === "?" || (e.shiftKey && key === "/")) {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      if (key === "home") {
        e.preventDefault();
        setPlayheadSec(0);
        return;
      }
      if (key === "end") {
        e.preventDefault();
        setPlayheadSec(template.totalDuration);
        return;
      }
      if (key === "arrowleft" || key === "arrowright") {
        const sign = key === "arrowleft" ? -1 : 1;
        // Alt: 微調整 0.01s / Shift: 大きく 1.0s / 通常: 0.1s
        const step = e.altKey ? 0.01 : e.shiftKey ? 1.0 : 0.1;
        const delta = sign * step;
        if (selectedLayerIds.length > 0) {
          // 何か選択中 → レイヤーを時間方向に微調整
          e.preventDefault();
          nudgeSelectedLayer(delta);
        } else {
          // 未選択 → プレイヘッドを左右に動かす
          e.preventDefault();
          setPlayheadSec((s) =>
            Math.max(0, Math.min(template.totalDuration, s + delta)),
          );
        }
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    deleteSelected,
    duplicateSelected,
    copySelected,
    pasteClipboard,
    nudgeSelectedLayer,
    handleSave,
    selectedLayerId,
    selectedLayerIds,
    template.layers,
    template.totalDuration,
  ]);

  // 画像2 = ヘッダーに portal で移動するツールバー（保存等）
  const headerToolbar = (
    <div
      data-keep-selection
      className="contents"
    >
      <input
        type="text"
        value={template.name}
        placeholder="テンプレ名"
        onChange={(e) =>
          setTemplate((t) => ({ ...t, name: e.target.value }))
        }
        className="w-44 px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
      />
      <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
        尺
        <input
          type="number"
          min={5}
          max={300}
          value={template.totalDuration}
          onChange={(e) =>
            setTemplate((t) => ({
              ...t,
              totalDuration: Number(e.target.value) || 30,
            }))
          }
          className="w-14 px-1 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
        />
        <span className="text-[10px]">秒</span>
      </label>
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1 rounded border border-gray-300 dark:border-gray-600 text-xs"
        >
          キャンセル
        </button>
      )}
      <button
        type="button"
        onClick={() => setPresetOpen(true)}
        className="px-3 py-1 rounded bg-amber-500 hover:bg-amber-600 text-white text-xs"
        title="選択レイヤーの見た目・アニメをプリセットに保存／プリセットから挿入"
      >
        🎁 プリセット
      </button>
      <button
        type="button"
        onClick={() => setShortcutsOpen(true)}
        className="px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-xs text-gray-600 dark:text-gray-300"
        title="キーボードショートカット一覧（? キー）"
      >
        ⌨ ?
      </button>
      <button
        type="button"
        onClick={() => setImportCommentsOpen(true)}
        className="px-3 py-1 rounded bg-purple-600 hover:bg-purple-700 text-white text-xs relative"
        title="YouTube のコメントを取得してテンプレに取り込む"
      >
        💬 コメント取得
        {template.importedComments && template.importedComments.length > 0 && (
          <span className="absolute -top-1 -right-1 bg-amber-400 text-[10px] text-gray-900 rounded-full px-1 min-w-[16px] h-4 flex items-center justify-center">
            {template.importedComments.length}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={() => setExportOpen(true)}
        className="px-3 py-1 rounded bg-fuchsia-600 hover:bg-fuchsia-700 text-white text-xs"
        title="このテンプレの内容そのままを MP4 として書き出す"
      >
        🎬 エクスポート
      </button>
      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs disabled:bg-gray-400"
      >
        {saving
          ? "保存中..."
          : editing
            ? "今すぐ保存"
            : "テンプレ保存"}
      </button>
    </div>
  );

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 100px)" }}>
      {headerSlot && createPortal(headerToolbar, headerSlot)}

      {saveMsg && (
        <div
          className={`text-xs px-2 py-1 rounded shrink-0 ${
            saveMsg.type === "ok"
              ? "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
              : "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300"
          }`}
        >
          {saveMsg.text}
        </div>
      )}

      {/* 2 カラム: 左=Canvas+Controls / 右=Panels+Timeline */}
      <div
        className="flex-1 min-h-0"
        style={{
          display: "grid",
          gridTemplateColumns: "480px 1fr",
          gap: "1.5rem",
          alignItems: "stretch",
        }}
      >
        {/* 左: キャンバスのみ */}
        <div className="flex flex-col min-w-0 min-h-0">
          <div className="flex-1 min-h-0 flex items-start justify-center">
            <TemplateCanvas
              layers={template.layers}
              selectedLayerId={selectedLayerId}
              selectedLayerIds={selectedLayerIds}
              onLayerSelect={handleLayerSelect}
              onLayerUpdate={updateLayer}
              showGrid={showGrid}
              currentTimeSec={playheadSec}
              isPlaying={isPlaying}

            />
          </div>
        </div>

        {/* 右: パネル + タイムライン */}
        <div className="flex flex-col min-w-0 min-h-0 gap-2">
          <div
            className="grid shrink-0"
            style={{
              gridTemplateColumns: "280px 240px 260px",
              gap: "1.25rem",
              height: "460px",
            }}
          >
            <div className="min-w-0 overflow-y-auto" data-keep-selection>
              <LayerPanel
                layers={template.layers}
                selectedLayerId={selectedLayerId}
                selectedLayerIds={selectedLayerIds}
                onLayersChange={setLayers}
                onLayerSelect={handleLayerSelect}
                newLayerDefaults={{
                  startSec: playheadSec,
                  endSec: Math.min(playheadSec + 3, template.totalDuration),
                }}
                currentTimeSec={playheadSec}
                seFolderPath={seFolderPath}
              />
            </div>
            <div
              className="min-w-0 overflow-y-auto pr-1"
              data-keep-selection
            >
              <LayerPropertyPanel
                layers={template.layers.filter((l) =>
                  selectedLayerIds.includes(l.id),
                )}
                onChange={(patch) => {
                  for (const id of selectedLayerIds) {
                    updateLayer(id, patch);
                  }
                }}
                onGenerateNarration={handleGenerateNarration}
                narrationBusyLayerId={narrationBusy}
                importedComments={template.importedComments}
                playheadSec={playheadSec}
              />
            </div>
            <div
              className="min-w-0 overflow-hidden flex flex-col gap-1"
              data-keep-selection
            >
              <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300 shrink-0">
                プレビュー
              </h4>
              <div className="flex-1 min-h-0 flex items-start justify-center">
                <LayerPreview layer={selectedLayer} />
              </div>
            </div>
          </div>
          {/* タイムライン上のコントロール */}
          <div
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] shrink-0"
          >
            <button
              type="button"
              onClick={undo}
              disabled={!canUndo}
              className="px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 text-[11px] disabled:opacity-40"
            >
              ↶ 元に戻す
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={!canRedo}
              className="px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 text-[11px] disabled:opacity-40"
            >
              やり直す ↷
            </button>
            <button
              type="button"
              onClick={togglePlay}
              className={`px-2 py-0.5 rounded text-[11px] font-medium ${
                isPlaying
                  ? "bg-red-600 hover:bg-red-700 text-white"
                  : "bg-emerald-600 hover:bg-emerald-700 text-white"
              }`}
              title={isPlaying ? "一時停止 (Space)" : "再生 (Space)"}
            >
              {isPlaying ? "⏸ 一時停止" : "▶ 再生"}
            </button>
            <span className="text-gray-500">
              {playheadSec.toFixed(1)}s / {template.totalDuration}s · 表示{" "}
              {visibleLayers.length}/{template.layers.length}
            </span>
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={showGrid}
                onChange={(e) => setShowGrid(e.target.checked)}
                className="h-3 w-3"
              />
              グリッド
            </label>
            {selectedLayer && !selectedLayerInTime && (
              <span className="px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 text-[10px]">
                ⚠ 選択は非表示
              </span>
            )}
          </div>
          <div className="flex-1 min-h-0">
            <TemplateTimeline
              layers={template.layers}

              totalDuration={template.totalDuration}
              playheadSec={playheadSec}
              selectedLayerId={selectedLayerId}
              selectedLayerIds={selectedLayerIds}
              onLayerUpdate={updateLayer}
              onLayerSelect={handleLayerSelect}
              onPlayheadChange={setPlayheadSec}
              onLayersReorder={setLayers}
            />
          </div>
        </div>
      </div>

      <ExportModal
        open={exportOpen}
        template={template}
        onClose={() => setExportOpen(false)}
      />

      <ImportCommentsModal
        open={importCommentsOpen}
        existingComments={template.importedComments}
        existingSource={template.importedCommentsSource}
        onImport={(comments, source) => {
          setTemplate((t) => ({
            ...t,
            importedComments: comments,
            importedCommentsSource: source,
          }));
        }}
        onClose={() => setImportCommentsOpen(false)}
      />

      {shortcutsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShortcutsOpen(false)}
        >
          <div
            className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-[560px] max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between sticky top-0 bg-white dark:bg-gray-900">
              <h3 className="font-semibold text-sm">⌨ キーボードショートカット</h3>
              <button
                type="button"
                onClick={() => setShortcutsOpen(false)}
                className="text-gray-500 hover:text-gray-700 text-xs"
              >
                ✕
              </button>
            </div>
            {(() => {
              const sections: Array<{
                title: string;
                items: Array<{ keys: string; desc: string }>;
              }> = [
                {
                  title: "編集",
                  items: [
                    { keys: "Ctrl + Z", desc: "元に戻す" },
                    { keys: "Ctrl + Y / Ctrl + Shift + Z", desc: "やり直し" },
                    { keys: "Ctrl + D", desc: "選択レイヤーを複製" },
                    { keys: "Ctrl + C", desc: "選択レイヤーをコピー" },
                    { keys: "Ctrl + V", desc: "プレイヘッド位置にペースト" },
                    { keys: "Delete / Backspace", desc: "選択レイヤーを削除" },
                    { keys: "Ctrl + A", desc: "全レイヤーを選択" },
                    { keys: "Esc", desc: "選択解除 / モーダルを閉じる" },
                  ],
                },
                {
                  title: "タイムライン / プレイヘッド",
                  items: [
                    {
                      keys: "← / →",
                      desc: "選択ありならレイヤー微調整 (0.1s) / なければプレイヘッド移動",
                    },
                    { keys: "Shift + ← / →", desc: "大きく 1.0s 動かす" },
                    { keys: "Alt + ← / →", desc: "細かく 0.01s 動かす" },
                    { keys: "Home / End", desc: "プレイヘッドを先頭/末尾へ" },
                    { keys: "Ctrl + ホイール", desc: "タイムライン横ズーム" },
                    { keys: "Ctrl + = / -", desc: "タイムライン横ズーム（中央基準）" },
                    { keys: "Ctrl + 0", desc: "タイムラインズームを元に戻す" },
                  ],
                },
                {
                  title: "プロパティ編集",
                  items: [
                    {
                      keys: "ラベル左右ドラッグ",
                      desc: "数値プロパティを連続的に変更",
                    },
                    {
                      keys: "マウスホイール",
                      desc: "ラベル / スライダー上でホイール = 値変更",
                    },
                    { keys: "Shift (押しながら)", desc: "×10 で粗く" },
                    { keys: "Alt (押しながら)", desc: "×0.1 で精密" },
                  ],
                },
                {
                  title: "保存 / その他",
                  items: [
                    { keys: "Ctrl + S", desc: "テンプレを保存" },
                    { keys: "?", desc: "このショートカット一覧を開閉" },
                  ],
                },
              ];
              return (
                <div className="p-3 space-y-4 text-[11px]">
                  {sections.map((s) => (
                    <div key={s.title}>
                      <h4 className="font-semibold text-[11px] text-gray-700 dark:text-gray-300 mb-1">
                        {s.title}
                      </h4>
                      <ul className="space-y-0.5">
                        {s.items.map((it, i) => (
                          <li
                            key={i}
                            className="grid grid-cols-[160px_1fr] gap-2 py-0.5"
                          >
                            <code className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-mono">
                              {it.keys}
                            </code>
                            <span className="text-gray-600 dark:text-gray-400">
                              {it.desc}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {presetOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setPresetOpen(false)}
        >
          <div
            className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-[520px] max-h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
              <h3 className="font-semibold text-sm">🎁 レイヤープリセット</h3>
              <button
                type="button"
                onClick={() => setPresetOpen(false)}
                className="text-gray-500 hover:text-gray-700 text-xs"
              >
                ✕
              </button>
            </div>

            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 space-y-2">
              <div className="text-[11px] text-gray-500">
                選択中のレイヤー（{selectedLayerIds.length}件）の見た目・アニメ・キーフレームをプリセットとして保存。
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newPresetName}
                  onChange={(e) => setNewPresetName(e.target.value)}
                  placeholder="プリセット名"
                  className="flex-1 px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
                />
                <button
                  type="button"
                  onClick={handleCreatePreset}
                  disabled={selectedLayerIds.length === 0}
                  className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white text-xs"
                >
                  保存
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto">
              {presetList.length === 0 ? (
                <div className="px-4 py-6 text-center text-[11px] text-gray-400">
                  プリセット未作成。上で作成してください。
                </div>
              ) : (
                <ul className="divide-y divide-gray-200 dark:divide-gray-700">
                  {presetList.map((p) => (
                    <li
                      key={p.id}
                      className="px-4 py-2 flex items-center justify-between gap-2"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium truncate">
                          {p.name}
                        </div>
                        <div className="text-[10px] text-gray-500">
                          {p.layers.length}レイヤー ·{" "}
                          {new Date(p.createdAt).toLocaleDateString()}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleInsertPreset(p)}
                        className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-[11px]"
                        title={`現在のプレイヘッド位置 (${playheadSec.toFixed(2)}s) に挿入`}
                      >
                        ＋ 挿入
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeletePreset(p)}
                        className="px-2 py-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 text-[11px]"
                        title="削除"
                      >
                        🗑
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
