import fs from "node:fs/promises";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { WorkEntry } from "../src/lib/types";

const festivalId = "2009-silver-week-miruge-festival";
const base = "https://vipkohaku.x.fc2.com/2009miru/";
const snapshot = "https://web.archive.org/web/20230611012209/https://vipkohaku.x.fc2.com/2009miru/index.html";
const root = `catch/${festivalId}`;

async function main() {
  const works: WorkEntry[] = JSON.parse(await fs.readFile(`src/data/works/${festivalId}.json`, "utf8"));
  const original: WorkEntry[] = JSON.parse(await fs.readFile(`${root}/legacy-works.json`, "utf8"));
  const manifest: Record<string, { file: string; status: number; sha256: string }> = JSON.parse(await fs.readFile(`${root}/source/archive/manifest.json`, "utf8"));
  const sourceBytes = await fs.readFile(`${root}/source/archive/index.html.bin`);
  const $ = cheerio.load(iconv.decode(sourceBytes, "shift_jis"));
  const workTables = $("table").toArray().filter((table) => $(table).parents("table").length === 1 && $(table).find("tr").length === 3);
  if (works.length !== 32 || original.length !== 32 || workTables.length !== 32) {
    throw new Error(`Unexpected source/data structure: ${works.length} works, ${original.length} baseline entries, ${workTables.length} work tables.`);
  }

  const byNo = new Map(works.map((work) => [String(work.no).padStart(3, "0"), work]));
  const originalByNo = new Map(original.map((work) => [String(work.no).padStart(3, "0"), work]));
  if (byNo.size !== works.length || originalByNo.size !== original.length) throw new Error("Duplicate work numbers detected.");

  const uniqueSourceImages = new Set<string>();
  const uniqueCapturedImages = new Set<string>();
  let screenshotReferences = 0;
  let availableScreenshotReferences = 0;
  for (const [index, table] of workTables.entries()) {
    const no = String(index + 1).padStart(3, "0");
    const work = byNo.get(no);
    if (!work || !originalByNo.has(no)) throw new Error(`Source table ${index + 1} does not map to existing work ${no}.`);
    const images = $(table).find("img[src]").toArray();
    if (images.length > 1) throw new Error(`Source table ${index + 1} has an unexpected image count.`);
    const screenshots: string[] = [];
    for (const image of images) {
      const url = new URL($(image).attr("src") ?? "", base);
      if (url.hostname !== new URL(base).hostname || !/^\/2009miru\/img\/\d{3}\.png$/i.test(url.pathname)) continue;
      const sourcePath = url.pathname.replace(/^\/2009miru\//, "");
      uniqueSourceImages.add(sourcePath);
      screenshotReferences++;
      const captured = manifest[sourcePath];
      if (!captured || captured.status !== 200 || !captured.sha256) continue;
      const publicPath = `/screenshots/${festivalId}/${sourcePath}`;
      await fs.access(`public${publicPath}`);
      screenshots.push(publicPath);
      uniqueCapturedImages.add(sourcePath);
      availableScreenshotReferences++;
    }
    if (screenshots.length) work.ss = screenshots;
    else delete work.ss;
    work.source = { ...work.source, url: new URL("index.html", base).href, snapshotUrl: snapshot };
  }

  if (screenshotReferences !== 31 || uniqueSourceImages.size !== 30 || uniqueCapturedImages.size !== 14 || availableScreenshotReferences !== 15) {
    throw new Error(`Unexpected source image mapping: refs=${screenshotReferences}, sourceUrls=${uniqueSourceImages.size}, archivedFiles=${uniqueCapturedImages.size}, attachedRefs=${availableScreenshotReferences}.`);
  }
  if (Object.keys(manifest).length !== 16 || manifest["index.html"]?.status !== 200 || !manifest["index.html"].sha256) {
    throw new Error("The archived page, stylesheet or image captures are missing from the source manifest.");
  }
  if (works.some((work, index) => JSON.stringify({ title: work.title, author: work.author, authorComment: work.authorComment, hostComment: work.hostComment, download: work.download, downloads: work.downloads, sourceContent: work.sourceContent, contentRestricted: work.contentRestricted }) !== JSON.stringify({ title: original[index].title, author: original[index].author, authorComment: original[index].authorComment, hostComment: original[index].hostComment, download: original[index].download, downloads: original[index].downloads, sourceContent: original[index].sourceContent, contentRestricted: original[index].contentRestricted }))) {
    throw new Error("Recovery changed existing entry text, downloads or restriction fields.");
  }

  await fs.writeFile(`src/data/works/${festivalId}.json`, `${JSON.stringify(works, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ festivalId, works: works.length, sourceTables: workTables.length, sourceUrlsAdded: works.filter((work) => Boolean(work.source?.url)).length, screenshotReferences, screenshotFiles: uniqueCapturedImages.size, missingScreenshotUrls: uniqueSourceImages.size - uniqueCapturedImages.size, sourceRowsWithoutImage: works.length - screenshotReferences, downloadsChanged: 0, entryTextChanged: false, restrictionsApplied: 0 }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
