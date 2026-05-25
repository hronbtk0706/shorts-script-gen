import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  importAsset,
  listTemplateAssets,
  deleteTemplateAsset,
  type AssetInfo,
  type AssetKind,
} from "../lib/assetImport";

interface Props {
  templateId: string;
  /** ユーザが素材を選択して「タイムラインに追加」したとき呼ばれる */
  onAdd: (asset: AssetInfo) => void;
}

const KIND_LABELS: Record<AssetKind, { icon: string; label: string }> = {
  images: { icon: "🖼", label: "画像" },
  videos: { icon: "🎬", label: "動画" },
  audio: { icon: "🎵", label: "音声" },
};

const FILTERS: Record<AssetKind, string[]> = {
  images: ["png", "jpg", "jpeg", "webp", "bmp", "gif"],
  videos: ["mp4", "mov", "webm", "m4v"],
  audio: ["mp3", "wav", "m4a", "ogg", "aac", "flac"],
};

export function AssetLibraryPanel({ templateId, onAdd }: Props) {
  const [activeKind, setActiveKind] = useState<AssetKind>("images");
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const refresh = async () => {
    if (!templateId) return;
    setLoading(true);
    try {
      const list = await listTemplateAssets(templateId);
      setAssets(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

  const filtered = assets.filter((a) => a.kind === activeKind);

  const handleImport = async () => {
    setError(null);
    setImporting(true);
    try {
      const path = await openDialog({
        multiple: false,
        directory: false,
        filters: [
          {
            name: KIND_LABELS[activeKind].label,
            extensions: FILTERS[activeKind],
          },
        ],
      });
      if (typeof path !== "string") return;
      await importAsset(templateId, path, activeKind);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async (asset: AssetInfo) => {
    if (!confirm(`素材「${asset.filename}」を削除しますか?（復元不可）`)) return;
    try {
      await deleteTemplateAsset(templateId, asset.kind, asset.filename);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!templateId) {
    return (
      <div className="p-3 text-xs text-gray-500">
        テンプレートを保存すると素材ライブラリが使えます
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full text-xs">
      {/* タブ */}
      <div className="flex gap-1 p-1 border-b border-gray-200 dark:border-gray-700">
        {(Object.keys(KIND_LABELS) as AssetKind[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setActiveKind(k)}
            className={`flex-1 px-2 py-1 rounded ${
              activeKind === k
                ? "bg-blue-600 text-white"
                : "bg-gray-100 dark:bg-gray-800 hover:bg-gray-200"
            }`}
          >
            {KIND_LABELS[k].icon} {KIND_LABELS[k].label}{" "}
            <span className="opacity-60">
              ({assets.filter((a) => a.kind === k).length})
            </span>
          </button>
        ))}
      </div>

      {/* ヘッダ */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-gray-200 dark:border-gray-700">
        <button
          type="button"
          onClick={handleImport}
          disabled={importing}
          className="px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-400 text-white text-[11px]"
        >
          {importing ? "取込中..." : "+ 取り込み"}
        </button>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="px-2 py-0.5 text-[11px] text-blue-600 hover:underline"
        >
          {loading ? "..." : "🔄"}
        </button>
      </div>

      {error && (
        <div className="m-2 p-1.5 rounded bg-red-50 dark:bg-red-900/20 text-[11px] text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* 一覧 */}
      <div className="flex-1 overflow-y-auto p-2">
        {filtered.length === 0 ? (
          <div className="text-center text-gray-400 py-8 text-[11px]">
            この種類の素材はまだありません。
            <br />
            「+ 取り込み」または、レイヤー追加から取り込まれた素材がここに表示されます。
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {filtered.map((a) => (
              <AssetCard
                key={a.path}
                asset={a}
                onAdd={() => onAdd(a)}
                onDelete={() => handleDelete(a)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AssetCard({
  asset,
  onAdd,
  onDelete,
}: {
  asset: AssetInfo;
  onAdd: () => void;
  onDelete: () => void;
}) {
  const url = convertFileSrc(asset.path);
  const sizeMb = (asset.size / (1024 * 1024)).toFixed(2);
  const displayName = asset.filename.replace(/^[a-f0-9]{8}_/, "");
  return (
    <div className="group relative rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
      <button
        type="button"
        onClick={onAdd}
        className="block w-full text-left"
        title={asset.filename}
      >
        <div className="aspect-video bg-gray-100 dark:bg-gray-800 flex items-center justify-center overflow-hidden">
          {asset.kind === "images" && (
            <img
              src={url}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          )}
          {asset.kind === "videos" && (
            <video src={url} className="w-full h-full object-cover" muted />
          )}
          {asset.kind === "audio" && (
            <div className="text-gray-400 text-2xl">🎵</div>
          )}
        </div>
        <div className="px-1.5 py-1 text-[10px]">
          <div className="truncate" title={displayName}>
            {displayName}
          </div>
          <div className="text-gray-400">{sizeMb} MB</div>
        </div>
      </button>

      <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition flex gap-1">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="px-1.5 py-0.5 rounded bg-red-600 hover:bg-red-700 text-white text-[10px]"
          title="素材を削除"
        >
          🗑
        </button>
      </div>
    </div>
  );
}
