import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const FESTIVAL_ID = "2019-summer";
const FESTIVAL_SLUG = "2019-summer";
const APPS_EXEC_BASE = "https://script.google.com/macros/s/AKfycbxUhsUdhTG6F844hBnioDdGacKRTip815r48sgbP-pPUhoXuPsK/exec";

const OUTPUT_WORKS = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const CATCH_DIR = path.join(process.cwd(), "catch", FESTIVAL_SLUG);
const SUMMARY_PATH = path.join(CATCH_DIR, `${FESTIVAL_SLUG}-scrape-summary.json`);

const PUBLIC_DIR = path.join(process.cwd(), "public");
const BANNERS_DIR = path.join(PUBLIC_DIR, "banners");
const ICONS_DIR = path.join(PUBLIC_DIR, "icons", FESTIVAL_SLUG);
const SCREENSHOTS_DIR = path.join(PUBLIC_DIR, "screenshots", FESTIVAL_SLUG);

const RELATIVE_ICONS_DIR = `/icons/${FESTIVAL_SLUG}`;
const RELATIVE_SCREENSHOTS_DIR = `/screenshots/${FESTIVAL_SLUG}`;

const MAX_SCREENSHOTS = 10; // include embedded images
const SMALL_IMAGE_LIMIT = 100;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)" +
  " Chrome/130.0.0.0 Safari/537.36";

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
  authorComment?: string; // keep HTML
  hostComment?: string; // keep HTML
  icon?: string;
  ss?: string[];
}

interface ScreenshotSkip { source: string; reason: "small" | "duplicate" }

interface SnapshotRecord {
  index: string;
  status: "ok" | "error" | "missing";
  title?: string;
  icon?: string;
  downloadSource?: string[];
  screenshotReport?: { saved: number; skipped?: ScreenshotSkip[]; failures?: string[] };
  error?: string;
}

async function ensureDir(dir: string) { await fs.mkdir(dir, { recursive: true }); }

function sanitizeWhitespace(v?: string | null) {
  if (!v) return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t || undefined;
}

function getImageExtension(input: string, fallback = ".png") {
  const base = input.split(/[?#]/)[0];
  const ext = path.extname(base).toLowerCase();
  if (ext === ".jpeg") return ".jpg";
  return ext || fallback;
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

async function fetchUrl(url: string) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    cache: "no-store",
    redirect: "follow",
    referrerPolicy: "no-referrer",
  } as RequestInit);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

async function fetchBinary(url: string) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
    cache: "no-store",
    redirect: "follow",
    referrerPolicy: "no-referrer",
  } as RequestInit);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const ab = await res.arrayBuffer();
  return { buffer: Buffer.from(ab), contentType: (res.headers.get("content-type") ?? "").toLowerCase() };
}

// Decode only \xHH escapes from the Apps Script wrapper string
function decodeHexEscapes(s: string) {
  return s.replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Extract userHtml string from goog.script.init('...') and return decoded HTML
function extractUserHtml(outerHtml: string): string | undefined {
  const m = outerHtml.match(/goog\.script\.init\(("|')([\s\S]*?)\1\)/);
  if (!m) return undefined;
  const arg = decodeHexEscapes(m[2]!);
  const key = '"userHtml":"';
  const start = arg.indexOf(key);
  if (start < 0) return undefined;
  // Extract the JSON-encoded string value for userHtml without trying to parse entire object
  let i = start + key.length;
  let buf = "";
  for (; i < arg.length; i++) {
    const ch = arg[i]!;
    if (ch === '"') {
      let k = i - 1, bs = 0;
      while (k >= 0 && arg[k] === '\\') { bs += 1; k -= 1; }
      if (bs === 0) break; // end of JSON string literal
    }
    buf += ch;
  }
  // Manually unescape common JSON string escapes to get raw HTML
  let html = buf;
  html = html.replace(/\\\"/g, '"');
  html = html.replace(/\\\//g, '/');
  html = html.replace(/\\n/g, '\n');
  html = html.replace(/\\r/g, '');
  html = html.replace(/\\t/g, '\t');
  html = html.replace(/\\\\/g, '\\');
  return html;
}

async function saveBanner() {
  // Try via r.jina.ai; if it fails, fall back to previously saved index_rjina.html
  try {
    const site = "https://r.jina.ai/https://sites.google.com/view/viprpg2019summer/";
    let html: string | undefined;
    try {
      html = await fetchUrl(site);
      await ensureDir(CATCH_DIR);
      await fs.writeFile(path.join(CATCH_DIR, "index_rjina.html"), html, "utf8");
    } catch (e) {
      try {
        html = await fs.readFile(path.join(CATCH_DIR, "index_rjina.html"), "utf8");
      } catch {
        throw e;
      }
    }
    if (!html) return;
    const $ = cheerio.load(html);
    const src = $("img").first().attr("src");
    if (src && /^https?:\/\//.test(src)) {
      const { buffer } = await fetchBinary(src);
      await ensureDir(BANNERS_DIR);
      const ext = getImageExtension(src, ".png");
      await fs.writeFile(path.join(BANNERS_DIR, `${FESTIVAL_SLUG}${ext}`), buffer);
    }
  } catch (e) {
    console.warn("Failed to save banner:", (e as Error).message);
  }
}

async function copyIcon(index: string, source?: string | null): Promise<string | undefined> {
  if (!source) return undefined;
  try {
    await ensureDir(ICONS_DIR);
    const { buffer, contentType } = await fetchBinary(source);
    if (!contentType.startsWith("image/")) return undefined;
    const ext = getImageExtension(source, ".png");
    const file = `${index}${ext}`;
    await fs.writeFile(path.join(ICONS_DIR, file), buffer);
    return path.posix.join(RELATIVE_ICONS_DIR, file);
  } catch {
    return undefined;
  }
}

async function copyScreenshots(index: string, sources: string[]): Promise<{ paths: string[]; skipped: ScreenshotSkip[]; failures: string[] }> {
  await ensureDir(SCREENSHOTS_DIR);
  try {
    const files = await fs.readdir(SCREENSHOTS_DIR);
    await Promise.all(files.filter(f => f.startsWith(index)).map(f => fs.unlink(path.join(SCREENSHOTS_DIR, f)).catch(() => undefined)));
  } catch {}
  const skipped: ScreenshotSkip[] = [];
  const failures: string[] = [];
  const saved: string[] = [];
  const hashSet = new Set<string>();
  let order = 1;
  for (const src of sources) {
    if (saved.length >= MAX_SCREENSHOTS) break;
    try {
      const { buffer, contentType } = await fetchBinary(src);
      if (!(contentType && contentType.startsWith("image/"))) { failures.push(src); continue; }
      const dim = getImageDimensions(buffer);
      if (dim && (dim.width < SMALL_IMAGE_LIMIT || dim.height < SMALL_IMAGE_LIMIT)) { skipped.push({ source: src, reason: "small" }); continue; }
      const hash = createHash("sha1").update(buffer).digest("hex");
      if (hashSet.has(hash)) { skipped.push({ source: src, reason: "duplicate" }); continue; }
      hashSet.add(hash);
      const ext = getImageExtension(src, ".png");
      const file = `${index}-${String(order).padStart(2, "0")}${ext}`;
      await fs.writeFile(path.join(SCREENSHOTS_DIR, file), buffer);
      saved.push(path.posix.join(RELATIVE_SCREENSHOTS_DIR, file));
      order += 1;
    } catch {
      failures.push(src);
    }
  }
  return { paths: saved, skipped, failures };
}

function parseDetailFromHtml(html: string, pageUrl: string) {
  const result: { no?: string; title?: string; author?: string; category?: string; engine?: string; streaming?: string; forumUrl?: string; downloadUrl?: string; authorComment?: string; hostComment?: string; icon?: string; screenshots: string[] } = { screenshots: [] };
  // Try to parse the embedded JSON in userHtml (globalDataes)
  const mm = html.match(/globalDataes\s*=\s*JSON\.parse\((['"])([\s\S]*?)\1\)/);
  const params = new URL(pageUrl).searchParams;
  const gameParam = params.get("game") || undefined;
  if (mm) {
    try {
      const quoted = mm[1] + mm[2] + mm[1];
      const jsonText = JSON.parse(quoted) as string; // decode string literal to JSON text
      const arr = JSON.parse(jsonText) as Array<Record<string, string>>;
      const pickNo = (gameParam ? parseInt(gameParam, 10) : NaN);
      const el = arr.find(e => String(e.gameNo) === String(pickNo)) || arr[0];
      if (el) {
        result.no = (el.gameNo || el.entryNo || '').toString().padStart(2, '0');
        result.title = sanitizeWhitespace(el.title) || result.title;
        result.author = sanitizeWhitespace(el.author) || result.author;
        result.category = sanitizeWhitespace(el.genre) || result.category;
        result.engine = sanitizeWhitespace(el.tkool_other || el.tkool) || result.engine;
        result.streaming = sanitizeWhitespace(el.video_other || el.video) || result.streaming;
        result.authorComment = el.comment_author ? el.comment_author : undefined;
        const toDrive = (s?: string) => {
          if (!s) return undefined;
          if (/^https?:\/\//i.test(s)) return s;
          return `https://drive.google.com/uc?id=${s}`;
        };
        const icon = toDrive(el.icon);
        if (icon) result.icon = icon;
        const ss1 = toDrive(el.ss1);
        const ss2 = toDrive(el.ss2);
        [ss1, ss2].forEach(u => { if (u) result.screenshots.push(u); });
        const gameUrl = toDrive(el.game);
        if (gameUrl) result.downloadUrl = gameUrl;
      }
    } catch {}
  }
  return result;
}

function parseGlobalDataes(html: string): Array<Record<string, string>> | undefined {
  const mm = html.match(/globalDataes\s*=\s*JSON\.parse\((['"])([\s\S]*?)\1\)/);
  if (!mm) return undefined;
  try {
    // Evaluate the original JS string literal by reconstructing `'...content...'`
    const quote = mm[1];
    const jsString = (new Function(`return ${quote}${mm[2]}${quote};`))() as string;
    const arr = JSON.parse(jsString) as Array<Record<string, string>>;
    return arr;
  } catch {
    // try a more forgiving unescape then parse
    let src = mm[2]!
      .replace(/\\\"/g, '"')
      .replace(/\\\//g, '/')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\');
    try {
      return JSON.parse(src) as Array<Record<string, string>>;
    } catch {
      return undefined;
    }
  }
}

async function main() {
  await ensureDir(CATCH_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);
  await saveBanner();
  const out: WorkEntryOut[] = [];
  const snaps: SnapshotRecord[] = [];

  // Try to get a single outer page to decode full dataset once
  let dataset: Array<Record<string, string>> | undefined;
  const seedIdx = 39; // any valid page contains the dataset
  const seedUrl = `${APPS_EXEC_BASE}?game=${seedIdx}`;
  let seedInner: string | undefined;
  try {
    const outer = await fetchUrl(seedUrl);
    await fs.writeFile(path.join(CATCH_DIR, `game-${String(seedIdx).padStart(2, '0')}-outer.html`), outer, "utf8");
    seedInner = extractUserHtml(outer);
  } catch {}
  if (!seedInner) {
    try {
      seedInner = await fs.readFile(path.join(CATCH_DIR, `game-${String(seedIdx).padStart(2, '0')}.html`), "utf8");
    } catch {}
  }
  if (seedInner) dataset = parseGlobalDataes(seedInner);

  // If dataset is available, use it to build all works; otherwise fall back to per-page fetch
  if (dataset && dataset.length) {
    // Only keep real entries numbered 01..80
    const entries = dataset.filter(e => {
      const no = (e.entryNo || e.no || '').toString();
      return /^\d+$/.test(no) && parseInt(no, 10) >= 1 && parseInt(no, 10) <= 80;
    });
    // Sort by numeric entry number
    entries.sort((a, b) => parseInt((a.entryNo || '0').toString(), 10) - parseInt((b.entryNo || '0').toString(), 10));
    for (const el of entries) {
      const noRaw = (el.entryNo || el.no || '').toString();
      const no = noRaw.padStart(2, '0');
      const toDrive = (s?: string) => {
        if (!s) return undefined;
        if (/^https?:\/\//i.test(s)) return s;
        return `https://drive.google.com/uc?id=${s}`;
      };
      const iconUrl = toDrive(el.icon);
      const ss1 = toDrive(el.ss1);
      const ss2 = toDrive(el.ss2);
      const iconLocal = await copyIcon(no, iconUrl);
      const ssSources = [ss1, ss2].filter((u): u is string => !!u);
      const { paths: ss, skipped, failures } = await copyScreenshots(no, ssSources);
      const work: WorkEntryOut = {
        id: `${FESTIVAL_SLUG}-${no}`,
        festivalId: FESTIVAL_ID,
        no,
        title: sanitizeWhitespace(el.title) || `Work ${no}`,
        author: sanitizeWhitespace(el.author) || "",
        category: sanitizeWhitespace(el.genre),
        engine: sanitizeWhitespace(el.tkool_other || el.tkool),
        streaming: sanitizeWhitespace(el.video_other || el.video),
        authorComment: el.comment_author ? el.comment_author : undefined,
        icon: iconLocal,
      };
      if (ss.length > 0) work.ss = ss;
      out.push(work);
      const rec: SnapshotRecord = { index: no, status: "ok", title: work.title, icon: iconLocal };
      if (skipped.length || failures.length) rec.screenshotReport = { saved: ss.length, skipped, failures };
      snaps.push(rec);
    }
  } else {
    for (let n = 1; n <= 80; n += 1) {
      const idx = String(n).padStart(2, "0");
      const url = `${APPS_EXEC_BASE}?game=${n}`;
      try {
        const outer = await fetchUrl(url);
        await fs.writeFile(path.join(CATCH_DIR, `game-${idx}-outer.html`), outer, "utf8");
        const inner = extractUserHtml(outer);
        if (!inner) { snaps.push({ index: idx, status: "missing" }); continue; }
        await fs.writeFile(path.join(CATCH_DIR, `game-${idx}.html`), inner, "utf8");
        const detail = parseDetailFromHtml(inner, url);
        if (!detail.no) detail.no = idx;
        const iconLocal = await copyIcon(detail.no!, detail.icon ?? undefined);
        const { paths: ss, skipped, failures } = await copyScreenshots(detail.no!, detail.screenshots);
        const rec: SnapshotRecord = { index: detail.no!, status: "ok", title: detail.title, icon: iconLocal };
        if (skipped.length || failures.length) rec.screenshotReport = { saved: ss.length, skipped, failures };
        const work: WorkEntryOut = {
          id: `${FESTIVAL_SLUG}-${detail.no!}`,
          festivalId: FESTIVAL_ID,
          no: detail.no!,
          title: detail.title || `Work ${detail.no!}`,
          author: detail.author || "",
          category: detail.category,
          engine: detail.engine,
          streaming: detail.streaming,
          forum: detail.forumUrl,
          authorComment: detail.authorComment,
          hostComment: detail.hostComment,
          icon: iconLocal,
        };
        if (ss.length > 0) work.ss = ss;
        out.push(work);
        snaps.push(rec);
      } catch (e) {
        snaps.push({ index: idx, status: "error", error: (e as Error).message });
      }
    }
  }

  await fs.writeFile(OUTPUT_WORKS, JSON.stringify(out, null, 2), "utf8");
  await fs.writeFile(SUMMARY_PATH, JSON.stringify(snaps, null, 2), "utf8");
  console.log(`Saved ${out.length} works to ${OUTPUT_WORKS}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
