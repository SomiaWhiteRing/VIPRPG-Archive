import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const FESTIVAL_ID = "2022-summer";
const FESTIVAL_SLUG = "2022-summer";
const BASE_URL = "https://viprpg2022s.suppa.jp";
const INDEX_URL = `${BASE_URL}/index.html`;
const ENTRY_URL = `${BASE_URL}/entry.html`;

const OUTPUT_WORKS = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const CATCH_DIR = path.join(process.cwd(), "catch", FESTIVAL_SLUG);
const SUMMARY_PATH = path.join(CATCH_DIR, `${FESTIVAL_SLUG}-scrape-summary.json`);

const PUBLIC_DIR = path.join(process.cwd(), "public");
const BANNERS_DIR = path.join(PUBLIC_DIR, "banners");
const ICONS_DIR = path.join(PUBLIC_DIR, "icons", FESTIVAL_SLUG);
const SCREENSHOTS_DIR = path.join(PUBLIC_DIR, "screenshots", FESTIVAL_SLUG);

const RELATIVE_SCREENSHOTS_DIR = `/screenshots/${FESTIVAL_SLUG}`;

const MAX_SCREENSHOTS = 6;
const SMALL_IMAGE_LIMIT = 100;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)" +
  " Chrome/130.0.0.0 Safari/537.36";

interface DetailEntry {
  index: string;
  no: string; // two-digit
  title: string;
  author: string;
  category?: string;
  engine?: string;
  streaming?: string;
  authorComment?: string;
  hostComment?: string; // 管理人コメント
  downloadUrl?: string;
  forumUrl?: string;
  screenshots: string[]; // absolute URLs
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
  streaming?: string; // keep raw
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

async function saveBannerFromIndex() {
  try {
    const html = await fetchText(INDEX_URL);
    await ensureDir(CATCH_DIR);
    await fs.writeFile(path.join(CATCH_DIR, "menu_top.html"), html, "utf8");
    // Try to locate a banner image; fallback to s2022.png
    const $ = cheerio.load(html);
    let bannerSrc = $("img[src*='s2022']").attr("src") || undefined;
    if (!bannerSrc) bannerSrc = "s2022.png";
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

async function parseEntriesFromEntryHtml(): Promise<DetailEntry[]> {
  const html = await fetchText(ENTRY_URL);
  await ensureDir(CATCH_DIR);
  await fs.writeFile(path.join(CATCH_DIR, "entry.html"), html, "utf8");

  const $ = cheerio.load(html);
  const results: DetailEntry[] = [];

  $("article").each((_, node) => {
    const art = $(node);
    const h2 = art.find("h2").first().text().trim();
    const m = h2.match(/^No\.(\d+)\s*(.+)$/);
    if (!m) return;
    const num = m[1];
    const index = num.padStart(2, "0");
    const title = sanitizeWhitespace(m[2]) || `Work ${index}`;

    const screenshots = new Set<string>();
    const img = art.find("img").first();
    const src = img.attr("src");
    const onOver = img.attr("onmouseover");
    const onOut = img.attr("onmouseout");
    const addIfImage = (u?: string) => {
      const abs = toAbsoluteUrl(u, ENTRY_URL);
      if (!abs) return;
      if (!/\.(png|jpe?g|gif|bmp)$/i.test(abs)) return;
      screenshots.add(abs);
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

    const pickText = (label: string) => {
      const header = art.find(`h4:contains(${label})`).first();
      if (!header.length) return undefined;
      const p = header.nextAll("p").first();
      return sanitizeWhitespace(p.text());
    };

    const collectBlock = (label: string) => {
      const header = art.find(`h4:contains(${label})`).first();
      if (!header.length) return undefined;
      const nodes = header.nextUntil("h4, nav");
      const clone = cheerio.load("<div></div>")("div");
      nodes.each((_, el) => {
        const $el = $(el).clone();
        $el.find("br").replaceWith("\n");
        clone.append($el);
      });
      const text = clone.text();
      return sanitizeMultiline(text);
    };

    const author = pickText("【作者名】") || "";
    const category = pickText("【ジャンル】");
    const engine = pickText("【ツール】");
    const streaming = pickText("【配信/投稿】");
    const authorComment = collectBlock("【作者コメント】");
    const hostComment = collectBlock("【管理人コメント】") || collectBlock("【主催コメント】");

    // nav links
    let downloadUrl: string | undefined;
    let forumUrl: string | undefined;
    art.find("nav a").each((_, a) => {
      const el = $(a);
      const text = (el.text() || "").trim();
      const href = toAbsoluteUrl(el.attr("href") || undefined, ENTRY_URL);
      if (!href) return;
      if (text.startsWith("ダウンロード")) downloadUrl = href;
      if (text.includes("感想掲示板")) forumUrl = href;
    });

    results.push({
      index,
      no: index,
      title,
      author,
      category,
      engine,
      streaming,
      authorComment,
      hostComment,
      downloadUrl,
      forumUrl,
      screenshots: Array.from(screenshots),
    });
  });

  return results;
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
      // Filter non-image responses
      if (!contentType.startsWith("image/")) {
        failures.push(src + " (not image: " + contentType + ")");
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

  const entries = await parseEntriesFromEntryHtml();

  const out: WorkEntryOut[] = [];
  const summary: SnapshotRecord[] = [];

  for (const e of entries) {
    const screenshotResult = await copyScreenshots(e.index, e.screenshots);

    const work: WorkEntryOut = {
      id: `${FESTIVAL_ID}-work-${e.index}`,
      festivalId: FESTIVAL_ID,
      no: e.no,
      title: e.title,
      author: e.author,
      category: e.category,
      engine: e.engine,
      streaming: e.streaming,
      forum: e.forumUrl,
      authorComment: e.authorComment,
      hostComment: e.hostComment,
      // No dedicated icon resource on this site; leave undefined.
      ss: screenshotResult.paths.length > 0 ? screenshotResult.paths : undefined,
    };
    out.push(work);

    summary.push({
      index: e.index,
      status: "ok",
      title: e.title,
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
