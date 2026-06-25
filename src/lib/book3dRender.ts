/**
 * 3D本（book3d）レイヤーの描画コア（Three.js）。
 *
 * 既存 Live2D character と同じ二段構えの「描画部分」を担う:
 *  - ライブプレビュー: HTMLCanvasElement に 1 frame 描く（React 側が毎 frame renderFrame）
 *  - 書き出し: OffscreenCanvas に 1 frame 描く → mediabunny で VP9+alpha WebM に焼く（後段）
 * どちらも同じ Book3DRenderer を使うので「見た目と出力が違う」を避ける。
 *
 * glb（glTF2.0）を渡せばそれを読む。未指定なら手続き的なプレースホルダ本（見開き2ページ）を
 * 表示する（マテリアル名は素材規約に合わせ page_L_0 / page_R_0）。本物の glb に差し替えても
 * 同じ slot 名でページ中身を流し込めるよう設計。
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { BookCamera, BookFlipKeyframe, BookPageContent } from "../types";

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/**
 * 本(book3d レイヤー id) → 「slot の焼き込み(glb既定)テクスチャを data URL で取り出す関数」。
 * Book3DLayerContent が読込後に自分の renderer の抽出関数を登録し、TemplateBuilder が
 * layout 新規作成時にこれを呼んで、既定画像を「編集可能な画像レイヤー」として種まきする。
 */
export const bookSlotExtractors = new Map<
  string,
  (slot: string) => string | null
>();

/** 本(book3d レイヤー id) → この glb に実在する差し替え可能スロット名（マテリアル名）一覧。
 * スロット選択 UI はハードコードでなくこれを使う（存在しない slot を選べないように）。 */
export const bookSlotNames = new Map<string, string[]>();

/**
 * 同じ slot を持つページが複数あったら **先頭だけ採用** して重複を除く。
 * 「1 slot = 1 ページ」を保証し、描画（setPages / composeLayoutPages）と
 * 編集（findIndex で先頭一致）の「どちらを反映するか」を一致させる。
 * （過去の find-or-create バグで空の重複ページが混ざったデータも、これで安全に正規化される）
 */
export function dedupePagesBySlot(
  pages: BookPageContent[] | undefined,
): BookPageContent[] {
  if (!pages) return [];
  const seen = new Set<string>();
  const out: BookPageContent[] = [];
  for (const p of pages) {
    if (seen.has(p.slot)) continue;
    seen.add(p.slot);
    out.push(p);
  }
  return out;
}

/** ページテクスチャの供給源。画像URL / canvas / ImageBitmap を許容（将来の入れ子レイアウト用）。 */
export type TexSource =
  | string
  | HTMLCanvasElement
  | OffscreenCanvas
  | ImageBitmap;

/** flipper メッシュの変形用情報（bbox からヒンジ→外端軸 u・法線軸 n・奥行軸 d を自動検出）。 */
interface FlipperMesh {
  mesh: THREE.Mesh;
  nodeName: string;
  /** 元の頂点座標（変形前）。復元と毎フレーム再計算の基準。 */
  orig: Float32Array;
  /** ヒンジ→外端の軸 (0=x/1=y/2=z)。 */
  uAxis: number;
  /** 紙の法線（厚み）軸。カールはこの面内で曲げる。 */
  nAxis: number;
  /** 奥行（ヒンジに平行）軸。ねじりの基準。 */
  dAxis: number;
  /** u 軸上のヒンジ座標（0 付近の端）。 */
  hinge: number;
  /** u 軸の長さ。 */
  uLen: number;
  /** 奥行軸の中心。 */
  dCenter: number;
  /** 法線軸の平面位置（フラットページの n 値）。 */
  nFlat: number;
  /** 回転させる node（このページの所属ノード）。 */
  node: THREE.Object3D;
  /** node の初期位置（めくり時の手前オフセットを足す基準・リセット用）。 */
  origNodePos: THREE.Vector3;
  /** ヒンジ回転の軸キー（= 背＝奥行軸）。"x"|"y"|"z"。 */
  spineKey: "x" | "y" | "z";
  /** めくり回転の符号（外端が反対側へ持ち上がる向き）。 */
  turnSign: number;
  /** flipper（めくり専用・既定非表示）か、page（常時表示の本体ページ）か。 */
  isFlipper: boolean;
  /** 現在変形適用中か（無駄な書き戻し回避）。 */
  bent: boolean;
}

/**
 * 差し替えテクスチャの上下を glTF UV に合わせる（flipY=false）。
 * glTF テクスチャは上原点（GLTFLoader 既定）。CanvasTexture/TextureLoader 既定 flipY=true だと
 * 上下逆さまになるため false に。左右（U）反転はページごとに異なる（見開き左右でUVの向きが逆な本が
 * あるため）ので、orientForSlot で slot 単位に出し分ける（meshUvMirrored の判定結果）。
 */
function applyPageUvOrientation(tex: THREE.Texture): void {
  tex.flipY = false;
  // ClampToEdge: 反転(repeat.x=-1)時に端で巻き込まずクランプ＝端の隙間/シームを防ぐ。
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
}

/**
 * メッシュの UV を解析: 鏡像か（水平反転が要るか）＋ U の範囲(uMin,uMax)。
 * - mirrored: 面内三角形と UV 三角形の符号付き面積が逆向きなら鏡像（左ページ等）。
 * - uMin/uMax: 反転オフセットを正確に出すため（offset.x = uMin+uMax で範囲内ミラー＝端ズレ防止）。
 */
function analyzeMeshUv(geo: THREE.BufferGeometry | undefined): {
  mirrored: boolean;
  uMin: number;
  uMax: number;
} {
  const fallback = { mirrored: false, uMin: 0, uMax: 1 };
  if (!geo) return fallback;
  const pos = geo.getAttribute("position") as THREE.BufferAttribute | undefined;
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute | undefined;
  if (!pos || !uv) return fallback;
  // U 範囲
  let uMin = Infinity;
  let uMax = -Infinity;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i);
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
  }
  if (!Number.isFinite(uMin) || !Number.isFinite(uMax)) {
    uMin = 0;
    uMax = 1;
  }
  // 鏡像判定（面内三角形 vs UV 三角形の向き）
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const span = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
  let nAxis = 0;
  for (let i = 1; i < 3; i++) if (span[i] < span[nAxis]) nAxis = i;
  const planar = [0, 1, 2].filter((i) => i !== nAxis);
  const idx = geo.index;
  const i0 = idx ? idx.getX(0) : 0;
  const i1 = idx ? idx.getX(1) : 1;
  const i2 = idx ? idx.getX(2) : 2;
  const comp = (a: THREE.BufferAttribute, i: number, axis: number) =>
    axis === 0 ? a.getX(i) : axis === 1 ? a.getY(i) : a.getZ(i);
  const pe1 = [
    comp(pos, i1, planar[0]) - comp(pos, i0, planar[0]),
    comp(pos, i1, planar[1]) - comp(pos, i0, planar[1]),
  ];
  const pe2 = [
    comp(pos, i2, planar[0]) - comp(pos, i0, planar[0]),
    comp(pos, i2, planar[1]) - comp(pos, i0, planar[1]),
  ];
  const posCross = pe1[0] * pe2[1] - pe1[1] * pe2[0];
  const ue1 = [uv.getX(i1) - uv.getX(i0), uv.getY(i1) - uv.getY(i0)];
  const ue2 = [uv.getX(i2) - uv.getX(i0), uv.getY(i2) - uv.getY(i0)];
  const uvCross = ue1[0] * ue2[1] - ue1[1] * ue2[0];
  const mirrored =
    Math.abs(posCross) > 1e-9 &&
    Math.abs(uvCross) > 1e-9 &&
    posCross * uvCross < 0;
  return { mirrored, uMin, uMax };
}

/** lens(mm 相当・35mm 換算) → 垂直 fov(度)。sensor 36mm 基準。 */
function lensToFov(lens: number): number {
  const sensor = 36;
  return (2 * Math.atan(sensor / (2 * Math.max(1, lens))) * 180) / Math.PI;
}

/** 文字をその場で画像化したテクスチャを作る（ページに文字を貼る用）。 */
function makeTextTexture(
  text: string,
  opts: { font?: string; size?: number; color?: string; align?: string } = {},
): THREE.Texture {
  const W = 512;
  const H = 720; // ページの縦長比に合わせる
  const cv = new OffscreenCanvas(W, H);
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#f7f3ea"; // 紙地
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = opts.color ?? "#1a1a1a";
  const px = (opts.size ?? 34) * 2; // テクスチャ解像度に合わせて拡大
  const fam = opts.font ?? "sans-serif";
  ctx.font = `bold ${px}px ${fam}`;
  ctx.textBaseline = "top";
  const align = opts.align ?? "left";
  ctx.textAlign = align === "center" ? "center" : "left";
  const x = align === "center" ? W / 2 : 40;
  // 素朴な折り返し
  const maxW = W - 80;
  const lines: string[] = [];
  let cur = "";
  for (const ch of text) {
    if (ch === "\n") {
      lines.push(cur);
      cur = "";
      continue;
    }
    const t = cur + ch;
    if (ctx.measureText(t).width > maxW && cur) {
      lines.push(cur);
      cur = ch;
    } else {
      cur = t;
    }
  }
  if (cur) lines.push(cur);
  let y = 48;
  for (const ln of lines) {
    ctx.fillText(ln, x, y);
    y += px * 1.3;
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  applyPageUvOrientation(tex); // glTF UV に合わせる（上下＋左右）
  return tex;
}

/** 既定のページ地テクスチャ（薄クリームに slot 名を薄く）。 */
function makePaperTexture(label: string): THREE.Texture {
  const cv = new OffscreenCanvas(256, 360);
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#f3eee2";
  ctx.fillRect(0, 0, 256, 360);
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.font = "20px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(label, 128, 184);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  applyPageUvOrientation(tex); // glTF UV に合わせる（上下＋左右）
  return tex;
}

export class Book3DRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private root = new THREE.Group();
  /** slot 名(= マテリアル名) → マテリアル。ページ中身差し替えに使う。 */
  private materials = new Map<string, THREE.MeshStandardMaterial | THREE.MeshBasicMaterial>();
  /** slot ごとに割り当てたテクスチャ（dispose 管理）。 */
  private assigned = new Map<string, THREE.Texture>();
  /** slot(マテリアル名) → UV が鏡像か（水平反転が要るか）。collectMaterials で判定。 */
  private materialFlipU = new Map<string, boolean>();
  /** slot → 反転オフセット(= uMin+uMax)。UV範囲がフル[0,1]でない本でも端がズレないように。 */
  private materialFlipOffset = new Map<string, number>();
  /** slot → glb 既定の元テクスチャ（差し替え前）。空 layout のとき復元するために保持。 */
  private originalMap = new Map<string, THREE.Texture | null>();
  /** めくり用フラットページの node（名前 flipper_L / flipper_R）。 */
  private flipperNodes = new Map<string, THREE.Object3D>();
  /** flipper メッシュの曲げ用情報（元頂点・ヒンジ→外端軸・法線軸を bbox から自動検出）。 */
  private flipperMeshes: FlipperMesh[] = [];
  private width: number;
  private height: number;
  private disposed = false;

  constructor(canvas: AnyCanvas, width: number, height: number) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.renderer = new THREE.WebGLRenderer({
      canvas: canvas as HTMLCanvasElement,
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      // 別 tick で 2D ctx に drawImage して取り込む（合成Canvas経路）ため、描画後も
      // バッファを保持しないと空が読まれる（既定 false だとクリアされる）。
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(this.width, this.height, false);
    this.renderer.setClearColor(0x000000, 0); // 透過背景

    this.scene = new THREE.Scene();
    this.scene.add(this.root);
    // 法線マップ無しの glb でも立体感が出るライティング:
    // 環境光は弱め（陰影を潰さない）＋ 斜め上のキーライト強め ＋ 反対側に弱いフィル。
    // Standard マテリアルに効く（Basic は無視するが無害）。
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.42));
    const key = new THREE.DirectionalLight(0xffffff, 1.05);
    key.position.set(2.5, 4.5, 3); // 右上手前から
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.32);
    fill.position.set(-3, 1.5, -2); // 反対側（左下奥）から弱く起こす
    this.scene.add(fill);

    this.camera = new THREE.PerspectiveCamera(
      40,
      this.width / this.height,
      0.05,
      100,
    );
  }

  /** glb を読む。path 未指定（or 読込失敗）ならプレースホルダ本を組む。 */
  async loadModel(gltfPath?: string, resolveUrl?: (p: string) => string): Promise<void> {
    this.clearRoot();
    if (gltfPath) {
      try {
        const url = resolveUrl ? resolveUrl(gltfPath) : gltfPath;
        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(url);
        this.root.add(gltf.scene);
        this.collectMaterials(gltf.scene);
        this.collectFlippers(gltf.scene);
        // めくり専用のフラットページ（flipper_*）は「めくる瞬間だけ表示」想定。既定は隠す。
        this.setFlippersVisible(false);
        this.fitRootToView();
        return;
      } catch (e) {
        console.warn("[book3d] glb 読込失敗→プレースホルダ本にフォールバック", e);
      }
    }
    this.buildPlaceholderBook();
    this.fitRootToView();
  }

  /**
   * めくり可能なページ node を集める（flipper_* ＝めくり専用 / Page* ＝本体ページ どちらも）。
   * 各ページの「ヒンジ→外端 u / 法線 n / 背＝奥行 d」軸を bbox から自動検出。回転軸・符号も決める。
   * flipperMeshes は収集順（node 順）＝めくり index 順。
   */
  private collectFlippers(obj: THREE.Object3D): void {
    obj.traverse((o) => {
      if (!o.name) return;
      const isFlipper = /^flipper/i.test(o.name);
      const isPage = /^page/i.test(o.name);
      if (!isFlipper && !isPage) return;
      this.flipperNodes.set(o.name, o);
      const nodeName = o.name;
      o.traverse((m) => {
        const mesh = m as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        const geo = mesh.geometry as THREE.BufferGeometry;
        geo.computeBoundingBox();
        const bb = geo.boundingBox!;
        const min = [bb.min.x, bb.min.y, bb.min.z];
        const max = [bb.max.x, bb.max.y, bb.max.z];
        const span = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
        // 法線軸 = 最も薄い軸（紙の厚み方向）
        let nAxis = 0;
        for (let i = 1; i < 3; i++) if (span[i] < span[nAxis]) nAxis = i;
        // 残り2軸のうち、片端が 0 付近（=ヒンジ端）の軸を u（ヒンジ→外端）とする
        const others = [0, 1, 2].filter((i) => i !== nAxis);
        const near0 = (i: number) => Math.min(Math.abs(min[i]), Math.abs(max[i]));
        const uAxis = near0(others[0]) <= near0(others[1]) ? others[0] : others[1];
        const dAxis = others[0] === uAxis ? others[1] : others[0]; // 奥行＝背
        const hinge =
          Math.abs(min[uAxis]) < Math.abs(max[uAxis]) ? min[uAxis] : max[uAxis];
        const outer =
          Math.abs(min[uAxis]) < Math.abs(max[uAxis]) ? max[uAxis] : min[uAxis];
        const uLen = span[uAxis] || 1;
        const dCenter = (min[dAxis] + max[dAxis]) / 2;
        const nFlat = (min[nAxis] + max[nAxis]) / 2;
        const uDir = Math.sign(outer - hinge) || -1;
        const spineKey = (["x", "y", "z"] as const)[dAxis]; // 背（奥行）軸まわりに反転
        // 外端が「法線+方向（手前）」へ持ち上がって反対側へ倒れる符号
        const turnSign = -uDir;
        const pos = geo.getAttribute("position") as THREE.BufferAttribute;
        this.flipperMeshes.push({
          mesh,
          nodeName,
          orig: new Float32Array(pos.array as ArrayLike<number>),
          uAxis,
          nAxis,
          dAxis,
          hinge,
          uLen,
          dCenter,
          nFlat,
          node: o,
          origNodePos: o.position.clone(),
          spineKey,
          turnSign,
          isFlipper,
          bent: false,
        });
      });
    });
  }

  /**
   * めくりの連続変形（剛体回転＋最後に反射＝スナップ、をやめる）。
   * 各頂点を **rest(右の静止形) → 反射(左の静止形=背平面 z=0 で z 反転＝湾曲 world x を保ったまま左へ)**
   * へ world 空間で連続モーフし、world -x（手前=机から起き上がる向き）へ sin(πp) の弧で
   * 持ち上げる（外端ほど高く）。さらに進行方向へ少しくぼませて（空気抵抗の concave）紙らしくする。
   * p=1 では反射の静止形に一致するので、完了時のスナップが原理的に出ない。
   * node は rest 変換のまま（変形は geometry に焼く）。
   */
  private deformFlipperTurn(fm: FlipperMesh, p: number): void {
    const node = fm.node;
    // rest 変換（rotation0 / scale1 / origNodePos）で matrixWorld を確定。
    node.rotation[fm.spineKey] = 0;
    node.scale.set(1, 1, 1);
    node.position.copy(fm.origNodePos);
    node.updateWorldMatrix(true, false);
    const Mrest = node.matrixWorld.clone();
    // 反射版（背平面=node-local z=0 を world で反転）の matrixWorld。
    node.scale.z = -1;
    node.updateWorldMatrix(true, false);
    const Mref = node.matrixWorld.clone();
    // 焼き込みは rest 変換基準なので node を rest に戻す。
    node.scale.set(1, 1, 1);
    node.updateWorldMatrix(true, false);
    const MrestInv = new THREE.Matrix4().copy(Mrest).invert();

    const geo = fm.mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const s = p * p * (3 - 2 * p); // 右→左モーフ（smoothstep）
    const wave = Math.sin(Math.PI * p);
    // 起き上がる「上」は world -x（カメラは -x 側から見る＝手前が -x）。+x は机の中＝下。
    const liftAmt = 1.7 * wave; // -x（机から起き上がる）への弧の高さ
    const dishAmt = 0.5 * wave; // 空気抵抗で中央が遅れてくぼむ量（+x=机側へ）
    const o = new THREE.Vector3();
    const wr = new THREE.Vector3();
    const wref = new THREE.Vector3();
    const w = new THREE.Vector3();
    for (let i = 0; i < arr.length; i += 3) {
      o.set(fm.orig[i], fm.orig[i + 1], fm.orig[i + 2]);
      wr.copy(o).applyMatrix4(Mrest); // rest world
      wref.copy(o).applyMatrix4(Mref); // 反射 world
      // 背(hinge)からの距離 0..1（外端ほど 1）。弧・くぼみのプロファイル。
      const dist = Math.min(1, Math.abs(fm.orig[i + fm.uAxis] - fm.hinge) / (fm.uLen || 1));
      // 持ち上げは外端ほど高い半円、くぼみは中央(dist=0.5)で最大の concave。
      const lift = liftAmt * Math.sin((Math.PI / 2) * dist);
      const dish = dishAmt * Math.sin(Math.PI * dist);
      w.set(
        wr.x + (wref.x - wr.x) * s - lift + dish,
        wr.y + (wref.y - wr.y) * s,
        wr.z + (wref.z - wr.z) * s,
      );
      w.applyMatrix4(MrestInv); // mesh ローカルへ戻す
      arr[i] = w.x;
      arr[i + 1] = w.y;
      arr[i + 2] = w.z;
    }
    pos.needsUpdate = true;
    fm.bent = true;
  }

  /** 曲げを元に戻す（窓外）。 */
  private restoreFlipper(fm: FlipperMesh): void {
    if (!fm.bent) return;
    const geo = fm.mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    (pos.array as Float32Array).set(fm.orig);
    pos.needsUpdate = true;
    fm.bent = false;
  }

  /** めくり専用 flipper_*（本体 Page* は対象外＝常時表示）の表示/非表示を切替。 */
  setFlippersVisible(visible: boolean): void {
    for (const [name, n] of this.flipperNodes) {
      if (/^flipper/i.test(name)) n.visible = visible;
    }
  }

  /**
   * メッシュを「常に最前面」に描く/戻す。めくる紙が他ページの下に潜らないように、
   * depthTest を切って renderOrder を上げる（位置は動かさない＝隣ページに干渉しない）。
   */
  private setMeshOnTop(mesh: THREE.Mesh, onTop: boolean): void {
    mesh.renderOrder = onTop ? 10 : 0;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const mat = m as THREE.Material | undefined;
      if (!mat) continue;
      mat.depthTest = !onTop;
      mat.depthWrite = !onTop;
    }
  }

  /**
   * めくり駆動（ティア2・剛体回転版）。bookFlip の窓 [atSec, atSec+dur] で flipper を
   * 背(X=0)ヒンジの Z 軸回転（+X→+Y→−X）でめくる。窓外は flipper を隠す（静止見開きだけ）。
   * 円筒曲げは後段で追加（まずは確実に動く剛体回転）。
   * page が偶数=右ページ(flipper_R)を左へ、奇数=左ページ(flipper_L)を右へ、と解釈。
   */
  applyFlip(flips: BookFlipKeyframe[] | undefined, t: number): void {
    // 既定（リセット）: 各ページを静止（回転0・変形解除・位置を初期に戻す・最前面化を解除）。
    for (const fm of this.flipperMeshes) {
      this.restoreFlipper(fm);
      fm.node.rotation[fm.spineKey] = 0;
      fm.node.position.copy(fm.origNodePos);
      fm.node.scale.z = 1; // 完了時の背平面反射(scale.z=-1)を戻す
      this.setMeshOnTop(fm.mesh, false);
      fm.node.visible = !fm.isFlipper;
    }
    if (!flips || flips.length === 0) return;

    // flipperMeshes は収集順（node 順）＝めくり index 順。f.page でそのページを引く。
    const pages = this.flipperMeshes;
    for (const f of flips) {
      const fm = pages[f.page];
      if (!fm) continue;
      // めくる紙は「束の一番上の1枚」＝位置は動かさず、常に最前面に描く（depthTest off + 高renderOrder）。
      // これで回転中も倒れた後も他ページの上に重なる（下に潜らない・隣に干渉しない・pop-up もしない）。
      this.setMeshOnTop(fm.mesh, true);
      fm.node.visible = true;
      const dur = Math.max(0.05, f.durationSec ?? 0.8);
      if (t < f.atSec) continue; // まだめくっていない＝右で静止（ただし一番上）
      // めくり中も完了も「rest(右)→反射(左) への連続頂点モーフ＋持ち上げの弧＋空気抵抗くぼみ」で
      // 動かす。p=1 が反射の静止形（検証済み）に一致するので、回転→反射の切替スナップが出ない。
      const p = Math.min(1, (t - f.atSec) / dur);
      this.deformFlipperTurn(fm, p);
      // break しない: 複数ページ（完了済み=固定 / めくり中 / 未めくり）を同時に正しく反映
    }
  }

  /** glTF シーンから名前付きマテリアルを集める（slot 差し替え用）。 */
  private collectMaterials(obj: THREE.Object3D): void {
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // このメッシュの UV 解析（鏡像か＋U範囲）。見開きの左右でUVの向き/範囲が違う本に対応。
      const uvInfo = analyzeMeshUv(mesh.geometry as THREE.BufferGeometry);
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const mm = m as THREE.MeshStandardMaterial;
        if (mm && mm.name) {
          mm.side = THREE.DoubleSide;
          this.materials.set(mm.name, mm);
          if (!this.materialFlipU.has(mm.name)) {
            this.materialFlipU.set(mm.name, uvInfo.mirrored);
            this.materialFlipOffset.set(mm.name, uvInfo.uMin + uvInfo.uMax);
          }
          if (!this.originalMap.has(mm.name))
            this.originalMap.set(mm.name, mm.map ?? null);
        }
      }
    });
  }

  /** slot のUV向きに合わせてテクスチャの水平反転を設定（flipY は applyPageUvOrientation で済）。 */
  private orientForSlot(tex: THREE.Texture, slot: string): void {
    const flipU = this.materialFlipU.get(slot) ?? false;
    // ClampToEdge: 反転時に端で巻き込まずクランプ。
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.repeat.x = flipU ? -1 : 1;
    // 反転オフセットは UV 範囲から正確に（offset=uMin+uMax）。フル[0,1]でない本でも端がズレない。
    tex.offset.x = flipU ? this.materialFlipOffset.get(slot) ?? 1 : 0;
    tex.needsUpdate = true;
  }

  /**
   * 手続き的プレースホルダ本（見開き2ページ）。本物の glb と同じ向き＝**机に開いて置いた本**
   * （ページは XZ 平面に寝かせ、法線は +Y。とじ目は X=0・Z 方向）にして、推奨カメラ（上から俯瞰）が
   * そのまま使えるようにする。glb 読込失敗時のフォールバック用。
   */
  private buildPlaceholderBook(): void {
    const pageW = 1.2; // X方向（左右）
    const pageD = 1.7; // Z方向（奥行=ページの縦）
    const tilt = THREE.MathUtils.degToRad(7); // 背側を少し起こすテント
    const make = (slot: string, sign: number) => {
      const geo = new THREE.PlaneGeometry(pageW, pageD);
      const mat = new THREE.MeshBasicMaterial({
        map: makePaperTexture(slot),
        side: THREE.DoubleSide,
      });
      mat.name = slot;
      const mesh = new THREE.Mesh(geo, mat);
      // PlaneGeometry は XY 面。X 軸まわり -90° で XZ 面（寝かせて法線+Y）に。
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.x = (sign * pageW) / 2;
      // 背(x=0)を蝶番に少しだけ起こす
      const pivot = new THREE.Group();
      pivot.add(mesh);
      pivot.rotation.z = sign * tilt;
      this.root.add(pivot);
      this.materials.set(slot, mat);
    };
    make("page_L_0", -1);
    make("page_R_0", 1);
  }

  /** root をだいたい原点中心・見やすいスケールに収める。 */
  private fitRootToView(): void {
    const box = new THREE.Box3().setFromObject(this.root);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    this.root.position.sub(center); // 中心を原点へ
  }

  /** カメラ（yaw/pitch/distance/targetY/lens）を反映。 */
  setCamera(cam: BookCamera): void {
    const yaw = THREE.MathUtils.degToRad(cam.yaw ?? 0);
    const pitch = THREE.MathUtils.degToRad(cam.pitch ?? 0);
    const dist = Math.max(0.1, cam.distance ?? 3);
    const ty = cam.targetY ?? 0;
    const target = new THREE.Vector3(0, ty, 0);
    const dir = new THREE.Vector3(
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(yaw) * Math.cos(pitch),
    );
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(target);
    this.camera.fov = lensToFov(cam.lens ?? 50);
    this.camera.updateProjectionMatrix();
  }

  /**
   * 任意のテクスチャ源から THREE.Texture を作る。
   * 将来ティア（ページ＝テキスト＋画像＋動画の入れ子レイアウトを layerComposer で 1 枚の
   * canvas に組んでそのまま流す）に備え、**画像URL だけでなく canvas / ImageBitmap も受ける**。
   */
  private async makeTexture(source: TexSource): Promise<THREE.Texture | null> {
    try {
      if (typeof source === "string") {
        const tex = await new THREE.TextureLoader().loadAsync(source);
        tex.colorSpace = THREE.SRGBColorSpace;
        applyPageUvOrientation(tex);
        tex.needsUpdate = true;
        return tex;
      }
      // ImageBitmap / Canvas は CanvasTexture/Texture でそのまま貼れる
      const tex =
        typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap
          ? new THREE.Texture(source)
          : new THREE.CanvasTexture(source as HTMLCanvasElement | OffscreenCanvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      applyPageUvOrientation(tex);
      tex.needsUpdate = true;
      return tex;
    } catch (e) {
      console.warn("[book3d] テクスチャ生成失敗", e);
      return null;
    }
  }

  /** slot の glb 既定（焼き込み）テクスチャ画像を data URL で取り出す。無ければ null。
   *  「焼き込み画像を編集可能な画像レイヤーとして取り込む」用。向きは生画像のまま（合成時に
   *  orientForSlot で元の焼き込みと同じ向きに揃う）。 */
  extractSlotImageURL(slot: string): string | null {
    const tex = this.originalMap.get(slot) ?? this.materials.get(slot)?.map;
    const img = (tex as THREE.Texture | null | undefined)?.image as
      | CanvasImageSource
      | undefined;
    if (!img) return null;
    const iw = (img as { width?: number }).width || 1024;
    const ih = (img as { height?: number }).height || 1448;
    try {
      const cv = document.createElement("canvas");
      cv.width = iw;
      cv.height = ih;
      const cx = cv.getContext("2d");
      if (!cx) return null;
      cx.drawImage(img, 0, 0, iw, ih);
      return cv.toDataURL("image/jpeg", 0.9);
    } catch (e) {
      console.warn("[book3d] 焼き込み画像の取り出し失敗", slot, e);
      return null;
    }
  }

  /** この glb に実在する差し替え可能スロット名（マテリアル名）。ページ/表紙系を優先的に返す。 */
  slotNames(): string[] {
    const all = [...this.materials.keys()];
    const pageLike = all.filter((n) => /page|cover|spine/i.test(n));
    return (pageLike.length > 0 ? pageLike : all).sort();
  }

  /** slot を glb 既定（埋め込み）テクスチャに戻す。空 layout ページのとき呼ぶ（白紙で上書きしない）。 */
  restoreSlot(slot: string): void {
    const mat = this.materials.get(slot);
    if (!mat) return;
    const prev = this.assigned.get(slot);
    if (prev) {
      prev.dispose();
      this.assigned.delete(slot);
    }
    mat.map = this.originalMap.get(slot) ?? null;
    mat.needsUpdate = true;
  }

  /** slot のマテリアルにテクスチャ源を割り当てる（image URL / canvas / ImageBitmap 何でも可）。 */
  async setSlotTexture(slot: string, source: TexSource): Promise<void> {
    const mat = this.materials.get(slot);
    if (!mat) return;
    const tex = await this.makeTexture(source);
    if (!tex) return;
    this.orientForSlot(tex, slot); // slot ごとの水平反転（鏡像UV対応）
    const prev = this.assigned.get(slot);
    if (prev) prev.dispose();
    this.assigned.set(slot, tex);
    mat.map = tex;
    mat.needsUpdate = true;
  }

  /**
   * ページ中身（JSON の pages[]）を反映。slot 名のマテリアルにテクスチャを割り当てる。
   * - image: resolveUrl(src) の URL からテクスチャ読込
   * - text: その場で画像化（曲面UVにベタ貼り）
   */
  async setPages(
    pages: BookPageContent[] | undefined,
    resolveUrl?: (p: string) => string,
  ): Promise<void> {
    if (!pages) return;
    for (const pg of dedupePagesBySlot(pages)) {
      if (!this.materials.has(pg.slot)) continue;
      if (pg.kind === "text") {
        const tex = makeTextTexture(pg.text, {
          font: pg.font,
          size: pg.size,
          color: pg.color,
          align: pg.align,
        });
        this.orientForSlot(tex, pg.slot); // slot ごとの水平反転（鏡像UV対応）
        const prev = this.assigned.get(pg.slot);
        if (prev) prev.dispose();
        this.assigned.set(pg.slot, tex);
        const mat = this.materials.get(pg.slot)!;
        mat.map = tex;
        mat.needsUpdate = true;
      } else if (pg.kind === "image") {
        await this.setSlotTexture(pg.slot, resolveUrl ? resolveUrl(pg.src) : pg.src);
      }
    }
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }

  /** 1 frame 描画して描画先 canvas を返す。 */
  renderFrame(): AnyCanvas {
    if (!this.disposed) this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement as AnyCanvas;
  }

  private clearRoot(): void {
    while (this.root.children.length) {
      const c = this.root.children.pop()!;
      c.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
          const mats = Array.isArray(mesh.material)
            ? mesh.material
            : [mesh.material];
          for (const m of mats) (m as THREE.Material)?.dispose();
        }
      });
    }
    this.materials.clear();
    this.materialFlipU.clear();
    this.materialFlipOffset.clear();
    this.originalMap.clear();
    this.flipperNodes.clear();
    this.flipperMeshes = [];
  }

  dispose(): void {
    this.disposed = true;
    this.clearRoot();
    for (const t of this.assigned.values()) t.dispose();
    this.assigned.clear();
    this.renderer.dispose();
  }
}
