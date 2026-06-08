#!/usr/bin/env node
/**
 * ヘッドレス・フレーム描画 CLI（curio-gen の D9 ゲートが subprocess で叩く入口）。
 *
 *   node scripts/render-frames.mjs --template <template.json> --times 1.2,3.4 --out <dir> [--width W --height H]
 *
 * stdout に JSON manifest を 1 行で出力し、exit code で成否を返す:
 *   成功: {"frames":[{"sec":1.2,"path":"<png絶対パス>"}, ...], "ok":true}        exit 0
 *   失敗: {"frames":[], "ok":false, "error":"..."}                                exit != 0
 *
 * 実体は shorts-script-gen.exe（Tauri / WebView2）を `--render-frames …` で spawn し、
 * 本物の renderLayersOnContext で描画させる方式（フォント・折返し幾何が本番と完全一致）。
 * release ビルドの exe は GUI サブシステムで stdout がパイプに乗らないため、exe は
 * `<out>/manifest.json` をファイル出力し、この node ラッパーがそれを読んで stdout に流す。
 *
 * exe の場所（優先順）:
 *   1. --exe <path> 引数
 *   2. 環境変数 SHORTS_GEN_EXE
 *   3. %LOCALAPPDATA%\shorts-script-gen\shorts-script-gen.exe（インストール先）
 *   4. <repo>/src-tauri/target/release/shorts-script-gen.exe（ビルド出力）
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--template") out.template = argv[++i];
    else if (a === "--times") out.times = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--width") out.width = argv[++i];
    else if (a === "--height") out.height = argv[++i];
    else if (a === "--exe") out.exe = argv[++i];
  }
  return out;
}

function findExe(override) {
  const candidates = [];
  if (override) candidates.push(override);
  if (process.env.SHORTS_GEN_EXE) candidates.push(process.env.SHORTS_GEN_EXE);
  const local = process.env.LOCALAPPDATA;
  if (local) {
    candidates.push(join(local, "shorts-script-gen", "shorts-script-gen.exe"));
  }
  const here = fileURLToPath(new URL(".", import.meta.url));
  candidates.push(
    resolve(here, "..", "src-tauri", "target", "release", "shorts-script-gen.exe"),
  );
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

function emitError(msg, code = 1) {
  process.stdout.write(
    JSON.stringify({ frames: [], ok: false, error: String(msg) }) + "\n",
  );
  process.exit(code || 1);
}

function emitManifest(manifest) {
  process.stdout.write(JSON.stringify(manifest) + "\n");
  process.exit(manifest && manifest.ok ? 0 : 1);
}

const args = parseArgs(process.argv.slice(2));
if (!args.template || !args.times || !args.out) {
  emitError("usage: --template <path> --times a,b,c --out <dir> [--width W --height H]");
}

const templateAbs = isAbsolute(args.template)
  ? args.template
  : resolve(process.cwd(), args.template);
const outAbs = isAbsolute(args.out) ? args.out : resolve(process.cwd(), args.out);

if (!existsSync(templateAbs)) emitError(`template not found: ${templateAbs}`);

const exe = findExe(args.exe);
if (!exe) {
  emitError(
    "shorts-script-gen.exe が見つかりません。--exe か環境変数 SHORTS_GEN_EXE で指定してください。",
  );
}

// 前回の manifest が残っていると古い結果を読むので消しておく
const manifestPath = join(outAbs, "manifest.json");
try {
  rmSync(manifestPath, { force: true });
} catch {
  /* noop */
}

const childArgs = [
  "--render-frames",
  "--template",
  templateAbs,
  "--times",
  args.times,
  "--out",
  outAbs,
];
if (args.width) childArgs.push("--width", String(args.width));
if (args.height) childArgs.push("--height", String(args.height));

const TIMEOUT_MS = Number(process.env.SHORTS_GEN_RENDER_TIMEOUT_MS || 120000);

const child = spawn(exe, childArgs, { stdio: "ignore", windowsHide: true });

const timer = setTimeout(() => {
  try {
    child.kill();
  } catch {
    /* noop */
  }
  emitError(`render timed out after ${TIMEOUT_MS}ms`, 124);
}, TIMEOUT_MS);

child.on("error", (e) => {
  clearTimeout(timer);
  emitError(`exe spawn failed: ${e.message}`);
});

child.on("exit", (code) => {
  clearTimeout(timer);
  if (!existsSync(manifestPath)) {
    emitError(`manifest.json が生成されませんでした (exe exit ${code})`, code || 1);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    emitError(`manifest.json の parse 失敗: ${e.message}`);
    return;
  }
  emitManifest(manifest);
});
