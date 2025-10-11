import fs from "node:fs/promises";
import path from "node:path";

interface WorkEntry {
  id: string;
  festivalId: string;
  no?: string;
  hostComment?: string;
}

function stripExistingHostImgs(html: string): string {
  return html.replace(/<img[^>]+src=\"\/icons\/2020-kouhaku\/host-[^\"]+\"[^>]*>\s*/gi, "").trim();
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

    const no = w.no.padStart(2, "0");
    const icons: string[] = [];
    for (const f of files) {
      const m = f.match(new RegExp(`^host-${no}-(\\d{2})\\.[a-z0-9]+$`, "i"));
      if (m) icons.push(f);
    }
    icons.sort();
    if (icons.length === 0) continue;

    const original = w.hostComment ?? "";
    const textOnly = stripExistingHostImgs(original);

    // Split paragraphs by newline, ignore empty lines
    const paragraphs = textOnly.split(/\r?\n+/).map((p) => p.trim()).filter(Boolean);

    if (paragraphs.length === 0) {
      // No text, keep a single line with all icons
      w.hostComment = icons.map((f) => `<img src="/icons/2020-kouhaku/${f}" alt=""/>`).join(" ");
      updated += 1;
      continue;
    }

    const outLines: string[] = [];
    for (let i = 0; i < paragraphs.length; i++) {
      const iconFile = icons[Math.min(i, icons.length - 1)];
      outLines.push(`<img src="/icons/2020-kouhaku/${iconFile}" alt=""/> ${paragraphs[i]}`);
    }
    w.hostComment = outLines.join("\n");
    updated += 1;
  }

  if (updated > 0) {
    await fs.writeFile(worksPath, JSON.stringify(works, null, 2), "utf8");
  }

  console.log(`Rewrote ${updated} hostComment entries with per-paragraph icons.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

