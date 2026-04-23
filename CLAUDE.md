# プロジェクト固有のルール

このファイルはセッション冒頭で自動的に読み込まれる。Claude Code はここに書かれた指針に従って作業する。

## 🎯 最重要: プレビューとエクスポートをセットで変更する

このアプリは **編集画面のプレビュー (React / Canvas / HTMLAudioElement 等)** と
**エクスポート (Rust + FFmpeg filter_complex)** の **2 系統** で同じ映像を再現している。
**どちらか片方だけ変更すると「見た目と出力が違う」という不整合バグ**が発生しやすい。

レイヤーのプロパティ追加 / 既存プロパティの挙動変更 / アニメ追加などを行うときは、
必ず **両系統を同時に変更する** こと。片側だけ実装してコミットしない。

### 変更チェックリスト

新しい Layer プロパティ・アニメ・エフェクトを追加するとき、以下を**全部**確認:

1. **型定義**: [src/types.ts](src/types.ts) の `Layer` / `LayerKeyframes` 等に追加
2. **プレビュー側**（片方でも抜けたら効かないので注意）
   - [src/components/TemplateCanvas.tsx](src/components/TemplateCanvas.tsx) の `LayerView` / `AudioLayerPlayer` / `computeLayer*` 系
   - [src/lib/layerComposer.ts](src/lib/layerComposer.ts) の `drawLayer` / `applyKeyframesAtTime`
   - [src/lib/keyframes.ts](src/lib/keyframes.ts) の `sampleLayerAt`（キーフレーム対応プロパティなら）
3. **エクスポート側**（Rust + FFmpeg）
   - [src/lib/video.ts](src/lib/video.ts) の `RustTemplateLayerInput` / `RustTemplateAudioInput` に field 追加、送信する値をセット
   - [src-tauri/src/lib.rs](src-tauri/src/lib.rs) の `TemplateLayerInput` / `TemplateAudioInput` に `#[serde(default = ...)]` で追加
   - `compose_template_video_inner` 内の filter_complex 構築処理で実際に使う
     - ビデオ系: overlay / scale / rotate / fade 等のチェーンに反映
     - 音声系: `atempo` / `volume` / `afade` / `adelay` 等のチェーンに反映
   - キーフレーム対応プロパティなら `keyframe_expr` + ffmpeg 式に組み込み
4. **UI 編集**: [src/components/LayerPropertyPanel.tsx](src/components/LayerPropertyPanel.tsx)
   - 上部バー（常時表示）or タブ内セクションに編集 UI を追加
   - 必要なら `numInput` / `sliderInput` / `colorInput` ヘルパを使う
5. **プリセット / パック**: [src/lib/presetStore.ts](src/lib/presetStore.ts) / [src/lib/templatePack.ts](src/lib/templatePack.ts)
   - 基本は `...layer` コピーで自動追従するが、**別ファイル参照の絶対パス**を持つプロパティなら pack のアセット収集対象にする

### 典型的な失敗例（過去に起きたもの）

- **playbackRate を追加したが、プレビューの `<audio>` に反映せずエクスポートだけ効いた**
  → 「速度が変わらない気がする」と言われる。**Preview の AudioLayerPlayer にも `a.playbackRate = ...` を書く必要**
- **volume スライダーを 0〜2 に広げたが、`HTMLAudioElement.volume` は 0〜1 クランプ**
  → 100% 超が聞こえない。**Web Audio API の GainNode を経由する** 必要
- **motion / color をシーン単位から廃止したが TS 型に `Motion` 型定義が残存** 等

### 「どちらか片方だけ」が許される例外

- プレビュー専用の UI（選択枠 / グリッド線 / ドラッグ中のガイド線）
- エクスポート専用の調整（faststart / GOP / CRF などのエンコード設定）
- それ以外は**基本セット変更**と考える

## その他のプロジェクト固有ルール

### アセットパスの扱い
- レイヤーの `source` は **絶対パス** で保存される運用
- 別 PC へ移すとパスが切れるので、**テンプレートパック (.zip) 機能** で素材ごと書き出し / 読み込みすること
- git の templates/*.json に絶対パスが入るのは不可避（Owner PC と user1 PC で互いに上書きしやすい）ので、
  **テンプレの共有は pack (.zip) 経由を推奨**

### シーン・セグメント概念は廃止済み
- `segments` / `TemplateSegment` / `Script` / `hook/body/cta` は旧方式。もう使わない
- 動画はレイヤーだけで構成され、1 回の `compose_template_video` 呼び出しで合成される

### Undo 挙動
- マウス押下中（ドラッグ / リサイズ）は history push を抑制して、pointer up で 1 件だけ commit する方式
- 新規に state 変更を多発する操作を追加するときは、**既存の `isPointerDownRef` / `pendingCommitRef` 仕組みに乗る** か、別途 debounce を入れる

### キーフレーム
- 対応プロパティ: `x` / `y` / `scale` / `opacity` / `rotation`
- 補間は **linear のみ**（将来 easing 追加予定）
- プレビュー: [src/components/TemplateCanvas.tsx](src/components/TemplateCanvas.tsx) の LayerView で **再生中のみ** 補間値を適用（編集中は静的値でドラッグを妨げない）
- エクスポート: [src-tauri/src/lib.rs](src-tauri/src/lib.rs) の `keyframe_expr` で ffmpeg if 式に展開
- opacity のエクスポート時キーフレーム補間は**未対応**（プレビューのみ動く）
