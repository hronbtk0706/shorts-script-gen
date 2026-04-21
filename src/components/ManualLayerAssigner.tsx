import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { ExtractedComment, Layer, VideoTemplate } from "../types";
import { ImageFitEditor, type LayerGeometry } from "./ImageFitEditor";

interface Props {
  template: VideoTemplate;
  availableComments: ExtractedComment[];
  commentAssignments: Record<string, ExtractedComment | null>;
  sourceAssignments: Record<string, string>;
  textAssignments: Record<string, string>;
  geometryAssignments: Record<string, LayerGeometry>;
  onCommentAssign: (layerId: string, comment: ExtractedComment | null) => void;
  onSourceAssign: (layerId: string, source: string) => void;
  onTextAssign: (layerId: string, text: string) => void;
  onGeometryAssign: (layerId: string, geometry: LayerGeometry | null) => void;
}

const TYPE_ICON: Record<string, string> = {
  image: "🖼",
  video: "🎬",
  text: "📝",
  comment: "💬",
  color: "🎨",
  shape: "⬜",
};

function layerLabel(layer: Layer, i: number): string {
  const t = layer.type;
  const timeRange = `${layer.startSec.toFixed(1)}–${layer.endSec.toFixed(1)}s`;
  return `${TYPE_ICON[t] ?? "◼"} ${t}#${i + 1} ${timeRange}`;
}

export function ManualLayerAssigner({
  template,
  availableComments,
  commentAssignments,
  sourceAssignments,
  textAssignments,
  geometryAssignments,
  onCommentAssign,
  onSourceAssign,
  onTextAssign,
  onGeometryAssign,
}: Props) {
  // 割り当て対象になるレイヤーのみ（color/shape は除外）
  const assignableLayers = template.layers.filter((l) =>
    ["image", "video", "comment"].includes(l.type),
  );

  const [editorLayer, setEditorLayer] = useState<Layer | null>(null);

  const pickFile = async (layer: Layer) => {
    const kind = layer.type === "image" ? "image" : "video";
    const exts =
      kind === "image"
        ? ["png", "jpg", "jpeg", "webp", "bmp"]
        : ["mp4", "mov", "webm", "m4v"];
    try {
      const path = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: kind, extensions: exts }],
      });
      if (typeof path === "string") {
        onSourceAssign(layer.id, path);
        // 画像（or 動画）を選んだ直後にフィット調整モーダルを自動で開く
        if (layer.type === "image") {
          setEditorLayer(layer);
        }
      }
    } catch (e) {
      console.warn("[ManualLayerAssigner] pickFile failed", e);
    }
  };

  const currentGeom = (l: Layer): LayerGeometry =>
    geometryAssignments[l.id] ?? {
      x: l.x,
      y: l.y,
      width: l.width,
      height: l.height,
    };

  if (assignableLayers.length === 0) {
    return (
      <div className="text-xs text-gray-500">
        このテンプレには割り当て対象のレイヤー（画像/動画/テキスト/コメント枠）がありません。
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-gray-700 dark:text-gray-300">
        レイヤーごとの割り当て（{assignableLayers.length}）
      </div>
      {assignableLayers.map((layer, i) => {
        const commentSelected = commentAssignments[layer.id] ?? null;
        const source = sourceAssignments[layer.id] ?? "";
        const text = textAssignments[layer.id] ?? "";
        return (
          <div
            key={layer.id}
            className="p-2 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/50 space-y-1"
          >
            <div className="text-[11px] font-medium text-gray-600 dark:text-gray-400">
              {layerLabel(layer, i)}
              {layer.text && (
                <span className="ml-2 text-gray-400 text-[10px]">
                  初期: {layer.text.slice(0, 18)}
                  {layer.text.length > 18 ? "…" : ""}
                </span>
              )}
            </div>

            {layer.type === "comment" && (
              <div className="space-y-1">
                {availableComments.length === 0 ? (
                  <p className="text-[10px] text-amber-600">
                    上でコメントをチェックすると選べます
                  </p>
                ) : (
                  <select
                    value={commentSelected?.id ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (!v) {
                        onCommentAssign(layer.id, null);
                        onTextAssign(layer.id, "");
                      } else {
                        const c = availableComments.find((x) => x.id === v);
                        onCommentAssign(layer.id, c ?? null);
                        // 選んだコメントの本文を編集用テキストボックスに転写
                        if (c) onTextAssign(layer.id, c.text);
                      }
                    }}
                    className="w-full px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
                  >
                    <option value="">— 未設定（テンプレ既定を使用）—</option>
                    {availableComments.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.isReply ? "↪ " : ""}
                        {c.author ? `@${c.author}: ` : ""}
                        {c.text.length > 50 ? c.text.slice(0, 50) + "…" : c.text}
                      </option>
                    ))}
                  </select>
                )}
                <textarea
                  value={text}
                  onChange={(e) => onTextAssign(layer.id, e.target.value)}
                  placeholder={
                    commentSelected
                      ? "コメント本文（編集可能）"
                      : "直接入力もOK（空欄ならテンプレ既定を使用）"
                  }
                  rows={2}
                  className="w-full px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 resize-none"
                />
              </div>
            )}

            {(layer.type === "image" || layer.type === "video") && (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => pickFile(layer)}
                    className="px-2 py-1 text-[11px] rounded border border-gray-300 dark:border-gray-600 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                  >
                    📁 ファイル選択
                  </button>
                  {source ? (
                    <>
                      <span className="text-[10px] text-emerald-600 truncate flex-1">
                        ✓ {source.split(/[\\/]/).pop()}
                      </span>
                      <button
                        type="button"
                        onClick={() => onSourceAssign(layer.id, "")}
                        className="text-[10px] text-red-600 hover:underline"
                      >
                        解除
                      </button>
                    </>
                  ) : (
                    <span className="text-[10px] text-gray-400">
                      テンプレ既定（{layer.source ?? "auto"}）を使用
                    </span>
                  )}
                </div>
                {source && layer.type === "image" && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setEditorLayer(layer)}
                      className="px-2 py-0.5 text-[10px] rounded border border-blue-300 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                    >
                      🎚 フィット調整
                    </button>
                    {geometryAssignments[layer.id] && (
                      <>
                        <span className="text-[10px] text-amber-600">
                          📐 サイズ上書き済み
                        </span>
                        <button
                          type="button"
                          onClick={() => onGeometryAssign(layer.id, null)}
                          className="text-[10px] text-red-600 hover:underline"
                        >
                          リセット
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {null /* 旧 text type は廃止。comment に統合 */}
          </div>
        );
      })}
      {editorLayer && sourceAssignments[editorLayer.id] && (
        <ImageFitEditor
          imagePath={sourceAssignments[editorLayer.id]}
          initialGeometry={currentGeom(editorLayer)}
          onSave={(g) => {
            onGeometryAssign(editorLayer.id, g);
            setEditorLayer(null);
          }}
          onCancel={() => setEditorLayer(null)}
        />
      )}
    </div>
  );
}
