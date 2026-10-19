import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ProxyAgent } from "undici";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { WorkEntry } from "../src/lib/types";
import { imageExtension, writeJson } from "./recover-entry-table";

const id = "2008-kouhaku";
const root = `catch/${id}`;
const sourceRoot = `${root}/source/archive`;
const proxyUrl = "http://127.0.0.1:7897";

type CdxRow = string[];
type Capture = {
  originalUrl: string;
  requestedUrl: string;
  actualUrl: string;
  timestamp: string;
  status: string;
  contentType: string;
  digest: string;
  sha256: string;
  bytes: number;
  file: string;
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

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

function selectCaptures(http: CdxRow[], https: CdxRow[]) {
  const selected = new Map<string, CdxRow>();
  for (const row of [...http.slice(1), ...https.slice(1)]) {
    if (!row[0]) continue;
    const url = new URL(row[0]);
    if (url.hostname !== "vipkohaku.x.fc2.com" || !url.pathname.startsWith("/2008/") || url.pathname === "/2008/") continue;
    if (row[2] !== "200" && row[2] !== "-") continue;
    const prior = selected.get(url.pathname + url.search);
    if (!prior || row[1] > prior[1] || (row[1] === prior[1] && row[2] === "200")) selected.set(url.pathname + url.search, row);
  }
  return [...selected.values()].sort((a, b) => a[0].localeCompare(b[0]));
}

async function archiveOnly() {
  if (!process.argv.includes("--archive-only")) throw new Error("Wayback retrieval requires the explicit --archive-only flag.");
  const dispatcher = new ProxyAgent(proxyUrl);
  try {
    const routeResponse = await fetch("http://ip-api.com/json/?fields=status,countryCode,city", { dispatcher, signal: AbortSignal.timeout(10_000) });
    const route = await routeResponse.json() as { countryCode?: string };
    if (!routeResponse.ok || route.countryCode !== "HK") throw new Error(`Wayback retrieval requires the Hong Kong exit; current exit is ${route.countryCode ?? "unknown"}.`);

    const [httpsCdx, httpCdx] = await Promise.all([
      readJson<CdxRow[]>(`${root}/investigation/prefix-https-cdx.json`),
      readJson<CdxRow[]>(`${root}/investigation/prefix-http-cdx.json`),
    ]);
    const selected = selectCaptures(httpCdx, httpsCdx);
    const manifest: Record<string, Capture> = {};
    const results: Array<{ path: string; timestamp: string; status: string; bytes?: number; cdxDigestVerified?: boolean; error?: string }> = [];
    for (const row of selected) {
      const original = new URL(row[0]);
      const relative = original.pathname.slice("/2008/".length);
      const requestedUrl = `https://web.archive.org/web/${row[1]}id_/${row[0]}`;
      let success: Buffer | undefined;
      let failure = "No response";
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await fetch(requestedUrl, { dispatcher, redirect: "error", signal: AbortSignal.timeout(30_000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const bytes = Buffer.from(await response.arrayBuffer());
          const extension = path.extname(relative).toLowerCase();
          if ([".png", ".jpg", ".jpeg", ".gif"].includes(extension)) imageExtension(bytes);
          if (sha1Base32(bytes) !== row[4]) throw new Error("CDX digest mismatch");
          success = bytes;
          break;
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
          if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 750));
        }
      }
      if (!success) {
        results.push({ path: original.pathname, timestamp: row[1], status: row[2], error: failure });
        continue;
      }
      const target = path.join(sourceRoot, ...relative.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, success);
      manifest[relative] = {
        originalUrl: row[0],
        requestedUrl,
        actualUrl: requestedUrl,
        timestamp: row[1],
        status: row[2],
        contentType: row[3],
        digest: row[4],
        sha256: sha256(success),
        bytes: success.length,
        file: relative,
        proxyRegion: "Hong Kong",
        proxyPort: "127.0.0.1:7897",
        exitCountry: "HK",
      };
      results.push({ path: original.pathname, timestamp: row[1], status: row[2], bytes: success.length, cdxDigestVerified: true });
      await writeJson(`${sourceRoot}/manifest.json`, manifest);
    }

    const combined = [httpCdx[0], ...httpsCdx.slice(1), ...httpCdx.slice(1)];
    await fs.writeFile(`${root}/investigation/original-timemap.bin`, `${JSON.stringify(combined)}\n`);
    await writeJson(`${root}/investigation/archive-resource-fetch.json`, {
      proxyRegion: "Hong Kong",
      proxyPort: "127.0.0.1:7897",
      exitCountry: route.countryCode,
      mode: "archive-only",
      selectedResources: selected.length,
      successfulResources: results.filter((result) => result.cdxDigestVerified).length,
      failedResources: results.filter((result) => !result.cdxDigestVerified),
      resources: results,
    });
    const detailCaptures = Object.keys(manifest).filter((file) => /^sakuhin_\d+\.html$/i.test(file)).length;
    const screenshotCaptures = Object.keys(manifest).filter((file) => /^SS?_\d+\.(?:png|jpe?g|gif)$/i.test(file)).length;
    await writeJson(`${root}/investigation/wayback-captures.json`, {
      proxyRegion: "Hong Kong",
      proxyPort: "127.0.0.1:7897",
      exitCountry: route.countryCode,
      httpsPrefixRecords: httpsCdx.length - 1,
      httpPrefixSuccessfulRecords: httpCdx.length - 1,
      selectedResources: selected.length,
      successfulResources: results.filter((result) => result.cdxDigestVerified).length,
      detailPagesWithCapture: detailCaptures,
      screenshotAssetsWithCapture: screenshotCaptures,
      failures: results.filter((result) => !result.cdxDigestVerified),
    });
    console.log(JSON.stringify({ mode: "archive-only", exitCountry: route.countryCode, selectedResources: selected.length, successfulResources: results.filter((result) => result.cdxDigestVerified).length, detailPagesWithCapture: detailCaptures, screenshotAssetsWithCapture: screenshotCaptures, failures: results.filter((result) => !result.cdxDigestVerified).length }));
    if (results.some((result) => !result.cdxDigestVerified)) process.exitCode = 1;
  } finally {
    await dispatcher.close();
  }
}

async function prepare() {
  const dataFile = `src/data/works/${id}.json`;
  const works = await readJson<WorkEntry[]>(dataFile);
  const manifest = await readJson<Record<string, Capture>>(`${sourceRoot}/manifest.json`);
  const encodingChecks = await Promise.all(Object.keys(manifest).filter((file) => /\.html$/i.test(file)).map(async (file) => {
    const bytes = await fs.readFile(`${sourceRoot}/${file}`);
    const decoded = iconv.decode(bytes, "shift_jis");
    return { file, declared: bytes.subarray(0, 4096).toString("latin1").match(/charset\s*=\s*["']?\s*([\w-]+)/i)?.[1], effectiveEncoding: "shift_jis", byteRoundtrip: iconv.encode(decoded, "shift_jis").equals(bytes), replacementCharacters: (decoded.match(/\ufffd/g) ?? []).length };
  }));
  await writeJson(`${root}/investigation/encoding-check.json`, encodingChecks);
  if (encodingChecks.some((check) => !check.byteRoundtrip || check.replacementCharacters)) throw new Error("Source encoding needs investigation");
  const base = "https://vipkohaku.x.fc2.com/2008/";
  const listed = new Map<number, string>();
  for (const file of ["sakuhin_aka.html", "sakuhin_siro.html"]) {
    const $ = cheerio.load((await fs.readFile(`${sourceRoot}/${file}`)).toString("latin1"));
    $("a[href]").each((_, element) => {
      const href = $(element).attr("href")!;
      const match = href.match(/^sakuhin_(\d+)\.html$/i);
      if (match) listed.set(Number(match[1]), href);
    });
  }
  if (works.length !== 125 || listed.size !== 125 || works.some((work) => !listed.has(Number(work.no)))) throw new Error("Catalogue number mismatch");
  const baselineFile = `${root}/investigation/pre-recovery-baseline.json`;
  if (!(await fs.stat(baselineFile).catch(() => undefined))) await writeJson(baselineFile, { works: works.length, disabled: works.filter((work) => work.detailDisabled).length, screenshots: works.reduce((n, work) => n + (work.ss?.length ?? 0), 0), sourcePages: works.filter((work) => work.source).length });
  const screenshotSources = [];
  for (const [file, capture] of Object.entries(manifest)) {
    const match = file.match(/^SS?_(\d+)\.(png|jpe?g|gif)$/i);
    if (!match || !listed.has(Number(match[1]))) continue;
    const bytes = await fs.readFile(`${sourceRoot}/${file}`);
    const extension = imageExtension(bytes);
    const local = `/screenshots/${id}/${Number(match[1])}.${extension}`;
    await fs.mkdir(path.dirname(`public${local}`), { recursive: true });
    await fs.writeFile(`public${local}`, bytes);
    const work = works.find((work) => Number(work.no) === Number(match[1]))!;
    work.ss = [local];
    screenshotSources.push({ no: work.no, sourcePath: file, local, originalUrl: capture.originalUrl, snapshotUrl: capture.requestedUrl, sha256: capture.sha256 });
  }
  const sourceDetailGaps = [];
  let savedDetails = 0;
  for (const work of works) {
    if (work.category === "紅組" || work.category === "白組") { work.group = work.category; delete work.category; }
    const file = listed.get(Number(work.no))!;
    const capture = manifest[file];
    work.source = { url: new URL(file, base).href, ...(capture ? { snapshotUrl: capture.requestedUrl } : {}) };
    delete work.detailDisabled;
    if (capture) {
      const bytes = await fs.readFile(`${sourceRoot}/${file}`);
      // Every retrieved page round-trips as Shift-JIS. Seven detail pages incorrectly declare UTF-8.
      const $ = cheerio.load(iconv.decode(bytes, "shift_jis"));
      $("script,noscript,style,img,iframe,form,object,embed").remove();
      $("*").each((_, element) => { for (const attr of Object.keys(element.attribs)) if (attr.startsWith("on")) $(element).removeAttr(attr); });
      $("a[href]").each((_, element) => { $(element).attr("href", new URL($(element).attr("href")!, work.source!.url).href); });
      work.sourceContent = $("body").html()?.trim();
      delete work.sourceDetailUnavailable;
      savedDetails += 1;
    } else {
      work.sourceDetailUnavailable = true;
      sourceDetailGaps.push({ no: work.no, sourcePath: file, sourceUrl: work.source.url });
    }
  }
  await writeJson(dataFile, works);
  await writeJson(`${root}/recovery.json`, {
    festivalId: id, catalogueEntries: works.length, sourceDetailPages: savedDetails,
    screenshots: screenshotSources, sourceDetailGaps,
    unavailableSourcePages: ["detail.html", "kantan.html"].map((sourcePath) => ({ sourcePath, sourceUrl: new URL(sourcePath, base).href })),
    provenance: { directSource: "investigation/direct-source-probes.json", archive: "source/archive/manifest.json", captureIndex: "investigation/wayback-captures.json" },
    failures: ["SS_3.PNG", "SS_0.PNG"].map((file) => ({ sourceUrl: new URL(file, base).href, error: "No successful capture in the retrieved HTTPS prefix and HTTP success indexes; Japan source probes reset. Full HTTP prefix lookup timed out, so absence is not established." })),
    archiveRegion: "Hong Kong", directSourceRegion: "Japan",
    handling: "Source bytes and body markup archived mechanically, without keyword filtering or content-based restriction decisions. Existing catalogue text preserved; explicit team labels moved from category to group. All pages decode as Shift-JIS without replacement characters; seven detail pages incorrectly declare UTF-8.",
    limitations: ["Japan source probes failed with connection resets.", "Seven successful introduction captures; No.073 has only a redirect capture, plus a separately captured screenshot.", "Other introduction URLs and two auxiliary pages have no successful capture in the retrieved prefix indexes; full HTTP prefix lookup timed out.", "SS_3.PNG and the shared sample SS_0.PNG have no successful capture in the retrieved indexes."],
    desktopReview: "pending",
  });
  console.log(JSON.stringify({ mode: "prepare", catalogueEntries: works.length, savedDetails, sourceDetailGaps: sourceDetailGaps.length, screenshots: screenshotSources.length }));
}

async function main() {
  if (process.argv[2] === "archive-only") return archiveOnly();
  if (process.argv[2] === "prepare") return prepare();
  throw new Error("Use `archive-only --archive-only` or `prepare`.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
