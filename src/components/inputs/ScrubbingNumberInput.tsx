import { useRef, useState } from "react";

interface Props {
  label: string;
  value: number | undefined;
  onChange: (v: number) => void;
  /** 1 ドラッグピクセルあたりの値変化量 */
  step?: number;
  unit?: string;
  min?: number;
  max?: number;
  /** 表示用フォーマッタ（例: 小数点下の桁数制御） */
  format?: (v: number) => string;
}

/**
 * AE / Photoshop 風のドラッグで値が変わる数値入力。
 * - ラベル部分を左右ドラッグ → 値が連続的に変化
 * - Shift で粗く (×10)、Alt で細かく (×0.1)
 * - 数値 input 部分はクリックして直接入力も可能
 */
export function ScrubbingNumberInput({
  label,
  value,
  onChange,
  step = 1,
  unit,
  min,
  max,
  format,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef<{ x: number; v: number } | null>(null);

  const clamp = (v: number) => {
    let r = v;
    if (min !== undefined) r = Math.max(min, r);
    if (max !== undefined) r = Math.min(max, r);
    return r;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (value === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    startRef.current = { x: e.clientX, v: value };
    setDragging(true);
    (e.currentTarget as HTMLSpanElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (!dragging || !startRef.current) return;
    const dx = e.clientX - startRef.current.x;
    const factor = e.shiftKey ? step * 10 : e.altKey ? step * 0.1 : step;
    const next = clamp(startRef.current.v + dx * factor);
    onChange(next);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLSpanElement>) => {
    setDragging(false);
    startRef.current = null;
    try {
      (e.currentTarget as HTMLSpanElement).releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  };

  const displayed =
    value === undefined ? "" : format ? format(value) : String(value);

  return (
    <div className="grid grid-cols-[64px_1fr] items-center gap-1">
      <span
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={`select-none text-[11px] ${
          dragging
            ? "text-blue-600 font-semibold"
            : "text-gray-600 dark:text-gray-400 hover:text-blue-600"
        }`}
        style={{ cursor: dragging ? "ew-resize" : "ew-resize" }}
        title="左右ドラッグで値を変更 / Shift 大・Alt 小"
      >
        {label}
      </span>
      <div className="flex items-center gap-1">
        <input
          type="number"
          value={displayed}
          step={step}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") return;
            const v = Number(raw);
            if (!Number.isFinite(v)) return;
            onChange(clamp(v));
          }}
          className="flex-1 min-w-0 px-1.5 py-0.5 text-[11px] rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
        />
        {unit && (
          <span className="shrink-0 text-[10px] text-gray-500">{unit}</span>
        )}
      </div>
    </div>
  );
}
