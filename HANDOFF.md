# 引き継ぎドキュメント — ショート動画台本ジェネレーター

最終更新: 2026-04-21（Phase H: テンプレエディタの本格 CapCut 化・音声レイヤー・ナレーション生成・テキスト演出など）

## プロジェクト概要

YouTube Shorts / TikTok / Reels の**反応集型ショート動画**を作るデスクトップアプリ。台本生成から動画合成まで一気通貫。

テンプレート（カット構成＋レイヤー配置）を作って、トピックごとに台本とコメントを差し替えて量産する運用を想定。

## スタック

- **Tauri 2** + **React 19** + **TypeScript** + **Vite 7**
- **Tailwind CSS v4**
- **Rust 1.95**
- LLM: OpenAI (GPT-5 系) / Groq (Llama 3.3 70B) / Gemini 2.5
- TTS: Edge TTS（接続不安定なので推奨停止）/ VOICEVOX / macOS say / **OpenAI TTS** / **SofTalk**（ゆっくり霊夢/魔理沙）
- 画像生成: Pollinations.ai / Cloudflare Workers AI
- BGM: Pixabay
- YouTube: **YouTube Data API v3**（コメント取得、公式・キー必須）+ youtubei.js（検索・情報取得、キー不要）
- 動画編集: `react-moveable`（レイヤー操作）
- 動画合成: FFmpeg 8.1（**外部インストール必須**）

## セットアップ（別 PC 引き継ぎ）

### 必須ソフト

```
1. Node.js 22+
2. Rust 1.95+ (rustup)
3. Microsoft Visual Studio 2022 + C++ ワークロード（Windows）
4. FFmpeg 8.1+（winget install Gyan.FFmpeg）
5. WebView2 Runtime（Windows 11 は標準同梱）
```

### インストール手順

```bash
git clone https://github.com/hronbtk0706/shorts-script-gen.git
cd shorts-script-gen
npm install
# Rust 依存は初回 npm run tauri dev 時に自動ダウンロード
```

### 起動

```bash
npm run tauri dev
```

**初回は Rust 依存のコンパイルで 5〜10 分かかる。**

### 必須 API キー（設定画面で登録）

| 用途 | キー | 取得先 |
|---|---|---|
| 台本生成 | OpenAI / Gemini / Groq のどれか | 各プロバイダ |
| コメント取得 | YouTube Data API v3 | https://console.cloud.google.com/apis/library/youtube.googleapis.com |
| 画像生成 | Cloudflare Workers AI（任意） | https://dash.cloudflare.com |
| BGM | Pixabay（任意） | https://pixabay.com/accounts/register |

## 主要機能と進化の経緯

### 初期 MVP（台本生成のみ）
Gemini で構造化 JSON 出力、React で結果表示、コピーボタンなど。

### Phase A（YouTube 参考データ + 多候補生成）
- youtubei.js 導入で YouTube 検索・字幕・コメント取得（API キー不要部分）
- 多候補生成パイプライン: ブレスト → 3 候補並列生成 → AI 審査で最良選定
- 設定で候補数・参考動画数を調整可能
- OpenAI/Groq/Gemini プロバイダ切り替え

### Phase B（反応集型への特化）
- 旧「解説・考察型」プロンプトは完全削除
- **反応集型**プロンプトのみ: body の各要素は「純粋なコメント引用箱」
- AI の合いの手禁止、実コメントそのまま並べる形式
- hook/cta だけ AI の地の文 OK

### Phase C（コメント手動選択）
- `CommentPicker` コンポーネント
- 特定動画 URL から最大 200 件のコメント取得（YouTube Data API v3 経由）
- 返信もインデント表示して選択可
- 選んだコメントだけで LLM が body を構築

### Phase D（テンプレート機能 v1: cuts ベース）**※廃止済み**
- 動画の構成（hook/body/cta カット × N）を JSON で保存
- Gemini 2.5 Vision で YouTube 動画から構造自動解析
- カットごとのレイヤー管理（画像/動画/単色/テキスト/コメント枠）

### Phase E（Canvas レイヤー編集 + FFmpeg 合成）
- `react-moveable` でドラッグ/リサイズ/回転
- マスク形状（長方形/角丸/円形）、枠線、不透明度、回転
- スナップ（画面端・中央・他レイヤー）
- Undo/Redo、グリッド表示
- Canvas で非動画レイヤーを合成 → Rust に渡す
- **動画レイヤーも FFmpeg で実際にループ再生**
- プレビュー機能（静止画サムネ + 動画レンダリング）

### Phase F（タイムライン型への全面再設計）
- **cuts 概念を廃止**、全レイヤーを動画全体の global timeline に自由配置
- 各レイヤーに `startSec` / `endSec` で独立した表示タイミング
- 入退場アニメーション設定（fade / slide / zoom / pop）**※設定のみ、FFmpeg 側未実装**
- セグメント（hook/body/cta）は台本マッピング用の構造マーカーとして残存
- Playhead スライダーで任意時刻の可視状態プレビュー

### Phase G（手動モード + UX 大改修）**← 現在**
- **CapCut 風タイムライン** `TemplateTimeline.tsx` 追加：レイヤーバーのドラッグで時刻調整、端ドラッグでリサイズ
- タイムライン上で **再生ヘッド（赤線）をドラッグでシーク**
- スナップ: 他レイヤー端 + セグメント境界 + 再生ヘッド位置（業界標準挙動）
- テンプレ編集画面を **3カラム中央寄せ構成**（キャンバス / レイヤーパネル / プロパティ）+ タイムラインは下段全幅
- タイムライン幅は尺に比例（60秒で上段幅×1.2、超えたら横スクロール）
- ヘッダーにテンプレ保存/プレビュー/尺入力を portal で移動してスペース節約
- セグメント列UIは削除（編集不可、セグメントは `applyManualAssignments` で自動補完）
- **生成モード: ✏️ 手動** を追加
  - コメント選択モード（旧 `manual-select`）は削除
  - YouTube URL → コメント取得 → チェック → 各コメント枠レイヤーに DDL で割り当て
  - 選択したコメントの本文は**テキストボックスに転写して編集可能**
  - 画像/動画レイヤーは **ファイル指定**、テキストレイヤーは直接入力
  - **画像フィット調整モーダル** `ImageFitEditor.tsx`: 選んだ画像に対して `react-moveable` でレイヤー枠を自由ドラッグ/リサイズ（テンプレ自体は無変更、ビデオ単位の上書き）
  - **AI完全スキップ**: 画像生成なし（未指定レイヤーは透過）、Script 構造編集UI 非表示、`ManualScriptSummary.tsx` で選択内容のみ表示
  - **per-layer TTS**: コメント/テキストレイヤーごとに TTS を生成し、`layer.startSec` で鳴り始める
  - TTS 長 > レイヤー表示時間の場合、`endSec` を自動延長
  - 新 Rust コマンド `mix_audio_clips`: 複数 TTS を時間オフセット付きでミックス（ffmpeg `adelay` + `amix`）
- **画像は cover フィット**（枠を完全に覆う最小倍率で描画、はみ出しはクリップ）
- **zIndex 修正**: タイムゲート付きレイヤーを zIndex ASC でソートしてから overlay、常時表示で高 zIndex のものはタイムゲート側に昇格してベース焼き込みを回避

## データモデル（v2 Timeline）

```ts
interface VideoTemplate {
  version: 2;
  id, name, note?, sourceUrl?, sourceTitle?, sourceChannel?, createdAt;
  totalDuration: number;
  themeVibe?, overallPacing?, narrationStyle?;
  layers: Layer[];           // global timeline にレイヤーを自由配置
  segments: TemplateSegment[]; // 台本マッピング用（hook/body[i]/cta）
}

interface TemplateSegment {
  id, type: "hook" | "body" | "cta", bodyIndex?,
  startSec, endSec,
  color?, transitionTo?, transitionDuration?
}

interface Layer {
  id, type: "image" | "video" | "color" | "shape" | "text" | "comment",
  x, y, width, height,       // % 座標
  zIndex,
  rotation?, opacity?,
  shape?: "rect" | "rounded" | "circle", borderRadius?, border?,
  source?: "auto" | "user" | string,  // path or 特殊値
  fillColor?, text?, fontSize?, fontColor?,
  motion?,
  // v2 で追加
  startSec, endSec,
  entryAnimation?, entryDuration?,
  exitAnimation?, exitDuration?
}
```

v1 (`cuts` ベース) のテンプレは**マイグレーションなしで読み込み拒否**（既存サンプルも削除済み）。

## 現在動作している機能（2026-04-20 時点）

- [x] テンプレ管理（一覧 / 新規作成 / URL解析で作成 / 編集 / 削除 / 複製）
- [x] タイムライン型テンプレエディタ（セグメント追加/時刻設定/レイヤー配置）
- [x] Playhead スライダーで時刻スクラブ
- [x] レイヤー操作: ドラッグ/リサイズ/回転/z順、マスク、枠線
- [x] レイヤーに `startSec` / `endSec` 設定 → プレビューで可視性反映
- [x] プレビュー（静止画サムネ / 動画レンダリング）
- [x] 台本生成: ⚡自動 / ✏️手動（AI完全スキップ・全手動割当）
- [x] 手動モード: コメント DDL 割当 / 画像フィット調整 / per-layer TTS（layer.startSec で鳴り始め）
- [x] CapCut 風タイムライン（ドラッグ・リサイズ・スナップ・プレイヘッドドラッグ）
- [x] 画像レイヤーの cover フィット（アスペクト保持、はみ出しはクリップ）
- [x] 多候補生成（切り口ブレスト → 3 候補 → AI 審査）
- [x] コメント取得（YouTube Data API v3）
- [x] 動画レイヤーの FFmpeg ループ合成
- [x] 画像レイヤーのユーザーファイル指定

## 未実装（TODO）

### 優先度 高
- **FFmpeg 書き出しで新アニメ群が未対応**
  - Phase H で追加した Canvas プレビュー用 CSS ベースのアニメは Rust 書き出しに未反映
  - 対象: `blur-in / elastic-pop / flip-in / stretch-in / roll-in` と対応 exit、ambient 全般、char（typewriter/stagger-fade/wave/color-shift）、kinetic（word-pop/keyword-color/slide-stack/zoom-talk）、装飾（highlight-bar / underline-sweep / neon / outline-reveal / shadow-drop）
  - 既存の fade / slide / zoom-in / pop / zoom-out は Rust 側対応済
- **Edge TTS が 403 で接続できない**
  - Python `edge-tts` と同じ WIN_EPOCH ベースに修正済だが依然 403 返る
  - ユーザーは OpenAI TTS / VOICEVOX / SofTalk にフォールバックで運用
  - UI からは非表示化してもよい（Phase H で `LayerPropertyPanel` からは既に撤去、`SettingsModal` にのみ残存）
- **セグメント編集 UI 復活の検討**
  - hook/body/cta の境界を編集できない
  - 手動モードなら `applyManualAssignments` が自動補完するので困らないが、自動モードでは課題

### 優先度 中
- **動画レイヤーの回転・角丸は Phase H で対応済**
- **プレビューの精度向上**（モーダル版プレビューは廃止、今は CapCut 風リアルタイム）
- **テンプレ用サンプル**（現状サンプルは削除済み・ゼロから作る必要）

### 優先度 低
- マイグレーション（v1→v2 の自動変換）
- 手動モードで選んだコメントを除外したコメント一覧（同じコメントを複数レイヤーに割り当てないためのヒント）
- Settings 整理（不要 UI 削減は「仕様が固まってから」ユーザー保留中）

## ディレクトリ構成（抜粋）

```
shorts-script-gen/
├─ src/
│  ├─ types.ts                       型定義の要
│  ├─ App.tsx                        ルーティング+ヘッダ
│  ├─ components/
│  │  ├─ ScriptForm.tsx              ← 台本生成フォーム（⚡自動 / ✏️手動）
│  │  ├─ ScriptResult.tsx            ← 台本表示（自動モード結果）
│  │  ├─ ManualScriptSummary.tsx     ← 手動モード結果（レイヤー一覧のみ）
│  │  ├─ ManualLayerAssigner.tsx     ← 手動モード: レイヤーごとのコメント DDL / ファイル選択
│  │  ├─ ImageFitEditor.tsx          ← 画像フィット調整モーダル（moveable でドラッグ/リサイズ）
│  │  ├─ CandidatePicker.tsx         多候補タブ切替
│  │  ├─ CommentPicker.tsx           YouTube コメント選択 UI
│  │  ├─ SettingsModal.tsx           API キー等の設定
│  │  ├─ TemplateManager.tsx         テンプレ一覧 / トグル
│  │  ├─ TemplateBuilder.tsx         テンプレ編集画面（左: Canvas / 右上: パネル×3 / 右下: Timeline）
│  │  ├─ TemplateCanvas.tsx          1080x1920 仮想キャンバス + CapCut 風インラインプレビュー
│  │  │                              （動画 <video> playhead 同期 / アニメ・motion・color・transition をリアルタイム反映）
│  │  ├─ TemplateTimeline.tsx        CapCut 風タイムライン（メイン/音声セクション / 挿入トラック / ズーム / サムネ等）
│  │  ├─ LayerPanel.tsx              レイヤー追加/z順/可視・ロックトグル
│  │  ├─ LayerPropertyPanel.tsx      レイヤープロパティ（アコーディオン式・複数選択時は共通値「—」表示）
│  │  ├─ LayerPreview.tsx            ★ 選択レイヤー単体の 9:16 プレビュー（Phase H）
│  │  ├─ VideoGenerator.tsx          動画生成実行
│  │  └─ AnalyticsPanel.tsx          実績管理
│  │  （TemplatePreviewModal.tsx / templatePreviewRunner.ts は Phase H で削除）
│  ├─ lib/
│  │  ├─ providers/
│  │  │  ├─ llm.ts                   Gemini/Groq/OpenAI + 多候補生成パイプライン
│  │  │  ├─ tts.ts                   Edge/VOICEVOX/say 切替
│  │  │  ├─ image.ts                 Pollinations/Cloudflare
│  │  │  └─ bgm.ts                   Pixabay BGM
│  │  ├─ scriptGenerator.ts          ブレスト→3候補→審査 オーケストレーション
│  │  ├─ manualScript.ts             手動モード用 Script 構築 + テンプレ上書き
│  │  ├─ youtube.ts                  Data API v3 コメント + youtubei.js 検索
│  │  ├─ templateStore.ts            templates/*.json の CRUD
│  │  ├─ templateAnalyzer.ts         Gemini Vision で YouTube 動画解析
│  │  ├─ layerUtils.ts               レイヤー操作ヘルパー（トラック操作・音声 zIndex 正規化等）
│  │  ├─ layerComposer.ts            Canvas でレイヤー合成 → PNG（cover フィット / レイヤー単位 PNG 対応）
│  │  ├─ video.ts                    動画生成オーケストレーション（manualMode 分岐 + per-layer TTS + 音声レイヤーミックス）
│  │  ├─ subtitleRender.ts           Canvas でテロップ/字幕描画
│  │  ├─ storage.ts                  設定永続化 (LazyStore)
│  │  ├─ analytics.ts                過去動画記録
│  │  ├─ effects.ts                  motion/color/transition 定数
│  │  └─ retry.ts                    API リトライ
│  └─ types.ts
├─ src-tauri/
│  ├─ src/lib.rs                     Rust バックエンド（ffmpeg/TTS/画像 DL/テンプレ CRUD 等）
│  ├─ Cargo.toml
│  ├─ tauri.conf.json                assetProtocol 有効化済
│  └─ capabilities/default.json      http/fs/opener/store/shell/dialog 許可
├─ templates/                        ユーザー作成のテンプレ JSON 置き場（git 管理）
├─ package.json
└─ HANDOFF.md                        このファイル
```

## Rust コマンド一覧（invoke 先）

| コマンド | 役割 |
|---|---|
| `list_templates` / `save_template` / `delete_template` | テンプレ CRUD（templates/ ディレクトリ） |
| `save_template_narration` | ★ Phase H: TTS 音声を templates/audio/{templateId}/ に永続コピー |
| `download_image` / `cloudflare_generate_image` | 画像生成/DL |
| `save_overlay_png` / `save_audio_base64` | Base64 → ファイル保存 |
| `generate_tts` / `edge_tts` / `voicevox_tts` | TTS |
| `openai_tts` | ★ Phase H: OpenAI TTS（Alloy/Nova/Shimmer 等 6 声） |
| `softalk_tts` | ★ Phase H: SofTalk 経由のゆっくり霊夢/魔理沙 |
| `get_audio_duration` | ffprobe で尺計測 |
| `compose_video` | シーン合成 → 連結 → BGM + ユーザー音声レイヤーをミックス |
| `generate_silent_wav` | プレビュー用無音 WAV 生成 |
| `mix_audio_clips` | 複数 TTS を時間オフセット付きでミックス（per-layer TTS 用） |
| `build_user_audio_track` | ★ Phase H: ユーザー配置の音声レイヤーを 1 本の WAV に（音量/fade/loop 対応） |
| `download_bgm` | Pixabay BGM DL |

## 続行手順（別 PC での作業開始時）

1. リポジトリを clone
2. `npm install`
3. FFmpeg / Rust / VS Build Tools を未導入ならセットアップ
4. `npm run tauri dev` で起動（初回は時間かかる）
5. ⚙️ 設定 → 各 API キー登録
6. テンプレ管理タブで既存テンプレを編集、or 新規作成
7. 台本生成タブで動画作成

## 直近の残課題（次セッションで着手）

1. **FFmpeg 書き出しで Phase H の新アニメ群を再現**（blur-in 等 / ambient 全般 / char / kinetic / decoration）
2. **Edge TTS 403 根本解決 or UI から完全撤去**
3. **SofTalk / VOICEVOX の実機テスト**（ユーザー家 PC での確認待ち）
4. **Settings 整理**（ユーザー要望、仕様固まり次第）
5. **セグメント編集 UI の復活検討**（自動モード利用時）

## 参考情報

- Rust 側の FFmpeg 呼び出しは `hidden_cmd("ffmpeg")`（PATH 依存）
- `templates/` ディレクトリは git 管理対象、別 PC で clone すればテンプレも引き継げる
- `templates/audio/{templateId}/` にナレーション音声が永続保存される（Phase H 以降）
- API キーはローカルの LazyStore（OS 依存パス）に**平文保存**されるため、git には含まれない
- **Vite dev サーバーの `watch.ignored` に `templates/**` を追加済**（さもないと save のたびに HMR でリロードされて画面がリセットする）

---

## Phase H（2026-04-21）— テンプレエディタ本格化

### CapCut 風インラインプレビュー化
- モーダル式プレビュー（TemplatePreviewModal / templatePreviewRunner）を**完全撤去**
- キャンバス上で**動画レイヤーは `<video>` で playhead 追従再生**
- 入退場アニメ・motion・color グレード・セグメント間トランジションを**CSS で即時反映**
- 選択レイヤー単体のプレビュー枠（LayerPreview, 右カラム 3 番目）を追加

### タイムラインの再設計
- **メイン + 音声セクション**モデル: `zIndex >= 0` が映像トラック、`zIndex < 0` が音声セクション
- main track = `zIndex=0`（★ アイコン + 琥珀色強調 + 区切り線）
- トラック間ドラッグ・挿入（既存トラック間/最上/最下）・セクション内クランプ
- ズーム（Ctrl+ホイール / Ctrl+=- / Ctrl+0、4〜200px/s）、倍率表示
- バーのサムネ（画像/単色/図形）、入退場アニメ三角インジケータ（幅=秒数）
- ラベル列は左 sticky、ルーラーは上 sticky、スクロールバーは内容末端に
- 既存 `type: "text"` → 自動マイグレーション（`comment` へ）、旧正 zIndex の音声も自動で負値化

### 複数選択
- 単一 → `selectedLayerIds[]` へ移行
- Shift+クリック: 範囲選択、Ctrl+クリック: 個別トグル、Ctrl+A: 全選択
- 一括削除 / 複製 / ドラッグ移動 / 時間ナッジ / LayerPanel トグル / PropertyPanel 共通値編集
- PropertyPanel は異値を `—` で placeholder 表示

### キーボードショートカット一式
`Delete/Backspace` 削除、`Ctrl+D` 複製、`Ctrl+C/V` コピペ（相対位置維持）、`Ctrl+S` 保存、`Ctrl+A` 全選択、`Escape` 解除、`Space` 再生/停止、`←→` playhead ナッジ（Alt で微調整）、`Shift+←→` 選択レイヤーナッジ、`Home/End` 先頭/末尾

### 可視性 / ロック
- `Layer.hidden` / `Layer.locked` 追加、Panel / Canvas / Timeline で尊重
- hidden は書き出しからも除外

### 自動保存 + 未保存確認
- 編集から 1.5 秒デバウンスで auto-save（既存テンプレのみ）
- 新規は初回手動保存必須、以降 auto
- 画面を離れる（← 一覧に戻る / キャンセル）とき dirty なら confirm
- Vite HMR が `templates/` を監視してリロードしていた致命バグを修正（`watch.ignored` に追加）

### 音声レイヤー（`type: "audio"`）
- ボリューム / フェードイン / フェードアウト / ループ
- 🎵 ボタン押下で直接ファイル選択 → 素材尺が layer.endSec に自動反映
- プレビューで `<audio>` 再生同期 + FFmpeg 書き出しでミックス
- Rust `build_user_audio_track` が全音声レイヤーを 1 本の WAV に合成 → `compose_video` 側で main + BGM と amix

### テキストレイヤー統合
- `type: "text"` 廃止、`"comment"` に統一
- PropertyPanel の「背景色を使う」チェックで `fillColor` ON/OFF
- 改行 (`\n`) を `white-space: pre-wrap` で正しく表示

### ナレーション生成（テキスト → 音声レイヤー自動追加）
- プロパティ「テキスト」セクションに `🔊 ナレーション生成` ボタン
- UI 上で **TTS プロバイダ / 声を選択**して生成（Settings はデフォルト値として機能）
- 生成した音声は `templates/audio/{templateId}/` に永続保存
- テキストレイヤーに `generatedNarrationLayerId` を保持し、再生成時は古いのを**置換**
- TTS は **OpenAI TTS**（新規）、VOICEVOX、SofTalk（新規）、macOS say。Edge は残存するが 403 頻発

### テキスト演出（Phase H 後半）
合成可能な 5 カテゴリ:
- **Entry 追加**: blur-in / elastic-pop / flip-in / stretch-in / roll-in
- **Exit 追加**: blur-out / flip-out / stretch-out / roll-out
- **Ambient（表示中ずっと）**: pulse / shake / wiggle / bounce / blink / glow-pulse / rainbow / float（強度スライダ付き）
- **文字単位**: typewriter / stagger-fade / wave / color-shift
- **キネティック（単語単位）**: word-pop / keyword-color（`keywordColor` 指定）/ slide-stack / zoom-talk
- **装飾**: highlight-bar / underline-sweep / neon / outline-reveal / shadow-drop
- すべて **transform / filter / opacity 合成**で複合動作
- 注意: **FFmpeg 側は未対応**。プレビューのみ反映

### メイン → 音声の仕様（UI 制約）
- 映像系レイヤーは `zIndex >= 0` のみ
- 音声レイヤーは `zIndex < 0` のみ
- 縦ドラッグで音声 → 映像エリアは赤表示で拒否
- 新規音声追加時は自動で負値セクションに配置
- 既存テンプレ読込時に `migrateAudioToNegativeZ` / `migrateTextToComment` を自動適用

### UI レイアウト再構成
- 左: Canvas のみ（480px 固定カラム・viewport 高さ 0.82 で拡縮）
- 右上（460px 固定高）: LayerPanel(280) + LayerPropertyPanel(240) + LayerPreview(260)
- 右下（残り全部）: Timeline（内部で縦横スクロール）
- ページ全体スクロールなし
- PropertyPanel はアコーディオン式（初期全閉）、開閉状態はレイヤー切替しても保持
- テキスト範囲選択ドラッグが外で離れても選択解除されないよう mousedown 起点判定を追加

### 最上段のコントロールバー
`↶ 元に戻す / ↷ やり直す / ▶⏸ / time / グリッド` をタイムライン上に移動

