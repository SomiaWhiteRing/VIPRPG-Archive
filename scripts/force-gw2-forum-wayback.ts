import fs from "node:fs/promises";
import path from "node:path";

async function main() {
  const file = path.join(process.cwd(), "src", "data", "works", "2018-gw-2.json");
  const arr = JSON.parse(await fs.readFile(file, "utf8")) as any[];
  let changed = 0;
  for (const w of arr) {
    const f = w.forum as string | undefined;
    if (!f) continue;
    try {
      const u = new URL(f);
      if (/^jbbs\.shitaraba\.net$/i.test(u.hostname) && /\/bbs\/read\.cgi\//i.test(u.pathname)) {
        const orig = `https://jbbs.shitaraba.net${u.pathname}`;
        const wb = `https://web.archive.org/web/2/${orig}`;
        if (w.forum !== wb) { w.forum = wb; changed += 1; }
      }
    } catch {}
  }
  if (changed > 0) await fs.writeFile(file, JSON.stringify(arr, null, 2), "utf8");
  console.log(`force-updated: ${changed}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

