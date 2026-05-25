import { useEffect, useRef, useState } from "react";
import type { Layer } from "../types";
import {
  loadLive2DModel,
  createPixiApp,
  type LoadedLive2D,
} from "../lib/live2dLoader";
import {
  tickCharacter,
  createTickState,
  type CharacterTickState,
  type TickableModel,
} from "../lib/characterTick";
import { buildCompositeLipsyncSampler } from "../lib/compositeLipsync";

/**
 * Live2D キャラクタレイヤーのプレビュー描画コンポーネント。
 *
 * - 自前の <canvas> に PIXI.Application を生成して Live2DModel を表示する
 * - playback 時は requestAnimationFrame で tickCharacter(t) を駆動
 * - 一時停止中は currentTimeSec が変わるたびに 1 フレームだけ再描画 (スクラブ対応)
 * - layer.modelPath / layer のサイズ変更時に追従
 */
export function CharacterLayerContent({
  layer,
  currentTimeSec,
  isPlaying,
  audiosForLipsync,
}: {
  layer: Layer;
  currentTimeSec: number;
  isPlaying: boolean;
  /**
   * リップシンクの駆動元として候補にする音声レイヤー一覧。
   * - linkedAudioLayerId 指定時 → その 1 本だけが渡される
   * - 未指定 (auto) 時 → テンプレ内の全音声レイヤーが渡される
   * 内部で時刻 t に応じてどの音声を使うかが切り替わる (compositeLipsync)。
   */
  audiosForLipsync?: Layer[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // ライフサイクル管理用 ref。再レンダリングと無関係に保持する
  const stateRef = useRef<{
    app?: ReturnType<typeof createPixiApp>;
    loaded?: LoadedLive2D;
    tickState?: CharacterTickState;
    rafId?: number;
    lastFrameTime?: number;
    sizeWatcher?: ResizeObserver;
  }>({});
  // リップシンクサンプラの最新値。linkedAudio / lipsyncMode の変化で更新される。
  const lipsyncSamplerRef = useRef<
    ((t: number) => { openY: number; form: number }) | null
  >(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // モデルの (再) 読み込み: layer.modelPath が変わるたびに走る
  useEffect(() => {
    let cancelled = false;
    const path = layer.modelPath;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!path || !canvas || !container) return;

    setLoading(true);
    setErrorMsg(null);

    const w = Math.max(1, Math.floor(container.clientWidth));
    const h = Math.max(1, Math.floor(container.clientHeight));

    // 既存の app / model を破棄
    const prev = stateRef.current;
    if (prev.rafId !== undefined) cancelAnimationFrame(prev.rafId);
    if (prev.app) {
      try {
        prev.app.destroy(false, { children: true, texture: false });
      } catch {
        /* noop */
      }
    }
    stateRef.current = {};

    (async () => {
      try {
        const app = createPixiApp(canvas, w, h);
        const loaded = await loadLive2DModel(path);
        if (cancelled) {
          app.destroy(false, { children: true, texture: false });
          return;
        }
        // モデルを枠内にフィットして中央配置
        const mw = loaded.modelWidth || 1;
        const mh = loaded.modelHeight || 1;
        const scale = Math.min(w / mw, h / mh);
        loaded.model.scale.set(scale);
        const anchor = (loaded.model as unknown as { anchor?: { set(x: number, y: number): void } }).anchor;
        if (anchor && typeof anchor.set === "function") {
          anchor.set(0.5, 0.5);
        }
        loaded.model.x = w / 2;
        loaded.model.y = h / 2;
        // pixi-live2d-display 0.5 系の型ズレ対策で any 経由
        app.stage.addChild(loaded.model as unknown as never);

        // 初期 tickState を生成 (シードされた瞬きスケジュール等を準備)
        // 長尺対応のため十分大きい maxDuration を渡す (3 時間まで)
        const tickState = createTickState(layer, 3 * 3600);
        // 既に解決済みのリップシンクサンプラがあれば即セット
        tickState.lipsyncSampler = lipsyncSamplerRef.current;

        stateRef.current = { app, loaded, tickState, lastFrameTime: undefined };

        // 初回フレームを描画
        renderOnce(currentTimeSec, 0);
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          // pixi-live2d-display の NetworkError は url / status を持っているので含める
          const err = e as {
            message?: string;
            url?: string;
            status?: number;
            stack?: string;
          };
          let detail: string;
          if (err?.url) {
            detail = `${err.message ?? "Error"} (HTTP ${err.status ?? "?"}) ${err.url}`;
          } else if (err?.stack) {
            // stack の最初の 3 行までを画面に出す (どの関数で起きたか追えるように)
            const lines = err.stack.split("\n").slice(0, 3).join("\n");
            detail = `${err.message ?? String(e)}\n${lines}`;
          } else {
            detail = String(e);
          }
          setErrorMsg(detail);
          setLoading(false);
          console.error("[CharacterLayerContent] Live2D load failed:", e);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer.modelPath]);

  // モデル設定 (blink / lipsync 等) が変わった場合に tickState を作り直す
  useEffect(() => {
    const s = stateRef.current;
    if (!s.loaded) return;
    s.tickState = createTickState(layer, 3 * 3600);
    // リップシンクサンプラを再注入 (tickState 作り直しで失われるため)
    s.tickState.lipsyncSampler = lipsyncSamplerRef.current;
    // 即座に 1 フレーム反映
    renderOnce(currentTimeSec, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    layer.blinkConfig?.enabled,
    layer.blinkConfig?.duration,
    layer.blinkConfig?.intervalMean,
    layer.blinkConfig?.intervalJitter,
    layer.blinkConfig?.seed,
  ]);

  // リップシンクサンプラの構築 (audiosForLipsync / lipsyncMode 変化時)
  // audios の中身が変わったか軽量に判定するためキー文字列を作る
  const audiosKey = (audiosForLipsync ?? [])
    .map(
      (a) =>
        `${a.id}|${a.source ?? ""}|${a.startSec}|${a.endSec}|${a.playbackRate ?? 1}`,
    )
    .join(",");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let sampler:
        | ((t: number) => { openY: number; form: number })
        | null = null;
      const mode = layer.lipsyncMode ?? "voicevox";
      const audios = audiosForLipsync ?? [];
      if (mode !== "off" && audios.length > 0) {
        sampler = await buildCompositeLipsyncSampler(
          audios,
          mode === "rms" ? "rms" : "voicevox",
        );
      }
      if (cancelled) return;
      lipsyncSamplerRef.current = sampler;
      if (stateRef.current.tickState) {
        stateRef.current.tickState.lipsyncSampler = sampler;
      }
      if (!isPlaying) renderOnce(currentTimeRef.current, 0);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer.lipsyncMode, audiosKey]);

  // 1 フレームだけ描画
  function renderOnce(t: number, dt: number) {
    const s = stateRef.current;
    if (!s.app || !s.loaded || !s.tickState) return;
    tickCharacter(
      s.loaded.model as unknown as TickableModel,
      s.loaded.cubismModel,
      s.loaded.paramIndex,
      layer,
      s.loaded.paramMap,
      t,
      dt,
      s.tickState,
    );
    s.app.render();
  }

  // 再生中は rAF で連続描画
  useEffect(() => {
    if (!isPlaying) {
      const s = stateRef.current;
      if (s.rafId !== undefined) {
        cancelAnimationFrame(s.rafId);
        s.rafId = undefined;
      }
      s.lastFrameTime = undefined;
      return;
    }
    const s = stateRef.current;
    s.lastFrameTime = undefined;
    const loop = (now: number) => {
      const last = s.lastFrameTime;
      const dt = last === undefined ? 1 / 60 : Math.max(0, (now - last) / 1000);
      s.lastFrameTime = now;
      // 親から渡される currentTimeSec が rAF より低頻度更新なので、ここでは
      // 最新の currentTimeSec をクロージャから読む。再レンダリングで loop 自体が再生成される。
      renderOnceWithLatest(dt);
      s.rafId = requestAnimationFrame(loop);
    };
    s.rafId = requestAnimationFrame(loop);
    return () => {
      if (s.rafId !== undefined) cancelAnimationFrame(s.rafId);
      s.rafId = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  // currentTimeSec の最新値を rAF ループから読むためのミラー (renderOnceWithLatest 用)
  const currentTimeRef = useRef(currentTimeSec);
  currentTimeRef.current = currentTimeSec;

  function renderOnceWithLatest(dt: number) {
    renderOnce(currentTimeRef.current, dt);
  }

  // 一時停止中の currentTimeSec 変更 (スクラブ) → 1 フレームだけ更新
  useEffect(() => {
    if (isPlaying) return;
    renderOnce(currentTimeSec, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTimeSec, isPlaying]);

  // 親要素サイズ変更に追従して PIXI renderer をリサイズ
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => {
      const s = stateRef.current;
      if (!s.app || !s.loaded) return;
      const w = Math.max(1, Math.floor(container.clientWidth));
      const h = Math.max(1, Math.floor(container.clientHeight));
      s.app.renderer.resize(w, h);
      const mw = s.loaded.modelWidth || 1;
      const mh = s.loaded.modelHeight || 1;
      const scale = Math.min(w / mw, h / mh);
      s.loaded.model.scale.set(scale);
      s.loaded.model.x = w / 2;
      s.loaded.model.y = h / 2;
      // 一時停止中なら即時再描画
      renderOnce(currentTimeRef.current, 0);
    });
    ro.observe(container);
    stateRef.current.sizeWatcher = ro;
    return () => {
      ro.disconnect();
    };
  }, []);

  // アンマウント時に PIXI app を完全に破棄
  useEffect(() => {
    return () => {
      const s = stateRef.current;
      if (s.rafId !== undefined) cancelAnimationFrame(s.rafId);
      s.sizeWatcher?.disconnect();
      if (s.app) {
        try {
          s.app.destroy(false, { children: true, texture: true });
        } catch {
          /* noop */
        }
      }
      stateRef.current = {};
    };
  }, []);

  if (!layer.modelPath) {
    return (
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
          background:
            "repeating-linear-gradient(45deg, #2a1a3a, #2a1a3a 8px, #3a2a4a 8px, #3a2a4a 16px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#aaa",
          fontSize: 10,
        }}
      >
        🎭 キャラ(モデル未設定)
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        pointerEvents: "none",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
        }}
      />
      {(loading || errorMsg) && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.4)",
            color: errorMsg ? "#fda4af" : "#aaa",
            fontSize: 9,
            padding: 8,
            textAlign: "center",
            whiteSpace: "pre-wrap",
            overflow: "auto",
          }}
        >
          {errorMsg ?? "🎭 ロード中..."}
        </div>
      )}
    </div>
  );
}
