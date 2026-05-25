/**
 * Live2D モデルの読み込みと標準パラメータ自動検出。
 *
 * - .model3.json のパスを与えて Live2DModel をロードする
 * - モデルが持つ Parameter ID 一覧を見て、抽象名 (mouthOpenY 等) ⇄ 実 ID の
 *   マッピングテーブル (CubismParamMap) を自動構築する
 * - 自動アニメ機能 (eyeBlink / breath / mouseFocus) は OFF にして、
 *   tickCharacter() で全パラメータをこちらが手動制御する前提を作る
 */

import { Application, Ticker } from "pixi.js";
import {
  Live2DModel,
  Cubism4ModelSettings,
} from "pixi-live2d-display-lipsyncpatch/cubism4";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { CubismParamMap } from "../types";

// pixi-live2d-display は PIXI.Ticker をライブラリ側に登録しないと
// model.update() の自動駆動も registerTicker() も使えない。
// 我々は autoUpdate=false で運用するが念のため登録だけはしておく。
let _tickerRegistered = false;
function ensureTickerRegistered() {
  if (_tickerRegistered) return;
  Live2DModel.registerTicker(Ticker);
  _tickerRegistered = true;
}

/**
 * 抽象パラメータ名 → モデルが採用していそうな ID 候補リスト。
 * 上から順にマッチを試し、最初に存在したものを採用する。
 */
const PARAM_CANDIDATES: Record<keyof CubismParamMap, string[]> = {
  mouthOpenY: ["ParamMouthOpenY", "PARAM_MOUTH_OPEN_Y"],
  mouthForm: ["ParamMouthForm", "PARAM_MOUTH_FORM"],
  mouthA: ["ParamMouthA", "PARAM_MOUTH_A"],
  mouthI: ["ParamMouthI", "PARAM_MOUTH_I"],
  mouthU: ["ParamMouthU", "PARAM_MOUTH_U"],
  mouthE: ["ParamMouthE", "PARAM_MOUTH_E"],
  mouthO: ["ParamMouthO", "PARAM_MOUTH_O"],
  eyeLOpen: ["ParamEyeLOpen", "PARAM_EYE_L_OPEN"],
  eyeROpen: ["ParamEyeROpen", "PARAM_EYE_R_OPEN"],
  eyeBallX: ["ParamEyeBallX", "PARAM_EYE_BALL_X"],
  eyeBallY: ["ParamEyeBallY", "PARAM_EYE_BALL_Y"],
  angleX: ["ParamAngleX", "PARAM_ANGLE_X"],
  angleY: ["ParamAngleY", "PARAM_ANGLE_Y"],
  angleZ: ["ParamAngleZ", "PARAM_ANGLE_Z"],
  bodyAngleX: ["ParamBodyAngleX", "PARAM_BODY_ANGLE_X"],
  bodyAngleY: ["ParamBodyAngleY", "PARAM_BODY_ANGLE_Y"],
  bodyAngleZ: ["ParamBodyAngleZ", "PARAM_BODY_ANGLE_Z"],
  breath: ["ParamBreath", "PARAM_BREATH"],
  browLY: ["ParamBrowLY", "PARAM_BROW_L_Y"],
  browRY: ["ParamBrowRY", "PARAM_BROW_R_Y"],
};

export interface Live2DDiagnostics {
  /** 口パクの最低限 (MouthOpenY) があるか */
  canLipsync: boolean;
  /** 母音別口形状 (MouthA/I/U/E/O) を全部持っているか */
  hasVowelShapes: boolean;
  /** 瞬きパラメータを持っているか */
  canBlink: boolean;
  /** 顔向きパラメータを持っているか */
  canHeadTurn: boolean;
  /** 呼吸パラメータを持っているか */
  hasBreath: boolean;
  /** 表情ファイル数 */
  expressionCount: number;
  /** モーショングループ名と本数 */
  motionGroups: { name: string; count: number }[];
  /** モデルが持つ全パラメータ ID (デバッグ用) */
  allParamIds: string[];
}

/** Cubism Core (live2dcubismcore.min.js) が直接持つ Model 本体 */
export interface CubismCoreNativeModel {
  parameters: {
    count: number;
    ids: string[];
    values: Float32Array;
    minimumValues: Float32Array;
    maximumValues: Float32Array;
    defaultValues: Float32Array;
  };
  parts?: {
    count: number;
    ids: string[];
    opacities: Float32Array;
  };
  drawables?: {
    count: number;
    ids: string[];
  };
}

export interface LoadedLive2D {
  /** PIXI シーンに addChild できる Live2DModel インスタンス */
  model: Live2DModel;
  /** Cubism Core が直接公開している Model (parameters.values 等を Float32Array で操作) */
  cubismModel: CubismCoreNativeModel;
  /** parameter ID 文字列 → parameters.values 内のインデックス */
  paramIndex: Record<string, number>;
  /** 検出された標準パラメータ → 実 ID マップ */
  paramMap: CubismParamMap;
  /** モデル診断情報 (UI 表示用) */
  diagnostics: Live2DDiagnostics;
  /** 利用可能な表情ファイル名一覧 (.exp3.json は拡張子なしで返す) */
  expressions: string[];
  /** モデル自然サイズ (pixel)。スケーリングに使う */
  modelWidth: number;
  modelHeight: number;
}

/** モデルパラメータ ID 一覧から CubismParamMap を構築 */
function buildParamMap(allIds: string[]): CubismParamMap {
  const set = new Set(allIds);
  const map: CubismParamMap = {};
  (Object.keys(PARAM_CANDIDATES) as (keyof CubismParamMap)[]).forEach((key) => {
    for (const candidate of PARAM_CANDIDATES[key]) {
      if (set.has(candidate)) {
        map[key] = candidate;
        return;
      }
    }
  });
  return map;
}

/** modelPath から、その親ディレクトリを (区切り文字保持で) 取り出す */
function dirnameOf(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx < 0) return ".";
  return p.substring(0, idx);
}

/**
 * .model3.json の絶対パスから Live2D モデルをロードする。
 *
 * Tauri の `convertFileSrc()` が返す URL はパス区切り `/` を %2F にエンコードするため、
 * pixi-live2d-display 内部の **相対 URL 解決が壊れる** (例: model3.json から見た
 * `zundamon_m0.moc3` が `http://asset.localhost/zundamon_m0.moc3` 直下に解決される)。
 *
 * 対策: 自前で model3.json を fetch → JSON パース → Cubism4ModelSettings を生成 →
 * `replaceFiles()` ですべての参照ファイルを「絶対 asset URL」に書き換えてから
 * Live2DModel.from(settings) に渡す。これで相対解決が一切発生しなくなる。
 */
export async function loadLive2DModel(modelPath: string): Promise<LoadedLive2D> {
  ensureTickerRegistered();

  const modelJsonUrl = convertFileSrc(modelPath);
  const modelDir = dirnameOf(modelPath);

  // 1. model3.json を fetch + parse
  const res = await fetch(modelJsonUrl);
  if (!res.ok) {
    throw new Error(
      `model3.json fetch failed: HTTP ${res.status} ${modelJsonUrl}`,
    );
  }
  const json = (await res.json()) as Record<string, unknown> & { url?: string };
  // ModelSettings コンストラクタは json.url を要求する (空でも何でも良いが必須)
  json.url = modelJsonUrl;

  // 2. settings 構築 (FileReferences をパースして moc / textures / motions 等を整理)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const settings = new Cubism4ModelSettings(json as any);

  // 3. すべての参照ファイルを絶対 asset:// URL に置換
  //    relative path はモデルフォルダ基準 → 絶対 path → convertFileSrc
  settings.replaceFiles((file: string) => {
    if (
      file.startsWith("http://") ||
      file.startsWith("https://") ||
      file.startsWith("data:") ||
      file.startsWith("blob:")
    ) {
      return file;
    }
    // 区切り文字は混在しても Windows / asset protocol は受理する
    return convertFileSrc(`${modelDir}/${file}`);
  });

  // 4. settings を渡してモデルロード
  const model = (await Live2DModel.from(settings, {
    autoUpdate: false,
    autoFocus: false,
  })) as Live2DModel;

  // 内蔵の自動アニメは全て OFF。我々が tickCharacter で全パラメータを設定する。
  // アクセスする内部参照は型定義外なので any 経由。
  const internal = (model as unknown as { internalModel?: any }).internalModel;
  if (internal) {
    if ("eyeBlink" in internal) internal.eyeBlink = undefined;
    if ("breath" in internal) internal.breath = undefined;
    // motion manager の自動 idle 再生は startRandomMotion を呼ばないことで抑止される
  }

  // パラメータ ID 一覧の収集
  // pixi-live2d-display の internalModel.coreModel は CubismFramework の CubismModel ラッパー。
  // 実際の Cubism Core Native Model は coreModel.getModel() で取得でき、
  // parameters.ids (string[]) / parameters.values (Float32Array) を直接持つ。
  const coreModelWrapper = internal?.coreModel;
  const cubismModel: CubismCoreNativeModel | undefined =
    typeof coreModelWrapper?.getModel === "function"
      ? coreModelWrapper.getModel()
      : (coreModelWrapper as CubismCoreNativeModel | undefined);
  const allParamIds: string[] = cubismModel?.parameters?.ids
    ? Array.from(cubismModel.parameters.ids)
    : [];
  const paramMap = buildParamMap(allParamIds);
  const paramIndex: Record<string, number> = {};
  allParamIds.forEach((id, i) => {
    paramIndex[id] = i;
  });
  if (!cubismModel) {
    throw new Error("Cubism Core model is unavailable on internalModel.coreModel");
  }

  // Cubism Core 5 では破壊的変更があり、
  //   - 旧: model.drawables.renderOrders (Int32Array)
  //   - 新: model.getRenderOrders() メソッドに移動、drawables.renderOrders は廃止
  // pixi-live2d-display にバンドルされている Cubism Framework は旧 API 前提なので、
  // ここで getter を追加して旧 API を再生する (描画ループで undefined.0 読みを避ける)。
  // 同様に他の field も移動している場合は同じパターンで追加する。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cm = cubismModel as any;
  if (cm.drawables && !("renderOrders" in cm.drawables)) {
    if (typeof cm.getRenderOrders === "function") {
      Object.defineProperty(cm.drawables, "renderOrders", {
        get() {
          return cm.getRenderOrders();
        },
        configurable: true,
      });
    }
  }

  // モーション / 表情の情報を集める
  const motionManager = internal?.motionManager;
  const motionDefs = motionManager?.definitions || {};
  const motionGroups = Object.keys(motionDefs).map((name) => ({
    name,
    count: Array.isArray(motionDefs[name]) ? motionDefs[name].length : 0,
  }));

  const expressionManager = motionManager?.expressionManager;
  const expressionDefs = expressionManager?.definitions || [];
  const expressions: string[] = Array.isArray(expressionDefs)
    ? expressionDefs.map((e: any) => e.Name || e.name || "").filter(Boolean)
    : [];

  // 待機モーション (idle) を自動再生開始する。
  // モデルが motion を定義していない場合は何もしない (例: ずんだもん配布版)。
  // 'Idle' / 'idle' / 最初のグループの順で探す。
  if (motionDefs && motionGroups.length > 0) {
    const idleGroup =
      motionGroups.find((g) => g.name === "Idle" || g.name === "idle")?.name ??
      motionGroups[0]?.name;
    if (idleGroup) {
      try {
        // priority=1 (IDLE) で再生 → 後から触る motion/expression に上書きされる
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (model as any).motion?.(idleGroup, 0, 1);
      } catch {
        /* モーション再生失敗は致命ではないので無視 */
      }
    }
  }

  // モデル自然サイズ (canvas.size 由来)
  const modelWidth = (model as any).width || 0;
  const modelHeight = (model as any).height || 0;

  const diagnostics: Live2DDiagnostics = {
    canLipsync: !!paramMap.mouthOpenY,
    hasVowelShapes:
      !!paramMap.mouthA &&
      !!paramMap.mouthI &&
      !!paramMap.mouthU &&
      !!paramMap.mouthE &&
      !!paramMap.mouthO,
    canBlink: !!paramMap.eyeLOpen && !!paramMap.eyeROpen,
    canHeadTurn: !!paramMap.angleX && !!paramMap.angleY,
    hasBreath: !!paramMap.breath,
    expressionCount: expressions.length,
    motionGroups,
    allParamIds,
  };

  return {
    model,
    cubismModel,
    paramIndex,
    paramMap,
    diagnostics,
    expressions,
    modelWidth,
    modelHeight,
  };
}

/**
 * PIXI Application を作って canvas DOM 要素にバインドする。
 * プレビュー (生 canvas) でもオフライン描画 (OffscreenCanvas) でも使える。
 */
export function createPixiApp(
  view: HTMLCanvasElement,
  width: number,
  height: number,
): Application {
  return new Application({
    view,
    width,
    height,
    backgroundAlpha: 0,
    antialias: true,
    autoStart: false,
  });
}
