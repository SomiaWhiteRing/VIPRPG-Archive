import fs from "node:fs/promises";
import path from "node:path";

type Work = {
  id: string;
  festivalId: string;
  no: string;
  title: string;
  author?: string;
  category?: string;
  engine?: string;
  streaming?: string;
  authorComment?: string;
  hostComment?: string;
  icon?: string;
  ss?: string[];
  detailDisabled?: boolean;
};

async function run() {
  const worksPath = path.join(process.cwd(), "src", "data", "works", "2022-kouhaku.json");
  const raw = await fs.readFile(worksPath, "utf8");
  const works: Work[] = JSON.parse(raw);

  let patched = 0;
  for (const w of works) {
    const missing = !w.author || !w.engine || !w.category || !w.streaming || !w.authorComment;
    if (missing) {
      if (w.detailDisabled !== true) {
        w.detailDisabled = true;
        patched++;
      }
    }
  }

  await fs.writeFile(worksPath, JSON.stringify(works, null, 2), "utf8");
  console.log(`Marked detailDisabled for ${patched} works.`);
}

run().catch((err) => { console.error(err); process.exitCode = 1; });

