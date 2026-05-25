# Live2D Cubism Core の配置

Live2D のキャラクターレイヤーを使うには、Live2D 公式が配布する **Cubism Core** ライブラリを
このディレクトリ (`public/`) に配置する必要がある。

ライセンスの都合で npm パッケージや git に同梱できないため、各自で取得する手順を以下に記す。

## 取得手順

1. [Cubism SDK for Web のダウンロードページ](https://www.live2d.com/sdk/download/web/) を開く
2. 利用規約に同意してダウンロード (`CubismSdkForWeb-X.Y.Z.zip`)
3. 解凍した zip 内の以下のファイルをコピー:

   ```
   CubismSdkForWeb-X.Y.Z/Core/live2dcubismcore.min.js
   ```

4. このディレクトリ直下に置く:

   ```
   public/live2dcubismcore.min.js
   ```

これで `index.html` の `<script src="/live2dcubismcore.min.js">` が解決され、
`pixi-live2d-display` が Cubism 4 系のモデル (`.moc3`) を読めるようになる。

## ライセンス

Cubism Core は **Live2D 専有ソフトウェア使用許諾契約書 (Proprietary License)** の対象。
本アプリは **個人利用のみ** を想定しており、配布や商用販売は行わない前提のため、
無償の Indie ライセンス枠内で利用できる。
詳細は [Live2D Cubism SDK ライセンス](https://www.live2d.com/eula/) を参照。

## 配置されていない場合の挙動

- アプリは起動する
- キャラクターレイヤー (Live2D) のみ初期化に失敗してプレビュー / エクスポートで無効化される
- 他のレイヤー (画像 / 動画 / テキスト / 音声 等) には一切影響しない
