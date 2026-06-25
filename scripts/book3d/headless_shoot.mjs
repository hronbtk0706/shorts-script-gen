/**
 * book3d ヘッドレス検証ドライバ（Playwright/Chromium = 実機 WebView2 と同系）。
 *
 * 「めくり最終状態の位置ズレ」等を推測でなく実フレームで確認するための道具。
 * vite dev server（`npm run dev`, 既定 http://localhost:1420）を起動しておき、本スクリプトで
 * book3d_headless.html?t=秒 を複数の t で開いて canvas を PNG 保存 + 各 page node の
 * world bbox 診断 JSON を出す。glb は public へ一時複製して配信し、終了時に消す
 * （public に常駐させると tauri build の dist/exe が肥大化するため）。
 *
 * 使い方:
 *   node scripts/book3d/headless_shoot.mjs [glbPath] [outDir] [t1,t2,...] [baseURL]
 * 既定:
 *   glbPath = ../curio-gen/anime/videos/rezero_001/rezero_book_open_clean.glb
 *   outDir  = .   t = 0,1.5,2.25,3,4   baseURL = http://localhost:1420
 * 一時ファイル: 検証用。コミット対象外。
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const glbPath =
  process.argv[2] ||
  resolve(repoRoot, "..", "curio-gen", "anime", "videos", "rezero_001", "rezero_book_open_clean.glb");
const outDir = process.argv[3] || ".";
const times = (process.argv[4] || "0,1.5,2.25,3,4").split(",").map(Number);
const baseURL = process.argv[5] || "http://localhost:1420";

if (!existsSync(glbPath)) {
  console.error(`glb not found: ${glbPath}`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

// public へ一時複製（vite が /_book3d_headless.glb で配信）。.gitignore 済み。
const served = resolve(repoRoot, "public", "_book3d_headless.glb");
copyFileSync(glbPath, served);
console.log(`served glb: ${glbPath} -> public/_book3d_headless.glb`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1320, height: 760 } });
page.on("console", (m) => {
  if (m.type() === "error" || /error|fail/i.test(m.text())) console.log("  [page]", m.type(), m.text());
});

const allDiag = [];
try {
  // ウォームアップ（最初のナビゲーションで WebGL context lost になり 1 枚目が空になるのを回避）。
  await page.goto(`${baseURL}/book3d_headless.html?t=0`, { waitUntil: "load" });
  await page.waitForFunction("window.__done === true", null, { timeout: 30000 }).catch(() => {});

  for (const t of times) {
    await page.goto(`${baseURL}/book3d_headless.html?t=${t}`, { waitUntil: "load" });
    await page.waitForFunction("window.__done === true", null, { timeout: 30000 });
    const err = await page.evaluate("window.__error || null");
    if (err) {
      console.error(`t=${t} ERROR:\n${err}`);
      continue;
    }
    allDiag.push(await page.evaluate("window.__diag"));
    const file = `${outDir}/book3d_t${String(t).replace(".", "_")}.png`;
    await page.locator("#stage").screenshot({ path: file });
    console.log(`t=${t} -> ${file}`);
  }
  writeFileSync(`${outDir}/book3d_diag.json`, JSON.stringify(allDiag, null, 2));
  console.log(`diag -> ${outDir}/book3d_diag.json`);
} finally {
  await browser.close();
  rmSync(served, { force: true });
  console.log("cleaned public/_book3d_headless.glb");
}
