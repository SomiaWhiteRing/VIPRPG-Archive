import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const FESTIVAL_ID = "2021-gw";
const FESTIVAL_SLUG = "2021-gw";
const BASE_URL = "https://viprpg2021gw.x.2nt.com";
const INDEX_URL = `${BASE_URL}/index.html`;

const OUTPUT_WORKS = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const CATCH_DIR = path.join(process.cwd(), "catch", FESTIVAL_SLUG);
const SUMMARY_PATH = path.join(CATCH_DIR, `${FESTIVAL_SLUG}-scrape-summary.json`);

const PUBLIC_DIR = path.join(process.cwd(), "public");
const BANNERS_DIR = path.join(PUBLIC_DIR, "banners");
const ICONS_DIR = path.join(PUBLIC_DIR, "icons", FESTIVAL_SLUG);
const SCREENSHOTS_DIR = path.join(PUBLIC_DIR, "screenshots", FESTIVAL_SLUG);

const RELATIVE_ICONS_DIR = `/icons/${FESTIVAL_SLUG}`;
const RELATIVE_SCREENSHOTS_DIR = `/screenshots/${FESTIVAL_SLUG}`;

const MAX_SCREENSHOTS = 6;
const SMALL_IMAGE_LIMIT = 100;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)" +
  " Chrome/130.0.0.0 Safari/537.36";

interface IndexEntry {
  index: string; // 2-digit
  no: string; // 2-digit
  title: string;
  iconUrl?: string;
  author?: string;
  genre?: string;
  engine?: string;
  streamingRaw?: string;
  detailUrl?: string;
  forumUrl?: string;
  downloadUrl?: string;
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
  no: string;
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
      } as RequestInit);
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return await response.text();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function fetchBinary(url: string) {
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
        referrerPolicy: "no-referrer",
      } as RequestInit);
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
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function toAbsoluteUrl(relative: string | undefined, base: string) {
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

async function saveBannerFromIndex() {
  try {
    const html = await fetchText(INDEX_URL);
    await ensureDir(CATCH_DIR);
    await fs.writeFile(path.join(CATCH_DIR, "menu_top.html"), html, "utf8");
    const $ = cheerio.load(html);
    // banner1.png is referenced in header
    const bannerSrc = $("img[src*='banner']").first().attr("src") || "banner1.png";
    // Use the page URL as base; the <base href> points to x.fc2.com which 404s for assets
    const bannerAbs = toAbsoluteUrl(bannerSrc, INDEX_URL);
    if (!bannerAbs) return;
    const { buffer } = await fetchBinary(bannerAbs);
    await ensureDir(BANNERS_DIR);
    const ext = getImageExtension(bannerAbs, ".png");
    const out = path.join(BANNERS_DIR, `${FESTIVAL_SLUG}${ext}`);
    await fs.writeFile(out, buffer);
  } catch (err) {
    console.warn("Failed to save banner:", err);
  }
}

function parseIndex(html: string): IndexEntry[] {
  const $ = cheerio.load(html);
  // Ignore <base href> since it points to x.fc2.com and many assets/pages live on x.2nt.com
  const baseForAssets = INDEX_URL;
  const entries: IndexEntry[] = [];
  const rows = $("#table2 tbody tr");
  rows.each((_, tr) => {
    const tds = $(tr).find("td");
    const th = $(tr).find("th");
    // skip header rows without number
    if (tds.length < 6) return;
    const noText = $(tr).find("td").first().text().trim();
    if (!/^\d{1,2}$/.test(noText)) return;
    const num = noText.padStart(2, "0");
    const index = num;

    const iconUrl = tds.eq(1).find("img").attr("src");
    const workCell = tds.eq(2);
    const detailUrl = workCell.find("a").attr("href");
    const title = sanitizeWhitespace(workCell.find("a").text()) ?? `Work ${index}`;
    const author = sanitizeWhitespace(workCell.find("span.font75").text());

    const genre = sanitizeWhitespace(tds.eq(3).contents().first().text());
    const engine = sanitizeWhitespace(tds.eq(3).find("span.font75").text());

    const dlCell = tds.eq(4);
    const downloadUrl = dlCell.find("a").first().attr("href");

    const streamingRaw = sanitizeWhitespace(tds.eq(5).text());
    const forumUrl = tds.eq(6).find("a").attr("href");

    entries.push({
      index,
      no: num,
      title,
      iconUrl: iconUrl ? toAbsoluteUrl(iconUrl, baseForAssets) : undefined,
      author,
      genre,
      engine,
      streamingRaw,
      detailUrl: detailUrl ? toAbsoluteUrl(detailUrl, INDEX_URL) : undefined,
      forumUrl: forumUrl ? toAbsoluteUrl(forumUrl, INDEX_URL) : undefined,
      downloadUrl: downloadUrl ? toAbsoluteUrl(downloadUrl, INDEX_URL) : undefined,
    });
  });
  return entries;
}

async function parseDetail(url: string | undefined): Promise<DetailEntry> {
  if (!url) return {};
  try {
    const html = await fetchText(url);
    await ensureDir(CATCH_DIR);
    const label = url.split("/").pop() || "entry.html";
    await fs.writeFile(path.join(CATCH_DIR, label), html, "utf8");
    const $ = cheerio.load(html);

    const result: DetailEntry = {};

    const img = $("#entry img[alt='SS画像']").first();
    const src = img.attr("src");
    const onOver = img.attr("onmouseover");
    const onOut = img.attr("onmouseout");
    // Ignore <base> (points to x.fc2.com); resolve relative assets against actual page URL
    const baseHref = url;
    const screenshotSet = new Set<string>();
    const addIfImage = (u?: string | null) => {
      if (!u) return;
      const abs = toAbsoluteUrl(u, baseHref);
      if (!abs) return;
      if (!/\.(png|jpe?g|gif|bmp)$/i.test(abs)) return;
      if (abs.toLowerCase().includes("counter_img.php")) return;
      screenshotSet.add(abs);
    };
    addIfImage(src ?? undefined);
    if (onOver) {
      const m1 = onOver.match(/['\"]([^'\"]+\.(?:png|jpe?g|gif|bmp))['\"]/i);
      if (m1) addIfImage(m1[1]);
    }
    if (onOut) {
      const m2 = onOut.match(/['\"]([^'\"]+\.(?:png|jpe?g|gif|bmp))['\"]/i);
      if (m2) addIfImage(m2[1]);
    }
    if (screenshotSet.size > 0) result.screenshots = Array.from(screenshotSet);

    const findRowText = (label: string) => {
      // rows like: <tr><td colspan="2" class="color2">作者：場末…</td></tr>
      const cell = $(`td:contains(${label})`).filter((_, el) => $(el).text().trim().startsWith(label));
      if (!cell.length) return undefined;
      const raw = cell.first().html() || cell.first().text();
      const replaced = raw.replace(/<br\s*\/?>(\s*)/gi, "\n");
      const $x = cheerio.load(`<div>${replaced}</div>`);
      const text = $x("div").text();
      // strip leading label + optional colon (both : and ：) and spaces (including fullwidth)
      const stripped = text.replace(new RegExp(`^${label}[\\s　]*[：:]?[\\s　]*`), "");
      return sanitizeMultiline(stripped);
    };

    result.authorComment = findRowText("作者コメント");
    result.hostComment = findRowText("管理人コメント") || findRowText("主催コメント");

    return result;
  } catch (error) {
    console.warn(`Failed to parse detail page ${url} =>`, error);
    return {};
  }
}

async function copyIcon(index: string, source: string | undefined): Promise<string | undefined> {
  if (!source) return undefined;
  await ensureDir(ICONS_DIR);
  try {
    const { buffer, contentType } = await fetchBinary(source);
    if (!looksLikeImageBuffer(buffer, contentType)) return undefined;
    const ext = getImageExtension(source, ".png");
    const file = `${index}${ext}`;
    await fs.writeFile(path.join(ICONS_DIR, file), buffer);
    return path.posix.join(RELATIVE_ICONS_DIR, file);
  } catch {
    return undefined;
  }
}

async function copyScreenshots(index: string, sources: string[]): Promise<DownloadResult> {
  await ensureDir(SCREENSHOTS_DIR);
  const skipped: ScreenshotSkip[] = [];
  const failures: string[] = [];
  const saved: string[] = [];
  const hashSet = new Set<string>();

  await purgeScreenshots(index);

  let order = 1;
  for (const src of sources) {
    if (saved.length >= MAX_SCREENSHOTS) break;
    try {
      const { buffer, contentType } = await fetchBinary(src);
      if (!looksLikeImageBuffer(buffer, contentType)) {
        failures.push(src + " (not image: " + (contentType || "unknown") + ")");
        continue;
      }
      const dim = getImageDimensions(buffer);
      if (dim && dim.width < SMALL_IMAGE_LIMIT && dim.height < SMALL_IMAGE_LIMIT) {
        skipped.push({ source: src, reason: "small" });
        continue;
      }
      const md5 = createHash("md5").update(buffer).digest("hex");
      if (hashSet.has(md5)) {
        skipped.push({ source: src, reason: "duplicate" });
        continue;
      }
      hashSet.add(md5);
      const ext = getImageExtension(src, ".png");
      const file = order === 1 ? `${index}${ext}` : `${index}-${String(order).padStart(2, "0")}${ext}`;
      await fs.writeFile(path.join(SCREENSHOTS_DIR, file), buffer);
      saved.push(path.posix.join(RELATIVE_SCREENSHOTS_DIR, file));
      order += 1;
    } catch (err) {
      failures.push(src + " => " + (err as Error).message);
    }
  }

  return { paths: saved, skipped, failures };
}

async function run() {
  await ensureDir(CATCH_DIR);
  await ensureDir(BANNERS_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);

  await saveBannerFromIndex();

  const indexHtml = await fetchText(INDEX_URL);
  await fs.writeFile(path.join(CATCH_DIR, "index.html"), indexHtml, "utf8");
  const entries = parseIndex(indexHtml);

  const out: WorkEntryOut[] = [];
  const summary: SnapshotRecord[] = [];

  for (const e of entries) {
    const detail = await parseDetail(e.detailUrl);
    const iconLocal = await copyIcon(e.index, e.iconUrl);

    const screenshotSources = new Set<string>();
    if (detail.screenshots && detail.screenshots.length > 0) {
      for (const src of detail.screenshots) screenshotSources.add(src);
    }
    const screenshotResult = await copyScreenshots(e.index, Array.from(screenshotSources));

    const work: WorkEntryOut = {
      id: `${FESTIVAL_ID}-work-${e.index}`,
      festivalId: FESTIVAL_ID,
      no: e.no,
      title: e.title,
      author: e.author ?? "",
      category: e.genre,
      engine: e.engine,
      streaming: e.streamingRaw,
      forum: e.forumUrl,
      authorComment: detail.authorComment,
      hostComment: detail.hostComment,
      icon: iconLocal,
      ss: screenshotResult.paths.length > 0 ? screenshotResult.paths : undefined,
    };
    out.push(work);

    summary.push({
      index: e.index,
      status: "ok",
      title: e.title,
      icon: iconLocal,
      downloadSource: e.downloadUrl ? [e.downloadUrl] : undefined,
      screenshotReport: {
        saved: screenshotResult.paths.length,
        skipped: screenshotResult.skipped.length > 0 ? screenshotResult.skipped : undefined,
        failures: screenshotResult.failures.length > 0 ? screenshotResult.failures : undefined,
      },
    });
  }

  await fs.writeFile(OUTPUT_WORKS, JSON.stringify(out, null, 2), "utf8");
  await fs.writeFile(SUMMARY_PATH, JSON.stringify(summary, null, 2), "utf8");

  console.log(`Saved works to ${OUTPUT_WORKS}`);
  console.log(`Summary written to ${SUMMARY_PATH}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
