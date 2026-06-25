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

### 未解決（次にやる）⚠
- **めくり最終状態(3s以降)の位置がまだズレている**（ユーザー報告）。
  - ただし `scripts/book3d/check_flip_depth.py` の深度計算では「最終=剛体180°回転で平ら、z/y範囲が Page1-2 と一致」のはず＝**計算と実機が食い違う**。
  - **次の一手: ヘッドレスで book3d を実際にPNG出力して目で確認する仕組みを用意**（Playwright で WebGL を描画→screenshot 等）。推測で直すのをやめ、実フレームを見て原因（カメラ／回転軸／renderOrderの副作用／preview合成側）を特定する。
- その後: 「1枚=1マテリアル」制約（紙の表裏を別画像にできない＝同一テクスチャ鏡像）を踏まえ、content を leaf単位で持つ設計 → タイムライン → WebM書き出し。

## 別マシンで動かすための必須事項
1. **glb は別ディレクトリ `moviegenerate/anime/videos/rezero_001/rezero_book_open_clean.glb`＝このリポジトリ外。push に含まれない。**
   - 表紙はみ出し修正は **その glb を直接編集**したもの。家のマシンの glb には反映されていない。
   - **再適用:** `python scripts/book3d/fix_cover_overhang.py <家のglbパス>` を実行（冪等・`.orig_bak` バックアップ作成）。
2. **テストテンプレ(`templates/test-bookflip-h.json` 等)は絶対パス `C:\Users\user1\...` 参照。** 家のマシンの実パスに合わせて `gltfPath` と各レイヤー `source` を書き換える（または pack 経由）。
3. ビルド運用は CLAUDE.md の通り（`npm run tauri build` → NSIS setup を `/S` 再インストールして AppData の exe まで反映）。

## 道具（このリポジトリに同梱）
- `scripts/book3d/fix_cover_overhang.py <glb>` — 表紙板を右表紙と同寸に縮める（左はみ出し修正の再現）。
- `scripts/book3d/check_flip_depth.py <glb> [yaw pitch dist]` — めくり後ページが手前/奥かを深度計算で判定。

## 関連コード
- `src/lib/book3dRender.ts` — Book3DRenderer（loadModel/collectFlippers/applyFlip/bendFlipper/setMeshOnTop/setSlotTexture/orientForSlot）。
- `src/components/Book3DLayerContent.tsx` — プレビュー描画（frameSource経路で前面合成へ）。
- `src/components/LayerPropertyPanel.tsx` — 3D本セクション（左/右2面編集）。
- `src/components/PageLayoutEditor.tsx` — ページ入れ子レイアウトのドラッグ編集モーダル。
