import { useEffect, useRef, useState } from "react";
import Moveable from "react-moveable";
import { convertFileSrc } from "@tauri-apps/api/core";

export interface LayerGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Props {
  imagePath: string;
  initialGeometry: LayerGeometry;
  onSave: (g: LayerGeometry) => void;
  onCancel: () => void;
}

const PREVIEW_W = 270;
const PREVIEW_H = 480; // 9:16

const clamp = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, v));

export function ImageFitEditor({
  imagePath,
  initialGeometry,
  onSave,
  onCancel,
}: Props) {
  const [g, setG] = useState<LayerGeometry>(initialGeometry);
  const [imgNatural, setImgNatural] = useState({ w: 0, h: 0 });
  const frameRef = useRef<HTMLDivElement>(null);
  const [frameReady, setFrameReady] = useState(false);

  const src = imagePath.startsWith("blob:")
    ? imagePath
    : convertFileSrc(imagePath);

  useEffect(() => {
    const img = new Image();
    img.onload = () =>
      setImgNatural({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = src;
  }, [src]);

  useEffect(() => {
    // Moveable が target を見つけられるよう、frame マウント直後に再描画
    const t = setTimeout(() => setFrameReady(true), 0);
    return () => clearTimeout(t);
  }, []);

  const frameLeft = (g.x / 100) * PREVIEW_W;
  const frameTop = (g.y / 100) * PREVIEW_H;
  const frameW = (g.width / 100) * PREVIEW_W;
  const frameH = (g.height / 100) * PREVIEW_H;

  // cover 計算: 画像のアスペクトを保ったまま、フレームを完全に覆う最小倍率
  const coverScale =
    imgNatural.w > 0 && imgNatural.h > 0
      ? Math.max(frameW / imgNatural.w, frameH / imgNatural.h)
      : 1;
  const scaledImgW = imgNatural.w * coverScale;
  const scaledImgH = imgNatural.h * coverScale;
  const imgOffsetX = (frameW - scaledImgW) / 2;
  const imgOffsetY = (frameH - scaledImgH) / 2;

  return (
    <div className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-900 rounded-lg p-4 shadow-xl max-w-2xl w-full space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">
            🖼 画像フィット調整（枠をドラッグ/リサイズ）
          </div>
          <div className="text-[11px] text-gray-500">
            X:{g.x.toFixed(1)}% Y:{g.y.toFixed(1)}% W:{g.width.toFixed(1)}%
            H:{g.height.toFixed(1)}%
          </div>
        </div>

        <div className="flex gap-4 items-start">
          {/* プレビュー領域 */}
          <div
            className="relative bg-black rounded overflow-hidden shrink-0"
            style={{ width: PREVIEW_W, height: PREVIEW_H }}
          >
            {/* カットされる外側を薄く表示 */}
            <img
              src={src}
              alt=""
              className="absolute pointer-events-none opacity-20"
              style={{
                left: 0,
                top: 0,
                width: PREVIEW_W,
                height: PREVIEW_H,
                objectFit: "contain",
              }}
            />
            {/* レイヤー枠（cover された画像が入る） */}
            <div
              ref={frameRef}
              className="absolute overflow-hidden border-2 border-blue-500"
              style={{
                left: frameLeft,
                top: frameTop,
                width: frameW,
                height: frameH,
              }}
            >
              <img
                src={src}
                alt=""
                className="absolute pointer-events-none select-none"
                style={{
                  left: imgOffsetX,
                  top: imgOffsetY,
                  width: scaledImgW,
                  height: scaledImgH,
                  maxWidth: "none",
                }}
              />
            </div>
            {frameReady && frameRef.current && (
              <Moveable
                key={`mv_${g.x.toFixed(2)}_${g.y.toFixed(2)}_${g.width.toFixed(2)}_${g.height.toFixed(2)}`}
                target={frameRef.current}
                draggable
                resizable
                origin={false}
                keepRatio={false}
                throttleDrag={0}
                throttleResize={0}
                snappable
                snapThreshold={8}
                verticalGuidelines={[0, PREVIEW_W / 2, PREVIEW_W]}
                horizontalGuidelines={[0, PREVIEW_H / 2, PREVIEW_H]}
                onDrag={(e) => {
                  e.target.style.transform = e.transform;
                }}
                onDragEnd={(e) => {
                  const el = e.target as HTMLElement;
                  const dx = e.lastEvent?.translate?.[0] ?? 0;
                  const dy = e.lastEvent?.translate?.[1] ?? 0;
                  const newLeft = frameLeft + dx;
                  const newTop = frameTop + dy;
                  el.style.transform = "";
                  setG((prev) => ({
                    ...prev,
                    x: clamp((newLeft / PREVIEW_W) * 100, 0, 100 - prev.width),
                    y: clamp(
                      (newTop / PREVIEW_H) * 100,
                      0,
                      100 - prev.height,
                    ),
                  }));
                }}
                onResize={(e) => {
                  e.target.style.width = `${e.width}px`;
                  e.target.style.height = `${e.height}px`;
                  e.target.style.transform = e.drag.transform;
                }}
                onResizeEnd={(e) => {
                  const el = e.target as HTMLElement;
                  const newWPx = parseFloat(el.style.width);
                  const newHPx = parseFloat(el.style.height);
                  const dx = e.lastEvent?.drag?.translate?.[0] ?? 0;
                  const dy = e.lastEvent?.drag?.translate?.[1] ?? 0;
                  const newLeft = frameLeft + dx;
                  const newTop = frameTop + dy;
                  el.style.transform = "";
                  el.style.width = "";
                  el.style.height = "";
                  setG(() => {
                    const width = clamp((newWPx / PREVIEW_W) * 100, 1, 100);
                    const height = clamp((newHPx / PREVIEW_H) * 100, 1, 100);
                    const x = clamp((newLeft / PREVIEW_W) * 100, 0, 100 - width);
                    const y = clamp(
                      (newTop / PREVIEW_H) * 100,
                      0,
                      100 - height,
                    );
                    return { x, y, width, height };
                  });
                }}
              />
            )}
          </div>

          {/* 右側: 操作説明 + 数値入力 */}
          <div className="flex-1 space-y-3 text-xs">
            <div className="space-y-1">
              <div className="text-gray-600 dark:text-gray-400 font-medium">
                操作
              </div>
              <ul className="text-gray-500 space-y-0.5 list-disc pl-4">
                <li>枠の中央: ドラッグで移動</li>
                <li>角/辺: ドラッグでリサイズ</li>
                <li>薄く見える外側: カット対象（最終動画には出ない）</li>
              </ul>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(["x", "y", "width", "height"] as const).map((k) => (
                <label key={k} className="flex flex-col gap-0.5">
                  <span className="text-[10px] text-gray-500 uppercase">
                    {k}
                  </span>
                  <input
                    type="number"
                    step={1}
                    min={0}
                    max={100}
                    value={Number(g[k].toFixed(1))}
                    onChange={(e) => {
                      const v = clamp(Number(e.target.value) || 0, 0, 100);
                      setG((prev) => ({ ...prev, [k]: v }));
                    }}
                    className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
                  />
                </label>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setG(initialGeometry)}
              className="text-[11px] text-blue-600 hover:underline"
            >
              ↺ テンプレの初期値に戻す
            </button>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-gray-200 dark:border-gray-800">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-sm"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={() => onSave(g)}
            className="px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white text-sm"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
