interface Props {
  label: string;
  value: number | undefined;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  /** 数値表示用のフォーマッタ */
  format?: (v: number) => string;
}

/**
 * スライダー + 数値入力 のハイブリッド。
 * - スライダーで直感的に操作
 * - 数値 input で正確な指定
 * - min/max が明確な範囲プロパティ用（不透明度 / 回転 / 角丸 etc）
 */
export function SliderInput({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.1,
  unit,
  format,
}: Props) {
  const v = value ?? min;
  const displayed = format ? format(v) : v.toString();
  return (
    <div className="grid grid-cols-[64px_1fr_52px] items-center gap-1">
      <span className="text-[11px] text-gray-600 dark:text-gray-400">
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-blue-600"
      />
      <div className="flex items-center gap-1 justify-end">
        <input
          type="number"
          value={displayed}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isFinite(n)) return;
            onChange(Math.max(min, Math.min(max, n)));
          }}
          className="w-12 px-1 py-0.5 text-[11px] rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-right"
        />
        {unit && (
          <span className="shrink-0 text-[10px] text-gray-500">{unit}</span>
        )}
      </div>
    </div>
  );
}
