import { useRef, useState } from "react";
import {
  generateAndSavePatternVideo,
  snapDirectionFromAngle,
  type ComicBurstParams,
  type PatternKind,
  type PatternParams,
  type PolkaDotsScrollParams,
} from "../lib/patternGenerator";
import { ColorSwatches, recordColorUsed } from "./ColorSwatches";

interface Props {
  open: boolean;
  templateId: string;
  /** 出力解像度（テンプレのアスペクトに合わせる）。未指定なら縦 1080×1920 */
  canvasWidth?: number;
  canvasHeight?: number;
  /** 生成後、この絶対パス + 尺で動画レイヤーを追加してもらうコールバック */
  onGenerated: (videoPath: string, durationSec: number) => void;
  onClose: () => void;
}

// ============================================================================
// プリセット
// ============================================================================
const POLKA_PRESETS: Array<{
  label: string;
  params: Omit<PolkaDotsScrollParams, "width" | "height" | "fps" | "kind">;
}> = [
  {
    label: "水色×白ドット（標準）",
    params: {
      bgColor: "#5cc6ee",
      dotColor: "#ffffff",
      tileSize: 160,
      dotRadius: 36,
      scrollAngleDeg: 45,
      scrollSpeed: 80,
    },
  },
  {
    label: "ピンク×白ドット（早め）",
    params: {
      bgColor: "#ff8fb1",
      dotColor: "#ffffff",
      tileSize: 140,
      dotRadius: 30,
      scrollAngleDeg: 45,
      scrollSpeed: 120,
    },
  },
  {
    label: "黒×黄ドット（注意系）",
    params: {
      bgColor: "#0e0e10",
      dotColor: "#ffe600",
      tileSize: 200,
      dotRadius: 28,
      scrollAngleDeg: 30,
      scrollSpeed: 100,
    },
  },
];

const BURST_PRESETS: Array<{
  label: string;
  params: Omit<ComicBurstParams, "width" | "height" | "fps" | "kind">;
}> = [
  {
    label: "黄×白（POW!）",
    params: {
      outerColor: "#ffffff",
      burstColor: "#ffe600",
      spikeCount: 16,
      spikeLength: 1300,
      innerRadius: 420,
      spikeVariation: 0.18,
      centerOffsetX: 0,
      centerOffsetY: 0,
      animation: "pulse",
      loopDuration: 1.5,
    },
  },
  {
    label: "赤×黄（BAM! 回転）",
    params: {
      outerColor: "#ff3838",
      burstColor: "#ffe600",
      spikeCount: 20,
      spikeLength: 1400,
      innerRadius: 380,
      spikeVariation: 0.25,
      centerOffsetX: 0,
      centerOffsetY: 0,
      animation: "rotate",
      loopDuration: 12,
    },
  },
  {
    label: "白×黒（モノ・静止）",
    params: {
      outerColor: "#ffffff",
      burstColor: "#0e0e10",
      spikeCount: 24,
      spikeLength: 1300,
      innerRadius: 360,
      spikeVariation: 0.15,
      centerOffsetX: 0,
      centerOffsetY: 0,
      animation: "none",
      loopDuration: 1,
    },
  },
];

// ============================================================================
// コンポーネント
// ============================================================================
export function PatternBackgroundModal({
  open,
  templateId,
  canvasWidth = 1080,
  canvasHeight = 1920,
  onGenerated,
  onClose,
}: Props) {
  const [kind, setKind] = useState<PatternKind>("polka-dots-scroll");

  // ---- 水玉スクロール状態 ----
  const [bgColor, setBgColor] = useState("#5cc6ee");
  const [dotColor, setDotColor] = useState("#ffffff");
  const [tileSize, setTileSize] = useState(160);
  const [dotRadius, setDotRadius] = useState(36);
  const [scrollAngleDeg, setScrollAngleDeg] = useState(45);
  const [scrollSpeed, setScrollSpeed] = useState(80);

  // ---- バースト状態 ----
  const [outerColor, setOuterColor] = useState("#ffffff");
  const [burstColor, setBurstColor] = useState("#ffe600");
  const [spikeCount, setSpikeCount] = useState(16);
  const [spikeLength, setSpikeLength] = useState(1300);
  const [innerRadius, setInnerRadius] = useState(420);
  const [spikeVariation, setSpikeVariation] = useState(0.18);
  const [centerOffsetX, setCenterOffsetX] = useState(0);
  const [centerOffsetY, setCenterOffsetY] = useState(0);
  const [burstAnimation, setBurstAnimation] = useState<
    "none" | "pulse" | "rotate"
  >("pulse");
  const [burstLoopDur, setBurstLoopDur] = useState(1.5);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  // ---- プリセット適用 ----
  const applyPolkaPreset = (p: (typeof POLKA_PRESETS)[number]) => {
    setBgColor(p.params.bgColor);
    setDotColor(p.params.dotColor);
    setTileSize(p.params.tileSize);
    setDotRadius(p.params.dotRadius);
    setScrollAngleDeg(p.params.scrollAngleDeg);
    setScrollSpeed(p.params.scrollSpeed);
  };
  const applyBurstPreset = (p: (typeof BURST_PRESETS)[number]) => {
    setOuterColor(p.params.outerColor);
    setBurstColor(p.params.burstColor);
    setSpikeCount(p.params.spikeCount);
    setSpikeLength(p.params.spikeLength);
    setInnerRadius(p.params.innerRadius);
    setSpikeVariation(p.params.spikeVariation);
    setCenterOffsetX(p.params.centerOffsetX);
    setCenterOffsetY(p.params.centerOffsetY);
    setBurstAnimation(p.params.animation);
    setBurstLoopDur(p.params.loopDuration);
  };

  // ---- 生成 ----
  const handleGenerate = async () => {
    setError(null);
    setBusy(true);
    try {
      let params: PatternParams;
      if (kind === "polka-dots-scroll") {
        params = {
          kind: "polka-dots-scroll",
          width: canvasWidth,
          height: canvasHeight,
          fps: 30,
          bgColor,
          dotColor,
          tileSize,
          dotRadius,
          scrollAngleDeg,
          scrollSpeed,
        };
      } else {
        params = {
          kind: "comic-burst",
          width: canvasWidth,
          height: canvasHeight,
          fps: 30,
          outerColor,
          burstColor,
          spikeCount,
          spikeLength,
          innerRadius,
          spikeVariation,
          centerOffsetX,
          centerOffsetY,
          animation: burstAnimation,
          loopDuration: burstLoopDur,
        };
      }
      const { path, durationSec } = await generateAndSavePatternVideo(
        templateId,
        params,
      );
      onGenerated(path, durationSec);
      onClose();
    } catch (e) {
      console.error("[PatternBackgroundModal] error:", e);
      setError(e instanceof Error ? e.message : String(e));
      alert(`パターン背景の生成でエラー:\n\n${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-xl w-full max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800">
          <div className="text-sm font-semibold">パターン背景生成</div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-gray-500 hover:text-gray-700 text-lg disabled:opacity-50"
          >
            ✕
          </button>
        </div>

        {/* 種類タブ */}
        <div className="flex border-b border-gray-200 dark:border-gray-800">
          <button
            type="button"
            onClick={() => setKind("polka-dots-scroll")}
            disabled={busy}
            className={`flex-1 px-3 py-2 text-xs font-medium ${
              kind === "polka-dots-scroll"
                ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-b-2 border-blue-500"
                : "text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
            }`}
          >
            水玉スクロール
          </button>
          <button
            type="button"
            onClick={() => setKind("comic-burst")}
            disabled={busy}
            className={`flex-1 px-3 py-2 text-xs font-medium ${
              kind === "comic-burst"
                ? "bg-yellow-50 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-200 border-b-2 border-yellow-500"
                : "text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
            }`}
          >
            アメコミ風バースト
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {kind === "polka-dots-scroll" && (
            <PolkaDotsForm
              bgColor={bgColor}
              setBgColor={setBgColor}
              dotColor={dotColor}
              setDotColor={setDotColor}
              tileSize={tileSize}
              setTileSize={setTileSize}
              dotRadius={dotRadius}
              setDotRadius={setDotRadius}
              scrollAngleDeg={scrollAngleDeg}
              setScrollAngleDeg={setScrollAngleDeg}
              scrollSpeed={scrollSpeed}
              setScrollSpeed={setScrollSpeed}
              busy={busy}
              applyPreset={applyPolkaPreset}
            />
          )}
          {kind === "comic-burst" && (
            <BurstForm
              outerColor={outerColor}
              setOuterColor={setOuterColor}
              burstColor={burstColor}
              setBurstColor={setBurstColor}
              spikeCount={spikeCount}
              setSpikeCount={setSpikeCount}
              spikeLength={spikeLength}
              setSpikeLength={setSpikeLength}
              innerRadius={innerRadius}
              setInnerRadius={setInnerRadius}
              spikeVariation={spikeVariation}
              setSpikeVariation={setSpikeVariation}
              centerOffsetX={centerOffsetX}
              setCenterOffsetX={setCenterOffsetX}
              centerOffsetY={centerOffsetY}
              setCenterOffsetY={setCenterOffsetY}
              animation={burstAnimation}
              setAnimation={setBurstAnimation}
              loopDuration={burstLoopDur}
              setLoopDuration={setBurstLoopDur}
              busy={busy}
              applyPreset={applyBurstPreset}
            />
          )}

          {error && (
            <div className="p-2 rounded bg-red-50 dark:bg-red-900/20 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-3 border-t border-gray-200 dark:border-gray-800">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-xs disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={busy}
            className="px-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-400 text-white text-xs"
          >
            {busy ? "生成中（数秒待ってね）..." : "生成してレイヤーに追加"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 水玉フォーム
// ============================================================================
function PolkaDotsForm(props: {
  bgColor: string;
  setBgColor: (v: string) => void;
  dotColor: string;
  setDotColor: (v: string) => void;
  tileSize: number;
  setTileSize: (v: number) => void;
  dotRadius: number;
  setDotRadius: (v: number) => void;
  scrollAngleDeg: number;
  setScrollAngleDeg: (v: number) => void;
  scrollSpeed: number;
  setScrollSpeed: (v: number) => void;
  busy: boolean;
  applyPreset: (p: (typeof POLKA_PRESETS)[number]) => void;
}) {
  const {
    bgColor,
    setBgColor,
    dotColor,
    setDotColor,
    tileSize,
    setTileSize,
    dotRadius,
    setDotRadius,
    scrollAngleDeg,
    setScrollAngleDeg,
    scrollSpeed,
    setScrollSpeed,
    busy,
    applyPreset,
  } = props;

  const { dirX, dirY } = snapDirectionFromAngle(scrollAngleDeg);
  const dxPx = dirX * tileSize;
  const dyPx = -dirY * tileSize;
  const distance = Math.hypot(dxPx, dyPx);
  const loopDur = distance > 0 ? distance / Math.max(0.001, scrollSpeed) : 0;
  const animName = `pattern-scroll-${dirX}-${dirY}-${tileSize}`;
  const keyframes = `@keyframes ${animName} {
    from { background-position: 0 0; }
    to { background-position: ${dxPx}px ${dyPx}px; }
  }`;
  const previewStyle: React.CSSProperties = {
    width: "100%",
    height: 200,
    background: bgColor,
    backgroundImage: `radial-gradient(circle at center, ${dotColor} ${dotRadius}px, transparent ${dotRadius + 1}px)`,
    backgroundSize: `${tileSize}px ${tileSize}px`,
    animation:
      loopDur > 0 ? `${animName} ${loopDur}s linear infinite` : "none",
  };

  return (
    <>
      <style>{keyframes}</style>
      <div>
        <div className="text-xs text-gray-500 mb-1">プリセット</div>
        <div className="flex flex-wrap gap-1">
          {POLKA_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => applyPreset(p)}
              disabled={busy}
              className="px-2 py-1 text-[11px] rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="text-xs text-gray-500 mb-1">プレビュー</div>
        <div
          className="rounded overflow-hidden border border-gray-300 dark:border-gray-600"
          style={previewStyle}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="text-xs">
          <label>背景色</label>
          <input
            type="color"
            value={bgColor}
            onChange={(e) => setBgColor(e.target.value)}
            onBlur={(e) => recordColorUsed(e.target.value)}
            className="w-full h-8 rounded border border-gray-300 dark:border-gray-600"
          />
          <ColorSwatches
            value={bgColor}
            onChange={(c) => {
              setBgColor(c);
              recordColorUsed(c);
            }}
          />
        </div>
        <div className="text-xs">
          <label>水玉色</label>
          <input
            type="color"
            value={dotColor}
            onChange={(e) => setDotColor(e.target.value)}
            onBlur={(e) => recordColorUsed(e.target.value)}
            className="w-full h-8 rounded border border-gray-300 dark:border-gray-600"
          />
          <ColorSwatches
            value={dotColor}
            onChange={(c) => {
              setDotColor(c);
              recordColorUsed(c);
            }}
          />
        </div>
        <label className="text-xs">
          タイルサイズ ({tileSize} px)
          <input
            type="range"
            min={60}
            max={400}
            step={10}
            value={tileSize}
            onChange={(e) => setTileSize(Number(e.target.value))}
            className="w-full"
          />
        </label>
        <label className="text-xs">
          水玉サイズ ({dotRadius} px)
          <input
            type="range"
            min={5}
            max={Math.max(10, tileSize / 2 - 5)}
            step={1}
            value={Math.min(dotRadius, Math.max(10, tileSize / 2 - 5))}
            onChange={(e) => setDotRadius(Number(e.target.value))}
            className="w-full"
          />
        </label>
        <label className="text-xs">
          スクロール角度 ({scrollAngleDeg}°)
          <input
            type="range"
            min={0}
            max={359}
            step={1}
            value={scrollAngleDeg}
            onChange={(e) => setScrollAngleDeg(Number(e.target.value))}
            className="w-full"
          />
          <span className="text-[10px] text-gray-400">
            0=右、45=右上、90=上、135=左上、180=左、270=下
          </span>
        </label>
        <label className="text-xs">
          スクロール速度 ({scrollSpeed} px/秒)
          <input
            type="range"
            min={10}
            max={300}
            step={5}
            value={scrollSpeed}
            onChange={(e) => setScrollSpeed(Number(e.target.value))}
            className="w-full"
          />
        </label>
      </div>

      <div className="text-[10px] text-gray-500">
        出力解像度 1080×1920 / fps 30 / 方向は 8 方向にスナップ（
        {dirX > 0 ? "→" : dirX < 0 ? "←" : "・"}
        {dirY > 0 ? "↑" : dirY < 0 ? "↓" : "・"}）/ 1 ループ ={" "}
        <strong>{loopDur.toFixed(2)} 秒</strong>
      </div>
    </>
  );
}

// ============================================================================
// バーストフォーム
// ============================================================================
function BurstForm(props: {
  outerColor: string;
  setOuterColor: (v: string) => void;
  burstColor: string;
  setBurstColor: (v: string) => void;
  spikeCount: number;
  setSpikeCount: (v: number) => void;
  spikeLength: number;
  setSpikeLength: (v: number) => void;
  innerRadius: number;
  setInnerRadius: (v: number) => void;
  spikeVariation: number;
  setSpikeVariation: (v: number) => void;
  centerOffsetX: number;
  setCenterOffsetX: (v: number) => void;
  centerOffsetY: number;
  setCenterOffsetY: (v: number) => void;
  animation: "none" | "pulse" | "rotate";
  setAnimation: (v: "none" | "pulse" | "rotate") => void;
  loopDuration: number;
  setLoopDuration: (v: number) => void;
  busy: boolean;
  applyPreset: (p: (typeof BURST_PRESETS)[number]) => void;
}) {
  const {
    outerColor,
    setOuterColor,
    burstColor,
    setBurstColor,
    spikeCount,
    setSpikeCount,
    spikeLength,
    setSpikeLength,
    innerRadius,
    setInnerRadius,
    spikeVariation,
    setSpikeVariation,
    centerOffsetX,
    setCenterOffsetX,
    centerOffsetY,
    setCenterOffsetY,
    animation,
    setAnimation,
    loopDuration,
    setLoopDuration,
    busy,
    applyPreset,
  } = props;

  // SVG プレビュー（パラメタを 0..360 / 0..640 にスケールして表示）
  // viewBox は 1080x1920 と同比（9:16）にする → 360x640
  const previewW = 360;
  const previewH = 640;
  const sx = previewW / 1080;
  const cx = previewW / 2 + (centerOffsetX / 100) * previewW;
  const cy = previewH / 2 + (centerOffsetY / 100) * previewH;

  // SVG ポリゴン頂点列（jitter 込み）
  const spikeRandoms = useRef<number[]>([]);
  if (spikeRandoms.current.length !== spikeCount) {
    spikeRandoms.current = Array.from({ length: spikeCount }, (_, i) => {
      const v = Math.sin((i + 1) * 12.9898) * 43758.5453;
      return v - Math.floor(v);
    });
  }
  const totalPts = spikeCount * 2;
  const points: string[] = [];
  for (let i = 0; i < totalPts; i++) {
    const angle = (i / totalPts) * Math.PI * 2 - Math.PI / 2;
    const isPeak = i % 2 === 0;
    const spikeIdx = Math.floor(i / 2);
    const jitter = isPeak
      ? (spikeRandoms.current[spikeIdx] - 0.5) * 2 * spikeVariation
      : 0;
    const r = (isPeak ? spikeLength * (1 + jitter) : innerRadius) * sx;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  const polyPoints = points.join(" ");

  // SVG プレビューでアニメも見えるようにする（CSS animation）
  const previewAnimName = `burst-${animation}-${loopDuration}`;
  const animKeyframes =
    animation === "pulse"
      ? `@keyframes ${previewAnimName} {
            0% { transform: scale(0.92); }
            50% { transform: scale(1.08); }
            100% { transform: scale(0.92); }
          }`
      : animation === "rotate"
        ? `@keyframes ${previewAnimName} {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }`
        : "";

  // svg 内 transform-origin 用に group で包む。CSS animation を当てる。
  const polygonStyle: React.CSSProperties = {
    transformOrigin: `${cx}px ${cy}px`,
    animation:
      animation === "none" || loopDuration <= 0
        ? "none"
        : `${previewAnimName} ${loopDuration}s linear infinite`,
  };

  return (
    <>
      {animKeyframes && <style>{animKeyframes}</style>}
      <div>
        <div className="text-xs text-gray-500 mb-1">プリセット</div>
        <div className="flex flex-wrap gap-1">
          {BURST_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => applyPreset(p)}
              disabled={busy}
              className="px-2 py-1 text-[11px] rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="text-xs text-gray-500 mb-1">プレビュー</div>
        <div className="rounded overflow-hidden border border-gray-300 dark:border-gray-600 mx-auto" style={{ width: previewW, height: previewH * 0.4, background: outerColor }}>
          {/* 縦横比保ちつつ、モーダルが縦に長くならないよう 40% 縮め */}
          <svg
            viewBox={`0 0 ${previewW} ${previewH}`}
            width={previewW}
            height={previewH * 0.4}
            style={{ display: "block" }}
            preserveAspectRatio="xMidYMid meet"
          >
            <rect width={previewW} height={previewH} fill={outerColor} />
            <polygon
              points={polyPoints}
              fill={burstColor}
              style={polygonStyle}
            />
          </svg>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="text-xs">
          <label>外側色</label>
          <input
            type="color"
            value={outerColor}
            onChange={(e) => setOuterColor(e.target.value)}
            onBlur={(e) => recordColorUsed(e.target.value)}
            className="w-full h-8 rounded border border-gray-300 dark:border-gray-600"
          />
          <ColorSwatches
            value={outerColor}
            onChange={(c) => {
              setOuterColor(c);
              recordColorUsed(c);
            }}
          />
        </div>
        <div className="text-xs">
          <label>バースト色</label>
          <input
            type="color"
            value={burstColor}
            onChange={(e) => setBurstColor(e.target.value)}
            onBlur={(e) => recordColorUsed(e.target.value)}
            className="w-full h-8 rounded border border-gray-300 dark:border-gray-600"
          />
          <ColorSwatches
            value={burstColor}
            onChange={(c) => {
              setBurstColor(c);
              recordColorUsed(c);
            }}
          />
        </div>
        <label className="text-xs">
          スパイク本数 ({spikeCount} 本)
          <input
            type="range"
            min={4}
            max={48}
            step={1}
            value={spikeCount}
            onChange={(e) => setSpikeCount(Number(e.target.value))}
            className="w-full"
          />
        </label>
        <label className="text-xs">
          長さ揺らぎ ({spikeVariation.toFixed(2)})
          <input
            type="range"
            min={0}
            max={0.6}
            step={0.01}
            value={spikeVariation}
            onChange={(e) => setSpikeVariation(Number(e.target.value))}
            className="w-full"
          />
        </label>
        <label className="text-xs">
          スパイク長 ({spikeLength} px)
          <input
            type="range"
            min={400}
            max={1800}
            step={20}
            value={spikeLength}
            onChange={(e) => setSpikeLength(Number(e.target.value))}
            className="w-full"
          />
        </label>
        <label className="text-xs">
          内側半径 ({innerRadius} px)
          <input
            type="range"
            min={50}
            max={Math.max(60, spikeLength - 100)}
            step={10}
            value={Math.min(innerRadius, Math.max(60, spikeLength - 100))}
            onChange={(e) => setInnerRadius(Number(e.target.value))}
            className="w-full"
          />
        </label>
        <label className="text-xs">
          中心 X オフセット ({centerOffsetX}%)
          <input
            type="range"
            min={-40}
            max={40}
            step={1}
            value={centerOffsetX}
            onChange={(e) => setCenterOffsetX(Number(e.target.value))}
            className="w-full"
          />
        </label>
        <label className="text-xs">
          中心 Y オフセット ({centerOffsetY}%)
          <input
            type="range"
            min={-40}
            max={40}
            step={1}
            value={centerOffsetY}
            onChange={(e) => setCenterOffsetY(Number(e.target.value))}
            className="w-full"
          />
        </label>
        <label className="text-xs col-span-2">
          アニメーション
          <select
            value={animation}
            onChange={(e) =>
              setAnimation(e.target.value as "none" | "pulse" | "rotate")
            }
            className="w-full h-8 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-xs px-2"
          >
            <option value="none">なし（静止）</option>
            <option value="pulse">パルス（拡大縮小）</option>
            <option value="rotate">回転</option>
          </select>
        </label>
        {animation !== "none" && (
          <label className="text-xs col-span-2">
            ループ秒数 ({loopDuration.toFixed(2)} 秒)
            <input
              type="range"
              min={0.3}
              max={animation === "rotate" ? 30 : 5}
              step={0.1}
              value={loopDuration}
              onChange={(e) => setLoopDuration(Number(e.target.value))}
              className="w-full"
            />
            <span className="text-[10px] text-gray-400">
              {animation === "pulse"
                ? "短いほど速いパルス"
                : "短いほど速い回転（1 ループで 360°）"}
            </span>
          </label>
        )}
      </div>

      <div className="text-[10px] text-gray-500">
        出力解像度 1080×1920 / fps 30 / 1 ループ ={" "}
        <strong>
          {animation === "none" ? "—" : `${loopDuration.toFixed(2)} 秒`}
        </strong>
      </div>
    </>
  );
}

