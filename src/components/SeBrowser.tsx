import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";

interface SeFile {
  name: string;
  path: string;
  ext: string;
}

interface Props {
  onSelect: (path: string, name: string, durationSec: number) => void;
  seDir?: string;
}

function probeAudioDuration(path: string): Promise<number> {
  const url = convertFileSrc(path);
  return new Promise((resolve) => {
    const a = new Audio();
    a.preload = "metadata";
    a.onloadedmetadata = () =>
      resolve(isFinite(a.duration) && a.duration > 0 ? a.duration : 3);
    a.onerror = () => resolve(3);
    a.src = url;
  });
}

export function SeBrowser({ onSelect, seDir }: Props) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<SeFile[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // ポップアップ外クリックで閉じる
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const load = async () => {
    setLoading(true);
    try {
      const result = await invoke<SeFile[]>("list_se_files", {
        dir: seDir ?? "",
      });
      setFiles(result);
    } catch (e) {
      console.error("[SeBrowser] list_se_files failed:", e);
    } finally {
      setLoading(false);
    }
  };

  const handleOpen = () => {
    if (!open) {
      setOpen(true);
      load();
    } else {
      setOpen(false);
      stopPreview();
    }
  };

  const stopPreview = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setPlaying(null);
  };

  const previewFile = (file: SeFile) => {
    if (playing === file.path) {
      stopPreview();
      return;
    }
    stopPreview();
    const a = new Audio(convertFileSrc(file.path));
    a.volume = 0.5;
    a.onended = () => setPlaying(null);
    a.play().catch(() => {});
    audioRef.current = a;
    setPlaying(file.path);
  };

  const handleSelect = async (file: SeFile) => {
    stopPreview();
    setOpen(false);
    const dur = await probeAudioDuration(file.path);
    onSelect(file.path, file.name, dur);
  };

  const filtered = filter
    ? files.filter((f) =>
        f.name.toLowerCase().includes(filter.toLowerCase()),
      )
    : files;

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={handleOpen}
        className="flex flex-col items-center gap-0.5 px-1 py-1.5 rounded border border-purple-300 dark:border-purple-700 bg-purple-50 dark:bg-purple-900/30 hover:bg-purple-100 dark:hover:bg-purple-800/40 text-[10px] w-full"
        title="SEフォルダから音声を追加"
      >
        <span className="text-base">🔊</span>
        <span>SE</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-64 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl flex flex-col"
          style={{ maxHeight: 360 }}
        >
          <div className="p-2 border-b border-gray-200 dark:border-gray-700 flex items-center gap-1">
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-300 flex-1">
              🔊 SE一覧
            </span>
            <button
              type="button"
              onClick={() => load()}
              className="text-[10px] text-blue-500 hover:underline"
            >
              更新
            </button>
          </div>

          <div className="p-1.5 border-b border-gray-200 dark:border-gray-700">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="絞り込み..."
              className="w-full text-[11px] px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 outline-none"
              autoFocus
            />
          </div>

          <div className="overflow-y-auto flex-1">
            {loading && (
              <div className="text-[11px] text-gray-400 text-center py-4">
                読み込み中...
              </div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="text-[11px] text-gray-400 text-center py-4">
                {files.length === 0
                  ? "C:\\Users\\...\\Documents\\SEが見つかりません"
                  : "該当なし"}
              </div>
            )}
            {filtered.map((file) => (
              <div
                key={file.path}
                className="flex items-center gap-1 px-2 py-1 hover:bg-gray-100 dark:hover:bg-gray-800 group"
              >
                <button
                  type="button"
                  onClick={() => previewFile(file)}
                  className={`p-0.5 rounded text-[11px] flex-shrink-0 ${
                    playing === file.path
                      ? "text-orange-500"
                      : "text-gray-400 hover:text-blue-500"
                  }`}
                  title="プレビュー再生"
                >
                  {playing === file.path ? "⏸" : "▶"}
                </button>
                <button
                  type="button"
                  onClick={() => handleSelect(file)}
                  className="flex-1 text-left text-[11px] text-gray-700 dark:text-gray-300 truncate hover:text-blue-600 dark:hover:text-blue-400"
                  title={file.name}
                >
                  {file.name}
                </button>
                <span className="text-[9px] text-gray-400 uppercase flex-shrink-0">
                  {file.ext}
                </span>
              </div>
            ))}
          </div>

          <div className="p-1.5 border-t border-gray-200 dark:border-gray-700 text-[9px] text-gray-400 text-center">
            Documents\SE ({files.length}件)
          </div>
        </div>
      )}
    </div>
  );
}
