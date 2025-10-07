import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import iconv from "iconv-lite";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const execFileAsync = promisify(execFile);

const FESTIVAL_ID = "2010-kouhaku";
const FESTIVAL_SLUG = "2010-kouhaku";
const BASE_HOST = "vipkohaku20102.web.fc2.com";
const HTTPS_BASE = `https://${BASE_HOST}`;
const DOWNLOAD_BASE = "https://files.viprpg-archive.local";

const CATCH_DIR = path.join(process.cwd(), "catch");
const ENTRY_DIR = path.join(CATCH_DIR, "entry");
const OUTPUT_WORKS = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const SUMMARY_PATH = path.join(CATCH_DIR, `${FESTIVAL_SLUG}-scrape-summary.json`);
const MENU_ENTRY_HTML = path.join(CATCH_DIR, "menu_entry.html");
const MENU_TOP_HTML = path.join(CATCH_DIR, "menu_top.html");

const PUBLIC_DIR = path.join(process.cwd(), "public");
const BANNERS_DIR = path.join(PUBLIC_DIR, "banners");
const ICONS_DIR = path.join(PUBLIC_DIR, "icons", FESTIVAL_SLUG);
const SCREENSHOTS_DIR = path.join(PUBLIC_DIR, "screenshots", FESTIVAL_SLUG);

const RELATIVE_BANNERS_DIR = "/banners";
const RELATIVE_ICONS_DIR = `/icons/${FESTIVAL_SLUG}`;
const RELATIVE_SCREENSHOTS_DIR = `/screenshots/${FESTIVAL_SLUG}`;

const MENU_ENTRY_SOURCES = [
  "https://web.archive.org/web/20230223054223fw_/https://vipkohaku20102.web.fc2.com/index_entry.html",
  "https://vipkohaku20102.web.fc2.com/index_entry.html",
];

const MENU_TOP_SOURCES = [
  "https://web.archive.org/web/20230223054157fw_/https://vipkohaku20102.web.fc2.com/menu_top.html",
  "https://vipkohaku20102.web.fc2.com/menu_top.html",
];

const CURL_BASE_ARGS = ["--silent", "--show-error", "--retry", "3", "--retry-delay", "1", "--compressed"];

interface EntryMeta {
  no: string;
  href: string;
  rawTitle: string;
}

interface WorkEntry {
  id: string;
  festivalId: string;
  title: string;
  icon?: string;
  category?: string;
  engine?: string;
  author: string;
  download: { url: string };
  forum?: string;
  authorComment?: string;
  hostComment?: string;
  ss?: string[];
}

interface SnapshotRecord {
  no: string;
  status: "ok" | "missing" | "parse-error";
  title?: string;
  icon?: string;
  note?: string;
  error?: string;
  skippedScreenshots?: string[];
}

interface ScreenshotSkip {
  source: string;
  reason: "small" | "duplicate";
}

interface ImageDimensions {
  width: number;
  height: number;
}

interface ScreenshotResult {
  paths: string[];
  failures: string[];
  skipped: ScreenshotSkip[];
}

interface EntryProcessingResult {
  work: WorkEntry;
  snapshot: SnapshotRecord;
  screenshotFailures: { no: string; sources: string[] } | undefined;
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runCurlBuffer(args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync("curl", args, { encoding: "buffer" }) as unknown as { stdout: Buffer };
  return stdout;
}

async function runCurlString(args: string[]): Promise<string> {
  const buffer = await runCurlBuffer(args);
  return buffer.toString("utf8");
}

async function downloadWithCurl(url: string, destPath: string) {
  await ensureDir(path.dirname(destPath));
  await execFileAsync("curl", [...CURL_BASE_ARGS, "--location", "--fail", url, "-o", destPath], { encoding: "buffer" });
}

async function fetchAssetBuffer(url: string) {
  const args = [...CURL_BASE_ARGS, "--location", "--fail", url];
  const { stdout } = await execFileAsync("curl", args, { encoding: "buffer" }) as unknown as { stdout: Buffer };
  return stdout;
}

function bufferLooksLikeHtml(buffer: Buffer) {
  if (buffer.length === 0) return false;
  if (buffer[0] === 0x3c) {
    const second = buffer[1];
    if (second === 0x21 || second === 0x3f || second === 0x68 || second === 0x48) {
      return true;
    }
  }
  try {
    const sample = buffer.slice(0, 256).toString("utf8");
    const trimmed = sample.trimStart().toLowerCase();
    if (!trimmed) return false;
    return trimmed.startsWith("<!doctype") || trimmed.startsWith("<html") || trimmed.startsWith("<head") || trimmed.startsWith("<body");
  } catch {
    return false;
  }
}

function readJpegDimensions(buffer: Buffer): ImageDimensions | undefined {
  let offset = 2;
  while (offset + 7 < buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) {
      offset += 1;
    }
    if (offset + 1 >= buffer.length) break;
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) {
      continue;
    }
    if (marker === 0xda) {
      break;
    }
    if (offset + 1 >= buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) {
      break;
    }
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      if (length >= 7) {
        const height = buffer.readUInt16BE(offset + 3);
        const width = buffer.readUInt16BE(offset + 5);
        if (width > 0 && height > 0) {
          return { width, height };
        }
      }
      break;
    }
    offset += length;
  }
  return undefined;
}

function getImageDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width > 0 && height > 0) {
      return { width, height };
    }
    return undefined;
  }
  if (buffer.length >= 10) {
    const header = buffer.toString("ascii", 0, 6);
    if (header === "GIF87a" || header === "GIF89a") {
      const width = buffer.readUInt16LE(6);
      const height = buffer.readUInt16LE(8);
      if (width > 0 && height > 0) {
        return { width, height };
      }
      return undefined;
    }
  }
  if (buffer.length >= 26 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return readJpegDimensions(buffer);
  }
  if (buffer.length >= 26 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    const width = buffer.readInt32LE(18);
    const height = Math.abs(buffer.readInt32LE(22));
    if (width > 0 && height > 0) {
      return { width, height };
    }
    return undefined;
  }
  return undefined;
}

async function purgeEntryScreenshots(no: string) {
  try {
    const files = await fs.readdir(SCREENSHOTS_DIR);
    await Promise.all(
      files
        .filter((file) => file.startsWith(no))
        .map((file) => fs.unlink(path.join(SCREENSHOTS_DIR, file)).catch(() => undefined)),
    );
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw error;
    }
  }
}

async function readHtmlFile(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const utf8 = buffer.toString("utf8");
  const lower = utf8.slice(0, 512).toLowerCase();
  if (lower.includes("charset=utf-8") || lower.includes("encoding=\"utf-8\"")) {
    return utf8;
  }
  try {
    return iconv.decode(buffer, "shift_jis");
  } catch {
    return utf8;
  }
}

function assetExtensionFromPath(input: string) {
  const base = input.split(/[?#]/)[0];
  const ext = path.extname(base).toLowerCase();
  if (!ext) return ".png";
  if (ext === ".jpeg") return ".jpg";
  return ext;
}

function normalizeUrl(url: string | undefined) {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  if (/^https?:/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`;
  }
  if (trimmed.startsWith("/")) {
    return `${HTTPS_BASE}${trimmed}`;
  }
  return `${HTTPS_BASE}/${trimmed}`;
}

function sanitizeUrl(url: string) {
  const replaced = url.replace(/\^/g, "%5E");
  try {
    return new URL(replaced).toString();
  } catch {
    try {
      return new URL(encodeURI(replaced)).toString();
    } catch {
      return encodeURI(replaced);
    }
  }
}

function extractArchiveInfo(url: string) {
  const match = url.match(/^https?:\/\/web\.archive\.org\/web\/(\d{14})(?:[a-z_]+)?\/(https?:\/\/.+)$/i);
  if (match) {
    return { direct: match[2], timestamp: match[1] };
  }
  return { direct: url, timestamp: undefined };
}

function buildArchiveCandidates(directUrl: string, timestamps: Iterable<string>) {
  const candidates = new Set<string>();
  candidates.add(directUrl);
  if (directUrl.startsWith("https://")) {
    candidates.add(directUrl.replace("https://", "http://"));
  } else if (directUrl.startsWith("http://")) {
    candidates.add(directUrl.replace("http://", "https://"));
  }
  for (const ts of timestamps) {
    candidates.add(`https://web.archive.org/web/${ts}im_/${directUrl}`);
    candidates.add(`https://web.archive.org/web/${ts}fw_/${directUrl}`);
    candidates.add(`https://web.archive.org/web/${ts}id_/${directUrl}`);
  }
  return Array.from(candidates);
}

function labelFromUrl(url: string) {
  if (url.includes("web.archive.org")) {
    const match = url.match(/web\/(\d{14})/);
    return match ? `wayback-${match[1]}` : "wayback";
  }
  if (url.startsWith("https://")) return "direct-https";
  if (url.startsWith("http://")) return "direct-http";
  return "direct";
}

async function fetchSnapshotTimestamps(sourceUrl: string) {
  const encoded = encodeURIComponent(sourceUrl);
  const apiUrl = `https://web.archive.org/cdx/search/cdx?url=${encoded}&output=json&filter=statuscode:200`;
  try {
    const response = await runCurlString([...CURL_BASE_ARGS, apiUrl]);
    const trimmed = response.trim();
    if (!trimmed || trimmed === "[]") return [] as string[];
    const data = JSON.parse(trimmed) as unknown[];
    if (!Array.isArray(data) || data.length < 2) return [] as string[];
    const timestamps: string[] = [];
    for (const row of data.slice(1)) {
      if (Array.isArray(row) && typeof row[1] === "string") {
        timestamps.push(row[1]);
      }
    }
    return timestamps;
  } catch {
    return [] as string[];
  }
}

async function fetchHtmlToFile(destPath: string, sources: string[]) {
  if (await fileExists(destPath)) {
    return;
  }
  for (const source of sources) {
    try {
      await downloadWithCurl(source, destPath);
      return;
    } catch {
      // try next source
    }
  }
  throw new Error(`Failed to download HTML for ${destPath}`);
}

async function fetchEntryHtml(no: string, href: string, baseUrl: string) {
  const candidates: string[] = [];
  try {
    const resolved = new URL(href, baseUrl).href;
    candidates.push(resolved);
    const info = extractArchiveInfo(resolved);
    if (info.direct !== resolved) {
      candidates.push(info.direct);
    }
  } catch {
    const normalized = normalizeUrl(href);
    if (normalized) {
      candidates.push(normalized);
    }
  }
  const directCandidate = normalizeUrl(href);
  if (directCandidate && !candidates.includes(directCandidate)) {
    candidates.push(directCandidate);
  }
  const httpCandidate = directCandidate?.replace("https://", "http://");
  if (httpCandidate && !candidates.includes(httpCandidate)) {
    candidates.push(httpCandidate);
  }
  if (!candidates.length) {
    throw new Error(`No entry URL candidates for ${no}`);
  }
  for (const candidate of candidates) {
    const label = labelFromUrl(candidate).replace(/[^a-z0-9-_]+/gi, "-");
    const destPath = path.join(ENTRY_DIR, `${no}_${label}.html`);
    try {
      if (!(await fileExists(destPath))) {
        await downloadWithCurl(candidate, destPath);
      }
      const html = await readHtmlFile(destPath);
      const info = extractArchiveInfo(candidate);
      return { html, entryUrl: candidate, entryTimestamp: info.timestamp };
    } catch {
      // continue trying
    }
  }
  throw new Error(`Unable to download entry HTML for ${no}`);
}

function collectScreenshotCandidates($: cheerio.Root, table: cheerio.Cheerio, entryUrl: string) {
  const candidates = new Set<string>();
  const pattern = /([\w./-]*ss\/[0-9A-Za-z_-]+\.(?:png|jpe?g|gif|bmp))/gi;
  const record = (value: string | undefined) => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const matches = [...trimmed.matchAll(pattern)];
    for (const match of matches) {
      try {
        const absolute = new URL(match[1], entryUrl).href;
        candidates.add(absolute);
      } catch {
        // ignore
      }
    }
    try {
      const absolute = new URL(trimmed, entryUrl);
      if (/\.(png|jpe?g|gif|bmp)$/i.test(absolute.pathname)) {
        candidates.add(absolute.href);
      }
    } catch {
      // ignore
    }
  };
  table.find("img").each((_, el) => {
    const img = $(el);
    record(img.attr("src"));
    const attribs = (el as cheerio.Element).attribs ?? {};
    for (const value of Object.values(attribs)) {
      if (typeof value !== "string") continue;
      record(value);
      value.split(/\s+/).forEach((token) => record(token));
    }
  });
  table.find("a").each((_, el) => {
    record($(el).attr("href"));
  });
  return Array.from(candidates);
}

function cleanTitle(rawTitle: string) {
  return rawTitle.replace(/[★●◎◇◆○■□△▽☆※♪♭♫]/g, "").trim();
}

function decodeHtmlFragment(html: string) {
  const normalized = html.replace(/<br\s*\/?\s*>/gi, "\n");
  const text = cheerio.load(`<div>${normalized}</div>`, undefined, false)("div").text();
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const result: string[] = [];
  for (const line of lines) {
    if (!line) {
      if (result.length === 0 || result[result.length - 1] === "") continue;
      result.push("");
    } else {
      result.push(line);
    }
  }
  return result.join("\n");
}

function resolveForum(anchors: cheerio.Element[], $: cheerio.Root) {
  for (const anchor of anchors) {
    const href = $(anchor).attr("href");
    const label = $(anchor).text();
    if (!href) continue;
    if (/jbbs|otaku|bbs|thread|forum/i.test(href)) return href;
    if (/掲示板|スレ|BBS/i.test(label)) return href;
  }
  return undefined;
}

function resolveExternalDownload(anchors: cheerio.Element[], $: cheerio.Root) {
  for (const anchor of anchors) {
    const href = $(anchor).attr("href");
    if (!href) continue;
    if (/\.zip|ux\.getuploader|drive|dropbox|onedrive|mega|storage.googleapis/i.test(href)) {
      return href;
    }
  }
  return undefined;
}
function parseEntryHtml(no: string, html: string, entryUrl: string) {
  const $ = cheerio.load(html);
  const infoTable = $('table[bgcolor="#000000"][cellpadding="1"]').first();
  if (!infoTable.length) {
    throw new Error("information table not found");
  }
  const rows = infoTable.find('> tbody > tr').toArray();
  const textOf = (row: cheerio.Element) => $(row).text().replace(/[\s\u3000]+/g, " ").trim();
  const htmlOf = (row: cheerio.Element) => $(row).find("font").first().html() ?? $(row).html() ?? "";

  const titleRow = rows.find((row) => textOf(row).startsWith("No"));
  if (!titleRow) throw new Error("title row missing");
  const rawTitle = textOf(titleRow).replace(/^No\d+\.\s*-?\s*/, "");
  const title = cleanTitle(rawTitle);
  const numberMatch = textOf(titleRow).match(/^No(\d+)/);
  if (numberMatch && numberMatch[1] !== no) {
    throw new Error(`entry number mismatch: expected ${no}, got ${numberMatch[1]}`);
  }

  const engineRow = rows.find((row) => textOf(row).startsWith("使用"));
  const engine = engineRow ? textOf(engineRow).replace(/^使用[^：]*：?/, "").trim() : undefined;

  const authorRow = rows.find((row) => textOf(row).startsWith("作者"));
  const author = authorRow ? textOf(authorRow).replace(/^作者：?/, "").trim() : "unknown";

  const genreRow = rows.find((row) => textOf(row).startsWith("ジャンル"));
  const category = genreRow ? textOf(genreRow).replace(/^ジャンル：?/, "").trim() : undefined;

  const downloadRow = rows.find((row) => textOf(row).includes("ダウンロード"));
  const anchors = downloadRow ? $(downloadRow).find("a").toArray() : [];
  const forumRaw = resolveForum(anchors, $);
  const externalRaw = resolveExternalDownload(anchors, $);
  const forum = forumRaw ? sanitizeUrl(new URL(forumRaw, entryUrl).href) : undefined;
  const externalDownload = externalRaw ? sanitizeUrl(new URL(externalRaw, entryUrl).href) : undefined;

  let authorComment: string | undefined;
  const genreIndex = genreRow ? rows.indexOf(genreRow) : -1;
  if (genreIndex >= 0) {
    for (let idx = genreIndex + 1; idx < rows.length; idx += 1) {
      const row = rows[idx];
      const text = textOf(row);
      if (!text) continue;
      if (text.startsWith("管理人コメント")) break;
      if (text.includes("ダウンロード")) break;
      if (text.startsWith("◆")) continue;
      authorComment = decodeHtmlFragment(htmlOf(row));
      if (authorComment) break;
    }
  }

  const hostRow = rows.find((row) => textOf(row).startsWith("管理人コメント"));
  const hostComment = hostRow ? textOf(hostRow).replace(/^管理人コメント：?/, "").trim() : undefined;

  const iconImg = infoTable.find('img[src*="icon/"]').first();
  const iconUrl = iconImg.attr("src") ? sanitizeUrl(new URL(iconImg.attr("src")!, entryUrl).href) : undefined;
  const screenshotUrls = collectScreenshotCandidates($, infoTable, entryUrl);

  const work: WorkEntry = {
    id: `${FESTIVAL_ID}-work-${no}`,
    festivalId: FESTIVAL_ID,
    title,
    category,
    engine,
    author,
    download: { url: `${DOWNLOAD_BASE}/${FESTIVAL_SLUG}/${FESTIVAL_SLUG}-${no}.zip` },
    forum,
    authorComment,
    hostComment,
  };

  if (externalDownload) {
    work.download.url = externalDownload;
  }

  return { work, iconUrl, screenshotUrls };
}

async function ensureIconAsset(no: string, iconUrl: string | undefined, entryTimestamp?: string) {
  if (!iconUrl) return undefined;
  const info = extractArchiveInfo(iconUrl);
  const timestamps = new Set<string>();
  if (info.timestamp) timestamps.add(info.timestamp);
  if (entryTimestamp) timestamps.add(entryTimestamp);
  const extra = await fetchSnapshotTimestamps(info.direct);
  extra.forEach((ts) => timestamps.add(ts));
  const candidates = new Set<string>();
  candidates.add(iconUrl);
  buildArchiveCandidates(info.direct, timestamps).forEach((candidate) => candidates.add(candidate));

  const fileName = `${no}${assetExtensionFromPath(info.direct)}`;
  const destPath = path.join(ICONS_DIR, fileName);
  if (await fileExists(destPath)) {
    return `${RELATIVE_ICONS_DIR}/${fileName}`;
  }
  for (const candidate of candidates) {
    try {
      await downloadWithCurl(candidate, destPath);
      const buffer = await fs.readFile(destPath);
      if (buffer.length >= 4 && buffer[0] === 0x3c && buffer[1] === 0x21) {
        await fs.unlink(destPath).catch(() => undefined);
        continue;
      }
      return `${RELATIVE_ICONS_DIR}/${fileName}`;
    } catch {
      await fs.unlink(destPath).catch(() => undefined);
    }
  }
  return undefined;
}

async function ensureScreenshots(no: string, screenshotUrls: string[], entryTimestamp?: string): Promise<ScreenshotResult> {
  if (screenshotUrls.length === 0) return { paths: [], failures: [], skipped: [] };
  await ensureDir(SCREENSHOTS_DIR);
  const accepted: { buffer: Buffer; extension: string; source: string }[] = [];
  const failures: string[] = [];
  const skipped: ScreenshotSkip[] = [];
  const seenHashes = new Set<string>();

  for (const source of screenshotUrls) {
    const info = extractArchiveInfo(source);
    const timestampSet = new Set<string>();
    if (info.timestamp) timestampSet.add(info.timestamp);
    if (entryTimestamp) timestampSet.add(entryTimestamp);
    const extra = await fetchSnapshotTimestamps(info.direct);
    extra.forEach((ts) => timestampSet.add(ts));
    const candidates = new Set<string>();
    candidates.add(source);
    buildArchiveCandidates(info.direct, timestampSet).forEach((candidate) => candidates.add(candidate));

    const extension = assetExtensionFromPath(info.direct);
    let buffer: Buffer | undefined;
    for (const candidate of candidates) {
      try {
        const fetched = await fetchAssetBuffer(candidate);
        if (fetched.length === 0) {
          continue;
        }
        if (bufferLooksLikeHtml(fetched)) {
          continue;
        }
        buffer = fetched;
        break;
      } catch {
        // continue
      }
    }

    if (!buffer) {
      failures.push(info.direct);
      continue;
    }

    const dimensions = getImageDimensions(buffer);
    if (dimensions && dimensions.width < 100 && dimensions.height < 100) {
      skipped.push({ source: info.direct, reason: "small" });
      continue;
    }

    const hash = createHash("md5").update(buffer).digest("hex");
    if (seenHashes.has(hash)) {
      skipped.push({ source: info.direct, reason: "duplicate" });
      continue;
    }
    seenHashes.add(hash);
    accepted.push({ buffer, extension, source: info.direct });
  }

  await purgeEntryScreenshots(no);

  const paths: string[] = [];
  for (let index = 0; index < accepted.length; index += 1) {
    const { buffer, extension } = accepted[index];
    const suffix = accepted.length > 1 ? `-${String(index + 1).padStart(2, "0")}` : "";
    const fileName = `${no}${suffix}${extension}`;
    const destPath = path.join(SCREENSHOTS_DIR, fileName);
    await fs.writeFile(destPath, buffer);
    paths.push(`${RELATIVE_SCREENSHOTS_DIR}/${fileName}`);
  }

  return { paths, failures, skipped };
}

async function parseMenuEntry(): Promise<EntryMeta[]> {
  const html = await readHtmlFile(MENU_ENTRY_HTML);
  const $ = cheerio.load(html);
  const entries: EntryMeta[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href || !/entry\/\d{3}\.html$/i.test(href)) return;
    const match = href.match(/(\d{3})\.html$/);
    if (!match) return;
    const no = match[1];
    const rawTitle = $(el).text().trim();
    entries.push({ no, href, rawTitle });
  });
  entries.sort((a, b) => a.no.localeCompare(b.no));
  return entries;
}

async function loadBannerUrl() {
  const html = await readHtmlFile(MENU_TOP_HTML);
  const $ = cheerio.load(html);
  const img = $("img").first();
  const src = img.attr("src");
  if (!src) return undefined;
  const absolute = new URL(src, MENU_TOP_SOURCES[0]).href;
  return absolute;
}

async function ensureBannerAsset(bannerUrl: string | undefined) {
  if (!bannerUrl) return undefined;
  const info = extractArchiveInfo(bannerUrl);
  const timestamps = new Set<string>();
  if (info.timestamp) timestamps.add(info.timestamp);
  const extra = await fetchSnapshotTimestamps(info.direct);
  extra.forEach((ts) => timestamps.add(ts));
  const candidates = new Set<string>();
  candidates.add(bannerUrl);
  buildArchiveCandidates(info.direct, timestamps).forEach((candidate) => candidates.add(candidate));
  const extension = assetExtensionFromPath(info.direct);
  const fileName = `${FESTIVAL_SLUG}${extension}`;
  const destPath = path.join(BANNERS_DIR, fileName);
  if (await fileExists(destPath)) {
    return `${RELATIVE_BANNERS_DIR}/${fileName}`;
  }
  for (const candidate of candidates) {
    try {
      await downloadWithCurl(candidate, destPath);
      const buffer = await fs.readFile(destPath);
      if (buffer.length >= 4 && buffer[0] === 0x3c && buffer[1] === 0x21) {
        await fs.unlink(destPath).catch(() => undefined);
        continue;
      }
      return `${RELATIVE_BANNERS_DIR}/${fileName}`;
    } catch {
      await fs.unlink(destPath).catch(() => undefined);
    }
  }
  return undefined;
}

async function processEntry(entry: EntryMeta, menuSource: string): Promise<EntryProcessingResult> {
  const { html, entryUrl, entryTimestamp } = await fetchEntryHtml(entry.no, entry.href, menuSource);
  const parsed = parseEntryHtml(entry.no, html, entryUrl);
  const iconPath = await ensureIconAsset(entry.no, parsed.iconUrl, entryTimestamp);
  if (iconPath) {
    parsed.work.icon = iconPath;
  } else if (parsed.iconUrl) {
    parsed.work.icon = parsed.iconUrl;
  }

  const screenshotResult = await ensureScreenshots(entry.no, parsed.screenshotUrls, entryTimestamp);
  const limitedScreenshots = screenshotResult.paths.slice(0, 2);
  if (limitedScreenshots.length > 0) {
    parsed.work.ss = limitedScreenshots;
  }
  const overflowCount = screenshotResult.paths.length - limitedScreenshots.length;
  const smallSkipCount = screenshotResult.skipped.filter((item) => item.reason === "small").length;
  const duplicateSkipCount = screenshotResult.skipped.filter((item) => item.reason === "duplicate").length;

  const noteParts: string[] = [];
  if (screenshotResult.failures.length > 0) {
    noteParts.push(`missing screenshots: ${screenshotResult.failures.length}`);
  }
  if (overflowCount > 0) {
    noteParts.push(`stored first ${limitedScreenshots.length} of ${screenshotResult.paths.length}`);
  }
  if (smallSkipCount > 0) {
    noteParts.push(`skipped small images (<100px): ${smallSkipCount}`);
  }
  if (duplicateSkipCount > 0) {
    noteParts.push(`skipped duplicate screenshots: ${duplicateSkipCount}`);
  }

  const skippedSummary = [
    ...screenshotResult.failures.map((source) => `failed:${source}`),
    ...screenshotResult.skipped.map((item) => `${item.reason}:${item.source}`),
  ];

  const snapshot: SnapshotRecord = {
    no: entry.no,
    status: "ok",
    title: parsed.work.title,
    icon: parsed.work.icon,
    note: noteParts.length > 0 ? noteParts.join("; ") : undefined,
    skippedScreenshots: skippedSummary.length > 0 ? skippedSummary : undefined,
  };

  const failureRecord = screenshotResult.failures.length > 0 ? { no: entry.no, sources: screenshotResult.failures } : undefined;
  return { work: parsed.work, snapshot, screenshotFailures: failureRecord };
}

async function processEntries(entries: EntryMeta[]) {
  const works: WorkEntry[] = [];
  const snapshots: SnapshotRecord[] = [];
  const screenshotFailures: { no: string; sources: string[] }[] = [];
  for (const entry of entries) {
    try {
      const result = await processEntry(entry, MENU_ENTRY_SOURCES[0]);
      works.push(result.work);
      snapshots.push(result.snapshot);
      if (result.screenshotFailures) {
        screenshotFailures.push(result.screenshotFailures);
      }
    } catch (error) {
      snapshots.push({
        no: entry.no,
        status: "parse-error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { works, snapshots, screenshotFailures };
}

async function fetchMenuHtml() {
  await ensureDir(CATCH_DIR);
  await fetchHtmlToFile(MENU_ENTRY_HTML, MENU_ENTRY_SOURCES);
  await fetchHtmlToFile(MENU_TOP_HTML, MENU_TOP_SOURCES);
}

async function main() {
  await ensureDir(BANNERS_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);

  await fetchMenuHtml();
  const bannerUrl = await loadBannerUrl();
  const bannerLocalPath = await ensureBannerAsset(bannerUrl);
  const entries = await parseMenuEntry();
  const { works, snapshots, screenshotFailures } = await processEntries(entries);

  works.sort((a, b) => a.id.localeCompare(b.id));
  await fs.writeFile(OUTPUT_WORKS, `${JSON.stringify(works, null, 2)}\n`, "utf8");

  const summary = {
    festivalId: FESTIVAL_ID,
    generatedAt: new Date().toISOString(),
    banner: {
      sourcesTried: MENU_TOP_SOURCES,
      localPath: bannerLocalPath,
    },
    list: {
      sourcesTried: MENU_ENTRY_SOURCES,
      totalEntries: entries.length,
    },
    stats: {
      captured: works.length,
      parseErrors: snapshots.filter((item) => item.status === "parse-error").length,
      screenshotIssues: screenshotFailures.length,
    },
    screenshotFailures,
    entries: snapshots,
  };

  await fs.writeFile(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(`Captured ${works.length} works. Snapshot issues: ${summary.stats.parseErrors}. Screenshot issues: ${summary.stats.screenshotIssues}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});




