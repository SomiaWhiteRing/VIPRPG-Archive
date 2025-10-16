import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const FESTIVAL_ID = "2017-summer";
const FESTIVAL_SLUG = "2017-summer";
const BASE_URL = "https://websupportviprpg.xxxxxxxx.jp/archive/2017Summer";
const LIST_URL = `${BASE_URL}/games.html`;
const DATA_URL = `${BASE_URL}/data.json`;

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

type DataRec = {
  ss1?: string; // ext or ext with query
  ss2?: string;
  icon?: string;
  title?: string;
  author?: string;
  genre?: string;
  tkool?: string; // engine
  dandm?: string; // 配信/動画
  vote?: string;
  comment?: string;
  comment2?: string;
  board?: string; // impression thread id
  game?: string; // 提出/更新信息
  volume?: string; // 容量
  link?: string; // download url
};

interface ScreenshotSkip { source: string; reason: "small" | "duplicate"; }

interface DownloadResult { paths: string[]; skipped: ScreenshotSkip[]; failures: string[]; }

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
  downloadSource?: string[];
  screenshotReport?: { saved: number; skipped?: ScreenshotSkip[]; failures?: string[] };
  error?: string;
}

function sanitizeWhitespace(v?: string | null) {
  if (!v) return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t || undefined;
}

function sanitizeMultiline(v?: string | null) {
  if (!v) return undefined;
  const lines = v
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const out = lines.join("\n").trim();
  return out || undefined;
}

async function ensureDir(dir: string) { await fs.mkdir(dir, { recursive: true }); }

async function purgeScreenshots(indexPadded: string) {
  try {
    const files = await fs.readdir(SCREENSHOTS_DIR);
    await Promise.all(
      files
        .filter((file) => file.startsWith(indexPadded))
        .map((file) => fs.unlink(path.join(SCREENSHOTS_DIR, file)).catch(() => undefined))
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") console.warn("purgeScreenshots error:", e.message);
  }
}

async function fetchText(url: string) {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/json" },
        cache: "no-store", redirect: "follow", referrerPolicy: "no-referrer"
      } as RequestInit);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function fetchBinary(url: string) {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
        cache: "no-store", redirect: "follow", referrerPolicy: "no-referrer"
      } as RequestInit);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const ab = await res.arrayBuffer();
      return { buffer: Buffer.from(ab), contentType: (res.headers.get("content-type") ?? "").toLowerCase() };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  // Wayback fallback last resort
  try {
    const wb = `https://web.archive.org/web/2/${url}`;
    const res = await fetch(wb, {
      headers: { "User-Agent": USER_AGENT, Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
      cache: "no-store", redirect: "follow", referrerPolicy: "no-referrer"
    } as RequestInit);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${wb}`);
    const ab = await res.arrayBuffer();
    return { buffer: Buffer.from(ab), contentType: (res.headers.get("content-type") ?? "").toLowerCase() };
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

function looksLikeImageBuffer(buffer: Buffer, contentType: string) {
  if (contentType && contentType.startsWith("image/")) return true;
  if (buffer.length >= 4) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true;
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return true;
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return true;
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) return true;
  }
  return false;
}

async function saveBannerFromList() {
  try {
    const html = await fetchText(LIST_URL);
    await ensureDir(CATCH_DIR);
    await fs.writeFile(path.join(CATCH_DIR, "games.html"), html, "utf8");
    const $ = cheerio.load(html);
    const src = $("img[src*='images/banner']").first().attr("src") || "images/banner.png";
    const abs = new URL(src, LIST_URL).toString();
    const { buffer } = await fetchBinary(abs);
    await ensureDir(BANNERS_DIR);
    const out = path.join(BANNERS_DIR, `${FESTIVAL_SLUG}${assetExtensionFromUrl(abs, ".png")}`);
    await fs.writeFile(out, buffer);
  } catch (e) {
    console.warn("saveBannerFromList failed:", e);
  }
}

async function copyIcon(assetIndex: number, iconExt?: string): Promise<string | undefined> {
  await ensureDir(ICONS_DIR);
  if (!iconExt || !iconExt.trim()) return undefined;
  const url = `${BASE_URL}/images/icon/${assetIndex}.${iconExt}`;
  try {
    const { buffer, contentType } = await fetchBinary(url);
    if (!looksLikeImageBuffer(buffer, contentType)) return undefined;
    const file = `${String(assetIndex).padStart(2, "0")}${assetExtensionFromUrl(url, ".png")}`;
    await fs.writeFile(path.join(ICONS_DIR, file), buffer);
    return path.posix.join(RELATIVE_ICONS_DIR, file);
  } catch {
    return undefined;
  }
}

async function copyScreenshots(assetIndex: number, ss1ext?: string, ss2ext?: string): Promise<DownloadResult> {
  await ensureDir(SCREENSHOTS_DIR);
  const skipped: ScreenshotSkip[] = [];
  const failures: string[] = [];
  const saved: string[] = [];
  const hashSet = new Set<string>();

  const indexPadded = String(assetIndex).padStart(2, "0");
  await purgeScreenshots(indexPadded);

  const ordereds: string[] = [];
  if (ss1ext && ss1ext.trim()) ordereds.push(`${BASE_URL}/images/ss/${assetIndex}-1.${ss1ext}`);
  if (ss2ext && ss2ext.trim()) ordereds.push(`${BASE_URL}/images/ss/${assetIndex}-2.${ss2ext}`);

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

function toForumUrl(boardId?: string) {
  const id = (boardId ?? "").trim();
  if (!id) return undefined;
  // 感想掲示板 game/60233
  return `http://jbbs.shitaraba.net/bbs/read.cgi/game/60233/${id}/`;
}

async function run() {
  await ensureDir(CATCH_DIR);
  await ensureDir(BANNERS_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);

  // Cache list page and save banner
  await saveBannerFromList();

  // Load data.json
  const text = await fetchText(DATA_URL);
  await fs.writeFile(path.join(CATCH_DIR, "data.json"), text, "utf8");
  const data = JSON.parse(text) as DataRec[];

  const out: WorkEntryOut[] = [];
  const summary: SnapshotRecord[] = [];

  for (let i = 0; i < data.length; i += 1) {
    const rec = data[i] || {};
    const indexPadded = String(i).padStart(2, "0");

    const iconLocal = await copyIcon(i, rec.icon);
    const ssResult = await copyScreenshots(i, rec.ss1, rec.ss2);

    const work: WorkEntryOut = {
      id: `${FESTIVAL_ID}-work-${indexPadded}`,
      festivalId: FESTIVAL_ID,
      no: indexPadded,
      title: sanitizeWhitespace(rec.title) ?? `Work ${indexPadded}`,
      author: sanitizeWhitespace(rec.author) ?? "",
      category: sanitizeWhitespace(rec.genre),
      engine: sanitizeWhitespace(rec.tkool),
      streaming: sanitizeWhitespace(rec.dandm),
      forum: toForumUrl(rec.board),
      authorComment: sanitizeMultiline(rec.comment),
      hostComment: sanitizeMultiline(rec.comment2),
      icon: iconLocal,
      ss: ssResult.paths.length > 0 ? ssResult.paths : undefined,
    };
    out.push(work);

    const dl = sanitizeWhitespace(rec.link);
    summary.push({
      index: indexPadded,
      status: "ok",
      title: work.title,
      icon: iconLocal,
      downloadSource: dl ? [dl] : undefined,
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

