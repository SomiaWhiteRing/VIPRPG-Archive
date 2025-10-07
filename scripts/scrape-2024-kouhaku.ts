import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const FESTIVAL_ID = "2024-kouhaku";
const FESTIVAL_SLUG = "2024-kouhaku";
const BASE_URL = "https://vipkouhaku2024.x.2nt.com";
const INDEX_URL = `${BASE_URL}/index.html`;

const OUTPUT_WORKS = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const CATCH_DIR = path.join(process.cwd(), "catch", FESTIVAL_SLUG);
const SUMMARY_PATH = path.join(CATCH_DIR, `${FESTIVAL_SLUG}-scrape-summary.json`);

const PUBLIC_DIR = path.join(process.cwd(), "public");
const BANNERS_DIR = path.join(PUBLIC_DIR, "banners");
const ICONS_DIR = path.join(PUBLIC_DIR, "icons", FESTIVAL_SLUG);
const SCREENSHOTS_DIR = path.join(PUBLIC_DIR, "screenshots", FESTIVAL_SLUG);

const RELATIVE_BANNERS_DIR = "/banners";
const RELATIVE_ICONS_DIR = `/icons/${FESTIVAL_SLUG}`;
const RELATIVE_SCREENSHOTS_DIR = `/screenshots/${FESTIVAL_SLUG}`;

const MAX_SCREENSHOTS = 6;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)" +
  " Chrome/130.0.0.0 Safari/537.36";

interface IndexEntry {
  index: string;
  title: string;
  iconUrl?: string;
  screenshotUrl?: string;
  author?: string;
  genre?: string;
  engine?: string;
  liveStreaming?: string;
  videoPosting?: string;
  note?: string;
  detailUrl?: string;
  forumUrl?: string;
  downloadUrl?: string;
  downloadLabel?: string;
}

interface DetailEntry {
  comment?: string;
  organizerComment?: string;
  genre?: string;
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

interface FetchBinaryOptions {
  referrer?: string;
}

async function fetchBinary(url: string, options: FetchBinaryOptions = {}) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      Connection: "close",
    },
    cache: "no-store",
    redirect: "follow",
    referrer: options.referrer,
    referrerPolicy: options.referrer ? "strict-origin-when-cross-origin" : "no-referrer",
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
  };
}

async function fetchText(url: string) {
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
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return await response.text();
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

async function copyIcon(index: string, url: string | undefined) {
  if (!url) return undefined;
  const absolute = toAbsoluteUrl(url, INDEX_URL);
  if (!absolute) return undefined;
  await ensureDir(ICONS_DIR);
  const extension = getImageExtension(absolute, ".png");
  const destFile = `${index}${extension}`;
  const destPath = path.join(ICONS_DIR, destFile);
  try {
    const { buffer, contentType } = await fetchBinary(absolute);
    if (!looksLikeImageBuffer(buffer, contentType)) {
      throw new Error(`Non-image response (${contentType || "unknown"})`);
    }
    await fs.writeFile(destPath, buffer);
    return `${RELATIVE_ICONS_DIR}/${destFile}`;
  } catch (error) {
    console.warn(`Failed to download icon for ${index}: ${absolute} =>`, error);
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

async function copyBanner() {
  const bannerUrl = `${BASE_URL}/assets/images/main-visual_viprpg_kouhaku_2024.png`;
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

function combineStreaming(live?: string, video?: string) {
  const parts: string[] = [];
  if (sanitizeWhitespace(live)) {
    parts.push(`配信: ${sanitizeWhitespace(live)}`);
  }
  if (sanitizeWhitespace(video)) {
    parts.push(`動画: ${sanitizeWhitespace(video)}`);
  }
  return parts.length ? parts.join(" / ") : undefined;
}

async function parseIndex(): Promise<IndexEntry[]> {
  const html = await fetchText(INDEX_URL);
  const $ = cheerio.load(html);
  const entries: IndexEntry[] = [];

  $("article.works ol > li").each((idx, element) => {
    const container = $(element);
    const index = String(idx + 1).padStart(2, "0");
    const title = sanitizeWhitespace(container.find("dt.game-title").text()) ?? `Work ${index}`;

    const iconUrl = container.find("dd.game-icon img").attr("src");
    const screenshotUrl = container.find("dd.game-screenshot img").attr("src");

    const author = sanitizeWhitespace(container.find("tr.game-author td").text());
    const genre = sanitizeWhitespace(container.find("tr.game-genre td").text());
    const engine = sanitizeWhitespace(container.find("tr.game-rpgmaker td").text());
    const liveStreaming = sanitizeWhitespace(container.find("tr.game-haisin td").text());
    const videoPosting = sanitizeWhitespace(container.find("tr.game-dougaka td").text());
    const note = sanitizeWhitespace(container.find("tr.game-note td").text());

    const detailUrl = container.find("a.shousai").attr("href");
    const forumUrl = container.find("a.kansou").attr("href");

    const downloadAnchor = container.find("a.download").first();
    const downloadUrl = downloadAnchor.attr("href");
    const sizeText = sanitizeWhitespace(downloadAnchor.find("small").text());

    const downloadLabel = sizeText || undefined;

    entries.push({
      index,
      title,
      iconUrl,
      screenshotUrl,
      author,
      genre,
      engine,
      liveStreaming,
      videoPosting,
      note,
      detailUrl,
      forumUrl,
      downloadUrl,
      downloadLabel,
    });
  });

  return entries;
}

async function parseDetail(url: string | undefined): Promise<DetailEntry> {
  if (!url) return {};
  const absolute = toAbsoluteUrl(url, INDEX_URL);
  if (!absolute) return {};
  try {
    const html = await fetchText(absolute);
    const $ = cheerio.load(html);
    const rows = $("table.entrypage tr");
    const result: DetailEntry = {};

    const screenshotSet = new Set<string>();
    $("table.entrypage img").each((_, img) => {
      const src = $(img).attr("src");
      const resolved = toAbsoluteUrl(src, absolute);
      if (!resolved) return;
      if (!/\.(png|jpe?g|gif|bmp)$/i.test(resolved)) return;
      const lower = resolved.toLowerCase();
      if (lower.includes("/icons/")) return;
      if (lower.includes("counter_img.php")) return;
      screenshotSet.add(resolved);
    });
    if (screenshotSet.size > 0) {
      result.screenshots = Array.from(screenshotSet);
    }

    const extractValue = (row: cheerio.Cheerio<cheerio.AnyNode>) => {
      const clone = row.clone();
      clone.find("br").replaceWith("\n");
      return sanitizeMultiline(clone.text());
    };

    for (let i = 0; i < rows.length - 1; i += 1) {
      const label = sanitizeWhitespace($(rows[i]).text());
      if (!label) continue;
      const valueRow = $(rows[i + 1]);
      const valueText = extractValue(valueRow);
      if (!valueText) continue;

      if (label.includes("コメント") && !label.includes("主催")) {
        result.comment = valueText;
        i += 1;
        continue;
      }
      if (label.includes("主催コメント")) {
        result.organizerComment = valueText;
        i += 1;
        continue;
      }
      if (label.includes("ジャンル") && !result.genre) {
        result.genre = valueText;
        i += 1;
        continue;
      }
    }

    return result;
  } catch (error) {
    console.warn(`Failed to parse detail page ${absolute} =>`, error);
    return {};
  }
}

async function processEntry(entry: IndexEntry) {
  const detail = await parseDetail(entry.detailUrl);

  const iconPath = await copyIcon(entry.index, entry.iconUrl);

  const screenshotSources = new Set<string>();
  if (detail.screenshots) {
    for (const src of detail.screenshots) {
      screenshotSources.add(src);
    }
  }
  const fallbackScreenshot = toAbsoluteUrl(entry.screenshotUrl, INDEX_URL);
  if (fallbackScreenshot) {
    screenshotSources.add(fallbackScreenshot);
  }
  const screenshotResult = await copyScreenshots(entry.index, Array.from(screenshotSources));

  const work: WorkEntry = {
    id: `${FESTIVAL_ID}-work-${entry.index}`,
    festivalId: FESTIVAL_ID,
    title: entry.title,
    author: entry.author ?? "",
    category: detail.genre ?? entry.genre,
    engine: entry.engine,
    streaming: combineStreaming(entry.liveStreaming, entry.videoPosting),
    forum: entry.forumUrl,
    authorComment: buildAuthorComment(detail.comment, detail.organizerComment, entry.note),
  };

  if (iconPath) {
    work.icon = iconPath;
  }
  if (screenshotResult.paths.length > 0) {
    work.ss = screenshotResult.paths;
  }

  const noteParts: string[] = [];
  if (entry.downloadUrl) {
    if (entry.downloadLabel) {
      noteParts.push(`ダウンロード: ${entry.downloadLabel}`);
    }
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

  const rawDownloadSources = [entry.downloadUrl].filter((value, idx, arr): value is string =>
    Boolean(value) && !value.toLowerCase().startsWith("javascript:") && arr.indexOf(value) === idx
  );
  const downloadSources = rawDownloadSources
    .map((source) => toAbsoluteUrl(source, INDEX_URL) ?? source)
    .filter((value, idx, arr) => arr.indexOf(value) === idx);

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

function buildAuthorComment(comment?: string, organizer?: string, note?: string) {
  const parts: string[] = [];
  if (comment) parts.push(comment);
  if (organizer) parts.push(`【主催】${organizer}`);
  if (note) parts.push(`【備考】${note}`);
  return parts.length ? parts.join("\n\n") : undefined;
}

async function main() {
  await ensureDir(CATCH_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);

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












