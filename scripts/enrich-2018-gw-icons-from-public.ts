import fs from "node:fs/promises";
import path from "node:path";

interface WorkEntry { id: string; no: string; icon?: string }

async function fileExists(p: string) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function run() {
  const WORKS = path.join(process.cwd(), "src", "data", "works", "2018-gw.json");
  const ICON_DIR = path.join(process.cwd(), "public", "icons", "2018-gw");
  const raw = await fs.readFile(WORKS, "utf8");
  const arr = JSON.parse(raw) as WorkEntry[];
  for (const w of arr) {
    if (w.icon) continue;
    const num = w.no.padStart(2, "0");
    const candidates = [`.png`, `.jpg`, `.gif`, `.jpeg`];
    for (const ext of candidates) {
      const file = path.join(ICON_DIR, `${num}${ext}`);
      if (await fileExists(file)) {
        w.icon = path.posix.join("/icons/2018-gw", `${num}${ext}`);
        break;
      }
    }
  }
  await fs.writeFile(WORKS, JSON.stringify(arr, null, 2), "utf8");
  console.log("Filled missing icon fields from public/icons/2018-gw");
}

run().catch((e) => { console.error(e); process.exit(1); });

