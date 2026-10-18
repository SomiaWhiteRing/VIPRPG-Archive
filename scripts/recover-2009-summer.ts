import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { WorkEntry } from "../src/lib/types";

const id = "2009-summer";
const catchRoot = path.join("catch", id);
const sourceBase = "https://vipkohaku.x.fc2.com/2009s/";
const originalIndex = path.join(catchRoot, "source", "archive", "index-20211203045641.bin");
const originalPages = path.join("public", "original-pages", id);
const screenshotRoot = path.join("public", "screenshots", id);
const worksPath = path.join("src", "data", "works", `${id}.json`);

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as T;
}

function sourceRelative(url: string): string | undefined {
  const target = new URL(url);
  const base = new URL(sourceBase);
  if (target.hostname !== base.hostname || !target.pathname.startsWith(base.pathname)) return undefined;
  return `${target.pathname.slice(base.pathname.length)}${target.search}`;
}

function verifyImage(file: string): void {
  const bytes = fs.readFileSync(file);
  const extension = path.extname(file).toLowerCase();
  const valid = extension === ".png"
    ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : extension === ".gif"
      ? bytes.subarray(0, 3).toString("ascii") === "GIF"
      : extension === ".jpg" || extension === ".jpeg"
        ? bytes[0] === 0xff && bytes[1] === 0xd8
        : false;
  if (!valid) throw new Error(`Image format does not match its source extension: ${file}`);
}

function copyImage(source: string, destination: string): void {
  verifyImage(source);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

const $ = cheerio.load(iconv.decode(fs.readFileSync(originalIndex), "shift_jis"), { decodeEntities: false });
const blocks = $("div.sakuhin").toArray().map((element) => {
  const block = $(element);
  const detailUrl = block.find("a[href]").map((_, anchor) => new URL($(anchor).attr("href")!, sourceBase).href).get()
    .find((url) => /\/sakuhin\/sakuhin_\d+\.html$/i.test(new URL(url).pathname));
  const match = detailUrl?.match(/sakuhin_(\d+)\.html$/i);
  const no = match ? String(Number(match[1])).padStart(3, "0") : "000";
  const screenshotUrl = block.find("img[src]").first().attr("src");
  if (!detailUrl || !screenshotUrl) throw new Error("A catalogue block is missing its source page or preview image.");
  return { no, detailUrl, screenshotUrl: new URL(screenshotUrl, sourceBase).href };
});

if (blocks.length !== 100 || blocks.filter((block) => block.no !== "000").length !== 99 || blocks.filter((block) => block.no === "000").length !== 1) {
  throw new Error(`Unexpected catalogue structure: ${blocks.length} blocks.`);
}

const timemap = readJson<string[][]>(path.join(catchRoot, "investigation", "original-timemap.bin"));
const captures = new Map<string, string[]>();
for (const row of timemap.slice(1)) {
  const local = sourceRelative(row[0]);
  if (local) captures.set(local, row);
}
const catalogue = readJson<WorkEntry[]>(worksPath);
if (catalogue.length !== 99 || new Set(catalogue.map((work) => work.no)).size !== 99) {
  throw new Error(`Unexpected registered work count: ${catalogue.length}.`);
}

const blockByNo = new Map(blocks.filter((block) => block.no !== "000").map((block) => [block.no, block]));
const updated = catalogue.map((work) => {
  const no = String(Number(work.no)).padStart(3, "0");
  const block = blockByNo.get(no);
  if (!block) throw new Error(`No source row is mapped to work number ${no}.`);
  const detailPath = sourceRelative(block.detailUrl)!;
  const capture = captures.get(detailPath);
  if (!capture || capture[4] !== "200") throw new Error(`No successful archived detail capture for work number ${no}.`);
  const timestamp = capture[2] || capture[1];
  const snapshotUrl = `https://web.archive.org/web/${timestamp}/${capture[0]}`;
  const thumbnailRelative = sourceRelative(block.screenshotUrl)!;
  const thumbnailSource = path.join(originalPages, ...thumbnailRelative.split("/"));
  if (!fs.existsSync(thumbnailSource)) throw new Error(`Archived catalogue preview is missing for work number ${no}.`);
  const thumbnailPath = `/${path.posix.join("screenshots", id, "sss", path.posix.basename(thumbnailRelative))}`;
  const screenshotPaths = [thumbnailPath];
  copyImage(thumbnailSource, path.join(screenshotRoot, "sss", path.basename(thumbnailRelative)));

  const detailFile = path.join(originalPages, "sakuhin", `sakuhin_${Number(no)}.html`);
  if (!fs.existsSync(detailFile)) throw new Error(`Archived detail file is missing for work number ${no}.`);
  const detail = cheerio.load(fs.readFileSync(detailFile, "utf8"), { decodeEntities: false });
  const fullScreens = new Set<string>();
  detail("img[src]").each((_, image) => {
    const url = new URL(detail(image).attr("src")!, new URL(`sakuhin/sakuhin_${Number(no)}.html`, sourceBase));
    if (!url.pathname.includes("/sakuhin/ss/")) return;
    const relative = url.pathname.slice(new URL(sourceBase).pathname.length);
    const source = path.join(originalPages, ...relative.split("/"));
    if (fs.existsSync(source)) fullScreens.add(relative);
  });
  for (const relative of [...fullScreens].sort()) {
    const source = path.join(originalPages, ...relative.split("/"));
    const filename = path.basename(relative);
    copyImage(source, path.join(screenshotRoot, "ss", filename));
    screenshotPaths.push(`/${path.posix.join("screenshots", id, "ss", filename)}`);
  }

  const existingScreens = work.ss ?? [];
  const ss = [...existingScreens];
  for (const screenshot of screenshotPaths) if (!ss.includes(screenshot)) ss.push(screenshot);
  if (work.source && work.source.url !== block.detailUrl) throw new Error(`Existing source URL differs for work number ${no}.`);
  return {
    ...work,
    source: { ...(work.source ?? {}), url: block.detailUrl, snapshotUrl },
    ss,
  };
});

const dataBytes = Buffer.from(`${JSON.stringify(updated, null, 2)}\n`);
fs.writeFileSync(worksPath, dataBytes);

const directAttempts = readJson<unknown[]>(path.join(catchRoot, "investigation", "direct-attempts.json"));
const directAssets = readJson<Array<{ retrieved: boolean }>>(path.join(catchRoot, "investigation", "direct-source-assets.json"));
const archiveManifest = readJson<Record<string, unknown>>(path.join(catchRoot, "source", "archive", "manifest.json"));
const cachedManifest = readJson<Record<string, unknown>>(path.join(catchRoot, "source", "original-view", "manifest.json"));
const originalView = readJson<{ files: string[]; missingResources: Array<{ url: string }> }>(path.join(catchRoot, "original-view.json"));
const missingGroups = originalView.missingResources.reduce<Record<string, number>>((counts, item) => {
  const pathname = new URL(item.url).pathname;
  const key = pathname.includes("/sakuhin/ss/") ? "fullSizeScreenshots" : pathname.toLowerCase().endsWith(".css") ? "stylesheets" : "otherImages";
  counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}, {});
const screenshotReferences = updated.reduce((count, work) => count + (work.ss?.length ?? 0), 0);
const screenshotFiles = fs.readdirSync(path.join(screenshotRoot, "sss")).length + fs.readdirSync(path.join(screenshotRoot, "ss")).length;
const recovery = {
  festivalId: id,
  status: "recovered-with-documented-source-gaps",
  archiveOnly: true,
  sourceContentReviewed: false,
  sourceImagesViewed: false,
  sourceUrl: "https://vipkohaku.x.fc2.com/2009s/index.html",
  sourceEncoding: "Shift_JIS",
  primarySource: {
    originalUrl: "https://vipkohaku.x.fc2.com/2009s/index.html",
    snapshotUrl: "https://web.archive.org/web/20211203045641/https://vipkohaku.x.fc2.com/2009s/index.html",
    timestamp: "20211203045641",
    sha256: "cebbc367048fb6f1c6d65719b937738e972ccd7a3c3bc1a7518f5a8f584f2f3a",
    cdxDigestVerified: true,
    proxyRegion: "Hong Kong",
    exitCountry: "HK",
  },
  directSourceAttempts: { pageRequests: directAttempts.length, assetRequests: directAssets.length, successfulAssets: directAssets.filter((item) => item.retrieved).length, proxyNode: "🇯🇵 日本S01 | IEPL", exitCountry: "JP" },
  catalogue: { sourceBlocks: blocks.length, registeredWorks: updated.length, sampleNo000RetainedInOriginalPage: true, sampleNo000AddedToStructuredWorks: false, detailPagesCaptured: 99, sourceUrls: updated.filter((work) => work.source?.url).length },
  screenshots: { thumbnailFiles: updated.length, capturedFullSizeFiles: screenshotFiles - updated.length, fullSizeReferencesMissingForWorks: missingGroups.fullSizeScreenshots - 1, sampleFullSizeScreenshotMissing: true, files: screenshotFiles, references: screenshotReferences },
  originalView: { files: originalView.files.length, cachedResources: Object.keys(cachedManifest).length, archiveSeedResources: Object.keys(archiveManifest).length, missingResources: originalView.missingResources.length, missingGroups },
  sourceDetailGaps: [],
  contentRestrictions: [],
  notes: "Preserved the source list and all captured detail pages without reviewing entry text or images. Five of 100 full-size detail images have archived captures; 94 registered works and the No.000 sample have no usable full-size image capture. The uncaptured stylesheet, background image, and visitor counter are documented; no source-side content or new restriction flags were added.",
};
fs.writeFileSync(path.join(catchRoot, "recovery.json"), `${JSON.stringify(recovery, null, 2)}\n`);

function urlsFor(block: typeof blocks[number]): { download: string[]; forum: string | null } {
  const $block = blocks.length ? $("div.sakuhin").eq(blocks.indexOf(block)) : cheerio.load("")("body");
  const links = $block.find("a[href]").map((_, anchor) => new URL($(anchor).attr("href")!, sourceBase).href).get();
  return {
    download: links.filter((url) => new URL(url).hostname !== "vipkohaku.x.fc2.com" && new URL(url).hostname !== "yy701.60.kg" && !/\.(?:s?html?|cgi|php)$/i.test(new URL(url).pathname)),
    forum: links.find((url) => new URL(url).hostname === "yy701.60.kg") ?? null,
  };
}
const comparisons = updated.map((work) => {
  const no = String(Number(work.no)).padStart(3, "0"), block = blockByNo.get(no)!;
  const links = urlsFor(block);
  return { no, sourceDownloads: links.download, sourceForum: links.forum, existingDownload: work.download?.url ?? null, existingForum: work.forum ?? null };
});
const sourceComparison = {
  festivalId: id,
  catalogueBlocks: blocks.length,
  registeredWorks: updated.length,
  sampleNo000BlocksExcluded: blocks.filter((block) => block.no === "000").length,
  detailPagesCaptured: 99,
  sourceUrlFields: updated.filter((work) => work.source?.url).length,
  screenshotFiles,
  screenshotReferences,
  downloads: { existingFields: updated.filter((work) => work.download?.url).length, exactSourceMatches: comparisons.filter((item) => item.existingDownload && item.sourceDownloads.includes(item.existingDownload)).length, sourceRowsWithDownloadUrl: comparisons.filter((item) => item.sourceDownloads.length).length },
  forumLinks: { existingFields: updated.filter((work) => work.forum).length, exactSourceMatches: comparisons.filter((item) => item.existingForum && item.existingForum === item.sourceForum).length, sourceRowsWithForumUrl: comparisons.filter((item) => item.sourceForum).length },
  textAndRestrictionFieldsReviewed: false,
};
fs.writeFileSync(path.join(catchRoot, "source-comparison.json"), `${JSON.stringify(sourceComparison, null, 2)}\n`);
console.log(JSON.stringify({ works: updated.length, sourceUrls: recovery.catalogue.sourceUrls, screenshotFiles, screenshotReferences, capturedFullSizeFiles: recovery.screenshots.capturedFullSizeFiles, missingResources: originalView.missingResources.length, missingGroups, downloadMatches: sourceComparison.downloads.exactSourceMatches, forumMatches: sourceComparison.forumLinks.exactSourceMatches }));
