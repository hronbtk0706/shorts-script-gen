/**
 * 手書き（筆順）グリフ字形データの provider。
 *
 * 「非同期ロード → 同期参照」の橋渡し。描画（computeHandwrite）は完全同期なので、
 * 描画前に preloadGlyphs/preloadHandwriteLayers で必要字形を module レベルの
 * glyphCache に詰めておき、getGlyph は同期でキャッシュを引くだけにする
 * （Live2D キャラの事前焼き＝exportTemplateWebCodecs と同じ思想）。
 *
 * Phase A: public/handwrite/ascii.json（Hershey 単線・ASCII）のみ。かな/漢字は未同梱で
 *          getGlyph が undefined を返す → 呼び出し側が char-sweep にフォールバック。
 * Phase B: KanjiVG（CC BY-SA）の codepoint シャード（gzip）を index.json 経由で遅延ロードする。
 *          そのための loadShard/index 枠を用意してある（現状 ASCII シャードのみ登録）。
 */

export interface Pt {
  x: number;
  y: number;
}

/** 1 グリフの筆順ストローク（0..1 正規化・y は下方向）。 */
export interface GlyphStrokes {
  /** 画ごとのポリライン（描く順）。座標は 0..1。 */
  strokes: Pt[][];
  /** 横送り（1.0 = 全角セル幅）。 */
  advance: number;
  /** 実データ由来なら true。false/未取得は呼び出し側が char-sweep。 */
  hasData: boolean;
}

interface ShardJson {
  format: string;
  source?: string;
  emHeight?: number;
  baselineNorm?: number;
  glyphs: Record<string, { advance: number; strokes: number[][] }>;
}

// codepoint → グリフ（同期参照用）。
const glyphCache = new Map<number, GlyphStrokes>();
// ロード済み / ロード中シャードの管理（多重 fetch 防止）。
const shardPromises = new Map<string, Promise<void>>();
// ASCII 共通メタ（baseline 揃え等に使用）。
let asciiBaselineNorm = 0.78;

/** public 配下のデータ URL（vite は public/ をルート直下で配信）。 */
function dataUrl(file: string): string {
  return `/handwrite/${file}`;
}

function ingestShard(json: ShardJson): void {
  if (typeof json.baselineNorm === "number") asciiBaselineNorm = json.baselineNorm;
  for (const [cpStr, g] of Object.entries(json.glyphs)) {
    const cp = Number(cpStr);
    if (!Number.isFinite(cp)) continue;
    const strokes: Pt[][] = g.strokes.map((flat) => {
      const pts: Pt[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        pts.push({ x: flat[i], y: flat[i + 1] });
      }
      return pts;
    });
    glyphCache.set(cp, { strokes, advance: g.advance, hasData: true });
  }
}

/** 1 シャードを fetch して glyphCache に取り込む（多重呼び出しは 1 回に集約）。 */
function loadShard(file: string): Promise<void> {
  const existing = shardPromises.get(file);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const res = await fetch(dataUrl(file));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let json: ShardJson;
      if (file.endsWith(".gz")) {
        // Phase B: gzip シャードは DecompressionStream で展開（webview/Chromium 対応）。
        const ds = new DecompressionStream("gzip");
        const stream = res.body!.pipeThrough(ds);
        const text = await new Response(stream).text();
        json = JSON.parse(text);
      } else {
        json = await res.json();
      }
      ingestShard(json);
    } catch (e) {
      console.warn(`[handwriteGlyphs] failed to load shard ${file}:`, e);
    }
  })();
  shardPromises.set(file, promise);
  return promise;
}

/**
 * 文字 → シャードファイル名。Phase A は ASCII のみ ascii.json、それ以外は null（未同梱）。
 * Phase B でかな/漢字 codepoint を kana.json / kanji-<bucket>.json.gz に割り当てる。
 */
function shardForCodepoint(cp: number): string | null {
  if (cp >= 0x20 && cp <= 0x7e) return "ascii.json";
  return null;
}

/** 同期: キャッシュからグリフを引く（未ロードは undefined＝char-sweep）。 */
export function getGlyph(codepoint: number): GlyphStrokes | undefined {
  return glyphCache.get(codepoint);
}

/** ASCII グリフ集合の baseline（正規化 y）。notebook 罫線揃え等に。 */
export function getAsciiBaselineNorm(): number {
  return asciiBaselineNorm;
}

/** 非同期: text 中の全文字の字形を glyphCache へロードする（描画前に呼ぶ）。 */
export async function preloadGlyphs(text: string): Promise<void> {
  if (!text) return;
  const shards = new Set<string>();
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (glyphCache.has(cp)) continue;
    const shard = shardForCodepoint(cp);
    if (shard) shards.add(shard);
  }
  await Promise.all([...shards].map((s) => loadShard(s)));
}

/** 非同期: handwrite を持つ全レイヤーの本文字形をロードする（preview/export 共通の前処理）。 */
export async function preloadHandwriteLayers(
  layers: { handwrite?: unknown; text?: string }[],
): Promise<void> {
  const texts = layers
    .filter((l) => l.handwrite)
    .map((l) => l.text ?? "")
    .filter(Boolean);
  if (texts.length === 0) return;
  await preloadGlyphs(texts.join(""));
}
