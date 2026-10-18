import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import type { WorkEntry } from "../src/lib/types";

const id = "2008-jisaku-battle-festival";
const root = `catch/${id}`;
const sourceRoot = `${root}/source/archive`;
const sourceUrl = "https://w.atwiki.jp/viprpg_battle/";
const selectedTimestamp = "20191216100856";
const selectedSnapshotUrl = `https://web.archive.org/web/${selectedTimestamp}/${sourceUrl}`;
const workPath = `src/data/works/${id}.json`;

type CdxRow = string[];
type ResourceMeta = {
  originalUrl: string;
  requestedUrl?: string;
  actualUrl?: string;
  contentType?: string | null;
  bytes?: number;
  sha256?: string;
  file?: string;
  proxyRegion?: string;
  proxyPort?: string;
  exitCountry?: string;
};

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha1Base32(bytes: Buffer) {
  const input = createHash("sha1").update(bytes).digest();
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function parseMenuRecords(html: Buffer) {
  const $ = cheerio.load(html.toString("utf8"), { decodeEntities: false });
  const heading = $("#atwiki_menubar h3").toArray().find((element) => $(element).text().includes("作品一覧"));
  if (!heading) throw new Error("Could not find the source menu structure.");
  const list = $(heading).nextAll("div").toArray().find((element) => $(element).find("a[href]").length >= 4);
  if (!list) throw new Error("Could not find the source menu entries.");

  const records: Array<{ no: string; title: string; url: string }> = [];
  let pendingNo: string | undefined;
  for (const node of $(list).contents().toArray()) {
    if (node.type === "text") {
      const match = node.data.match(/No\.?\s*(\d{1,3})/i);
      if (match) pendingNo = String(Number(match[1])).padStart(3, "0");
    } else if (node.type === "tag" && node.tagName === "a" && pendingNo) {
      const href = $(node).attr("href");
      const title = $(node).text().trim();
      if (!href || !title) throw new Error(`Incomplete source menu entry No.${pendingNo}.`);
      records.push({ no: pendingNo, title, url: new URL(href, sourceUrl).href });
      pendingNo = undefined;
    }
  }
  const numbers = records.map((record) => record.no);
  if (records.length !== 4 || new Set(numbers).size !== 4 || numbers.join(",") !== "001,002,003,004") {
    throw new Error("The source menu no longer matches the verified four-entry structure.");
  }
  if (records.some((record) => new URL(record.url).hostname !== "w.atwiki.jp")) throw new Error("A menu entry points outside the source wiki.");
  return { $, records };
}

function captureShape(bytes: Buffer) {
  const $ = cheerio.load(bytes.toString("utf8"), { decodeEntities: false });
  const wikiBody = $("#wikibody");
  const menu = parseMenuRecords(bytes).records;
  const hash = createHash("sha256").update(wikiBody.text()).digest("hex");
  return {
    wikiBodyCharacters: wikiBody.text().length,
    wikiBodySha256: hash,
    headings: { h1: wikiBody.find("h1").length, h2: wikiBody.find("h2").length, h3: wikiBody.find("h3").length },
    lists: { unordered: wikiBody.find("ul").length, ordered: wikiBody.find("ol").length, listItems: wikiBody.find("li").length },
    wikiBodyLinks: wikiBody.find("a[href]").length,
    wikiBodyImages: wikiBody.find("img[src]").length,
    menuNumbers: menu.map((entry) => entry.no),
  };
}

function hostAlias(url: URL) {
  return url.hostname === "w.atwiki.jp" || url.hostname === "img.atwikiimg.com";
}

async function prepare() {
  const capturePath = `${sourceRoot}/index-${selectedTimestamp}.bin`;
  const sourceBytes = await fs.readFile(capturePath);
  const cdx = await readJson<CdxRow[]>(`${root}/investigation/atwiki-index-https-cdx.json`);
  const cdxRow = cdx.slice(1).find((row) => row[0] === sourceUrl && row[1] === selectedTimestamp && row[2] === "200");
  const rootManifest = await readJson<Record<string, ResourceMeta>>(`${sourceRoot}/manifest.json`);
  const rootMeta = rootManifest[`index-${selectedTimestamp}.bin`];
  if (!cdxRow || !rootMeta || rootMeta.sha256 !== sha256(sourceBytes) || sha1Base32(sourceBytes) !== cdxRow[4]) {
    throw new Error("The selected Hong Kong Wayback root capture failed its CDX digest verification.");
  }

  const { $, records } = parseMenuRecords(sourceBytes);
  const pages = new Set<string>();
  for (const record of records) {
    const url = new URL(record.url);
    if (!/^\/viprpg_battle\/pages\/\d+\.html$/.test(url.pathname)) throw new Error(`Unexpected source page path for No.${record.no}.`);
    pages.add(url.pathname.slice("/viprpg_battle/".length));
  }

  const works = await readJson<WorkEntry[]>(workPath);
  const previousRecovery = await readJson<{ catalogue?: { registeredWorksBeforeRecovery?: number; existingTitleMatches?: number; existingTitleMismatches?: number; newRecords?: string[] } }>(`${root}/recovery.json`).catch(() => ({}));
  const baseline = await readJson<{ registeredWorks: number; workNos: string[] }>(`${root}/investigation/pre-recovery-inventory.json`);
  const oldByNo = new Map(works.map((work) => [work.no, work]));
  if (works.some((work) => !work.no || !records.some((record) => record.no === work.no)) || new Set(works.map((work) => work.no)).size !== works.length) {
    throw new Error("The current catalogue cannot be safely reconciled by source number.");
  }
  const baselineNumbers = new Set(baseline.workNos);
  const baselineWorks = works.filter((work) => work.no && baselineNumbers.has(work.no));
  const titleMatches = baselineWorks.filter((work) => records.find((record) => record.no === work.no)?.title === work.title).length;
  const titleMismatches = baselineWorks.length - titleMatches;
  const newNumbers = records.filter((record) => !baselineNumbers.has(record.no)).map((record) => record.no);
  const registeredWorksBeforeRecovery = previousRecovery.catalogue?.registeredWorksBeforeRecovery ?? baseline.registeredWorks;
  const recordedTitleMatches = previousRecovery.catalogue?.existingTitleMatches ?? titleMatches;
  const recordedTitleMismatches = previousRecovery.catalogue?.existingTitleMismatches ?? titleMismatches;
  const recordedNewNumbers = previousRecovery.catalogue?.newRecords ?? newNumbers;

  const updatedWorks: WorkEntry[] = records.map((record) => {
    const existing = oldByNo.get(record.no);
    if (existing) {
      const source = { ...existing.source, url: sourceUrl, snapshotUrl: selectedSnapshotUrl };
      if (existing.title !== record.title) {
        source.titleUrl = sourceUrl;
        return { ...existing, originalTitle: record.title, source, sourceDetailUnavailable: true };
      }
      return { ...existing, source, sourceDetailUnavailable: true };
    }
    return {
      id: `${id}-work-${record.no}`,
      festivalId: id,
      no: record.no,
      title: record.title,
      author: "未记载",
      source: { url: sourceUrl, snapshotUrl: selectedSnapshotUrl, titleUrl: sourceUrl, authorOmitted: true },
      sourceDetailUnavailable: true,
    };
  });
  await fs.writeFile(workPath, `${JSON.stringify(updatedWorks, null, 2)}\n`);

  const waybackPageReport = await readJson<{ report: Array<{ scheme: string; page: string; captures: Array<unknown> }> }>(`${root}/investigation/atwiki-entry-page-cdx-summary.json`);
  const detailGaps = records.map((record) => {
    const url = new URL(record.url);
    const page = url.pathname.match(/pages\/(\d+)\.html$/)?.[1];
    const exactQueries = waybackPageReport.report.filter((entry) => entry.page === page);
    if (exactQueries.length !== 2 || exactQueries.some((entry) => entry.captures.length > 0)) throw new Error(`Unexpected archived detail evidence for No.${record.no}.`);
    return {
      no: record.no,
      sourcePath: url.pathname.slice("/viprpg_battle/".length),
      sourceUrl: record.url,
      archiveEvidence: "Exact HTTP and HTTPS Wayback CDX queries found no successful page capture; representative direct source pages returned HTTP 403 on the Japan route.",
    };
  });
  const allMenuPages = new Set<string>();
  $("#atwiki_menubar a[href],#contents a[href]").each((_, element) => {
    try {
      const url = new URL($(element).attr("href")!, sourceUrl);
      if (url.hostname === "w.atwiki.jp" && /^\/viprpg_battle\/pages\/\d+\.html$/.test(url.pathname)) allMenuPages.add(url.pathname.slice("/viprpg_battle/".length));
    } catch { /* Ignore non-URL navigation controls. */ }
  });
  const auxiliaryPaths = [...allMenuPages].filter((page) => !pages.has(page));
  const auxiliaryGaps = auxiliaryPaths.map((sourcePath) => ({
    sourcePath,
    role: "auxiliary",
    archiveEvidence: "Exact HTTP and HTTPS Wayback CDX queries returned no successful page capture; direct access to the source host was blocked on representative pages.",
  }));

  const sourceOriginalResources: Record<string, string> = {};
  const liveManifest: Record<string, ResourceMeta> = {};
  const addResource = (local: string, originalUrl: string, file: string, meta: ResourceMeta, requestedUrl = meta.requestedUrl ?? meta.originalUrl) => {
    sourceOriginalResources[originalUrl] = local;
    liveManifest[local] = {
      originalUrl,
      requestedUrl,
      actualUrl: meta.actualUrl ?? requestedUrl,
      contentType: meta.contentType,
      bytes: meta.bytes,
      sha256: meta.sha256,
      file,
      proxyRegion: meta.proxyRegion ?? "Japan",
      proxyPort: meta.proxyPort ?? "127.0.0.1:37997",
      exitCountry: meta.exitCountry ?? "JP",
    };
  };

  const rootStyles: Array<{ url: string; kind: "base" | "pc" | "common" }> = [];
  $("link[rel~='stylesheet'][href]").each((_, element) => {
    const url = new URL($(element).attr("href")!, sourceUrl);
    const pathname = url.pathname;
    const kind = pathname.endsWith("base_101default.css") ? "base" : pathname.endsWith("pc_common.css") ? "pc" : pathname.endsWith("atwiki_common.css") ? "common" : undefined;
    if (kind) rootStyles.push({ url: url.href, kind });
  });
  if (rootStyles.length !== 3 || new Set(rootStyles.map((style) => style.kind)).size !== 3) throw new Error("The archived root stylesheet set changed.");

  const css2019 = await readJson<Record<string, ResourceMeta>>("catch/2008-jisaku-battle-festival/source/live/css-2019/manifest.json");
  const currentCss = await readJson<Record<string, ResourceMeta>>("catch/2008-jisaku-battle-festival/source/live/css/manifest.json");
  const localStyleByKind: Record<string, { file: string; meta: ResourceMeta; requestedUrl?: string }> = {};
  for (const [file, meta] of Object.entries(css2019)) {
    const pathname = new URL(meta.originalUrl).pathname;
    if (pathname.endsWith("base_101default.css")) localStyleByKind.base = { file: `css-2019/${file}`, meta };
    if (pathname.endsWith("atwiki_common.css")) localStyleByKind.common = { file: `css-2019/${file}`, meta };
  }
  const currentPc = Object.entries(currentCss).find(([, meta]) => new URL(meta.originalUrl).pathname.endsWith("/dist/css/pc_common.css"));
  if (currentPc) localStyleByKind.pc = { file: `css/${currentPc[0]}`, meta: currentPc[1], requestedUrl: currentPc[1].originalUrl };
  if (!localStyleByKind.base || !localStyleByKind.common || !localStyleByKind.pc) throw new Error("A usable AtWiki stylesheet source is missing.");
  const styleLocals: Record<string, string> = {
    base: "styles/base_101default.css",
    pc: "styles/pc_common.css",
    common: "styles/atwiki_common.css",
  };
  for (const style of rootStyles) {
    const saved = localStyleByKind[style.kind];
    addResource(styleLocals[style.kind], style.url, saved.file, saved.meta, saved.requestedUrl ?? saved.meta.originalUrl);
  }

  const directAssetManifest = await readJson<Record<string, ResourceMeta>>(`${root}/source/live/asset-manifest.json`);
  const rootUiImageManifest = await readJson<Record<string, ResourceMeta>>(`${root}/source/live/root-ui-images/manifest.json`);
  const assetsByPath = new Map<string, Array<{ url: string; meta: ResourceMeta }>>();
  for (const meta of [...Object.values(directAssetManifest), ...Object.values(rootUiImageManifest)]) {
    if (!meta.originalUrl || !meta.file) continue;
    const url = new URL(meta.originalUrl);
    const key = url.pathname;
    assetsByPath.set(key, [...(assetsByPath.get(key) ?? []), { url: url.href, meta }]);
  }
  const missingCssAssets: Array<{ originalUrl: string; sourcePath: string; directResult?: number | string }> = [];
  const neededCssAssets = new Map<string, { url: string; meta: ResourceMeta }>();
  for (const saved of Object.values(localStyleByKind)) {
    const cssBytes = await fs.readFile(`catch/2008-jisaku-battle-festival/source/live/${saved.file}`);
    for (const match of cssBytes.toString("utf8").matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
      let resource: URL;
      try { resource = new URL(match[1], saved.meta.originalUrl); } catch { continue; }
      if (!/^https?:$/.test(resource.protocol)) continue;
      const candidate = (assetsByPath.get(resource.pathname) ?? []).find(({ url }) => {
        const host = new URL(url).hostname;
        return host === resource.hostname || (hostAlias(new URL(url)) && hostAlias(resource));
      });
      if (candidate) {
        const file = candidate.meta.file!;
        neededCssAssets.set(resource.href, candidate);
        sourceOriginalResources[resource.href] = file;
        liveManifest[file] = { ...candidate.meta, originalUrl: resource.href, requestedUrl: candidate.url, file };
      } else {
        const observed = JSON.parse(await fs.readFile(`${root}/investigation/css-assets-direct.json`, "utf8")) as { results: Array<{ path: string; status: number; error?: string }> };
        const direct = observed.results.find((attempt) => attempt.path === resource.pathname);
        missingCssAssets.push({ originalUrl: resource.href, sourcePath: resource.pathname, ...(direct ? { directResult: direct.status || direct.error } : {}) });
      }
    }
  }

  const pageImages = $("img[src]").toArray().map((element) => new URL($(element).attr("src")!, sourceUrl));
  const unavailableAttachments = pageImages.filter((url) => url.hostname === "img.atwikiimg.com" && url.pathname.includes("/attach/"));
  const shareBadges = pageImages.filter((url) => url.hostname === "b.st-hatena.com");
  const unavailablePageImages: Array<{ host: string; path: string }> = [];
  for (const imageUrl of pageImages) {
    if (shareBadges.some((badge) => badge.href === imageUrl.href) || imageUrl.pathname.includes("/attach/")) continue;
    const image = Object.values(rootUiImageManifest).find((meta) => new URL(meta.originalUrl).pathname === imageUrl.pathname);
    if (!image?.file) {
      unavailablePageImages.push({ host: imageUrl.host, path: imageUrl.pathname });
      continue;
    }
    const local = image.file;
    sourceOriginalResources[imageUrl.href] = local;
    liveManifest[local] = { ...image, originalUrl: imageUrl.href, file: local };
  }
  if (unavailableAttachments.length !== 0) throw new Error("The selected 2019 source root unexpectedly contains an uncaptured page attachment.");

  await fs.writeFile(`${root}/investigation/original-timemap.bin`, `${JSON.stringify(cdx)}\n`);
  await writeJson("catch/2008-jisaku-battle-festival/source/live/original-view-manifest.json", liveManifest);
  await fs.writeFile(workPath, `${JSON.stringify(updatedWorks, null, 2)}\n`);

  const captureSummaries = await Promise.all(Object.keys(rootManifest).filter((file) => file.startsWith("index-") && file.endsWith(".bin")).map(async (file) => {
    const meta = rootManifest[file];
    const bytes = await fs.readFile(path.join(sourceRoot, file));
    return { file, timestamp: meta.actualUrl ? file.match(/\d{14}/)?.[0] : undefined, bytes: bytes.length, sha256: sha256(bytes), cdxDigestVerified: meta.cdxDigestVerified === true, ...captureShape(bytes) };
  }));
  const downloadedItems = works.flatMap((work) => work.downloads ?? (work.download ? [work.download] : []));
  const sourceDetails = {
    sourceRootPage: sourceUrl,
    selectedSnapshotUrl: selectedSnapshotUrl,
    rootSnapshots: captureSummaries,
    sourceMenuNumbers: records.map((record) => record.no),
    individualDetailPagesWithCapture: 0,
    sourceDetailGaps: detailGaps,
    unavailableAuxiliaryPages: auxiliaryGaps,
    noPerWorkScreenshotReferences: true,
  };
  const originalResources = sourceOriginalResources;
  const recovery = {
    festivalId: id,
    source: { url: sourceUrl, snapshotUrl: selectedSnapshotUrl, timestamp: selectedTimestamp, encoding: "UTF-8", rawFile: `${sourceRoot}/index-${selectedTimestamp}.bin`, sha256: sha256(sourceBytes), cdxDigest: cdxRow[4], cdxDigestVerified: true },
    directSourceAttempts: {
      sourceUrl,
      proxyNode: "🇯🇵 日本S01 | IEPL",
      proxyRegion: "Japan",
      exitCountry: "JP",
      rootResponses: [403, 403],
      representativePageResponses: [{ page: "pages/1.html", status: 403 }, { page: "pages/14.html", status: 403 }],
      successfulRootOrDetailRequests: 0,
      evidence: [`${root}/investigation/direct-source-attempts.json`, `${root}/investigation/direct-css-2019.json`],
    },
    archiveRetrieval: { proxyRegion: "Hong Kong", proxyPort: "127.0.0.1:7897", exitCountry: "HK", rootCaptures: captureSummaries.length, rootCdxDigestVerified: true, exactDetailPagesWithCapture: 0, originalTimemap: `${root}/investigation/original-timemap.bin` },
    catalogue: {
      sourceMenuEntries: records.length,
      registeredWorksBeforeRecovery,
      registeredWorks: updatedWorks.length,
      newRecords: recordedNewNumbers,
      existingTitleMatches: recordedTitleMatches,
      existingTitleMismatches: recordedTitleMismatches,
      sourceAuthorFieldsOnNewRecords: 0,
      newAuthorsMarkedNotRecorded: newNumbers.length,
      existingCommentsPreserved: works.filter((work) => work.authorComment || work.hostComment).length,
      downloadsBeforeRecovery: downloadedItems.length,
      downloadsChanged: 0,
      sourceDetailUnavailableRecords: updatedWorks.filter((work) => work.sourceDetailUnavailable).length,
    },
    sourceDetails,
    sourceDetailGaps: detailGaps,
    unavailableSourcePages: auxiliaryGaps,
    originalResources,
    cssResources: {
      rootStylesheets: rootStyles.length,
      directlySaved2019Stylesheets: Object.keys(css2019).length,
      currentAtWikiPcStylesheetUsedForOld404Path: true,
      selectedStylesheetResources: neededCssAssets.size,
      missingSelectedStylesheetResources: missingCssAssets,
      directImageResources: Object.keys(rootUiImageManifest).length,
      rootUiImageReferences: pageImages.length - shareBadges.length,
      unavailablePageImages,
      unavailablePageAttachments: unavailableAttachments.length,
      unattachedImageProbe: { path: "/viprpg_battle/attach/1/1/vo01_0228.png", sourceStatus: 404, waybackCaptures: 0 },
      thirdPartyShareBadgesRemoved: shareBadges.length,
      selectedSnapshotImageCount: pageImages.length,
    },
    contentReview: { inspected: false, keywordScreening: false, restrictionOrTextScreening: false, newRestrictionMarkers: 0 },
  };
  const directAttemptsPath = `${root}/investigation/direct-source-attempts.json`;
  const directAttempts = await readJson<Record<string, unknown>>(directAttemptsPath);
  directAttempts.representativeEntryPages = [{ page: "pages/1.html", status: 403 }, { page: "pages/14.html", status: 403 }];
  await writeJson(directAttemptsPath, directAttempts);
  await writeJson(`${root}/source-comparison.json`, {
    festivalId: id,
    sourceDetails,
    catalogue: { ...recovery.catalogue, registeredWorksBeforeRecovery, registeredWorks: updatedWorks.length, newRecords: recordedNewNumbers, existingTitleMatches: recordedTitleMatches, existingTitleMismatches: recordedTitleMismatches },
    downloads: { existingFields: downloadedItems.length, changedFields: 0 },
    sourceResources: recovery.cssResources,
    contentReview: recovery.contentReview,
    proxyRoute: { JapaneseSource: "Japan", Wayback: "Hong Kong", archiveExitCountry: "HK" },
    selectedRootReason: "The 2019 capture retains the longest captured Wiki-body structure among the three root versions; all three snapshots preserve the same four numbered menu entries.",
  });
  await writeJson(`${root}/recovery.json`, recovery);
  console.log(JSON.stringify({ mode: "prepare", sourceMenuEntries: records.length, registeredWorksBeforeRecovery, registeredWorks: updatedWorks.length, newRecords: recordedNewNumbers.length, titleMatches: recordedTitleMatches, detailPagesWithCapture: 0, unavailableDetailSkeletons: detailGaps.length, unavailableAuxiliaryPages: auxiliaryGaps.length, savedStaticResources: Object.keys(liveManifest).length, missingCssResources: missingCssAssets.length }));
}

async function main() {
  if (process.argv[2] !== "prepare") throw new Error("Use `prepare` after the source and archive capture batches have completed.");
  await prepare();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
