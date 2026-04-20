# 引き継ぎドキュメント — ショート動画台本ジェネレーター

最終更新: 2026-04-20

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

### Phase F（タイムライン型への全面再設計）**← 現在**
- **cuts 概念を廃止**、全レイヤーを動画全体の global timeline に自由配置
- 各レイヤーに `startSec` / `endSec` で独立した表示タイミング
- 入退場アニメーション設定（fade / slide / zoom / pop）**※設定のみ、FFmpeg 側未実装**
- セグメント（hook/body/cta）は台本マッピング用の構造マーカーとして残存
- Playhead スライダーで任意時刻の可視状態プレビュー

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
- [x] 台本生成: ⚡自動 / 🎯コメント選択
- [x] 多候補生成（切り口ブレスト → 3 候補 → AI 審査）
- [x] コメント取得（YouTube Data API v3）
- [x] 動画レイヤーの FFmpeg ループ合成
- [x] 画像レイヤーのユーザーファイル指定

## 未実装（TODO）

### 優先度 高
- **Phase 2（未着手）: 横タイムライン UI**
  - 現状はセグメント一覧 + レイヤーの数値入力で時刻指定
  - 理想: CapCut のようにレイヤーの帯をドラッグで時刻変更 + リサイズで長さ変更
  - `TemplateTimeline.tsx` を新規作成予定
- **Phase 6（未着手）: FFmpeg 側アニメーション対応**
  - UI で `entryAnimation`/`exitAnimation` を設定できるが、動画生成時に反映されない
  - Rust 側で fade / slide / zoom / pop を `enable` + `fade` filter などで実装する必要あり
  - あわせて「セグメント途中で出現するレイヤー」の時刻管理も Rust 側で適切な `enable='between(t, ...)'` 追加が必要

### 優先度 中
- **マニュアル配置モード（削除済み）の復活検討**
  - 旧 cuts ベースのマニュアルモードは削除した
  - 新設するなら「セグメントごとに text を手入力」の簡易形
  - ユーザーの最新コメントでは「必要か?」と質問中
- **プレビューの精度向上**
  - 現状: セグメント開始時刻のスナップショット
  - 理想: セグメント内の時間遷移も動画として反映
- **テンプレ用サンプル**（現状サンプルは削除済み・ゼロから作る必要）

### 優先度 低
- マイグレーション（v1→v2 の自動変換）
- 動画レイヤーの回転対応（FFmpeg 側で未対応）
- 動画レイヤーの角丸マスク（FFmpeg 側で rect/circle のみ）

## ディレクトリ構成（抜粋）

```
shorts-script-gen/
├─ src/
│  ├─ types.ts                       型定義の要
│  ├─ App.tsx                        ルーティング+ヘッダ
│  ├─ components/
│  │  ├─ ScriptForm.tsx              ← 台本生成フォーム
│  │  ├─ ScriptResult.tsx            ← 台本表示
│  │  ├─ CandidatePicker.tsx         多候補タブ切替
│  │  ├─ CommentPicker.tsx           YouTube コメント選択 UI
│  │  ├─ SettingsModal.tsx           API キー等の設定
│  │  ├─ TemplateManager.tsx         テンプレ一覧 / トグル
│  │  ├─ TemplateBuilder.tsx         テンプレ編集画面（Playhead + セグメント + レイヤー）
│  │  ├─ TemplateCanvas.tsx          1080x1920 仮想キャンバス（react-moveable）
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
│  │  ├─ youtube.ts                  Data API v3 コメント + youtubei.js 検索
│  │  ├─ templateStore.ts            templates/*.json の CRUD
│  │  ├─ templateAnalyzer.ts         Gemini Vision で YouTube 動画解析
│  │  ├─ layerUtils.ts               レイヤー操作ヘルパー
│  │  ├─ layerComposer.ts            Canvas でレイヤー合成 → PNG
│  │  ├─ templatePreviewRunner.ts    プレビュー動画生成
│  │  ├─ video.ts                    動画生成オーケストレーション
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

1. **Phase 2: 横タイムライン UI**（最優先）
2. **Phase 6: FFmpeg アニメーション実装**
3. マニュアル配置モードの新設計（要否検討）
4. プレビュー精度向上

## 参考情報

- Rust 側の FFmpeg 呼び出しは `hidden_cmd("ffmpeg")`（PATH 依存）
- `templates/` ディレクトリは git 管理対象、別 PC で clone すればテンプレも引き継げる
- API キーはローカルの LazyStore（OS 依存パス）に**平文保存**されるため、git には含まれない
