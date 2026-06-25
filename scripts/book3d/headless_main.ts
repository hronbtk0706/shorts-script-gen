/**
 * book3d ヘッドレス検証ハーネス（実機 Book3DRenderer をそのまま使う）。
 *
 * 目的: 「めくり最終状態(3s以降)の位置ズレ」を推測でなく実フレームで確認する。
 * Playwright(Chromium=実機 WebView2 と同系) でこのページを開き、?t=秒 ごとに
 * 1 frame 描いて canvas を screenshot する。各 flipper の world bbox も window.__diag に出す。
 *
 * 一時ファイル: 検証後に削除してよい。
 */
import * as THREE from "three";
import { Book3DRenderer } from "../../src/lib/book3dRender";
import type { BookCamera, BookFlipKeyframe } from "../../src/types";

// test-bookflip-h.json と同一条件（カメラ・めくり）。
const CAMERA: BookCamera = {
  yaw: -90,
  pitch: -55,
  distance: 6.2,
  targetY: 0,
  lens: 56,
};
const FLIPS: BookFlipKeyframe[] = [{ atSec: 1.5, page: 1, durationSec: 1.5 }];
const GLB_URL = "/_book3d_headless.glb";

const W = 1280;
const H = 720;

// slot を識別するためのラベル付き単色テクスチャ（どのページがどこへ行ったか判別用）。
const SLOT_COLORS = ["#e23b3b", "#2f7fe2", "#2fae54", "#d49a1a", "#9a4fd4", "#19a7a7"];
function labelCanvas(label: string, color: string): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = 512;
  cv.height = 724;
  const c = cv.getContext("2d")!;
  c.fillStyle = color;
  c.fillRect(0, 0, cv.width, cv.height);
  c.fillStyle = "rgba(255,255,255,0.92)";
  c.font = "bold 64px sans-serif";
  c.textAlign = "center";
  c.textBaseline = "middle";
  for (const [i, ln] of label.split("\n").entries()) {
    c.fillText(ln, cv.width / 2, cv.height / 2 - 40 + i * 80);
  }
  // 上下の向きが分かるよう上端に矢印帯
  c.fillStyle = "rgba(0,0,0,0.55)";
  c.fillRect(0, 0, cv.width, 70);
  c.fillStyle = "#fff";
  c.font = "bold 44px sans-serif";
  c.fillText("▲ TOP", cv.width / 2, 36);
  return cv;
}

function getParam(name: string, def: number): number {
  const v = new URLSearchParams(location.search).get(name);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : def;
}

async function main(): Promise<void> {
  const t = getParam("t", 3.0);
  const canvas = document.getElementById("stage") as HTMLCanvasElement;
  canvas.width = W;
  canvas.height = H;
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";

  const renderer = new Book3DRenderer(canvas, W, H);
  await renderer.loadModel(GLB_URL);
  renderer.setCamera(CAMERA);

  // 各 slot に識別ラベルを貼る（位置判別用）。slotNames は glb 実在マテリアル。
  const slots = renderer.slotNames();
  for (const [i, s] of slots.entries()) {
    await renderer.setSlotTexture(s, labelCanvas(s, SLOT_COLORS[i % SLOT_COLORS.length]));
  }

  renderer.applyFlip(FLIPS, t);
  renderer.renderFrame();

  // 診断: 各 flipper/page node の world bbox（min/max/center）を出す。
  // 「最終 3s で Page3-4 が Page1-2 と一致するはず」を実測で照合する。
  const diag: Record<string, unknown> = { t, slots };
  // renderer 内部にアクセスできないので scene を辿る（root は scene の子）。
  const sceneAny = (renderer as unknown as { scene: THREE.Scene }).scene;
  const nodes: Record<string, { min: number[]; max: number[]; center: number[] }> = {};
  sceneAny.traverse((o) => {
    if (/^(page|flipper)/i.test(o.name)) {
      const box = new THREE.Box3().setFromObject(o);
      if (!box.isEmpty()) {
        nodes[o.name] = {
          min: box.min.toArray().map((v) => +v.toFixed(4)),
          max: box.max.toArray().map((v) => +v.toFixed(4)),
          center: box.getCenter(new THREE.Vector3()).toArray().map((v) => +v.toFixed(4)),
        };
      }
    }
  });
  diag.nodes = nodes;
  (window as unknown as { __diag: unknown }).__diag = diag;
  (window as unknown as { __done: boolean }).__done = true;
}

main().catch((e) => {
  (window as unknown as { __error: string }).__error = String(e?.stack || e);
  (window as unknown as { __done: boolean }).__done = true;
});
