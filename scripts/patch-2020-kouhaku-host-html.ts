import fs from "node:fs/promises";
import path from "node:path";

interface WorkEntry {
  id: string;
  festivalId: string;
  no?: string;
  hostComment?: string;
}

async function main() {
  const iconsDir = path.join(process.cwd(), "public", "icons", "2020-kouhaku");
  const worksPath = path.join(process.cwd(), "src", "data", "works", "2020-kouhaku.json");

  const [filesRaw, jsonRaw] = await Promise.all([
    fs.readdir(iconsDir).catch(() => [] as string[]),
    fs.readFile(worksPath, "utf8"),
  ]);

  const files = new Set<string>(filesRaw);
  const works: WorkEntry[] = JSON.parse(jsonRaw);

  let updated = 0;

  for (const w of works) {
    if (w.festivalId !== "2020-kouhaku" || !w.no) continue;
    // Skip if already HTML-embedded
    if (w.hostComment && /<img\s/i.test(w.hostComment)) continue;

    const no = w.no.padStart(2, "0");
    // Collect host images for this entry, sorted by index
    const matches: { file: string; order: number }[] = [];
    for (const f of files) {
      // host-<no>-<NN>.* (e.g., host-04-02.png)
      const m = f.match(new RegExp(`^host-${no}-(\\d{2})\\.[a-z0-9]+$`, "i"));
      if (m) {
        matches.push({ file: f, order: Number(m[1]) });
      }
    }
    matches.sort((a, b) => a.order - b.order);
    if (matches.length === 0) continue;

    const imgHtml = matches
      .map((m) => `<img src="/icons/2020-kouhaku/${m.file}" alt=""/>`)
      .join(" ");

    const text = (w.hostComment ?? "").trim();
    w.hostComment = text ? `${imgHtml} ${text}` : imgHtml;
    updated += 1;
  }

  if (updated > 0) {
    await fs.writeFile(worksPath, JSON.stringify(works, null, 2), "utf8");
  }

  console.log(`Updated ${updated} hostComment entries.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

