import fs from "node:fs/promises";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { WorkEntry } from "../src/lib/types";

const festivalId = "2009-ksgfestival";
const base = "https://vipkohaku.x.fc2.com/2009ksg/";
const listSnapshot = "https://web.archive.org/web/20230206095914/https://vipkohaku.x.fc2.com/2009ksg/";
const root = `catch/${festivalId}`;

async function main() {
  const works: WorkEntry[] = JSON.parse(await fs.readFile(`src/data/works/${festivalId}.json`, "utf8"));
  const original: WorkEntry[] = JSON.parse(await fs.readFile(`${root}/legacy-works.json`, "utf8"));
  const manifest: Record<string, { status: number; sha256: string }> = JSON.parse(await fs.readFile(`${root}/source/archive/manifest.json`, "utf8"));
  const sourceBytes = await fs.readFile(`${root}/source/archive/index.html.bin`);
  const $ = cheerio.load(iconv.decode(sourceBytes, "euc-jp"));
  const rows = $("tr").toArray().filter((row) => $(row).children("td,th").length === 3);
  if (works.length !== 30 || original.length !== 30 || rows.length !== 31) {
    throw new Error(`Unexpected source/data structure: ${works.length} works, ${original.length} baseline entries, ${rows.length} three-cell rows.`);
  }

  const byNo = new Map(works.map((work) => [String(work.no).padStart(3, "0"), work]));
  const originalByNo = new Map(original.map((work) => [String(work.no).padStart(3, "0"), work]));
  if (byNo.size !== works.length || originalByNo.size !== original.length) throw new Error("Duplicate work numbers detected.");

  let mappedRows = 0;
  let detailLinks = 0;
  let sourceDownloadLinks = 0;
  let existingDownloadPathMatches = 0;
  for (const [index, row] of rows.slice(1).entries()) {
    const no = String(index + 1).padStart(3, "0");
    const pageNo = index + 1;
    const work = byNo.get(no);
    if (!work || !originalByNo.has(no) || work.detailDisabled !== true) {
      throw new Error(`Source row ${index + 2} does not map to an existing disabled work ${no}.`);
    }

    const rowNode = $(row).clone();
    const links = rowNode.find("a[href]").toArray();
    const rowDetailUrls: string[] = [];
    for (const anchor of links) {
      const node = $(anchor), href = node.attr("href") ?? "";
      const absolute = new URL(href, base);
      const detail = absolute.pathname.match(/\/sakuhin\/ksg(\d+)\.html$/i);
      if (detail) {
        const linkedNo = Number(detail[1]);
        if (linkedNo !== pageNo) throw new Error(`Source row ${index + 2} links to a different numeric detail slot.`);
        detailLinks++;
        rowDetailUrls.push(absolute.href);
        node.attr("href", `/original-pages/${festivalId}/sakuhin/ksg${pageNo}.html`);
        continue;
      }
      if (/\.zip(?:$|[?#])/i.test(absolute.pathname)) {
        sourceDownloadLinks++;
        if (work.download && new URL(work.download.url).pathname.toLowerCase() === absolute.pathname.toLowerCase()) existingDownloadPathMatches++;
      }
      if (!/^(?:#|javascript:|mailto:|data:)/i.test(href)) node.attr("href", absolute.href);
    }
    if (rowDetailUrls.length !== 1) throw new Error(`Source row ${index + 2} is missing its individual detail link.`);

    work.source = { ...work.source, url: rowDetailUrls[0], snapshotUrl: listSnapshot };
    work.sourceContent = `<table class="archive-source-row" role="presentation"><tbody>${$.html(rowNode)}</tbody></table>`;
    delete work.detailDisabled;
    mappedRows++;
  }

  if (mappedRows !== 30 || detailLinks !== 30 || sourceDownloadLinks !== 8 || existingDownloadPathMatches !== 8) {
    throw new Error(`Unexpected source coverage: rows=${mappedRows}, details=${detailLinks}, sourceDownloads=${sourceDownloadLinks}, matchingExistingDownloadPaths=${existingDownloadPathMatches}.`);
  }
  if (Object.keys(manifest).length !== 1 || manifest["index.html"]?.status !== 200 || !manifest["index.html"].sha256) {
    throw new Error("The archived source-list capture is missing from its manifest.");
  }
  if (works.some((work, index) => JSON.stringify({ title: work.title, author: work.author, authorComment: work.authorComment, hostComment: work.hostComment, download: work.download, downloads: work.downloads, ss: work.ss, contentRestricted: work.contentRestricted }) !== JSON.stringify({ title: original[index].title, author: original[index].author, authorComment: original[index].authorComment, hostComment: original[index].hostComment, download: original[index].download, downloads: original[index].downloads, ss: original[index].ss, contentRestricted: original[index].contentRestricted }))) {
    throw new Error("Recovery changed existing structured fields or restriction markers.");
  }

  await fs.writeFile(`src/data/works/${festivalId}.json`, `${JSON.stringify(works, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ festivalId, works: works.length, mappedSourceRows: mappedRows, originalDetailLinks: detailLinks, sourceDownloadLinks, existingDownloadUrlsChanged: 0, detailsEnabled: works.filter((work) => !work.detailDisabled).length, sourceRowsSaved: works.filter((work) => Boolean(work.sourceContent)).length, screenshots: 0, restrictionsApplied: 0, entryTextChanged: false }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
