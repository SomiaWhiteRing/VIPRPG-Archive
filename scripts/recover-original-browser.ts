import fs from "node:fs/promises";
import { configurations } from "./recover-original-views";
import { prepareOriginalBrowser, saveOriginalBrowserSources } from "./source-original-browser";

async function main() {
  const views = JSON.parse(await fs.readFile("src/data/original-views.json", "utf8"));
  const sources: Record<string, Record<string, string>> = {};
  let pagesUpdated = 0;
  const encodingRepairs: Record<string, string[]> = {};
  for (const id of Object.keys(views)) {
    const config = id === "2015-summer" ? { base: "http://viprpgsum15.webcrow.jp/" } : configurations[id];
    if (!config) throw new Error(`Missing original source configuration: ${id}`);
    const result = await prepareOriginalBrowser(id, config);
    sources[id] = result.sources;
    pagesUpdated += result.pagesUpdated;
    if (result.encodingRepairs.length) encodingRepairs[id] = result.encodingRepairs;
  }
  await saveOriginalBrowserSources(sources);
  if (Object.keys(encodingRepairs).length) {
    const reportPath = "catch/original-browser-encoding-repair.json";
    const changes = await fs.readFile(reportPath, "utf8").then((text) => JSON.parse(text).changes as Record<string, string[]>).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return {} as Record<string, string[]>;
    });
    for (const [id, files] of Object.entries(encodingRepairs)) changes[id] = [...new Set([...(changes[id] ?? []), ...files])];
    await fs.writeFile(reportPath, JSON.stringify({
      updatedAt: new Date().toISOString(), encoding: "UTF-8", changes,
      reason: "UTF-8 reading copies require an early HTML charset declaration when the static host sends text/html without a charset. Source caches are unchanged.",
    }, null, 2) + "\n");
  }
  console.log(JSON.stringify({ festivals: Object.keys(sources).length, pagesUpdated, encodingRepairs: Object.fromEntries(Object.entries(encodingRepairs).map(([id, files]) => [id, files.length])) }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
