import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import { ProxyAgent } from "undici";
import type { WorkEntry } from "../src/lib/types";

const id = "2008-gw";
const root = `catch/${id}`;
const archiveRoot = `${root}/source/archive`;
const rootUrl = "https://vipkohaku.x.fc2.com/2008GW/index.html";
const rootTimestamp = "20220428072419";
const rootSnapshotUrl = `https://web.archive.org/web/${rootTimestamp}/${rootUrl}`;
const proxyUrl = "http://127.0.0.1:7897";

type CdxRow = string[];
type SourceManifestEntry = {
  originalUrl: string;
  requestedUrl: string;
  actualUrl: string;
  contentType: string | null;
  timestamp?: string;
  cdxDigest?: string;
  cdxDigestVerified?: boolean;
  sha256?: string;
  bytes?: number;
  file?: string;
  proxyRegion: "Hong Kong";
  proxyPort: "127.0.0.1:7897";
  exitCountry: "HK";
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

function proxyFetch(url: string, dispatcher: ProxyAgent, redirect: RequestRedirect = "error") {
  const fetchWithDispatcher = fetch as unknown as (url: string, init: RequestInit & { dispatcher: ProxyAgent }) => Promise<Response>;
  return fetchWithDispatcher(url, { dispatcher, redirect, signal: AbortSignal.timeout(45_000) });
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function cdxSelection(rows: CdxRow[]) {
  const rootRows = rows.slice(1).filter((row) => row[0] && new URL(row[0]).hostname === "vipkohaku.x.fc2.com");
  const resources = rootRows.filter((row) => {
    const url = new URL(row[0]);
    return url.pathname.startsWith("/2008GW/") &&
      (/^\/2008GW\/(?:screenshot|image)\//.test(url.pathname) || /\.(?:css|js)$/i.test(url.pathname)) &&
      (row[2] === "200" || row[2] === "-");
  });
  const selected = new Map<string, CdxRow>();
  for (const row of resources) {
    const url = new URL(row[0]);
    const prior = selected.get(url.href);
    const beforeRoot = row[1] <= rootTimestamp;
    const priorBeforeRoot = prior ? prior[1] <= rootTimestamp : false;
    if (!prior || (beforeRoot && !priorBeforeRoot) || (beforeRoot === priorBeforeRoot && row[1] > prior[1])) selected.set(url.href, row);
  }
  return [...selected.values()].sort((a, b) => a[0].localeCompare(b[0]));
}

async function archiveOnly() {
  if (!process.argv.includes("--archive-only")) throw new Error("Archive retrieval requires the explicit --archive-only flag.");
  const dispatcher = new ProxyAgent(proxyUrl);
  try {
    const ipResponse = await proxyFetch("https://ipinfo.io/json", dispatcher);
    if (!ipResponse.ok) throw new Error(`Could not verify the proxy exit country (HTTP ${ipResponse.status}).`);
    const ip = await ipResponse.json() as { country?: string };
    if (ip.country !== "HK") throw new Error(`Archive retrieval requires the Hong Kong exit; current exit is ${ip.country ?? "unknown"}.`);

    const cdx = await readJson<CdxRow[]>(`${root}/investigation/prefix-https-cdx.json`);
    const selected = cdxSelection(cdx);
    const manifestPath = `${archiveRoot}/manifest.json`;
    const manifest = await readJson<Record<string, SourceManifestEntry>>(manifestPath);
    const retrievals: Array<{ path: string; timestamp: string; cdxDigest: string; bytes: number; sha256: string }> = [];
    const failures: Array<{ path: string; timestamp: string; error: string }> = [];

    for (const row of selected) {
      const originalUrl = row[0];
      const original = new URL(originalUrl);
      const relativeFile = original.pathname.slice("/2008GW/".length);
      const target = path.join(archiveRoot, ...relativeFile.split("/"));
      const requestedUrl = `https://web.archive.org/web/${row[1]}id_/${originalUrl}`;
      try {
        let bytes = await fs.readFile(target).catch(() => undefined);
        if (!bytes || sha1Base32(bytes) !== row[4]) {
          let lastError = "No response";
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const response = await proxyFetch(requestedUrl, dispatcher);
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              const candidate = Buffer.from(await response.arrayBuffer());
              if (sha1Base32(candidate) !== row[4]) throw new Error("CDX digest mismatch");
              bytes = candidate;
              break;
            } catch (error) {
              lastError = error instanceof Error ? error.message : String(error);
              if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
            }
          }
          if (!bytes || sha1Base32(bytes) !== row[4]) throw new Error(lastError);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, bytes);
        }
        const localFile = relativeFile.replaceAll("\\", "/");
        manifest[localFile] = {
          originalUrl,
          requestedUrl,
          actualUrl: requestedUrl,
          contentType: row[3] || null,
          timestamp: row[1],
          cdxDigest: row[4],
          cdxDigestVerified: true,
          sha256: sha256(bytes),
          bytes: bytes.length,
          file: localFile,
          proxyRegion: "Hong Kong",
          proxyPort: "127.0.0.1:7897",
          exitCountry: "HK",
        };
        retrievals.push({ path: original.pathname, timestamp: row[1], cdxDigest: row[4], bytes: bytes.length, sha256: sha256(bytes) });
        await writeJson(manifestPath, manifest);
      } catch (error) {
        failures.push({ path: original.pathname, timestamp: row[1], error: error instanceof Error ? error.message : String(error) });
      }
    }

    await writeJson(`${root}/investigation/archive-resource-fetch.json`, {
      proxyRegion: "Hong Kong",
      proxyPort: "127.0.0.1:7897",
      exitCountry: ip.country,
      mode: "archive-only",
      rootSnapshotTimestamp: rootTimestamp,
      selectedResources: selected.length,
      successfulResources: retrievals.length,
      failures,
      retrievals,
    });
    if (failures.length) throw new Error(`${failures.length} archived resources failed; see ${root}/investigation/archive-resource-fetch.json.`);
    console.log(JSON.stringify({ mode: "archive-only", exitCountry: ip.country, selectedResources: selected.length, successfulResources: retrievals.length }));
  } finally {
    await dispatcher.close();
  }
}

async function prepare() {
  const latestRoot = `${archiveRoot}/index-${rootTimestamp}.bin`;
  const rootBytes = await fs.readFile(latestRoot);
  const sourceManifest = await readJson<Record<string, SourceManifestEntry>>(`${archiveRoot}/manifest.json`);
  const rootMeta = sourceManifest[`index-${rootTimestamp}.bin`];
  const cdx = await readJson<CdxRow[]>(`${root}/investigation/prefix-https-cdx.json`);
  const rootCdxRow = cdx.slice(1).find((row) => row[0] === rootUrl && row[1] === rootTimestamp && row[2] === "200");
  if (!rootMeta || rootMeta.sha256 !== sha256(rootBytes) || !rootCdxRow || sha1Base32(rootBytes) !== rootCdxRow[4]) throw new Error("The selected root capture is not backed by a verified HK archive manifest entry.");
  for (const file of Object.keys(sourceManifest).filter((name) => name.startsWith("index-") && name.endsWith(".bin"))) {
    const bytes = await fs.readFile(path.join(archiveRoot, file));
    const timestamp = sourceManifest[file].timestamp ?? file.match(/\d{14}/)?.[0];
    const row = cdx.slice(1).find((candidate) => candidate[0] === rootUrl && candidate[1] === timestamp && candidate[2] === "200");
    if (!row || sourceManifest[file].sha256 !== sha256(bytes) || sha1Base32(bytes) !== row[4]) throw new Error(`Root capture verification failed for ${file}.`);
    sourceManifest[file].cdxDigest = row[4];
    sourceManifest[file].cdxDigestVerified = true;
  }
  await writeJson(`${archiveRoot}/manifest.json`, sourceManifest);

  const $ = cheerio.load(iconv.decode(rootBytes, "shift_jis"), { decodeEntities: false });
  const screenshots = new Map<string, string>();
  $("img[src]").each((_, element) => {
    const url = new URL($(element).attr("src")!, rootUrl);
    const match = url.pathname.match(/\/screenshot\/ss(\d{3})\.(png|jpe?g)$/i);
    if (!match) return;
    const no = match[1];
    if (screenshots.has(no)) throw new Error(`Duplicate source screenshot number ${no}.`);
    screenshots.set(no, `screenshot/ss${no}.${match[2]}`);
  });
  if (screenshots.size !== 64 || !screenshots.has("000")) throw new Error("The source root does not contain the expected 64-number screenshot series.");

  const cdxAssets = new Set(cdxSelection(cdx).map((row) => new URL(row[0]).pathname.slice("/2008GW/".length)));
  for (const file of screenshots.values()) if (!cdxAssets.has(file)) throw new Error(`Screenshot capture is missing from the recorded CDX inventory: ${file}`);
  for (const file of cdxAssets) {
    const meta = sourceManifest[file];
    if (!meta || meta.cdxDigestVerified !== true || !(await fs.stat(path.join(archiveRoot, ...file.split("/"))).catch(() => undefined))) {
      throw new Error(`Archived source asset is missing or not digest-verified: ${file}`);
    }
  }

  const workPath = `src/data/works/${id}.json`;
  const works = await readJson<WorkEntry[]>(workPath);
  const workNos = works.map((work) => work.no).filter((no): no is string => Boolean(no));
  const unprepared = works.every((work) => work.detailDisabled === true && !work.ss?.length);
  const alreadyPrepared = works.every((work) => work.detailDisabled === undefined && work.source?.url === rootUrl && work.source.snapshotUrl === rootSnapshotUrl && work.ss?.length === 1);
  if (works.length !== 63 || new Set(workNos).size !== works.length || works.some((work) => !work.no) || (!unprepared && !alreadyPrepared)) {
    throw new Error("The work catalogue shape changed; stop before assigning screenshots.");
  }
  const sourceNos = new Set([...screenshots.keys()].filter((no) => no !== "000"));
  if (workNos.some((no) => !sourceNos.has(no)) || [...sourceNos].some((no) => !workNos.includes(no))) {
    throw new Error("The source screenshot numbers do not match the registered catalogue numbers.");
  }

  const rootDownloadUrls = new Set<string>();
  $("a[href]").each((_, element) => {
    const url = new URL($(element).attr("href")!, rootUrl);
    if (["drive.google.com", "box.yahoo.co.jp"].includes(url.hostname)) rootDownloadUrls.add(url.href);
  });
  const existingDownloadUrls = works.flatMap((work) => work.downloads ?? (work.download ? [work.download] : [])).map((download) => download.url);
  const exactDownloadMatches = existingDownloadUrls.filter((url) => rootDownloadUrls.has(url)).length;

  const updated = await Promise.all(works.map(async (work) => {
    const file = screenshots.get(work.no!)!;
    const extension = path.extname(file);
    const local = `/screenshots/${id}/ss${work.no}${extension}`;
    const sourceFile = path.join(archiveRoot, ...file.split("/"));
    const targetFile = `public${local}`;
    const bytes = await fs.readFile(sourceFile);
    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.writeFile(targetFile, bytes);
    const preserved = { ...work };
    delete preserved.detailDisabled;
    return {
      ...preserved,
      source: { ...work.source, url: rootUrl, snapshotUrl: rootSnapshotUrl },
      ss: [local],
    } satisfies WorkEntry;
  }));
  await fs.writeFile(workPath, `${JSON.stringify(updated, null, 2)}\n`);

  const headers = cdx[0];
  await fs.writeFile(`${root}/investigation/original-timemap.bin`, `${JSON.stringify(cdx)}\n`);
  const captureRows = await Promise.all(Object.keys(sourceManifest).filter((file) => file.startsWith("index-") && file.endsWith(".bin")).map(async (file) => {
    const meta = sourceManifest[file];
    const bytes = await fs.readFile(path.join(archiveRoot, file));
    const capture$ = cheerio.load(iconv.decode(bytes, "shift_jis"), { decodeEntities: false });
    const screenshotCount = capture$("img[src]").toArray().filter((element) => /\/screenshot\/ss\d{3}\.(?:png|jpe?g)$/i.test(new URL(capture$(element).attr("src")!, rootUrl).pathname)).length;
    const linkHosts: Record<string, number> = {};
    const downloadUrls = new Set<string>();
    capture$("a[href]").each((_, element) => {
      const url = new URL(capture$(element).attr("href")!, rootUrl);
      const host = url.hostname;
      linkHosts[host] = (linkHosts[host] ?? 0) + 1;
      if (["drive.google.com", "box.yahoo.co.jp"].includes(host)) downloadUrls.add(url.href);
    });
    return {
      file,
      timestamp: meta.timestamp ?? file.match(/\d{14}/)?.[0],
      sha256: sha256(bytes),
      cdxDigestVerified: meta.cdxDigestVerified === true,
      screenshotReferences: screenshotCount,
      linkCount: capture$("a[href]").length,
      linkHosts,
      sourceDownloadLinks: downloadUrls.size,
      existingDownloadFields: existingDownloadUrls.length,
      exactExistingDownloadMatches: existingDownloadUrls.filter((url) => downloadUrls.has(url)).length,
    };
  }));
  const entries = Object.entries(sourceManifest).filter(([file]) => !file.startsWith("index-"));
  const directAssetAttempts = {
    proxyNode: "🇯🇵 日本S01 | IEPL",
    exitCountry: "JP",
    attempts: ["/2008GW/screenshot/ss001.png", "/2008GW/image/gw.png"].map((resourcePath) => ({ resourcePath, result: "ECONNRESET" })),
    successfulRequests: 0,
  };
  await writeJson(`${root}/investigation/direct-source-probes.json`, {
    proxyNode: "🇯🇵 日本S01 | IEPL",
    proxyRegion: "Japan",
    exitCountry: "JP",
    root: { https: "ECONNRESET", http: 502 },
    representativeEntries: { numbers: ["001", "024"], https: "ECONNRESET", http: 502 },
    representativeAssets: directAssetAttempts.attempts,
    successfulRequests: 0,
  });
  await writeJson(`${root}/investigation/direct-asset-attempts.json`, directAssetAttempts);
  await writeJson(`${root}/source-comparison.json`, {
    festivalId: id,
    sourceUrl: rootUrl,
    captures: captureRows,
    latestSelectedCapture: rootTimestamp,
    catalogue: { registeredWorks: works.length, sourceScreenshotReferences: 64, sampleNo: "000", missingScreenshotNo: "042", registeredScreenshotMatches: updated.length },
    downloads: { latestRootLinks: rootDownloadUrls.size, existingFields: existingDownloadUrls.length, exactUrlMatchesInLatestRoot: exactDownloadMatches, exactUrlMatchesByCapture: captureRows.map(({ file, timestamp, sourceDownloadLinks, exactExistingDownloadMatches }) => ({ file, timestamp, sourceDownloadLinks, exactExistingDownloadMatches })), changedFields: 0 },
    sourceDetails: { individualDetailLinks: 0, allEntriesUseCatalogueRoot: true },
    contentReview: { inspected: false, keywordScreening: false, newRestrictionMarkers: 0 },
    proxyRoute: { source: "Japan", wayback: "Hong Kong", waybackExitCountry: "HK" },
    cdxInventory: { header: headers, selectedAssetResources: cdxAssets.size, digestVerifiedAssetResources: entries.length },
  });
  await writeJson(`${root}/recovery.json`, {
    festivalId: id,
    source: { url: rootUrl, snapshotUrl: rootSnapshotUrl, timestamp: rootTimestamp, encoding: "Shift_JIS", rawFile: `${root}/source/archive/index-${rootTimestamp}.bin`, sha256: sha256(rootBytes), cdxDigest: rootCdxRow[4], cdxDigestVerified: true },
    directSourceAttempts: { rootRequests: 2, representativeEntryRequests: 2, representativeAssetRequests: directAssetAttempts.attempts.length, successfulRequests: 0, proxyNode: "🇯🇵 日本S01 | IEPL", exitCountry: "JP" },
    archiveRetrieval: { resourceRequests: entries.length, proxyRegion: "Hong Kong", proxyPort: "127.0.0.1:7897", exitCountry: "HK", cdxDigestVerified: true, rootSnapshotTimestamp: rootTimestamp },
    catalogue: { registeredWorks: updated.length, enabledDetailPages: updated.length, detailDisabledRemoved: works.length, sourceScreenshotReferences: 64, workScreenshotFiles: updated.length, workScreenshotReferences: updated.length, no000SamplePreservedOnlyInOriginalView: true, missingNo042NotInCatalogue: true },
    downloads: { latestRootLinks: rootDownloadUrls.size, existingDownloadFields: existingDownloadUrls.length, exactUrlMatchesInLatestRoot: exactDownloadMatches, exactUrlMatchesByCapture: captureRows.map(({ file, timestamp, sourceDownloadLinks, exactExistingDownloadMatches }) => ({ file, timestamp, sourceDownloadLinks, exactExistingDownloadMatches })), changedFields: 0 },
    sourceDetails: { individualDetailLinks: 0, perWorkSourceUrl: rootUrl, rootContainsCatalogue: true },
    contentReview: { inspected: false, keywordScreening: false, restrictionOrTextScreening: false },
  });
  console.log(JSON.stringify({ mode: "prepare", registeredWorks: updated.length, screenshotReferences: updated.length, sourceScreenshotNumbers: screenshots.size, exactDownloadMatches, originalTimemapRows: cdx.length - 1 }));
}

async function main() {
  const mode = process.argv[2];
  if (mode === "archive-only") return archiveOnly();
  if (mode === "prepare") return prepare();
  throw new Error("Use `archive-only --archive-only` for Wayback retrieval or `prepare` to map the already-fetched archive data.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
