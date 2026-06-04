# 引き継ぎ書 — 2026-06-04（手書き「筆順」テキスト Phase A）

curio-gen 依頼書 `依頼書_手書き筆順テキスト_shorts-script-gen.md`（★最優先・本命）の **Phase A** 実装。
**文字が一画ずつ「書かれていく」手書きアニメ**のエンジン・サーフェス・ASCII 筆順・char-sweep フォールバックを
**preview＝書き出し一致**で実装した。日本語（漢字・かな）の本物の筆順データ（KanjiVG）同梱は **Phase B（次ステップ）**。

> **curio-gen 担当へ**: 下記「確定フィールド名・surface 値・既定値」に合わせて `[[WRITE ...]]` を emit してください。

---

## 1. 何ができるか（Phase A）

- comment レイヤーに `handwrite` を付けると、本文を **一画ずつ書かれていく**アニメで描画。ペン先が画線の先端を走り軌跡が残る。
- **ASCII（英数記号）は Hershey 単線フォントの筆順**で本物の write-on（同梱済み `public/handwrite/ascii.json`）。
- **日本語（漢字・かな）は現状 char-sweep**（左→右の掃出し出現）で全表示まで到達（破綻しない）。Phase B で本物の筆順に置換。
- **surface（下地）**: 黒板/ホワイトボード/ノート/なし。既定インク色・ペン先を供給。
- 停止/スクラブ/編集中は **全文表示**（レイアウト安定）。再生・書き出しは時刻どおり書き進む。
- 決定論的（seed=layer.id）で preview/export 一致。

---

## 2. 確定 JSON フィールド（curio 連携）

comment レイヤーに付与:
```ts
handwrite?: {
  order?: "normal";   // 既定 normal（読み順）
  speed?: number;     // 自動書き秒への倍率（既定 1。大きいほど速い）
  tip?: "chalk" | "pen" | "marker" | "pencil"; // 未指定は surface 既定
  jitter?: number;    // 手書き揺れ 0..2（既定 0.5）
  strokeWidth?: number; // 線の太さ design(360)px（未指定 ≒ fontSize*0.07）
};
surface?: "none" | "blackboard" | "whiteboard" | "notebook"; // 既定 none
```
- 色は既存 `fontColor` を流用（未指定は surface 既定インク）。
- 書き秒は自動（`entryDuration` があればそれを採用、無ければ `clamp(0.6, 0.12×画数, 12)`）÷ `speed`。
- 例: `text:"10.000 M", handwrite:{}, surface:"blackboard"` → 黒板に白チョークで ASCII が一画ずつ。

### surface プリセット既定
| surface | 背景 | 既定インク | 既定ペン先 | 追加 |
|---|---|---|---|---|
| none | 透明 | fontColor or #FFFFFF | pen | — |
| blackboard | #2E3D34 | #FAFAF0 | chalk | インク α0.92 |
| whiteboard | #FAFAFA＋#DDD 枠 | #2B6CB0 | marker | — |
| notebook | #FFFEF7＋横罫線＋赤マージン | #1A237E | pen | 罫線は各行ベースライン |

---

## 3. 実装（preview=export 単一レンダラ）

- **合成キャンバス＝書き出し経路**: 手書きは export 経路 `drawHandwriteShape`（[layerComposer.ts](src/lib/layerComposer.ts)）
  だけで描き、プレビューの合成キャンバスがそれを表示（particles/speedlines と同方式）。DOM 側は `renderLayerContent`
  で `return null`（[TemplateCanvas.tsx](src/components/TemplateCanvas.tsx)）＝二重実装ゼロ。
- **幾何エンジン**: 新規 [src/lib/handwriteStroke.ts](src/lib/handwriteStroke.ts) `computeHandwrite`。
  セル割り→行折返し→各文字を筆順ストロークに解決→書き順 1 列化→各画を長さ重みの進捗窓に割当→
  marker の `truncate`/`localP`（[markerShape.ts](src/lib/markerShape.ts) から export 共有）で一画ずつ描画。
  ペン先・char-sweep・jitter・SURFACE_PRESETS もここ。
- **字形 provider**: 新規 [src/lib/handwriteGlyphs.ts](src/lib/handwriteGlyphs.ts)。
  `public/handwrite/ascii.json` を fetch → module 同期キャッシュ `glyphCache`。`getGlyph`(同期) / `preloadGlyphs` /
  `preloadHandwriteLayers`(非同期・描画前)。未ロード字は undefined → char-sweep。
  Phase B 用に index.json/gzip シャード＋`DecompressionStream` の枠あり。
- **非同期→同期の橋渡し**: フレームループ前に preload（[exportTemplateWebCodecs.ts](src/lib/exportTemplateWebCodecs.ts) は
  キャラ事前焼き直後に `await preloadHandwriteLayers`、preview は handwrite 本文 key の useEffect で preload→再合成）。
  Live2D キャラ事前焼きと同じ思想。
- **停止時の全文表示**: `renderLayersOnContext` に opt `staticHandwrite` 追加。preview が停止/スクラブ時に
  `!isPlaying` を渡す（module flag 経由）。実 export は渡さない＝時刻どおり。
- **データ生成**: [scripts/build-handwrite-glyphs.mjs](scripts/build-handwrite-glyphs.mjs)（`npm run build:glyphs`）。
  Hershey(futural) → 正規化ポリライン JSON。Phase B でここに KanjiVG 取得＋サンプリングを追加。
- **UI**: [LayerPropertyPanel.tsx](src/components/LayerPropertyPanel.tsx) テキストセクションに手書き ON/OFF＋
  surface/ペン先/速度/揺れ/太さ。
- devDep: `hersheytext`（ビルド時のみ）。runtime 追加 dep なし（データは JSON 同梱）。

---

## 4. Phase B（次ステップ・本 PR 外）— 全 KanjiVG 同梱

- 全 KanjiVG（**CC BY-SA 3.0**）を取得 → `svg-path-properties` で画ごとサンプリング → codepoint シャード（gzip）→
  `public/handwrite/`＋`index.json` 同梱。`handwriteGlyphs.ts` の `shardForCodepoint` にかな/漢字を割当てれば有効化。
- **ライセンス（要対応）**: KanjiVG は **CC BY-SA 3.0**。同梱時は `public/handwrite/ATTRIBUTION.txt` ＋
  アプリ内クレジット導線（既存 `AssetCredit`/概要欄）に **KanjiVG 表示が必須**、派生データも同ライセンス。
  Hershey はパブリックドメイン（義務なし）。
- ユーザー確定: 収録範囲は **全 KanjiVG**（漢字 6000+・かな）。

---

## 5. 続行・確認手順
1. `git pull`
2. `npm install`（hersheytext 追加のため）／必要なら `npm run build:glyphs`
3. アプリ終了を確認して `npm run tauri build`（起動中だと exe ロックで失敗）
4. 動作確認: comment に `handwrite:{}`＋`surface:"blackboard"`＋"10.000 M" → ASCII が一画ずつ書かれる。
   日本語本文は char-sweep で全表示。再生＝書き出し一致を目視。
