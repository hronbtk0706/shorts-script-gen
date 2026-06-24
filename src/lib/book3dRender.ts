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

/** ページテクスチャの供給源。画像URL / canvas / ImageBitmap を許容（将来の入れ子レイアウト用）。 */
export type TexSource =
  | string
  | HTMLCanvasElement
  | OffscreenCanvas
  | ImageBitmap;

/** flipper メッシュの曲げ用情報（bbox からヒンジ→外端軸 u・法線軸 n を自動検出）。 */
interface FlipperMesh {
  mesh: THREE.Mesh;
  nodeName: string;
  /** 元の頂点座標（曲げ前）。復元と毎フレーム再計算の基準。 */
  orig: Float32Array;
  /** ヒンジ→外端の軸 (0=x/1=y/2=z)。 */
  uAxis: number;
  /** 紙の法線（厚み）軸。曲げはこの方向へ持ち上げる。 */
  nAxis: number;
  /** u 軸上のヒンジ座標（0 付近の端）。 */
  hinge: number;
  /** u 軸の長さ。 */
  uLen: number;
  /** 現在曲げ適用中か（無駄な書き戻し回避）。 */
  bent: boolean;
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

  /** めくり用フラットページ node（flipper_*）と、その曲げ用メッシュ情報を集める。 */
  private collectFlippers(obj: THREE.Object3D): void {
    obj.traverse((o) => {
      if (!o.name || !o.name.toLowerCase().startsWith("flipper")) return;
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
        const hinge =
          Math.abs(min[uAxis]) < Math.abs(max[uAxis]) ? min[uAxis] : max[uAxis];
        const uLen = span[uAxis] || 1;
        const pos = geo.getAttribute("position") as THREE.BufferAttribute;
        this.flipperMeshes.push({
          mesh,
          nodeName,
          orig: new Float32Array(pos.array as ArrayLike<number>),
          uAxis,
          nAxis,
          hinge,
          uLen,
          bent: false,
        });
      });
    });
  }

  /** flipper メッシュを「弓なり（円筒曲げ）」に変形。amount 0..1（中盤で最大）。 */
  private bendFlipper(fm: FlipperMesh, amount: number): void {
    const geo = fm.mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const maxLift = fm.uLen * 0.35 * amount; // 外端の盛り上がり量
    for (let i = 0; i < arr.length; i += 3) {
      const u = fm.orig[i + fm.uAxis];
      const s = Math.abs(u - fm.hinge) / fm.uLen; // 0(ヒンジ)→1(外端)
      // ヒンジ固定で外端ほど法線方向へ持ち上げ（2乗で根元はなだらか）
      arr[i + fm.nAxis] = fm.orig[i + fm.nAxis] + maxLift * s * s;
      // わずかに u を縮めて弧長を保つ（見栄え）
      arr[i + fm.uAxis] =
        fm.hinge + (u - fm.hinge) * (1 - amount * 0.12 * s);
      // 他軸（depth）はそのまま
      const other = [0, 1, 2].find((a) => a !== fm.uAxis && a !== fm.nAxis)!;
      arr[i + other] = fm.orig[i + other];
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

  /** めくり用フラットページ（node 名 flipper_*）の表示/非表示を切替。 */
  setFlippersVisible(visible: boolean): void {
    for (const n of this.flipperNodes.values()) {
      n.visible = visible;
      n.rotation.z = 0;
    }
  }

  /**
   * めくり駆動（ティア2・剛体回転版）。bookFlip の窓 [atSec, atSec+dur] で flipper を
   * 背(X=0)ヒンジの Z 軸回転（+X→+Y→−X）でめくる。窓外は flipper を隠す（静止見開きだけ）。
   * 円筒曲げは後段で追加（まずは確実に動く剛体回転）。
   * page が偶数=右ページ(flipper_R)を左へ、奇数=左ページ(flipper_L)を右へ、と解釈。
   */
  applyFlip(flips: BookFlipKeyframe[] | undefined, t: number): void {
    // 既定: 全 flipper 非表示・回転 0・曲げ解除
    for (const n of this.flipperNodes.values()) {
      n.visible = false;
      n.rotation.z = 0;
    }
    for (const fm of this.flipperMeshes) this.restoreFlipper(fm);
    if (!flips || flips.length === 0) return;
    for (const f of flips) {
      const dur = Math.max(0.05, f.durationSec ?? 0.8);
      if (t < f.atSec || t > f.atSec + dur) continue;
      const p = Math.max(0, Math.min(1, (t - f.atSec) / dur));
      // easeInOutQuad（回転の緩急）
      const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      const left = f.page % 2 !== 0; // 奇数=左ページめくり
      const name = left ? "flipper_L" : "flipper_R";
      const node =
        this.flipperNodes.get(name) ?? this.flipperNodes.get(name.toLowerCase());
      if (node) {
        node.visible = true;
        // 右ページは +X→+Y→−X（+Z 回転）、左ページは逆向き
        node.rotation.z = (left ? -1 : 1) * e * Math.PI;
        // しなり（円筒曲げ）: 中盤で最大の弓なり（sin で 0→1→0）
        const bend = Math.sin(p * Math.PI);
        for (const fm of this.flipperMeshes) {
          if (fm.nodeName === name) this.bendFlipper(fm, bend);
        }
      }
      break;
    }
  }

  /** glTF シーンから名前付きマテリアルを集める（slot 差し替え用）。 */
  private collectMaterials(obj: THREE.Object3D): void {
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const mm = m as THREE.MeshStandardMaterial;
        if (mm && mm.name) {
          mm.side = THREE.DoubleSide;
          this.materials.set(mm.name, mm);
        }
      }
    });
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
        return tex;
      }
      // ImageBitmap / Canvas は CanvasTexture/Texture でそのまま貼れる
      const tex =
        typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap
          ? new THREE.Texture(source)
          : new THREE.CanvasTexture(source as HTMLCanvasElement | OffscreenCanvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      return tex;
    } catch (e) {
      console.warn("[book3d] テクスチャ生成失敗", e);
      return null;
    }
  }

  /** slot のマテリアルにテクスチャ源を割り当てる（image URL / canvas / ImageBitmap 何でも可）。 */
  async setSlotTexture(slot: string, source: TexSource): Promise<void> {
    const mat = this.materials.get(slot);
    if (!mat) return;
    const tex = await this.makeTexture(source);
    if (!tex) return;
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
    for (const pg of pages) {
      if (!this.materials.has(pg.slot)) continue;
      if (pg.kind === "text") {
        const tex = makeTextTexture(pg.text, {
          font: pg.font,
          size: pg.size,
          color: pg.color,
          align: pg.align,
        });
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
