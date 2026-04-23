import { useEffect, useRef, useState } from "react";
import { drawWaveform, loadWaveformPeaks } from "../lib/audioWaveform";

interface Props {
  source: string;
  widthPx: number;
  heightPx: number;
  color?: string;
}

/**
 * タイムラインの audio レイヤーバー内に配置する波形描画用 canvas。
 * - layer.source ごとに peaks をキャッシュ
 * - canvas サイズ変化時は再描画
 */
export function WaveformCanvas({ source, widthPx, heightPx, color }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPeaks(null);
    loadWaveformPeaks(source)
      .then((p) => {
        if (!cancelled) setPeaks(p);
      })
      .catch((e) => {
        if (!cancelled) {
          console.warn("[WaveformCanvas] load failed:", e);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  useEffect(() => {
    if (!peaks || !canvasRef.current) return;
    drawWaveform(canvasRef.current, peaks, color);
  }, [peaks, widthPx, heightPx, color]);

  if (widthPx < 4 || heightPx < 4) return null;
  return (
    <canvas
      ref={canvasRef}
      width={Math.max(1, Math.floor(widthPx))}
      height={Math.max(1, Math.floor(heightPx))}
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
      }}
    />
  );
}
