import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { VideoTemplate, Layer } from "../types";

/**
 * テンプレートを .zip に書き出す（テンプレ本体 + 参照素材を同梱）。
 * 戻り値: 書き出した zip の絶対パス。キャンセル時は null。
 */
export async function exportTemplatePack(
  template: VideoTemplate,
): Promise<string | null> {
  const defaultName = `${sanitizeFilename(template.name || template.id || "template")}.zip`;
  const zipPath = await saveDialog({
    defaultPath: defaultName,
    filters: [{ name: "Template Pack", extensions: ["zip"] }],
  });
  if (!zipPath) return null;

  // layers を走査して、絶対パスで source が指定されているものを assets にまとめる
  const assets: Array<[string, string]> = []; // [zip内相対パス, 元の絶対パス]
  const usedNames = new Set<string>();
  const clonedLayers: Layer[] = template.layers.map((l) => ({ ...l }));

  for (const layer of clonedLayers) {
    if (!needsAssetCollection(layer)) continue;
    const absPath = layer.source as string;
    const basename = extractBasename(absPath);
    // 衝突回避のため layer.id を先頭に付ける
    let entryName = `assets/${layer.id}_${basename}`;
    let n = 1;
    while (usedNames.has(entryName)) {
      entryName = `assets/${layer.id}_${n}_${basename}`;
      n++;
    }
    usedNames.add(entryName);
    assets.push([entryName, absPath]);
    layer.source = entryName; // json 上は相対パスに書き換え
  }

  const rewritten: VideoTemplate = { ...template, layers: clonedLayers };
  const templateJson = JSON.stringify(rewritten, null, 2);

  await invoke("pack_template_to_zip", {
    outputZipPath: zipPath,
    templateJson,
    assets,
  });

  return zipPath;
}

/**
 * .zip からテンプレートを読み込む。素材はアプリ管理フォルダに展開して、
 * layer.source を展開先の絶対パスに書き換えた上で VideoTemplate を返す。
 * キャンセル時は null。
 */
export async function importTemplatePack(): Promise<VideoTemplate | null> {
  const selected = await openDialog({
    multiple: false,
    filters: [{ name: "Template Pack", extensions: ["zip"] }],
  });
  if (!selected || Array.isArray(selected)) return null;

  const templateJson = await invoke<string>("unpack_template_zip", {
    zipPath: selected,
  });

  const parsed = JSON.parse(templateJson) as VideoTemplate;
  return parsed;
}

function needsAssetCollection(layer: Layer): boolean {
  if (layer.type !== "image" && layer.type !== "video" && layer.type !== "audio") {
    return false;
  }
  const src = layer.source;
  if (!src) return false;
  if (src === "auto" || src === "user") return false;
  // 既に相対パス "assets/xxx" なら再パック不要（理論上は起きないはず）
  if (src.startsWith("assets/")) return false;
  return true;
}

function extractBasename(p: string): string {
  // Windows でも Unix でもセパレータを最後のものに合わせる
  const parts = p.split(/[\\\/]/);
  const last = parts[parts.length - 1] || "asset";
  return last;
}

function sanitizeFilename(s: string): string {
  // Windows の不正文字を除去
  return s.replace(/[\\\/:*?"<>|]/g, "_").trim() || "template";
}
