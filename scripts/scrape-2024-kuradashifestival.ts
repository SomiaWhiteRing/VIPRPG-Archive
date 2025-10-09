import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import { execFileSync } from "node:child_process";

const FESTIVAL_ID = "2024-kuradashifestival";
const FESTIVAL_SLUG = "2024-kuradashifestival";
const BASE_URL = "https://tkoolviprpg2421014.web.fc2.com";
const INDEX_URL = `${BASE_URL}/archive_exf1.html`;
const PICKUP_URL = `${BASE_URL}/pickup_exf1.html`;

const OUTPUT_WORKS = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const CATCH_DIR = path.join(process.cwd(), "catch", FESTIVAL_SLUG);
const SUMMARY_PATH = path.join(CATCH_DIR, `${FESTIVAL_SLUG}-scrape-summary.json`);

const PUBLIC_DIR = path.join(process.cwd(), "public");
const BANNERS_DIR = path.join(PUBLIC_DIR, "banners");
const ICONS_DIR = path.join(PUBLIC_DIR, "icons", FESTIVAL_SLUG);
const SCREENSHOTS_DIR = path.join(PUBLIC_DIR, "screenshots", FESTIVAL_SLUG);

const RELATIVE_BANNERS_DIR = "/banners";
const RELATIVE_SCREENSHOTS_DIR = `/screenshots/${FESTIVAL_SLUG}`;

const MAX_SCREENSHOTS = 6;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)" +
  " Chrome/130.0.0.0 Safari/537.36";

interface IndexEntry {
  index: string;
  title: string;
  category?: string;
  engine?: string;
  downloadUrl?: string;
  pickupAnchor?: string; // like #pickup_f1-1
}

interface PickupDetail {
  hostComment?: string;
  screenshots?: string[];
}

interface DownloadResult {
  paths: string[];
  skipped: ScreenshotSkip[];
  failures: string[];
}

interface ScreenshotSkip {
  source: string;
  reason: "small" | "duplicate";
}

interface WorkEntry {
  id: string;
  festivalId: string;
  no?: string;
  title: string;
  author: string;
  category?: string;
  engine?: string;
  streaming?: string;
  forum?: string;
  authorComment?: string;
  hostComment?: string;
  icon?: string;
  ss?: string[];
}

interface SnapshotRecord {
  index: string;
  status: "ok" | "error";
  title?: string;
  icon?: string;
  note?: string;
  downloadSource?: string[];
  screenshotReport?: {
    saved: number;
    skipped?: ScreenshotSkip[];
    failures?: string[];
  };
  error?: string;
}

function sanitizeWhitespace(value: string | undefined | null) {
  if (!value) return undefined;
  const result = value.replace(/\s+/g, " ").trim();
  return result || undefined;
}

function sanitizeMultiline(value: string | undefined | null) {
  if (!value) return undefined;
  const trimmed = value
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return trimmed || undefined;
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function purgeScreenshots(index: string) {
  try {
    const files = await fs.readdir(SCREENSHOTS_DIR);
    await Promise.all(
      files
        .filter((file) => file.startsWith(index))
        .map((file) => fs.unlink(path.join(SCREENSHOTS_DIR, file)).catch(() => undefined))
    );
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      console.warn(`Failed to purge screenshots for ${index}: ${err.message}`);
    }
  }
}

async function fetchText(url: string) {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Connection: "close",
      },
      cache: "no-store",
      redirect: "follow",
      referrerPolicy: "no-referrer",
    });
    if (response.ok) {
      return await response.text();
    }
  } catch {}
  // fallback to curl
  const output = execFileSync("curl", ["-L", "-s", "--fail", url], { encoding: "utf8" });
  return output;
}

interface FetchBinaryResult { buffer: Buffer; contentType: string }
async function fetchBinary(url: string): Promise<FetchBinaryResult> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        Connection: "close",
      },
      cache: "no-store",
      redirect: "follow",
      referrerPolicy: "no-referrer",
    });
    if (response.ok) {
      const arrayBuffer = await response.arrayBuffer();
      return {
        buffer: Buffer.from(arrayBuffer),
        contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
      };
    }
  } catch {}
  // fallback to curl
  const buffer = execFileSync("curl", ["-L", "-s", "--fail", url]);
  return { buffer, contentType: "" };
}

function toAbsoluteUrl(relative: string | undefined, base: string = BASE_URL) {
  if (!relative) return undefined;
  try {
    return new URL(relative, base).toString();
  } catch {
    return undefined;
  }
}

function getImageExtension(input: string, fallback = ".png") {
  const base = input.split(/[?#]/)[0];
  const ext = path.extname(base).toLowerCase();
  if (ext === ".jpeg") return ".jpg";
  if (ext) return ext;
  return fallback;
}

function getImageDimensions(buffer: Buffer) {
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 26 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1;
      if (offset + 1 >= buffer.length) break;
      const marker = buffer[offset + 1];
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (marker === 0xda) break;
      if (offset + 7 >= buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xcc) {
        if (offset + 5 >= buffer.length) break;
        const height = buffer.readUInt16BE(offset + 3);
        const width = buffer.readUInt16BE(offset + 5);
        return { width, height };
      }
      offset += length;
    }
  }
  if (buffer.length >= 10 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length >= 26 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    const width = buffer.readInt32LE(18);
    const height = Math.abs(buffer.readInt32LE(22));
    return { width, height };
  }
  return undefined;
}

function looksLikeImageBuffer(buffer: Buffer, contentType: string) {
  if (contentType.startsWith("image/")) return true;
  if (buffer.length >= 4) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true;
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return true;
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return true;
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) return true;
  }
  return false;
}

async function copyBanner() {
  const bannerUrl = `${BASE_URL}/img/kuradasi_banner24.png`;
  await ensureDir(BANNERS_DIR);
  try {
    const { buffer, contentType } = await fetchBinary(bannerUrl);
    if (!looksLikeImageBuffer(buffer, contentType)) {
      throw new Error(`Non-image response (${contentType || "unknown"})`);
    }
    const destPath = path.join(BANNERS_DIR, `${FESTIVAL_SLUG}.png`);
    await fs.writeFile(destPath, buffer);
    return `${RELATIVE_BANNERS_DIR}/${FESTIVAL_SLUG}.png`;
  } catch (error) {
    console.warn(`Failed to download banner: ${bannerUrl} =>`, error);
    return undefined;
  }
}

async function copyScreenshots(index: string, urls: string[]) {
  await ensureDir(SCREENSHOTS_DIR);
  await purgeScreenshots(index);

  const seenHashes = new Set<string>();
  const seenSources = new Set<string>();
  const candidates: Array<{
    buffer: Buffer;
    extension: string;
    source: string;
    dims?: { width: number; height: number };
  }> = [];
  const skipped: ScreenshotSkip[] = [];
  const failures: string[] = [];

  for (const raw of urls) {
    if (!raw) continue;
    if (seenSources.has(raw)) continue;
    seenSources.add(raw);
    try {
      const { buffer, contentType } = await fetchBinary(raw);
      if (!looksLikeImageBuffer(buffer, contentType)) {
        failures.push(raw);
        continue;
      }
      const dims = getImageDimensions(buffer);
      if (dims && dims.width < 100 && dims.height < 100) {
        skipped.push({ source: raw, reason: "small" });
        continue;
      }
      const hash = createHash("md5").update(buffer).digest("hex");
      if (seenHashes.has(hash)) {
        skipped.push({ source: raw, reason: "duplicate" });
        continue;
      }
      seenHashes.add(hash);
      const extension = getImageExtension(raw, ".png");
      candidates.push({ buffer, extension, source: raw, dims });
    } catch (error) {
      console.warn(`Failed to download screenshot for ${index}: ${raw} =>`, error);
      failures.push(raw);
    }
  }

  if (candidates.length === 0) {
    return { paths: [], skipped, failures } satisfies DownloadResult;
  }

  const HIGH_WIDTH = 400;
  const HIGH_HEIGHT = 300;
  const highQualityExists = candidates.some(
    (item) => item.dims && item.dims.width >= HIGH_WIDTH && item.dims.height >= HIGH_HEIGHT
  );

  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    if (
      highQualityExists &&
      candidate.dims &&
      (candidate.dims.width < HIGH_WIDTH || candidate.dims.height < HIGH_HEIGHT)
    ) {
      skipped.push({ source: candidate.source, reason: "small" });
      continue;
    }
    selected.push(candidate);
  }

  const usable = selected.length > 0 ? selected : candidates;
  const limited = usable.slice(0, MAX_SCREENSHOTS);
  const paths: string[] = [];

  for (let i = 0; i < limited.length; i += 1) {
    const candidate = limited[i];
    const suffix = i === 0 ? "" : `-${String(i + 1).padStart(2, "0")}`;
    const destFile = `${index}${suffix}${candidate.extension}`;
    const destPath = path.join(SCREENSHOTS_DIR, destFile);
    await fs.writeFile(destPath, candidate.buffer);
    paths.push(`${RELATIVE_SCREENSHOTS_DIR}/${destFile}`);
  }

  return { paths, skipped, failures } satisfies DownloadResult;
}

async function parseIndex(): Promise<IndexEntry[]> {
  const html = await fetchText(INDEX_URL);
  await ensureDir(CATCH_DIR);
  await fs.writeFile(path.join(CATCH_DIR, "archive_exf1.html"), html, "utf8");
  const $ = cheerio.load(html);
  const entries: IndexEntry[] = [];

  $("table tr").each((_, tr) => {
    const cells = $(tr).find("td");
    if (cells.length < 5) return; // header or invalid

    const idxText = sanitizeWhitespace($(cells[0]).text());
    const category = sanitizeWhitespace($(cells[1]).text());
    const engine = sanitizeWhitespace($(cells[2]).text());
    const titleAnchor = $(cells[4]).find("a").first();
    const title = sanitizeWhitespace(titleAnchor.text());
    const downloadUrl = titleAnchor.attr("href") || undefined;
    const pickupAnchor = $(cells[5]).find("a").attr("href") || undefined;

    if (!idxText || !title) return;
    // Skip placeholders and EX (reviews)
    if (/EX/i.test(idxText)) return;
    if (/F1-\s*$/i.test(idxText)) return;

    entries.push({
      index: idxText,
      title,
      category,
      engine,
      downloadUrl,
      pickupAnchor,
    });
  });

  return entries;
}

let cachedPickup$: cheerio.CheerioAPI | null = null;
let cachedPickupHtml: string | null = null;
async function getPickup$() {
  if (cachedPickup$) return cachedPickup$;
  try {
    const html = await fetchText(PICKUP_URL);
    await ensureDir(CATCH_DIR);
    await fs.writeFile(path.join(CATCH_DIR, "pickup_exf1.html"), html, "utf8");
    cachedPickupHtml = html;
    cachedPickup$ = cheerio.load(html);
  } catch (error) {
    console.warn("Failed to fetch pickup page", error);
    try {
      const fallback = await fs.readFile(path.join(CATCH_DIR, "pickup_exf1.html"), "utf8");
      cachedPickupHtml = fallback;
      cachedPickup$ = cheerio.load(fallback);
    } catch {
      cachedPickupHtml = "";
      cachedPickup$ = cheerio.load("<html></html>");
    }
  }
  return cachedPickup$;
}

async function parsePickup(anchor: string | undefined): Promise<PickupDetail> {
  if (!anchor) return {};
  const hash = anchor.includes("#") ? anchor.split("#")[1] : anchor;
  if (!hash) return {};
  const $ = await getPickup$();
  // Try robust slice by raw HTML to avoid malformed nesting issues
  if (!cachedPickupHtml) {
    try {
      cachedPickupHtml = await fs.readFile(path.join(CATCH_DIR, "pickup_exf1.html"), "utf8");
    } catch {}
  }
  let sliceRoot: cheerio.Cheerio<cheerio.AnyNode> | null = null;
  if (cachedPickupHtml) {
    const startMarker = `<section id="${hash}">`;
    const idx = cachedPickupHtml.indexOf(startMarker);
    if (idx >= 0) {
      const start = idx + startMarker.length;
      const rest = cachedPickupHtml.slice(start);
      const nextIdx = rest.search(/<section id=\"pickup_[^\"]+\"\s*>/i);
      const block = nextIdx > 0 ? rest.slice(0, nextIdx) : rest;
      const $block = cheerio.load(block);
      sliceRoot = $block.root();
    }
  }
  const scope = sliceRoot ?? $("section").filter((_, el) => $(el).attr("id") === hash);

  const screenshots = scope
    .find("img")[0]
    ? scope
        .find("img")
        .map((_, img) => toAbsoluteUrl($(img).attr("src"), PICKUP_URL))
        .get()
        .filter((x): x is string => Boolean(x))
    : [];

  const comments: string[] = [];
  scope.find("td").each((_, td) => {
    const text = sanitizeWhitespace($(td).text()) || "";
    if (text.startsWith("★")) {
      comments.push(text.replace(/^★\s*/, ""));
    }
  });

  return {
    hostComment: comments.length ? sanitizeMultiline(comments.join("\n\n")) : undefined,
    screenshots,
  };
}

async function processEntry(entry: IndexEntry) {
  const pickup = await parsePickup(entry.pickupAnchor);
  const screenshotSources = new Set<string>();
  for (const src of pickup.screenshots ?? []) {
    screenshotSources.add(src);
  }
  const screenshotResult = await copyScreenshots(entry.index, Array.from(screenshotSources));

  const work: WorkEntry = {
    id: `${FESTIVAL_ID}-work-${entry.index}`,
    festivalId: FESTIVAL_ID,
    no: entry.index,
    title: entry.title,
    author: "",
    category: entry.category,
    engine: entry.engine,
    hostComment: pickup.hostComment,
  };

  if (screenshotResult.paths.length > 0) {
    work.ss = screenshotResult.paths;
  }

  const noteParts: string[] = [];
  const downloadSources = [entry.downloadUrl]
    .filter((x): x is string => Boolean(x))
    .map((x) => toAbsoluteUrl(x, INDEX_URL) ?? x)
    .filter((value, idx, arr) => arr.indexOf(value) === idx);

  if (downloadSources.length > 0) {
    noteParts.push("ダウンロード: 1件");
  } else {
    noteParts.push("ダウンロード: 未提供");
  }
  if (screenshotResult.skipped.length > 0) {
    const small = screenshotResult.skipped.filter((item) => item.reason === "small").length;
    const dup = screenshotResult.skipped.filter((item) => item.reason === "duplicate").length;
    if (small > 0) noteParts.push(`skipped small: ${small}`);
    if (dup > 0) noteParts.push(`skipped dup: ${dup}`);
  }
  if (screenshotResult.failures.length > 0) {
    noteParts.push(`screenshot failures: ${screenshotResult.failures.length}`);
  }

  const snapshot: SnapshotRecord = {
    index: entry.index,
    status: "ok",
    title: work.title,
    icon: work.icon,
    note: noteParts.length ? noteParts.join("; ") : undefined,
    downloadSource: downloadSources.length ? downloadSources : undefined,
    screenshotReport: {
      saved: screenshotResult.paths.length,
      skipped: screenshotResult.skipped.length ? screenshotResult.skipped : undefined,
      failures: screenshotResult.failures.length ? screenshotResult.failures : undefined,
    },
  };

  return { work, snapshot };
}

async function main() {
  await ensureDir(CATCH_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);
  await ensureDir(BANNERS_DIR);

  const banner = await copyBanner();
  const indexEntries = await parseIndex();

  const works: WorkEntry[] = [];
  const snapshots: SnapshotRecord[] = [];

  for (const entry of indexEntries) {
    try {
      const { work, snapshot } = await processEntry(entry);
      works.push(work);
      snapshots.push(snapshot);
    } catch (error) {
      console.error(`Failed to process entry ${entry.index}:`, error);
      snapshots.push({
        index: entry.index,
        status: "error",
        title: entry.title,
        downloadSource: entry.downloadUrl ? [entry.downloadUrl] : undefined,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  works.sort((a, b) => a.id.localeCompare(b.id));
  await fs.writeFile(OUTPUT_WORKS, `${JSON.stringify(works, null, 2)}\n`, "utf8");

  const summary = {
    festivalId: FESTIVAL_ID,
    generatedAt: new Date().toISOString(),
    banner: banner ?? undefined,
    stats: {
      captured: works.length,
      skipped: snapshots.filter((item) => item.status !== "ok").length,
    },
    entries: snapshots,
    unmatched: [],
  };

  await fs.writeFile(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`Captured ${works.length} works. Errors: ${summary.stats.skipped}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
