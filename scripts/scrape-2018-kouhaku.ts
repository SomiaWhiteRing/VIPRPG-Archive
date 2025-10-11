import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const execFileAsync = promisify(execFile);

const FESTIVAL_ID = "2018-kouhaku";
const FESTIVAL_SLUG = "2018-kouhaku";
const BASE_URL = "https://viprpgmsmkohaku2018.web.fc2.com";
const INDEX_URL = `${BASE_URL}/index.html`;

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

const CURL_BASE_ARGS = ["--silent", "--show-error", "--retry", "2", "--retry-delay", "1", "--location", "--fail", "--referer", ""];

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
  streamingCell?: string;
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
  await execFileAsync("curl", [...CURL_BASE_ARGS, url, "-o", destPath], { encoding: "buffer" });
}

async function curlBuffer(url: string): Promise<Buffer> {
  const { stdout } = (await execFileAsync("curl", [...CURL_BASE_ARGS, url], { encoding: "buffer" })) as unknown as { stdout: Buffer };
  return stdout;
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
  const bannerCandidate = `${BASE_URL}/banner/kohaku2018.png`;
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

async function downloadHtmlResilient(url: string, destPath: string) {
  try {
    await curlToFile(url, destPath);
    return;
  } catch (error) {
    if (url.startsWith("https://")) {
      const httpUrl = url.replace("https://", "http://");
      await curlToFile(httpUrl, destPath);
      return;
    }
    throw error;
  }
}

async function readHtmlFrom(url: string, destPath: string) {
  if (!(await fileExists(destPath))) {
    await downloadHtmlResilient(url, destPath);
  }
  const buffer = await fs.readFile(destPath);
  // 2018 site is UTF-8
  return buffer.toString("utf8");
}

function normalizeNo(raw: string) {
  const digits = (raw.match(/\d+/)?.[0] ?? "").trim();
  if (!digits) return undefined;
  return digits.length >= 2 ? digits : digits.padStart(2, "0");
}

async function parseIndexList(): Promise<IndexEntry[]> {
  const listPath = path.join(CATCH_DIR, "menu_entry.html");
  const html = await readHtmlFrom(INDEX_URL, listPath);
  const $ = cheerio.load(html);
  const entries: IndexEntry[] = [];
  // Find the table under #gamelist
  const table = $("#gamelist").nextAll("table").first();
  const rows = table.find("> tbody > tr").toArray();
  for (const row of rows) {
    const tds = $(row).find("td");
    if (tds.length < 7) continue;
    const noText = tds.eq(0).text();
    const index = normalizeNo(noText) ?? "";
    if (!index) continue;
    const iconUrl = toAbsoluteUrl(tds.eq(1).find("img").attr("src"), INDEX_URL);
    const titleAnchor = tds.eq(2).find("a").first();
    const detailUrl = toAbsoluteUrl(titleAnchor.attr("href"), INDEX_URL);
    // Title from anchor text; author from <font> content after <br>
    let anchorText = titleAnchor.text() || "";
    // Remove author tail or split at newline
    const authorCandidate = sanitizeWhitespace(tds.eq(2).find("font").text()) || "";
    if (anchorText.includes("\n")) anchorText = anchorText.split("\n")[0];
    if (authorCandidate && anchorText.endsWith(authorCandidate)) {
      anchorText = anchorText.slice(0, -authorCandidate.length);
    }
    const title = sanitizeWhitespace(anchorText);
    const author = sanitizeWhitespace(authorCandidate);
    // Genre/Engine
    const geHtml = tds.eq(3).html() ?? "";
    const geText = cheerio.load(`<div>${geHtml.replace(/<br\s*\/?\s*>/gi, "\n")}</div>`)("div").text();
    const geLines = (geText || "").split(/\n/).map((s) => s.trim()).filter(Boolean);
    const genre = geLines[0] || undefined;
    const engine = geLines[1] || undefined;
    // Download cell link
    const dlAnchor = tds.eq(4).find("a").first();
    const downloadUrl = dlAnchor.attr("href") ? toAbsoluteUrl(dlAnchor.attr("href"), INDEX_URL) ?? dlAnchor.attr("href") : undefined;
    const dlHtml = tds.eq(4).html() ?? "";
    const dlText = (dlAnchor.text() || cheerio.load(`<div>${dlHtml.replace(/<br\s*\/?\s*>/gi, "\n")}</div>`)("div").text());
    const sizeMatch = dlText.match(/([\d.]+\s*MB|\d+\.\d+\s*MB|\d+\s*MB|0\.0+MB|0\.00MB|0\.0MB|0\.00MB)/i);
    const downloadLabel = sizeMatch ? sizeMatch[1] : undefined;
    const streamingCell = sanitizeWhitespace(tds.eq(5).text());
    const forumUrl = toAbsoluteUrl(tds.eq(6).find("a").attr("href"), INDEX_URL);

    entries.push({ index, title: title ?? `Work ${index}`, author, genre, engine, iconUrl, detailUrl, forumUrl, downloadUrl, downloadLabel, streamingCell });
  }
  // Remove header rows with non-numeric index
  const filtered = entries.filter((e) => /\d+/.test(e.index));
  filtered.sort((a, b) => a.index.localeCompare(b.index, undefined, { numeric: true }));
  return filtered;
}

async function parseDetail(entry: IndexEntry) {
  const detailUrl = entry.detailUrl;
  if (!detailUrl) return { authorComment: undefined as string | undefined, hostComment: undefined as string | undefined, screenshots: [] as string[], streaming: undefined as string | undefined };
  const label = detailUrl.includes("web.archive.org") ? "wayback" : "direct";
  const destPath = path.join(ENTRY_DIR, `${entry.index}_${label}.html`);
  const html = await readHtmlFrom(detailUrl, destPath);
  const $ = cheerio.load(html);

  // Screenshots: collect from <img>, attributes (onmouseover...), and anchors
  const screenshotSet = new Set<string>();
  const record = (raw?: string) => {
    if (!raw) return;
    const parts = raw.split(/[\s'"()]+/);
    for (const part of parts) {
      if (!part) continue;
      try {
        const abs = toAbsoluteUrl(part, detailUrl);
        if (!abs) continue;
        const lower = abs.toLowerCase();
        if (/icon\//i.test(lower)) continue; // skip icons
        if (lower.includes("counter_img.php")) continue;
        if (/\.(png|jpe?g|gif|bmp)$/i.test(abs)) screenshotSet.add(abs);
      } catch {
        // ignore
      }
    }
  };
  $("img").each((_, el) => {
    const img = $(el);
    record(img.attr("src"));
    const attribs = (el as cheerio.Element).attribs ?? {};
    for (const value of Object.values(attribs)) {
      if (typeof value !== "string") continue;
      record(value);
    }
  });
  $("a").each((_, a) => record($(a).attr("href")));

  // Extract fields from rows
  let authorComment: string | undefined;
  let hostComment: string | undefined;
  let streaming: string | undefined;
  const trs = $("table tr").toArray();
  for (const tr of trs) {
    const td = $(tr).find("td").first();
    const rawHtml = td.length ? (td.html() ?? "") : ($(tr).html() ?? "");
    const text = sanitizeMultiline(cheerio.load(`<div>${rawHtml.replace(/<br\s*\/?\s*>/gi, "\n")}</div>`)("div").text());
    if (!text) continue;
    if (!streaming && /^配信\s*\/\s*投稿/.test(text)) {
      const val = text.replace(/^配信\s*\/\s*投稿\s*[:：]?/i, "").trim();
      if (val) streaming = val;
    }
    if (!authorComment && /作者コメント/.test(text)) {
      // keep HTML after the label and optional <br>
      const html = rawHtml.replace(/^\s*作者コメント\s*[:：]?\s*(<br\s*\/?\s*>\s*)?/i, "").trim();
      if (html) authorComment = html;
    }
    if (!hostComment && /管理人コメント/.test(text)) {
      const html = rawHtml.replace(/^\s*管理人コメント\s*[:：]?\s*(<br\s*\/?\s*>\s*)?/i, "").trim();
      if (html) hostComment = html;
    }
  }

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

function buildStreaming(listCell?: string, detail?: string) {
  const value = sanitizeWhitespace(detail) ?? sanitizeWhitespace(listCell);
  return value || undefined;
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
    streaming: buildStreaming(entry.streamingCell, detail.streaming),
    forum: entry.forumUrl,
    authorComment: detail.authorComment,
    hostComment: detail.hostComment,
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
