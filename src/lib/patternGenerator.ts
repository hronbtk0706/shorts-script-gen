import { invoke } from "@tauri-apps/api/core";

export type PatternKind = "polka-dots-scroll" | "comic-burst";

export interface PolkaDotsScrollParams {
  kind: "polka-dots-scroll";
  /** 出力解像度 */
  width: number;
  height: number;
  /** 背景色（CSS 形式） */
  bgColor: string;
  /** 水玉の色 */
  dotColor: string;
  /** 1タイルのサイズ (px) */
  tileSize: number;
  /** 水玉の半径 (px) */
  dotRadius: number;
  /** スクロール角度（度数法。0=右、45=右上、90=上、135=左上、180=左、270=下） */
  scrollAngleDeg: number;
  /** スクロール速度 (px / 秒) */
  scrollSpeed: number;
  /** フレームレート */
  fps: number;
}

export interface ComicBurstParams {
  kind: "comic-burst";
  /** 出力解像度 */
  width: number;
  height: number;
  fps: number;
  /** スパイク外側（背景）色 */
  outerColor: string;
  /** スパイク本体（バースト内側）色 */
  burstColor: string;
  /** スパイクの本数 */
  spikeCount: number;
  /** 中心からスパイク先端までの基準長 (px) */
  spikeLength: number;
  /** 中心からスパイク根元までの距離 (px、0 で星型に集まる) */
  innerRadius: number;
  /** スパイク 1 本ごとの長さ揺らぎ (0..1, 0=均一, 1=大きく揺らぐ) */
  spikeVariation: number;
  /** 中心位置のオフセット (キャンバス中央からの ±%、X 軸) */
  centerOffsetX: number;
  /** 中心位置のオフセット (キャンバス中央からの ±%、Y 軸) */
  centerOffsetY: number;
  /** アニメ種別 */
  animation: "none" | "pulse" | "rotate";
  /** アニメの 1 ループ秒数（"none" のときは無視） */
  loopDuration: number;
}

export type PatternParams = PolkaDotsScrollParams | ComicBurstParams;

/**
 * 角度を 8 方向 (45° 刻み) にスナップして単位ベクトルを返す。
 * これによりスクロール終端が必ずタイルグリッドに乗り、ループが継ぎ目なく繋がる。
 */
export function snapDirectionFromAngle(deg: number): {
  dirX: number;
  dirY: number;
} {
  const normalized = ((deg % 360) + 360) % 360;
  const snapped = Math.round(normalized / 45) * 45;
  const rad = (snapped * Math.PI) / 180;
  const dirX = Math.round(Math.cos(rad));
  const dirY = Math.round(Math.sin(rad));
  return { dirX, dirY };
}

// ============================================================================
// 共通: Canvas + MediaRecorder で webm を録画する
// ============================================================================
async function recordCanvasToWebmBlob(
  canvas: HTMLCanvasElement,
  fps: number,
  drawFrame: (frameIdx: number) => void,
  totalFrames: number,
): Promise<Blob> {
  const stream = canvas.captureStream(fps);
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  const mimeType =
    candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? "video/webm";
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 4_000_000,
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
  });

  recorder.start();
  for (let f = 0; f < totalFrames; f++) {
    drawFrame(f);
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }
  // 末尾のループ繋ぎを良くするため最終フレーム後ちょっと待つ
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  recorder.stop();
  await stopped;

  return new Blob(chunks, { type: mimeType });
}

// ============================================================================
// 水玉スクロールパターン
// ============================================================================
async function generatePolkaDotsLoopBlob(
  params: PolkaDotsScrollParams,
): Promise<Blob> {
  const {
    width,
    height,
    bgColor,
    dotColor,
    tileSize,
    dotRadius,
    scrollAngleDeg,
    scrollSpeed,
    fps,
  } = params;

  const { dirX, dirY } = snapDirectionFromAngle(scrollAngleDeg);
  const dxFinal = dirX * tileSize;
  const dyFinal = -dirY * tileSize;
  const distance = Math.hypot(dxFinal, dyFinal);
  const loopDuration =
    distance > 0 ? distance / Math.max(0.001, scrollSpeed) : 1 / fps;
  const totalFrames = Math.max(2, Math.round(loopDuration * fps));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context を取得できませんでした");

  const drawFrame = (frameIdx: number) => {
    const p = totalFrames > 1 ? frameIdx / totalFrames : 0;
    const offsetX = p * dxFinal;
    const offsetY = p * dyFinal;
    const ox = ((offsetX % tileSize) + tileSize) % tileSize;
    const oy = ((offsetY % tileSize) + tileSize) % tileSize;

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = dotColor;
    const startX = -tileSize + (ox - tileSize);
    const startY = -tileSize + (oy - tileSize);
    for (let py = startY; py < height + tileSize; py += tileSize) {
      for (let px = startX; px < width + tileSize; px += tileSize) {
        const cx = px + tileSize / 2;
        const cy = py + tileSize / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, dotRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  return recordCanvasToWebmBlob(canvas, fps, drawFrame, totalFrames);
}

// ============================================================================
// アメコミ風バースト（BAM! / POW! 系の放射状ギザギザ）
// ============================================================================

/** スパイク本数ぶんの決定論的 0..1 ランダム配列を返す（フレーム間で同一・ループの seam を保つ） */
function generateSpikeRandoms(spikeCount: number, seed: number = 1): number[] {
  return Array.from({ length: spikeCount }, (_, i) => {
    const v = Math.sin((i + 1) * seed * 12.9898) * 43758.5453;
    return v - Math.floor(v); // 0..1 の擬似乱数
  });
}

/** バースト 1 フレームを描画する */
function drawBurstFrame(
  ctx: CanvasRenderingContext2D,
  params: ComicBurstParams,
  timeSec: number,
  spikeRandoms: number[],
): void {
  const {
    width,
    height,
    outerColor,
    burstColor,
    spikeCount,
    spikeLength,
    innerRadius,
    spikeVariation,
    centerOffsetX,
    centerOffsetY,
    animation,
    loopDuration,
  } = params;

  // 背景（外側）を塗る
  ctx.fillStyle = outerColor;
  ctx.fillRect(0, 0, width, height);

  const cx = width / 2 + (centerOffsetX / 100) * width;
  const cy = height / 2 + (centerOffsetY / 100) * height;

  // アニメ
  let scale = 1;
  let rotationDeg = 0;
  if (animation === "pulse" && loopDuration > 0) {
    const p = (timeSec % loopDuration) / loopDuration;
    scale = 1 + 0.08 * Math.sin(p * Math.PI * 2);
  } else if (animation === "rotate" && loopDuration > 0) {
    const p = (timeSec % loopDuration) / loopDuration;
    rotationDeg = p * 360; // 1 ループ = 1 回転（ジッタ込みでも seam が合う）
  }

  ctx.save();
  ctx.translate(cx, cy);
  if (scale !== 1) ctx.scale(scale, scale);
  if (rotationDeg !== 0) ctx.rotate((rotationDeg * Math.PI) / 180);

  // バーストポリゴン: 2N 点（外側=peak, 内側=valley の交互）
  ctx.fillStyle = burstColor;
  ctx.beginPath();
  const totalPoints = spikeCount * 2;
  for (let i = 0; i < totalPoints; i++) {
    // 上 (-PI/2) 起点で時計回り
    const angle = (i / totalPoints) * Math.PI * 2 - Math.PI / 2;
    const isPeak = i % 2 === 0;
    const spikeIdx = Math.floor(i / 2);
    const jitter = isPeak
      ? (spikeRandoms[spikeIdx] - 0.5) * 2 * spikeVariation
      : 0;
    const radius = isPeak ? spikeLength * (1 + jitter) : innerRadius;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

async function generateComicBurstLoopBlob(
  params: ComicBurstParams,
): Promise<Blob> {
  const { width, height, fps, animation, loopDuration } = params;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context を取得できませんでした");

  const totalFrames =
    animation === "none" || loopDuration <= 0
      ? 1
      : Math.max(2, Math.round(loopDuration * fps));

  const spikeRandoms = generateSpikeRandoms(params.spikeCount);

  const drawFrame = (frameIdx: number) => {
    const t =
      totalFrames > 1 ? (frameIdx / totalFrames) * loopDuration : 0;
    drawBurstFrame(ctx, params, t, spikeRandoms);
  };

  if (totalFrames === 1) {
    // 静止 1 フレーム動画
    drawFrame(0);
  }
  return recordCanvasToWebmBlob(canvas, fps, drawFrame, totalFrames);
}

// ============================================================================
// パブリック API: kind で振り分け
// ============================================================================

/** 1ループぶんの webm Blob を生成する */
export async function generatePatternLoopBlob(
  params: PatternParams,
): Promise<Blob> {
  switch (params.kind) {
    case "polka-dots-scroll":
      return generatePolkaDotsLoopBlob(params);
    case "comic-burst":
      return generateComicBurstLoopBlob(params);
  }
}

/** Blob を base64 化（data URL prefix なし） */
async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunkSize)),
    );
  }
  return btoa(binary);
}

/** 生成した webm を assets フォルダに保存して絶対パスを返す */
export async function generateAndSavePatternVideo(
  templateId: string,
  params: PatternParams,
): Promise<{ path: string; durationSec: number }> {
  const blob = await generatePatternLoopBlob(params);
  const base64 = await blobToBase64(blob);
  const filename = `pattern_${params.kind}_${Date.now().toString(36)}.webm`;
  const path = await invoke<string>("save_template_asset_base64", {
    templateId,
    kind: "videos",
    filename,
    base64Data: base64,
  });
  // 1 ループぶんの秒数（後段の videoLoop=true で繰り返される想定）
  let durationSec: number;
  switch (params.kind) {
    case "polka-dots-scroll": {
      const distance = params.tileSize;
      durationSec = distance / Math.max(0.001, params.scrollSpeed);
      break;
    }
    case "comic-burst": {
      durationSec =
        params.animation === "none" ? 1 / params.fps : params.loopDuration;
      break;
    }
  }
  return { path, durationSec };
}
