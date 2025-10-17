import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";

const FESTIVAL_ID = "2016-gw";
const FESTIVAL_SLUG = "2016-gw";
// Two origins: FC2 + Geocities mirror
const DEFAULT_ORIGINS = [
  "https://vipkohaku.x.fc2.com/2016GW/",
  "http://www.geocities.jp/viprpg2016gw/",
  "https://www.geocities.jp/viprpg2016gw/",
];
const BASE_ORIGINS: string[] = DEFAULT_ORIGINS;

const OUTPUT_WORKS = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const CATCH_DIR = path.join(process.cwd(), "catch", FESTIVAL_SLUG);
const SUMMARY_PATH = path.join(CATCH_DIR, `${FESTIVAL_SLUG}-scrape-summary.json`);

const PUBLIC_DIR = path.join(process.cwd(), "public");
const BANNERS_DIR = path.join(PUBLIC_DIR, "banners");
const ICONS_DIR = path.join(PUBLIC_DIR, "icons", FESTIVAL_SLUG);
const SCREENSHOTS_DIR = path.join(PUBLIC_DIR, "screenshots", FESTIVAL_SLUG);

const RELATIVE_ICONS_DIR = `/icons/${FESTIVAL_SLUG}`;
const RELATIVE_SCREENSHOTS_DIR = `/screenshots/${FESTIVAL_SLUG}`;

const SMALL_IMAGE_LIMIT = 100;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)" +
  " Chrome/130.0.0.0 Safari/537.36";

interface IndexEntry {
  index: string;
  no: string;
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
  authorComment?: string; // keep text with \n
  hostComment?: string;
  screenshots?: string[]; // absolute URLs
}

interface ScreenshotSkip { source: string; reason: "small" | "duplicate" }
interface DownloadResult { paths: string[]; skipped: ScreenshotSkip[]; failures: string[] }

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
  detailDisabled?: boolean;
}

interface SnapshotRecord {
  index: string;
  status: "ok" | "error";
  title?: string;
  icon?: string;
  note?: string;
  downloadSource?: string[];
  sourcesTried?: string[];
  detailSourcesTried?: string[];
  iconSourcesTried?: string[];
  screenshotSourcesTriedCount?: number;
  screenshotReport?: {
    saved: number;
    skipped?: ScreenshotSkip[];
    failures?: string[];
  };
  error?: string;
}

interface TimemapRow {
  original: string;
  mimetype: string;
  timestamp: string;
  endtimestamp: string;
  groupcount: number;
  uniqcount: number;
}

async function ensureDir(dir: string) { await fs.mkdir(dir, { recursive: true }); }

function toAbsoluteUrl(relative: string | undefined, base: string) {
  if (!relative) return undefined;
  try { return new URL(relative, base).toString(); } catch { return undefined; }
}

function getImageExtension(input: string, fallback = ".png") {
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
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true; // PNG
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return true; // JPEG
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return true; // GIF
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) return true; // BMP
  }
  return false;
}

function buildWaybackUrl(ts: string | undefined, original: string, kind: "im_" | "id_" | "fw_" = "id_") {
  const base = BASE_ORIGINS[0] || "https://vipkohaku.x.fc2.com/2016GW/";
  const u = original.startsWith("http") ? original : new URL(original, base).toString();
  if (ts) return `https://web.archive.org/web/${ts}${kind}/${u}`;
  return `https://web.archive.org/web/2/${u}`;
}

function detectHtmlEncoding(buffer: Buffer, contentType: string): string {
  const ct = (contentType || "").toLowerCase();
  if (/shift[_-]?jis|x-sjis|sjis|windows-31j|ms932/.test(ct)) return "shift_jis";
  const head = buffer.slice(0, Math.min(4096, buffer.length)).toString("latin1");
  const m = head.match(/charset\s*=\s*([A-Za-z0-9_\-]+)/i);
  if (m) {
    const enc = m[1].toLowerCase();
    if (/shift[_-]?jis|x-sjis|sjis|windows-31j|ms932/.test(enc)) return "shift_jis";
    if (/utf-8|utf8/.test(enc)) return "utf8";
  }
  return "utf8";
}

async function fetchText(url: string) {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Connection: "close",
        },
        cache: "no-store",
        redirect: "follow",
        referrerPolicy: "no-referrer",
      } as RequestInit);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const ab = await res.arrayBuffer();
      const buf = Buffer.from(ab);
      const enc = detectHtmlEncoding(buf, res.headers.get("content-type") || "");
      return enc === "utf8" ? buf.toString("utf8") : iconv.decode(buf, enc);
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
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          Connection: "close",
        },
        cache: "no-store",
        redirect: "follow",
        referrerPolicy: "no-referrer",
      } as RequestInit);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const ab = await res.arrayBuffer();
      return { buffer: Buffer.from(ab), contentType: (res.headers.get("content-type") ?? "").toLowerCase() };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  // Wayback fallback variants for images
  try {
    const u = new URL(url);
    if (u.hostname === "web.archive.org" && /\/web\//.test(u.pathname)) {
      const path = u.pathname;
      const m = path.match(/\/web\/(\d+)([a-z]{2}_)?\/(.*)$/i);
      if (m) {
        const ts = m[1];
        const original = decodeURIComponent(m[3]);
        for (const kind of ["im_", "id_"]) {
          const alt = `https://web.archive.org/web/${ts}${kind}/${original}`;
          const res = await fetch(alt, {
            headers: { "User-Agent": USER_AGENT, Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8", Connection: "close" },
            cache: "no-store", redirect: "follow", referrerPolicy: "no-referrer",
          } as RequestInit);
          if (res.ok) {
            const ab = await res.arrayBuffer();
            return { buffer: Buffer.from(ab), contentType: (res.headers.get("content-type") ?? "").toLowerCase() };
          }
        }
        // Last resort: nearest snapshot redirect
        const last = `https://web.archive.org/web/2/${original}`;
        const res2 = await fetch(last, { headers: { "User-Agent": USER_AGENT, Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" } as any, cache: "no-store", redirect: "follow", referrerPolicy: "no-referrer" } as RequestInit);
        if (res2.ok) {
          const ab2 = await res2.arrayBuffer();
          return { buffer: Buffer.from(ab2), contentType: (res2.headers.get("content-type") ?? "").toLowerCase() };
        }
      }
    }
  } catch {}
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function sanitizeWhitespace(v?: string | null) {
  if (!v) return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t || undefined;
}

function sanitizeMultilineHtmlToText(v?: string | null) {
  if (!v) return undefined;
  const out = v
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return out || undefined;
}

function stripLeadingLabel(text: string | undefined, labels: string[]): string | undefined {
  if (!text) return undefined;
  const pattern = new RegExp(`^(?:【)?(?:${labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?:】)?[\\s　]*[：:]?[\\s　]*`);
  return text.replace(pattern, "").trim() || undefined;
}

async function fetchTimemap(base: string): Promise<TimemapRow[]> {
  const timemapUrl =
    `https://web.archive.org/web/timemap/json?url=${encodeURIComponent(base)}` +
    `&matchType=prefix&collapse=urlkey&output=json&fl=original%2Cmimetype%2Ctimestamp%2Cendtimestamp%2Cgroupcount%2Cuniqcount&filter=!statuscode%3A%5B45%5D..&limit=10000`;
  const raw = await fetchText(timemapUrl);
  const data = JSON.parse(raw) as unknown[];
  const header = data[0] as string[];
  const rows = data.slice(1) as any[];
  const idx: Record<string, number> = {};
  header.forEach((k, i) => (idx[k] = i));
  const out: TimemapRow[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    out.push({
      original: String(row[idx.original] ?? ""),
      mimetype: String(row[idx.mimetype] ?? ""),
      timestamp: String(row[idx.timestamp] ?? ""),
      endtimestamp: String(row[idx.endtimestamp] ?? ""),
      groupcount: Number(row[idx.groupcount] ?? 0),
      uniqcount: Number(row[idx.uniqcount] ?? 0),
    });
  }
  return out;
}

function buildAssetMaps(rows: TimemapRow[]) {
  const iconByIndex = new Map<string, TimemapRow>();
  const detailByIndex = new Map<string, TimemapRow>();
  const ssByIndex = new Map<string, TimemapRow[]>();
  for (const r of rows) {
    const u = r.original;
    // detail e.g. /(2016GW|viprpg2016gw)/entryNN.html
    const mDetail = u.match(/\/(?:2016GW|viprpg2016gw)\/entry(\d{2,3})\.html$/i);
    if (mDetail) {
      const idx = mDetail[1].padStart(2, "0");
      const prev = detailByIndex.get(idx);
      if (!prev || r.endtimestamp > prev.endtimestamp) detailByIndex.set(idx, r);
      continue;
    }
    // icon: /(2016GW|viprpg2016gw)/mate/iNN.(png|gif|jpg)
    const mIcon = u.match(/\/(?:2016GW|viprpg2016gw)\/mate\/i0*(\d{1,3})\.(png|jpe?g|gif|bmp)$/i);
    if (mIcon) {
      const idx = mIcon[1].padStart(2, "0");
      const prev = iconByIndex.get(idx);
      if (!prev || r.endtimestamp > prev.endtimestamp) iconByIndex.set(idx, r);
      continue;
    }
    // screenshots: under /(2016GW|viprpg2016gw)/, image but not icon, not counter
    if (/\/(?:2016GW|viprpg2016gw)\//i.test(u) && /\.(png|jpe?g|gif|bmp)$/i.test(u) && !/\/mate\/i\d/i.test(u) && !/counter/i.test(u)) {
      // try infer 2-digit index from filename
      let idx: string | undefined;
      const mNum = u.match(/(?:^|[^\d])(\d{2})(?:[^\d]|\.|$)/);
      if (mNum) idx = mNum[1];
      if (idx) {
        const list = ssByIndex.get(idx) ?? [];
        list.push(r);
        ssByIndex.set(idx, list);
      }
      continue;
    }
  }
  return { iconByIndex, detailByIndex, ssByIndex };
}

async function saveBannerFromIndex(indexUrl: string, html: string) {
  try {
    const $ = cheerio.load(html);
    const img = $("img[src*='banner'], img[src*='top'], img[src*='bnr']").first();
    const src = img.attr("src");
    if (!src) return;
    const abs = toAbsoluteUrl(src, indexUrl);
    if (!abs) return;
    const { buffer } = await fetchBinary(abs);
    await ensureDir(BANNERS_DIR);
    const ext = getImageExtension(abs, ".png");
    await fs.writeFile(path.join(BANNERS_DIR, `${FESTIVAL_SLUG}${ext}`), buffer);
  } catch {}
}

function parseIndex2016(html: string, baseUrl: string): IndexEntry[] {
  const $ = cheerio.load(html);
  const entries: IndexEntry[] = [];
  $("table tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 7) return;
    const noText = (tds.eq(0).text() || "").trim();
    if (!/^\d{1,3}$/.test(noText)) return;
    const noRaw = noText;
    const index = noRaw.padStart(2, "0");

    const iconSrc = tds.eq(1).find("img").attr("src");
    const iconUrl = iconSrc ? toAbsoluteUrl(iconSrc, baseUrl) : undefined;

    const workCell = tds.eq(2);
    const a = workCell.find("a").first();
    const detailUrl = a.attr("href") ? toAbsoluteUrl(a.attr("href")!, baseUrl) : undefined;
    const htmlIn = a.html() || workCell.html() || "";
    const parts = htmlIn.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, "").split(/\n/).map((x) => x.trim()).filter(Boolean);
    const title = sanitizeWhitespace(parts[0]) || sanitizeWhitespace(a.text()) || `Work ${index}`;
    const author = parts[1] ? sanitizeWhitespace(parts[1]) : undefined;

    const geCell = tds.eq(3);
    const geHtml = geCell.html() || "";
    const geParts = geHtml.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, "").split(/\n/).map((x) => x.trim()).filter(Boolean);
    const genre = geParts[0] ? sanitizeWhitespace(geParts[0]) : sanitizeWhitespace(geCell.text());
    const engine = (geParts[1] ? sanitizeWhitespace(geParts[1]) : undefined) || sanitizeWhitespace(geCell.find("font").last().text());

    const downloadUrl = tds.eq(4).find("a").first().attr("href");
    const streamingRaw = sanitizeWhitespace(tds.eq(5).text());
    const forumUrl = tds.eq(6).find("a[href*='jbbs']").attr("href");

    entries.push({ index, no: noRaw, title: title!, iconUrl, author, genre, engine, streamingRaw, detailUrl, forumUrl: forumUrl ? toAbsoluteUrl(forumUrl, baseUrl) : undefined, downloadUrl: downloadUrl ? toAbsoluteUrl(downloadUrl, baseUrl) : undefined });
  });

  if (entries.length === 0) {
    // Fallback: anchor-based parse
    $("a[href*='entry']").each((_, el) => {
      const a = $(el);
      const href = a.attr("href") || "";
      const m = href.match(/entry(\d{1,3})\.html/i);
      if (!m) return;
      const noRaw = m[1];
      const index = noRaw.padStart(2, "0");
      const detailUrl = toAbsoluteUrl(href, baseUrl);
      let iconUrl: string | undefined;
      const td = a.closest("td");
      const prevImg = td.prev().find("img").attr("src");
      if (prevImg) iconUrl = toAbsoluteUrl(prevImg, baseUrl);
      const htmlIn = a.html() || a.text();
      const parts = htmlIn.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, "").split(/\n/).map((x) => x.trim()).filter(Boolean);
      const title = sanitizeWhitespace(parts[0]) || sanitizeWhitespace(a.text()) || `Work ${index}`;
      const author = parts[1] ? sanitizeWhitespace(parts[1]) : undefined;
      const dlCell = td.next();
      const downloadUrl = dlCell.find("a").attr("href") || dlCell.next().find("a").attr("href") || undefined;
      const forumUrl = dlCell.next().find("a[href*='jbbs']").attr("href") || td.nextAll("td").find("a[href*='jbbs']").attr("href") || undefined;
      entries.push({ index, no: noRaw, title: title!, iconUrl, author, detailUrl, forumUrl: forumUrl ? toAbsoluteUrl(forumUrl, baseUrl) : undefined, downloadUrl: downloadUrl ? toAbsoluteUrl(downloadUrl, baseUrl) : undefined });
    });
  }

  const map = new Map<string, IndexEntry>();
  for (const e of entries) if (!map.has(e.index)) map.set(e.index, e);
  return Array.from(map.values()).sort((a, b) => Number(a.no) - Number(b.no));
}

async function parseDetailGeneric(url: string | undefined): Promise<DetailEntry> {
  if (!url) return {};
  try {
    const html = await fetchText(url);
    await ensureDir(CATCH_DIR);
    const label = (url.split("/").pop() || "entry.html").replace(/[^a-z0-9_.-]+/gi, "-");
    await fs.writeFile(path.join(CATCH_DIR, label), html, "utf8");
    const $ = cheerio.load(html);
    const result: DetailEntry = {};
    const baseHref = url;
    const screenshotSet = new Set<string>();
    const addIfImage = (u?: string | null) => {
      if (!u) return;
      const abs = toAbsoluteUrl(u, baseHref);
      if (!abs) return;
      if (!/\.(png|jpe?g|gif|bmp)$/i.test(abs)) return;
      const lower = abs.toLowerCase();
      if (lower.includes("counter")) return;
      if (/\/mate\/i\d+/i.test(lower)) return; // skip icons
      // Only accept screenshots under mate/ss*
      if (!/\/(2016gw|viprpg2016gw)\/mate\/ss/i.test(lower) && !/\/mate\/ss/i.test(lower)) return;
      screenshotSet.add(abs);
    };
    $("img").each((_, el) => {
      const img = $(el);
      addIfImage(img.attr("src") ?? undefined);
      const onOver = img.attr("onmouseover");
      const onOut = img.attr("onmouseout");
      const pick = (val?: string | null) => {
        if (!val) return;
        const m = val.match(/['\"]([^'\"]+\.(?:png|jpe?g|gif|bmp)(?:\?[^'\"]*)?)['\"]/i);
        if (m) addIfImage(m[1]);
      };
      pick(onOver); pick(onOut);
    });
    if (screenshotSet.size > 0) result.screenshots = Array.from(screenshotSet);

    const textFromCells = (label: string) => {
      const cell = $(`td:contains(${label})`).filter((_, el) => $(el).text().includes(label)).first();
      if (!cell.length) return undefined;
      const raw = cell.html() || cell.text();
      return sanitizeMultilineHtmlToText(raw);
    };
    const aRaw = textFromCells("作者コメント") || textFromCells("作者から一言");
    const hRaw = textFromCells("管理人コメント") || textFromCells("主催コメント");
    result.authorComment = stripLeadingLabel(aRaw, ["作者コメント", "作者から一言"]);
    result.hostComment = stripLeadingLabel(hRaw, ["管理人コメント", "主催コメント"]);
    return result;
  } catch (err) {
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
  // purge existing
  try {
    const files = await fs.readdir(SCREENSHOTS_DIR);
    await Promise.all(files.filter((f) => f.startsWith(index)).map((f) => fs.unlink(path.join(SCREENSHOTS_DIR, f)).catch(() => undefined)));
  } catch {}

  let order = 1;
  for (const src of sources) {
    if (saved.length >= 6) break;
    try {
      const { buffer, contentType } = await fetchBinary(src);
      if (!looksLikeImageBuffer(buffer, contentType)) { failures.push(`${src} (not image: ${contentType || "unknown"})`); continue; }
      const dim = getImageDimensions(buffer);
      if (dim && dim.width < SMALL_IMAGE_LIMIT && dim.height < SMALL_IMAGE_LIMIT) { skipped.push({ source: src, reason: "small" }); continue; }
      const md5 = createHash("md5").update(buffer).digest("hex");
      if (hashSet.has(md5)) { skipped.push({ source: src, reason: "duplicate" }); continue; }
      hashSet.add(md5);
      const ext = getImageExtension(src, ".png");
      const file = order === 1 ? `${index}${ext}` : `${index}-${String(order).padStart(2, "0")}${ext}`;
      await fs.writeFile(path.join(SCREENSHOTS_DIR, file), buffer);
      saved.push(path.posix.join(RELATIVE_SCREENSHOTS_DIR, file));
      order += 1;
    } catch (err) { failures.push(`${src} => ${(err as Error).message}`); }
  }
  return { paths: saved, skipped, failures };
}

async function run() {
  await ensureDir(CATCH_DIR);
  await ensureDir(BANNERS_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);

  // Fetch timemaps
  const allRows: TimemapRow[] = [];
  for (const base of BASE_ORIGINS) {
    try { const rows = await fetchTimemap(base); allRows.push(...rows); } catch {}
  }

  // Fetch main listing (FC2 main.html preferred)
  const mainOriginal = new URL("main.html", BASE_ORIGINS[0]).toString();
  let mainHtml = ""; let mainUrl = "";
  try { mainHtml = await fetchText(`https://web.archive.org/web/2/${mainOriginal}`); mainUrl = `https://web.archive.org/web/2/${mainOriginal}`; } catch {}
  if (!mainHtml) {
    // fallback to index.html
    const idxOrig = new URL("index.html", BASE_ORIGINS[0]).toString();
    try { mainHtml = await fetchText(`https://web.archive.org/web/2/${idxOrig}`); mainUrl = `https://web.archive.org/web/2/${idxOrig}`; } catch {}
  }
  if (!mainHtml) {
    await fs.writeFile(OUTPUT_WORKS, JSON.stringify([], null, 2), "utf8");
    await fs.writeFile(SUMMARY_PATH, JSON.stringify([{ index: "--", status: "error", error: "missing main/index via Wayback" }], null, 2), "utf8");
    console.error("No main html fetched");
    return;
  }
  await fs.writeFile(path.join(CATCH_DIR, path.basename(new URL(mainUrl).pathname)), mainHtml, "utf8");
  await saveBannerFromIndex(mainUrl, mainHtml);

  const entries = parseIndex2016(mainHtml, mainUrl);

  const { iconByIndex, detailByIndex, ssByIndex } = buildAssetMaps(allRows);

  const out: WorkEntryOut[] = [];
  const summary: SnapshotRecord[] = [];

  for (const e of entries) {
    // Details via timemap preferred
    // Try multiple detail snapshots (iterate timemap rows for this entry)
    const detailCandidates: string[] = [];
    const detRegex = new RegExp(`/(?:2016GW|viprpg2016gw)/entry0*${Number(e.no)}\\.html$`, "i");
    const detRows = allRows
      .filter((r) => detRegex.test(r.original))
      .sort((a, b) => (b.endtimestamp || b.timestamp).localeCompare(a.endtimestamp || a.timestamp));
    for (const r of detRows) detailCandidates.push(buildWaybackUrl(r.endtimestamp || r.timestamp, r.original, "fw_"));
    if (e.detailUrl) detailCandidates.push(e.detailUrl);
    let detail: DetailEntry = {};
    for (const u of detailCandidates) {
      try {
        const d = await parseDetailGeneric(u);
        detail = d;
        if (d.authorComment || d.hostComment || (d.screenshots && d.screenshots.length > 0)) break;
      } catch {}
    }

    // Icon via timemap (try multiple snapshots) else from list
    let iconLocal: string | undefined = undefined;
    const iconCandidates: string[] = [];
    const iconRegex = new RegExp(`/(?:2016GW|viprpg2016gw)/mate/i0*${Number(e.no)}\\.(?:png|jpe?g|gif|bmp)$`, "i");
    const iconRows = allRows
      .filter((r) => iconRegex.test(r.original))
      .sort((a, b) => (b.endtimestamp || b.timestamp).localeCompare(a.endtimestamp || a.timestamp));
    for (const r of iconRows) iconCandidates.push(buildWaybackUrl(r.endtimestamp || r.timestamp, r.original, "im_"));
    if (e.iconUrl) iconCandidates.push(e.iconUrl);
    for (const u of iconCandidates) { iconLocal = await copyIcon(e.index, u); if (iconLocal) break; }

    // Screenshots: union of parsed + timemap
    const screenshotSources = new Set<string>();
    if (detail.screenshots) detail.screenshots.forEach((u) => screenshotSources.add(u));
    const tmScreens = ssByIndex.get(e.index) || [];
    for (const r of tmScreens) screenshotSources.add(buildWaybackUrl(r.endtimestamp || r.timestamp, r.original, "im_"));
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
    if (!work.authorComment && !work.hostComment && (!work.ss || work.ss.length === 0)) work.detailDisabled = true;
    out.push(work);

    summary.push({
      index: e.index,
      status: "ok",
      title: e.title,
      icon: iconLocal,
      downloadSource: e.downloadUrl ? [e.downloadUrl] : undefined,
      sourcesTried: [mainUrl],
      detailSourcesTried: detailCandidates,
      iconSourcesTried: iconCandidates,
      screenshotSourcesTriedCount: screenshotSources.size,
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
