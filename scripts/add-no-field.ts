import fs from "node:fs/promises";
import path from "node:path";

async function updateFile(filePath: string) {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    console.warn(`skip: ${filePath} not found`);
    return;
  }
  const works = JSON.parse(raw) as Array<Record<string, unknown>>;
  let changed = false;
  for (const work of works) {
    if ((work as any).no) continue;
    const id = String((work as any).id || "");
    const m = id.match(/-work-([0-9a-zA-Z-]+)$/);
    if (m) {
      (work as any).no = m[1];
      changed = true;
    }
  }
  if (changed) {
    await fs.writeFile(filePath, JSON.stringify(works, null, 2) + "\n", "utf8");
    console.log(`updated: ${path.basename(filePath)}`);
  } else {
    console.log(`no change: ${path.basename(filePath)}`);
  }
}

async function main() {
  const dir = path.join(process.cwd(), "src", "data", "works");
  const files = await fs.readdir(dir);
  const targets = files.filter((f) => f.endsWith(".json"));
  for (const file of targets) {
    await updateFile(path.join(dir, file));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
