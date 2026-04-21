import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Layer } from "../types";
import {
  computeLayerAnimStyle,
  computeLayerAmbientStyle,
  computeLayerMotionTransform,
  renderAnimatedText,
} from "./TemplateCanvas";

interface Props {
  layer: Layer | null;
  /** プレビューボックスの幅 (px) */
  widthPx?: number;
  /** プレビューボックスの高さ (px)。未指定なら 9:16 比で算出 */
  heightPx?: number;
}

function resolveSrc(src: string | undefined): string | null {
  if (!src) return null;
  if (src === "auto" || src === "user") return null;
  if (
    src.startsWith("http://") ||
    src.startsWith("https://") ||
    src.startsWith("data:") ||
    src.startsWith("blob:")
  ) {
    return src;
  }
  try {
    return convertFileSrc(src);
  } catch {
    return null;
  }
}

export function LayerPreview({ layer, widthPx = 260, heightPx }: Props) {
  const h = heightPx ?? Math.round((widthPx * 16) / 9);
  const w = widthPx;
  const [isPlaying, setIsPlaying] = useState(true);
  const [localTime, setLocalTime] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  // レイヤーが変わったら時計をリセット
  useEffect(() => {
    setLocalTime(0);
  }, [layer?.id]);

  // requestAnimationFrame でループ再生
  useEffect(() => {
    if (!layer) return;
    if (!isPlaying) return;
    const dur = Math.max(0.1, layer.endSec - layer.startSec);
    let rafId = 0;
    let last = performance.now();
    const tick = (ts: number) => {
      const dt = (ts - last) / 1000;
      last = ts;
      setLocalTime((t) => {
        let next = t + dt;
        if (next >= dur) next = 0; // ループ
        return next;
      });
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, layer?.id, layer?.endSec, layer?.startSec, layer]);

  // video 要素の同期
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (Math.abs(v.currentTime - localTime) > 0.15) {
      try {
        v.currentTime = localTime;
      } catch {
        /* noop */
      }
    }
    if (isPlaying) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, [localTime, isPlaying, layer?.source]);

  // audio 要素（音声レイヤー再生時）
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (isPlaying) {
      a.play().catch(() => {});
    } else {
      a.pause();
    }
  }, [isPlaying, layer?.source]);

  if (!layer) {
    return (
      <div
        className="border border-gray-200 dark:border-gray-700 rounded bg-gray-100 dark:bg-gray-900 flex items-center justify-center text-[11px] text-gray-400"
        style={{ width: w, height: h }}
      >
        レイヤーを選択
      </div>
    );
  }

  // タイムレイヤー期間上の「擬似的な currentTime」＝ startSec + localTime を渡して
  // computeLayerAnimStyle が入場/退場判定できるようにする
  const currentTimeSec = layer.startSec + localTime;

  // 音声レイヤーはビジュアルなし
  if (layer.type === "audio") {
    const resolved = resolveSrc(layer.source);
    return (
      <div
        className="relative border border-gray-200 dark:border-gray-700 rounded bg-gray-800 overflow-hidden"
        style={{ width: w, height: h }}
      >
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white">
          <div className="text-4xl">🎵</div>
          <div className="text-[11px] opacity-75">音声レイヤー</div>
          {layer.text && (
            <div className="text-[10px] opacity-60 px-3 truncate max-w-full">
              {layer.source?.split(/[\\/]/).pop()}
            </div>
          )}
        </div>
        {resolved && (
          <audio ref={audioRef} src={resolved} loop={!!layer.audioLoop} />
        )}
        <PlayButton
          isPlaying={isPlaying}
          onToggle={() => setIsPlaying((p) => !p)}
        />
      </div>
    );
  }

  // 共通計算（TemplateCanvas とほぼ同じロジック）
  const anim = computeLayerAnimStyle(layer, currentTimeSec);
  const ambient = computeLayerAmbientStyle(layer, currentTimeSec);
  const baseOpacity = layer.opacity ?? 1;
  const effectiveOpacity = baseOpacity * anim.opacity * ambient.opacity;
  const motionTransform = computeLayerMotionTransform(layer, currentTimeSec);
  const innerTransformParts: string[] = [];
  if (anim.transform) innerTransformParts.push(anim.transform);
  if (motionTransform) innerTransformParts.push(motionTransform);
  if (ambient.transform) innerTransformParts.push(ambient.transform);
  const innerTransform = innerTransformParts.join(" ");
  const innerFilterParts: string[] = [];
  if (anim.filter) innerFilterParts.push(anim.filter);
  if (ambient.filter) innerFilterParts.push(ambient.filter);
  const innerFilter = innerFilterParts.join(" ");

  let borderRadius: string | number | undefined;
  if (layer.shape === "circle") borderRadius = "50%";
  else if (layer.shape === "rounded") borderRadius = layer.borderRadius ?? 12;

  const leftPx = (layer.x / 100) * w;
  const topPx = (layer.y / 100) * h;
  const widthPx_ = (layer.width / 100) * w;
  const heightPx_ = (layer.height / 100) * h;

  const outerTransform = layer.rotation
    ? `rotate(${layer.rotation}deg)`
    : undefined;

  // テキスト系（comment）は renderAnimatedText 内で border を適用するためここでは省く
  const innerBoxShadow =
    layer.border && layer.type !== "comment"
      ? `inset 0 0 0 ${Math.max(1, layer.border.width * 0.25)}px ${layer.border.color}`
      : undefined;

  const innerStyle: React.CSSProperties = {
    width: "100%",
    height: "100%",
    borderRadius,
    boxShadow: innerBoxShadow,
    transform: innerTransform || undefined,
    transformOrigin: "center center",
    filter: innerFilter || undefined,
  };

  return (
    <div
      className="relative border border-gray-200 dark:border-gray-700 rounded overflow-hidden"
      style={{ width: w, height: h, background: "#111" }}
    >
      <div
        style={{
          position: "absolute",
          left: leftPx,
          top: topPx,
          width: widthPx_,
          height: heightPx_,
          transform: outerTransform,
          opacity: effectiveOpacity !== 1 ? effectiveOpacity : undefined,
          overflow: "hidden",
          borderRadius,
        }}
      >
        <div style={innerStyle}>
          {renderContent(layer, videoRef, isPlaying, currentTimeSec, w)}
        </div>
      </div>
      <PlayButton
        isPlaying={isPlaying}
        onToggle={() => setIsPlaying((p) => !p)}
      />
      <div className="absolute bottom-1 right-1 text-[9px] text-white/70 bg-black/40 rounded px-1">
        {localTime.toFixed(1)} / {(layer.endSec - layer.startSec).toFixed(1)}s
      </div>
    </div>
  );
}

function PlayButton({
  isPlaying,
  onToggle,
}: {
  isPlaying: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="absolute top-1 right-1 w-6 h-6 rounded bg-black/50 hover:bg-black/70 text-white text-[11px] flex items-center justify-center"
      title={isPlaying ? "一時停止" : "再生"}
    >
      {isPlaying ? "⏸" : "▶"}
    </button>
  );
}

function renderContent(
  layer: Layer,
  videoRef: React.RefObject<HTMLVideoElement | null>,
  isPlaying: boolean,
  currentTimeSec: number,
  widthPx: number,
): React.ReactNode {
  const resolved = resolveSrc(layer.source);
  switch (layer.type) {
    case "color":
    case "shape":
      return (
        <div
          style={{
            width: "100%",
            height: "100%",
            background: layer.fillColor ?? "#333",
          }}
        />
      );
    case "image": {
      if (!resolved) {
        return (
          <div
            style={{
              width: "100%",
              height: "100%",
              background:
                "repeating-linear-gradient(45deg, #444, #444 8px, #555 8px, #555 16px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#999",
              fontSize: 9,
            }}
          >
            {layer.source === "auto" ? "🖼 AI画像" : "🖼 画像未設定"}
          </div>
        );
      }
      return (
        <div
          style={{
            width: "100%",
            height: "100%",
            background: `url("${resolved}") center/cover no-repeat`,
          }}
        />
      );
    }
    case "video": {
      if (!resolved) {
        return (
          <div
            style={{
              width: "100%",
              height: "100%",
              background:
                "repeating-linear-gradient(135deg, #222, #222 8px, #333 8px, #333 16px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#999",
              fontSize: 9,
            }}
          >
            🎬 動画未設定
          </div>
        );
      }
      return (
        <video
          ref={videoRef}
          src={resolved}
          muted
          playsInline
          autoPlay={isPlaying}
          loop
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            pointerEvents: "none",
          }}
        />
      );
    }
    case "comment":
      // エクスポートと同じ fontScale = widthPx / 360 で統一
      return renderAnimatedText(layer, currentTimeSec, widthPx / 360);
    default:
      return null;
  }
}
