import fs from "node:fs/promises";
import path from "node:path";

function normalizeTitle(s?: string) {
  return (s ?? "").toLowerCase().replace(/\s+/g, "").trim();
}

async function main() {
  const worksPath = path.join(process.cwd(), "src", "data", "works", "2025-summer.json");
  const raw = await fs.readFile(worksPath, "utf8");
  const works = JSON.parse(raw) as any[];

  const numbered = works.filter((w) => typeof w.no === "string" && w.no.length > 0);
  const unnumbered = works.filter((w) => !w.no);

  const byTitle = new Map<string, any>();
  for (const w of numbered) {
    byTitle.set(normalizeTitle(w.title), w);
  }

  let merged = 0;
  for (const u of unnumbered) {
    const key = normalizeTitle(u.title);
    const target = byTitle.get(key);
    if (!target) continue;
    if ((!target.ss || target.ss.length === 0) && Array.isArray(u.ss) && u.ss.length > 0) {
      target.ss = u.ss;
    }
    if (!target.authorComment && u.authorComment) {
      target.authorComment = u.authorComment;
    }
    if (!target.icon && u.icon) {
      target.icon = u.icon;
    }
    // Mark to remove
    u.__remove = true;
    merged += 1;
  }

  const result = works.filter((w) => !w.__remove);
  await fs.writeFile(worksPath, JSON.stringify(result, null, 2) + "\n", "utf8");
  console.log(`Merged ${merged} unnumbered entries into numbered ones. Total now: ${result.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

