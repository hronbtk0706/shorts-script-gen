# プロジェクト固有のルール

このファイルはセッション冒頭で自動的に読み込まれる。Claude Code はここに書かれた指針に従って作業する。

## 🎯 最重要: プレビューとエクスポートをセットで変更する

このアプリは **編集画面のプレビュー (React / CSS / HTMLAudioElement)** と
**エクスポート (WebCodecs 経路: Canvas 合成 + mediabunny で h264/AAC encode)** の
**2 系統** で同じ映像を再現している。
**どちらか片方だけ変更すると「見た目と出力が違う」という不整合バグ**が発生しやすい。

> **2026-05-29 以降**: 旧 ffmpeg + filter_complex の動画合成経路 (`compose_template_video`) は
> **撤去済み**。エクスポートは WebCodecs に一本化された（`exportTemplateWebCodecs.ts`）。
> ffmpeg.exe 自体は音声系（TTS / BGM / 尺取得）でまだ使うが、**動画合成には使わない**。
> エクスポート側の編集は Rust ではなく **TS の Canvas 描画コード** を触ること。

レイヤーのプロパティ追加 / 既存プロパティの挙動変更 / アニメ追加などを行うときは、
必ず **両系統を同時に変更する** こと。片側だけ実装してコミットしない。

### 変更チェックリスト

新しい Layer プロパティ・アニメ・エフェクトを追加するとき、以下を**全部**確認:

1. **型定義**: [src/types.ts](src/types.ts) の `Layer` / `LayerKeyframes` 等に追加
2. **プレビュー側**（片方でも抜けたら効かないので注意）
   - [src/components/TemplateCanvas.tsx](src/components/TemplateCanvas.tsx) の `LayerView` / `AudioLayerPlayer` / `computeLayer*` 系
   - [src/lib/layerComposer.ts](src/lib/layerComposer.ts) の `drawLayer` / `applyKeyframesAtTime`
   - [src/lib/keyframes.ts](src/lib/keyframes.ts) の `sampleLayerAt`（キーフレーム対応プロパティなら）
3. **エクスポート側**（WebCodecs / Canvas — Rust ではない）
   - [src/lib/layerComposer.ts](src/lib/layerComposer.ts) の `drawLayer`（レイヤー中身の Canvas 描画。
     image/video/character/color/shape/comment の分岐）に反映
   - 入退場 / Ambient アニメは [src/lib/layerAnimCanvas.ts](src/lib/layerAnimCanvas.ts) の
     `computeCanvasAnim` / `applyCanvasAnim`（**プレビューの `computeLayerAnimStyle` /
     `computeLayerAmbientStyle` と数式を完全一致させる**）
   - テキスト演出は `drawAnimatedTextFrame` / `drawAnimatedToken`（プレビュー `renderAnimatedText` と一致）
   - 音声は [src/lib/exportTemplateWebCodecs.ts](src/lib/exportTemplateWebCodecs.ts) の `mixAudioLayers`
     （OfflineAudioContext + GainNode で volume / fade / playbackRate を反映）
   - 動画レイヤーは同ファイルの `buildVideoStream`（mediabunny VideoSampleSink）、
     character は `composeCharacterLayerVideo` で事前焼き → video と同経路
   - キーフレーム対応プロパティなら `renderLayersOnContext` の `applyKeyframesAtTime` が
     毎フレーム補間値を反映する（`sampleLayerAt` 経由）。新プロパティを kf 対応にするならそこに追加
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
- エクスポート専用の調整（mediabunny の codec / bitrate / fps などの encode 設定）
- 動画ファイルの原理上どうしても再現できない差（例: キャラ物理のリアルタイム揺らぎ＝固定 fps で焼くと毎回同じ結果になる）
  ※ flip の 3D perspective は「preview 専用」ではなく、列スライス warp (`drawFlipWarp`) で export でも厳密再現済み
- それ以外は**基本セット変更**と考える

## その他のプロジェクト固有ルール

### アセットパスの扱い
- レイヤーの `source` は **絶対パス** で保存される運用
- 別 PC へ移すとパスが切れるので、**テンプレートパック (.zip) 機能** で素材ごと書き出し / 読み込みすること
- git の templates/*.json に絶対パスが入るのは不可避（Owner PC と user1 PC で互いに上書きしやすい）ので、
  **テンプレの共有は pack (.zip) 経由を推奨**

### シーン・セグメント概念は廃止済み
- `segments` / `TemplateSegment` / `Script` / `hook/body/cta` は旧方式。もう使わない
- 動画はレイヤーだけで構成され、1 回の WebCodecs エクスポート（`exportTemplateWebCodecs`）で
  全フレームを Canvas 合成して書き出す

### Undo 挙動
- マウス押下中（ドラッグ / リサイズ）は history push を抑制して、pointer up で 1 件だけ commit する方式
- 新規に state 変更を多発する操作を追加するときは、**既存の `isPointerDownRef` / `pendingCommitRef` 仕組みに乗る** か、別途 debounce を入れる

### キーフレーム
- 対応プロパティ: `x` / `y` / `scale` / `opacity` / `rotation`
- 補間は **linear のみ**（将来 easing 追加予定）
- プレビュー: [src/components/TemplateCanvas.tsx](src/components/TemplateCanvas.tsx) の LayerView で **再生中のみ** 補間値を適用（編集中は静的値でドラッグを妨げない）
- エクスポート: [src/lib/layerComposer.ts](src/lib/layerComposer.ts) の `renderLayersOnContext` が
  毎フレーム `applyKeyframesAtTime`（`sampleLayerAt` 経由）で補間値を `drawLayer` に渡す
- **opacity のキーフレーム補間も WebCodecs では対応済み**（旧 ffmpeg 経路では未対応だったが撤去済み）

## ビルド運用（重要）— 「ビルドして」はデスクトップのショートカットまで反映する

ユーザーは普段、アプリを **デスクトップのショートカット**から起動する。その実体は
**NSIS インストール先** `%LOCALAPPDATA%\shorts-script-gen\shorts-script-gen.exe`。
Tauri はフロント `dist/` を **exe に埋め込んでビルド**するため、ソースや `dist/` を更新しても
起動済み exe は変わらない。さらに `npm run tauri build` が更新するのは
`src-tauri\target\release\` の exe であって、**ショートカットが指す AppData の
インストール済み exe は setup.exe を実行するまで古いまま**。

そのため「ビルドして」と言われたら、原則 **ショートカットに反映されるところまで**を完了とする:

1. アプリを終了してから `npm run tauri build`（起動中は exe ロックで os error 5）。
   → `tsc && vite build` で `dist/` を exe に埋め込み、release コンパイル + NSIS installer 生成。
2. 生成された `src-tauri\target\release\bundle\nsis\shorts-script-gen_<ver>_x64-setup.exe` を
   **サイレント再インストール**: `Start-Process <setup> -ArgumentList "/S" -Wait`。
3. `%LOCALAPPDATA%\shorts-script-gen\shorts-script-gen.exe` の LastWriteTime が更新されたか確認。

- 手早い動作確認だけなら `npm run tauri dev`（exe 埋め込み不要で速い・HMR）を使う/案内してよい。
  ショートカット版へ恒久反映する必要があるときは上の 3 ステップ。
- フロント側のみの変更でも、exe への再埋め込みのため `tauri build` は必要（`npm run build` だけでは不可）。

## ブランチ運用（重要・デフォルト挙動を上書き）

- このリポジトリは **`main` 1 本で運用**する（ユーザーが一人で触るため feature ブランチ不要）。
- **コミットは `main` に直接行い、勝手にブランチを切らないこと。** 「default ブランチではまず branch を切ってからコミットする」というデフォルト挙動より**このルールを優先**する。
- ブランチが必要なときはユーザーが明示する。指示なくブランチ作成・切り替えをしない。

## セッション間の引き継ぎ（重要）

セッションをまたいで作業を確実に引き継ぐため、**作業の現在地メモを正本とする**:

- 場所: ユーザーの auto-memory `current-work-state.md`（`MEMORY.md` の index 先頭 ⭐ にポインタあり）。
- **セッション開始時**: まず `current-work-state.md` を読み、ブランチ・残タスク・決定事項・直近の追加を把握してから着手する。
- **更新タイミング**: セッション末ではなく **「作業の区切りごと」に都度更新する**（機能を1つ実装した／決定した／ビルドした等のたびに）。途中で中断しても最新が残るようにする。古いまま放置すると誤誘導になるので、変わったら即反映。
- 演出（アニメ/エフェクト/シェイプ/テキスト演出）を追加・変更したら `HANDOFF_演出リファレンス.md` も更新し、`moviegenerate/docs/shorts-script-gen-capabilities.md` へ同期する（curio-gen が読む正本）。
