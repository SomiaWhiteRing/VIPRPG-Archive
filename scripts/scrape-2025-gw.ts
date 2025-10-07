import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const execFileAsync = promisify(execFile);

const FESTIVAL_ID = "2025-gw";
const FESTIVAL_SLUG = "2025-gw";
const CATCH_DIR = path.join(process.cwd(), "catch", FESTIVAL_SLUG);
const OUTPUT_WORKS = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const SUMMARY_PATH = path.join(CATCH_DIR, `${FESTIVAL_SLUG}-scrape-summary.json`);
const JAM_HTML = path.join(CATCH_DIR, "jam.html");
const ENTRIES_DATA_JSON = path.join(CATCH_DIR, "entries-data.json");
const GAME_CACHE_DIR = path.join(CATCH_DIR, "game");

const PUBLIC_DIR = path.join(process.cwd(), "public");
const BANNERS_DIR = path.join(PUBLIC_DIR, "banners");
const ICONS_DIR = path.join(PUBLIC_DIR, "icons", FESTIVAL_SLUG);
const SCREENSHOTS_DIR = path.join(PUBLIC_DIR, "screenshots", FESTIVAL_SLUG);

const RELATIVE_BANNERS_DIR = "/banners";
const RELATIVE_ICONS_DIR = `/icons/${FESTIVAL_SLUG}`;
const RELATIVE_SCREENSHOTS_DIR = `/screenshots/${FESTIVAL_SLUG}`;
const MAX_SCREENSHOTS = 6;

const CURL_BASE_ARGS = ["--silent", "--show-error", "--retry", "3", "--retry-delay", "1", "--compressed"];

interface TableEntry {
  index: string;
  rateUrl: string;
  title: string;
  author: string;
  category?: string;
  engine?: string;
  streaming?: string;
  iconUrl?: string;
  downloadLink?: string;
  downloadLabel?: string;
  forumLink?: string;
}

interface JamGameEntry {
  rateUrl: string;
  gameUrl: string;
  title: string;
  author: string;
  cover?: string;
  shortText?: string;
}

interface ScreenshotSkip {
  source: string;
  reason: "small" | "duplicate";
}

interface ScreenshotResult {
  paths: string[];
  failures: string[];
  skipped: ScreenshotSkip[];
}

interface WorkEntry {
  id: string;
  festivalId: string;
  title: string;
  icon?: string;
  category?: string;
  engine?: string;
  author: string;
  streaming?: string;
  forum?: string;
  authorComment?: string;
  ss?: string[];
}

interface SnapshotRecord {
  index: string;
  status: "ok" | "skipped" | "error";
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

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function sanitizeWhitespace(value: string | undefined) {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed || undefined;
}

function normalizeUrl(url: string | undefined, base?: string) {
  if (!url) return undefined;
  try {
    return new URL(url, base ?? "https://itch.io").toString();
  } catch {
    return undefined;
  }
}

async function runCurl(args: string[], options?: { encoding?: BufferEncoding | "buffer" }) {
  const { stdout } = await execFileAsync("curl", args, { encoding: options?.encoding ?? "utf8" });
  return stdout as unknown as string;
}

async function downloadBinary(url: string) {
  const args = [...CURL_BASE_ARGS, "--location", "--fail", url];
  const { stdout } = await execFileAsync("curl", args, { encoding: "buffer" }) as unknown as { stdout: Buffer };
  return stdout;
}

function bufferLooksLikeHtml(buffer: Buffer) {
  if (buffer.length === 0) return true;
  if (buffer[0] === 0x3c) {
    const second = buffer[1];
    if (second === 0x21 || second === 0x68 || second === 0x48 || second === 0x3f) {
      return true;
    }
  }
  try {
    const sample = buffer.slice(0, 256).toString("utf8").trimStart().toLowerCase();
    if (!sample) return false;
    return sample.startsWith("<!doctype") || sample.startsWith("<html") || sample.startsWith("<head") || sample.startsWith("<body");
  } catch {
    return false;
  }
}

function getImageExtension(url: string, fallback = ".png") {
  const clean = url.split(/[?#]/)[0];
  const ext = path.extname(clean).toLowerCase();
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
      if (offset + 1 >= buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      const isSOF =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSOF) {
        if (length >= 7) {
          const height = buffer.readUInt16BE(offset + 3);
          const width = buffer.readUInt16BE(offset + 5);
          return { width, height };
        }
        break;
      }
      offset += length;
    }
  }
  if (buffer.length >= 10) {
    const header = buffer.toString("ascii", 0, 6);
    if (header === "GIF87a" || header === "GIF89a") {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
  }
  if (buffer.length >= 26 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    const width = buffer.readInt32LE(18);
    const height = Math.abs(buffer.readInt32LE(22));
    return { width, height };
  }
  return undefined;
}

async function ensureBanner() {
  const html = await fs.readFile(JAM_HTML, "utf8");
  const $ = cheerio.load(html);
  const content = $(".jam_content").first();
  let bannerUrl: string | undefined;
  content.find("img").each((_, el) => {
    if (bannerUrl) return;
    const src = normalizeUrl($(el).attr("src"));
    if (!src) return;
    if (!/img\.itch\.zone\/aW1n/i.test(src)) return;
    bannerUrl = src;
  });
  if (!bannerUrl) return undefined;
  await ensureDir(BANNERS_DIR);
  const extension = getImageExtension(bannerUrl, ".png");
  const fileName = `${FESTIVAL_SLUG}${extension}`;
  const destPath = path.join(BANNERS_DIR, fileName);
  if (!(await fileExists(destPath))) {
    const buffer = await downloadBinary(bannerUrl);
    if (bufferLooksLikeHtml(buffer) || buffer.length === 0) {
      return undefined;
    }
    await fs.writeFile(destPath, buffer);
  }
  return `${RELATIVE_BANNERS_DIR}/${fileName}`;
}

async function ensureIcon(index: string, iconUrl: string | undefined) {
  if (!iconUrl) return undefined;
  await ensureDir(ICONS_DIR);
  const extension = getImageExtension(iconUrl, ".png");
  const fileName = `${index}${extension}`;
  const destPath = path.join(ICONS_DIR, fileName);
  if (await fileExists(destPath)) {
    return `${RELATIVE_ICONS_DIR}/${fileName}`;
  }
  try {
    const buffer = await downloadBinary(iconUrl);
    if (bufferLooksLikeHtml(buffer)) {
      return undefined;
    }
    await fs.writeFile(destPath, buffer);
    return `${RELATIVE_ICONS_DIR}/${fileName}`;
  } catch (error) {
    console.warn(`Failed to download icon for ${index}: ${iconUrl} =>`, error);
    return undefined;
  }
}

async function fileExists(target: string) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function purgeScreenshots(index: string) {
  try {
    const files = await fs.readdir(SCREENSHOTS_DIR);
    await Promise.all(
      files
        .filter((file) => file.startsWith(index))
        .map((file) => fs.unlink(path.join(SCREENSHOTS_DIR, file)).catch(() => undefined)),
    );
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw error;
  }
}

function canonicalScreenshotKey(url: string) {
  const withoutParams = url.split(/[?#]/)[0];
  const normalized = withoutParams.replace(/\/\d+x\d+(?:%23c)?\//i, "/original/");
  return normalized.toLowerCase();
}

async function ensureScreenshots(index: string, candidates: string[]) {
  if (candidates.length === 0) {
    return { paths: [], failures: [], skipped: [] } satisfies ScreenshotResult;
  }
  await ensureDir(SCREENSHOTS_DIR);
  const seenHashes = new Set<string>();
  const paths: string[] = [];
  const failures: string[] = [];
  const skipped: ScreenshotSkip[] = [];
  await purgeScreenshots(index);

  for (const url of candidates) {
    if (paths.length >= MAX_SCREENSHOTS) {
      break;
    }
    try {
      const buffer = await downloadBinary(url);
      if (bufferLooksLikeHtml(buffer) || buffer.length === 0) {
        failures.push(url);
        continue;
      }
      const dims = getImageDimensions(buffer);
      if (dims && dims.width < 100 && dims.height < 100) {
        skipped.push({ source: url, reason: "small" });
        continue;
      }
      const hash = createHash("md5").update(buffer).digest("hex");
      if (seenHashes.has(hash)) {
        skipped.push({ source: url, reason: "duplicate" });
        continue;
      }
      seenHashes.add(hash);
      const suffix = paths.length > 0 ? `-${String(paths.length + 1).padStart(2, "0")}` : "";
      const extension = getImageExtension(url, ".png");
      const fileName = `${index}${suffix}${extension}`;
      const destPath = path.join(SCREENSHOTS_DIR, fileName);
      await fs.writeFile(destPath, buffer);
      paths.push(`${RELATIVE_SCREENSHOTS_DIR}/${fileName}`);
    } catch {
      failures.push(url);
    }
  }

  return { paths, failures, skipped } satisfies ScreenshotResult;
}

function cleanTitle(raw: string) {
  return raw.replace(/[★☆◎◇◆△▽※♪♭♫\s]+/g, " ").trim();
}

function parseTable(): Promise<Map<string, TableEntry>> {
  return fs.readFile(JAM_HTML, "utf8").then((content) => {
    const $ = cheerio.load(content);
    const rows = new Map<string, TableEntry>();
    $("table tbody tr").each((_, element) => {
      const cells = $(element).find("td");
      if (cells.length < 3) return;
      const indexText = sanitizeWhitespace(cells.eq(0).text());
      if (!indexText) return;
      const titleCell = cells.eq(2);
      const link = titleCell.find("a[href]").first();
      const rateUrlRaw = link.attr("href");
      const rateUrl = normalizeUrl(rateUrlRaw, "https://itch.io");
      if (!rateUrl) return;
      const iconUrl = normalizeUrl(cells.eq(1).find("img").attr("src"));
      const title = cleanTitle(link.text());
      const author = sanitizeWhitespace(cells.eq(3).text()) ?? "";
      const category = sanitizeWhitespace(cells.eq(4).text());
      const engine = sanitizeWhitespace(cells.eq(5).text());
      const streaming = sanitizeWhitespace(cells.eq(6).text());
      const downloadAnchor = cells.eq(7).find("a[href]").first();
      const downloadLink = normalizeUrl(downloadAnchor.attr("href"));
      const downloadLabel = sanitizeWhitespace(downloadAnchor.text());
      const forumAnchor = cells.eq(8).find("a[href]").first();
      const forumLink = normalizeUrl(forumAnchor?.attr("href"));

      rows.set(rateUrl, {
        index: indexText.padStart(2, "0"),
        rateUrl,
        title,
        author,
        category,
        engine,
        streaming,
        iconUrl,
        downloadLink,
        downloadLabel,
        forumLink,
      });
    });
    return rows;
  });
}

async function parseEntriesData(): Promise<Map<string, JamGameEntry>> {
  const raw = await fs.readFile(ENTRIES_DATA_JSON, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.jam_games)) {
    throw new Error("entries-data.json does not contain jam_games array");
  }
  const map = new Map<string, JamGameEntry>();
  for (const item of parsed.jam_games) {
    const rateUrl = normalizeUrl(item.url, "https://itch.io");
    const gameUrl = normalizeUrl(item.game?.url);
    if (!rateUrl || !gameUrl) continue;
    const entry: JamGameEntry = {
      rateUrl,
      gameUrl,
      title: item.game?.title ?? "",
      author: item.game?.user?.name ?? item.game?.user?.url ?? "",
      cover: item.game?.cover,
      shortText: item.game?.short_text,
    };
    map.set(rateUrl, entry);
  }
  return map;
}

function sanitizeFileName(input: string) {
  return input.replace(/[^a-z0-9-_]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

async function fetchGameHtml(index: string, jamEntry: JamGameEntry) {
  await ensureDir(GAME_CACHE_DIR);
  const slugPart = sanitizeFileName(jamEntry.gameUrl);
  const filePath = path.join(GAME_CACHE_DIR, `${index}_${slugPart}.html`);
  if (await fileExists(filePath)) {
    return fs.readFile(filePath, "utf8");
  }
  const html = await runCurl([...CURL_BASE_ARGS, "--location", "--fail", jamEntry.gameUrl], { encoding: "utf8" });
  await fs.writeFile(filePath, html, "utf8");
  return html;
}

function extractDescription($: cheerio.CheerioAPI) {
  const container = $(".formatted_description").first();
  if (!container.length) return undefined;
  container.find("script,style").remove();
  const html = container.html();
  if (!html) return undefined;
  const normalized = html.replace(/<br\s*\/?\s*>/gi, "\n");
  const text = cheerio.load(`<div>${normalized}</div>`, undefined, false)("div").text();
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line, idx, arr) => line || (idx > 0 && arr[idx - 1] !== ""));
  const result = lines.join("\n").trim();
  return result || undefined;
}

function collectScreenshotCandidates($: cheerio.CheerioAPI, jamEntry: JamGameEntry) {
  const order: string[] = [];
  const candidates = new Map<string, { url: string; weight: number }>();
  let hasGalleryImages = false;
  let hasAnchors = false;

  const remember = (raw: string | undefined, opts?: { markGallery?: boolean }) => {
    if (!raw) return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (/^(true|false|javascript:|#)$/i.test(trimmed)) return;
    const normalized = normalizeUrl(trimmed);
    if (!normalized || !/^https?:/i.test(normalized)) return;
    if (opts?.markGallery) {
      hasGalleryImages = true;
    }
    const key = canonicalScreenshotKey(normalized);
    const weight = normalized.includes("/original/") ? 0 : normalized.match(/\/\d+x\d+(?:%23c)?\//i) ? 1 : 0;
    if (!candidates.has(key)) {
      candidates.set(key, { url: normalized, weight });
      order.push(key);
    } else {
      const current = candidates.get(key)!;
      if (weight < current.weight) {
        candidates.set(key, { url: normalized, weight });
      }
    }
  };

  $(".screenshot_list a[href]").each((_, el) => {
    hasAnchors = true;
    remember($(el).attr("href"), { markGallery: true });
    remember($(el).attr("data-image_lightbox"), { markGallery: true });
  });

  if (!hasAnchors) {
    $(".screenshot_list img[src]").each((_, el) => {
      remember($(el).attr("src"), { markGallery: true });
    });
  }

  if (!hasGalleryImages && jamEntry.cover) {
    remember(jamEntry.cover);
    const coverOriginal = jamEntry.cover.replace(/\/\d+x\d+(?:%23c)?\//i, "/original/");
    remember(coverOriginal);
  }

  return order.map((key) => candidates.get(key)!.url);
}

function extractDownloadSources(table: TableEntry, $: cheerio.CheerioAPI, gameUrl: string) {
  const sources = new Set<string>();
  if (table.downloadLink) sources.add(table.downloadLink);
  if (gameUrl) sources.add(gameUrl);
  const scriptText = $("script")
    .map((_, el) => $(el).html() ?? "")
    .get()
    .join("\n");
  const match = scriptText.match(/\"generate_download_url\":\"([^\"]+)\"/);
  if (match) {
    sources.add(match[1].replace(/\\\//g, "/"));
  }
  return Array.from(sources);
}

async function processEntry(table: TableEntry, jamEntry: JamGameEntry) {
  const index = table.index;
  const html = await fetchGameHtml(index, jamEntry);
  const $ = cheerio.load(html);
  const description = extractDescription($);
  const screenshotCandidates = collectScreenshotCandidates($, jamEntry);
  const screenshotResult = await ensureScreenshots(index, screenshotCandidates);
  const iconPath = await ensureIcon(index, table.iconUrl);

  const work: WorkEntry = {
    id: `${FESTIVAL_ID}-work-${index}`,
    festivalId: FESTIVAL_ID,
    title: table.title || jamEntry.title,
    category: table.category,
    engine: table.engine,
    author: table.author || jamEntry.author,
    streaming: table.streaming,
    forum: table.forumLink,
    authorComment: description ?? jamEntry.shortText ?? undefined,
  };

  if (iconPath) {
    work.icon = iconPath;
  }
  if (screenshotResult.paths.length > 0) {
    work.ss = screenshotResult.paths;
  }

  const noteParts: string[] = [];
  if (screenshotResult.failures.length > 0) {
    noteParts.push(`screenshot failures: ${screenshotResult.failures.length}`);
  }
  const skippedSmall = screenshotResult.skipped.filter((item) => item.reason === "small").length;
  if (skippedSmall > 0) {
    noteParts.push(`skipped small images: ${skippedSmall}`);
  }
  const skippedDup = screenshotResult.skipped.filter((item) => item.reason === "duplicate").length;
  if (skippedDup > 0) {
    noteParts.push(`skipped duplicates: ${skippedDup}`);
  }

  const snapshot: SnapshotRecord = {
    index,
    status: "ok",
    title: work.title,
    icon: work.icon,
    note: noteParts.length ? noteParts.join("; ") : undefined,
    downloadSource: extractDownloadSources(table, $, jamEntry.gameUrl),
    screenshotReport: {
      saved: screenshotResult.paths.length,
      skipped: screenshotResult.skipped.length ? screenshotResult.skipped : undefined,
      failures: screenshotResult.failures.length ? screenshotResult.failures : undefined,
    },
  };

  return { work, snapshot };
}

async function main() {
  await ensureDir(BANNERS_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);
  await ensureDir(GAME_CACHE_DIR);

  const bannerLocal = await ensureBanner();
  const [tableMap, jamMap] = await Promise.all([parseTable(), parseEntriesData()]);

  const works: WorkEntry[] = [];
  const snapshots: SnapshotRecord[] = [];
  const missingTable: SnapshotRecord[] = [];

  for (const [rateUrl, tableEntry] of tableMap) {
    const jamEntry = jamMap.get(rateUrl);
    if (!jamEntry) {
      snapshots.push({
        index: tableEntry.index,
        status: "skipped",
        title: tableEntry.title,
        note: "rate URL not present in jam data",
        downloadSource: tableEntry.downloadLink ? [tableEntry.downloadLink] : undefined,
      });
      continue;
    }
    jamMap.delete(rateUrl);
    try {
      const { work, snapshot } = await processEntry(tableEntry, jamEntry);
      works.push(work);
      snapshots.push(snapshot);
    } catch (error) {
      const sources = [tableEntry.downloadLink, jamEntry.gameUrl].filter((value): value is string => Boolean(value));
      snapshots.push({
        index: tableEntry.index,
        status: "error",
        title: tableEntry.title,
        downloadSource: sources.length ? sources : undefined,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const jamEntry of jamMap.values()) {
    missingTable.push({
      index: "?",
      status: "skipped",
      title: jamEntry.title,
      note: "entry present in jam data but missing from overview table",
      downloadSource: [jamEntry.gameUrl],
    });
  }

  works.sort((a, b) => a.id.localeCompare(b.id));
  await fs.writeFile(OUTPUT_WORKS, `${JSON.stringify(works, null, 2)}\n`, "utf8");

  const summary = {
    festivalId: FESTIVAL_ID,
    generatedAt: new Date().toISOString(),
    banner: bannerLocal ? `${bannerLocal}` : undefined,
    stats: {
      captured: works.length,
      skipped: snapshots.filter((item) => item.status !== "ok").length,
    },
    entries: snapshots,
    unmatched: missingTable,
  };

  await fs.writeFile(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(`Captured ${works.length} works. Skipped: ${summary.stats.skipped}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
