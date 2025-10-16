import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const FESTIVAL_ID = "2017-kouhaku";
const FESTIVAL_SLUG = "2017-kouhaku";
const BASE_URL = "https://websupportviprpg.xxxxxxxx.jp/archive/kohaku2017";
const MAIN_INDEX_URL = `${BASE_URL}/main/index.html`;
const LIST_URL = `${BASE_URL}/main/03_list.html`;
const DATA_URL = `${BASE_URL}/games/data.json`;
const IMG_GAMES_BASE = `${BASE_URL}/img/games`;

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

type GameRecord = {
  time?: string | number | null;
  title?: string;
  author?: string;
  genre?: string;
  tkool?: string; // engine
  browser?: string; // 0/1
  dandm?: string; // 配/動
  vote?: string; // 0/1
  comment?: string;
  comment2?: string;
  ss1ext?: string;
  ss2ext?: string;
  iconext?: string;
  board?: string; // forum
  date1?: string;
  date2?: string;
  capa?: string;
  link1?: string; // download
  link2?: string; // mirror
  yobi1?: string;
  yobi2?: string;
};

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

async function fetchJson(url: string) {
  const text = await fetchText(url);
  return JSON.parse(text);
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
  // Wayback fallback
  try {
    const wb = `https://web.archive.org/web/2/${url}`;
    const response = await fetch(wb, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        Connection: "close",
      },
      cache: "no-store",
      redirect: "follow",
      referrerPolicy: "no-referrer",
    } as RequestInit);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${wb}`);
    const arrayBuffer = await response.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
    };
  } catch (fallbackErr) {
    throw lastErr instanceof Error ? lastErr : (fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr)));
  }
}

function assetExtensionFromUrl(input: string, fallback = ".png") {
  const base = input.split(/[?#]/)[0];
  const ext = path.extname(base).toLowerCase();
  if (ext === ".jpeg") return ".jpg";
  return ext || fallback;
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

async function saveBannerFromMain() {
  try {
    const html = await fetchText(MAIN_INDEX_URL);
    await ensureDir(CATCH_DIR);
    await fs.writeFile(path.join(CATCH_DIR, "index.html"), html, "utf8");
    const $ = cheerio.load(html);
    // Prefer banner1.png under ../img/
    const bannerSrc = $("img[src*='banner1']").first().attr("src") || $("img[class='banner']").first().attr("src");
    if (!bannerSrc) return;
    const abs = new URL(bannerSrc, MAIN_INDEX_URL).toString();
    const { buffer } = await fetchBinary(abs);
    await ensureDir(BANNERS_DIR);
    const out = path.join(BANNERS_DIR, `${FESTIVAL_SLUG}${assetExtensionFromUrl(abs, ".png")}`);
    await fs.writeFile(out, buffer);
  } catch (err) {
    console.warn("Failed to save banner:", err);
  }
}

// assetIndex: unpadded numeric id used by site paths (e.g., 1-icon.png)
async function copyIcon(assetIndex: string, iconExt?: string): Promise<string | undefined> {
  await ensureDir(ICONS_DIR);
  const specific = iconExt && iconExt.trim() ? `${IMG_GAMES_BASE}/${assetIndex}-icon.${iconExt}` : undefined;
  const candidates = specific ? [specific, `${IMG_GAMES_BASE}/icon.png`] : [`${IMG_GAMES_BASE}/icon.png`];
  for (const url of candidates) {
    try {
      const { buffer, contentType } = await fetchBinary(url);
      if (!looksLikeImageBuffer(buffer, contentType)) continue;
      const file = `${assetIndex.padStart(2, "0")}${assetExtensionFromUrl(url, ".png")}`;
      await fs.writeFile(path.join(ICONS_DIR, file), buffer);
      return path.posix.join(RELATIVE_ICONS_DIR, file);
    } catch {
      // try next
    }
  }
  return undefined;
}

// assetIndex: unpadded numeric id used by site paths (e.g., 1-1.png)
async function copyScreenshots(assetIndex: string, ss1ext?: string, ss2ext?: string): Promise<DownloadResult> {
  await ensureDir(SCREENSHOTS_DIR);
  const skipped: ScreenshotSkip[] = [];
  const failures: string[] = [];
  const saved: string[] = [];
  const hashSet = new Set<string>();

  const indexPadded = assetIndex.padStart(2, "0");
  await purgeScreenshots(indexPadded);

  const ordereds: string[] = [];
  if (ss1ext && ss1ext.trim()) ordereds.push(`${IMG_GAMES_BASE}/${assetIndex}-1.${ss1ext}`);
  if (ss2ext && ss2ext.trim()) ordereds.push(`${IMG_GAMES_BASE}/${assetIndex}-2.${ss2ext}`);

  let order = 1;
  for (const src of ordereds) {
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
      const ext = assetExtensionFromUrl(src, ".png");
      const file = order === 1 ? `${indexPadded}${ext}` : `${indexPadded}-${String(order).padStart(2, "0")}${ext}`;
      await fs.writeFile(path.join(SCREENSHOTS_DIR, file), buffer);
      saved.push(path.posix.join(RELATIVE_SCREENSHOTS_DIR, file));
      order += 1;
    } catch (err) {
      failures.push(src + " => " + (err as Error).message);
    }
  }

  return { paths: saved, skipped, failures };
}

function normalizeNo(i: number) {
  const s = String(i);
  return s.length >= 2 ? s : s.padStart(2, "0");
}

async function run() {
  await ensureDir(CATCH_DIR);
  await ensureDir(BANNERS_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);

  // Save main index and banner
  await saveBannerFromMain();
  // Save list page
  try {
    const listHtml = await fetchText(LIST_URL);
    await fs.writeFile(path.join(CATCH_DIR, "03_list.html"), listHtml, "utf8");
  } catch {}

  // Load games data json
  const dataRaw = (await fetchJson(DATA_URL)) as Record<string, unknown>;
  await fs.writeFile(path.join(CATCH_DIR, "games-data.json"), JSON.stringify(dataRaw, null, 2), "utf8");

  const out: WorkEntryOut[] = [];
  const summary: SnapshotRecord[] = [];

  const numStr = (dataRaw["num"] as string) ?? "0";
  const max = Number(numStr);
  for (let i = 0; i <= max; i += 1) {
    const rec = dataRaw[String(i)] as GameRecord | undefined;
    if (!rec) continue;
    const index = normalizeNo(i);
    const assetIndex = String(i); // unpadded id used in remote asset filenames
    const iconLocal = await copyIcon(assetIndex, rec.iconext);
    const ssResult = await copyScreenshots(assetIndex, rec.ss1ext, rec.ss2ext);

    // Construct forum URL from board id if present
    let forumUrl: string | undefined = undefined;
    if (rec.board && String(rec.board).trim().length > 0) {
      const bid = String(rec.board).trim();
      forumUrl = `http://jbbs.shitaraba.net/bbs/read.cgi/game/60350/${bid}/`;
    }

    const work: WorkEntryOut = {
      id: `${FESTIVAL_ID}-work-${index}`,
      festivalId: FESTIVAL_ID,
      no: index,
      title: sanitizeWhitespace(rec.title) ?? `Work ${index}`,
      author: sanitizeWhitespace(rec.author) ?? "",
      category: sanitizeWhitespace(rec.genre),
      engine: sanitizeWhitespace(rec.tkool),
      streaming: sanitizeWhitespace(rec.dandm),
      forum: forumUrl,
      authorComment: sanitizeMultiline(rec.comment),
      hostComment: sanitizeMultiline(rec.comment2),
      icon: iconLocal,
      ss: ssResult.paths.length > 0 ? ssResult.paths : undefined,
    };
    out.push(work);

    const dlSources = [rec.link1, rec.link2].filter((x): x is string => !!x && x.length > 0);
    summary.push({
      index,
      status: "ok",
      title: work.title,
      icon: iconLocal,
      downloadSource: dlSources.length > 0 ? dlSources : undefined,
      screenshotReport: {
        saved: ssResult.paths.length,
        skipped: ssResult.skipped.length > 0 ? ssResult.skipped : undefined,
        failures: ssResult.failures.length > 0 ? ssResult.failures : undefined,
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
