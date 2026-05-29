# プレビュー vs エクスポート 差異監査 — 2026-05-28

5 分野並列で audit した結果のまとめ。判定: ✅ 一致 / ⚠️ 軽微差 / 🔴 重大 mismatch / 🟡 preview 専用 / 🟠 export 専用。

## 集計

| 分野 | ✅ | ⚠️ | 🔴 | 🟡 | 🟠 |
|---|---|---|---|---|---|
| Entry / Exit anim | 0 | 10 | 12 | 0 | 0 |
| Ambient | 3 | 2 | 3 | 1 | 0 |
| Text effect | 4 | 10 | 8 | 0 | 0 |
| Keyframe | 3 | 2 | 1 | 0 | 0 |
| Layer 固有 | 21 | 5 | 7 | 2 | 0 |
| **合計** | **31** | **29** | **31** | **3** | **0** |

---

## 🔴 重大 mismatch（31 件）

### A. anim 系（CSS 系単位・easing 差）

| # | 項目 | preview | export | 修正方針 | file:line |
|---|---|---|---|---|---|
| A1 | `entry: slide-left/right/up/down` | `translate(±100%)` = **要素自身の幅/高さ**基準 + ease-out (`1-(1-p)^2`) | `main_w/main_h` = **canvas 全体**基準 + linear | export 側で `layer_w` / `layer_h` を基準にする、または preview 側を canvas 基準に揃える。easing もどちらかに統一 | TemplateCanvas.tsx:1272-1283 / lib.rs:1076-1095 |
| A2 | `exit: slide-*` | `translate(±100%)` 要素基準 ease-in (`p^2`) | `±2*main_w` canvas 基準 linear | 同上 + exit の 2× 倍率も要削除 | TemplateCanvas.tsx:1334-1344 / lib.rs:1087-1126 |
| A3 | `entry/exit: roll-in/out` の translate | 要素幅 ease-out / ease-in | canvas 幅 linear | translate 部の単位・easing を slide と同じく統一 | TemplateCanvas.tsx:1317-1320 / lib.rs:1077, 2259-2267 |
| A4 | `entry: blur-in` / `exit: blur-out` | CSS `filter: blur(20px → 0)` 本物のぼかし | **blur 一切無し**、alpha fade のみ | ffmpeg は時間依存 `gblur` が困難 → 期間内のフレームごとに `gblur` を多段 segment で組むか、機能を preview からも削除 | TemplateCanvas.tsx:1294-1299, 1352 / lib.rs:892-895 |
| A5 | `entry/exit: flip-in/out` | `perspective(500px) rotateY(0↔90)` 真の 3D 立体回転 | `scaleX` 0↔1 で 2D 横潰し近似 | ffmpeg では perspective 困難 → 「3D flip 系は preview 専用」と割り切るか、video レイヤー限定にする | TemplateCanvas.tsx:1309-1312, 1353-1356 / lib.rs:1000-1034 |

### B. ambient（位置スケール基準・未実装）

| # | 項目 | preview | export | 修正方針 | file:line |
|---|---|---|---|---|---|
| B1 | `shake` / `bounce` / `float` の振幅 | CSS px そのまま (canvasWPx スケールなし) | `振幅*W/360` で **1080 出力時 約 3 倍強い** | preview 側 `computeLayerAmbientStyle` に `canvasWPx/360` を掛ける | TemplateCanvas.tsx:1395-1429 / lib.rs:1153-1164 |
| B2 | `glow-pulse` | CSS `drop-shadow` で光る | **完全未実装** | ffmpeg `split→boxblur→colorize→blend` で擬似 glow。実装規模大。短期は「preview 専用」明示 | TemplateCanvas.tsx:1415-1419 / lib.rs (該当ブランチなし) |
| B3 | `pulse` の static layer クランプ | `1+0.05k*sin` で overshoot あり | `is_static_layer && has_scale_anim` で `min(1,…)` が ambient pulse にもかかり上半周が消える | pulse 部だけクランプ外で乗算する、または overshoot しない pulse 式に変える | TemplateCanvas.tsx:1390-1394 / lib.rs:1170-1176, 2310-2347 |

### C. text effect（decoration アニメ未実装・座標系不整合）

| # | 項目 | preview | export | 修正方針 | file:line |
|---|---|---|---|---|---|
| C1 | `highlight-bar` (char/kinetic 無し時) | `width: p*90%` で sweep | `drawText` PNG 経路で **最終状態固定**、sweep 無し | `layerNeedsAnimatedTextVideo` に decoration 単独も含めて .mov 経路に強制 | TemplateCanvas.tsx:1093-1109 / layerComposer.ts:576-581 |
| C2 | `underline-sweep` (decoration 単独) | `width: p*90%` で sweep + **3px CSS** | PNG 経路で full 線固定 + **3×scale ≈ 9px** | sweep 補間追加 + 線太さを 3px (preview 系) に統一 | TemplateCanvas.tsx:1112-1133 / layerComposer.ts |
| C3 | `outline-reveal` (decoration 単独) | CSS `WebkitTextStroke` 補間 | PNG 経路で 3px stroke 最終状態固定 | sweep 補間追加、または .mov 経路強制 | TemplateCanvas.tsx:1050-1054 / layerComposer.ts:591-604 |
| C4 | `shadow-drop` (decoration 単独) | `text-shadow` dx/dy が -6→4 補間 | PNG 経路で **4×scale = 12px の最終固定**（補間なし + 距離 3 倍） | 補間追加 + offset を CSS 系に揃える | TemplateCanvas.tsx:1055-1061 / layerComposer.ts:629-637 |
| C5 | comment **bubble + multi-line** の box overflow | `baseStyle.overflow:hidden` で box 内 clip | `composeAnimatedTextLayerVideo` が `padT/padB` で canvas を縦拡張 → box 外まで描画 | preview を `overflow:visible` に揃える、または export の pad 拡張を撤廃 | TemplateCanvas.tsx:1024 / layerComposer.ts:1164-1177 |
| C6 | comment **plain (bubble 無し) multi-line** の改行位置 | HTML flex center + `wordBreak:break-word` | Canvas `wrapTextLines` + `measureText` | フォントメトリクス差で改行位置 1 文字ズレ。preview から `wrapTextLines` 結果を逆算して並べる、または export 側に DOM レンダ経路を入れる | TemplateCanvas.tsx:1010-1090 / layerComposer.ts:506-534 |
| C7 | `fontFamily` 未指定時 | CSS 継承 = ブラウザ既定 sans (欧文 fallback) | `buildTextFontString` で和文スタック | preview の `baseStyle.fontFamily` を `layer.fontFamily \|\| TEXT_DEFAULT_FONT_STACK` に統一 | TemplateCanvas.tsx:1027 / layerComposer.ts:491-499 |
| C8 | `neon` の白テキスト時 fallback | white text-shadow（見えない） | `#fff` を `#ffe600` に置換して光る | preview にも同じ置換を入れるか、export 側で置換を外す | TemplateCanvas.tsx:1047-1049 / layerComposer.ts:606-625 |

### D. keyframe

| # | 項目 | preview | export | 修正方針 | file:line |
|---|---|---|---|---|---|
| D1 | `opacity` キーフレーム | 再生中に補間 | **完全無視**、`layer.opacity` static のみ | `lib.rs:2391` の `colorchannelmixer=aa=opacity` を `keyframe_expr(opacity, layer.opacity)` 式に置換 | TemplateCanvas.tsx:393-408 / lib.rs:2391-2395 |

### E. layer 固有

| # | 項目 | preview | export | 修正方針 | file:line |
|---|---|---|---|---|---|
| E1 | **static レイヤー (image/shape/color/comment) opacity 二重適用** | inner div opacity | PNG 焼き時 `globalAlpha=opacity` **+** Rust `colorchannelmixer=aa=opacity` → **二重** | PNG 焼きでは globalAlpha=1 にして Rust 一箇所に集約 | layerComposer.ts:201 / lib.rs:2391-2396 |
| E2 | image / shape **`border`** | `inset boxShadow`（完全に枠内に描画） | PNG `strokeRect`（中心 stroke、半分は枠外でクリップ） | export を `strokeRect(width/2, width/2, w-width, h-width)` で内側に寄せる | layerComposer.ts / lib.rs |
| E3 | shape `fillColor` デフォルト | **`#FFE600`** (黄) | **`#333`** (暗灰) | デフォルト値を一致させる（推奨: `#FFE600` で統一） | TemplateCanvas.tsx / layerComposer.ts |
| E4 | audio `volume` クランプ | `<audio>.volume` 0..1 クランプ (GainNode 経由になっていない) | `volume=` クランプ無し | preview を Web Audio API `GainNode` 経由に変更（CLAUDE.md 既知失敗例そのもの） | TemplateCanvas.tsx:1533-1534 |
| E5 | audio `playbackRate` クランプ範囲 | 0.05..4.0 | atempo 0.5..4.0 | export 側で `atempo=0.5,atempo=0.1` 多段化して 0.05 まで対応、または preview 側を 0.5..4.0 に揃える | TemplateCanvas.tsx:1501,1553,1567 / lib.rs:2610 |
| E6 | character **物理 dt** | rAF の実 dt（可変、停止中=0） | 固定 `1/30` フレーム順送り | preview も `1/30` 固定 tick で別途回す、または `physicsFps` を両系統で参照 | TemplateCanvas.tsx (Live2D tick) / lib.rs |
| E7 | comment 非 bubble の box overflow（C5 と重複だが別経路） | outer `overflow:hidden` で切る | `composeLayerContentPng` が PNG 縦拡張で溢れて見える | C5 と同じく統一 | TemplateCanvas.tsx / layerComposer.ts |

---

## ⚠️ 軽微差（29 件、要対応性 中）

主に easing と単位スケールの軽微なズレ。フル一覧は agent ログ参照。代表的なもの:

- entry/exit の **fade / zoom / stretch / pop** が preview ease-out/ease-in、export linear（中間時刻で alpha や scale 値が違うが端点は一致）
- text decoration の `*scale` 倍率による線太さ・影距離の 3 倍化（C2/C4 と同根）
- char/kinetic の `dy=6` `dy=-16` `dy*4` などのピクセル値が **preview CSS px（canvasWPx 系）vs export Canvas px（1080 系）** で 3 倍ズレ
- scale キーフレーム時の **基準点ズレ**（preview 左上 / export 中心補正）
- character `blinkConfig` の `maxDuration` 引数が `3*3600` vs `duration+60` で異なる（mulberry32 seed 共有なので先頭一致するが将来バグの種）
- ambient `blink` の geq `T` が `setpts=PTS+startSec/TB` 後の時刻で位相ズレ
- ambient `pulse` の static layer 上半周クランプ（B3 と関連）

---

## 🟡 preview 専用（3 件）

| 項目 | 内容 |
|---|---|
| `ambient: glow-pulse` | export に分岐なし。CSS drop-shadow が完全に消える（B2） |
| `Layer.physicsFps` | 型はあるが両系統とも未参照のデッドプロパティ |
| `setpts=PTS-STARTPTS` 補正 | export 側にのみ存在する VFR 対策。preview は `<video>` 内部処理に任せている |

---

## 修正優先度（推奨順）

「**1 箇所の修正でユーザー体感が大きく変わる順**」で並べた:

### P1 — 即修正候補（1 ファイル数行で直る + 体感差大）
1. **E1: static opacity 二重適用** — opacity 0.5 が 0.25 になる致命傷。1〜2 行で直る
2. **D1: opacity キーフレーム export 未対応** — 既知。`keyframe_expr` を流すだけ
3. **E4: audio volume が 0..1 クランプ** — CLAUDE.md 既知失敗例。GainNode 化
4. **E5: audio playbackRate 0.05 が export で 0.5 に丸まる** — atempo 多段化
5. **C7: fontFamily 未指定で preview / export が別フォント** — 1 行で直る

### P2 — 中規模（数十行）
6. **A1〜A3: slide/roll の単位・easing 統一** — anim 全種を見直す必要
7. **C1〜C4: text decoration アニメの PNG 経路** — .mov 経路強制 or 補間追加
8. **C5/E7: comment box overflow** — preview/export 方針統一
9. **B1: ambient shake/bounce/float の振幅 3 倍** — preview に `canvasWPx/360` 乗算
10. **E2: border の strokeRect 中心問題** — 1 ファイル数行

### P3 — 機能設計の判断が必要
11. **A4: blur-in/out** — ffmpeg で時間依存 blur が困難。機能削除 or video 限定
12. **A5: flip-in/out** — perspective 不可。video 限定 or 機能削除
13. **B2: glow-pulse** — 実装大。preview 専用と明示するのが現実的
14. **E6: character 物理 dt** — preview を固定 tick で別途回すか議論

### P4 — easing の linear → ease-out/in 統一（軽微だが全体の質感）
15. **A 全般の easing 統一** — export の `(1-(t-s)/d)` を `(1-pow(1-(t-s)/d, 2))` に置換するだけ。テンプレ多くないなら一気に直せる

---

## 補足

- 旧型残骸（`Motion` / `SceneEffects` / `BodySegment` / `Script`）が `types.ts:482-590` に残存。keyframe 実装に影響しないが「廃止済み」CLAUDE.md 記述と不一致。掃除は別タスク。
- CLAUDE.md の「rotation は static のみ」は古い。現在は両系統で kf 対応済み。

---

# 追記 — 2026-05-29 ffmpeg 経路撤去後の再棚卸し

**前提変化**: ffmpeg (Export A) を物理削除し **WebCodecs (Export B) に一本化**した。
この監査の 🔴 の大半は「preview vs **ffmpeg**」の差異だったため、ffmpeg 撤去で **自動的に消滅**した。
現在問うべきは「preview vs **WebCodecs (Canvas 合成)**」だけ。WebCodecs は preview ロジックを
再利用 / 同式で移植しているため、残差は少ない。以下は再判定結果（A〜E の元番号で対応）。

## ✅ ffmpeg 撤去 + 既存 fix で解消済み

| 元# | 状態 | 根拠 |
|---|---|---|
| A1〜A3 slide/roll の単位・easing | ✅ | WebCodecs `computeCanvasAnim` は **layer w/h 基準 + ease-out `1-(1-p)²`** で preview と同式（layerAnimCanvas.ts で確認） |
| A4 blur-in/out | ✅ | `computeCanvasAnim` が `blur` を出し `applyCanvasAnim` が `ctx.filter=blur()` を適用（CSS と同じ本物のぼかし） |
| B2 glow-pulse | ✅ | `computeCanvasAnim` が `glowBlur`+`drop-shadow` filter を適用（preview と同経路） |
| B3 pulse の static クランプ | ✅ | ffmpeg 固有の `min(1,…)` クランプが消滅。Canvas は overshoot 維持 |
| C1〜C4 text decoration sweep | ✅ | Phase 3.3c で `drawAnimatedTextFrame` 経路に統一（時刻補間 + `drawAnimatedToken` の textAlign バグ修正） |
| C7 fontFamily 未指定 | ✅ | preview/layerComposer 双方 `TEXT_DEFAULT_FONT_STACK` fallback |
| D1 opacity キーフレーム | ✅ | WebCodecs は `applyKeyframesAtTime` で opacity を補間して `drawLayer` に反映 |
| E1 static opacity 二重適用 | ✅ | ffmpeg の `colorchannelmixer` 二重適用が消滅。Canvas は `globalAlpha` 一箇所 |
| E2 border strokeRect | ✅ | `drawBorder`/`drawAnimatedLayerStaticParts` が `inset=lw/2` で内側描画（preview の inset boxShadow と一致） |
| E3 shape fillColor デフォルト | ✅ | 両系統 `#FFE600` で統一済み |
| E4 audio volume クランプ | ✅ | preview を GainNode 化（100%超対応）、export `mixAudioLayers` も Web Audio GainNode |
| E5 audio playbackRate 範囲 | ✅ | export は AudioBufferSourceNode.playbackRate（atempo の 0.5 下限なし）→ 0.05 まで一致 |
| comment bubble 形状 (監査外) | ✅ | WebCodecs `drawLayer` で `drawBubbleShape` を描画（旧 fillRect のみを修正） |

## 🔧 2026-05-29 に修正

| 元# | 内容 | 変更 |
|---|---|---|
| B1 | ambient shake/bounce/float/glow の px 振幅が design(360) 基準で未スケール（preview と WebCodecs で frame 比がズレ、export は約 1/3 に減衰） | `computeCanvasAnim` に `pxScale=FINAL_W/360`、`computeLayerAmbientStyle` に `canvasWPx/360` を導入し両系統で px 振幅をスケール |
| C8 | neon 白文字時、preview は白文字+白 glow（見えない）、export は #ffe600 | preview neon を「白/未指定 → #ffe600」に統一し、文字本体色 + glow 色を export と一致 |

## ⚠️ 残存（preview vs WebCodecs。Canvas 2D の原理的制約 or 軽微）

| 元# | 内容 | 扱い |
|---|---|---|
| A5 flip-in/out | preview は `perspective rotateY` の真 3D、WebCodecs は `scaleX` 2D 近似（Canvas 2D は 3D 不可） | **preview 専用差として許容**。完全一致は WebGL 化が必要 |
| E6 character 物理 dt | preview は rAF 実 dt（可変）、export は固定 1/30 frame-step | **許容**（export の固定 dt のほうが決定的で正。実害は物理の僅かな揺れ差のみ） |
| C6 plain multi-line 改行位置 | preview は DOM の折り返し、WebCodecs は Canvas `measureText` | フォントメトリクス差で稀に 1 文字ズレ。Canvas テキストの原理的限界。許容 |
| C5/E7 comment box overflow | preview は `overflow:hidden` で box 内クリップ、WebCodecs は rect comment をクリップしない | テキストが box を超える稀なケースのみ。未対応（必要なら drawLayer の comment に矩形 clip 追加で対応可） |

## 🟡 preview 専用（変わらず）

- `Layer.physicsFps`: 両系統未参照のデッドプロパティ（型定義のみ）
- `setpts` 系: ffmpeg 撤去で消滅（もはや存在しない）

**結論**: 監査時 🔴 31 件のうち、**ffmpeg 撤去 + 既存 fix + 本日の B1/C8 で実害のある差異はほぼ解消**。
残るのは Canvas 2D の原理的制約（A5 / C6）と決定論的に許容できる差（E6）、および稀なケース（C5/E7）のみ。
