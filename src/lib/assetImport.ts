import { invoke } from "@tauri-apps/api/core";

export type AssetKind = "images" | "videos" | "audio";

/**
 * 素材ファイルをアプリ管理下にコピーする。
 * - templates/assets/{templateId}/{kind}/{hash}_{name}.{ext} に保存される
 * - 同じ内容のファイルが既にあれば再コピーせず既存パスを返す
 * - 戻り値はコピー先の絶対パス。layer.source にそのまま入れる
 */
export async function importAsset(
  templateId: string,
  sourcePath: string,
  kind: AssetKind,
): Promise<string> {
  return await invoke<string>("import_asset", {
    templateId,
    sourcePath,
    kind,
  });
}

/** テンプレ削除時に対応する assets フォルダも削除する */
export async function deleteTemplateAssets(templateId: string): Promise<void> {
  await invoke("delete_template_assets", { templateId });
}

export interface AssetInfo {
  kind: AssetKind;
  path: string;
  filename: string;
  size: number;
  modifiedUnix: number;
}

/** テンプレに紐づく素材一覧を取得（新しい順） */
export async function listTemplateAssets(
  templateId: string,
): Promise<AssetInfo[]> {
  if (!templateId) return [];
  return await invoke<AssetInfo[]>("list_template_assets", { templateId });
}

/** 個別の素材ファイルを削除する */
export async function deleteTemplateAsset(
  templateId: string,
  kind: AssetKind,
  filename: string,
): Promise<void> {
  await invoke("delete_template_asset", { templateId, kind, filename });
}

/**
 * テンプレ ID 変更時（仮 ID → 確定 ID）に assets フォルダをリネームする。
 * 移行先が既に存在する場合はエラーになる（呼び出し側で握りつぶして良い）。
 */
export async function renameTemplateAssets(
  oldId: string,
  newId: string,
): Promise<void> {
  await invoke("rename_template_assets", { oldId, newId });
}

/**
 * 旧 `templates/audio/{tid}/` を `templates/assets/{tid}/audio/` に移行する
 * 一度限りのマイグレーション。アプリ起動時に 1 回呼ぶ。戻り値は移行できた tid 数。
 */
export async function migrateLegacyAudioDirs(): Promise<number> {
  return await invoke<number>("migrate_legacy_audio_dirs");
}

/**
 * Live2D モデルのフォルダ全体を `templates/assets/{templateId}/live2d/{model_name}/` に
 * 再帰コピーする。.model3.json から見える sister files (moc3 / textures / motions /
 * expressions / physics 等) は同階層のものを丸ごとコピーする。
 *
 * @returns コピー後の `.model3.json` の絶対パス
 */
export async function importLive2DModel(
  templateId: string,
  sourceModel3JsonPath: string,
): Promise<string> {
  return await invoke<string>("import_live2d_model", {
    templateId,
    sourceModel3JsonPath,
  });
}
