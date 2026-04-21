import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Layer, LayerType } from "../types";
import {
  sortedLayers,
  makeLayer,
  moveLayerZ,
  findFreeTrackZIndex,
} from "../lib/layerUtils";

/** 音声ファイルのメタ情報から再生時間(秒)を取得 */
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
  layers: Layer[];
  selectedLayerId: string | null;
  /** 複数選択中の全 id（プライマリ含む）。未指定なら [selectedLayerId] 相当として扱う */
  selectedLayerIds?: string[];
  onLayersChange: (layers: Layer[]) => void;
  onLayerSelect: (
    id: string | null,
    modifier?: "shift" | "ctrl" | null,
  ) => void;
  /** 新規レイヤー追加時のデフォルト値（startSec/endSec 等） */
  newLayerDefaults?: { startSec?: number; endSec?: number };
  /** 指定時刻に可視なレイヤーだけ一覧に表示（未指定なら全表示） */
  currentTimeSec?: number;
}

const LAYER_TYPE_LABELS: Record<LayerType, { icon: string; label: string }> = {
  image: { icon: "🖼", label: "画像" },
  video: { icon: "🎬", label: "動画" },
  color: { icon: "🎨", label: "単色" },
  shape: { icon: "🟡", label: "図形" },
  comment: { icon: "📝", label: "テキスト" },
  audio: { icon: "🎵", label: "音声" },
};

export function LayerPanel({
  layers,
  selectedLayerId,
  selectedLayerIds,
  onLayersChange,
  onLayerSelect,
  newLayerDefaults,
  currentTimeSec,
}: Props) {
  const selectedSet = new Set<string>(
    selectedLayerIds ?? (selectedLayerId ? [selectedLayerId] : []),
  );
  const addLayer = async (type: LayerType) => {
    if (type === "audio") {
      // 音声はファイル選択から入って、尺を自動セット
      await addAudioFromFile();
      return;
    }
    const startSec = newLayerDefaults?.startSec ?? 0;
    const endSec =
      newLayerDefaults?.endSec ?? Math.max(startSec + 1, startSec + 3);
    const nextZ = findFreeTrackZIndex(layers, startSec, endSec);
    const newLayer = makeLayer(
      {
        type,
        startSec: newLayerDefaults?.startSec,
        endSec: newLayerDefaults?.endSec,
      },
      nextZ,
    );
    onLayersChange([...layers, newLayer]);
    onLayerSelect(newLayer.id);
  };

  const addAudioFromFile = async () => {
    try {
      const path = await openDialog({
        multiple: false,
        directory: false,
        filters: [
          {
            name: "音声",
            extensions: ["mp3", "wav", "m4a", "ogg", "aac", "flac"],
          },
        ],
      });
      if (typeof path !== "string") return;
      let dur = 3;
      try {
        dur = await probeAudioDuration(path);
      } catch (e) {
        console.warn("[LayerPanel] audio duration probe failed:", e);
      }
      const startSec = newLayerDefaults?.startSec ?? 0;
      const endSec = startSec + dur;
      const nextZ = findFreeTrackZIndex(layers, startSec, endSec, "audio");
      const base = makeLayer({ type: "audio", startSec, endSec }, nextZ);
      const layer: Layer = { ...base, source: path };
      onLayersChange([...layers, layer]);
      onLayerSelect(layer.id);
    } catch (e) {
      console.warn("[LayerPanel] addAudioFromFile failed:", e);
    }
  };

  // 選択中の行のアイコン操作は選択全体に適用（単独行なら単独）
  const targetIdsFor = (id: string): string[] =>
    selectedSet.has(id) && selectedSet.size > 1
      ? Array.from(selectedSet)
      : [id];

  const deleteLayer = (id: string) => {
    const targets = new Set(targetIdsFor(id));
    const next = layers.filter((l) => !targets.has(l.id));
    onLayersChange(next);
    if (selectedLayerId && targets.has(selectedLayerId)) onLayerSelect(null);
  };

  const duplicateLayer = (id: string) => {
    const targets = targetIdsFor(id);
    const working: Layer[] = [...layers];
    const copies: Layer[] = [];
    for (const tid of targets) {
      const src = working.find((l) => l.id === tid);
      if (!src) continue;
      const section: "video" | "audio" = src.type === "audio" ? "audio" : "video";
      const nextZ = findFreeTrackZIndex(
        working,
        src.startSec,
        src.endSec,
        section,
      );
      const copy: Layer = {
        ...src,
        id: `ly_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        x: Math.min(src.x + 3, 90),
        y: Math.min(src.y + 3, 90),
        zIndex: nextZ,
      };
      working.push(copy);
      copies.push(copy);
    }
    if (copies.length === 0) return;
    onLayersChange([...layers, ...copies]);
    onLayerSelect(copies[copies.length - 1].id);
  };

  const moveZ = (id: string, direction: "up" | "down") => {
    // Z移動はクリック行のみに適用（一括だと挙動が曖昧）
    onLayersChange(moveLayerZ(layers, id, direction));
  };

  const toggleHidden = (id: string) => {
    const targets = new Set(targetIdsFor(id));
    // 押した行の現状値を反転させて全対象に同じ値を適用
    const clicked = layers.find((l) => l.id === id);
    const newHidden = !clicked?.hidden;
    onLayersChange(
      layers.map((l) =>
        targets.has(l.id) ? { ...l, hidden: newHidden } : l,
      ),
    );
  };

  const toggleLocked = (id: string) => {
    const targets = new Set(targetIdsFor(id));
    const clicked = layers.find((l) => l.id === id);
    const newLocked = !clicked?.locked;
    onLayersChange(
      layers.map((l) =>
        targets.has(l.id) ? { ...l, locked: newLocked } : l,
      ),
    );
  };

  // 表示は上位レイヤーを上に（z 降順）。currentTimeSec が指定されていれば可視のみ
  const displayOrder = sortedLayers(layers)
    .reverse()
    .filter((l) =>
      currentTimeSec === undefined
        ? true
        : currentTimeSec >= l.startSec && currentTimeSec < l.endSec,
    );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300">
          レイヤー{" "}
          {currentTimeSec === undefined
            ? `(${layers.length})`
            : `(${displayOrder.length}/${layers.length})`}
        </h4>
      </div>

      <div className="grid grid-cols-3 gap-1">
        {(Object.keys(LAYER_TYPE_LABELS) as LayerType[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => addLayer(t)}
            className="flex flex-col items-center gap-0.5 px-1 py-1.5 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-[10px]"
            title={`${LAYER_TYPE_LABELS[t].label}レイヤーを追加`}
          >
            <span className="text-base">{LAYER_TYPE_LABELS[t].icon}</span>
            <span>{LAYER_TYPE_LABELS[t].label}</span>
          </button>
        ))}
      </div>

      <div className="max-h-[320px] overflow-y-auto space-y-1">
        {layers.length === 0 && (
          <div className="text-[11px] text-gray-400 text-center py-3">
            レイヤー未追加
          </div>
        )}
        {displayOrder.map((l) => {
          const info = LAYER_TYPE_LABELS[l.type];
          const isSelected = selectedSet.has(l.id);
          return (
            <div
              key={l.id}
              onClick={(e) => {
                const modifier = e.shiftKey
                  ? "shift"
                  : e.ctrlKey || e.metaKey
                    ? "ctrl"
                    : null;
                onLayerSelect(l.id, modifier);
              }}
              className={`flex items-center gap-1.5 px-2 py-1.5 rounded cursor-pointer text-xs ${
                isSelected
                  ? "bg-blue-100 dark:bg-blue-900/40 ring-1 ring-blue-500"
                  : "bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700"
              } ${l.hidden ? "opacity-50" : ""}`}
            >
              <span>{info.icon}</span>
              <span className="flex-1 truncate">
                {info.label}
                {l.text && ` "${l.text.slice(0, 10)}"`}
              </span>
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleHidden(l.id);
                  }}
                  className="p-0.5 hover:bg-gray-200 dark:hover:bg-gray-600 rounded"
                  title={l.hidden ? "表示する" : "非表示にする"}
                >
                  {l.hidden ? "🙈" : "👁"}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleLocked(l.id);
                  }}
                  className="p-0.5 hover:bg-gray-200 dark:hover:bg-gray-600 rounded"
                  title={l.locked ? "ロック解除" : "ロック"}
                >
                  {l.locked ? "🔒" : "🔓"}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    moveZ(l.id, "up");
                  }}
                  className="p-0.5 hover:bg-gray-200 dark:hover:bg-gray-600 rounded"
                  title="前面へ"
                >
                  ⬆
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    moveZ(l.id, "down");
                  }}
                  className="p-0.5 hover:bg-gray-200 dark:hover:bg-gray-600 rounded"
                  title="背面へ"
                >
                  ⬇
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    duplicateLayer(l.id);
                  }}
                  className="p-0.5 hover:bg-gray-200 dark:hover:bg-gray-600 rounded"
                  title="複製"
                >
                  📋
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteLayer(l.id);
                  }}
                  className="p-0.5 hover:bg-red-100 dark:hover:bg-red-900/40 rounded text-red-600"
                  title="削除"
                >
                  🗑
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
