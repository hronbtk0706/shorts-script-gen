import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import Moveable from "react-moveable";
import type { Layer } from "../types";
import { makeLayer } from "../lib/layerUtils";

/**
 * book3d の kind:"layout" ページ専用のドラッグ編集モーダル。
 *
 * メインエディタ（TemplateBuilder/TemplateCanvas）には一切触れず、ページの layers[] だけを
 * 自前の矩形内に DOM 表示し、react-moveable でドラッグ/リサイズ → %座標（ページ基準）で書き戻す。
 * 本体プレビューは従来どおり合成テクスチャで反映される（onChange→pages 更新→再合成）。
 */
export function PageLayoutEditor({
  width,
  height,
  layers,
  slot,
  onChange,
  onClose,
}: {
  width: number;
  height: number;
  layers: Layer[];
  slot: string;
  onChange: (layers: Layer[]) => void;
  onClose: () => void;
}) {
  const [selId, setSelId] = useState<string | null>(null);
  const elMap = useRef<Map<string, HTMLElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  // プレビュー矩形をページのアスペクト比で収める
  const maxH = 520;
  const maxW = 560;
  const ar = width / height;
  let pw = maxH * ar;
  let ph = maxH;
  if (pw > maxW) {
    pw = maxW;
    ph = maxW / ar;
  }

  const sel = layers.find((l) => l.id === selId) ?? null;
  const update = (id: string, patch: Partial<Layer>) =>
    onChange(layers.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  // Backspace/Delete は「選択中のページ内レイヤー」を消す（メイン側へは伝播させない）。
  // Escape で閉じる。入力欄にフォーカス中は素通り（文字削除のため）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable);
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if ((e.key === "Backspace" || e.key === "Delete") && !inField && selId) {
        e.preventDefault();
        e.stopPropagation();
        onChange(layers.filter((l) => l.id !== selId));
        setSelId(null);
      }
    };
    // capture phase でメインの window ハンドラより先に握り、確実に止める
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [layers, selId, onChange, onClose]);
  const pctW = (px: number) => (px / pw) * 100;
  const pctH = (px: number) => (px / ph) * 100;

  const addLayer = (type: "image" | "comment") => {
    const nl = makeLayer({ type, x: 12, y: 12, width: 50, height: 24 }, layers.length);
    onChange([...layers, nl]);
    setSelId(nl.id);
  };
  const pickImage = async () => {
    if (!sel) return;
    const s = await openDialog({
      multiple: false,
      filters: [{ name: "画像", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    if (typeof s === "string") update(sel.id, { source: s });
  };

  const resolveImg = (src?: string): string | undefined => {
    if (!src || src === "auto" || src === "user") return undefined;
    if (/^(https?:|data:|blob:)/.test(src)) return src;
    return convertFileSrc(src);
  };

  return (
    <div
      data-page-layout-editor
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10050,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
      }}
      onMouseDown={(e) => {
        // 背景（オーバーレイそのもの）クリックでだけ閉じる。中身の操作では閉じない。
        if (e.target === e.currentTarget) onClose();
      }}
    >
     <div
       style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}
       onMouseDown={(e) => e.stopPropagation()}
     >
      {/* ツールバー */}
      <div
        className="flex items-center gap-2 text-[12px] text-white"
        style={{ background: "#1b1f27", padding: "6px 10px", borderRadius: 8 }}
      >
        <span className="font-bold">ページ編集: {slot}</span>
        <button onClick={() => addLayer("image")} className="px-2 py-1 rounded bg-blue-600">
          ＋画像
        </button>
        <button onClick={() => addLayer("comment")} className="px-2 py-1 rounded bg-blue-600">
          ＋テキスト
        </button>
        {sel && (
          <button
            onClick={() => {
              onChange(layers.filter((l) => l.id !== sel.id));
              setSelId(null);
            }}
            className="px-2 py-1 rounded bg-red-500"
          >
            削除
          </button>
        )}
        <button onClick={onClose} className="px-2 py-1 rounded bg-gray-600 ml-2">
          本に戻る
        </button>
      </div>

      {/* 選択中レイヤーの簡易プロパティ */}
      {sel && (
        <div
          className="flex items-center gap-2 text-[11px] text-white"
          style={{ background: "#1b1f27", padding: "4px 10px", borderRadius: 8 }}
        >
          {sel.type === "comment" ? (
            <>
              <input
                type="text"
                value={sel.text ?? ""}
                placeholder="テキスト"
                onChange={(e) => update(sel.id, { text: e.target.value })}
                className="px-1 py-0.5 rounded text-black"
                style={{ width: 220 }}
              />
              <label className="flex items-center gap-1">
                字
                <input
                  type="number"
                  value={Math.round(sel.fontSize ?? 16)}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) update(sel.id, { fontSize: n });
                  }}
                  className="w-12 px-1 py-0.5 rounded text-black text-right"
                />
              </label>
              <input
                type="color"
                value={sel.fontColor ?? "#222222"}
                onChange={(e) => update(sel.id, { fontColor: e.target.value })}
                title="文字色"
              />
            </>
          ) : sel.type === "image" ? (
            <button onClick={pickImage} className="px-2 py-1 rounded bg-blue-600">
              画像選択
            </button>
          ) : null}
        </div>
      )}

      {/* ページ矩形 */}
      <div
        ref={containerRef}
        style={{
          position: "relative",
          width: pw,
          height: ph,
          background: "#f7f3ea",
          boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
          overflow: "hidden",
        }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setSelId(null);
        }}
      >
        {layers.map((l) => {
          const left = (l.x / 100) * pw;
          const top = (l.y / 100) * ph;
          const w = (l.width / 100) * pw;
          const h = (l.height / 100) * ph;
          const isSel = l.id === selId;
          return (
            <div
              key={l.id}
              ref={(el) => {
                if (el) elMap.current.set(l.id, el);
              }}
              data-pl-id={l.id}
              onMouseDown={(e) => {
                e.stopPropagation();
                setSelId(l.id);
              }}
              style={{
                position: "absolute",
                left,
                top,
                width: w,
                height: h,
                outline: isSel
                  ? "2px solid #3b82f6"
                  : "1px dashed rgba(0,0,0,0.25)",
                overflow: "hidden",
                cursor: "move",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background:
                  l.type === "color" || l.type === "shape"
                    ? l.fillColor ?? "#cccccc"
                    : "transparent",
              }}
            >
              {l.type === "image" &&
                (resolveImg(l.source) ? (
                  <img
                    src={resolveImg(l.source)}
                    alt=""
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                ) : (
                  <span style={{ fontSize: 11, color: "#888" }}>画像未選択</span>
                ))}
              {l.type === "comment" && (
                <span
                  style={{
                    color: l.fontColor ?? "#222",
                    fontSize: Math.max(8, (l.fontSize ?? 16) * (pw / 360)),
                    fontWeight: "bold",
                    textAlign: "center",
                    whiteSpace: "pre-wrap",
                    lineHeight: 1.2,
                    padding: 2,
                  }}
                >
                  {l.text ?? ""}
                </span>
              )}
            </div>
          );
        })}

        {sel && elMap.current.get(sel.id) && (
          <Moveable
            key={`pl_${sel.id}_${sel.x.toFixed(2)}_${sel.y.toFixed(2)}_${sel.width.toFixed(2)}_${sel.height.toFixed(2)}`}
            target={elMap.current.get(sel.id)}
            draggable
            resizable
            origin={false}
            throttleDrag={0}
            throttleResize={0}
            onDrag={(e) => {
              e.target.style.transform = e.transform;
            }}
            onDragEnd={(e) => {
              const dx = e.lastEvent?.translate?.[0] ?? 0;
              const dy = e.lastEvent?.translate?.[1] ?? 0;
              (e.target as HTMLElement).style.transform = "";
              update(sel.id, {
                x: pctW((sel.x / 100) * pw + dx),
                y: pctH((sel.y / 100) * ph + dy),
              });
            }}
            onResize={(e) => {
              e.target.style.width = `${e.width}px`;
              e.target.style.height = `${e.height}px`;
              e.target.style.transform = e.drag.transform;
            }}
            onResizeEnd={(e) => {
              const el = e.target as HTMLElement;
              const wpx = parseFloat(el.style.width);
              const hpx = parseFloat(el.style.height);
              const dx = e.lastEvent?.drag?.translate?.[0] ?? 0;
              const dy = e.lastEvent?.drag?.translate?.[1] ?? 0;
              el.style.transform = "";
              update(sel.id, {
                x: pctW((sel.x / 100) * pw + dx),
                y: pctH((sel.y / 100) * ph + dy),
                width: pctW(wpx),
                height: pctH(hpx),
              });
            }}
          />
        )}
      </div>
      <div className="text-[10px] text-gray-300">
        ドラッグで移動 / ハンドルでリサイズ。閉じると本に反映されます。
      </div>
     </div>
    </div>
  );
}
