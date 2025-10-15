import fs from "node:fs/promises";
import path from "node:path";

interface WorkEntry {
  id: string;
  festivalId: string;
  no: string;
  title: string;
  author: string;
  category?: string;
  engine?: string;
  streaming?: string;
  forum?: string;
  authorComment?: string;
  hostComment?: string;
  icon?: string;
  ss?: string[];
}

async function run() {
  const WORKS = path.join(process.cwd(), "src", "data", "works", "2018-gw.json");
  const BACKUP = path.join(process.cwd(), "catch", "2018-gw-generated.json");
  const nowRaw = await fs.readFile(WORKS, "utf8");
  const oldRaw = await fs.readFile(BACKUP, "utf8").catch(() => "");
  if (!oldRaw) {
    console.error("Backup catch/2018-gw-generated.json not found; aborting merge.");
    process.exit(1);
  }
  const now = JSON.parse(nowRaw) as WorkEntry[];
  const old = JSON.parse(oldRaw) as WorkEntry[];
  const oldById = new Map(old.map((w) => [w.id, w] as const));
  for (const w of now) {
    const prev = oldById.get(w.id);
    if (!prev) continue;
    if (!w.icon && prev.icon) w.icon = prev.icon;
    if ((!w.ss || w.ss.length === 0) && prev.ss && prev.ss.length > 0) w.ss = prev.ss;
    if (!w.authorComment && prev.authorComment) w.authorComment = prev.authorComment;
    if (!w.hostComment && prev.hostComment) w.hostComment = prev.hostComment;
  }
  await fs.writeFile(WORKS, JSON.stringify(now, null, 2), "utf8");
  console.log(`Merged backup fields into ${WORKS}`);
}

run().catch((err) => { console.error(err); process.exit(1); });

