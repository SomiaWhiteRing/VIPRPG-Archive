import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

const FESTIVAL_ID = "2024-summer";
const FESTIVAL_SLUG = "2024-summer";
const BASE_URL = "https://vipsummer2024.x.2nt.com";
const INDEX_URL = `${BASE_URL}/entries.html`;

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
  index: string; // equals to `no`, used for filenames
  no: string; // 2-digit string from page
  title: string;
  iconUrl?: string;
  thumbUrl?: string;
  author?: string;
  genre?: string;
  engine?: string;
  streamingRaw?: string;
  detailUrl?: string;
  forumUrl?: string;
  downloadUrl?: string; // do not save in works; only summary
  downloadLabel?: string;
}

interface DetailEntry {
  authorComment?: string;
  hostComment?: string;
  screenshots?: string[]; // absolute URLs
}

interface ScreenshotSkip {
  source: string;
  reason: "small" | "duplicate";
}

interface DownloadResult {
  paths: string[];
  skipped: ScreenshotSkip[];
  failures: string[];
}

interface WorkEntryOut {
  id: string;
  festivalId: string;
  title: string;
  author: string;
  category?: string;
  engine?: string;
  streaming?: string; // keep raw text
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
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
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
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return await response.text();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  // fallback to http if https failed for 2nt domains
  if (url.startsWith("https://vipsummer2024.x.2nt.com/")) {
    const httpUrl = url.replace("https://", "http://");
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await fetch(httpUrl, {
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            Connection: "close",
          },
          cache: "no-store",
          redirect: "follow",
          referrerPolicy: "no-referrer",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${httpUrl}`);
        return await response.text();
      } catch (err2) {
        lastErr = err2;
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }
  // final fallback: use curl
  try {
    const args = [
      "-sSL",
      "--fail",
      "--http1.1",
      "-A",
      USER_AGENT,
      "-H",
      "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      url,
    ];
    const { stdout } = await execFileAsync("curl", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    return stdout;
  } catch (err3) {
    lastErr = err3;
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

interface FetchBinaryOptions {
  referrer?: string;
}

async function fetchBinary(url: string, options: FetchBinaryOptions = {}) {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
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
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      const arrayBuffer = await response.arrayBuffer();
      return {
        buffer: Buffer.from(arrayBuffer),
        contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
      };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  if (url.startsWith("https://vipsummer2024.x.2nt.com/")) {
    const httpUrl = url.replace("https://", "http://");
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await fetch(httpUrl, {
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
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${httpUrl}`);
        const arrayBuffer = await response.arrayBuffer();
        return {
          buffer: Buffer.from(arrayBuffer),
          contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
        };
      } catch (err2) {
        lastErr = err2;
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }
  // final fallback: use curl to fetch binary
  try {
    const args = [
      "-sSL",
      "--fail",
      "--http1.1",
      "-A",
      USER_AGENT,
      "-H",
      "Accept: image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      url,
    ];
    const { stdout } = await execFileAsync("curl", args, { encoding: "latin1", maxBuffer: 50 * 1024 * 1024 });
    const buf = Buffer.from(stdout, "binary");
    return { buffer: buf, contentType: "" };
  } catch (err3) {
    lastErr = err3;
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
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
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true; // PNG
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return true; // JPEG
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return true; // GIF
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) return true; // BMP
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
    if (!looksLikeImageBuffer(buffer, contentType)) throw new Error(`Non-image response (${contentType || "unknown"})`);
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
  const candidates: Array<{ buffer: Buffer; extension: string; source: string; dims?: { width: number; height: number } }>= [];
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
  const highQualityExists = candidates.some((item) => item.dims && item.dims.width >= HIGH_WIDTH && item.dims.height >= HIGH_HEIGHT);

  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    if (highQualityExists && candidate.dims && (candidate.dims.width < HIGH_WIDTH || candidate.dims.height < HIGH_HEIGHT)) {
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
  await ensureDir(BANNERS_DIR);
  try {
    // banner src is in header.html: <img class="banner" src="img/bunner1.png">
    const headerHtml = await fetchText(`${BASE_URL}/header.html`);
    const $ = cheerio.load(headerHtml);
    const src = $("img.banner").attr("src");
    const bannerUrl = toAbsoluteUrl(src, `${BASE_URL}/header.html`);
    if (!bannerUrl) return undefined;
    const { buffer, contentType } = await fetchBinary(bannerUrl);
    if (!looksLikeImageBuffer(buffer, contentType)) throw new Error(`Non-image response (${contentType || "unknown"})`);
    const destPath = path.join(BANNERS_DIR, `${FESTIVAL_SLUG}.png`);
    await fs.writeFile(destPath, buffer);
    return `${RELATIVE_BANNERS_DIR}/${FESTIVAL_SLUG}.png`;
  } catch (error) {
    console.warn(`Failed to download banner:`, error);
    return undefined;
  }
}

async function parseIndex(): Promise<IndexEntry[]> {
  const html = await fetchText(INDEX_URL);
  const $ = cheerio.load(html);

  const table = $("centering_box table").first();
  const rows = table.find("tr").toArray();
  const entries: IndexEntry[] = [];

  // Iterate rows in pairs, include sample No.00 as a normal entry
  for (let i = 0; i < rows.length; i++) {
    const r1 = $(rows[i]);
    const tds = r1.find("td");
    if (tds.length === 0) continue;
    const noCell = tds.eq(0);
    const noText = sanitizeWhitespace(noCell.text());
    if (!noText) continue;
    // First actual row of a pair has 7 tds with title in td[3]
    const hasRowspan2 = noCell.attr("rowspan") === "2";
    if (!hasRowspan2) continue;

    // Peek the number (could be like "00" sample)
    const num = (noText.match(/\d+/)?.[0] ?? "").padStart(2, "0");
    const index = num; // keep for filenames and id suffix
    const iconUrl = tds.eq(1).find("img").attr("src");
    const thumbUrl = tds.eq(2).find("img").attr("src");
    const detailUrl = tds.eq(2).find("a").attr("href") || tds.eq(3).find("a").attr("href");
    const title = sanitizeWhitespace(tds.eq(3).text()) ?? `Work ${index}`;
    const genre = sanitizeWhitespace(tds.eq(4).text());
    const streamingRaw = sanitizeWhitespace(tds.eq(5).text());
    const dlAnchor = tds.eq(6).find("a").first();
    const downloadUrl = dlAnchor.attr("href");
    const downloadLabel = sanitizeWhitespace(dlAnchor.text());

    // second row for author/engine/forum
    const r2 = $(rows[i + 1] ?? []);
    const tds2 = r2.find("td");
    const author = sanitizeWhitespace(tds2.eq(0).text());
    const engine = sanitizeWhitespace(tds2.eq(1).text());
    const forumUrl = tds2.eq(2).find("a").attr("href");

    entries.push({
      index,
      no: num,
      title,
      iconUrl,
      thumbUrl,
      author,
      genre,
      engine,
      streamingRaw,
      detailUrl,
      forumUrl,
      downloadUrl,
      downloadLabel,
    });

    i += 1; // consume the second row
  }

  return entries;
}

async function parseDetail(url: string | undefined): Promise<DetailEntry> {
  if (!url) return {};
  const absolute = toAbsoluteUrl(url, INDEX_URL);
  if (!absolute) return {};
  try {
    const html = await fetchText(absolute);
    const $ = cheerio.load(html);

    const result: DetailEntry = {};

    // Collect screenshots from <img src> and possible onmouseover/onmouseout swap images
    const screenshotSet = new Set<string>();
    const addIfImage = (u: string | undefined) => {
      const resolved = toAbsoluteUrl(u, absolute);
      if (!resolved) return;
      if (!/\.(png|jpe?g|gif|bmp)$/i.test(resolved)) return;
      const lower = resolved.toLowerCase();
      if (lower.includes("/img/icon/")) return;
      if (lower.includes("/img/thumbnail/")) return;
      if (lower.includes("counter_img.php")) return;
      screenshotSet.add(resolved);
    };

    $("table img").each((_, img) => {
      const el = $(img);
      addIfImage(el.attr("src"));
      const attributes = ["onmouseover", "onmouseout", "data-src", "data-alt-src", "data-hover-src"];
      for (const attr of attributes) {
        const val = el.attr(attr);
        if (!val) continue;
        // match 'screenshot/xxx.ext' or quoted URL in JS handler
        const m = val.match(/([\w./-]+\.(?:png|jpe?g|gif|bmp))/i);
        if (m) addIfImage(m[1]);
        // also try any quoted path
        const m2 = val.match(/['\"]([^'\"]+\.(?:png|jpe?g|gif|bmp))['\"]/i);
        if (m2) addIfImage(m2[1]);
      }
    });
    if (screenshotSet.size > 0) result.screenshots = Array.from(screenshotSet);

    // Extract comments: content from <h2>.. until next <h2>
    function collectSectionText(headerText: string) {
      const header = $(`h2:contains(${headerText})`).first();
      if (header.length === 0) return undefined;
      const blocks = header.nextUntil("h2");
      const raw = blocks
        .map((_, el) => {
          const clone = $(el).clone();
          clone.find("br").replaceWith("\n");
          return clone.text();
        })
        .get()
        .join("\n");
      return sanitizeMultiline(raw);
    }

    result.authorComment = collectSectionText("作者のコメント");
    result.hostComment = collectSectionText("主催のコメント");

    return result;
  } catch (error) {
    console.warn(`Failed to parse detail page ${absolute} =>`, error);
    return {};
  }
}

async function processEntry(entry: IndexEntry) {
  const detail = await parseDetail(entry.detailUrl);

  const iconPath = await copyIcon(entry.index, entry.iconUrl);

  // Build screenshot source preference: detail page first, fallback to list thumbnail
  const screenshotSources = new Set<string>();
  if (detail.screenshots && detail.screenshots.length > 0) {
    for (const src of detail.screenshots) screenshotSources.add(src);
  }
  if (screenshotSources.size === 0) {
    const thumbAbs = toAbsoluteUrl(entry.thumbUrl, INDEX_URL);
    if (thumbAbs) screenshotSources.add(thumbAbs);
  }
  const screenshotResult = await copyScreenshots(entry.index, Array.from(screenshotSources));

  const work: WorkEntryOut = {
    id: `${FESTIVAL_ID}-work-${entry.index}`,
    festivalId: FESTIVAL_ID,
    no: entry.no,
    title: entry.title,
    author: entry.author ?? "",
    category: entry.genre,
    engine: entry.engine,
    streaming: entry.streamingRaw,
    forum: entry.forumUrl,
    authorComment: detail.authorComment,
    hostComment: detail.hostComment,
  };

  if (iconPath) work.icon = iconPath;
  if (screenshotResult.paths.length > 0) work.ss = screenshotResult.paths;

  const noteParts: string[] = [];
  if (!entry.downloadUrl) noteParts.push("ダウンロード: 未提供");
  if (screenshotResult.skipped.length > 0) {
    const small = screenshotResult.skipped.filter((s) => s.reason === "small").length;
    const dup = screenshotResult.skipped.filter((s) => s.reason === "duplicate").length;
    if (small > 0) noteParts.push(`skipped small: ${small}`);
    if (dup > 0) noteParts.push(`skipped dup: ${dup}`);
  }
  if (screenshotResult.failures.length > 0) noteParts.push(`screenshot failures: ${screenshotResult.failures.length}`);

  const downloadSources = [entry.downloadUrl]
    .filter((v): v is string => Boolean(v) && !v.toLowerCase().startsWith("javascript:"))
    .map((src) => toAbsoluteUrl(src, INDEX_URL) ?? src)
    .filter((v, i, arr) => arr.indexOf(v) === i);

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

  const banner = await copyBanner();
  const indexEntries = await parseIndex();

  const works: WorkEntryOut[] = [];
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
