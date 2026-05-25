/**
 * グローバル Live2D モデルライブラリ。
 * テンプレート非依存で、`templates/live2d/{name}/` 配下にモデル一式を保管する。
 * 一度登録したモデルは、新規テンプレートを作っても再インポート不要で使える。
 */

import { invoke } from "@tauri-apps/api/core";

export interface Live2DModelMeta {
  /** 登録名 (フォルダ名と同じ) */
  name: string;
  /** 主 .model3.json への絶対パス */
  modelPath: string;
  /** 制作者名 */
  author?: string;
  /** 配布元 URL */
  sourceUrl?: string;
  /** 動画概要欄に貼る指定クレジット文 */
  requiredCreditText?: string;
  /** 登録日時 (UNIX 秒) */
  registeredAt?: number;
}

/**
 * ローカルのモデルフォルダをグローバルライブラリに取り込む。
 * 同名モデルがあれば内容差し替え (上書き) する。
 */
export async function importLive2DGlobal(
  sourceModel3JsonPath: string,
  meta: {
    author?: string;
    sourceUrl?: string;
    requiredCreditText?: string;
  } = {},
): Promise<Live2DModelMeta> {
  return await invoke<Live2DModelMeta>("import_live2d_global", {
    sourceModel3JsonPath,
    author: meta.author ?? null,
    sourceUrl: meta.sourceUrl ?? null,
    requiredCreditText: meta.requiredCreditText ?? null,
  });
}

/** 登録済みモデル一覧 (登録日時降順) */
export async function listLive2DModels(): Promise<Live2DModelMeta[]> {
  return await invoke<Live2DModelMeta[]>("list_live2d_models");
}

/** モデルをライブラリから削除 (フォルダごと) */
export async function deleteLive2DModel(name: string): Promise<void> {
  await invoke("delete_live2d_model", { name });
}

/** 既存モデルのクレジット情報を更新 */
export async function updateLive2DModelMeta(
  name: string,
  meta: {
    author?: string;
    sourceUrl?: string;
    requiredCreditText?: string;
  },
): Promise<Live2DModelMeta> {
  return await invoke<Live2DModelMeta>("update_live2d_model_meta", {
    name,
    author: meta.author ?? null,
    sourceUrl: meta.sourceUrl ?? null,
    requiredCreditText: meta.requiredCreditText ?? null,
  });
}
