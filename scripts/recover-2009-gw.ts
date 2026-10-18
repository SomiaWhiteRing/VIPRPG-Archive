import fs from "node:fs/promises";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { WorkDownload, WorkEntry } from "../src/lib/types";

const festivalId = "2009-gw";
const root = `catch/${festivalId}`;
const sourceRoot = `${root}/source/original`;
const base = "https://vipgw2011.web.fc2.com/vip_2009gw/";
const workPath = `src/data/works/${festivalId}.json`;
const json = async <T>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, "utf8")) as T;
const writeJson = async (file: string, value: unknown) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

async function main() {
  const legacyPath = `${root}/legacy-works.json`;
  let oldWorks: WorkEntry[];
  try { oldWorks = await json<WorkEntry[]>(legacyPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    oldWorks = await json<WorkEntry[]>(workPath);
    await fs.copyFile(workPath, legacyPath);
  }
  const sourceBase = new URL(base);
  const indexUrl = new URL("index.html", sourceBase).href;
  const manifest = await json<Record<string, { originalUrl: string; file: string; status: number; contentType: string; bytes: number; sha256?: string }>>(`${sourceRoot}/manifest.json`);
  const indexAsset = manifest["index.html"];
  if (!indexAsset || indexAsset.status !== 200) throw new Error("Direct source index.html is missing from the capture manifest.");
  const $ = cheerio.load(iconv.decode(await fs.readFile(`${sourceRoot}/${indexAsset.file}`), "euc-jp"));
  const rows = $("tr").toArray().filter((row) => $(row).children("td,th").length === 3 && $(row).find("img[src]").length > 0);
  if (oldWorks.length !== 48 || rows.length !== oldWorks.length) throw new Error(`Source row mapping mismatch: works=${oldWorks.length}, sourceRows=${rows.length}.`);
  const orderedWorks = [...oldWorks].sort((a, b) => Number(a.no) - Number(b.no));
  if (orderedWorks.some((work, i) => work !== oldWorks[i])) throw new Error("Existing work order is not numeric; refusing to map rows by position.");

  const updated: WorkEntry[] = [];
  const entries: Array<{ no: string; sourceUrl: string; sourceRow: number; rowCellCount: number; downloadLinks: number; downloadHosts: string[]; authorTextMatchesExisting: boolean; sourceContentBytes: number }> = [];
  let downloadLinkCount = 0, oneDriveLinks = 0, boxLinks = 0, authorMatches = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const old = orderedWorks[index], no = String(old.no).padStart(3, "0"), sourceRow = $(rows[index]).clone();
    const downloads: WorkDownload[] = [];
    const downloadHosts = new Set<string>();
    for (const anchor of sourceRow.find("a[href]").toArray()) {
      let url: URL;
      try { url = new URL(sourceRow.find(anchor).attr("href")!, indexUrl); }
      catch { continue; }
      if (url.hostname === "onedrive.live.com" || url.hostname === "box.yahoo.co.jp") {
        const hostLabel = url.hostname === "onedrive.live.com" ? "OneDrive" : "Box";
        downloads.push({ url: url.href, label: `原站所列下载入口（${hostLabel}）` });
        downloadHosts.add(hostLabel);
        downloadLinkCount += 1;
        if (hostLabel === "OneDrive") oneDriveLinks += 1;
        else boxLinks += 1;
      }
    }
    sourceRow.find("form,script,style,noscript,iframe,object,embed").remove();
    sourceRow.find("*").each((_, element) => {
      for (const attribute of Object.keys(element.attribs ?? {})) if (attribute.toLowerCase().startsWith("on")) sourceRow.find(element).removeAttr(attribute);
    });
    sourceRow.find("img[src]").each((_, element) => {
      const image = sourceRow.find(element), url = new URL(image.attr("src")!, indexUrl), localPath = url.pathname.replace(/^\/vip_2009gw\//, "");
      image.attr({ src: `/original-pages/${festivalId}/${localPath}`, alt: "" }).removeAttr("srcset");
    });
    const cellAuthor = sourceRow.children("td,th").eq(2).text().replace(/\s+/g, " ").trim();
    const authorTextMatchesExisting = cellAuthor.normalize("NFKC").replace(/\s+/g, "") === old.author.normalize("NFKC").replace(/\s+/g, "");
    if (authorTextMatchesExisting) authorMatches += 1;
    const sourceContent = `<table class="archive-source-row" role="presentation"><tbody>${sourceRow.toString()}</tbody></table>`;
    const work: WorkEntry = { ...old, source: { ...(old.source ?? {}), url: indexUrl }, sourceContent };
    delete work.detailDisabled;
    if (downloads.length === 1) { work.download = downloads[0]; delete work.downloads; }
    else if (downloads.length > 1) { work.downloads = downloads; delete work.download; }
    if (work.contentRestricted !== old.contentRestricted) throw new Error(`Restriction marker changed for ${no}.`);
    updated.push(work);
    entries.push({ no, sourceUrl: indexUrl, sourceRow: index + 1, rowCellCount: sourceRow.children("td,th").length, downloadLinks: downloads.length, downloadHosts: [...downloadHosts], authorTextMatchesExisting, sourceContentBytes: Buffer.byteLength(sourceContent) });
  }

  const asset = manifest["f.png"];
  if (!asset || asset.status !== 200) throw new Error("The source row image f.png is missing from the capture manifest.");
  const festivalsPath = "src/data/festivals.json";
  const registry = await json<Array<{ id: string; banners: string[] }>>(festivalsPath);
  const festival = registry.find((item) => item.id === festivalId);
  if (!festival) throw new Error(`Festival registry entry ${festivalId} is missing.`);
  if (festival.banners.length !== 0) throw new Error("The source provides no banner images; refusing to replace existing banners.");
  const workBytes = Buffer.from(`${JSON.stringify(updated, null, 2)}\n`), workHandle = await fs.open(workPath, "r+");
  try { await workHandle.writeFile(workBytes); await workHandle.truncate(workBytes.length); } finally { await workHandle.close(); }

  const sourceManifest = await json<Record<string, { originalUrl: string; file: string; status: number; contentType: string; bytes: number; sha256?: string }>>(`${sourceRoot}/manifest.json`);
  const originalResources = Object.fromEntries(Object.entries(sourceManifest).map(([localPath, value]) => [value.originalUrl, localPath]));
  const recovery = await json<Record<string, unknown>>(`${root}/recovery.json`);
  recovery.originalResources = originalResources;
  recovery.entries = entries;
  recovery.sourcePages = ["index.html"];
  recovery.sourceDetailGaps = [];
  recovery.contentRestrictions = [];
  recovery.ignoredTrackingResources = [{ originalUrl: "https://media.fc2.com/counter_img.php", reason: "Remote visitor counter; omitted from local replay." }];
  recovery.dataCapture = { works: updated.length, sourceRows: rows.length, rowOrderMappedByExistingNumericWorkOrder: true, sourceAuthorsMatchedAutomatically: authorMatches, downloadLinksRecorded: downloadLinkCount, oneDriveLinks: oneDriveLinks, boxLinks, sourceContentRows: updated.filter((work) => work.sourceContent).length, manuallyAppliedRestrictions: 0, manualEntryContentReview: false };
  recovery.desktopReview = "pending";
  await writeJson(`${root}/recovery.json`, recovery);
  await writeJson(`${root}/source-comparison.json`, { festivalId, directSourceRootCaptured: true, sourceRows: rows.length, existingWorks: oldWorks.length, rowsMappedByNumericWorkOrder: rows.length === oldWorks.length, existingAuthorTextMatches: authorMatches, directDownloadLinksRecorded: downloadLinkCount, oneDriveLinks, boxLinks, sourceScreenshots: 0, sourceDetailPages: 0, sourceIndexEncodedAs: "EUC-JP", manualEntryContentReview: false, titleTextManuallyReviewed: false, restrictionChanges: 0, entries });
  console.log(JSON.stringify({ works: updated.length, sourceRows: rows.length, enabledDetails: updated.filter((work) => !work.detailDisabled).length, authorMatches, downloadLinks: downloadLinkCount, oneDriveLinks, boxLinks }, null, 2));
}

void main();
