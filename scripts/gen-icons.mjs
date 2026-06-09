#!/usr/bin/env node
/**
 * icon プリミティブ用アイコンデータ生成器（curio-gen 依頼書「icon プリミティブ」§67-78）。
 *
 *   node scripts/gen-icons.mjs [--scan <dir|file> ...] [--template <file> ...]
 *
 * やること:
 *   1. 厳選セット(BASE_ICONS)＋エイリアス(ALIASES) を必ず同梱する。
 *   2. --scan で渡したテンプレ JSON（既定: repo の templates/）を走査し、
 *      使用中の {"type":"icon", "icon"/"name": ...} を集める。
 *   3. 同梱セットに無い名前だけ lucide-static（devDependency＝ビルド時のみ）から
 *      パスデータを取り出し、静的セット src/lib/iconData.ts へインラインする。
 *   4. 結果：実行時は静的・同期・オフラインのまま、バンドルには実際に使う分だけ入る
 *      （1500 全部は積まない）。"描画時にネット取得" は一切しない。
 *
 * 取りこぼし（lucide にも無い名前＝打ち間違い等）はスキップ（ログに warn）。
 * 実行時は iconLib の placeholder（破線四角＋名前）が描画して可視化する。
 *
 * prebuild フックから自動実行される（package.json）。生成物 src/lib/iconData.ts は
 * git に commit する（dev / HMR で生成不要にするため）。
 */
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, isAbsolute, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "..");
const LUCIDE_DIR = join(REPO, "node_modules", "lucide-static", "icons");
const OUT_FILE = join(REPO, "src", "lib", "iconData.ts");

/**
 * 同梱する厳選語彙（再利用前提・お金/解説テーマ全般）。依頼書 §58-63 のリスト。
 * すべて Lucide の正式名。
 */
const BASE_ICONS = [
  // お金・金融
  "coins", "banknote", "wallet", "credit-card", "piggy-bank", "hand-coins",
  "dollar-sign", "japanese-yen", "percent", "receipt",
  // 人・場所・組織
  "user", "users", "store", "landmark", "building", "factory",
  // 物・容器・封
  "smartphone", "gift", "package", "shopping-cart", "truck", "lock", "key",
  // 時間・状態
  "hourglass", "clock", "calendar", "flame", "check", "x", "circle-alert",
  "eye", "ban",
  // 動き・図・概念
  "arrow-right", "arrow-left-right", "trending-up", "trending-down", "scale",
  "globe", "lightbulb", "coffee",
];

/**
 * 呼び出し側が使いがちな別名 → Lucide 正式名。
 * curio-gen が "yen" 等で呼んでも解決できるようにする（依頼書 §59 は "yen" 表記）。
 */
const ALIASES = {
  yen: "japanese-yen",
  bank: "landmark",
  card: "credit-card",
  phone: "smartphone",
  cart: "shopping-cart",
  money: "banknote",
  cash: "banknote",
  coin: "coins",
  alert: "circle-alert",
  warning: "circle-alert",
  cross: "x",
  close: "x",
  balance: "scale",
};

function parseArgs(argv) {
  const out = { scan: [], template: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scan") out.scan.push(argv[++i]);
    else if (a === "--template") out.template.push(argv[++i]);
  }
  return out;
}

/** テンプレ JSON 1 ファイルから icon レイヤー名を収集する。 */
function collectFromTemplateFile(file) {
  const names = new Set();
  let json;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return names;
  }
  const layers = Array.isArray(json?.layers) ? json.layers : [];
  for (const l of layers) {
    if (l && l.type === "icon") {
      const n = l.icon ?? l.name ?? l.iconName;
      if (typeof n === "string" && n.trim()) names.add(n.trim());
    }
  }
  return names;
}

/** dir / file パスからテンプレ JSON を集めて icon 名を収集する。 */
function collectFromPath(p) {
  const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
  const names = new Set();
  if (!existsSync(abs)) return names;
  let files = [];
  try {
    // dir か file かを readdir で判定（dir 以外は例外）
    files = readdirSync(abs)
      .filter((f) => extname(f).toLowerCase() === ".json")
      .map((f) => join(abs, f));
  } catch {
    files = [abs];
  }
  for (const f of files) {
    for (const n of collectFromTemplateFile(f)) names.add(n);
  }
  return names;
}

/** lucide svg ファイルから inner markup（要素列）を 1 行で取り出す。 */
function extractIconBody(name) {
  const file = join(LUCIDE_DIR, `${name}.svg`);
  if (!existsSync(file)) return null;
  const svg = readFileSync(file, "utf8");
  const inner = svg
    .replace(/<!--[\s\S]*?-->/g, "") // ライセンスコメント除去
    .replace(/<svg[\s\S]*?>/, "") // 開始タグ
    .replace(/<\/svg>/, "") // 終了タグ
    .replace(/\s*\n\s*/g, "") // 改行＋インデント除去（属性値内に改行は無い）
    .trim();
  return inner || null;
}

const args = parseArgs(process.argv.slice(2));

if (!existsSync(LUCIDE_DIR)) {
  console.error(
    `[gen-icons] lucide-static が見つかりません: ${LUCIDE_DIR}\n` +
      `  npm install -D lucide-static を実行してください。`,
  );
  process.exit(1);
}

// 収集: BASE ∪ スキャンで見つかった名前（既定で repo の templates/ も見る）。
const scanPaths = [...args.scan];
if (args.scan.length === 0) scanPaths.push(join(REPO, "templates"));
const used = new Set();
for (const p of scanPaths) for (const n of collectFromPath(p)) used.add(n);
for (const f of args.template) {
  const abs = isAbsolute(f) ? f : resolve(process.cwd(), f);
  for (const n of collectFromTemplateFile(abs)) used.add(n);
}

// エイリアス解決（"yen" → "japanese-yen" 等）し、正式名の集合を作る。
const canonical = new Set(BASE_ICONS);
const missingFromLucide = [];
for (const raw of used) {
  const resolved = ALIASES[raw] ?? raw;
  canonical.add(resolved);
}

// 各正式名の body を取り出す。lucide に無いものは記録してスキップ。
const bodies = {};
for (const name of [...canonical].sort()) {
  const body = extractIconBody(name);
  if (body) bodies[name] = body;
  else missingFromLucide.push(name);
}

if (missingFromLucide.length > 0) {
  console.warn(
    `[gen-icons] lucide に存在しない名前（スキップ・実行時 placeholder）: ${missingFromLucide.join(", ")}`,
  );
}

// 出力（決定論的に名前順）。
const bodyEntries = Object.keys(bodies)
  .sort()
  .map((n) => `  ${JSON.stringify(n)}: ${JSON.stringify(bodies[n])},`)
  .join("\n");
const aliasEntries = Object.keys(ALIASES)
  .sort()
  .map((a) => `  ${JSON.stringify(a)}: ${JSON.stringify(ALIASES[a])},`)
  .join("\n");
const nameList = Object.keys(bodies)
  .sort()
  .map((n) => `  ${JSON.stringify(n)},`)
  .join("\n");

const out = `// AUTO-GENERATED by scripts/gen-icons.mjs — DO NOT EDIT BY HAND.
// アイコンは Lucide (https://lucide.dev) より。ISC License © Lucide Contributors.
// 再生成: npm run icons:sync （prebuild からも自動実行）。
// 値は <svg> の inner markup（要素列）。実行時に icons.ts が Path2D / inline SVG へ変換する。

/** アイコン名 → SVG inner markup（24x24 viewBox・stroke=currentColor 前提）。 */
export const ICON_BODIES: Record<string, string> = {
${bodyEntries}
};

/** 呼び出し側の別名 → 正式名。 */
export const ICON_ALIASES: Record<string, string> = {
${aliasEntries}
};

/** 同梱済みの正式名一覧（UI のピッカー用・名前順）。 */
export const ICON_NAMES: string[] = [
${nameList}
];
`;

writeFileSync(OUT_FILE, out, "utf8");
console.log(
  `[gen-icons] ${Object.keys(bodies).length} icons → ${OUT_FILE}` +
    (used.size ? ` (scanned ${used.size} used name(s))` : ""),
);
