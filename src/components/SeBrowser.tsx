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

  // モーダル開いてる時に Esc で閉じる
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        stopPreview();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <>
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
        <div
          className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-6"
          onClick={() => {
            setOpen(false);
            stopPreview();
          }}
        >
          <div
            className="w-full max-w-2xl max-h-[85vh] bg-white dark:bg-gray-900 rounded-lg shadow-xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <span className="text-sm font-bold flex-1">🔊 SE 選択</span>
              <button
                type="button"
                onClick={() => load()}
                className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800"
                title="一覧を再読み込み"
              >
                🔄 更新
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  stopPreview();
                }}
                className="text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 text-lg leading-none px-1"
                title="閉じる"
              >
                ✕
              </button>
            </div>

            <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-700">
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="ファイル名で絞り込み..."
                className="w-full text-sm px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 outline-none"
                autoFocus
              />
            </div>

            <div className="flex-1 overflow-y-auto">
              {loading && (
                <div className="text-xs text-gray-400 text-center py-8">
                  読み込み中...
                </div>
              )}
              {!loading && filtered.length === 0 && (
                <div className="text-xs text-gray-400 text-center py-8">
                  {files.length === 0
                    ? "Documents\\SE フォルダにファイルが見つかりません"
                    : "該当なし"}
                </div>
              )}
              {filtered.map((file) => (
                <div
                  key={file.path}
                  className="flex items-center gap-2 px-3 py-1.5 hover:bg-blue-50 dark:hover:bg-blue-900/20 border-b border-gray-100 dark:border-gray-800"
                >
                  <button
                    type="button"
                    onClick={() => previewFile(file)}
                    className={`shrink-0 w-7 h-7 rounded text-sm flex items-center justify-center ${
                      playing === file.path
                        ? "bg-orange-500 text-white"
                        : "bg-gray-100 dark:bg-gray-800 text-gray-500 hover:bg-blue-500 hover:text-white"
                    }`}
                    title="プレビュー再生"
                  >
                    {playing === file.path ? "⏸" : "▶"}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSelect(file)}
                    className="flex-1 text-left text-sm text-gray-700 dark:text-gray-300 truncate hover:text-blue-600 dark:hover:text-blue-400"
                    title={file.name}
                  >
                    {file.name}
                  </button>
                  <span className="text-[10px] text-gray-400 uppercase shrink-0">
                    {file.ext}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleSelect(file)}
                    className="shrink-0 px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-xs"
                  >
                    使用
                  </button>
                </div>
              ))}
            </div>

            <div className="px-4 py-2 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-400 text-center">
              Documents\SE ({files.length} 件)・▶ で試聴・「使用」 or ファイル名クリックで追加
            </div>
          </div>
        </div>
      )}
    </>
  );
}
