/**
 * ヘッドレス・フレーム描画エントリ（curio-gen の D9 ゲート用）。render.html から起動する。
 *
 * Tauri が `--render-frames --template … --times … --out …` で起動すると、隠しウィンドウで
 * このスクリプトが走る。本物の `renderLayersOnContext`（exportTemplateWebCodecs と同じ前処理）で
 * 各秒の PNG を Canvas 合成して書き出し、`<out>/manifest.json` を残してプロセスを終了する。
 *
 * 本番一致のポイント:
 *   - 寸法は templateDimensions（--width/--height で上書き可）
 *   - visibleLayers = layers.filter(!hidden)（export と同じ）
 *   - preloadHandwriteLayers で筆順グリフを同期キャッシュへ
 *   - フォントは WebView2(=本番) のシステムフォント（TEXT_DEFAULT_FONT_STACK）がそのまま効く
 *   - groups / cameras も渡す（group/camera 変換下のカード幾何を本番と一致させる）
 *   - applyAnim:true / transparent:false
 *   - video / character はテクスチャを省く（resolveSrc が null）。D9 はカード(text/shape)幾何が
 *     目的で、カードは絶対座標なので背景動画の有無に依存しない。画像背景・color scrim は描画する。
 */
import { invoke } from "@tauri-apps/api/core";
import type { Layer, VideoTemplate } from "./types";
import { templateDimensions } from "./types";
import {
  setCompositionCanvasDimensions,
  renderLayersOnContext,
  type LayerSourceResolver,
} from "./lib/layerComposer";
import { preloadHandwriteLayers } from "./lib/handwriteGlyphs";

interface RenderArgs {
  templateJson: string;
  times: number[];
  outDir: string;
  width?: number | null;
  height?: number | null;
}

/** manifest を書いてプロセス終了（exit code は ok で決まる）。例外は握りつぶす（必ず終了させる）。 */
async function finish(
  outDir: string,
  manifest: Record<string, unknown>,
  ok: boolean,
): Promise<void> {
  try {
    await invoke("finish_render", {
      outDir,
      manifestJson: JSON.stringify(manifest),
      ok,
    });
  } catch {
    /* finish_render は app.exit するので戻ってこない。失敗時もここで握りつぶす。 */
  }
}

/** 秒をファイル名向けに整形（1.2 → "1.2", 3 → "3"）。Windows でも安全な文字だけ使う。 */
function secToken(sec: number): string {
  return String(sec).replace(/[^0-9.]/g, "_");
}

async function main(): Promise<void> {
  let args: RenderArgs | null = null;
  try {
    args = await invoke<RenderArgs | null>("get_render_args");
  } catch (e) {
    await finish("", { frames: [], ok: false, error: `get_render_args: ${e}` }, false);
    return;
  }
  if (!args) {
    await finish("", { frames: [], ok: false, error: "no render args" }, false);
    return;
  }
  const outDir = args.outDir;

  try {
    const template = JSON.parse(args.templateJson) as VideoTemplate;
    const dims =
      args.width && args.height
        ? { width: args.width, height: args.height }
        : templateDimensions(template);
    setCompositionCanvasDimensions(dims.width, dims.height);

    const visibleLayers: Layer[] = (template.layers ?? []).filter((l) => !l.hidden);

    // 筆順グリフを同期キャッシュへ（描画は同期なので先読みが必須）
    await preloadHandwriteLayers(visibleLayers);

    // image は絶対パスを返す（loadImage が convertFileSrc 経由で WebView2 にロード）。
    // video / character はテクスチャを省く（D9 はカード幾何が目的）。auto/user/空は null。
    const resolveSrc: LayerSourceResolver = async (l) => {
      if (l.type === "video" || l.type === "character") return null;
      if (!l.source || l.source === "auto" || l.source === "user") return null;
      return l.source;
    };

    const canvas = document.createElement("canvas");
    canvas.width = dims.width;
    canvas.height = dims.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context を取得できませんでした");

    const frames: { sec: number; path: string }[] = [];
    for (let i = 0; i < args.times.length; i++) {
      const sec = args.times[i];
      await renderLayersOnContext(ctx, visibleLayers, resolveSrc, {
        skipVideoLayers: false,
        atTimeSec: sec,
        applyAnim: true,
        transparent: false,
        groups: template.groups,
        cameras: template.cameras,
        hqSmoothing: true,
      });
      const dataUrl = canvas.toDataURL("image/png");
      const base64 = dataUrl.split(",", 2)[1];
      const path = await invoke<string>("save_render_frame_png", {
        outDir,
        filename: `frame_${i}_${secToken(sec)}`,
        base64Data: base64,
      });
      frames.push({ sec, path });
    }

    await finish(outDir, { frames, ok: true }, true);
  } catch (e) {
    const err = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
    await finish(outDir, { frames: [], ok: false, error: err }, false);
  }
}

void main();
