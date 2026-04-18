# 引き継ぎドキュメント — ショート動画台本ジェネレーター

最終更新: 2026-04-19

## プロジェクト概要

AIでショート動画（TikTok/Reels/Shorts）の台本を自動生成するデスクトップアプリ。
既にMVPは完成。**次のゴール: 台本から動画まで自動生成する機能の追加（プランB: 画像+TTS+テロップ+BGM を ffmpeg 合成）**

## 現在の状態（MVP完成済み）

### スタック
- **Tauri 2** + **React 19** + **TypeScript** + **Vite 7**
- **Tailwind CSS v4**（@tailwindcss/vite）
- **@google/genai** (v1.50.1) — Gemini SDK
- **@tauri-apps/plugin-store** — APIキーのローカル永続化
- **Rust 1.95** + **Cargo**

### 実装済み機能
- [x] トピック入力フォーム（必須: トピック・プラットフォーム・尺 / 任意: ターゲット・トーン・目的・参考）
- [x] Gemini API で構造化JSON出力（responseSchema 使用）
- [x] 結果表示（フック/本編セグメント/CTA/ハッシュタグ/BGM）
- [x] セクションごとの「コピー」ボタン
- [x] APIキー設定モーダル（LazyStore に暗号化せず平文保存）

### 動作確認済み
Gemini 2.5 Flash で台本生成が正常動作することをユーザー環境で確認済み（2026-04-19）。

## ファイル構成

```
/Users/saismac03/Documents/project/shorts-script-gen/
├── src/
│   ├── App.tsx                     # メインレイアウト（状態管理）
│   ├── main.tsx                    # エントリ（App.css をインポート）
│   ├── App.css                     # @import "tailwindcss" のみ
│   ├── types.ts                    # Script / ScriptInput 型
│   ├── components/
│   │   ├── ScriptForm.tsx          # 入力フォーム
│   │   ├── ScriptResult.tsx        # 結果表示
│   │   └── SettingsModal.tsx       # APIキー設定
│   └── lib/
│       ├── gemini.ts               # Gemini API ラッパー（モデル: gemini-2.5-flash）
│       └── storage.ts              # APIキー永続化（@tauri-apps/plugin-store）
├── src-tauri/
│   ├── Cargo.toml                  # tauri-plugin-store 追加済み
│   ├── src/lib.rs                  # プラグイン登録済み
│   ├── capabilities/default.json   # store:default 権限付与済み
│   └── tauri.conf.json
├── vite.config.ts                  # Tailwind プラグイン追加済み
├── package.json
└── HANDOFF.md                      # このファイル
```

## 重要な技術決定

### 1. モデルは `gemini-2.5-flash` を使う
- 当初 `gemini-2.0-flash` で実装したが、2026-04時点で **無料枠がlimit=0** になっており使えなかった
- `gemini-2.5-flash` に変更して解決（[src/lib/gemini.ts](src/lib/gemini.ts) の `model` フィールド）
- 切り替え候補: `gemini-2.5-flash-lite`（より軽量）、`gemini-flash-latest`（エイリアス）

### 2. APIキーはGemini専用プロジェクトで発行
- Workspace アカウント（`/u/1/`）で作ったプロジェクトは無料枠対象外だった
- 個人Gmail（`/u/0/`）の `gen-lang-client-*` プロジェクトで発行したキーは無料枠（1日1,500リクエスト）が使える
- ユーザーは `saisproduction03@gmail.com` の個人Gmailで発行済み

### 3. 構造化出力は `responseSchema` で厳密に
- [src/lib/gemini.ts](src/lib/gemini.ts) で `Type.OBJECT` を使って定義
- `propertyOrdering` でフィールド順を固定（Geminiは順序に敏感）
- 型は [src/types.ts](src/types.ts) に集約

### 4. Tailwind v4 構成
- `tailwind.config.js` 不要（v4 は @import のみで動く）
- [src/App.css](src/App.css) の `@import "tailwindcss";` が全て
- [vite.config.ts](vite.config.ts) で `tailwindcss()` プラグインを登録

## 次のタスク: 動画生成機能（プランB）

### 設計

台本の各本編セグメント（body[]）から、以下を自動生成してffmpegで合成:

1. **シーン画像（Imagen）**: セグメントごとに `visual` 欄から画像プロンプトを作成 → Imagen API（Gemini経由）で生成
2. **ナレーション音声（TTS）**: `narration` を音声化
   - 第1候補: **Gemini TTS**（`gemini-2.5-flash-preview-tts`）
   - 代替: ブラウザの `SpeechSynthesis`（無料・即時・英語寄り）、または Cloud TTS
3. **テロップ**: `text_overlay` を ffmpeg の `drawtext` で焼き込む（または ASS字幕）
4. **BGM**: `bgm_mood` に合う曲をローカルフォルダから選ぶ（まずはユーザー提供）
5. **合成**: 各シーンの 画像+音声+テロップ → concat → BGM合成 → 縦型 1080x1920 で出力

### 実装プラン（推奨順序）

#### Phase 1: 骨組み
1. 新規タブ/画面「動画生成」を追加
2. 既存の `Script` を受け取り、進捗表示（シーンごとのステータス）
3. Rust 側で ffmpeg を呼ぶコマンドを追加（`#[tauri::command] async fn render_video`）
4. ffmpeg のバイナリは Homebrew 依存 or sidecar 同梱するか決定 → **sidecar推奨**（ユーザーに入れさせない）

#### Phase 2: 画像生成
1. Gemini SDK で `imagen-3.0-generate-002` または `imagen-4.0-generate-001` を呼ぶ
2. 画像は Tauri の `appLocalDataDir` に PNG 保存
3. アスペクト比は 9:16（縦型ショート）

#### Phase 3: 音声生成
1. Gemini TTS で `narration` を WAV 生成
2. 保存先は画像と同じディレクトリ
3. セグメントごとの長さを計測（ffprobe）→ 画像表示尺を音声尺に合わせる

#### Phase 4: ffmpeg 合成
1. 各シーン: `ffmpeg -loop 1 -i scene.png -i voice.wav -vf "drawtext=text='...',scale=1080:1920" -shortest scene.mp4`
2. concat: `ffmpeg -f concat -i list.txt -c copy combined.mp4`
3. BGM: `ffmpeg -i combined.mp4 -i bgm.mp3 -filter_complex "[1:a]volume=0.15[bgm];[0:a][bgm]amix=inputs=2" output.mp4`

#### Phase 5: UI 仕上げ
1. シーンごとのプレビュー（画像+ナレーション試聴）
2. シーン単位で再生成ボタン
3. 最終動画のプレビュー → 保存先選択（ダイアログ経由）

### コスト見積もり（無料枠前提）

| 項目 | モデル | 無料枠 | 30秒動画のコスト |
|---|---|---|---|
| 台本生成 | gemini-2.5-flash | 十分 | ほぼ0 |
| 画像生成 | imagen-3/4 | **有料のみ**（$0.03〜/枚） | 5シーン×$0.03 = $0.15 |
| TTS | gemini-2.5-flash-preview-tts | 無料枠あり | 0〜微小 |

**注意**: 画像生成は無料枠なし。代替として:
- Stable Diffusion をローカル実行（Ollama/diffusers）
- Pollinations.ai の無料API
- ストック画像API（Unsplash/Pexels）+ 検索クエリを Gemini に生成させる

→ ユーザーと相談して決定する必要あり（プランBの本質は「AI素材+自動編集」で、画像がローカルSDでも成立する）。

## 環境情報

- **プラットフォーム**: macOS (Darwin 25.2.0, aarch64)
- **Rust**: 1.95.0（rustup経由でインストール済み）
- **Node**: v25.6.0
- **npm**: 11.8.0
- **ffmpeg**: **未確認**（次セッションで `which ffmpeg` 必須。無ければ Homebrew or sidecar）

## APIキーの場所（注意）

- ユーザーのAPIキーは **アプリ側の LazyStore** に保存（`~/Library/Application Support/com.shorts-script-gen.app/settings.json` あたり）
- **チャット・コード・Git に絶対に書かない**。過去に一度平文で貼られたキーがあるため、ユーザーに漏洩の注意を徹底済み
- 次セッションで必要ならユーザーにアプリ内の⚙️設定から再入力してもらう

## 起動コマンド

```bash
cd /Users/saismac03/Documents/project/shorts-script-gen
npm run tauri dev      # 開発起動
npm run tauri build    # リリースビルド（.dmg が src-tauri/target/release/bundle/ に出る）
```

初回のRustビルドは5〜10分。2回目以降は差分のみ。

## 権限設定（済）

`~/.claude/settings.json` に `permissions` セクションを追加済み。npm/cargo/tauri/git/ffmpeg などのコマンドと主要なファイル操作ツールが allow リストに入っているため、次セッションでは許可プロンプトがほぼ出ない想定。

## ユーザーの作業スタイルメモ

- 日本語で会話
- 手短で具体的な説明を好む
- 「はい」「Bで」のような短い返事で方針決定することが多い → 選択肢を明示的に提示すると進めやすい
- APIキーのような機密情報をうっかりチャットに貼ることがある → 注意喚起を忘れない
- 画面スクリーンショットを送って相談する傾向あり

## 次セッション開始時にやること

1. **このファイルを読んで現状把握**
2. `npm run tauri dev` が動くか確認（Rustビルドキャッシュ済みのはず）
3. `which ffmpeg` で ffmpeg の有無チェック
4. プランBの Phase 1 から着手するかユーザーに確認
5. 画像生成を有料（Imagen）にするか無料代替（SD/Pollinations/ストック）にするか方針決定
