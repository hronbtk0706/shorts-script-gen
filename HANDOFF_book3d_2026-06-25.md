# 引き継ぎ: 3D本(book3d) めくり — 2026-06-25 夕方時点

別マシンで続ける用の正本。**まずこれを読めば続きから入れる。**

## ゴール（変えない）
**本物のノートみたいに「貼る／書く／めくる」を動画にする。** 開く→ページに画像を貼る・文字を書く→めくって次の見開き→…を動画化。
- 本命の難所は **「めくり」**。次点でタイムライン（開く→書く→めくる）→ WebM書き出し。
- やらないこと: 描画結果を見ずに推測で直す（過去それで何度も外した）。**描画を見て／数値で確かめてから直す。**

## いまの状態
### できている
- 編集UI: 見える見開きの **左ページ/右ページの2面だけ**（実ページ番号ラベル「2ページ目/3ページ目」）。glbの24スロット露出は廃止。種別(画像/テキスト/レイアウト)切替で中身引き継ぎ。`src/components/LayerPropertyPanel.tsx`
- ページ重複排除 `dedupePagesBySlot`（先頭優先）。`src/lib/book3dRender.ts`
- **表紙の左はみ出し（余白）= 素材(glb)修正で解決済み**。後述。
- めくり機構: `applyFlip` が動く。`bookFlip:[{atSec,page,durationSec}]`。`page`=ノード順index（Page1-2=0 / **Page3-4=1** / Page5-6=2 …）。Page3-4 は背=Y軸まわりに右→左へ倒れ、下の Page5-6 が右に出る。テスト=`templates/test-bookflip-h.json`（1.5sから page1 を1.5sめくる）。
- めくり紙の潜り込み対策: `setMeshOnTop`(depthTest off + renderOrder10) で**最前面強制描画**。位置は動かさない（位置ずらしは隣ページにめり込むのでNG）。
- めくり途中の歪み対策: `bendFlipper` の ねじり28°→0 / カール55°→18°。

### 原因特定済み（2026-06-25 夜・ヘッドレス実フレームで確定）✅診断
**ヘッドレス検証ツールを用意して実フレーム＋実測 bbox で確認した（推測ではない）。**
- ツール: `npm run dev`（vite, :1420）→ `node scripts/book3d/headless_shoot.mjs <glb> <outDir> <t,...>`。
  実機と同一の `Book3DRenderer` を Playwright/Chromium（=WebView2 同系）で動かし、各 t を PNG 化＋
  各 page node の world bbox を `book3d_diag.json` に出す。各 slot は識別用のラベル単色を貼る。
  ハーネス: `book3d_headless.html`(ルート) / `scripts/book3d/headless_main.ts`（カメラ/めくりは test-bookflip-h.json と同条件をハードコード）。
- **判明**: めくり**中**の動きは正常・静止見開きも正常。**完了状態(t≥3)だけ破綻**。
  - 倒れた page は z は左側に正しく着地するが、**左束に密着せず上に凸に反って浮く**
    （実測: Page_3-4 完了時 x=[0.088, 0.293]／左の Page_1-2 は x≈[-0.0155, 0] でほぼ平ら）。
  - **真因**: glb のページは平面でなく **右側用に下へ湾曲した立体**（静止 Page_3-4 は x=[-0.20, 0]）。
    完了処理 `applyFlip` は `restoreFlipper`（元の右用湾曲に戻す）＋**剛体180°回転だけ**なので、
    右用の下湾曲が左で**上湾曲に反転**して浮く。`check_flip_depth.py` の「剛体180°＝平ら」前提は
    **ページが平面でない**ため誤り＝計算と実機の食い違いの正体。
  - 併発: 倒れた面に**同テクスチャが鏡像で出る**（裏面＝既知の「1mesh=1material」制約）。

### 位置ズレ＋完了スナップ＝修正済み ✅（2026-06-25 夜・headless 全フレーム目視＋実機確認）
- **`applyFlip` のめくりを「剛体回転＋最後に反射」から `deformFlipperTurn` の連続頂点モーフに作り直した**
  （`src/lib/book3dRender.ts`）。reset 分岐に `fm.node.scale.z = 1`、めくり中も完了も
  `const p = Math.min(1,(t-f.atSec)/dur); this.deformFlipperTurn(fm, p);` の一本化。
  - 中身: 各頂点を **rest(右の静止形) → 反射(背平面 z=0 で z 反転＝湾曲 world x を保ったまま左へ)**
    へ world 空間で smoothstep モーフ＋ world -x（手前=机から起き上がる向き）へ sin(πp) の弧で
    持ち上げ＋進行方向へ軽いくぼみ。**p=1 が反射の静止形に一致するので完了スナップが原理的に出ない**。
    node は rest 変換のまま、変形は geometry に焼く（Mrest/Mref を作って world↔local 変換）。
  - 重要な実測知見:
    - 剛体180°回転は (x,z)→(-x,-z) で**湾曲(x)まで反転**＝上反りで浮く。z=0 背平面の反射なら湾曲を保つ。
    - 起き上がる「上」は **world -x**（カメラは world(-3.56,-5.08,0) から見る＝手前が -x）。最初 +x へ
      持ち上げて紙が机下へ垂れたので -x に反転で解決。
    - **diag の bbox は geometry 焼き込みで未再計算＝全フレーム rest 表示で当てにならない。視覚(montage)が正。**
  - 検証: headless_shoot で 1.5〜3.0s を密に撮り montage 目視（持ち上げ→越える→左へ平らにネスト、スナップ無し）。
    実機反映後ユーザー確認＝**基本OK**。

### まだ残る ⚠（次にやる）
1. **めくり中の動きをもっと自然に**（ユーザー要望）。peel(めくれ伝播)/緩急＋着地ひと跳ね/動的くぼみ/
   角先行ねじれの4要素を一度に入れたら**カールが過剰でおかしくなり撤去**（基本の連続モーフ版に戻した）。
   → 次は **1要素ずつ薄く** 入れて実機確認しながら詰める（特に peel と緩急を控えめに）。
   `deformFlipperTurn` の `liftAmt`/`dishAmt` と smoothstep `s` 周りが調整ポイント。
2. **裏面テクスチャが鏡像**（1mesh=1material 制約）: content を leaf 単位で持ち表裏別マテリアル化 →
   タイムライン → WebM書き出し。
- 確認用テンプレ: `templates/_test_bookflip_owner.json`（Owner PC 実パス版。元 `test-bookflip-h.json` は user1 パス）。
- 注意: このマシン(Owner)の glb に表紙オーバーハング修正が当たっているかは未確認（`.orig_bak` 無し＝未適用の可能性）。
  「左の表紙が大きい」のは glb 由来でコード変更とは無関係。`fix_cover_overhang.py` は flip 位置ズレとは別問題。

## 別マシンで動かすための必須事項
0. **初回セットアップ**: `npm install`（playwright を含む devDep を取得）→ **`npx playwright install chromium`**
   （検証ツール用の Chromium ≈110MB を DL。これが無いと headless_shoot.mjs が動かない）。
1. **glb は別ディレクトリ `moviegenerate/anime/videos/rezero_001/rezero_book_open_clean.glb`＝このリポジトリ外。push に含まれない。**
   - 表紙はみ出し修正は **その glb を直接編集**したもの。家のマシンの glb には反映されていない。
   - **再適用:** `python scripts/book3d/fix_cover_overhang.py <家のglbパス>` を実行（冪等・`.orig_bak` バックアップ作成）。
   - **検証ツールには glb パスを明示で渡す**: `node scripts/book3d/headless_shoot.mjs <そのマシンのglb> <outDir> <t,...>`
     （既定は `../curio-gen/...` を見るので、リポジトリと curio-gen/moviegenerate の相対位置が違うマシンでは必須）。
2. **テストテンプレは絶対パス参照**: `templates/test-bookflip-h.json` は `C:\Users\user1\...`、
   `templates/_test_bookflip_owner.json` は `C:\Users\Owner\branch\curio-gen\...`。家のマシンの実パスに合わせて
   `gltfPath` と各レイヤー `source` を書き換える（または pack 経由）。**自分のマシン用のコピーを1つ作るのが楽**。
3. ビルド運用は CLAUDE.md の通り（`npm run tauri build` → NSIS setup を `/S` 再インストールして AppData の exe まで反映）。

## 道具（このリポジトリに同梱）
- **`scripts/book3d/headless_shoot.mjs <glb> <outDir> <t,...>` — 実機 Book3DRenderer の各 t を PNG＋
  bbox診断で出すヘッドレス検証（要 `npm run dev` 起動・Playwright/Chromium）。fix の前後で必ずこれで実測。**
  - 連携: `book3d_headless.html`(ルート) / `scripts/book3d/headless_main.ts`。glb は public へ一時複製して
    配信し終了時に消す（.gitignore 済み・build 肥大化防止）。PowerShell から呼ぶときは空文字引数を
    渡さない（落ちて引数がずれる）＝glb パスを明示する。
- `scripts/book3d/fix_cover_overhang.py <glb>` — 表紙板を右表紙と同寸に縮める（左はみ出し修正の再現）。
- `scripts/book3d/check_flip_depth.py <glb> [yaw pitch dist]` — めくり後ページが手前/奥かを深度計算で判定。
  **注意: 「ページ＝平面」前提なので湾曲ページの実機とは食い違う（headless_shoot を正とする）。**

## 関連コード
- `src/lib/book3dRender.ts` — Book3DRenderer（loadModel/collectFlippers/applyFlip/**deformFlipperTurn**/setMeshOnTop/setSlotTexture/orientForSlot）。めくりは applyFlip→deformFlipperTurn（連続モーフ）。
- `src/components/Book3DLayerContent.tsx` — プレビュー描画（frameSource経路で前面合成へ）。
- `src/components/LayerPropertyPanel.tsx` — 3D本セクション（左/右2面編集）。
- `src/components/PageLayoutEditor.tsx` — ページ入れ子レイアウトのドラッグ編集モーダル。
