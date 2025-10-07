import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const FESTIVAL_ID = "2024-gw";
const FESTIVAL_SLUG = "2024-gw";
const SOURCE_ROOT = path.join(process.cwd(), "[html]23夏24紅白GW");
const SITE_DIR = path.join(SOURCE_ROOT, "[2024GW]");
const ITCH_DIR = path.join(SOURCE_ROOT, "[2024GW(itch)]");
const INDEX_HTML = path.join(SITE_DIR, "index[1].html");
const ENTRY_DIR = path.join(SITE_DIR, "entry");

const PUBLIC_DIR = path.join(process.cwd(), "public");
const BANNERS_DIR = path.join(PUBLIC_DIR, "banners");
const ICONS_DIR = path.join(PUBLIC_DIR, "icons", FESTIVAL_SLUG);
const SCREENSHOTS_DIR = path.join(PUBLIC_DIR, "screenshots", FESTIVAL_SLUG);

const RELATIVE_BANNERS_DIR = "/banners";
const RELATIVE_ICONS_DIR = `/icons/${FESTIVAL_SLUG}`;
const RELATIVE_SCREENSHOTS_DIR = `/screenshots/${FESTIVAL_SLUG}`;

const OUTPUT_WORKS = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const SUMMARY_DIR = path.join(process.cwd(), "catch", FESTIVAL_SLUG);
const SUMMARY_PATH = path.join(SUMMARY_DIR, `${FESTIVAL_SLUG}-scrape-summary.json`);

const MAX_SCREENSHOTS = 12;

interface TableRow {
  index: string;
  href: string;
  title?: string;
  author?: string;
  engine?: string;
  category?: string;
  submission?: string;
  streaming?: string;
  downloadHref?: string;
  downloadLabel?: string;
  forum?: string;
  iconSrc?: string;
  screenshotSrcs: string[];
}

interface WorkEntry {
  id: string;
  festivalId: string;
  title: string;
  author: string;
  category?: string;
  engine?: string;
  streaming?: string;
  forum?: string;
  authorComment?: string;
  icon?: string;
  ss?: string[];
}

interface ScreenshotSkip {
  source: string;
  reason: "small" | "duplicate";
}

interface ScreenshotResult {
  paths: string[];
  skipped: ScreenshotSkip[];
  failures: string[];
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

interface ProcessedEntry {
  work: WorkEntry;
  snapshot: SnapshotRecord;
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

async function fileExists(target: string) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
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

function decodeRelative(relative: string | undefined) {
  if (!relative) return undefined;
  const cleaned = relative.replace(/^\.\//, "");
  try {
    return decodeURIComponent(cleaned);
  } catch {
    return cleaned;
  }
}

function resolveEntryImage(relative: string | undefined) {
  const decoded = decodeRelative(relative);
  if (!decoded) return undefined;
  if (decoded.startsWith("entry/")) {
    return path.join(SITE_DIR, decoded);
  }
  return path.join(ENTRY_DIR, decoded);
}

function resolveItchResource(baseFile: string, relative: string | undefined) {
  const decoded = decodeRelative(relative);
  if (!decoded) return undefined;
  return path.join(path.dirname(baseFile), decoded);
}

async function copyFileIfChanged(source: string, dest: string) {
  if (!(await fileExists(source))) {
    throw new Error(`Source file missing: ${source}`);
  }
  const buffer = await fs.readFile(source);
  await ensureDir(path.dirname(dest));
  await fs.writeFile(dest, buffer);
}

async function copyIcon(index: string, source: string | undefined) {
  if (!source) return undefined;
  const extension = getImageExtension(source, ".png");
  const destFile = `${index}${extension}`;
  const destPath = path.join(ICONS_DIR, destFile);
  const absolute = path.isAbsolute(source) ? source : resolveEntryImage(source);
  if (!absolute) return undefined;
  await ensureDir(ICONS_DIR);
  await copyFileIfChanged(absolute, destPath);
  return `${RELATIVE_ICONS_DIR}/${destFile}`;
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
      console.warn('Failed to purge screenshots for ' + index + ': ' + err.message);
    }
  }
}


async function copyScreenshots(index: string, baseDir: string, sources: string[]) {
  await ensureDir(SCREENSHOTS_DIR);
  await purgeScreenshots(index);

  const seenHashes = new Set<string>();
  const candidates: Array<{
    buffer: Buffer;
    extension: string;
    resolved: string;
    dims?: { width: number; height: number };
  }> = [];
  const skipped: ScreenshotSkip[] = [];
  const failures: string[] = [];

  for (const raw of sources) {
    if (!raw) continue;
    const resolved = path.isAbsolute(raw) ? raw : path.join(baseDir, raw);
    try {
      const buffer = await fs.readFile(resolved);
      if (buffer.length === 0) {
        failures.push(resolved);
        continue;
      }
      const dims = getImageDimensions(buffer);
      if (dims && dims.width < 100 && dims.height < 100) {
        skipped.push({ source: resolved, reason: "small" });
        continue;
      }
      const hash = createHash("md5").update(buffer).digest("hex");
      if (seenHashes.has(hash)) {
        skipped.push({ source: resolved, reason: "duplicate" });
        continue;
      }
      seenHashes.add(hash);
      const extension = getImageExtension(resolved, ".png");
      candidates.push({ buffer, extension, resolved, dims });
    } catch {
      failures.push(raw);
    }
  }

  if (candidates.length === 0) {
    return { paths: [], skipped, failures } satisfies ScreenshotResult;
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
      skipped.push({ source: candidate.resolved, reason: "small" });
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

  return { paths, skipped, failures } satisfies ScreenshotResult;
}

async function copyBanner() {
  const bannerSource = path.join(SITE_DIR, "img", "banner24gw_01.png");
  const bannerDest = path.join(BANNERS_DIR, `${FESTIVAL_SLUG}.png`);
  await ensureDir(BANNERS_DIR);
  if (!(await fileExists(bannerSource))) {
    return undefined;
  }
  await copyFileIfChanged(bannerSource, bannerDest);
  return `${RELATIVE_BANNERS_DIR}/${FESTIVAL_SLUG}.png`;
}

function combineStreaming(submission?: string, streaming?: string) {
  const sub = sanitizeWhitespace(submission);
  const stream = sanitizeWhitespace(streaming);
  if (sub && stream) return `${stream}/${sub}`;
  if (stream) return stream;
  if (sub) return sub;
  return undefined;
}

function extractTextWithBreaks(html: string | undefined) {
  if (!html) return undefined;
  const normalized = html.replace(/<br\s*\/?>(\s|&nbsp;)*/gi, "\n");
  const text = cheerio.load(`<div>${normalized}</div>`).text();
  return sanitizeMultiline(text);
}

async function parseTable() {
  const html = await fs.readFile(INDEX_HTML, "utf8");
  const $ = cheerio.load(html);
  const rows: TableRow[] = [];
  $("#sampleTable tr").each((index, element) => {
    if (index === 0) return;
    const cells = $(element).find("td");
    if (cells.length < 3) return;
    const noCell = cells.eq(0);
    const indexText = sanitizeWhitespace(noCell.text());
    const numberMatch = indexText?.match(/\d+/);
    if (!numberMatch) return;
    const indexValue = numberMatch[0].padStart(2, "0");

    const titleCell = cells.eq(2);
    const link = titleCell.find("a[href]").first();
    const href = link.attr("href");
    if (!href) return;
    const titleClone = link.clone();
    titleClone.find("font").remove();
    const title = sanitizeWhitespace(titleClone.text());
    const author = sanitizeWhitespace(link.find("font").text()) ?? undefined;

    const iconSrc = noCell.find("img").attr("src");
    const screenshotSrcs = cells
      .eq(1)
      .find("img")
      .map((_, img) => $(img).attr("src"))
      .get()
      .filter(Boolean);

    const engine = sanitizeWhitespace(cells.eq(3).text());
    const category = sanitizeWhitespace(cells.eq(4).text());

    const dlCell = cells.eq(5);
    const downloadLink = dlCell.find("a[href]").attr("href");
    const downloadLabel = sanitizeWhitespace(dlCell.text());

    const submission = sanitizeWhitespace(cells.eq(6).text());
    const streaming = sanitizeWhitespace(cells.eq(7).text());
    const forumLink = cells.eq(8).find("a[href]").attr("href");

    rows.push({
      index: indexValue,
      href,
      title,
      author,
      engine,
      category,
      submission,
      streaming,
      downloadHref: downloadLink || undefined,
      downloadLabel,
      forum: forumLink || undefined,
      iconSrc: iconSrc || undefined,
      screenshotSrcs: screenshotSrcs as string[],
    });
  });
  return rows;
}

async function findItchFileByUrl(gameUrl: string) {
  const files = await fs.readdir(ITCH_DIR);
  for (const file of files) {
    if (!file.toLowerCase().endsWith(".htm")) continue;
    const fullPath = path.join(ITCH_DIR, file);
    const content = await fs.readFile(fullPath, "utf8");
    const $ = cheerio.load(content);
    const twitterUrl = $('meta[name="twitter:url"]').attr("content");
    const canonical = $('link[rel="canonical"]').attr("href");
    if (twitterUrl === gameUrl || canonical === gameUrl) {
      return { path: fullPath, html: content };
    }
  }
  return undefined;
}

function extractItchDownloadUrl(html: string) {
  const match = html.match(/init_ViewGame\([^,]+,\s*(\{[\s\S]*?\})\);/);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[1]);
    const url = parsed?.generate_download_url;
    if (typeof url === "string" && url.length > 0) {
      return url;
    }
  } catch {
    // ignore
  }
  return undefined;
}

async function processLocalEntry(row: TableRow): Promise<ProcessedEntry> {
  const entryPath = path.join(SITE_DIR, decodeRelative(row.href) ?? "");
  const html = await fs.readFile(entryPath, "utf8");
  const $ = cheerio.load(html);
  const entry = $("#entry");

  const h2 = entry.find("h2").first();
  let h2Text = h2.text().replace(/\s+/g, " ").trim();
  h2Text = h2Text.replace(/　+/g, " ");
  const title = sanitizeWhitespace(
    h2Text
      .replace(/^No\.\d+\s*/, "")
      .replace(/\[[^\]]*\]$/, "")
      .trim()
  ) ?? row.title ?? `Work ${row.index}`;
  const engineMatch = h2Text.match(/\[([^\]]+)\]$/);
  const engine = sanitizeWhitespace(engineMatch?.[1]) ?? row.engine;

  const h3 = entry.find("h3").first();
  const h3Html = h3.html() ?? "";
  const [lineOneRaw = "", lineTwoRaw = ""] = h3Html.split(/<br\s*\/?/i);
  const lineOneText = sanitizeWhitespace(cheerio.load(`<span>${lineOneRaw}</span>`).text());
  const lineTwoText = sanitizeWhitespace(cheerio.load(`<span>${lineTwoRaw}</span>`).text());

  let author = row.author;
  let category = row.category;
  if (lineOneText) {
    const authorMatch = lineOneText.match(/作者[：:](.+?)(?:\/|$)/);
    if (authorMatch) {
      author = sanitizeWhitespace(authorMatch[1]) ?? author;
    }
    const genreMatch = lineOneText.match(/ジャンル[：:](.+)/);
    if (genreMatch) {
      category = sanitizeWhitespace(genreMatch[1]) ?? category;
    }
  }

  let streamingValue = combineStreaming(row.submission, row.streaming);
  if (lineTwoText) {
    const directMatch = lineTwoText.match(/配信[：:](.+?)(?:\/投稿[：:](.+))?$/);
    if (directMatch) {
      const stream = sanitizeWhitespace(directMatch[1]);
      const sub = sanitizeWhitespace(directMatch[2]);
      streamingValue = combineStreaming(sub, stream) ?? streamingValue;
    } else {
      const bothMatch = lineTwoText.match(/配信\/?投稿[：:](.+)/);
      if (bothMatch) {
        streamingValue = sanitizeWhitespace(bothMatch[1]) ?? streamingValue;
      }
    }
  }

  const descriptionHtml = entry.find("font b").html();
  const authorComment = extractTextWithBreaks(descriptionHtml);

  const iconSrc = h2.find("img").attr("src") ?? row.iconSrc;
  const iconAbsolute = iconSrc ? resolveEntryImage(iconSrc) : undefined;
  const iconPath = iconAbsolute
    ? await copyIcon(row.index, iconAbsolute)
    : undefined;

  const carouselImages = entry
    .find(".carousel_entry img")
    .map((_, img) => resolveEntryImage($(img).attr("src")))
    .get()
    .filter(Boolean) as string[];
  const fallbackScreens = row.screenshotSrcs
    .map((src) => resolveEntryImage(src))
    .filter((value): value is string => Boolean(value));
  const allScreens = [...carouselImages];
  for (const img of fallbackScreens) {
    if (!allScreens.includes(img)) {
      allScreens.push(img);
    }
  }
  const screenshotResult = await copyScreenshots(row.index, ENTRY_DIR, allScreens);

  const dlLink = entry.find(".e_btn_dl a[href]").first().attr("href") ?? row.downloadHref;
  const forumLink = entry.find(".e_btn a[href]").first().attr("href") ?? row.forum;

  const work: WorkEntry = {
    id: `${FESTIVAL_ID}-work-${row.index}`,
    festivalId: FESTIVAL_ID,
    title,
    author: author ?? "",
    category,
    engine,
    streaming: streamingValue,
    forum: forumLink ?? undefined,
    authorComment,
  };

  if (iconPath) {
    work.icon = iconPath;
  }
  if (screenshotResult.paths.length > 0) {
    work.ss = screenshotResult.paths;
  }

  const noteSegments: string[] = [];
  if (row.downloadLabel && /公開停止|ｴﾀ|締切|未提出/i.test(row.downloadLabel)) {
    noteSegments.push(`DL: ${row.downloadLabel}`);
  }
  if (screenshotResult.skipped.length > 0) {
    const small = screenshotResult.skipped.filter((item) => item.reason === "small").length;
    const dup = screenshotResult.skipped.filter((item) => item.reason === "duplicate").length;
    if (small > 0) noteSegments.push(`skipped small: ${small}`);
    if (dup > 0) noteSegments.push(`skipped dup: ${dup}`);
  }
  if (screenshotResult.failures.length > 0) {
    noteSegments.push(`screenshot failures: ${screenshotResult.failures.length}`);
  }

  const sources = [row.downloadHref, dlLink].filter((value, idx, arr): value is string => Boolean(value) && !value.toLowerCase().startsWith("javascript:") && arr.indexOf(value) === idx);

  const snapshot: SnapshotRecord = {
    index: row.index,
    status: "ok",
    title: work.title,
    icon: work.icon,
    note: noteSegments.length ? noteSegments.join("; ") : undefined,
    downloadSource: sources.length ? sources : undefined,
    screenshotReport: {
      saved: screenshotResult.paths.length,
      skipped: screenshotResult.skipped.length ? screenshotResult.skipped : undefined,
      failures: screenshotResult.failures.length ? screenshotResult.failures : undefined,
    },
  };

  return { work, snapshot };
}

async function processItchEntry(row: TableRow): Promise<ProcessedEntry> {
  const gameUrl = row.href;
  const result = await findItchFileByUrl(gameUrl);
  if (!result) {
    return buildFallbackItch(row);
  }
  const { path: filePath, html } = result;
  const $ = cheerio.load(html);

  const title = sanitizeWhitespace($("h1.game_title").first().text()) ?? row.title ?? `Work ${row.index}`;

  let author = row.author;
  $(".game_info_panel_widget tr").each((_, tr) => {
    const label = sanitizeWhitespace($(tr).find("td").eq(0).text());
    const value = sanitizeWhitespace($(tr).find("td").eq(1).text());
    if (label === "Author" && value) {
      author = value;
    }
  });

  const descriptionHtml = $(".formatted_description").html();
  const authorComment = extractTextWithBreaks(descriptionHtml);

  const screenshotSources = $(".screenshot_list img")
    .map((_, img) => {
      const node = $(img);
      const srcset = node.attr("srcset");
      if (srcset) {
        const entries = srcset
          .split(",")
          .map((entry) => entry.trim().split(/\s+/)[0])
          .filter(Boolean);
        if (entries.length > 0) {
          const preferred = entries[entries.length - 1];
          return resolveItchResource(filePath, preferred);
        }
      }
      return resolveItchResource(filePath, node.attr("src") ?? node.attr("data-lazy_src"));
    })
    .get()
    .filter((value): value is string => Boolean(value));
  const tableScreens = row.screenshotSrcs
    .map((src) => resolveEntryImage(src))
    .filter((value): value is string => Boolean(value));
  const allScreens = [...screenshotSources];
  if (allScreens.length === 0) {
    for (const img of tableScreens) {
      if (!allScreens.includes(img)) {
        allScreens.push(img);
      }
    }
  }
  const screenshotResult = await copyScreenshots(row.index, path.dirname(filePath), allScreens);

  const downloadButtons = $("a.button.download_btn[href], a.button.download[href]");
  const downloadLinks = downloadButtons
    .map((_, anchor) => $(anchor).attr("href"))
    .get()
    .filter(Boolean) as string[];

  const downloadUrl = extractItchDownloadUrl(html);
  const sources = [row.downloadHref, downloadUrl, ...downloadLinks, gameUrl].filter(
    (value, idx, arr): value is string =>
      Boolean(value) && !value.toLowerCase().startsWith("javascript:") && arr.indexOf(value) === idx
  );

  const iconPath = await copyIcon(row.index, resolveEntryImage(row.iconSrc));

  const noteSegments: string[] = [];
  if (row.downloadLabel && /公開停止|ｴﾀ|締切|未提出/i.test(row.downloadLabel)) {
    noteSegments.push(`DL: ${row.downloadLabel}`);
  }
  if (screenshotResult.skipped.length > 0) {
    const small = screenshotResult.skipped.filter((item) => item.reason === "small").length;
    const dup = screenshotResult.skipped.filter((item) => item.reason === "duplicate").length;
    if (small > 0) noteSegments.push(`skipped small: ${small}`);
    if (dup > 0) noteSegments.push(`skipped dup: ${dup}`);
  }
  if (screenshotResult.failures.length > 0) {
    noteSegments.push(`screenshot failures: ${screenshotResult.failures.length}`);
  }

  const work: WorkEntry = {
    id: `${FESTIVAL_ID}-work-${row.index}`,
    festivalId: FESTIVAL_ID,
    title,
    author: author ?? "",
    category: row.category,
    engine: row.engine,
    streaming: combineStreaming(row.submission, row.streaming),
    forum: row.forum,
    authorComment,
  };

  if (iconPath) {
    work.icon = iconPath;
  }
  if (screenshotResult.paths.length > 0) {
    work.ss = screenshotResult.paths;
  }

  const snapshot: SnapshotRecord = {
    index: row.index,
    status: "ok",
    title: work.title,
    icon: work.icon,
    note: noteSegments.length ? noteSegments.join("; ") : undefined,
    downloadSource: sources.length ? sources : undefined,
    screenshotReport: {
      saved: screenshotResult.paths.length,
      skipped: screenshotResult.skipped.length ? screenshotResult.skipped : undefined,
      failures: screenshotResult.failures.length ? screenshotResult.failures : undefined,
    },
  };

  return { work, snapshot };
}

async function buildFallbackItch(row: TableRow): Promise<ProcessedEntry> {
  const iconPath = await copyIcon(row.index, resolveEntryImage(row.iconSrc));
  const tableScreens = row.screenshotSrcs
    .map((src) => resolveEntryImage(src))
    .filter((value): value is string => Boolean(value));
  const screenshotResult = await copyScreenshots(row.index, ENTRY_DIR, tableScreens);

  const sources = [row.downloadHref, row.href].filter(
    (value, idx, arr): value is string =>
      Boolean(value) && !value.toLowerCase().startsWith("javascript:") && arr.indexOf(value) === idx
  );

  const work: WorkEntry = {
    id: `${FESTIVAL_ID}-work-${row.index}`,
    festivalId: FESTIVAL_ID,
    title: row.title ?? `Work ${row.index}`,
    author: row.author ?? "",
    category: row.category,
    engine: row.engine,
    streaming: combineStreaming(row.submission, row.streaming),
    forum: row.forum,
  };

  if (iconPath) {
    work.icon = iconPath;
  }
  if (screenshotResult.paths.length > 0) {
    work.ss = screenshotResult.paths;
  }

  const notes: string[] = ["offline dump missing"];
  if (row.downloadLabel && /公開停止|ｴﾀ|締切|未提出/i.test(row.downloadLabel)) {
    notes.push(`DL: ${row.downloadLabel}`);
  }
  if (screenshotResult.skipped.length > 0) {
    const small = screenshotResult.skipped.filter((item) => item.reason === "small").length;
    const dup = screenshotResult.skipped.filter((item) => item.reason === "duplicate").length;
    if (small > 0) notes.push(`skipped small: ${small}`);
    if (dup > 0) notes.push(`skipped dup: ${dup}`);
  }
  if (screenshotResult.failures.length > 0) {
    notes.push(`screenshot failures: ${screenshotResult.failures.length}`);
  }

  const snapshot: SnapshotRecord = {
    index: row.index,
    status: "ok",
    title: work.title,
    icon: work.icon,
    note: notes.join("; "),
    downloadSource: sources.length ? sources : undefined,
    screenshotReport: {
      saved: screenshotResult.paths.length,
      skipped: screenshotResult.skipped.length ? screenshotResult.skipped : undefined,
      failures: screenshotResult.failures.length ? screenshotResult.failures : undefined,
    },
  };

  return { work, snapshot };
}

async function processRow(row: TableRow): Promise<ProcessedEntry> {
  if (/^https?:\/\//i.test(row.href)) {
    return processItchEntry(row);
  }
  return processLocalEntry(row);
}

async function main() {
  await ensureDir(SUMMARY_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);

  const banner = await copyBanner();

  const rows = await parseTable();
  const works: WorkEntry[] = [];
  const snapshots: SnapshotRecord[] = [];

  for (const row of rows) {
    try {
      const { work, snapshot } = await processRow(row);
      works.push(work);
      snapshots.push(snapshot);
    } catch (error) {
      snapshots.push({
        index: row.index,
        status: "error",
        title: row.title,
        downloadSource: row.downloadHref ? [row.downloadHref] : undefined,
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













