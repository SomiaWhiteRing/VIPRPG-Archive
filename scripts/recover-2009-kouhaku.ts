import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { WorkEntry } from "../src/lib/types";

const festivalId = "2009-kouhaku";
const base = "http://vipkouhaku09.web.fc2.com/";
const root = `catch/${festivalId}`;
const listPath = "sakuhin_list2.htm";

async function main() {
  const works: WorkEntry[] = JSON.parse(await fs.readFile(`src/data/works/${festivalId}.json`, "utf8"));
  const original: WorkEntry[] = JSON.parse(await fs.readFile(`${root}/legacy-works.json`, "utf8"));
  const manifest: Record<string, { file: string; status: number; sha256: string }> = JSON.parse(await fs.readFile(`${root}/source/original/manifest.json`, "utf8"));
  const sourceBytes = await fs.readFile(`${root}/source/original/${listPath}.bin`);
  const $ = cheerio.load(iconv.decode(sourceBytes, "shift_jis"));
  const rows = $("tr").toArray().filter((row) => $(row).children("td").length === 3);
  if (works.length !== 89 || original.length !== 89 || rows.length !== 90) {
    throw new Error(`Unexpected source/data structure: ${works.length} works, ${original.length} baseline entries, ${rows.length} three-cell rows.`);
  }

  const byNo = new Map(works.map((work) => [String(work.no).padStart(3, "0"), work]));
  const originalByNo = new Map(original.map((work) => [String(work.no).padStart(3, "0"), work]));
  if (byNo.size !== works.length || originalByNo.size !== original.length) throw new Error("Duplicate work numbers detected.");

  const sourceIds = new Set<string>();
  const downloadIds = new Set<string>();
  const screenshotPaths = new Set<string>();
  let rowMappings = 0;
  let screenshotReferences = 0;
  let detailPages = 0;
  for (const [index, row] of rows.slice(1).entries()) {
    const no = String(index + 1).padStart(3, "0");
    const work = byNo.get(no);
    if (!work || !originalByNo.has(no)) throw new Error(`Source row ${index + 2} has no existing work number ${no}.`);
    const links = $(row).find("a[href]").toArray().map((anchor) => $(anchor).attr("href") ?? "");
    const observedIds = [...new Set(links.flatMap((href) => [...href.matchAll(/(?:vipkh09_|SS_)(\d{3})/gi)].map((match) => match[1])))];
    if (observedIds.some((id) => id !== no)) throw new Error(`Source row ${index + 2} does not match its numeric work position.`);
    if (observedIds.length) sourceIds.add(no);

    const screenshots = links
      .filter((href) => /^SS_\d{3}[^/]*\.(?:png|jpe?g|gif)$/i.test(path.posix.basename(new URL(href, base).pathname)))
      .map((href) => {
        const url = new URL(href, base);
        const sourcePath = decodeURIComponent(url.pathname.replace(/^\//, ""));
        const captured = manifest[sourcePath];
        if (!captured || captured.status !== 200 || !captured.sha256) throw new Error(`Source screenshot is not in the verified capture manifest: ${sourcePath}`);
        const publicPath = `/screenshots/${festivalId}/${path.posix.basename(sourcePath)}`;
        screenshotPaths.add(publicPath);
        return publicPath;
      });
    screenshotReferences += screenshots.length;
    if (screenshots.length) work.ss = screenshots;
    else delete work.ss;

    const sourceZip = links.find((href) => /(?:^|\/)vipkh09_\d{3}\.zip(?:$|[?#])/i.test(href));
    if (Boolean(sourceZip) !== Boolean(work.download)) throw new Error(`Source/download presence differs for numeric work ${no}.`);
    if (sourceZip && work.download) {
      const direct = new URL(sourceZip, base);
      const existing = new URL(work.download.url);
      if (direct.pathname.toLowerCase() !== existing.pathname.toLowerCase()) throw new Error(`Source/download archive path differs for numeric work ${no}.`);
      work.download = { ...work.download, url: direct.href };
      downloadIds.add(no);
    }

    const detailPath = `sakuhin_${no}.htm`;
    if (manifest[detailPath]?.status === 200) {
      work.source = { ...work.source, url: new URL(detailPath, base).href };
      detailPages++;
    } else {
      work.source = { ...work.source, url: new URL(listPath, base).href };
    }
    rowMappings++;
  }

  if (rowMappings !== 89 || detailPages !== 88 || screenshotReferences !== 87 || downloadIds.size !== 71) {
    throw new Error(`Unexpected source coverage: rows=${rowMappings}, details=${detailPages}, screenshots=${screenshotReferences}, downloads=${downloadIds.size}.`);
  }
  if ([...sourceIds].some((no) => !byNo.has(no))) throw new Error("A source row references a work outside the existing catalogue.");
  if (works.some((work, index) => JSON.stringify({ title: work.title, author: work.author, authorComment: work.authorComment, hostComment: work.hostComment, contentRestricted: work.contentRestricted }) !== JSON.stringify({ title: original[index].title, author: original[index].author, authorComment: original[index].authorComment, hostComment: original[index].hostComment, contentRestricted: original[index].contentRestricted }))) {
    throw new Error("Recovery changed existing entry text or restriction fields.");
  }
  for (const screenshot of screenshotPaths) await fs.access(`public${screenshot}`);

  await fs.writeFile(`src/data/works/${festivalId}.json`, `${JSON.stringify(works, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ festivalId, works: works.length, mappedSourceRows: rowMappings, directDetailPages: detailPages, sourceRowsWithoutDetailPage: 1, screenshots: screenshotReferences, directDownloadLinks: downloadIds.size, titlesOrCommentsChanged: false, restrictionsApplied: 0 }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
