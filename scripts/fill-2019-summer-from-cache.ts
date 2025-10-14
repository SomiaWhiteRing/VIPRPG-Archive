import fs from "node:fs/promises";
import path from "node:path";

const FESTIVAL_ID = "2019-summer";
const CATCH_DIR = path.join(process.cwd(), "catch", FESTIVAL_ID);
const OUTPUT_WORKS = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_ID}.json`);

type Row = Record<string, string>;

function sanitize(v?: string | null) {
  if (!v) return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t || undefined;
}

async function readUserHtml(): Promise<string> {
  // 39 号页面已保存且包含完整 globalDataes
  const innerFile = path.join(CATCH_DIR, `game-39.html`);
  const html = await fs.readFile(innerFile, "utf8");
  return html;
}

function decodeGlobalDataes(html: string): Row[] {
  // 从内页脚本中提取 globalDataes = JSON.parse('...')
  const m = html.match(/globalDataes\s*=\s*JSON\.parse\((['"])([\s\S]*?)\1\)/);
  if (!m) throw new Error("未找到 globalDataes 片段");
  const quote = m[1];
  const body = m[2];
  // 通过构造 JS 字符串字面量来还原 JSON 文本
  const jsonText = (new Function(`return ${quote}${body}${quote};`))() as string;
  // 修正非标准转义：在 JSON 文本中出现了诸如 "\<", "\(", "\'" 等非 JSON 合法转义，需移除多余反斜杠
  const cleaned = jsonText.replace(/\\(?!["\\\/bfnrtu])/g, "");
  const arr = JSON.parse(cleaned) as Row[];
  return arr;
}

async function main() {
  const html = await readUserHtml();
  const rows = decodeGlobalDataes(html);
  const filtered = rows.filter(r => {
    const g = Number(r.gameNo);
    return Number.isFinite(g) && g >= 1 && g <= 80; // 只保留 1..80 的游戏项（排除 0: 雑談掲示板）
  });
  filtered.sort((a,b)=> Number(a.gameNo) - Number(b.gameNo));
  const out = filtered.map((el) => {
    const n = Number(el.gameNo);
    const no = String(n).padStart(2, '0');
    return {
      id: `${FESTIVAL_ID}-${no}`,
      festivalId: FESTIVAL_ID,
      no,
      title: sanitize(el?.title) || `Work ${no}`,
      author: sanitize(el?.author) || "",
      category: sanitize(el?.genre),
      engine: sanitize(el?.tkool_other || el?.tkool),
      streaming: sanitize(el?.video_other || el?.video),
      authorComment: el?.comment_author || undefined,
    };
  });
  await fs.writeFile(OUTPUT_WORKS, JSON.stringify(out, null, 2), "utf8");
  console.log(`Wrote filled works: ${OUTPUT_WORKS}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
