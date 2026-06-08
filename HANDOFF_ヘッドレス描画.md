# ヘッドレス・フレーム描画（curio-gen D9 ゲート用）

curio-gen の「レンダ済みの見た目」自動チェック（D9: 線交差・重なり・矢じり・はみ出し）が、
**本物の `renderLayersOnContext`** で描いた PNG を機械検査するための入口。
依頼書: `moviegenerate/docs/依頼_shorts-script-gen_ヘッドレス描画.md`。

## CLI 契約（curio-gen が叩くのはこれだけ）

```
node "<shorts-script-gen>/scripts/render-frames.mjs" \
  --template "<template.json の絶対パス>" \
  --times 1.2,3.4,5.6 \
  --out "<出力ディレクトリ>" \
  [--width 1920 --height 1080]   # 省略時 templateDimensions
```

- **stdout（1 行 JSON）**
  - 成功: `{"frames":[{"sec":1.2,"path":"<png絶対パス>"}, ...], "ok":true}` / exit 0
  - 失敗: `{"frames":[], "ok":false, "error":"..."}` / exit ≠ 0
- PNG ファイル名: `frame_<index>_<sec>.png`（例 `frame_0_1.2.png`）。path は **絶対パス**（`--out` 配下）。
- これは **純粋な node CLI**。curio-gen は subprocess で叩くだけで、Tauri アプリ内コマンドには触れない。

## 方式（Tauri 隠しウィンドウ）

`render-frames.mjs`（node ラッパー）が `shorts-script-gen.exe` を `--render-frames …` で spawn し、
**非表示の WebView2 ウィンドウ（`render.html` → `src/renderEntry.ts`）** で本物の描画経路を回す。
WebView2 = 本番と同じ Chromium 系エンジン＋同じ Windows システムフォントなので、
**テキスト折返し/はみ出し幾何が本番（編集プレビュー / WebCodecs エクスポート）と一致**する。

release ビルドの exe は `windows_subsystem="windows"` で stdout がパイプに乗らないため、
exe は `<out>/manifest.json` をファイル出力 → node ラッパーがそれを読んで自前 stdout に流す。

### exe の探索順（ラッパー）
1. `--exe <path>` 引数
2. 環境変数 `SHORTS_GEN_EXE`
3. `%LOCALAPPDATA%\shorts-script-gen\shorts-script-gen.exe`（インストール先）
4. `<repo>/src-tauri/target/release/shorts-script-gen.exe`（ビルド出力）

タイムアウト: 既定 120 秒（`SHORTS_GEN_RENDER_TIMEOUT_MS` で変更可）。超過時 exit 124。

## 描画の前処理（exportTemplateWebCodecs と一致）

`src/renderEntry.ts`:
1. `template = JSON.parse(templateJson)`
2. `dims = --width/--height 指定 ?? templateDimensions(template)` → `setCompositionCanvasDimensions(w,h)`
3. `visibleLayers = layers.filter(l => !l.hidden)`
4. `preloadHandwriteLayers(visibleLayers)`（筆順グリフを同期キャッシュへ）
5. 各秒 `renderLayersOnContext(ctx, visibleLayers, resolveSrc, { atTimeSec, applyAnim:true, transparent:false, groups, cameras, skipVideoLayers:false, hqSmoothing:true })`
6. `canvas.toDataURL("image/png")` → `save_render_frame_png` で保存
7. `finish_render(manifest)` → `<out>/manifest.json` 書込み＋`app.exit`

`resolveSrc`: image=絶対パス（`convertFileSrc` で WebView2 にロード）/ video・character=null（テクスチャ省略）/ auto・user・空=null。

## 依頼書「確認したいこと」への回答

### Q1. ブラウザ固有依存（Tauri API 以外）
描画経路は `OffscreenCanvas` / `document.createElement` / `new Image` / `fetch("/handwrite/*.json")` /
`DecompressionStream` を使う＝**WebView/Chromium 前提**。本方式は実 WebView2 上で回すので全て満たす。
`convertFileSrc` は Tauri 専用だが WebView2 内なので問題なし（image 背景もロード可）。
**決定性**: 描画経路に `Math.random`/`Date.now`/`performance.now` は無し（marker/disintegrate は layer.id seed の
mulberry32）。`atTimeSec` 固定で同じ秒は同じ絵。

### Q2. フォント読み込み
`public/` に webfont は**同梱されていない**。`TEXT_DEFAULT_FONT_STACK`（Hiragino/Yu Gothic/Meiryo/MS Gothic/
Noto…）は **OS のシステムフォントをそのまま使う**設計。WebView2 上で描けば DirectWrite 経由で
本番一致。`document.fonts` への追加ロードは不要。

### Q3. PNG の色空間/サイズ
- サイズ: `templateDimensions`（`--width/--height` で上書き可）。本番 export と同じ。
- 色空間: PNG は sRGB の素 Canvas ピクセル。本番動画は h264(YUV) なので最終ピクセルは厳密一致しないが、
  **D9 は幾何（座標・折返し・重なり）が目的**で、幾何はエンジン一致なら一致する。問題なし。

### video=黒箱について
D9 はカード要素（text/shape）の幾何が目的。カード層は絶対座標で背景動画に依存しないため、
video テクスチャを省いても**カード幾何は完全一致**（＝以前却下した「別レンダラによる近似」とは別物。
今回は同じ `renderLayersOnContext` を使い、動画テクスチャだけ省く faithful な描画）。
将来「背景との対比」チェックが必要になったら video フレーム抽出を足す。

## 実装ファイル
- `scripts/render-frames.mjs` — node CLI ラッパー（exe spawn → manifest 中継）
- `render.html` + `src/renderEntry.ts` — 隠しウィンドウの描画エントリ
- `src-tauri/src/lib.rs` — `--render-frames` CLI 解析 / 隠しウィンドウ起動 / `get_render_args` `save_render_frame_png` `finish_render` コマンド
- `src-tauri/tauri.conf.json` — main ウィンドウに `label:"main"` / `visible:false`（起動時 setup で show）
- `vite.config.ts` — `render.html` を 2 つ目のビルドエントリに追加
