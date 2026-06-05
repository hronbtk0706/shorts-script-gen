# 演出リファレンス（curio-gen 向け・全演出カタログ）

curio-gen が台本と一緒に**演出**を組むための「使える手札」一覧。
すべて `src/types.ts` を真実の源とし、**実装をコードで裏取り済み**（2026-06-05 時点）。
「型にはあるが無視される」未対応項目は明記する（emit しても効かないので注意）。

- 座標 `x/y/width/height` は **キャンバスに対する % (0〜100)・左上基準**。解像度非依存。
- アスペクト: `aspect: "vertical"`=1080×1920 / `"horizontal"`=1920×1080。未指定は vertical。
- 時刻 `startSec`/`endSec` はタイムライン全体の秒。アニメの「相対秒」は各レイヤーの `startSec` 起点。
- **preview と export は同一の合成コードを通る**ので、ここに載っているものは見た目＝書き出しが一致する。

凡例: ✅実装済み / 🆕今回追加(2026-06-05) / ⚠️型はあるが**未対応**(無視される)

---

## 1. レイヤー種別 `type`

| type | 用途 | 主なフィールド |
|---|---|---|
| `color` | 単色/グラデの矩形（背景等） | `fillColor` / `fillGradient` |
| `shape` | 図形・マーカー注釈 | `shape` ほか（§5） |
| `comment` | テキスト（テロップ/吹き出し/手書き/カウンター） | `text` / `fontSize` 等（§4,§6） |
| `image` | 画像 | `source`(絶対パス) / `crop` / `chromaKey` |
| `video` | 動画 | `source` / `videoLoop` / `playbackRate` / `crop` / `chromaKey` |
| `audio` | 音声（無描画） | §9 |
| `character` | Live2D（要モデル・curio-gen 非対象） | `modelPath` 等 |
| `effect` | エフェクト（描画系/画面全体） | `effect` または `effectKind`（§7） |

### 全レイヤー共通
`id` / `type` / `x` / `y` / `width` / `height` / `zIndex`(重なり順) / `startSec` / `endSec` /
`rotation`(度) / `opacity`(0..1) / `hidden` / `locked`。
塗り: `fillColor`(#hex) / `fillGradient: {from, to, angle?}`(rect/rounded/circle に適用・fillColor優先)。
枠: `border: {width, color}` / `borderRadius`(rounded用)。
画像/動画: `crop: {x,y,width,height}`(素材%) / `chromaKey: {color, threshold?, smoothness?}`(指定色を透過)。
🆕 マスク切り抜き `mask`（画像/動画を文字や図形の形にくり抜く・canvas経路＝書き出し表示/exportで反映）:
- `{type:"text", text:"歴史", fontFamily?}` … 文字の形に素材を流し込む（箱幅に自動フィットで大きく表示）
- `{type:"shape", shape:"circle"|"rounded"(+borderRadius)|"rect"|"star"|"heart"|"diamond"|"hexagon"}` … 図形の形にくり抜く
- 円にするには箱を**ピクセルで正方形**に（横は width%×1920 = height%×1080）。

---

## 2. 入場アニメ `entryAnimation`（+ `entryDuration` 秒, 既定0.3）✅

`none` / `fade` / `slide-left` / `slide-right` / `slide-up` / `slide-down` /
`zoom-in` / `pop`(弾むスケール) / `blur-in`(ぼけ→鮮明) / `elastic-pop`(行き過ぎ戻る) /
`flip-in`(横回転) / `stretch-in`(縦伸び) / `roll-in`(回転しながら) /
`grow-up` / `grow-down` / `grow-right` / `grow-left`（端から伸びる・棒グラフ向き。opacityは1維持） /
`arc-sweep`（`shape:"arc"` 専用。扇が時計回りに描かれる） /
`draw-on`（`marker-*` / `handwrite` 専用。ペン先が進んだぶん描かれる） /
`flip-swap`（`comment` 専用。縦に潰れて中央で文字を差替え戻す値札フリップ。`flipTo`/`flipAtSec` と併用） /
`stamp`🆕（判子のように大きく現れて叩きつけ、わずかに反動して定位置に収まる。強調・インパクト）

## 3. 退場アニメ `exitAnimation`（+ `exitDuration` 秒）✅

`none` / `fade` / `slide-left` / `slide-right` / `slide-up` / `slide-down` /
`zoom-out` / `blur-out` / `flip-out` / `stretch-out` / `roll-out`

## 4. 常時アニメ（Ambient）`ambientAnimation`（+ `ambientIntensity` 0..1, `ambientSpeed` 倍率）✅

表示中ずっと続く。入退場と複合可。
`none` / `pulse`(脈動) / `shake`(微振動) / `wiggle`(回転揺れ) / `bounce`(上下) /
`blink`(点滅) / `glow-pulse`(発光脈動) / `rainbow`(色相回転) / `float`(ふわふわ上下) /
`spin`(回転) / `drift`(漂い) / `sway`(横揺れ) / `orbit`(円運動) / `jelly`(ぷるぷる)

---

## 5. 図形 `shape`

### 基本図形 ✅
`rect` / `rounded`(+`borderRadius`) / `circle` / `star` / `heart` / `diamond` / `hexagon`
- `arc`（扇/ドーナツ）: `arcStart`/`arcEnd`(度・0=真上,時計回り) / `arcInnerRadius`(0=パイ,>0=ドーナツ) / `arcOuterRadius`。`entryAnimation:"arc-sweep"` で円グラフ的に描ける。

### 手書き風マーカー注釈 `marker-*` ✅（線色=`fillColor`、`entryAnimation:"draw-on"` で描き進む）
`marker-circle`(丸囲み) / `marker-underline`(下線) / `marker-strike`(取り消し線) /
`marker-check`(レ点) / `marker-cross`(バツ) / `marker-brackets`(四隅[ ]) /
`marker-burst`(集中線・`markerCount` 本数) /
`marker-line`(線) / `marker-arrow`(矢印) /
`marker-surge`(数値サージ・急騰線。`entryAnimation:"draw-on"` で expo-out 急加速＋着弾フラッシュ。`markerOvershoot` 0..0.5) /
`marker-graph`🆕(折れ線グラフ。`graphData:[数値…]`(最小2点)を箱内に min..max でスケールして結ぶ。`draw-on` で左から描く。線色=`fillColor`/太さ=`markerWidth`/`markerRoughness:0`で直線)

**マーカー共通プロパティ:**
- `markerWidth`: 線の太さ（design 360基準 px・既定6）
- `markerRoughness`: 手書き揺れ 0..2（既定1）。**`0` で完全な直線** ✅
- `markerFrom` / `markerTo`: `{x, y}`(箱内 %)。line/arrow/surge の始点・終点
- `markerHead`: 先端の矢じり（line/arrow/surge）
  - `none` / `triangle`(塗り三角) / `open`🆕（**手書き風の開いた2本線**。塗らずストロークで描くので本文線と同じタッチ。**矢じりも draw-on で順に手書きされる**＝軸→矢じり左→右）
- `markerCount`: `marker-burst` の線本数（既定12）

---

## 6. テキスト演出（`comment`）

### 文字単位アニメ `charAnimation` ✅
`none` / `typewriter`(1字ずつ出現) / `stagger-fade`(時間差フェード) / `wave`(波打ち) /
`color-shift`(字ごと色相) / `drop-in`(上から落下) / `bounce-in`(下から跳ね) / `rainbow`(虹・時間で流れる) /
`slide-left` / `slide-right`(横から) / `pop-each`(字ごとポップ) / `shake-each`(字ごと振動) / `blink-each`(字ごと点滅) /
`scale-pulse-each`🆕(字ごとに位相をずらして鼓動＝拡大縮小の波)

### 単語キネティック `kineticAnimation` ✅
`none` / `word-pop`(単語ポップ) / `keyword-color`(キーワード強調・`keywordColor` で色) / `slide-stack`(積み上げ) / `zoom-talk`(ズーム強調)

### 文字装飾 `textDecoration` ✅
`none` / `highlight-bar`(背景帯スイープ) / `underline-sweep`(下線スイープ) / `neon`(ネオン発光) / `outline-reveal`(縁取りが育つ) / `shadow-drop`(影が寄る)

### 文字スタイル ✅
`fontSize` / `fontColor` / `textGradient: {from,to,angle?}`(fontColor優先・静的テキスト) /
`textOutlineWidth` / `textOutlineColor`(縁取り) / `fontFamily`。
吹き出し: `bubble: {shape:"rect"|"rounded"|"ellipse"|"cloud", tail?:{tipX,tipY,baseWidth}}`。

### カウントアップ `counter` ✅（`comment` に付与。`text` を無視して数値表示）
`{ from, to, durationSec, prefix?, suffix?, separator?(3桁区切り 既定true), decimals?, ease?("out"|"linear"|"in"|"inout") }`
例: `counter:{from:5000,to:10000,durationSec:3,suffix:"マルク"}` → 3秒で 5,000→10,000マルク。停止時は to。
- 🆕 `style:"roll"` で**オドメーター**（各桁が縦にロールする機械式カウンター）。prefix/suffix/区切り/小数点は静的、各桁がロール。先頭ゼロは出さない。`"plain"`(既定)は通常テキスト。

### 手書き筆順 `handwrite` ✅（`comment`。一画ずつ「書かれていく」）
`{ order:"normal", speed?, tip?, jitter?(0..2), strokeWidth?, tempo?🆕, annotate?🆕, annotateColor?🆕 }`
- 日本語(漢字/かな)は KanjiVG の本物の筆順、ASCII は単線フォント。字形なしは左→右の掃出しにフォールバック。
- `tip`: `chalk` / `pen` / `marker` / `pencil`（書く道具も先端に表示）
- `tempo`🆕: 書き味の緩急 0..1（0=一定、1=画ごとに速度がばらつく。書き順は変えない）
- `annotate`🆕: 書き上がり後に同じ手書きタッチで追い書き → `none` / `underline`(下線) / `box`(囲み) / `strike`(取消) / `double-strike`(二本線で訂正)
- `annotateColor`🆕: 注釈の色（未指定は本文インク色）
- `surface`: 下地プリセット `none` / `blackboard`(黒板・白チョーク) / `whiteboard`(青マーカー) / `notebook`(罫線・鉛筆)。ink/tip の既定を供給。

---

## 7. エフェクト（`type:"effect"`）

### 描画系 `effect`（zIndex 位置にピクセルを描くオーバーレイ）✅
`effectParams` で制御。
- `speedlines`(集中線): `color` / `density`(本数) / `thickness` / `gapRatio`(中心の空き) / `animate`("none"|"flicker"|"pulse"|"spin") / `speed`
- `spotlight`(スポット): `center` / `radius` / `dim`(周辺の暗さ) / `softness` / `animate` / `speed`
- `particles`(粒子): `kind`("fall"|"confetti"|"sparkle"|"money"|"dust"|"heart"|"star"|"bubble"|"spark"|🆕"snow"|"rain"|"leaves"|"petals"|"smoke") / `rate`(個/秒) / `count`(総数上限) / `gravity` / `wind` / `region:[x,y,w,h]`(生成域%) / `sizeRange:[min,max]` / `color`
  - 🆕 `snow`(雪・柔らかい白) / `rain`(雨・縦ストリーク) / `leaves`(落ち葉・秋色がひらひら) / `petals`(花びら・ピンク) / `smoke`(煙/もや・薄いグレーが膨らみ薄れる)
- `steam`(湯気): `center`(発生位置%) / `count` / `color` / `speed` / `spread`(横広がり) / `rise`(上昇量) / `sizeRange` / `kind`("sparkle"|"dust"|省略=柔らかい湯気)

### 画面全体 `effectKind`（最終合成フレーム全体に適用。`effectIntensity` 0..2 で強度）✅
`shake`(地震) / `flash`(白フラッシュ) / `vignette-pulse`(画面端を一瞬暗く) / `zoom-punch`(一瞬拡大) / `blur-burst`(一瞬ぼかし) /
`colorgrade`(色調補正・`screenEffectParams`) / `grain`(粒子/走査線・`screenEffectParams: {type:"grain"|"scanlines", speed}`) / `blur`(区間内一定ぼかし・`screenEffectParams: {radius}`)
- `colorgrade` の `screenEffectParams`: `mode:"tint"`(単色被せ・`color`)/`"grade"`(彩度コントラスト) ✅ / `strength`(0..1)。`mode:"duotone"` は⚠️**未対応**(無視)。

> 1 レイヤーで `effect`(描画系) か `effectKind`(画面全体) のどちらか一方を使う。

---

## 8. キーフレーム / 高度なモーション

### A) UI キーフレーム `keyframes`（プロパティ別トラック）✅ ※`ease`なし
`{ x?, y?, scale?, opacity?, rotation? : { enabled, frames:[{time(グローバル秒), value}] } }`
- 補間は **linear のみ**。⚠️ easing 未対応。

### B) curio-gen アニメ `kfs`（時刻列・per-KF easing）✅【curio-gen 本命】
`kfs: [{ t(startSec相対秒), x?, y?, scale?, rotation?, opacity?, width?, height?, fillColor?, fontColor?, textOutlineColor?, borderRadius?, ease? }]`
- `ease`(KeyframeEase・16種): `linear` / `easeIn|Out|InOutQuad` / `…Cubic` / `…Back` / `…Elastic` / `…Bounce`
- `width`/`height` は % 絶対（`anchor` 基準で伸縮、scale より優先）。`fillColor`等は色補間。
- ループ: `kfsLoop`(または `keyframeLoop`) `{ mode:"restart"|"yoyo", count?:number|null }`(null=無限)
- これがある層は entry/exit/motion を無視（ambient は加算）。

### C) 曲線移動 `motionPath` ✅
`{ points:[[x,y],...](%・通過点), ease?, duration?, loop? }` — Catmull-Rom で滑らかに通過。

### D) reveal（ワイプ表示）`reveal` ✅
`{ direction:"left-to-right"|"right-to-left"|"top-to-bottom"|"bottom-to-top"|"center-out"|"radial", t?, duration?(既定0.6), ease? }`
- 内容を方向にクリップして 0→100% 表示。transform でなくクリップなので kfs/entry と併用可。

### E) `anchor`（伸縮の基準点）✅
`center`(既定) / `left` / `right` / `top` / `bottom` / `top-left` / `top-right` / `bottom-left` / `bottom-right`
- 例: `left` + width を 0→100% に補間 = 左端から伸びるバー。

### F) レイヤー単体フィルタ `filter` ✅（preview=export 同一）
`{ glow?:{color,strength,radius}, blur?:{radius}, shadow?:{dx,dy,blur,color(#RRGGBBAA可)} }`
- ⚠️ `tint`(着色) は**未適用**（型では受けるが無視）。

---

## 9. トランジション（top-level `transitions[]`）✅ 全種実装

`{ atSec, style, duration?(既定0.5), direction? }`。`atSec` 中心に ±duration/2 の窓。
- `fade-black`(暗転) / `zoom`(ズーム切替) … 最終フレーム全体に適用（前後フレーム不要）
- `wipe` / `push`(`direction:"left-to-right"|"right-to-left"|"up"|"down"`) / `dissolve`(クロス) / `circle-wipe`(円が広がる) / `blinds`(横帯が開く) / `glitch`(中盤でスライスがずれる) … 前後シーンを合成

---

## 9.5 レイヤーグループ（ステージ）`groups` 🆕

複数レイヤーを**ひとまとまり（ステージ）として一括で縮小/移動/フェード**する。ctx 変換で包むので
位置だけでなく文字サイズ・線幅も一緒に正しくスケールする。preview/export とも反映。

- レイヤー側: `groupId:"<id>"` で所属させる。
- top-level: `groups: [{ id, offsetX?, offsetY?, scale?, opacity?, pivot?:[x,y], kfs? }]`
  - `offsetX/Y`(% 移動) / `scale`(拡大率) / `opacity`(倍率)。`pivot` 未指定は**所属レイヤーのバウンディングボックス中心**。
  - `kfs:[{t(絶対秒), offsetX?, offsetY?, scale?, opacity?, ease?}]` で**時間アニメ**（例: シーン全体を隅に縮小）。
- 使い所: ステージを隅に畳む(PinP風) / コールアウト等を1単位で出し入れ / シーン丸ごとフェード切替 / インフォグラフ一式を一括スケール。

## 10. 音声（`type:"audio"`）✅
`source`(絶対パス) / `volume`(0..1) / `audioFadeIn` / `audioFadeOut` / `audioLoop` / `playbackRate`(0.05..4) /
ダッキング: `duckBy:[layerId]`(列挙レイヤーの表示中に音量を下げる) / `duckAmount`(既定0.3) / `duckAttackMs`(250) / `duckReleaseMs`(800)。
テンプレ全体: `audioNormalize: {enabled, targetLufs(-14), truePeakCeilingDb(-1)}`(エクスポート専用ラウドネス正規化)。

---

## 11. 組み立てレシピ（複数レイヤーの合わせ技）

- **訂正アニメ**: ①`handwrite`(text) + `annotate:"strike"` で「書く→取り消す」 → ②`shape:"marker-arrow"` + `markerHead:"open"` + `markerRoughness:0` + `draw-on` でまっすぐな手書き矢印 → ③別の `handwrite`(text) で書き直し。startSec をずらして順に再生。
- **通常テロップを丸で囲む/取り消す**: テロップの上に `shape:"marker-circle"` / `marker-strike` レイヤーを重ねて `draw-on`。
- **数値の山場**: `counter`(カウントアップ) or `flip-swap`(値札フリップ) + `marker-surge`(急騰線)。
- **強調**: `textDecoration:"highlight-bar"` or `marker-underline` + `ambientAnimation:"pulse"`。
- **登場**: `entryAnimation` + `ambientAnimation`(float等) + 必要なら `kfs` で細かく。
- **棒グラフ**: `shape:"rect"` + `anchor:"bottom"` + `kfs` で height 0→N%（or `grow-up`）。
- **折れ線グラフ**🆕: `shape:"marker-graph"` + `graphData:[…]` + `entryAnimation:"draw-on"`。`markerRoughness:0` で直線。
- **プログレスバー**: トラック=`shape:"rounded"`(灰) を敷き、その上に塗り=`shape:"rounded"` を `entryAnimation:"grow-right"`(左基準で伸びる)。塗りレイヤーの `width%` が到達値（例 80%地点に置けば 80% 進捗）。
- **ラジアルゲージ**: トラック=`shape:"arc"`(`arcEnd:360`,`arcInnerRadius:0.62`,灰) を敷き、その上に値=`shape:"arc"`(`arcEnd:値の角度`,同 innerRadius,`entryAnimation:"arc-sweep"`)。
- **ローワーサード（名前テロップ帯）**🆕: 帯=`shape:"rounded"` + 細いアクセント=`shape:"rect"`（左端）+ 名前=`comment`(大) + 肩書=`comment`(小)。全部 `entryAnimation:"slide-left"` でスッと入る。画面下 1/3 に配置。
- **コールアウト吹き出し（引き出し線つき）**🆕: 対象を `shape:"marker-circle"`(`draw-on`)で丸囲み + `comment` に `bubble:{shape,tail:{tipX,tipY,baseWidth}}` を付けて tail を対象へ向ける（または `shape:"marker-line"` で引き出し線）。
- **セーフエリアガイド**🆕: プレビュー上部ツールバーの「セーフエリア」チェックで action(3.5%)/title(5%) 枠を表示（プレビュー専用・出力には出ない）。

---

## 12. curio-gen が emit しないもの（参考）
- **音ハメ（拍検出 → scale パルス自動生成）**: アプリ内の「🎵拍に合わせて生成」ボタンで音声解析して `keyframes.scale` を作る**対話型ツール**。curio-gen が JSON で吐く類ではない（音声解析はアプリ側で走る）。必要なら curio-gen は `keyframes` を直接書けばパルスは表現可能。
- **character(Live2D)**: 実モデルファイルが必要。

---

## 13. 未対応まとめ（emit しても無視されるので避ける）
- `filter.tint`（着色）⚠️
- `colorgrade` の `mode:"duotone"`⚠️
- `keyframes`(UIトラック) の easing（linear固定）⚠️ ※ `kfs` 側は ease 対応
