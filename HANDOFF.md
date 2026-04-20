# 引き継ぎドキュメント — ショート動画台本ジェネレーター

最終更新: 2026-04-20（Phase G: 手動モード + zIndex 修正 + cover fit）

## プロジェクト概要

YouTube Shorts / TikTok / Reels の**反応集型ショート動画**を作るデスクトップアプリ。台本生成から動画合成まで一気通貫。

テンプレート（カット構成＋レイヤー配置）を作って、トピックごとに台本とコメントを差し替えて量産する運用を想定。

## スタック

- **Tauri 2** + **React 19** + **TypeScript** + **Vite 7**
- **Tailwind CSS v4**
- **Rust 1.95**
- LLM: OpenAI (GPT-5 系) / Groq (Llama 3.3 70B) / Gemini 2.5
- TTS: Edge TTS / VOICEVOX / macOS say
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
- **動画レイヤー × タイムドオーバーレイ間の zIndex**
  - 現状: FFmpeg フィルタチェインの構造上、video_layers は常にタイムドオーバーレイの下に来る
  - 両者が混在する場合の zIndex 同士の比較には未対応
- **セグメント編集 UI 復活の検討**
  - セグメント列は削除したので UI から hook/body/cta の境界を編集できない
  - 現状はテンプレ作成時の既定値のまま、またはURL解析の結果に依存
  - 手動モードなら `applyManualAssignments` で自動補完されるので不要だが、自動モード利用者には影響する可能性

### 優先度 中
- **Phase 6: FFmpeg アニメーション完成度**
  - slide / fade は Rust 側で実装済み
  - zoom / pop は未実装
- **動画レイヤーの回転対応**（FFmpeg 側で未対応）
- **動画レイヤーの角丸マスク**（FFmpeg 側で rect/circle のみ）
- **プレビューの精度向上**
  - 現状: セグメント開始時刻のスナップショット
  - 理想: セグメント内の時間遷移も動画として反映
- **テンプレ用サンプル**（現状サンプルは削除済み・ゼロから作る必要）

### 優先度 低
- マイグレーション（v1→v2 の自動変換）
- 手動モードで選んだコメントを除外したコメント一覧（同じコメントを複数レイヤーに割り当てないためのヒント）

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
│  │  ├─ TemplateBuilder.tsx         テンプレ編集画面（ツールバー + 3カラム + タイムライン）
│  │  ├─ TemplateCanvas.tsx          1080x1920 仮想キャンバス（react-moveable）
│  │  ├─ TemplateTimeline.tsx        CapCut 風タイムライン（レイヤーバー + プレイヘッド）
│  │  ├─ LayerPanel.tsx              レイヤー追加/z順
│  │  ├─ LayerPropertyPanel.tsx      レイヤープロパティ（位置/タイミング/アニメ）
│  │  ├─ TemplatePreviewModal.tsx    プレビューモーダル
│  │  ├─ VideoGenerator.tsx          動画生成実行
│  │  └─ AnalyticsPanel.tsx          実績管理
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
│  │  ├─ layerUtils.ts               レイヤー操作ヘルパー
│  │  ├─ layerComposer.ts            Canvas でレイヤー合成 → PNG（cover フィット）
│  │  ├─ templatePreviewRunner.ts    プレビュー動画生成
│  │  ├─ video.ts                    動画生成オーケストレーション（manualMode 分岐 + per-layer TTS）
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
| `download_image` / `cloudflare_generate_image` | 画像生成/DL |
| `save_overlay_png` / `save_audio_base64` | Base64 → ファイル保存 |
| `generate_tts` / `edge_tts` / `voicevox_tts` | TTS |
| `get_audio_duration` | ffprobe で尺計測 |
| `compose_video` | シーン合成 → 連結 → BGM ミックス |
| `generate_silent_wav` | プレビュー用無音 WAV 生成 |
| `mix_audio_clips` | 複数 TTS を時間オフセット付きでミックス（手動モードの per-layer TTS 用） |
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

1. **動画レイヤー × タイムドオーバーレイの zIndex 統合**（FFmpeg フィルタチェイン刷新が必要）
2. **Phase 6: zoom / pop アニメーションの Rust 実装**（slide / fade は実装済み）
3. 動画レイヤーの回転・角丸対応
4. プレビュー精度向上（時間遷移も動画化）

## 参考情報

- Rust 側の FFmpeg 呼び出しは `hidden_cmd("ffmpeg")`（PATH 依存）
- `templates/` ディレクトリは git 管理対象、別 PC で clone すればテンプレも引き継げる
- API キーはローカルの LazyStore（OS 依存パス）に**平文保存**されるため、git には含まれない
