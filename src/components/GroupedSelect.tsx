import type { OptionGroup } from "../lib/scriptOptions";

interface Props {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  groups: OptionGroup[];
  placeholderOption?: string;
  className?: string;
}

export function GroupedSelect({
  label,
  value,
  onChange,
  groups,
  placeholderOption = "おまかせ",
  className,
}: Props) {
  return (
    <div>
      {label && <label className="block text-sm font-medium mb-1">{label}</label>}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={
          className ??
          "w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
        }
      >
        <option value="">{placeholderOption}</option>
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.options.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
