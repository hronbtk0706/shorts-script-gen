import { invoke } from "@tauri-apps/api/core";
import type { VideoTemplate } from "../types";
import { isValidV2Template } from "./layerUtils";

function genId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${rand}`;
}

function sanitizeIdPart(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24)
    || "template";
}

export function makeTemplateId(name: string): string {
  return genId(sanitizeIdPart(name));
}

export async function listTemplates(): Promise<VideoTemplate[]> {
  const raw: string[] = await invoke("list_templates");
  const list: VideoTemplate[] = [];
  for (const json of raw) {
    try {
      const parsed = JSON.parse(json);
      if (isValidV2Template(parsed)) {
        list.push(parsed);
      } else {
        console.warn(
          "[templateStore] 旧バージョンのテンプレはスキップ:",
          parsed?.name ?? parsed?.id,
        );
      }
    } catch (e) {
      console.warn("[templateStore] failed to parse template:", e);
    }
  }
  list.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return list;
}

export async function saveTemplate(template: VideoTemplate): Promise<void> {
  const json = JSON.stringify(template, null, 2);
  await invoke("save_template", { id: template.id, json });
}

export async function deleteTemplate(id: string): Promise<void> {
  await invoke("delete_template", { id });
}

export function duplicateTemplate(t: VideoTemplate): VideoTemplate {
  const newName = `${t.name} (copy)`;
  return {
    ...t,
    id: makeTemplateId(newName),
    name: newName,
    createdAt: new Date().toISOString(),
  };
}
