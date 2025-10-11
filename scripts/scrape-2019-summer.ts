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
  const argHex = decodeHexEscapes(m[2]);
  try {
    // First, turn the Apps Script string literal into a single string
    const dequoted = JSON.parse('"' + argHex.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"');
    // Then parse JSON and read userHtml
    const obj = JSON.parse(dequoted);
    const html = typeof obj?.userHtml === "string" ? (obj.userHtml as string) : undefined;
    return html;
  } catch {
    return undefined;
  }
}

async function saveBanner() {
  try {
    const site = "https://r.jina.ai/https://sites.google.com/view/viprpg2019summer/";
    const html = await fetchUrl(site);
    await ensureDir(CATCH_DIR);
    await fs.writeFile(path.join(CATCH_DIR, "index_rjina.html"), html, "utf8");
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
  const $ = cheerio.load(html);
  const result: { no?: string; title?: string; author?: string; category?: string; engine?: string; streaming?: string; forumUrl?: string; downloadUrl?: string; authorComment?: string; hostComment?: string; icon?: string; screenshots: string[] } = { screenshots: [] };
  // Title and no
  let full = sanitizeWhitespace($("h2:contains('No.'), h3:contains('No.'), h1:contains('No.')").first().text()) || "";
  if (!full) full = sanitizeWhitespace($("thead th").first().text()) || "";
  const mNo = full.match(/No\.(\d+)/i);
  if (mNo) result.no = mNo[1];
  result.title = (full || "").replace(/No\.\d+\s*/i, "").trim();
  // icon
  const iconSrc = $("img.icon").attr("src");
  if (iconSrc) result.icon = new URL(iconSrc, pageUrl).toString();
  // fields by labels in text
  const raw = $("body").text().replace(/\s+/g, " ").trim();
  const pick = (re: RegExp) => { const m = raw.match(re); return m ? sanitizeWhitespace(m[1]) : undefined; };
  result.author = pick(/作者[:：]([^\s].*?)(?: ジャンル| ツール| 配信|$)/);
  result.category = pick(/ジャンル[:：]([^\s].*?)(?: ツール| 配信|$)/);
  result.engine = pick(/ツール[:：]([^\s].*?)(?: 配信|$)/) || pick(/使用ツール[:：]([^\s].*?)(?: 配信|$)/);
  result.streaming = pick(/配信[\/／]投稿[:：]([^\s].*?)(?: 作者コメント|$)/) || pick(/配信[:：]([^\s].*?)(?: 作者コメント|$)/);
  // comments (keep HTML, strip label)
  const strip = (htmlIn: string, label: string) => htmlIn.replace(new RegExp(`^[\\s\\S]*?${label}[：:]?\\s*(?:<br\\s*\\/?>\\s*)?`, "i"), "").trim();
  const authorCell = $("*:contains('作者コメント')").filter((_, el) => $(el).children().length === 0 || /作者コメント/.test($(el).text())).first().parent();
  if (authorCell && authorCell.html()) result.authorComment = strip(authorCell.html()!, "作者コメント");
  const hostCell = $("*:contains('管理人コメント')").filter((_, el) => $(el).children().length === 0 || /管理人コメント/.test($(el).text())).first().parent();
  if (hostCell && hostCell.html()) result.hostComment = strip(hostCell.html()!, "管理人コメント");
  // links
  $("a").each((_, a) => {
    const t = ($(a).text() || "").trim();
    const href = $(a).attr("href");
    if (!href) return;
    const abs = new URL(href, pageUrl).toString();
    if (/【?感想】?/.test(t) || /掲示板/.test(t)) result.forumUrl = abs;
    if (/DL|ダウンロード/.test(t)) result.downloadUrl = abs;
  });
  // screenshots: include embedded images; exclude small icons and UI/brand images
  $("img").each((_, img) => {
    const src = $(img).attr("src");
    if (!src) return;
    const abs = new URL(src, pageUrl).toString();
    if (/material\/product|gstatic|googleusercontent\.com\/a\//i.test(abs)) return; // skip logos/avatars
    if (iconSrc && abs === new URL(iconSrc, pageUrl).toString()) return; // skip same as icon
    result.screenshots.push(abs);
  });
  return result;
}

async function main() {
  await ensureDir(CATCH_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);
  await saveBanner();
  const out: WorkEntryOut[] = [];
  const snaps: SnapshotRecord[] = [];
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
  await fs.writeFile(OUTPUT_WORKS, JSON.stringify(out, null, 2), "utf8");
  await fs.writeFile(SUMMARY_PATH, JSON.stringify(snaps, null, 2), "utf8");
  console.log(`Saved ${out.length} works to ${OUTPUT_WORKS}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
