import fs from "node:fs/promises";
import path from "node:path";

const CATCH_DIR = path.join(process.cwd(), "catch", "2019-summer");

async function readInner() {
  const html = await fs.readFile(path.join(CATCH_DIR, "game-39.html"), "utf8");
  return html;
}

function decode(html: string) {
  const m = html.match(/globalDataes\s*=\s*JSON\.parse\((['"])([\s\S]*?)\1\)/);
  if (!m) throw new Error("no globalDataes");
  const quote = m[1];
  const body = m[2];
  const jsonText = (new Function(`return ${quote}${body}${quote};`))() as string;
  const cleaned = jsonText.replace(/\\(?!["\\\/bfnrtu])/g, "");
  const arr = JSON.parse(cleaned) as Array<Record<string, string>>;
  return arr;
}

(async () => {
  const arr = decode(await readInner());
  const gameNos = new Set(arr.map(e => Number(e.gameNo)));
  const max = Math.max(...[...gameNos]);
  const missing: number[] = [];
  for (let i = 1; i <= 80; i++) if (!gameNos.has(i)) missing.push(i);
  console.log('total entries:', arr.length, 'max gameNo:', max);
  console.log('missing gameNos 1..80:', missing.join(','));
})();

