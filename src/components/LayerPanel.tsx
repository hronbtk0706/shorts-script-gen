import type { Layer, LayerType } from "../types";
import { sortedLayers, makeLayer, moveLayerZ } from "../lib/layerUtils";

interface Props {
  layers: Layer[];
  selectedLayerId: string | null;
  onLayersChange: (layers: Layer[]) => void;
  onLayerSelect: (id: string | null) => void;
  /** 新規レイヤー追加時のデフォルト値（startSec/endSec 等） */
  newLayerDefaults?: { startSec?: number; endSec?: number };
}

const LAYER_TYPE_LABELS: Record<LayerType, { icon: string; label: string }> = {
  image: { icon: "🖼", label: "画像" },
  video: { icon: "🎬", label: "動画" },
  color: { icon: "🎨", label: "単色" },
  shape: { icon: "🟡", label: "図形" },
  text: { icon: "📝", label: "テキスト" },
  comment: { icon: "💬", label: "コメント枠" },
};

export function LayerPanel({
  layers,
  selectedLayerId,
  onLayersChange,
  onLayerSelect,
  newLayerDefaults,
}: Props) {
  const addLayer = (type: LayerType) => {
    const nextZ = layers.length > 0 ? Math.max(...layers.map((l) => l.zIndex)) + 1 : 0;
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

  const deleteLayer = (id: string) => {
    const next = layers.filter((l) => l.id !== id);
    onLayersChange(next);
    if (selectedLayerId === id) onLayerSelect(null);
  };

  const duplicateLayer = (id: string) => {
    const src = layers.find((l) => l.id === id);
    if (!src) return;
    const nextZ = Math.max(...layers.map((l) => l.zIndex)) + 1;
    const copy: Layer = {
      ...src,
      id: `ly_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      x: Math.min(src.x + 3, 90),
      y: Math.min(src.y + 3, 90),
      zIndex: nextZ,
    };
    onLayersChange([...layers, copy]);
    onLayerSelect(copy.id);
  };

  const moveZ = (id: string, direction: "up" | "down") => {
    onLayersChange(moveLayerZ(layers, id, direction));
  };

  // 表示は上位レイヤーを上に（z 降順）
  const displayOrder = sortedLayers(layers).reverse();

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300">
          レイヤー ({layers.length})
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
          const isSelected = l.id === selectedLayerId;
          return (
            <div
              key={l.id}
              onClick={() => onLayerSelect(l.id)}
              className={`flex items-center gap-1.5 px-2 py-1.5 rounded cursor-pointer text-xs ${
                isSelected
                  ? "bg-blue-100 dark:bg-blue-900/40 ring-1 ring-blue-500"
                  : "bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700"
              }`}
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
