import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Layer, LayerShape, EntryAnimation, ExitAnimation } from "../types";

interface Props {
  layer: Layer | null;
  onChange: (patch: Partial<Layer>) => void;
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
];

const EXIT_ANIMATIONS: { id: ExitAnimation; label: string }[] = [
  { id: "none", label: "なし" },
  { id: "fade", label: "フェードアウト" },
  { id: "slide-left", label: "左へスライド" },
  { id: "slide-right", label: "右へスライド" },
  { id: "slide-up", label: "上へスライド" },
  { id: "slide-down", label: "下へスライド" },
  { id: "zoom-out", label: "ズームアウト" },
];

export function LayerPropertyPanel({ layer, onChange }: Props) {
  if (!layer) {
    return (
      <div className="text-[11px] text-gray-400 text-center py-3">
        レイヤーを選択してください
      </div>
    );
  }

  const pickFile = async (kind: "image" | "video") => {
    try {
      const exts =
        kind === "image"
          ? ["png", "jpg", "jpeg", "webp", "bmp"]
          : ["mp4", "mov", "webm", "m4v"];
      const path = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: kind === "image" ? "画像" : "動画", extensions: exts }],
      });
      if (typeof path === "string") onChange({ source: path });
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
    const displayValue = Number.isFinite(value)
      ? Number((value as number).toFixed(precision))
      : 0;
    return (
      <div className="grid grid-cols-[70px_1fr] items-center gap-1 text-[11px]">
        <label className="text-gray-600 dark:text-gray-400">{label}</label>
        <div className="flex items-center gap-1">
          <input
            type="number"
            value={displayValue}
            step={step}
            onChange={(e) => setter(Number(e.target.value))}
            className="flex-1 px-1 py-0.5 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
          />
          {unit && <span className="text-gray-400">{unit}</span>}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-2 text-xs">
      <div className="text-[11px] font-semibold text-gray-700 dark:text-gray-300">
        🛠 プロパティ ({layer.type})
      </div>

      <div className="pt-1 space-y-1 border-b border-gray-200 dark:border-gray-700 pb-2">
        <div className="text-[10px] text-gray-500 font-semibold">タイミング</div>
        {numInput("開始", layer.startSec, (v) => onChange({ startSec: Math.max(0, v) }), 0.1, "s")}
        {numInput("終了", layer.endSec, (v) => onChange({ endSec: Math.max(layer.startSec + 0.1, v) }), 0.1, "s")}
        <div className="grid grid-cols-[70px_1fr] items-center gap-1">
          <label className="text-gray-600">入場</label>
          <select
            value={layer.entryAnimation ?? "none"}
            onChange={(e) => onChange({ entryAnimation: e.target.value as EntryAnimation })}
            className="px-1 py-0.5 text-[10px] rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
          >
            {ENTRY_ANIMATIONS.map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </select>
        </div>
        {layer.entryAnimation && layer.entryAnimation !== "none" &&
          numInput("入場秒", layer.entryDuration ?? 0.3, (v) => onChange({ entryDuration: Math.max(0, v) }), 0.1, "s")}
        <div className="grid grid-cols-[70px_1fr] items-center gap-1">
          <label className="text-gray-600">退場</label>
          <select
            value={layer.exitAnimation ?? "none"}
            onChange={(e) => onChange({ exitAnimation: e.target.value as ExitAnimation })}
            className="px-1 py-0.5 text-[10px] rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
          >
            {EXIT_ANIMATIONS.map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </select>
        </div>
        {layer.exitAnimation && layer.exitAnimation !== "none" &&
          numInput("退場秒", layer.exitDuration ?? 0.3, (v) => onChange({ exitDuration: Math.max(0, v) }), 0.1, "s")}
      </div>

      <div className="space-y-1">
        <div className="text-[10px] text-gray-500 font-semibold">位置・サイズ</div>
        {numInput("X", layer.x, (v) => onChange({ x: v }), 1, "%")}
        {numInput("Y", layer.y, (v) => onChange({ y: v }), 1, "%")}
        {numInput("幅", layer.width, (v) => onChange({ width: v }), 1, "%")}
        {numInput("高さ", layer.height, (v) => onChange({ height: v }), 1, "%")}
        {numInput(
          "回転",
          layer.rotation ?? 0,
          (v) => onChange({ rotation: v }),
          1,
          "°",
        )}
        {numInput(
          "不透明度",
          layer.opacity ?? 1,
          (v) => onChange({ opacity: Math.max(0, Math.min(1, v)) }),
          0.1,
        )}
        {numInput(
          "Z順",
          layer.zIndex,
          (v) => onChange({ zIndex: v }),
          1,
        )}
      </div>
      <p className="text-[10px] text-gray-500 -mt-1">
        Z順: 大きいほど前面に表示
      </p>

      <div className="pt-1 border-t border-gray-200 dark:border-gray-700">
        <label className="block text-[11px] text-gray-600 dark:text-gray-400 mb-0.5">
          形状
        </label>
        <div className="flex gap-1">
          {SHAPES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onChange({ shape: s.id })}
              className={`flex-1 px-1.5 py-1 rounded border text-[10px] ${
                layer.shape === s.id
                  ? "bg-blue-100 dark:bg-blue-900/40 border-blue-500"
                  : "bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        {layer.shape === "rounded" &&
          numInput(
            "角丸 px",
            layer.borderRadius ?? 12,
            (v) => onChange({ borderRadius: v }),
            1,
          )}
      </div>

      <div className="pt-1 border-t border-gray-200 dark:border-gray-700 space-y-1">
        <label className="flex items-center gap-1 text-[11px]">
          <input
            type="checkbox"
            checked={!!layer.border}
            onChange={(e) =>
              onChange({
                border: e.target.checked
                  ? { width: 2, color: "#ffffff" }
                  : undefined,
              })
            }
            className="h-3 w-3"
          />
          枠線
        </label>
        {layer.border && (
          <div className="ml-4 space-y-1">
            {numInput(
              "太さ",
              layer.border.width,
              (v) =>
                onChange({ border: { ...layer.border!, width: Math.max(0, v) } }),
              1,
              "px",
            )}
            <div className="grid grid-cols-[70px_1fr] items-center gap-1 text-[11px]">
              <label className="text-gray-600 dark:text-gray-400">色</label>
              <input
                type="color"
                value={layer.border.color}
                onChange={(e) =>
                  onChange({
                    border: { ...layer.border!, color: e.target.value },
                  })
                }
                className="w-full h-6 rounded border border-gray-300 dark:border-gray-600"
              />
            </div>
          </div>
        )}
      </div>

      {(layer.type === "color" ||
        layer.type === "shape" ||
        layer.type === "comment") && (
        <div className="pt-1 border-t border-gray-200 dark:border-gray-700">
          <div className="grid grid-cols-[70px_1fr] items-center gap-1 text-[11px]">
            <label className="text-gray-600 dark:text-gray-400">塗り色</label>
            <input
              type="color"
              value={
                layer.fillColor?.startsWith("#") ? layer.fillColor : "#333333"
              }
              onChange={(e) => onChange({ fillColor: e.target.value })}
              className="w-full h-6 rounded border border-gray-300 dark:border-gray-600"
            />
          </div>
        </div>
      )}

      {(layer.type === "text" || layer.type === "comment") && (
        <div className="pt-1 border-t border-gray-200 dark:border-gray-700 space-y-1">
          <div>
            <label className="block text-[11px] text-gray-600 dark:text-gray-400 mb-0.5">
              テキスト
            </label>
            <textarea
              value={layer.text ?? ""}
              onChange={(e) => onChange({ text: e.target.value })}
              rows={2}
              className="w-full px-1.5 py-0.5 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 resize-none"
            />
          </div>
          {numInput(
            "文字サイズ",
            layer.fontSize ?? 48,
            (v) => onChange({ fontSize: Math.max(8, v) }),
            1,
            "px",
          )}
          <div className="grid grid-cols-[70px_1fr] items-center gap-1 text-[11px]">
            <label className="text-gray-600 dark:text-gray-400">文字色</label>
            <input
              type="color"
              value={layer.fontColor ?? "#FFFFFF"}
              onChange={(e) => onChange({ fontColor: e.target.value })}
              className="w-full h-6 rounded border border-gray-300 dark:border-gray-600"
            />
          </div>
        </div>
      )}

      {(layer.type === "image" || layer.type === "video") && (
        <div className="pt-1 border-t border-gray-200 dark:border-gray-700 space-y-1">
          <label className="block text-[11px] text-gray-600 dark:text-gray-400 mb-0.5">
            {layer.type === "image" ? "画像ソース" : "動画ソース"}
          </label>
          <div className="flex gap-1">
            {layer.type === "image" && (
              <button
                type="button"
                onClick={() => onChange({ source: "auto" })}
                className={`flex-1 px-1.5 py-1 rounded border text-[10px] ${
                  layer.source === "auto"
                    ? "bg-blue-100 dark:bg-blue-900/40 border-blue-500"
                    : "bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600"
                }`}
              >
                🤖 AI自動
              </button>
            )}
            <button
              type="button"
              onClick={() => pickFile(layer.type as "image" | "video")}
              className="flex-1 px-1.5 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-[10px] hover:bg-blue-50"
            >
              📁 ファイル選択
            </button>
          </div>
          {layer.source &&
            layer.source !== "auto" &&
            layer.source !== "user" && (
              <div className="flex items-center gap-1">
                <p className="text-[10px] text-emerald-600 dark:text-emerald-400 truncate flex-1">
                  ✓ {layer.source.split(/[\\/]/).pop()}
                </p>
                <button
                  type="button"
                  onClick={() =>
                    onChange({
                      source: layer.type === "image" ? "auto" : "user",
                    })
                  }
                  className="text-[10px] text-red-600 hover:underline"
                >
                  解除
                </button>
              </div>
            )}
          {layer.source === "user" && layer.type === "video" && (
            <p className="text-[10px] text-gray-400">ファイルを選択してください</p>
          )}
        </div>
      )}
    </div>
  );
}
