import { useCallback, useEffect, useRef, useState } from "react";
import Moveable from "react-moveable";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Layer, TransitionSpec, LayerGroup, CameraSpec } from "../types";
import { templateDimensions } from "../types";
import { sortedLayers } from "../lib/layerUtils";
import { sampleLayerAt } from "../lib/keyframes";
import {
  applyAnchorOffset,
  hasAnimKfs,
  sampleAnimKfs,
} from "../lib/animKeyframes";
import { hasMotionPath, sampleMotionPath } from "../lib/motionPath";
import { computeLayerFilterCss } from "../lib/layerFilter";
import { buildIconSvgMarkup } from "../lib/icons";
import { drawGrain } from "../lib/effectShape";
import { computeDuckMultiplier } from "../lib/ducking";
import {
  computeScreenEffects,
  computeTransition,
  computeSnapshotTransition,
  composeSnapshotTransition,
} from "../lib/screenEffect";
import { computeMotion, computeFlyOffset } from "../lib/layerAnimCanvas";
import {
  computeMarker,
  isMarkerShape,
  markerColor,
  strokeToPath,
} from "../lib/markerShape";
import { bubbleFullPath } from "../lib/bubble";
import { resolveDynamicText } from "../lib/counterText";
import { hasHandwrite } from "../lib/handwriteStroke";
import { preloadHandwriteLayers } from "../lib/handwriteGlyphs";
import {
  TEXT_DEFAULT_FONT_STACK,
  wrapTextLines,
  renderLayersOnContext,
  composeScopedSnapshotTransition,
  setCompositionCanvasDimensions,
  computeCharAnimState,
} from "../lib/layerComposer";
import { CharacterLayerContent } from "./CharacterLayerContent";
import { LayerErrorBoundary } from "./LayerErrorBoundary";

function resolveSrcForWebview(src: string | undefined): string | null {
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
  // ローカルファイルパス → Tauri webview で表示可能な URL に変換
  try {
    return convertFileSrc(src);
  } catch {
    return null;
  }
}

interface Props {
  layers: Layer[];
  /** Phase2 §C: 場面転換（fade-black/zoom）。最終合成に適用。 */
  transitions?: TransitionSpec[];
  /** レイヤーグループ（ステージ）。Layer.groupId で所属したレイヤーを一括変換。 */
  groups?: LayerGroup[];
  /** カメラ変換（Phase3 C-1）。groupId 一致レイヤーに scale+移動を上掛け。 */
  cameras?: CameraSpec[];
  selectedLayerId: string | null;
  /** 複数選択中の全 id。未指定なら [selectedLayerId] 相当 */
  selectedLayerIds?: string[];
  onLayerSelect: (
    id: string | null,
    modifier?: "shift" | "ctrl" | null,
  ) => void;
  onLayerUpdate: (id: string, patch: Partial<Layer>) => void;
  /** 背景色（キャンバス自体の背景、レイヤーなしでも見える色） */
  canvasBackground?: string;
  /** グリッド表示 */
  showGrid?: boolean;
  /** セーフエリアガイド（プレビュー専用・action 93% / title 90% の枠）。 */
  showSafeArea?: boolean;
  /** 指定時刻に可視なレイヤーだけ表示（未指定なら全レイヤー） */
  currentTimeSec?: number;
  /** 再生中の正確な再生位置（60fps 更新の ref）。合成キャンバスはこれを読んで
   *  React state の間引き(24fps)に影響されず 60fps で描画する。未指定なら currentTimeSec を使う。 */
  playheadRef?: { current: number };
  /** タイムライン再生中かどうか（動画レイヤー再生同期用） */
  isPlaying?: boolean;
  /** 出力アスペクト比。未指定なら 9:16 (旧テンプレ互換) */
  aspect?: "vertical" | "horizontal";
}

/** 仮想キャンバスの最大サイズ。親幅／ビューポート高さに応じて拡縮 */
// 縦動画 (9:16) は横幅 720px 程度で十分 (高さで親コンテナを埋める)。
// 横動画 (16:9) は幅優先で大きく表示したいので最大値を 1280 まで許す。
// 実際の幅は親コンテナの実サイズで決まるので、ここはあくまで上限。
const CANVAS_MAX_W_PX = 1280;
const CANVAS_MIN_W_PX = 120;
/** キャンバスが占有してよいビューポート高さの割合 */
const CANVAS_HEIGHT_RATIO = 0.82;

export function TemplateCanvas({
  layers,
  transitions,
  groups,
  cameras,
  selectedLayerId,
  selectedLayerIds,
  onLayerSelect,
  onLayerUpdate,
  canvasBackground = "#111",
  showGrid = false,
  showSafeArea = false,
  currentTimeSec,
  playheadRef,
  isPlaying = false,
  aspect = "vertical",
}: Props) {
  // 縦 9:16, 横 16:9 のいずれか。CANVAS の縦横比をここから決める。
  const aspectRatioWH = aspect === "horizontal" ? 16 / 9 : 9 / 16;
  const selectedSet = new Set<string>(
    selectedLayerIds ?? (selectedLayerId ? [selectedLayerId] : []),
  );
  const isInTime = (l: Layer) =>
    currentTimeSec === undefined ||
    (currentTimeSec >= l.startSec && currentTimeSec < l.endSec);
  // 動画は startSec の少し前からマウントして preload="auto" で先読みする
  // （背景動画の切替時に「読み込み待ちで真っ暗」になるのを防ぐ）。
  const VIDEO_PRELOAD_LEAD_SEC = 1.5;
  const VIDEO_PRELOAD_TAIL_SEC = 0.5;
  // 音声も同様に startSec の手前から <audio preload="auto"> をマウントしてデコード/バッファを
  // 先読みする。startSec ちょうどでマウントするとロード待ちでナレーションが鳴り始め遅延・
  // 短尺だと区間を過ぎて欠落する（実際の発音は AudioLayerPlayer 側で in-time のときだけ）。
  const AUDIO_PRELOAD_LEAD_SEC = 1.5;
  const AUDIO_PRELOAD_TAIL_SEC = 0.3;
  const isAudioMounted = (l: Layer) =>
    currentTimeSec === undefined ||
    (currentTimeSec >= l.startSec - AUDIO_PRELOAD_LEAD_SEC &&
      currentTimeSec < l.endSec + AUDIO_PRELOAD_TAIL_SEC);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement | null>(null);
  const [, forceRerender] = useState(0);
  // 書き出しプレビュー: 実 export 経路 (renderLayersOnContext/drawLayer) で現在時刻を 1 枚描き、
  // プレビューと切り替え表示する。ちらつき防止のため OffscreenCanvas に完成させてから一括 blit。
  // ※ video/character は async デコードが要るためここには出ない（黒背景に text/shape/色/marker/
  //   bubble/image を描画。位置・サイズ・行間・折り返し・クリップ・アニメの確認用）。
  const exportCanvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<OffscreenCanvas | null>(null);
  const renderingRef = useRef(false);
  // 単一レンダラ化（CapCut 型）完了: 常に書き出し基準(Canvas)で表示・編集する。
  // DOM レイヤーは裏で操作専用。インライン編集中だけ Canvas を一時的に隠す（下の条件参照）。
  // ※ 巨大テンプレで編集が重い場合に素 DOM プレビューへ戻す退避が要るなら、ここを state 化して
  //   トグルを復活できる（DOM 描画経路は温存してある）。
  const showExport = true;
  // ドラッグ/リサイズ/回転の最中、掴んだレイヤーの「暫定 位置/サイズ/回転」を保持。
  // Canvas は隠さず（DOM に切り替えると見た目が変わるため）、この override を反映して
  // 掴んだレイヤーだけ追従描画する。pointer up で state を確定して override を消す。
  const dragOverrideRef = useRef<
    | {
        id: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        rotation?: number;
      }
    | null
  >(null);
  // rAF ループ用に最新の時刻/レイヤーを ref で保持（ループを再生成せず参照）
  const timeRef = useRef(currentTimeSec ?? 0);
  timeRef.current = currentTimeSec ?? 0;
  // 手書き（筆順）の「停止/スクラブ中は全文表示」用に再生状態を ref で保持。
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  // 性能計測（Shift+P で ON/OFF）: 合成にかかった時間と実FPS を表示してボトルネック特定用。
  const perfRef = useRef({
    emaTotal: 0, // renderExportFrame 全体 ms（指数移動平均）
    emaLayers: 0, // renderLayersOnContext だけの ms
    emaFps: 0,
    lastTick: 0,
    layerCount: 0,
    vidInTime: 0, // 今描画すべき動画レイヤー数
    vidReady: 0, // そのうち readyState>=2（描画可能）な数
    vidMounted: 0, // DOM に存在する <video> 総数（先読み含む）
    blackAlpha: 0, // fade-black トランジションの黒被せ量（0..1）
    snap: false, // wipe/push/dissolve トランジション中か
    flashAlpha: 0, // 白フラッシュ量
  });
  const [showPerf, setShowPerf] = useState(false);
  const [perfText, setPerfText] = useState("");
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const transitionsRef = useRef(transitions);
  transitionsRef.current = transitions;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const camerasRef = useRef(cameras);
  camerasRef.current = cameras;
  // 編集中レイヤーは Canvas 描画から除外（DOM textarea を重ねて二重描画を避ける）
  const initW = Math.round(Math.min(CANVAS_MAX_W_PX, 360));
  const [canvasSize, setCanvasSize] = useState({
    w: initW,
    h: Math.round(initW / aspectRatioWH),
  });
  // Shift 押下中のみアスペクト比を固定する（通常ドラッグは自由変形）
  const [shiftHeld, setShiftHeld] = useState(false);
  // キャンバス上のテキスト編集中のレイヤー id (ダブルクリックで開始)
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const editingLayerIdRef = useRef<string | null>(null);
  editingLayerIdRef.current = editingLayerId; // renderExportFrame で編集中レイヤーを除外するため
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(true);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(false);
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, []);

  // 親要素の実サイズ（flex レイアウトで決定）に合わせてアスペクト比を維持して拡縮
  useEffect(() => {
    if (!wrapperRef.current) return;
    const measure = () => {
      if (!wrapperRef.current) return;
      const availW = wrapperRef.current.clientWidth;
      // 親コンテナの実高さを優先。取得できなければビューポート基準にフォールバック
      const parentH = wrapperRef.current.clientHeight;
      const availH =
        parentH > 0 ? parentH : window.innerHeight * CANVAS_HEIGHT_RATIO;
      const wByWidth = availW;
      // height に収まる幅 = availH × (W/H)
      const wByHeight = availH * aspectRatioWH;
      const w = Math.max(
        CANVAS_MIN_W_PX,
        Math.min(CANVAS_MAX_W_PX, wByWidth, wByHeight),
      );
      const h = Math.round(w / aspectRatioWH);
      setCanvasSize({ w: Math.round(w), h });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrapperRef.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [aspectRatioWH]);

  const CANVAS_W_PX = canvasSize.w;
  const CANVAS_H_PX = canvasSize.h;

  // 表示中（in-time）でかつ selected のレイヤーだけ Moveable を出す。hidden/locked は除外
  const selected =
    layers.find(
      (l) =>
        l.id === selectedLayerId &&
        isInTime(l) &&
        !l.hidden &&
        !l.locked,
    ) ?? null;
  // selected が変わったら Moveable を再計算させる
  useEffect(() => {
    if (!selected) targetRef.current = null;
    forceRerender((n) => n + 1);
  }, [selectedLayerId, selected]);

  const pxToPercent = (px: number, dimension: "w" | "h") =>
    (px / (dimension === "w" ? CANVAS_W_PX : CANVAS_H_PX)) * 100;

  const handleBackgroundClick = (e: React.MouseEvent) => {
    // クリックした要素がレイヤーに属していないなら選択解除
    const hitLayer =
      e.target instanceof HTMLElement
        ? e.target.closest("[data-layer-id]")
        : null;
    if (!hitLayer) {
      onLayerSelect(null);
    }
  };

  // 画面全体エフェクト（type === "effect"）。再生中のみ適用（編集中は Moveable との
  // ズレを避けるため静止）。export 側 (computeScreenEffects) と同式・同 seed。
  // shake(translate)/zoom-punch(scale)/blur-burst は layer をラップする inner div に、
  // flash/vignette-pulse は overlay div で上に重ねる。
  const fx = isPlaying
    ? computeScreenEffects(layers, currentTimeSec ?? 0, CANVAS_W_PX / 360)
    : {
        dx: 0,
        dy: 0,
        scale: 1,
        flashAlpha: 0,
        vignetteAlpha: 0,
        blurPx: 0,
        gradeFilter: "",
        tintColor: null,
        tintAlpha: 0,
        grain: null,
      };
  const fxTransforms: string[] = [];
  if (fx.dx !== 0 || fx.dy !== 0) {
    fxTransforms.push(`translate(${fx.dx.toFixed(2)}px, ${fx.dy.toFixed(2)}px)`);
  }
  if (fx.scale !== 1) {
    fxTransforms.push(`scale(${fx.scale.toFixed(4)})`);
  }
  const hasTransform = fxTransforms.length > 0;
  const hasBlur = fx.blurPx > 0;
  const screenShakeStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    transformOrigin: "center",
    transform: hasTransform ? fxTransforms.join(" ") : undefined,
    filter: hasBlur ? `blur(${fx.blurPx.toFixed(2)}px)` : undefined,
    willChange: hasTransform || hasBlur ? "transform, filter" : undefined,
  };

  // 書き出しフレームを OffscreenCanvas に完成させてから可視 Canvas に一括描画（ちらつき防止）。
  // 動画/キャラはプレビューの実 <video>/<canvas> 要素を videoFrameSources として流用し、
  // ネイティブ再生のまま毎フレーム合成する（バッファ不要のリアルタイム書き出しプレビュー）。
  const renderExportFrame = useCallback(async () => {
    const visible = exportCanvasRef.current;
    const container = containerRef.current;
    if (!visible || !container) return;
    if (renderingRef.current) return; // 直列化（rAF が await するので通常は重ならない）
    renderingRef.current = true;
    const _perfT0 = performance.now();
    let _layersMs = 0;
    try {
      const dims = templateDimensions({ aspect });
      if (
        !offscreenRef.current ||
        offscreenRef.current.width !== dims.width ||
        offscreenRef.current.height !== dims.height
      ) {
        offscreenRef.current = new OffscreenCanvas(dims.width, dims.height);
      }
      const off = offscreenRef.current;
      const octx = off.getContext("2d");
      if (!octx) return;
      // 再生中は 60fps の playheadRef を読む（React state の間引きに影響されず滑らか）。
      // 停止/スクラブ中は timeRef（= currentTimeSec 同期）を使う。
      const t =
        isPlayingRef.current && playheadRef
          ? playheadRef.current
          : timeRef.current;
      const ov = dragOverrideRef.current;
      const editId = editingLayerIdRef.current;
      const curLayers = layersRef.current
        // 編集中レイヤーは Canvas から除外（DOM textarea を重ねる）
        .filter((l) => !l.hidden && l.id !== editId)
        // ドラッグ中の掴んだレイヤーは暫定値で描く（Canvas を隠さず追従）
        .map((l) => (ov && l.id === ov.id ? { ...l, ...ov } : l));
      // 動画/キャラの現在フレーム: プレビューの DOM 内 <video>/<canvas> をそのまま使う
      const frameSources = new Map<string, CanvasImageSource>();
      let _vidInTime = 0;
      let _vidReady = 0;
      for (const l of curLayers) {
        if (l.type !== "video" && l.type !== "character") continue;
        if (t < l.startSec || t >= l.endSec) continue;
        if (l.type === "video") _vidInTime++;
        const el = container.querySelector<HTMLElement>(
          `[data-layer-id="${l.id}"] video, [data-layer-id="${l.id}"] canvas`,
        );
        if (el instanceof HTMLVideoElement && el.readyState >= 2) {
          frameSources.set(l.id, el);
          if (l.type === "video") _vidReady++;
        } else if (el instanceof HTMLCanvasElement && el.width > 0) {
          frameSources.set(l.id, el);
        }
      }
      perfRef.current.vidInTime = _vidInTime;
      perfRef.current.vidReady = _vidReady;
      perfRef.current.vidMounted = container.querySelectorAll("video").length;
      const resolveSrc = async (l: Layer): Promise<string | null> => {
        const s = l.source;
        if (!s || s === "auto" || s === "user" || s === "") return null;
        if (
          s.startsWith("http://") ||
          s.startsWith("https://") ||
          s.startsWith("data:") ||
          s.startsWith("blob:")
        )
          return s;
        return convertFileSrc(s);
      };
      setCompositionCanvasDimensions(dims.width, dims.height);
      // 画面全体エフェクト（shake/zoom-punch/blur-burst/flash/vignette）も本物の書き出しと
      // 同じ順序で適用し、書き出し表示を export と一致させる（exportTemplateWebCodecs と同コード）。
      const fx = computeScreenEffects(layersRef.current, t, dims.width / 360);
      // §C transition（fade-black/zoom）。export と同式・同窓。
      const tr = computeTransition(transitionsRef.current, t);
      perfRef.current.blackAlpha = tr.blackAlpha;
      perfRef.current.flashAlpha = fx.flashAlpha;
      const totalScale = fx.scale * tr.scale;
      const cx = dims.width / 2;
      const cy = dims.height / 2;
      octx.save();
      if (fx.dx !== 0 || fx.dy !== 0) {
        octx.fillStyle = "#000";
        octx.fillRect(0, 0, dims.width, dims.height);
        octx.translate(fx.dx, fx.dy);
      }
      if (totalScale !== 1) {
        octx.translate(cx, cy);
        octx.scale(totalScale, totalScale);
        octx.translate(-cx, -cy);
      }
      const octxFilterParts: string[] = [];
      if (fx.blurPx > 0) octxFilterParts.push(`blur(${fx.blurPx.toFixed(2)}px)`);
      if (fx.gradeFilter) octxFilterParts.push(fx.gradeFilter);
      if (octxFilterParts.length > 0) octx.filter = octxFilterParts.join(" ");
      const _layT0 = performance.now();
      await renderLayersOnContext(octx, curLayers, resolveSrc, {
        atTimeSec: t,
        applyAnim: true,
        transparent: false,
        videoFrameSources: frameSources.size > 0 ? frameSources : undefined,
        // 停止/スクラブ中は手書きを全文表示（編集レイアウト安定）。再生中は時刻どおり書き進む。
        staticHandwrite: !isPlayingRef.current,
        // 再生中は縮小補間を "low" に落として軽量化（重い素材での音声プツプツ/コマ落ち対策）。
        // 停止/スクラブ中は "high" で綺麗に見せる（負荷は 1 フレーム分のみ）。
        hqSmoothing: !isPlayingRef.current,
        groups: groupsRef.current,
        cameras: camerasRef.current,
      });
      _layersMs = performance.now() - _layT0;
      perfRef.current.layerCount = curLayers.length;
      octx.filter = "none";
      octx.restore();
      if (fx.flashAlpha > 0) {
        octx.save();
        octx.globalAlpha = Math.min(1, fx.flashAlpha);
        octx.fillStyle = "#fff";
        octx.fillRect(0, 0, dims.width, dims.height);
        octx.restore();
      }
      if (fx.vignetteAlpha > 0) {
        const a = Math.min(1, fx.vignetteAlpha);
        const grad = octx.createRadialGradient(
          cx,
          cy,
          0,
          cx,
          cy,
          Math.hypot(cx, cy),
        );
        grad.addColorStop(0, "rgba(0,0,0,0)");
        grad.addColorStop(0.5, "rgba(0,0,0,0)");
        grad.addColorStop(1, `rgba(0,0,0,${a.toFixed(3)})`);
        octx.save();
        octx.fillStyle = grad;
        octx.fillRect(0, 0, dims.width, dims.height);
        octx.restore();
      }
      // §B colorgrade tint: 単色を alpha で被せる
      if (fx.tintColor && fx.tintAlpha > 0) {
        octx.save();
        octx.globalAlpha = Math.min(1, fx.tintAlpha);
        octx.fillStyle = fx.tintColor;
        octx.fillRect(0, 0, dims.width, dims.height);
        octx.restore();
      }
      // §B grain: フィルム粒子 / 走査線
      if (fx.grain) {
        drawGrain(octx, fx.grain, dims.width, dims.height, dims.width / 360, t);
      }
      // §C fade-black: 黒被せ（atSec 中心で最大＝暗転）
      if (tr.blackAlpha > 0) {
        octx.save();
        octx.globalAlpha = Math.min(1, tr.blackAlpha);
        octx.fillStyle = "#000";
        octx.fillRect(0, 0, dims.width, dims.height);
        octx.restore();
      }
      // §C wipe/push/dissolve: 窓中は前シーン(ts)を別途描画して後シーンと合成
      // （export は窓開始フレームを保持。preview は時刻独立なので ts を再レンダリング＝窓中だけ負荷増）
      const snapTr = computeSnapshotTransition(transitionsRef.current, t);
      perfRef.current.snap = !!snapTr;
      if (snapTr) {
        const vfs = frameSources.size > 0 ? frameSources : undefined;
        // groupId/layerIds 指定があれば対象レイヤー群だけを push（背景だけ入替など）。
        // scoped を行えなければ（指定なし/対象0件）従来の画面全体スナップにフォールバック。
        const scoped = await composeScopedSnapshotTransition(
          octx,
          curLayers,
          resolveSrc,
          snapTr,
          dims.width,
          dims.height,
          {
            atTimeSec: t,
            videoFrameSources: vfs,
            groups: groupsRef.current,
            cameras: camerasRef.current,
            hqSmoothing: !isPlayingRef.current,
            staticHandwrite: !isPlayingRef.current,
          },
        );
        if (!scoped) {
          const prev = new OffscreenCanvas(dims.width, dims.height);
          const cur = new OffscreenCanvas(dims.width, dims.height);
          const pctx = prev.getContext("2d");
          const cctx = cur.getContext("2d");
          if (pctx && cctx) {
            // 前シーン(ts=切替直前) と 後シーン(te=切替直後) を別々に描いて窓全体で遷移
            await renderLayersOnContext(pctx, curLayers, resolveSrc, {
              atTimeSec: snapTr.ts,
              applyAnim: true,
              transparent: false,
              videoFrameSources: vfs,
              hqSmoothing: !isPlayingRef.current,
            });
            await renderLayersOnContext(cctx, curLayers, resolveSrc, {
              atTimeSec: snapTr.te,
              applyAnim: true,
              transparent: false,
              videoFrameSources: vfs,
              hqSmoothing: !isPlayingRef.current,
            });
            octx.clearRect(0, 0, dims.width, dims.height);
            composeSnapshotTransition(
              octx,
              prev,
              cur,
              snapTr,
              dims.width,
              dims.height,
            );
          }
        }
      }
      // 一括 blit（途中状態を可視 Canvas に出さない）
      if (visible.width !== dims.width) visible.width = dims.width;
      if (visible.height !== dims.height) visible.height = dims.height;
      const vctx = visible.getContext("2d");
      if (vctx) {
        vctx.clearRect(0, 0, dims.width, dims.height);
        vctx.drawImage(off, 0, 0);
      }
    } catch (e) {
      console.warn("[export-preview] render failed", e);
    } finally {
      renderingRef.current = false;
      const totalMs = performance.now() - _perfT0;
      const p = perfRef.current;
      const a = p.emaTotal === 0 ? 1 : 0.2; // 初回は即反映、以降は EMA
      p.emaTotal = p.emaTotal * (1 - a) + totalMs * a;
      p.emaLayers = p.emaLayers * (1 - a) + _layersMs * a;
    }
  }, [aspect, playheadRef]);

  // 再生中: rAF ループで動画も含めて毎フレーム合成（ネイティブ再生を借りるのでバッファ不要）
  useEffect(() => {
    if (!showExport || !isPlaying) return;
    let active = true;
    let raf = 0;
    perfRef.current.lastTick = 0;
    const tick = async () => {
      if (!active) return;
      const now = performance.now();
      const p = perfRef.current;
      if (p.lastTick > 0) {
        const fps = 1000 / Math.max(1, now - p.lastTick);
        p.emaFps = p.emaFps === 0 ? fps : p.emaFps * 0.8 + fps * 0.2;
      }
      p.lastTick = now;
      await renderExportFrame();
      if (active) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      active = false;
      cancelAnimationFrame(raf);
    };
  }, [showExport, isPlaying, renderExportFrame]);

  // 性能メーター: Shift+P で ON/OFF（入力欄ではない時のみ）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable);
      if (!typing && e.shiftKey && (e.key === "P" || e.key === "p")) {
        e.preventDefault();
        setShowPerf((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 性能メーター表示の更新（ON の間だけ 4回/秒）。
  useEffect(() => {
    if (!showPerf) {
      setPerfText("");
      return;
    }
    const id = window.setInterval(() => {
      const p = perfRef.current;
      setPerfText(
        `合成 ${p.emaTotal.toFixed(1)}ms · ${p.emaFps.toFixed(0)}fps · ${p.layerCount}層 · 動画 ${p.vidReady}/${p.vidInTime} · 黒${p.blackAlpha.toFixed(2)}${p.snap ? " WIPE" : ""}${p.flashAlpha > 0 ? ` 白${p.flashAlpha.toFixed(2)}` : ""}`,
      );
    }, 250);
    return () => window.clearInterval(id);
  }, [showPerf]);

  // 停止中: 時刻/レイヤー変更時に 1 度だけ合成（編集も即反映。idle で CPU を回さない）
  useEffect(() => {
    if (!showExport || isPlaying) return;
    void renderExportFrame();
  }, [showExport, isPlaying, currentTimeSec, layers, editingLayerId, renderExportFrame]);

  // 手書き（筆順）字形データの先読み: handwrite レイヤーの本文が変わったら必要グリフを
  // ロードし、揃ったら 1 度再合成（合成キャンバスがストロークを描けるようになる）。
  const handwriteKey = layers
    .filter((l) => l.handwrite)
    .map((l) => l.text ?? "")
    .join("");
  useEffect(() => {
    let cancelled = false;
    void preloadHandwriteLayers(layersRef.current).then(() => {
      if (!cancelled) void renderExportFrame();
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handwriteKey, renderExportFrame]);

  return (
    <div
      ref={wrapperRef}
      className="w-full h-full flex justify-center items-start"
    >
    <div
      ref={containerRef}
      onMouseDown={handleBackgroundClick}
      className="relative overflow-hidden shadow-lg"
      style={{
        width: CANVAS_W_PX,
        height: CANVAS_H_PX,
        background: canvasBackground,
      }}
    >
      {showGrid && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            zIndex: 9999,
            backgroundImage:
              "linear-gradient(to right, rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.08) 1px, transparent 1px)",
            backgroundSize: `${CANVAS_W_PX / 10}px ${CANVAS_H_PX / 10}px`,
          }}
        />
      )}
      {/* 性能メーター（Shift+P）: 合成時間・FPS を表示してボトルネック特定用 */}
      {showPerf && perfText && (
        <div
          style={{
            position: "absolute",
            top: 4,
            left: 4,
            zIndex: 10001,
            pointerEvents: "none",
            background: "rgba(0,0,0,0.7)",
            color: perfRef.current.emaTotal > 16.7 ? "#ff6b6b" : "#7CFC9B",
            font: "11px ui-monospace, monospace",
            padding: "2px 6px",
            borderRadius: 4,
            whiteSpace: "nowrap",
          }}
        >
          {perfText}
        </div>
      )}
      {/* セーフエリアガイド（プレビュー専用）: 外=action-safe(3.5%余白) / 内=title-safe(5%余白) */}
      {showSafeArea && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            zIndex: 9999,
          }}
        >
          <div
            style={{
              position: "absolute",
              left: "3.5%",
              top: "3.5%",
              right: "3.5%",
              bottom: "3.5%",
              border: "1px solid rgba(255, 215, 0, 0.55)",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: "5%",
              top: "5%",
              right: "5%",
              bottom: "5%",
              border: "1px solid rgba(255, 90, 90, 0.6)",
            }}
          />
        </div>
      )}
      {/* レイヤー群は shake 用 inner div でラップ（グリッド/Moveable は揺らさない） */}
      <div style={screenShakeStyle}>
        {sortedLayers(layers)
          .filter((layer) => {
            if (
              layer.hidden ||
              layer.type === "audio" ||
              layer.type === "effect"
            )
              return false;
            // 再生中: 合成キャンバス(前面)が全レイヤーを描くので、裏の DOM レイヤーは見えない。
            // フレーム取得が要る video/character だけ DOM に残し、それ以外（image/text/color/
            // shape/comment）は再生中マウントしない → 毎フレームの React 再描画を激減（品質そのまま）。
            if (
              isPlaying &&
              layer.type !== "video" &&
              layer.type !== "character"
            ) {
              return false;
            }
            // 動画は先読みのため startSec の手前からマウント（canvas は in-time のみ描画）。
            if (layer.type === "video" && currentTimeSec !== undefined) {
              return (
                currentTimeSec >= layer.startSec - VIDEO_PRELOAD_LEAD_SEC &&
                currentTimeSec < layer.endSec + VIDEO_PRELOAD_TAIL_SEC
              );
            }
            return isInTime(layer);
          })
          .map((layer) => (
            <LayerView
              key={layer.id}
              layer={layer}
              isSelected={selectedSet.has(layer.id)}
              isPrimary={layer.id === selectedLayerId}
              dimmed={false}
              canvasWPx={CANVAS_W_PX}
              canvasHPx={CANVAS_H_PX}
              currentTimeSec={currentTimeSec ?? 0}
              isPlaying={isPlaying}
              cssFilter=""
              allLayers={layers}
              editingLayerId={editingLayerId}
              onSelect={(modifier) => onLayerSelect(layer.id, modifier)}
              onUpdate={(patch) => onLayerUpdate(layer.id, patch)}
              onRefReady={(el) => {
                if (layer.id === selectedLayerId) {
                  targetRef.current = el;
                  forceRerender((n) => n + 1);
                }
              }}
              onEditStart={(id) => setEditingLayerId(id)}
              onEditEnd={() => setEditingLayerId(null)}
            />
          ))}
      </div>

      {/* 書き出し表示: 実 export 経路の 1 フレームを前面に表示。クリックは透過（pointer 透過）して
          裏の DOM レイヤーに届くので、ON のまま選択・ドラッグ・リサイズができる（ハンドルは CSS で前面）。
          インライン文字編集中は編集レイヤーだけ Canvas から除外し、DOM textarea を前面に重ねる。 */}
      {showExport && (
        <canvas
          ref={exportCanvasRef}
          style={{
            position: "absolute",
            inset: 0,
            width: CANVAS_W_PX,
            height: CANVAS_H_PX,
            pointerEvents: "none",
            background: "#000",
            zIndex: 9995,
          }}
        />
      )}

      {/* 書き出し表示中は DOM レイヤーが Canvas の裏に隠れるので、複数選択（プライマリ以外）の
          選択枠を Canvas の上に重ねて見せる。プライマリは Moveable が前面に出すので不要。 */}
      {showExport &&
        !editingLayerId &&
        layers
          .filter(
            (l) =>
              selectedSet.has(l.id) &&
              l.id !== selectedLayerId &&
              isInTime(l) &&
              !l.hidden,
          )
          .map((l) => (
            <div
              key={`selbox_${l.id}`}
              style={{
                position: "absolute",
                left: (l.x / 100) * CANVAS_W_PX,
                top: (l.y / 100) * CANVAS_H_PX,
                width: (l.width / 100) * CANVAS_W_PX,
                height: (l.height / 100) * CANVAS_H_PX,
                transform: l.rotation ? `rotate(${l.rotation}deg)` : undefined,
                outline: "2px solid rgba(59, 130, 246, 0.9)",
                outlineOffset: "-2px",
                pointerEvents: "none",
                zIndex: 9996,
              }}
            />
          ))}


      {/* 画面全体エフェクト overlay: flash(白) / vignette-pulse(径方向の黒)。
          layer ラップ(inner div)の上、グリッド(zIndex 9999)の下に重ねる。 */}
      {fx.flashAlpha > 0 && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            zIndex: 9998,
            background: "#fff",
            opacity: Math.min(1, fx.flashAlpha),
          }}
        />
      )}
      {fx.vignetteAlpha > 0 && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            zIndex: 9998,
            background: `radial-gradient(circle at center, rgba(0,0,0,0) 50%, rgba(0,0,0,${Math.min(
              1,
              fx.vignetteAlpha,
            ).toFixed(3)}) 100%)`,
          }}
        />
      )}

      {/* 音声レイヤー（視覚なし、<audio> を playhead 同期）。
          startSec の手前から先読みマウント（発音は AudioLayerPlayer が in-time 判定）。 */}
      {layers
        .filter((l) => l.type === "audio" && !l.hidden && isAudioMounted(l))
        .map((layer) => (
          <AudioLayerPlayer
            key={layer.id}
            layer={layer}
            currentTimeSec={currentTimeSec ?? 0}
            isPlaying={isPlaying}
            allLayers={layers}
          />
        ))}

      {selected && targetRef.current && (
        <Moveable
          // レイヤーの位置/サイズが変わるたびに Moveable を作り直して内部状態を同期
          key={`mv_${selected.id}_${selected.x.toFixed(2)}_${selected.y.toFixed(2)}_${selected.width.toFixed(2)}_${selected.height.toFixed(2)}_${selected.rotation ?? 0}`}
          target={targetRef.current}
          draggable
          resizable
          rotatable
          origin={false}
          // デフォルトは自由変形。Shift 押下中のみアスペクト比固定。
          keepRatio={shiftHeld}
          throttleDrag={0}
          throttleResize={0}
          throttleRotate={0}
          // 画面端・中央・他レイヤーにスナップ
          snappable
          snapThreshold={8}
          snapDirections={{
            top: true,
            right: true,
            bottom: true,
            left: true,
            center: true,
            middle: true,
          }}
          elementSnapDirections={{
            top: true,
            right: true,
            bottom: true,
            left: true,
            center: true,
            middle: true,
          }}
          verticalGuidelines={[0, CANVAS_W_PX / 2, CANVAS_W_PX]}
          horizontalGuidelines={[0, CANVAS_H_PX / 2, CANVAS_H_PX]}
          elementGuidelines={
            containerRef.current
              ? Array.from(
                  containerRef.current.querySelectorAll<HTMLElement>(
                    "[data-layer-id]",
                  ),
                ).filter((el) => el.dataset.layerId !== selected.id)
              : []
          }
          onDrag={(e) => {
            e.target.style.transform = e.transform;
            // 掴んだレイヤーの暫定位置を Canvas に反映して追従（DOM へ切り替えない）
            const baseLeft = (selected.x / 100) * CANVAS_W_PX;
            const baseTop = (selected.y / 100) * CANVAS_H_PX;
            dragOverrideRef.current = {
              id: selected.id,
              x: pxToPercent(baseLeft + (e.translate?.[0] ?? 0), "w"),
              y: pxToPercent(baseTop + (e.translate?.[1] ?? 0), "h"),
            };
            void renderExportFrame();
          }}
          onDragEnd={(e) => {
            const el = e.target as HTMLElement;
            const dx = e.lastEvent?.translate?.[0] ?? 0;
            const dy = e.lastEvent?.translate?.[1] ?? 0;
            const baseLeft = (selected.x / 100) * CANVAS_W_PX;
            const baseTop = (selected.y / 100) * CANVAS_H_PX;
            const finalX = baseLeft + dx;
            const finalY = baseTop + dy;
            // transform をリセット（回転は保持）
            el.style.transform = selected.rotation
              ? `rotate(${selected.rotation}deg)`
              : "";
            dragOverrideRef.current = null;
            onLayerUpdate(selected.id, {
              x: pxToPercent(finalX, "w"),
              y: pxToPercent(finalY, "h"),
            });
          }}
          onResize={(e) => {
            e.target.style.width = `${e.width}px`;
            e.target.style.height = `${e.height}px`;
            e.target.style.transform = e.drag.transform;
            const baseLeft = (selected.x / 100) * CANVAS_W_PX;
            const baseTop = (selected.y / 100) * CANVAS_H_PX;
            dragOverrideRef.current = {
              id: selected.id,
              x: pxToPercent(baseLeft + (e.drag?.translate?.[0] ?? 0), "w"),
              y: pxToPercent(baseTop + (e.drag?.translate?.[1] ?? 0), "h"),
              width: pxToPercent(e.width, "w"),
              height: pxToPercent(e.height, "h"),
            };
            void renderExportFrame();
          }}
          onResizeEnd={(e) => {
            const el = e.target as HTMLElement;
            const widthPx = parseFloat(el.style.width);
            const heightPx = parseFloat(el.style.height);
            const dx = e.lastEvent?.drag?.translate?.[0] ?? 0;
            const dy = e.lastEvent?.drag?.translate?.[1] ?? 0;
            const baseLeft = (selected.x / 100) * CANVAS_W_PX;
            const baseTop = (selected.y / 100) * CANVAS_H_PX;
            const finalX = baseLeft + dx;
            const finalY = baseTop + dy;
            el.style.transform = selected.rotation
              ? `rotate(${selected.rotation}deg)`
              : "";
            dragOverrideRef.current = null;
            onLayerUpdate(selected.id, {
              x: pxToPercent(finalX, "w"),
              y: pxToPercent(finalY, "h"),
              width: pxToPercent(widthPx, "w"),
              height: pxToPercent(heightPx, "h"),
            });
          }}
          onRotate={(e) => {
            e.target.style.transform = e.drag.transform;
            dragOverrideRef.current = {
              id: selected.id,
              rotation: e.rotate ?? selected.rotation ?? 0,
            };
            void renderExportFrame();
          }}
          onRotateEnd={(e) => {
            dragOverrideRef.current = null;
            onLayerUpdate(selected.id, {
              rotation: e.lastEvent?.rotate ?? 0,
            });
          }}
        />
      )}
    </div>
    </div>
  );
}

interface LayerViewProps {
  layer: Layer;
  isSelected: boolean;
  isPrimary?: boolean;
  dimmed?: boolean;
  canvasWPx: number;
  canvasHPx: number;
  currentTimeSec: number;
  isPlaying: boolean;
  cssFilter?: string;
  /** リップシンク等で他レイヤー (音声等) を参照するためのテンプレ全レイヤー */
  allLayers?: Layer[];
  /** インライン編集中のレイヤー id (キャンバス上テキスト編集) */
  editingLayerId?: string | null;
  onSelect: (modifier?: "shift" | "ctrl" | null) => void;
  onUpdate: (patch: Partial<Layer>) => void;
  onRefReady: (el: HTMLDivElement | null) => void;
  /** インライン編集の開始 / 終了 */
  onEditStart?: (id: string) => void;
  onEditEnd?: () => void;
}

function LayerView({
  layer: rawLayer,
  isSelected,
  isPrimary = false,
  dimmed = false,
  canvasWPx,
  canvasHPx,
  currentTimeSec,
  isPlaying,
  cssFilter,
  allLayers,
  editingLayerId,
  onSelect,
  onUpdate,
  onRefReady,
  onEditStart,
  onEditEnd,
}: LayerViewProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isSelected) onRefReady(ref.current);
  }, [isSelected, onRefReady]);

  // 再生中はキーフレーム補間値で表示（編集中は静的値のまま、ドラッグ等の操作を妨げない）。
  // ※ 書き出し表示 ON 時の見た目は Canvas(renderExportFrame=export 経路) が描くので、ここは
  //   主に操作枠(Moveable ターゲット)の位置同期用。kfs(curio アニメ仕様) 優先で評価する。
  const layer: Layer =
    isPlaying && (hasAnimKfs(rawLayer) || hasMotionPath(rawLayer))
      ? (() => {
          // kfs(§4) / motionPath(§8) を合成。x,y は motionPath 優先（§8）。export
          // applyKeyframesAtTime と同じ合成にする（操作枠の位置を書き出しと一致させる）。
          const tRel = currentTimeSec - rawLayer.startSec;
          let x = rawLayer.x;
          let y = rawLayer.y;
          let rotation = rawLayer.rotation ?? 0;
          let opacity = rawLayer.opacity ?? 1;
          let wPct = rawLayer.width;
          let hPct = rawLayer.height;
          if (hasAnimKfs(rawLayer)) {
            const s = sampleAnimKfs(rawLayer, tRel);
            x = s.x;
            y = s.y;
            rotation = s.rotation;
            opacity = s.opacity;
            wPct = s.width !== undefined ? s.width : rawLayer.width * s.scale;
            hPct = s.height !== undefined ? s.height : rawLayer.height * s.scale;
          }
          if (hasMotionPath(rawLayer)) {
            const p = sampleMotionPath(rawLayer, tRel);
            x = p.x;
            y = p.y;
          }
          const adj = applyAnchorOffset(
            rawLayer.anchor,
            x,
            y,
            rawLayer.width,
            rawLayer.height,
            wPct,
            hPct,
          );
          return {
            ...rawLayer,
            x: adj.x,
            y: adj.y,
            width: wPct,
            height: hPct,
            rotation,
            opacity,
          };
        })()
      : isPlaying && rawLayer.keyframes
        ? (() => {
            const s = sampleLayerAt(rawLayer, currentTimeSec);
            return {
              ...rawLayer,
              x: s.x,
              y: s.y,
              width: s.width,
              height: s.height,
              rotation: s.rotation,
              opacity: s.opacity,
            };
          })()
        : rawLayer;

  const leftPx = (layer.x / 100) * canvasWPx;
  const topPx = (layer.y / 100) * canvasHPx;
  const widthPx = (layer.width / 100) * canvasWPx;
  const heightPx = (layer.height / 100) * canvasHPx;

  // 形状の borderRadius。外側（クリップ）と内側（border 描画）で共有する
  // layerComposer が borderRadius * (FINAL_W/360) で描画するため、プレビューも canvasWPx/360 倍する
  const dimScale = canvasWPx / 360;
  let borderRadius: string | number | undefined;
  if (layer.shape === "circle") {
    borderRadius = "50%";
  } else if (layer.shape === "rounded") {
    borderRadius = (layer.borderRadius ?? 12) * dimScale;
  }

  const outerStyle: React.CSSProperties = {};
  if (borderRadius !== undefined) outerStyle.borderRadius = borderRadius;

  const baseOpacity = layer.opacity ?? 1;
  // 入退場アニメ / motion / ambient は内側ラッパーに集約して Moveable の外側矩形を安定させる
  const anim = computeLayerAnimStyle(layer, currentTimeSec);
  // ambient の px 振幅は design(360) 基準 → プレビュー解像度 canvasWPx へ換算
  // (export computeCanvasAnim の pxScale=FINAL_W/360 と一致させる)
  const ambient = computeLayerAmbientStyle(layer, currentTimeSec, canvasWPx / 360);
  // 時間外（dimmed）レイヤーは「位置を示す点線アウトラインのみ」にして、
  // 本体（fill / border / テキスト / 画像内容）は描かない。
  // 旧実装は本体を 25% 不透明で薄描画していたが、export(layerComposer) は
  // 入退場アニメに乗せて startSec 前は本体を一切描かない → preview だけ枠線が定位置に居座る
  // 不整合になっていた（白カードの comment は fill が埋もれ濃い border だけ残って見える）。
  const effectiveOpacity = baseOpacity * anim.opacity * ambient.opacity;
  if (!dimmed && effectiveOpacity !== 1) {
    outerStyle.opacity = effectiveOpacity;
  }
  if (dimmed) {
    outerStyle.outline = "2px dashed rgba(255,255,255,0.35)";
    outerStyle.outlineOffset = "-2px";
  }

  // fly-in-*（画面端から滑り込む）/ fly-out-*（画面端へ押し出す）: anim を内側ラッパーに乗せる
  // slide-* と違い、外箱 overflow:hidden の「外側」で箱ごと動かす（移動中もクリップされず全体が
  // 見える）。移動量は box の最終位置から画面端までの実 px 距離。式は export と共有（computeFlyOffset）。
  const fly = computeFlyOffset(
    layer,
    currentTimeSec,
    leftPx,
    topPx,
    widthPx,
    heightPx,
    canvasWPx,
    canvasHPx,
  );
  const flyTransform =
    fly.tx !== 0 || fly.ty !== 0
      ? `translate(${fly.tx.toFixed(2)}px, ${fly.ty.toFixed(2)}px)`
      : undefined;

  // 外側に乗せるのは rotation と fly-in の平行移動（Moveable の rotatable が扱える）
  const outerTransform =
    [flyTransform, layer.rotation ? `rotate(${layer.rotation}deg)` : undefined]
      .filter(Boolean)
      .join(" ") || undefined;

  // 吹き出し（comment + bubble）はしっぽが枠外に出られるよう overflow を visible にする
  const isBubbleLayer = layer.type === "comment" && !!layer.bubble;
  const style: React.CSSProperties = {
    position: "absolute",
    left: leftPx,
    top: topPx,
    width: widthPx,
    height: heightPx,
    transform: outerTransform,
    filter: cssFilter || undefined,
    cursor: "pointer",
    userSelect: "none",
    overflow: isBubbleLayer ? "visible" : "hidden",
    // 編集中レイヤーは Canvas(9995) より前面に出して textarea を見せる
    zIndex:
      editingLayerId === layer.id && layer.type === "comment"
        ? 9997
        : layer.zIndex,
    ...outerStyle,
  };

  // エクスポート側（layerComposer.drawText）が fontSize * (FINAL_W/360) = fontSize * 3 で
  // 1080×1920 に描画するため、プレビューも同じ係数 (canvasWPx / 360) を掛けないと見た目が一致しない。
  const fontScale = canvasWPx / 360;
  const inner = renderLayerContent(
    layer,
    currentTimeSec,
    isPlaying,
    fontScale,
    allLayers,
    widthPx,
    heightPx,
  );
  const motionTransform = computeLayerMotionTransform(layer, currentTimeSec);
  // 入退場 / motion / ambient の transform / filter を合成した内側 style
  const innerTransformParts: string[] = [];
  if (anim.transform) innerTransformParts.push(anim.transform);
  if (motionTransform) innerTransformParts.push(motionTransform);
  if (ambient.transform) innerTransformParts.push(ambient.transform);
  const innerTransform = innerTransformParts.join(" ");
  const innerFilterParts: string[] = [];
  if (anim.filter) innerFilterParts.push(anim.filter);
  if (ambient.filter) innerFilterParts.push(ambient.filter);
  // §A6: per-layer filter（glow/blur/shadow）。export drawLayer の ctx.filter と同式。
  const layerFilterCss = computeLayerFilterCss(layer, canvasWPx / 360);
  if (layerFilterCss) innerFilterParts.push(layerFilterCss);
  const innerFilter = innerFilterParts.join(" ");

  // テキスト系レイヤー（comment）は renderAnimatedText 内で border を適用するためここでは省く
  // layerComposer が border.width * (FINAL_W/360) で描画するためプレビューも同じ係数に
  // 時間外（dimmed）は本体を描かない方針なので border の boxShadow も出さない
  const innerBoxShadow =
    !dimmed && layer.border && layer.type !== "comment"
      ? `inset 0 0 0 ${(layer.border.width * dimScale).toFixed(2)}px ${layer.border.color}`
      : undefined;

  const innerStyle: React.CSSProperties = {
    width: "100%",
    height: "100%",
    borderRadius,
    boxShadow: innerBoxShadow,
    transform: innerTransform || undefined,
    transformOrigin: anim.transformOrigin ?? "center center",
    filter: innerFilter || undefined,
  };

  // 複数選択 (プライマリではない) には細いアウトラインを出す
  const multiSelectOutline =
    isSelected && !isPrimary
      ? "2px solid rgba(59, 130, 246, 0.9)"
      : undefined;
  const styleWithSelection: React.CSSProperties = multiSelectOutline
    ? { ...style, outline: multiSelectOutline, outlineOffset: "-2px" }
    : style;

  const isEditingThis =
    editingLayerId === layer.id && layer.type === "comment";

  return (
    <div
      ref={ref}
      data-layer-id={layer.id}
      style={styleWithSelection}
      onMouseDown={(e) => {
        e.stopPropagation();
        const modifier = e.shiftKey
          ? "shift"
          : e.ctrlKey || e.metaKey
            ? "ctrl"
            : null;
        onSelect(modifier);
      }}
      onDoubleClick={(e) => {
        if (layer.type === "comment" && onEditStart) {
          e.stopPropagation();
          onEditStart(layer.id);
        }
      }}
    >
      <div style={innerStyle}>
        {isEditingThis ? (
          <CanvasTextEditor
            layer={layer}
            fontScale={fontScale}
            onCommit={(text) => {
              onUpdate({ text });
              onEditEnd?.();
            }}
            onCancel={() => onEditEnd?.()}
          />
        ) : dimmed ? null : (
          // 時間外レイヤーは本体を描かない（点線アウトラインだけで位置を示す）
          inner
        )}
      </div>
      {/* 吹き出しのしっぽ先端ドラッグハンドル（選択中 & bubble.tail あり時のみ） */}
      {isSelected &&
        layer.type === "comment" &&
        layer.bubble?.tail && (
          <TailHandle
            tipX={layer.bubble.tail.tipX}
            tipY={layer.bubble.tail.tipY}
            onChange={(x, y) => {
              const bubble = layer.bubble;
              if (!bubble?.tail) return;
              onUpdate({
                bubble: {
                  ...bubble,
                  tail: { ...bubble.tail, tipX: x, tipY: y },
                },
              });
            }}
          />
        )}
    </div>
  );
}

/**
 * comment レイヤーをキャンバス上で直接編集するための textarea。
 * - フォントは layer.fontFamily / layer.fontSize で揃える
 * - Esc でキャンセル / Enter (Shift なし) で確定 / blur で確定
 */
function CanvasTextEditor({
  layer,
  fontScale,
  onCommit,
  onCancel,
}: {
  layer: Layer;
  fontScale: number;
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(layer.text ?? "");

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.focus();
    // テキスト全選択 (上書き入力しやすく)
    el.select();
  }, []);

  return (
    <textarea
      ref={taRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Enter は通常通り改行 (preventDefault しない)
        // Esc キャンセル / Ctrl+Enter で確定
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          onCommit(draft);
        }
      }}
      onBlur={() => onCommit(draft)}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        background: "rgba(0, 0, 0, 0.15)",
        color: layer.fontColor ?? "#ffffff",
        // renderAnimatedText と同じ式: fontSize * (canvasWPx / 360)
        // 編集中も確定後と同じサイズで表示するために fontScale をそのまま掛ける
        fontSize: `${(layer.fontSize ?? 48) * fontScale}px`,
        fontFamily: layer.fontFamily ?? "inherit",
        textAlign: "center",
        border: "2px solid #3b82f6",
        outline: "none",
        resize: "none",
        // renderAnimatedText と同じく design(360) 基準でスケール（export と改行位置を揃える）
        padding: 4 * fontScale,
        boxSizing: "border-box",
      }}
    />
  );
}

function renderLayerContent(
  layer: Layer,
  currentTimeSec: number,
  isPlaying: boolean,
  fontScale?: number,
  allLayers?: Layer[],
  widthPx?: number,
  heightPx?: number,
): React.ReactNode {
  switch (layer.type) {
    case "color":
      if (layer.shape === "arc") {
        return <ArcShapeSvg layer={layer} defaultFill="#333" currentTimeSec={currentTimeSec} />;
      }
      if (isMarkerShape(layer.shape)) {
        return (
          <MarkerShapeSvg
            layer={layer}
            currentTimeSec={currentTimeSec}
            isPlaying={isPlaying}
            fontScale={fontScale ?? 0.25}
            widthPx={widthPx}
            heightPx={heightPx}
          />
        );
      }
      return (
        <div
          style={{
            width: "100%",
            height: "100%",
            background: layer.fillColor ?? "#333",
          }}
        />
      );
    case "shape":
      if (layer.shape === "arc") {
        return <ArcShapeSvg layer={layer} defaultFill="#FFE600" currentTimeSec={currentTimeSec} />;
      }
      if (isMarkerShape(layer.shape)) {
        return (
          <MarkerShapeSvg
            layer={layer}
            currentTimeSec={currentTimeSec}
            isPlaying={isPlaying}
            fontScale={fontScale ?? 0.25}
            widthPx={widthPx}
            heightPx={heightPx}
          />
        );
      }
      return (
        <div
          style={{
            width: "100%",
            height: "100%",
            background: layer.fillColor ?? "#FFE600",
          }}
        />
      );
    case "image": {
      const resolved = resolveSrcForWebview(layer.source);
      if (!resolved) {
        return (
          <div
            style={{
              width: "100%",
              height: "100%",
              background: `repeating-linear-gradient(45deg, #444, #444 8px, #555 8px, #555 16px)`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#999",
              fontSize: 10,
            }}
          >
            🖼 画像(未設定)
          </div>
        );
      }
      // crop 対応: 枠を overflow:hidden にして、内部の img を crop 分だけ拡大＋ネガオフセットで
      // 「クロップ矩形だけが枠に見える」ように配置する。
      const crop = layer.crop;
      const cw = crop ? Math.max(1, crop.width) : 100;
      const ch = crop ? Math.max(1, crop.height) : 100;
      const cx = crop ? crop.x : 0;
      const cy = crop ? crop.y : 0;
      return (
        <div
          style={{
            width: "100%",
            height: "100%",
            position: "relative",
            overflow: "hidden",
          }}
        >
          <img
            src={resolved}
            style={{
              position: "absolute",
              width: `${(100 * 100) / cw}%`,
              height: `${(100 * 100) / ch}%`,
              top: `${(-cy * 100) / ch}%`,
              left: `${(-cx * 100) / cw}%`,
              objectFit: "cover",
              pointerEvents: "none",
              userSelect: "none",
            }}
            draggable={false}
            alt=""
          />
        </div>
      );
    }
    case "video": {
      return (
        <VideoLayerContent
          layer={layer}
          currentTimeSec={currentTimeSec}
          isPlaying={isPlaying}
        />
      );
    }
    case "icon": {
      // 同梱 Lucide 線アイコン or inline SVG(layer.svg) を inline <svg> で contain 描画
      // （同期・export の drawIconOnCanvas と一致）。
      const color = layer.fillColor ?? "#FFFFFF";
      const markup = buildIconSvgMarkup(
        layer.icon,
        color,
        layer.iconStrokeWidth ?? 2,
        layer.svg,
      );
      if (!markup) {
        // 未知名 / inline 解釈不能: export と同じ「見える placeholder」（破線四角＋名前）。
        const label = (layer.icon ?? "").trim() || (layer.svg ? "svg?" : "icon?");
        return (
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: `2px dashed ${color}`,
              opacity: 0.7,
              color,
              fontSize: 10,
              textAlign: "center",
              overflow: "hidden",
              boxSizing: "border-box",
            }}
          >
            {label}
          </div>
        );
      }
      return (
        <div
          style={{ width: "100%", height: "100%" }}
          dangerouslySetInnerHTML={{ __html: markup }}
        />
      );
    }
    case "comment":
      // 手書き（筆順）は合成キャンバス（書き出し経路 drawHandwriteShape）が描く。
      // DOM 側は描かず操作枠のみ（particles/speedlines と同じ）。二重実装を避け preview=export を保証。
      if (hasHandwrite(layer)) return null;
      if (layer.bubble) {
        // 吹き出しモード: SVG で背景と枠を描画し、その上にテキストを重ねる。
        // padding は内側 renderAnimatedText が design 基準で 1 回適用するため、ここでは付けない
        // （export は textInnerPadding を 1 回のみ。二重 padding を避ける）。
        return (
          <div
            style={{ width: "100%", height: "100%", position: "relative" }}
          >
            <BubbleSvg
              layer={layer}
              fontScale={fontScale ?? 0.25}
              widthPx={widthPx}
              heightPx={heightPx}
            />
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
              }}
            >
              {renderAnimatedText(
                { ...layer, fillColor: undefined, border: undefined },
                currentTimeSec,
                fontScale ?? 0.25,
                widthPx,
                heightPx,
                isPlaying,
              )}
            </div>
          </div>
        );
      }
      return renderAnimatedText(
        layer,
        currentTimeSec,
        fontScale ?? 0.25,
        widthPx,
        heightPx,
        isPlaying,
      );
    case "audio":
      return null;
    case "character": {
      // リップシンク候補を決定:
      // - linkedAudioLayerIds 1 件以上 → その音声群だけ
      // - 0 件 (自動)             → テンプレ内の全音声
      // - 旧 linkedAudioLayerId    → [その 1 本] とみなす (後方互換)
      const explicitIds: string[] =
        layer.linkedAudioLayerIds && layer.linkedAudioLayerIds.length > 0
          ? layer.linkedAudioLayerIds
          : layer.linkedAudioLayerId
          ? [layer.linkedAudioLayerId]
          : [];
      let audiosForLipsync: Layer[] = [];
      if (allLayers) {
        if (explicitIds.length > 0) {
          const idSet = new Set(explicitIds);
          audiosForLipsync = allLayers.filter(
            (l) => l.type === "audio" && !l.hidden && idSet.has(l.id),
          );
        } else {
          audiosForLipsync = allLayers.filter(
            (l) => l.type === "audio" && !l.hidden,
          );
        }
      }
      return (
        <LayerErrorBoundary label={`character: ${layer.id}`}>
          <CharacterLayerContent
            layer={layer}
            currentTimeSec={currentTimeSec}
            isPlaying={isPlaying}
            audiosForLipsync={audiosForLipsync}
          />
        </LayerErrorBoundary>
      );
    }
  }
}

/** 吹き出し背景の SVG 描画コンポーネント */
/**
 * 扇形 / ドーナツセグメントを SVG path で描画する（layer.shape === "arc"）。
 * layerComposer.ts の drawArcShape と同じ仕様:
 * - 0° = 真上（12時方向）、時計回り
 * - 半径は box の min(w,h)/2 を 1.0 とする比率
 * - arcInnerRadius = 0 → 扇形（パイ）、> 0 → ドーナツセグメント
 * viewBox は正方形にして preserveAspectRatio="xMidYMid meet" で box の短辺に合わせる。
 */
function ArcShapeSvg({
  layer,
  defaultFill,
  currentTimeSec,
}: {
  layer: Layer;
  defaultFill: string;
  currentTimeSec?: number;
}) {
  const startDeg = layer.arcStart ?? 0;
  const rawEndDeg = layer.arcEnd ?? 360;
  // arc-sweep: 「1 本のペン先が 0° → 360° を一定速度で進む」方式。
  // 全ての arc-sweep layer は同じ startSec / entryDuration を共有し（curio-gen
  // 側の責任）、それぞれが「ペン先が自分の arcStart～arcEnd を通過するとき」
  // だけ徐々に塗られる。layer ごとに別ペンを持つ方式だとセグメント境界で
  // 「前ペン完了 → 次ペン出現」の切替が見えてしまうが、ペン先方式なら
  // ペン先は止まらず色だけが切り替わるのでシームレスに見える。
  let endDeg = rawEndDeg;
  if (layer.entryAnimation === "arc-sweep" && currentTimeSec !== undefined) {
    const entryDur = Math.max(0.01, layer.entryDuration ?? 0.3);
    const entryEnd = layer.startSec + entryDur;
    if (currentTimeSec < entryEnd) {
      const raw = (currentTimeSec - layer.startSec) / entryDur;
      const p = Math.max(0, Math.min(1, raw));
      // ペン先の角度（0° → 360° linear）。自セグ範囲でクランプして effectiveEnd を決める
      const penAngle = p * 360;
      endDeg = Math.max(startDeg, Math.min(rawEndDeg, penAngle));
    }
  }
  const outerScale = layer.arcOuterRadius ?? 1.0;
  const innerScale = layer.arcInnerRadius ?? 0.0;
  const fill = layer.fillColor ?? defaultFill;

  // 100x100 viewBox、中心 (50,50)、最大半径 50
  const cx = 50;
  const cy = 50;
  const maxR = 50;
  const oR = outerScale * maxR;
  const iR = innerScale * maxR;

  // 0° = 12時方向、時計回り → SVG math 角度 = (deg - 90)° 、sin/cos 通常通り
  const toRad = (deg: number) => ((deg - 90) * Math.PI) / 180;
  const sweep = endDeg - startDeg;
  const isFullCircle = Math.abs(sweep) >= 360 - 0.01;
  const largeArc = Math.abs(sweep) > 180 ? 1 : 0;

  let d = "";
  if (isFullCircle) {
    // 完全な円: A コマンドは始点=終点だと描かれないので 2 弧で構成
    if (iR > 0) {
      d =
        `M ${cx + oR},${cy} A ${oR},${oR} 0 1,1 ${cx - oR},${cy} ` +
        `A ${oR},${oR} 0 1,1 ${cx + oR},${cy} Z ` +
        `M ${cx + iR},${cy} A ${iR},${iR} 0 1,0 ${cx - iR},${cy} ` +
        `A ${iR},${iR} 0 1,0 ${cx + iR},${cy} Z`;
    } else {
      d =
        `M ${cx + oR},${cy} A ${oR},${oR} 0 1,1 ${cx - oR},${cy} ` +
        `A ${oR},${oR} 0 1,1 ${cx + oR},${cy} Z`;
    }
  } else {
    const sRad = toRad(startDeg);
    const eRad = toRad(endDeg);
    const sx = cx + oR * Math.cos(sRad);
    const sy = cy + oR * Math.sin(sRad);
    const ex = cx + oR * Math.cos(eRad);
    const ey = cy + oR * Math.sin(eRad);
    if (iR > 0) {
      const isx = cx + iR * Math.cos(sRad);
      const isy = cy + iR * Math.sin(sRad);
      const iex = cx + iR * Math.cos(eRad);
      const iey = cy + iR * Math.sin(eRad);
      d =
        `M ${sx},${sy} A ${oR},${oR} 0 ${largeArc},1 ${ex},${ey} ` +
        `L ${iex},${iey} A ${iR},${iR} 0 ${largeArc},0 ${isx},${isy} Z`;
    } else {
      d =
        `M ${cx},${cy} L ${sx},${sy} ` +
        `A ${oR},${oR} 0 ${largeArc},1 ${ex},${ey} Z`;
    }
  }

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      width="100%"
      height="100%"
      style={{ display: "block" }}
    >
      <path d={d} fill={fill} fillRule="evenodd" />
    </svg>
  );
}

/** 手書き風マーカー注釈（shape: "marker-*"）の preview。export drawMarkerShape と式一致。
 *  draw-on は再生中のみ進捗 p で描き、編集中(停止時)は p=1（フル表示）でドラッグを妨げない。 */
function MarkerShapeSvg({
  layer,
  currentTimeSec,
  isPlaying,
  fontScale,
  widthPx,
  heightPx,
}: {
  layer: Layer;
  currentTimeSec?: number;
  isPlaying: boolean;
  fontScale: number;
  widthPx?: number;
  heightPx?: number;
}) {
  // box px が不明なときは design 比のフォールバック寸法（形は比率依存なので破綻しない）
  const w = widthPx && widthPx > 0 ? widthPx : (layer.width / 100) * fontScale * 360;
  const h = heightPx && heightPx > 0 ? heightPx : (layer.height / 100) * fontScale * 360;
  let p = 1;
  if (
    layer.entryAnimation === "draw-on" &&
    isPlaying &&
    currentTimeSec !== undefined
  ) {
    const entryDur = Math.max(0.01, layer.entryDuration ?? 0.5);
    const raw = (currentTimeSec - layer.startSec) / entryDur;
    p = Math.max(0, Math.min(1, raw));
  }
  const { strokes, arrowHead, flash } = computeMarker(layer, w, h, p, fontScale);
  const color = markerColor(layer);
  const lineW = (layer.markerWidth ?? 6) * fontScale;
  const flashGradId = `surge-flash-${layer.id}`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      width="100%"
      height="100%"
      style={{ display: "block", overflow: "visible" }}
    >
      <g
        fill="none"
        stroke={color}
        strokeWidth={lineW}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.85}
      >
        {strokes.map((s, i) => (
          <path key={i} d={strokeToPath(s)} />
        ))}
      </g>
      {arrowHead && arrowHead.length === 3 && (
        <polygon
          points={arrowHead.map((pt) => `${pt.x},${pt.y}`).join(" ")}
          fill={color}
          opacity={0.85}
        />
      )}
      {/* marker-surge の着弾フラッシュ（export drawMarkerShape と同じ放射グラデ） */}
      {flash && flash.alpha > 0.001 && (
        <>
          <defs>
            <radialGradient id={flashGradId} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity={0.95} />
              <stop offset="40%" stopColor={color} stopOpacity={1} />
              <stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
            </radialGradient>
          </defs>
          <circle
            cx={flash.x}
            cy={flash.y}
            r={flash.r}
            fill={`url(#${flashGradId})`}
            opacity={Math.min(1, flash.alpha)}
          />
        </>
      )}
    </svg>
  );
}

function BubbleSvg({
  layer,
  fontScale = 0.25,
  widthPx,
  heightPx,
}: {
  layer: Layer;
  fontScale?: number;
  widthPx?: number;
  heightPx?: number;
}) {
  const bubble = layer.bubble;
  if (!bubble) return null;
  // export (layerComposer.drawBubbleShape) と一致させるため、実ピクセル寸法の viewBox で
  // パスを生成する（旧実装は 100×100 を preserveAspectRatio="none" で歪ませており、
  // 角丸半径・枠線太さが export と食い違っていた）。寸法不明時のみ 100×100 にフォールバック。
  const vw = widthPx && widthPx > 0 ? widthPx : 100;
  const vh = heightPx && heightPx > 0 ? heightPx : 100;
  // export: radius = (borderRadius ?? 12) * (FINAL_W/360) / lineWidth = border.width * (FINAL_W/360)
  // preview の design 係数は fontScale = canvasWPx/360 なので同じ基準でスケール
  const radius = (layer.borderRadius ?? 12) * fontScale;
  const d = bubbleFullPath(vw, vh, bubble, radius);
  const stroke = layer.border;
  return (
    <svg
      viewBox={`0 0 ${vw} ${vh}`}
      preserveAspectRatio="none"
      width="100%"
      height="100%"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        overflow: "visible",
      }}
    >
      <path
        d={d}
        fill={layer.fillColor || "rgba(255,255,255,0.95)"}
        stroke={stroke?.color || "transparent"}
        strokeWidth={stroke && stroke.width > 0 ? stroke.width * fontScale : 0}
      />
    </svg>
  );
}

/**
 * 吹き出しのしっぽ先端ドラッグハンドル。
 * レイヤー枠内の (tipX%, tipY%) に丸点を表示し、ドラッグで tipX/tipY を更新する。
 */
function TailHandle({
  tipX,
  tipY,
  onChange,
}: {
  tipX: number;
  tipY: number;
  onChange: (x: number, y: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    setDragging(true);
    try {
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    // 可動域は制限なし（キャンバス端までどこへでも伸ばせる）
    onChange(x, y);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    setDragging(false);
    try {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  };
  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        position: "absolute",
        left: `${tipX}%`,
        top: `${tipY}%`,
        width: 14,
        height: 14,
        marginLeft: -7,
        marginTop: -7,
        borderRadius: "50%",
        background: dragging ? "#2563EB" : "#3B82F6",
        border: "2px solid white",
        cursor: "move",
        zIndex: 100,
        boxShadow: "0 0 4px rgba(0,0,0,0.5)",
      }}
      title="しっぽの先端位置（ドラッグで移動）"
    />
  );
}

/** export の wrapTextLines を preview スケールの font で呼び、折り返し後の行リストを返す。
 * これを preview のプレーンテキスト描画にも使うことで、改行位置を export と完全一致させる
 * （DOM 任せの折り返しだとフォントメトリクス差で 1 文字ズレる = C6）。 */
let _measureCtx: CanvasRenderingContext2D | null = null;
function previewWrapLines(
  layer: Layer,
  fontSizePx: number,
  maxWidthPx: number,
): string[] {
  const text = layer.text ?? "";
  if (!text) return [""];
  if (!_measureCtx) {
    _measureCtx = document.createElement("canvas").getContext("2d");
  }
  if (!_measureCtx) return text.split(/\n/);
  const family = layer.fontFamily
    ? `${layer.fontFamily}, ${TEXT_DEFAULT_FONT_STACK}`
    : TEXT_DEFAULT_FONT_STACK;
  _measureCtx.font = `bold ${fontSizePx}px ${family}`;
  return wrapTextLines(_measureCtx, text, Math.max(1, maxWidthPx));
}
function countWrappedLines(
  layer: Layer,
  fontSizePx: number,
  maxWidthPx: number,
): number {
  return previewWrapLines(layer, fontSizePx, maxWidthPx).length;
}

/** highlight-bar / underline-sweep の縦位置（px）を export(drawText) と同式で算出。
 * box(heightPx) 内で中央寄せされたテキストブロックの上端/高さ・最終行下端を返す。 */
interface DecoGeom {
  blockTop: number;
  blockH: number;
  padY: number;
  underlineY: number;
}
function computeDecoGeom(
  layer: Layer,
  fontScale: number,
  widthPx: number,
  heightPx: number,
): DecoGeom {
  const fontSizePx = (layer.fontSize ?? 48) * fontScale;
  const paddingPx = 4 * fontScale; // export textInnerPadding = 4*(FINAL_W/360) と同基準
  const n = countWrappedLines(layer, fontSizePx, widthPx - paddingPx * 2);
  const lineHeight = fontSizePx * 1.2;
  const totalH = n * lineHeight;
  const startY = heightPx / 2 - totalH / 2 + lineHeight / 2; // 各行の中心 (textBaseline middle)
  const blockTop = startY - lineHeight / 2;
  const lastLineCenterY = startY + (n - 1) * lineHeight;
  const underlineY = Math.min(
    lastLineCenterY + fontSizePx * 0.6,
    heightPx - 4 * fontScale,
  );
  return { blockTop, blockH: totalH, padY: fontSizePx * 0.1, underlineY };
}

/**
 * テキスト / コメントレイヤーを、文字単位アニメ・単語キネティック・装飾付きで描画する。
 * fontScale は プレビュー時等に縮小表示する場合の係数（キャンバス 1.0 / プレビュー 0.25 等）
 * widthPx/heightPx はレイヤーボックスの実 px（装飾を行位置に合わせるため。未指定は従来の % 配置）
 */
export function renderAnimatedText(
  layer: Layer,
  currentTimeSec: number,
  fontScale: number = 1,
  widthPx?: number,
  heightPx?: number,
  // ① counter / ③ flip-swap の「停止時は最終値」を実現するための再生状態。
  // 既定 false（サムネ等の静的呼び出しは最終値を表示）。本キャンバスは実 isPlaying を渡す。
  isPlaying: boolean = false,
): React.ReactNode {
  const localTime = currentTimeSec - layer.startSec;
  // counter / flip-swap があれば表示文字列を毎フレーム差し替え（export と同一の resolveDynamicText）。
  const dynamicText = resolveDynamicText(layer, localTime, isPlaying);
  const text = dynamicText ?? layer.text ?? "テキスト";
  const baseFontSize = Math.max(8, (layer.fontSize ?? 48) * fontScale);
  const layerDur = Math.max(0.1, layer.endSec - layer.startSec);
  const decoration = layer.textDecoration ?? "none";
  // highlight-bar / underline-sweep の縦位置（box px が分かるときのみ行位置基準に）
  const decoGeom =
    (decoration === "highlight-bar" || decoration === "underline-sweep") &&
    widthPx &&
    heightPx
      ? computeDecoGeom(layer, fontScale, widthPx, heightPx)
      : null;

  // fillColor 背景がある場合、inset box-shadow（innerStyle 側）が背景に隠れるため
  // border をここのコンテナに直接適用する
  // layerComposer と同じスケール（fontScale = canvasWPx/360）で太さを合わせる
  const borderBoxShadow = layer.border
    ? `inset 0 0 0 ${(layer.border.width * fontScale).toFixed(2)}px ${layer.border.color}`
    : undefined;

  const baseStyle: React.CSSProperties = {
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: layer.fillColor ?? "transparent",
    color: layer.fontColor ?? "#fff",
    fontSize: baseFontSize,
    // 行間は export (drawText/drawAnimatedTextFrame の lineHeight = fontSize*1.2) と一致させる。
    // 未指定だと CSS line-height:normal（フォント依存・和文で約1.2〜1.4）になり、複数行の
    // 行間・縦位置・ブロック高さが export とズレる。
    lineHeight: 1.2,
    // export (layerComposer.textInnerPadding = 4*(FINAL_W/360)) と同じく design(360)
    // 基準でスケールする。固定 4px だと表示キャンバスが広いほど相対パディングが小さくなり、
    // 可用テキスト幅がズレて改行位置が export と食い違う（C6）。
    padding: 4 * fontScale,
    textAlign: "center",
    fontWeight: "bold",
    wordBreak: "break-word",
    whiteSpace: "pre-wrap",
    overflow: "hidden",
    position: "relative",
    boxShadow: borderBoxShadow,
    fontFamily: layer.fontFamily
      ? `${layer.fontFamily}, ${TEXT_DEFAULT_FONT_STACK}`
      : TEXT_DEFAULT_FONT_STACK,
  };

  // 装飾：ネオン / アウトライン / 影ドロップ は text-shadow / -webkit-text-stroke で表現
  const textStyleExtra: React.CSSProperties = {};

  // ユーザー設定の文字縁取り（textDecoration が none 系のときに適用。シャドウ/アウトライン装飾時はそちらを優先）
  const userOutlineWidth = layer.textOutlineWidth ?? 0;
  const userOutlineColor = layer.textOutlineColor ?? "#000000";
  if (
    userOutlineWidth > 0 &&
    decoration !== "outline-reveal" &&
    decoration !== "neon"
  ) {
    const scaledStroke = userOutlineWidth * fontScale;
    textStyleExtra.WebkitTextStroke = `${scaledStroke.toFixed(2)}px ${userOutlineColor}`;
    textStyleExtra.paintOrder = "stroke fill";
  }

  if (decoration === "neon") {
    // export (drawAnimatedToken/drawText) は白文字を #ffe600 に置換し、
    // 文字本体も glow も neon 色で描く。preview もそれに揃える
    // （白の text-shadow は背景次第で見えず不一致になるため）。
    const color =
      !layer.fontColor || layer.fontColor === "#fff" ? "#ffe600" : layer.fontColor;
    textStyleExtra.color = color;
    // glow 半径は export (drawAnimatedToken: blur*scalePx) と同じく design(360) 基準でスケール
    textStyleExtra.textShadow = `0 0 ${(4 * fontScale).toFixed(2)}px ${color}, 0 0 ${(8 * fontScale).toFixed(2)}px ${color}, 0 0 ${(16 * fontScale).toFixed(2)}px ${color}`;
  } else if (decoration === "outline-reveal") {
    // 時間に応じて stroke 幅を 0→3 に。線幅は export (strokeP*3*scalePx) と同じく fontScale でスケール
    const strokeP = Math.min(1, localTime / Math.max(0.01, layer.entryDuration ?? 0.3));
    textStyleExtra.WebkitTextStroke = `${(strokeP * 3 * fontScale).toFixed(2)}px ${layer.fontColor ?? "#fff"}`;
    textStyleExtra.WebkitTextFillColor = "transparent";
  } else if (decoration === "shadow-drop") {
    const entryDur = Math.max(0.01, layer.entryDuration ?? 0.3);
    const p = Math.min(1, Math.max(0, localTime / entryDur));
    // 影 offset は export (dxS=(...)*scalePx) と同じく design 基準でスケール
    const dx = ((1 - p) * -6 + p * 4) * fontScale;
    const dy = ((1 - p) * -6 + p * 4) * fontScale;
    textStyleExtra.textShadow = `${dx.toFixed(2)}px ${dy.toFixed(2)}px 0 rgba(0,0,0,0.6)`;
  }

  // 描画ノード（本文部分）
  let contentNode: React.ReactNode;

  const kinetic = layer.kineticAnimation ?? "none";
  const charAnim = layer.charAnimation ?? "none";

  if (kinetic !== "none") {
    contentNode = renderKineticText(layer, text, localTime, layerDur, fontScale);
  } else if (charAnim !== "none") {
    contentNode = renderCharAnimatedText(layer, text, localTime, fontScale);
  } else if (widthPx) {
    // プレーンテキスト: DOM 任せの折り返しだと export(Canvas measureText)と改行位置が
    // ズレる（C6）。export と同じ wrapTextLines で行を確定し、明示的な改行で描画する。
    const fontSizePx = (layer.fontSize ?? 48) * fontScale;
    const maxW = widthPx - 4 * fontScale * 2;
    // counter/flip の動的文字列も export(wrapTextLines)と同じ折り返しにするため text を差し替える。
    const wrapLayer = dynamicText != null ? { ...layer, text } : layer;
    contentNode = previewWrapLines(wrapLayer, fontSizePx, maxW).join("\n");
  } else {
    contentNode = text;
  }

  return (
    <div style={baseStyle}>
      {/* 装飾レイヤー（背景系）。box px が分かれば行位置基準、無ければ従来の % 配置 */}
      {decoration === "highlight-bar" && (
        <HighlightBar layer={layer} localTime={localTime} geom={decoGeom} />
      )}
      {decoration === "underline-sweep" && (
        <UnderlineSweep
          layer={layer}
          localTime={localTime}
          geom={decoGeom}
          fontScale={fontScale}
        />
      )}
      <span style={{ position: "relative", ...textStyleExtra }}>
        {contentNode}
      </span>
    </div>
  );
}

function HighlightBar({
  layer,
  localTime,
  geom,
}: {
  layer: Layer;
  localTime: number;
  geom: DecoGeom | null;
}) {
  const entryDur = Math.max(0.01, layer.entryDuration ?? 0.3);
  const p = Math.min(1, Math.max(0, localTime / entryDur));
  // geom があればテキストブロックの実高さ基準（複数行で文字を覆う）、無ければ従来 % 配置
  const vertical: React.CSSProperties = geom
    ? { top: geom.blockTop - geom.padY, height: geom.blockH + geom.padY * 2 }
    : { top: "10%", bottom: "10%" };
  return (
    <div
      style={{
        position: "absolute",
        left: "5%",
        width: `${p * 90}%`,
        background: "rgba(255, 220, 0, 0.85)",
        zIndex: 0,
        transition: "none",
        ...vertical,
      }}
    />
  );
}

function UnderlineSweep({
  layer,
  localTime,
  geom,
  fontScale = 1,
}: {
  layer: Layer;
  localTime: number;
  geom: DecoGeom | null;
  fontScale?: number;
}) {
  const entryDur = Math.max(0.01, layer.entryDuration ?? 0.3);
  const p = Math.min(1, Math.max(0, localTime / entryDur));
  // geom があれば最終行直下に引く（複数行で 2 行目に重ならない）、無ければ従来 % 配置
  const vertical: React.CSSProperties = geom
    ? { top: geom.underlineY, height: 3 * fontScale }
    : { bottom: "12%", height: 3 };
  return (
    <div
      style={{
        position: "absolute",
        left: "5%",
        width: `${p * 90}%`,
        background: layer.fontColor ?? "#fff",
        zIndex: 0,
        ...vertical,
      }}
    />
  );
}

function renderCharAnimatedText(
  layer: Layer,
  text: string,
  localTime: number,
  fontScale: number = 1,
): React.ReactNode {
  const anim = layer.charAnimation ?? "none";
  const chars = Array.from(text);
  return (
    <span style={{ display: "inline-block" }}>
      {chars.map((ch, i) => {
        // export(computeCharAnimState) と同じ計算を共有（数式一致を保証）。
        // dx/dy は design 基準なので preview は fontScale 倍。
        const st = computeCharAnimState(anim, i, localTime, layer.fontColor ?? "#fff");
        const style: React.CSSProperties = {
          display: "inline-block",
          whiteSpace: "pre",
          opacity: st.opacity,
          color: st.color,
        };
        const tparts: string[] = [];
        if (st.dx !== 0 || st.dy !== 0) {
          tparts.push(
            `translate(${(st.dx * fontScale).toFixed(2)}px, ${(st.dy * fontScale).toFixed(2)}px)`,
          );
        }
        if (st.scale !== 1) tparts.push(`scale(${st.scale.toFixed(3)})`);
        if (tparts.length) style.transform = tparts.join(" ");
        return (
          <span key={i} style={style}>
            {ch}
          </span>
        );
      })}
    </span>
  );
}

function renderKineticText(
  layer: Layer,
  text: string,
  localTime: number,
  _layerDur: number,
  fontScale: number = 1,
): React.ReactNode {
  const kinetic = layer.kineticAnimation ?? "none";
  const words = text.split(/(\s+)/); // スペースを保ったまま分割
  return (
    <span style={{ display: "inline-block" }}>
      {words.map((w, i) => {
        if (/^\s+$/.test(w)) return <span key={i}>{w}</span>;
        const style: React.CSSProperties = {
          display: "inline-block",
          whiteSpace: "pre",
        };
        const appearAt = i * 0.2;
        const p = Math.min(1, Math.max(0, (localTime - appearAt) / 0.3));
        switch (kinetic) {
          case "word-pop": {
            // easeOutBack
            const c1 = 1.70158;
            const c3 = c1 + 1;
            const eb = p === 0 ? 0 : 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
            style.transform = `scale(${Math.max(0.001, eb)})`;
            style.opacity = p > 0 ? 1 : 0;
            break;
          }
          case "keyword-color": {
            // i 番目が偶数ならベース、奇数なら keywordColor
            style.opacity = p;
            style.transform = `translateY(${((1 - p) * 6 * fontScale).toFixed(2)}px)`;
            if (i % 2 === 1) {
              style.color = layer.keywordColor ?? "#ffe600";
            }
            break;
          }
          case "slide-stack": {
            style.opacity = p;
            style.transform = `translateY(${((1 - p) * -16 * fontScale).toFixed(2)}px)`;
            break;
          }
          case "zoom-talk": {
            const zoom = p < 0.5 ? 1 + p * 0.6 : 1 + (1 - p) * 0.6;
            style.transform = `scale(${zoom.toFixed(3)})`;
            style.opacity = p > 0 ? 1 : 0;
            break;
          }
        }
        return (
          <span key={i} style={style}>
            {w}
          </span>
        );
      })}
    </span>
  );
}

/**
 * 入退場アニメーションを現在時刻に基づいて計算する。
 * 戻り値は opacity(0..1) と transform 文字列（scale/translate/rotate）、filter 文字列
 */
export function computeLayerAnimStyle(
  layer: Layer,
  currentTimeSec: number,
): { opacity: number; transform: string; filter: string; transformOrigin?: string } {
  const entryAnim = layer.entryAnimation ?? "none";
  const exitAnim = layer.exitAnimation ?? "none";
  const entryDur = Math.max(0.01, layer.entryDuration ?? 0.3);
  const exitDur = Math.max(0.01, layer.exitDuration ?? 0.3);
  const entryEnd = layer.startSec + entryDur;
  const exitStart = layer.endSec - exitDur;

  let opacity = 1;
  let transformOrigin: string | undefined;
  const parts: string[] = [];
  const filters: string[] = [];

  // ---- 入場 ----
  if (entryAnim !== "none" && currentTimeSec < entryEnd) {
    const raw = (currentTimeSec - layer.startSec) / entryDur;
    const p = Math.max(0, Math.min(1, raw));
    // ease-out (1 - (1-p)^2)
    const e = 1 - Math.pow(1 - p, 2);
    switch (entryAnim) {
      case "fade":
        opacity *= e;
        break;
      case "slide-left":
        parts.push(`translateX(${(1 - e) * -100}%)`);
        break;
      case "slide-right":
        parts.push(`translateX(${(1 - e) * 100}%)`);
        break;
      case "slide-up":
        parts.push(`translateY(${(1 - e) * 100}%)`);
        break;
      case "slide-down":
        parts.push(`translateY(${(1 - e) * -100}%)`);
        break;
      case "zoom-in":
        parts.push(`scale(${Math.max(0.001, e)})`);
        break;
      case "pop": {
        const c1 = 1.70158;
        const c3 = c1 + 1;
        const eb = 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
        parts.push(`scale(${Math.max(0.001, eb)})`);
        break;
      }
      case "blur-in": {
        const b = (1 - e) * 20;
        filters.push(`blur(${b.toFixed(2)}px)`);
        opacity *= e;
        break;
      }
      case "elastic-pop": {
        // easeOutElastic
        const c4 = (2 * Math.PI) / 3;
        const el =
          p === 0 ? 0 : p === 1 ? 1 : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * c4) + 1;
        parts.push(`scale(${Math.max(0.001, el)})`);
        opacity *= e;
        break;
      }
      case "flip-in":
        parts.push(`perspective(500px) rotateY(${(1 - e) * 90}deg)`);
        opacity *= e;
        break;
      case "stretch-in":
        parts.push(`scaleX(${Math.max(0.001, e)})`);
        opacity *= e;
        break;
      case "roll-in":
        parts.push(`translateX(${(1 - e) * -100}%) rotate(${(1 - e) * -180}deg)`);
        opacity *= e;
        break;
      // 「ちゃんと伸びる」: opacity を維持して端から伸ばす。棒グラフ用
      case "grow-up":
        parts.push(`scaleY(${Math.max(0.001, e)})`);
        transformOrigin = "center bottom";
        break;
      case "grow-down":
        parts.push(`scaleY(${Math.max(0.001, e)})`);
        transformOrigin = "center top";
        break;
      case "grow-right":
        parts.push(`scaleX(${Math.max(0.001, e)})`);
        transformOrigin = "left center";
        break;
      case "grow-left":
        parts.push(`scaleX(${Math.max(0.001, e)})`);
        transformOrigin = "right center";
        break;
      case "arc-sweep":
        // ArcShapeSvg 側で arcEnd を時間補間するため、ここでは transform を触らない。
        // entry 中も opacity 1.0 維持で「描かれていく」ように見せる。
        break;
      case "flip-swap":
        // ③ 値札フリップ: 縦に潰れて戻る。scaleY = |p-0.5|*2（中央で 0）。
        // transform-origin は中央（既定）。export computeCanvasAnim の sy と一致。
        // 文字列差し替え（text→flipTo）は resolveDynamicText が担当。
        parts.push(`scaleY(${Math.max(0.001, Math.abs(p - 0.5) * 2)})`);
        break;
      case "stamp": {
        // 判子: 2.0 倍から easeOutBack で叩きつけ → 1.0。軽い傾きが 0 へ。
        // export computeCanvasAnim と数式一致。
        const c1 = 1.70158;
        const c3 = c1 + 1;
        const eb = 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
        const s = Math.max(0.001, 2.0 - eb);
        parts.push(`scale(${s.toFixed(3)}) rotate(${((1 - e) * -4).toFixed(2)}deg)`);
        opacity *= Math.min(1, p * 3);
        break;
      }
    }
  }

  // ---- 退場 ----
  if (exitAnim !== "none" && currentTimeSec >= exitStart) {
    const raw = (currentTimeSec - exitStart) / exitDur;
    const p = Math.max(0, Math.min(1, raw));
    // ease-in (p^2)
    const e = p * p;
    switch (exitAnim) {
      case "fade":
        opacity *= 1 - e;
        break;
      case "slide-left":
        parts.push(`translateX(${e * -100}%)`);
        break;
      case "slide-right":
        parts.push(`translateX(${e * 100}%)`);
        break;
      case "slide-up":
        parts.push(`translateY(${e * -100}%)`);
        break;
      case "slide-down":
        parts.push(`translateY(${e * 100}%)`);
        break;
      case "zoom-out":
        parts.push(`scale(${Math.max(0.001, 1 - e)})`);
        break;
      case "blur-out":
        filters.push(`blur(${(e * 20).toFixed(2)}px)`);
        opacity *= 1 - e;
        break;
      case "flip-out":
        parts.push(`perspective(500px) rotateY(${e * 90}deg)`);
        opacity *= 1 - e;
        break;
      case "stretch-out":
        parts.push(`scaleX(${Math.max(0.001, 1 - e)})`);
        opacity *= 1 - e;
        break;
      case "roll-out":
        parts.push(`translateX(${e * 100}%) rotate(${e * 180}deg)`);
        opacity *= 1 - e;
        break;
    }
  }

  return {
    opacity,
    transform: parts.join(" "),
    filter: filters.join(" "),
    transformOrigin,
  };
}

/**
 * Ambient（表示中ずっと続くアニメ）の transform / filter / opacity を計算
 */
export function computeLayerAmbientStyle(
  layer: Layer,
  currentTimeSec: number,
  // ambient の絶対 px 振幅 (shake/bounce/float/glow) を design 基準(360)から
  // プレビュー描画解像度へ換算する係数 = canvasWPx/360 (= fontScale)。
  // export 側 computeCanvasAnim の pxScale (FINAL_W/360) と一致させる。
  pxScale = 1,
): { opacity: number; transform: string; filter: string } {
  const amb = layer.ambientAnimation ?? "none";
  if (amb === "none") return { opacity: 1, transform: "", filter: "" };
  const k = Math.max(0, Math.min(2, layer.ambientIntensity ?? 1));
  // ambientSpeed（§7・既定1）を周期時間に乗算（export computeCanvasAnim の tp=t*sp と一致）。
  const t = currentTimeSec * (layer.ambientSpeed ?? 1);
  const parts: string[] = [];
  const filters: string[] = [];
  let opacity = 1;
  switch (amb) {
    case "pulse": {
      const s = 1 + 0.05 * k * Math.sin(t * Math.PI * 2);
      parts.push(`scale(${s.toFixed(4)})`);
      break;
    }
    case "shake": {
      const x = Math.sin(t * 30) * 2 * k * pxScale;
      const y = Math.cos(t * 33) * 1.5 * k * pxScale;
      parts.push(`translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`);
      break;
    }
    case "wiggle": {
      const r = Math.sin(t * Math.PI * 2) * 2 * k;
      parts.push(`rotate(${r.toFixed(2)}deg)`);
      break;
    }
    case "bounce": {
      const y = -Math.abs(Math.sin(t * Math.PI * 2)) * 4 * k * pxScale;
      parts.push(`translateY(${y.toFixed(2)}px)`);
      break;
    }
    case "blink": {
      opacity = Math.sin(t * Math.PI * 4) > 0 ? 1 : 0.3 + 0.7 * (1 - k);
      break;
    }
    case "glow-pulse": {
      const g = (4 + Math.sin(t * Math.PI * 2) * 4 * k) * pxScale;
      filters.push(`drop-shadow(0 0 ${g.toFixed(1)}px rgba(255,230,0,0.9))`);
      break;
    }
    case "rainbow": {
      const hue = (t * 60) % 360;
      filters.push(`hue-rotate(${hue.toFixed(0)}deg)`);
      break;
    }
    case "float": {
      const y = Math.sin(t * Math.PI) * 3 * k * pxScale;
      parts.push(`translateY(${y.toFixed(2)}px)`);
      break;
    }
    case "spin": {
      // 一定速度で回転（§7）。export computeCanvasAnim の rot += tp*90*k と一致（CSS は度）。
      parts.push(`rotate(${(t * 90 * k).toFixed(2)}deg)`);
      break;
    }
    case "drift": {
      // ゆっくり横へ漂う（§7）。export と同式 ±6px·k・周期4s。
      const x = Math.sin(t * Math.PI * 0.5) * 6 * k * pxScale;
      parts.push(`translateX(${x.toFixed(2)}px)`);
      break;
    }
    case "sway": {
      const r = Math.sin(t * Math.PI * 0.7) * 6 * k;
      parts.push(`rotate(${r.toFixed(2)}deg)`);
      break;
    }
    case "orbit": {
      const x = Math.cos(t * Math.PI) * 5 * k * pxScale;
      const y = Math.sin(t * Math.PI) * 5 * k * pxScale;
      parts.push(`translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`);
      break;
    }
    case "jelly": {
      const j = 0.07 * k * Math.sin(t * Math.PI * 3);
      parts.push(`scale(${(1 + j).toFixed(4)}, ${(1 - j).toFixed(4)})`);
      break;
    }
  }
  return { opacity, transform: parts.join(" "), filter: filters.join(" ") };
}

/**
 * Motion フィルタ (zoom/pan/ken_burns 等) を CSS transform で表現する。
 * レイヤーの可視期間 [startSec, endSec] の進捗 0..1 に応じて計算。
 */
export function computeLayerMotionTransform(
  layer: Layer,
  currentTimeSec: number,
): string {
  // 数式は export と共有 (layerAnimCanvas.computeMotion)。CSS `scale() translate()` に整形する。
  // export drawLayer は applyMotion で同じ合成を ctx に適用する。
  const m = computeMotion(layer, currentTimeSec);
  if (m.scale === 1 && m.txFrac === 0 && m.tyFrac === 0) return "";
  const parts: string[] = [];
  if (m.scale !== 1) parts.push(`scale(${m.scale})`);
  if (m.txFrac !== 0 || m.tyFrac !== 0) {
    parts.push(`translate(${(m.txFrac * 100).toFixed(4)}%, ${(m.tyFrac * 100).toFixed(4)}%)`);
  }
  return parts.join(" ");
}

/** 音声レイヤーを <audio> で playhead 同期再生（視覚表示なし） */
function AudioLayerPlayer({
  layer,
  currentTimeSec,
  isPlaying,
  allLayers = [],
}: {
  layer: Layer;
  currentTimeSec: number;
  isPlaying: boolean;
  allLayers?: Layer[];
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  // HTMLAudioElement.volume は 0..1 にクランプされるため、100% 超のボリュームは
  // Web Audio API の GainNode 経由で実現する（エクスポート側 ffmpeg `volume=` と一致させる）。
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const resolved = resolveSrcForWebview(layer.source);
  // 再生開始時の seek に使う最新の currentTimeSec（effect の依存に入れずに参照する）
  const currentTimeRef = useRef(currentTimeSec);
  currentTimeRef.current = currentTimeSec;

  // Web Audio グラフを必要時に一度だけ構築（autoplay policy 対策で suspended の可能性あり）
  const ensureAudioGraph = (): GainNode | null => {
    if (gainNodeRef.current) return gainNodeRef.current;
    const a = audioRef.current;
    if (!a) return null;
    const AC: typeof AudioContext | undefined =
      (window as unknown as { AudioContext?: typeof AudioContext })
        .AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return null;
    try {
      const ctx = new AC();
      const source = ctx.createMediaElementSource(a);
      const gain = ctx.createGain();
      gain.gain.value = layer.volume ?? 1;
      source.connect(gain);
      gain.connect(ctx.destination);
      audioCtxRef.current = ctx;
      sourceNodeRef.current = source;
      gainNodeRef.current = gain;
      return gain;
    } catch {
      return null;
    }
  };

  // アンマウント時に Web Audio グラフを片付け
  useEffect(() => {
    return () => {
      try {
        gainNodeRef.current?.disconnect();
        sourceNodeRef.current?.disconnect();
        audioCtxRef.current?.close().catch(() => {});
      } catch {
        /* noop */
      }
      gainNodeRef.current = null;
      sourceNodeRef.current = null;
      audioCtxRef.current = null;
    };
  }, []);

  // currentTime を同期（scrub 中 / 再生停止中の追従）
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const rate = Math.max(0.05, Math.min(4, layer.playbackRate ?? 1));
    let target = (currentTimeSec - layer.startSec) * rate;
    const dur = a.duration;
    if (layer.audioLoop && dur && isFinite(dur) && target > dur) {
      target = target % dur;
    }
    if (target < 0) target = 0;
    // 許容ズレ。再生中は大きめ(250ms)に取り、playhead の微小ジッタ（重いテンプレで
    // React 再描画が詰まると起きる）での再 seek を避ける。<audio> の再生中 seek は
    // プチノイズ（音割れ）の原因になるため。停止/スクラブ中は精密に追従（音ハメ用）。
    // 再生中の初回同期は play 開始時の seek（下の play 効果）が担当するので問題ない。
    const tol = isPlaying ? 0.25 : 0.05;
    if (Math.abs(a.currentTime - target) > tol) {
      try {
        a.currentTime = target;
      } catch {
        /* noop */
      }
    }
  }, [
    currentTimeSec,
    layer.startSec,
    layer.audioLoop,
    layer.playbackRate,
    isPlaying,
  ]);

  // 音量（GainNode 経由で 0..1 制約を回避してフェードを反映）
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const base = layer.volume ?? 1;
    const fadeIn = layer.audioFadeIn ?? 0;
    const fadeOut = layer.audioFadeOut ?? 0;
    const inLayer = currentTimeSec - layer.startSec;
    const toEnd = layer.endSec - currentTimeSec;
    let gain = base;
    if (fadeIn > 0 && inLayer < fadeIn) {
      gain *= Math.max(0, Math.min(1, inLayer / fadeIn));
    }
    if (fadeOut > 0 && toEnd < fadeOut) {
      gain *= Math.max(0, Math.min(1, toEnd / fadeOut));
    }
    // ダッキング: duckBy の layer が鳴っている時間帯は volume を下げる
    // （fade とは独立に積算）。export 側 mixAudioLayers と同じ computeDuckMultiplier を共有。
    gain *= computeDuckMultiplier(layer, allLayers, currentTimeSec);
    const volumeFinal = Math.max(0, gain);
    // 0..1 の通常音量は HTMLAudioElement 直結で鳴らす（Web Audio に通すと
    // AudioContext が suspended のままだと無音になる事故が起きるため）。
    // 100% 超が必要なときだけ Web Audio グラフを構築する。一度グラフを作ると
    // 要素出力は恒久的に Web Audio 経由になるので、既存グラフがある場合も Web Audio を使う。
    const needsWebAudio = volumeFinal > 1 || gainNodeRef.current != null;
    const gainNode = needsWebAudio ? ensureAudioGraph() : null;
    if (gainNode) {
      // Web Audio 経路: GainNode で実音量、HTMLAudioElement.volume は素通し
      gainNode.gain.value = volumeFinal;
      a.volume = 1;
      a.muted = volumeFinal === 0;
    } else {
      // 通常経路 / フォールバック: 0..1 にクランプして HTMLAudioElement に直接
      const clamped = Math.min(1, volumeFinal);
      a.volume = clamped;
      a.muted = clamped === 0;
    }
  }, [
    currentTimeSec,
    layer.volume,
    layer.audioFadeIn,
    layer.audioFadeOut,
    layer.startSec,
    layer.endSec,
    layer.id,
    layer.duckBy,
    layer.duckAmount,
    layer.duckAttackMs,
    layer.duckReleaseMs,
    allLayers,
  ]);

  // 再生速度
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const rate = Math.max(0.05, Math.min(4, layer.playbackRate ?? 1));
    a.playbackRate = rate;
    a.defaultPlaybackRate = rate;
  }, [layer.playbackRate, layer.id]);

  // play/pause（再生開始時に再生速度も再適用 — メタデータ読み込み前に設定したものが
  // ロード完了で 1.0 にリセットされるブラウザ実装の対策）。
  // in-time（startSec〜endSec）の間だけ発音する。startSec 手前の先読みマウント中は
  // preload="auto" でバッファだけ進め、再生はしない（鳴り始めの遅延を消すため）。
  const inTime =
    currentTimeSec >= layer.startSec && currentTimeSec < layer.endSec;
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (isPlaying && inTime) {
      // Web Audio グラフを既に構築済み（volume>1）の場合のみ resume。
      // autoplay policy で suspended になっている可能性があるため。
      // 通常音量レイヤーは直結なのでグラフを作らない（無音事故防止）。
      if (gainNodeRef.current) {
        audioCtxRef.current?.resume().catch(() => {});
      }
      const rate = Math.max(0.05, Math.min(4, layer.playbackRate ?? 1));
      a.playbackRate = rate;
      // 再生開始時にプレイヘッド位置へ seek してから鳴らす（音声の鳴り始め遅延による
      // 映像とのズレを抑え、音ハメの同期精度を上げる）。
      let startTarget = (currentTimeRef.current - layer.startSec) * rate;
      const dur0 = a.duration;
      if (layer.audioLoop && dur0 && isFinite(dur0) && startTarget > dur0) {
        startTarget = startTarget % dur0;
      }
      if (startTarget < 0) startTarget = 0;
      try {
        a.currentTime = startTarget;
      } catch {
        /* noop */
      }
      a.play()
        .then(() => {
          // play() 後にも再度設定（一部ブラウザは play で rate を 1 にリセットする）
          a.playbackRate = rate;
        })
        .catch(() => {
          /* autoplay 制約で失敗する可能性 */
        });
    } else {
      a.pause();
    }
  }, [isPlaying, inTime, layer.playbackRate]);

  if (!resolved) return null;

  return (
    <audio
      ref={audioRef}
      src={resolved}
      preload="auto"
      loop={!!layer.audioLoop}
      onLoadedMetadata={() => {
        const a = audioRef.current;
        if (!a) return;
        const rate = Math.max(0.05, Math.min(4, layer.playbackRate ?? 1));
        a.playbackRate = rate;
      }}
      style={{ display: "none" }}
    />
  );
}

/** 動画レイヤーを <video> として描画し、プレイヘッドと同期再生する */
function VideoLayerContent({
  layer,
  currentTimeSec,
  isPlaying,
}: {
  layer: Layer;
  currentTimeSec: number;
  isPlaying: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const resolved = resolveSrcForWebview(layer.source);

  // プレイヘッドが飛んだ / 停止中のスクラブで currentTime を同期
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const rate = Math.max(0.05, Math.min(4, layer.playbackRate ?? 1));
    let target = Math.max(0, (currentTimeSec - layer.startSec) * rate);
    // ループ ON で素材尺を超えたら、剰余を取って素材内に折り返す
    const loop = (layer.videoLoop ?? true) === true;
    const dur = v.duration;
    if (loop && dur && isFinite(dur) && dur > 0 && target > dur) {
      target = target % dur;
    }
    if (isFinite(target) && Math.abs(v.currentTime - target) > 0.15) {
      try {
        v.currentTime = target;
      } catch {
        // seek 前に metadata 未ロードの場合があるが、loadedmetadata で再設定される
      }
    }
  }, [currentTimeSec, layer.startSec, layer.playbackRate, layer.videoLoop]);

  // isPlaying に応じて play/pause。先読みマウント中（startSec 前）は再生せず
  // preload buffering だけ。in-time になったら再生。状態変化時のみ play/pause を
  // 呼ぶ（毎フレーム呼ばない）。
  const videoPlayStateRef = useRef<boolean | null>(null);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const inTime =
      currentTimeSec >= layer.startSec && currentTimeSec < layer.endSec;
    const shouldPlay = isPlaying && inTime;
    if (videoPlayStateRef.current === shouldPlay) return;
    videoPlayStateRef.current = shouldPlay;
    if (shouldPlay) {
      v.play().catch(() => {
        /* user gesture 要件などで失敗する可能性あり。無視 */
      });
    } else {
      v.pause();
    }
  }, [isPlaying, currentTimeSec, layer.startSec, layer.endSec]);

  // 再生速度（video レイヤーでも音声と同じく playbackRate を反映）
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const rate = layer.playbackRate ?? 1;
    v.playbackRate = Math.max(0.05, Math.min(4, rate));
  }, [layer.playbackRate]);

  // src 変更時にメタデータロード後 seek を即反映
  const handleLoadedMetadata = () => {
    const v = videoRef.current;
    if (!v) return;
    const target = Math.max(0, currentTimeSec - layer.startSec);
    if (isFinite(target)) {
      try {
        v.currentTime = target;
      } catch {
        /* noop */
      }
    }
  };

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
          fontSize: 10,
        }}
      >
        🎬 動画(未設定)
      </div>
    );
  }

  // crop 対応（image と同じ「overflow:hidden + 子要素を拡大＆ネガオフセット」方式）
  const crop = layer.crop;
  const cw = crop ? Math.max(1, crop.width) : 100;
  const ch = crop ? Math.max(1, crop.height) : 100;
  const cx = crop ? crop.x : 0;
  const cy = crop ? crop.y : 0;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <video
        ref={videoRef}
        src={resolved}
        muted
        playsInline
        preload="auto"
        loop={(layer.videoLoop ?? true) === true}
        onLoadedMetadata={handleLoadedMetadata}
        style={{
          position: "absolute",
          width: `${(100 * 100) / cw}%`,
          height: `${(100 * 100) / ch}%`,
          top: `${(-cy * 100) / ch}%`,
          left: `${(-cx * 100) / cw}%`,
          objectFit: "cover",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
