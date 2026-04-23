import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * 音声ファイルをデコードしてピーク配列を取得する。
 * - 同じ source に対しては一度だけデコードしてキャッシュ再利用
 * - peaks は固定 bin 数（画面幅に合わせて拡縮描画する）
 */

const PEAK_BINS = 600; // 1 音源あたりの波形ビン数（タイムラインの横幅が大きくても耐える）
const peakCache = new Map<string, Float32Array>();
const inflight = new Map<string, Promise<Float32Array>>();

export async function loadWaveformPeaks(source: string): Promise<Float32Array> {
  const cached = peakCache.get(source);
  if (cached) return cached;
  const running = inflight.get(source);
  if (running) return running;

  const task = (async () => {
    try {
      const url =
        source.startsWith("http://") ||
        source.startsWith("https://") ||
        source.startsWith("data:") ||
        source.startsWith("blob:")
          ? source
          : convertFileSrc(source);
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      const AC =
        (window as unknown as { AudioContext?: typeof AudioContext })
          .AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AC) throw new Error("AudioContext not supported");
      const ctx = new AC();
      try {
        const audio = await ctx.decodeAudioData(buf.slice(0));
        const ch = audio.getChannelData(0);
        const peaks = new Float32Array(PEAK_BINS);
        const samplesPerBin = Math.max(
          1,
          Math.floor(ch.length / PEAK_BINS),
        );
        for (let i = 0; i < PEAK_BINS; i++) {
          let max = 0;
          const start = i * samplesPerBin;
          const end = Math.min(start + samplesPerBin, ch.length);
          for (let j = start; j < end; j++) {
            const v = Math.abs(ch[j]);
            if (v > max) max = v;
          }
          peaks[i] = max;
        }
        peakCache.set(source, peaks);
        return peaks;
      } finally {
        try {
          ctx.close();
        } catch {
          /* noop */
        }
      }
    } finally {
      inflight.delete(source);
    }
  })();

  inflight.set(source, task);
  return task;
}

/** Canvas に波形を描画。peaks は 0〜1 の絶対値。 */
export function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: Float32Array,
  color: string = "rgba(255,255,255,0.55)",
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = color;
  const halfH = h / 2;
  for (let x = 0; x < w; x++) {
    const i = Math.floor((x / w) * peaks.length);
    const peak = peaks[i] ?? 0;
    const barH = Math.max(1, peak * halfH * 2);
    const y = halfH - barH / 2;
    ctx.fillRect(x, y, 1, barH);
  }
}
