import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";

const execFileAsync = promisify(execFile);

const FESTIVAL_ID = "2019-kouhaku";
const FESTIVAL_SLUG = "2019-kouhaku";
const BASE_URL = "https://kohakuviprpg2019.x.2nt.com";
const INDEX_URL = `${BASE_URL}/index.html`;
const LIST_URL = `${BASE_URL}/list/`;

const OUTPUT_WORKS = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const CATCH_DIR = path.join(process.cwd(), "catch", FESTIVAL_SLUG);
const SUMMARY_PATH = path.join(CATCH_DIR, `${FESTIVAL_SLUG}-scrape-summary.json`);
const ENTRY_DIR = path.join(CATCH_DIR, "entry");

const PUBLIC_DIR = path.join(process.cwd(), "public");
const BANNERS_DIR = path.join(PUBLIC_DIR, "banners");
const ICONS_DIR = path.join(PUBLIC_DIR, "icons", FESTIVAL_SLUG);
const SCREENSHOTS_DIR = path.join(PUBLIC_DIR, "screenshots", FESTIVAL_SLUG);

const RELATIVE_BANNERS_DIR = "/banners";
const RELATIVE_ICONS_DIR = `/icons/${FESTIVAL_SLUG}`;
const RELATIVE_SCREENSHOTS_DIR = `/screenshots/${FESTIVAL_SLUG}`;

const MAX_SCREENSHOTS = 6;
const SMALL_IMAGE_LIMIT = 100;

const CURL_BASE_ARGS = ["--silent", "--show-error", "--retry", "2", "--retry-delay", "1", "--location", "--fail"];

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

interface IndexEntry {
  index: string;
  title: string;
  author?: string;
  genre?: string;
  engine?: string;
  iconUrl?: string;
  detailUrl?: string;
  forumUrl?: string;
  downloadUrl?: string;
  downloadLabel?: string;
}

function sanitizeWhitespace(value: string | undefined | null) {
  if (!value) return undefined;
  const result = value.replace(/\s+/g, " ").trim();
  return result || undefined;
}

function sanitizeMultiline(value: string | undefined | null) {
  if (!value) return undefined;
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line, idx, arr) => line.length > 0 || (idx > 0 && arr[idx - 1].length > 0));
  const result = lines.join("\n");
  return result || undefined;
}

function stripLeadingBrackets(text: string | undefined | null) {
  if (!text) return undefined;
  // Remove any leading fullwidth/square closing brackets like 】 or ] that may remain after header removal
  const cleaned = text.replace(/^[\s\uFEFF]*[】\]]+\s*/g, "");
  return cleaned || undefined;
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

async function curlToFile(url: string, destPath: string) {
  await ensureDir(path.dirname(destPath));
  await execFileAsync("curl", [...CURL_BASE_ARGS, "--referer", "", url, "-o", destPath], { encoding: "buffer" });
}

async function curlBuffer(url: string): Promise<Buffer> {
  const { stdout } = (await execFileAsync("curl", [...CURL_BASE_ARGS, "--referer", "", url], { encoding: "buffer" })) as unknown as { stdout: Buffer };
  return stdout;
}

function decodeHtmlBuffer(buffer: Buffer) {
  // Try to detect UTF-8; otherwise fall back to Shift_JIS
  const utf8 = buffer.toString("utf8");
  const head = utf8.slice(0, 512).toLowerCase();
  if (head.includes("charset=utf-8") || head.includes("encoding=\"utf-8\"")) return utf8;
  try {
    return iconv.decode(buffer, "shift_jis");
  } catch {
    return utf8;
  }
}

function toAbsoluteUrl(relative: string | undefined, base: string) {
  if (!relative) return undefined;
  try {
    return new URL(relative, base).toString();
  } catch {
    return undefined;
  }
}

function assetExtensionFromUrl(input: string, fallback = ".png") {
  const base = input.split(/[?#]/)[0];
  const ext = path.extname(base).toLowerCase();
  if (ext === ".jpeg") return ".jpg";
  if (ext) return ext;
  return fallback;
}

function getImageDimensions(buffer: Buffer) {
  // PNG
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  // JPEG
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
  // GIF
  if (buffer.length >= 10 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  // BMP
  if (buffer.length >= 26 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    const width = buffer.readInt32LE(18);
    const height = Math.abs(buffer.readInt32LE(22));
    return { width, height };
  }
  return undefined;
}

function looksLikeImageBuffer(buffer: Buffer, contentTypeHint?: string) {
  if (contentTypeHint && contentTypeHint.toLowerCase().startsWith("image/")) return true;
  if (buffer.length >= 4) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true;
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return true;
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return true;
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) return true;
  }
  return false;
}

async function copyBanner() {
  // Use header image on index page
  const bannerCandidate = `${BASE_URL}/img/topbanar.png`;
  const dest = path.join(BANNERS_DIR, `${FESTIVAL_SLUG}${assetExtensionFromUrl(bannerCandidate, ".png")}`);
  try {
    await ensureDir(BANNERS_DIR);
    if (!(await fileExists(dest))) {
      await curlToFile(bannerCandidate, dest);
    }
    return `${RELATIVE_BANNERS_DIR}/${path.basename(dest)}`;
  } catch {
    return undefined;
  }
}

async function readHtmlFrom(url: string, destPath: string) {
  if (!(await fileExists(destPath))) {
    await curlToFile(url, destPath);
  }
  const buffer = await fs.readFile(destPath);
  return decodeHtmlBuffer(buffer);
}

function normalizeNo(raw: string) {
  const digits = (raw.match(/\d+/)?.[0] ?? "").trim();
  if (!digits) return undefined;
  return digits.length >= 2 ? digits : digits.padStart(2, "0");
}

async function parseIndexList(): Promise<IndexEntry[]> {
  const menuEntryPath = path.join(CATCH_DIR, "menu_entry.html");
  const html = await readHtmlFrom(LIST_URL, menuEntryPath);
  const $ = cheerio.load(html);
  const entries: IndexEntry[] = [];

  $("div.tyuuou2, div.tyuuou3").each((_, el) => {
    const container = $(el);
    const noText = container.find("div.number").text();
    const index = normalizeNo(noText) ?? "";
    if (!index) return; // skip malformed

    const title = sanitizeWhitespace(container.find("div.name b a").text()) ?? `Work ${index}`;
    const detailUrl = toAbsoluteUrl(container.find("div.name b a").attr("href"), LIST_URL);
    const iconUrl = toAbsoluteUrl(container.find("div.icon img").attr("src"), LIST_URL);
    const author = sanitizeWhitespace(container.find("div.author p").text());
    const genre = sanitizeWhitespace(container.find("div.genre").text());
    const engine = sanitizeWhitespace(container.find("div.tkool").text());

    let forumUrl: string | undefined;
    let downloadUrl: string | undefined;
    let downloadLabel: string | undefined;
    container.find("div.downlord a").each((__, a) => {
      const href = $(a).attr("href") || "";
      const label = $(a).text();
      if (/drive|dropbox|onedrive|mega|\.zip/i.test(href) || /download/i.test(label)) {
        downloadUrl = toAbsoluteUrl(href, LIST_URL) ?? href;
        // Sometimes label like DOWNLOAD(178.0Mb) sits in sibling or same anchor text
        const raw = $(a).text() || container.find("div.downlord").text();
        const m = raw.match(/download\s*\(([^)]+)\)/i);
        downloadLabel = m ? m[1] : undefined;
      } else if (!forumUrl) {
        forumUrl = toAbsoluteUrl(href, LIST_URL) ?? href;
      }
    });

    entries.push({ index, title, iconUrl, detailUrl, author, genre, engine, forumUrl, downloadUrl, downloadLabel });
  });

  // Ensure stable order by index
  entries.sort((a, b) => a.index.localeCompare(b.index, undefined, { numeric: true }));
  return entries;
}

async function parseDetail(entry: IndexEntry) {
  const detailUrl = entry.detailUrl;
  if (!detailUrl) return { authorComment: undefined as string | undefined, hostComment: undefined as string | undefined, screenshots: [] as string[] };
  const label = detailUrl.includes("web.archive.org") ? "wayback" : "direct";
  const destPath = path.join(ENTRY_DIR, `${entry.index}_${label}.html`);
  const html = await readHtmlFrom(detailUrl, destPath);
  const $ = cheerio.load(html);

  // Collect screenshots from <img> and image-like attributes
  const screenshotSet = new Set<string>();
  const record = (src?: string) => {
    if (!src) return;
    try {
      const absolute = new URL(src, detailUrl).toString();
      if (/\.(png|jpe?g|gif|bmp)$/i.test(absolute)) screenshotSet.add(absolute);
    } catch {
      // ignore
    }
  };
  $("img").each((_, img) => {
    const src = $(img).attr("src");
    record(src);
    // also scan attributes for inline onmouseover switching
    const attribs = (img as cheerio.Element).attribs ?? {};
    for (const value of Object.values(attribs)) {
      if (typeof value !== "string") continue;
      const parts = value.split(/[\s'"()]/);
      parts.forEach((p) => record(p));
    }
  });
  $("a").each((_, a) => record($(a).attr("href")));

  // Extract author and host comments heuristically from text blocks
  let authorComment: string | undefined;
  let hostComment: string | undefined;
  let streaming: string | undefined;
  $("div.ran").each((_, block) => {
    const text = sanitizeMultiline($(block).text());
    if (!text) return;
    // Try line-by-line parsing for labeled fields
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (!streaming && /(動画\s*配信)/i.test(line)) {
        const val = line.replace(/^.*?動画\s*配信[】\]]?[:：]?/i, "").trim();
        if (val) streaming = stripLeadingBrackets(val);
      }
      if (!streaming && /(配信)\s*[\/／]\s*(動画|投稿)/.test(line)) {
        // e.g. 【配信/投稿】 いいぜ/いいぜ
        const after = line.replace(/^.*?[】\]]\s*/, "");
        const pair = after.split(/[\/／]/).map((s) => s.trim()).filter(Boolean);
        if (pair.length === 2) {
          streaming = `配信: ${pair[0]} / 動画: ${pair[1]}`;
        } else if (pair.length === 1) {
          streaming = `配信: ${pair[0]}`;
        }
      }
      if (!streaming) {
        const m = line.match(/^【[^】]*配信[^】]*】\s*(.+)$/);
        if (m && m[1]) {
          const raw = m[1].trim();
          const parts = raw.split(/[\/／]/).map((s) => s.trim()).filter(Boolean);
          if (parts.length === 2) {
            streaming = `配信: ${parts[0]} / 動画: ${parts[1]}`;
          } else {
            streaming = raw;
          }
        }
      }
    }
    if (!authorComment && /コメント|ｺﾒﾝﾄ/i.test(text) && !/管理人|主催/i.test(text)) {
      const replaced = text.replace(/^.*?コメント[】\]]?[:：]?/i, "").trim();
      authorComment = stripLeadingBrackets(replaced);
    }
    if (!hostComment && /(管理人|主催)コメント/i.test(text)) {
      const replaced = text.replace(/^.*?(管理人|主催)コメント[】\]]?[:：]?/i, "").trim();
      hostComment = stripLeadingBrackets(replaced);
    }
  });

  return { authorComment, hostComment, screenshots: Array.from(screenshotSet), streaming };
}

async function purgeScreenshots(index: string) {
  try {
    const files = await fs.readdir(SCREENSHOTS_DIR);
    await Promise.all(
      files.filter((f) => f.startsWith(index)).map((f) => fs.unlink(path.join(SCREENSHOTS_DIR, f)).catch(() => undefined))
    );
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw error;
  }
}

async function copyIcon(index: string, url?: string) {
  if (!url) return undefined;
  const destFile = `${index}${assetExtensionFromUrl(url, ".png")}`;
  const destPath = path.join(ICONS_DIR, destFile);
  try {
    await ensureDir(ICONS_DIR);
    if (!(await fileExists(destPath))) {
      const buffer = await curlBuffer(url);
      if (!looksLikeImageBuffer(buffer)) throw new Error("non-image response");
      await fs.writeFile(destPath, buffer);
    }
    return `${RELATIVE_ICONS_DIR}/${destFile}`;
  } catch (error) {
    await fs.unlink(destPath).catch(() => undefined);
    return undefined;
  }
}

async function copyScreenshots(index: string, urls: string[]): Promise<ScreenshotResult> {
  await ensureDir(SCREENSHOTS_DIR);
  await purgeScreenshots(index);
  const seenHashes = new Set<string>();
  const seenSources = new Set<string>();
  const accepted: { buffer: Buffer; extension: string; source: string; dims?: { width: number; height: number } }[] = [];
  const skipped: ScreenshotSkip[] = [];
  const failures: string[] = [];

  for (const src of urls) {
    if (!src) continue;
    if (seenSources.has(src)) continue;
    seenSources.add(src);
    try {
      const buffer = await curlBuffer(src);
      if (!looksLikeImageBuffer(buffer)) {
        failures.push(src);
        continue;
      }
      const dims = getImageDimensions(buffer);
      if (dims && dims.width < SMALL_IMAGE_LIMIT && dims.height < SMALL_IMAGE_LIMIT) {
        skipped.push({ source: src, reason: "small" });
        continue;
      }
      const hash = createHash("md5").update(buffer).digest("hex");
      if (seenHashes.has(hash)) {
        skipped.push({ source: src, reason: "duplicate" });
        continue;
      }
      seenHashes.add(hash);
      accepted.push({ buffer, extension: assetExtensionFromUrl(src, ".png"), source: src, dims });
    } catch (error) {
      failures.push(src);
    }
  }

  // Prefer higher-resolution if available
  const HIGH_W = 400;
  const HIGH_H = 300;
  const highExists = accepted.some((c) => c.dims && c.dims.width >= HIGH_W && c.dims.height >= HIGH_H);
  const filtered = highExists ? accepted.filter((c) => c.dims && c.dims.width >= HIGH_W && c.dims.height >= HIGH_H) : accepted;

  const limited = filtered.slice(0, MAX_SCREENSHOTS);
  const paths: string[] = [];
  for (let i = 0; i < limited.length; i += 1) {
    const candidate = limited[i];
    const suffix = i === 0 ? "" : `-${String(i + 1).padStart(2, "0")}`;
    const fileName = `${index}${suffix}${candidate.extension}`;
    const destPath = path.join(SCREENSHOTS_DIR, fileName);
    await fs.writeFile(destPath, candidate.buffer);
    paths.push(`${RELATIVE_SCREENSHOTS_DIR}/${fileName}`);
  }
  return { paths, skipped, failures };
}

function buildStreaming(detailStreaming?: string) {
  if (detailStreaming && detailStreaming.trim().length) return detailStreaming.trim();
  return undefined;
}

async function processEntry(entry: IndexEntry) {
  const detail = await parseDetail(entry);
  const iconPath = await copyIcon(entry.index, entry.iconUrl);

  const screenshotSources = new Set<string>();
  for (const s of detail.screenshots) screenshotSources.add(s);
  const screenshotResult = await copyScreenshots(entry.index, Array.from(screenshotSources));

  const work: WorkEntry = {
    id: `${FESTIVAL_ID}-work-${entry.index}`,
    festivalId: FESTIVAL_ID,
    no: entry.index,
    title: entry.title,
    author: entry.author ?? "",
    category: entry.genre,
    engine: entry.engine,
    streaming: buildStreaming(detail.streaming),
    forum: entry.forumUrl,
    authorComment: stripLeadingBrackets(detail.authorComment),
    hostComment: stripLeadingBrackets(detail.hostComment),
  };

  if (iconPath) work.icon = iconPath;
  if (screenshotResult.paths.length > 0) work.ss = screenshotResult.paths;

  const noteParts: string[] = [];
  if (!entry.downloadUrl) {
    noteParts.push("ダウンロード: 未提供");
  } else if (entry.downloadLabel) {
    noteParts.push(`ダウンロード: ${entry.downloadLabel}`);
  }
  if (screenshotResult.skipped.length > 0) {
    const small = screenshotResult.skipped.filter((s) => s.reason === "small").length;
    const dup = screenshotResult.skipped.filter((s) => s.reason === "duplicate").length;
    if (small > 0) noteParts.push(`skipped small: ${small}`);
    if (dup > 0) noteParts.push(`skipped dup: ${dup}`);
  }
  if (screenshotResult.failures.length > 0) {
    noteParts.push(`screenshot failures: ${screenshotResult.failures.length}`);
  }

  const downloadSources = entry.downloadUrl ? [entry.downloadUrl] : [];

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
  await ensureDir(ENTRY_DIR);
  await ensureDir(BANNERS_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);

  // Cache top and list pages
  await readHtmlFrom(INDEX_URL, path.join(CATCH_DIR, "menu_top.html"));
  const banner = await copyBanner();
  const entries = await parseIndexList();

  const works: WorkEntry[] = [];
  const snapshots: SnapshotRecord[] = [];

  for (const entry of entries) {
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
      skipped: snapshots.filter((s) => s.status !== "ok").length,
    },
    entries: snapshots,
  };
  await fs.writeFile(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`Captured ${works.length} works. Errors: ${summary.stats.skipped}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
