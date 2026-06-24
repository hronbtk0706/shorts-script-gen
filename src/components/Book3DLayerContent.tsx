import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Layer } from "../types";
import { Book3DRenderer } from "../lib/book3dRender";
import { getCompositionCanvasDimensions } from "../lib/layerComposer";

/** 本を 1 frame 描いたら「合成Canvasを撮り直して」と TemplateCanvas に知らせるイベント名。 */
export const BOOK3D_FRAME_EVENT = "book3d-frame";
function notifyFrame() {
  window.dispatchEvent(new Event(BOOK3D_FRAME_EVENT));
}

/**
 * 3D本（book3d）レイヤーのプレビュー描画コンポーネント。
 *
 * - 自前の <canvas> に Three.js（Book3DRenderer）で本を描く
 * - gltfPath があれば glb を読む。無ければ手続き的プレースホルダ本（見開き）
 * - bookCamera（角度）/ pages（中身）/ サイズ変更で 1 frame 再描画（MVP は静止＝アニメ無し）
 *
 * 書き出しは別途オフラインで Book3DRenderer を OffscreenCanvas に回して WebM 焼き（後段）。
 * 同じ Book3DRenderer を使うので「見た目と出力が違う」を避ける。
 */
export function Book3DLayerContent({
  layer,
  currentTimeSec,
  isPlaying,
}: {
  layer: Layer;
  currentTimeSec: number;
  isPlaying: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Book3DRenderer | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const camKey = JSON.stringify(layer.bookCamera ?? {});
  const pagesKey = JSON.stringify(layer.pages ?? []);
  const flipKey = JSON.stringify(layer.bookFlip ?? []);
  const gltfPath = layer.gltfPath;

  // 描画バッファは「出力解像度の箱サイズ」にする。編集プレビューの小さい DOM サイズで描くと
  // 合成（1920px 等）へ拡大されてボケるため。CSS 表示は 100%（DOM 箱）のまま。
  const layerRef = useRef(layer);
  layerRef.current = layer;
  // 描画バッファ寸法。**アスペクト比は実表示の DOM 箱（canvas client）から取る**＝
  // 合成で貼る枠と必ず一致させて歪み（横伸び）を防ぐ。解像度だけ出力箱px相当まで引き上げて
  // ボケ防止。getCompositionCanvasDimensions は「目標解像度」の算出だけに使い、未確定（既定縦）
  // でもアスペクトには影響させない。
  const targetRes = (): { w: number; h: number } => {
    const canvas = canvasRef.current;
    const { width: cw } = getCompositionCanvasDimensions();
    const l = layerRef.current;
    const outW = Math.max(2, (l.width / 100) * cw); // 出力解像度(横)目安
    const clientW = Math.max(1, canvas?.clientWidth || outW);
    const clientH = Math.max(1, canvas?.clientHeight || (outW * 9) / 16);
    const scale = Math.min(4, Math.max(0.5, outW / clientW)); // 解像度引き上げ係数
    const cap = 4096;
    return {
      w: Math.min(cap, Math.round(clientW * scale)),
      h: Math.min(cap, Math.round(clientH * scale)),
    };
  };

  // glb（or プレースホルダ）読込：gltfPath が変わるたびに作り直す
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    setErrorMsg(null);

    // 既存を破棄
    rendererRef.current?.dispose();
    rendererRef.current = null;

    const res = targetRes();

    let renderer: Book3DRenderer;
    try {
      renderer = new Book3DRenderer(canvas, res.w, res.h);
    } catch (e) {
      setErrorMsg("WebGL 初期化に失敗しました");
      console.warn("[book3d] renderer init failed", e);
      return;
    }

    (async () => {
      try {
        await renderer.loadModel(gltfPath, convertFileSrc);
        if (cancelled) {
          renderer.dispose();
          return;
        }
        await renderer.setPages(layer.pages, convertFileSrc);
        if (layer.bookCamera) renderer.setCamera(layer.bookCamera);
        renderer.applyFlip(layer.bookFlip, currentTimeSec);
        renderer.renderFrame();
        rendererRef.current = renderer;
        notifyFrame(); // ロード完了→合成Canvasを撮り直してもらう
      } catch (e) {
        if (!cancelled) {
          setErrorMsg("本の読み込みに失敗しました");
          console.warn("[book3d] load failed", e);
        }
        renderer.dispose();
      }
    })();

    return () => {
      cancelled = true;
      renderer.dispose();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
    // gltfPath だけを依存に（中身/カメラは別 effect で追従）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gltfPath]);

  // カメラ角度の変更 → 反映して 1 frame 再描画＋（停止中は）合成を撮り直す
  useEffect(() => {
    const r = rendererRef.current;
    if (!r || !layer.bookCamera) return;
    r.setCamera(layer.bookCamera);
    r.renderFrame();
    if (!isPlaying) notifyFrame();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camKey]);

  // ページ中身の変更 → 反映して 1 frame 再描画＋（停止中は）合成を撮り直す
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    (async () => {
      await r.setPages(layer.pages, convertFileSrc);
      r.applyFlip(layer.bookFlip, currentTimeSec);
      r.renderFrame();
      if (!isPlaying) notifyFrame();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagesKey]);

  // 時刻変化（再生中は毎フレーム props 更新）→ めくりを反映して再描画。
  // 再生中は前面の合成 rAF が本 canvas を毎フレーム取り込むので notify 不要。
  // 停止/スクラブ中は notify して合成を撮り直す。
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    r.applyFlip(layer.bookFlip, currentTimeSec);
    r.renderFrame();
    if (!isPlaying) notifyFrame();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTimeSec, flipKey]);

  // 箱サイズ変更に追従
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      const r = rendererRef.current;
      if (!r) return;
      const res = targetRes(); // 出力解像度ベース（DOM サイズではない）
      r.resize(res.w, res.h);
      r.renderFrame();
      notifyFrame();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: "100%", display: "block" }}
      />
      {errorMsg && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            background: "rgba(0,0,0,0.4)",
            fontSize: 12,
            textAlign: "center",
            padding: 8,
          }}
        >
          {errorMsg}
        </div>
      )}
    </div>
  );
}
