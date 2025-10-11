import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function run() {
  const dir = path.join(process.cwd(), "catch", "2019-summer");
  const file = path.join(dir, "game-39-outer.html");
  const outer = await fs.readFile(file, "utf8");
  const key = '\\"userHtml\\":\\"';
  const i = outer.indexOf(key);
  console.log("key index:", i);
  const pattern = /\"userHtml\":\"([\s\S]*?)\"/;
  const m = outer.match(pattern);
  console.log("regex matched:", !!m, m && m[1]?.slice(0, 120));
}

run().catch((e) => { console.error(e); process.exit(1); });

