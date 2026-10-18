import fs from "node:fs";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { WorkEntry } from "../src/lib/types";

const id = "2008-chuuni-festival";
const root = `catch/${id}`;
const original = "https://vipkohaku.x.fc2.com/2008chu/index.html";
const base = "https://vipkohaku.x.fc2.com/2008chu/";
const dataPath = `src/data/works/${id}.json`;
const primaryFile = `${root}/source/archive/index-20190518093109.bin`;
const inventory = JSON.parse(fs.readFileSync(`${root}/investigation/structural-inventory.json`, "utf8")) as {
  captures: Array<{
    file: string;
    timestamp: string;
    originalUrl: string;
    rows: Array<{ no: string | null; detailUrl: string | null; externalLinks: string[] }>;
  }>;
};
const primary = inventory.captures.find((capture) => capture.file === "index-20190518093109.bin");
const alternate = inventory.captures.find((capture) => capture.file === "directory-20230206095914.bin");
if (!primary || !alternate) throw new Error("Expected both archived directory captures.");

const $ = cheerio.load(iconv.decode(fs.readFileSync(primaryFile), "shift_jis"), { decodeEntities: false });
const sourceRows = $("table").eq(3).find("tr").toArray().map((row) => {
  const links = $(row).find("a[href]").map((_, anchor) => new URL($(anchor).attr("href")!, base).href).get();
  const detailUrl = links.find((url) => /\/entry\/\d+\.html$/i.test(new URL(url).pathname));
  const match = detailUrl?.match(/entry\/(\d+)\.html$/i);
  return {
    no: match ? String(Number(match[1])).padStart(3, "0") : null,
    detailUrl: detailUrl ?? null,
    downloadUrls: links.filter((url) => new URL(url).hostname === "box.yahoo.co.jp"),
  };
});
if (sourceRows.length !== 24 || sourceRows.some((row) => !row.no || !row.detailUrl) || new Set(sourceRows.map((row) => row.no)).size !== 24) {
  throw new Error("Unexpected source catalogue row mapping.");
}

const catalogue = JSON.parse(fs.readFileSync(dataPath, "utf8")) as WorkEntry[];
if (catalogue.length !== 24 || new Set(catalogue.map((work) => work.no)).size !== 24) {
  throw new Error(`Unexpected registered work count: ${catalogue.length}.`);
}
const sourceByNo = new Map(sourceRows.map((row) => [row.no!, row]));
const updated = catalogue.map((work) => {
  const row = sourceByNo.get(work.no ?? "");
  if (!row?.detailUrl) throw new Error(`Missing source detail link for work number ${work.no}.`);
  if (work.source && work.source.url !== row.detailUrl) throw new Error(`Existing source URL differs for work number ${work.no}.`);
  return { ...work, source: { ...(work.source ?? {}), url: row.detailUrl } };
});
fs.writeFileSync(dataPath, `${JSON.stringify(updated, null, 2)}\n`);

function hostCounts(rows: typeof sourceRows): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) for (const url of row.downloadUrls) {
    const host = new URL(url).hostname;
    counts[host] = (counts[host] ?? 0) + 1;
  }
  return counts;
}
const comparisons = inventory.captures.map((capture) => {
  const rows = capture.rows.filter((row) => row.no && row.detailUrl).map((row) => ({
    no: row.no!,
    detailUrl: row.detailUrl!,
    downloadUrls: row.externalLinks.filter((url) => new URL(url).hostname === "box.yahoo.co.jp" || new URL(url).hostname === "drive.google.com"),
  }));
  const byNo = new Map(rows.map((row) => [row.no, row]));
  return {
    timestamp: capture.timestamp,
    originalUrl: capture.originalUrl,
    workRows: rows.length,
    detailLinks: rows.filter((row) => row.detailUrl).length,
    downloadHosts: hostCounts(rows as typeof sourceRows),
    existingDownloadFields: updated.filter((work) => work.download?.url).length,
    exactExistingDownloadMatches: updated.filter((work) => work.download?.url && byNo.get(work.no ?? "")?.downloadUrls.includes(work.download.url)).length,
  };
});

const directAttempts = JSON.parse(fs.readFileSync(`${root}/investigation/direct-attempts.json`, "utf8")) as unknown[];
const directEntryAttempts = JSON.parse(fs.readFileSync(`${root}/investigation/direct-entry-attempts.json`, "utf8").replace(/^\uFEFF/, "")) as unknown[];
const directAssets = JSON.parse(fs.readFileSync(`${root}/investigation/direct-source-assets.json`, "utf8").replace(/^\uFEFF/, "")) as Array<{ retrieved: boolean }>;
const originalView = JSON.parse(fs.readFileSync(`${root}/original-view.json`, "utf8")) as { files: string[]; missingResources: unknown[]; generatedUnavailablePages?: string[] };
const recoverySeed = JSON.parse(fs.readFileSync(`${root}/recovery.json`, "utf8")) as { sourceDetailGaps: unknown[]; unavailableSourcePages: unknown[] };
const recovery = {
  festivalId: id,
  status: "recovered-with-documented-source-gaps",
  archiveOnly: true,
  sourceContentReviewed: false,
  sourceImagesViewed: false,
  sourceUrl: original,
  sourceEncoding: "Shift_JIS",
  primarySource: { originalUrl: primary.originalUrl, snapshotUrl: "https://web.archive.org/web/20190518093109/https://vipkohaku.x.fc2.com/2008chu/index.html", timestamp: primary.timestamp, sha256: "af68b0925970b84859e6ff96172dbd4f00d586eb5a21b02a65ec1695380d111f", cdxDigestVerified: true, proxyRegion: "Hong Kong", exitCountry: "HK" },
  alternateSource: { originalUrl: alternate.originalUrl, snapshotUrl: "https://web.archive.org/web/20230206095914/https://vipkohaku.x.fc2.com/2008chu/", timestamp: alternate.timestamp, sha256: "689aa2ed79c72eca2f0e351b811707586c2f6cc53995a47c28c770680b14a240", cdxDigestVerified: true, proxyRegion: "Hong Kong", exitCountry: "HK" },
  directSourceAttempts: { rootRequests: directAttempts.length, representativeDetailRequests: directEntryAttempts.length, representativeAssetRequests: directAssets.length, successfulAssets: directAssets.filter((asset) => asset.retrieved).length, proxyNode: "🇯🇵 日本S01 | IEPL", exitCountry: "JP" },
  catalogue: { sourceRows: sourceRows.length, registeredWorks: updated.length, detailLinks: sourceRows.filter((row) => row.detailUrl).length, archivedDetailPages: 0, generatedUnavailableDetailSkeletons: originalView.generatedUnavailablePages?.length ?? 0 },
  screenshots: { sourceRootImages: 6, archivedSourceImages: 0, workScreenshotFiles: 0, workScreenshotReferences: 0 },
  downloadComparison: comparisons,
  originalView: { files: originalView.files.length, missingResources: originalView.missingResources.length, generatedUnavailablePages: originalView.generatedUnavailablePages?.length ?? 0 },
  sourceDetailGaps: recoverySeed.sourceDetailGaps,
  unavailableSourcePages: recoverySeed.unavailableSourcePages,
  contentRestrictions: [],
  notes: "Preserved both archived directory versions and the 24 source rows. The 2019 index version matches all 11 existing download URLs; the 2023 directory version has 11 migrated Drive links and is kept as an alternate. No detail page or root image had a usable archive capture. All 24 detail links receive a neutral source-unavailable skeleton in the original view; existing detailDisabled state and restriction markers are unchanged.",
};
fs.writeFileSync(`${root}/recovery.json`, `${JSON.stringify(recovery, null, 2)}\n`);
const sourceComparison = {
  festivalId: id,
  captures: comparisons,
  existingWorkData: { works: updated.length, downloads: updated.filter((work) => work.download?.url).length, forums: updated.filter((work) => work.forum).length, disabledDetails: updated.filter((work) => work.detailDisabled).length, restrictedDetails: updated.filter((work) => work.contentRestricted).length, sourceUrls: updated.filter((work) => work.source?.url).length },
  mappedSourceRows: sourceRows.length,
  sourceDetailPagesWithCapture: 0,
  sourceRootImagesWithCapture: 0,
  additionalUnavailablePages: recoverySeed.unavailableSourcePages.length,
  restrictionOrTextScreening: false,
};
fs.writeFileSync(`${root}/source-comparison.json`, `${JSON.stringify(sourceComparison, null, 2)}\n`);
console.log(JSON.stringify({ works: updated.length, sourceUrls: sourceComparison.existingWorkData.sourceUrls, downloadsPreserved: sourceComparison.existingWorkData.downloads, existingDetailDisabled: sourceComparison.existingWorkData.disabledDetails, unavailableDetailPages: recovery.catalogue.generatedUnavailableDetailSkeletons, originalViewMissing: originalView.missingResources.length }));
