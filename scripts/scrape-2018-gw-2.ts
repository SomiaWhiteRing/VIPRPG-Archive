import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";

const FESTIVAL_ID = "2018-gw-2";
const FESTIVAL_SLUG = "2018-gw-2";

const OUTPUT_WORKS = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const CATCH_DIR = path.join(process.cwd(), "catch", FESTIVAL_SLUG);
const SUMMARY_PATH = path.join(CATCH_DIR, `${FESTIVAL_SLUG}-scrape-summary.json`);

const PUBLIC_DIR = path.join(process.cwd(), "public");
const BANNERS_DIR = path.join(PUBLIC_DIR, "banners");
const ICONS_DIR = path.join(PUBLIC_DIR, "icons", FESTIVAL_SLUG);
const SCREENSHOTS_DIR = path.join(PUBLIC_DIR, "screenshots", FESTIVAL_SLUG);

const RELATIVE_ICONS_DIR = `/icons/${FESTIVAL_SLUG}`;
const RELATIVE_SCREENSHOTS_DIR = `/screenshots/${FESTIVAL_SLUG}`;

// Keep tiny <100px images out of screenshots; icons are handled separately
const SMALL_IMAGE_LIMIT = 100;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)" +
  " Chrome/130.0.0.0 Safari/537.36";

type Maybe<T> = T | undefined;

interface IndexEntry {
  index: string; // zero-padded number text
  no: string; // raw number
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
}

interface SnapshotRecord {
  index: string;
  status: "ok" | "error";
  title?: string;
  icon?: string;
  note?: string;
  downloadSource?: string[];
  sourcesTried?: string[];
  screenshotReport?: {
    saved: number;
    skipped?: ScreenshotSkip[];
    failures?: string[];
  };
  error?: string;
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

function stripJina(url: string) {
  const m = url.match(/^https?:\/\/r\.jina\.ai\/(https?:\/\/.+)$/i);
  return m ? m[1] : url;
}

// For FC2 2018, HTML pages often 403; include Wayback candidates
const DIRECT_ONLY = false;

function buildWaybackCandidates(directUrl: string) {
  const u = stripJina(directUrl);
  if (DIRECT_ONLY) return [u];
  // Prefer Wayback candidates first; FC2 direct often returns an age gate page
  return [
    `https://web.archive.org/web/2im_/${u}`,
    `https://web.archive.org/web/2fw_/${u}`,
    `https://web.archive.org/web/2id_/${u}`,
    u,
  ];
}

async function fetchSnapshotTimestamps(directUrl: string, limit = 25): Promise<string[]> {
  try {
    const encoded = encodeURIComponent(stripJina(directUrl));
    const api = `https://web.archive.org/cdx/search/cdx?url=${encoded}&output=json&filter=statuscode:200&fl=timestamp,mimetype&limit=${limit}`;
    const res = await fetch(api, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } as any });
    if (!res.ok) return [];
    const text = await res.text();
    if (!text.trim() || text.trim() === "[]") return [];
    const data = JSON.parse(text) as unknown[];
    if (!Array.isArray(data) || data.length < 2) return [];
    const out: string[] = [];
    for (const row of data.slice(1)) {
      if (Array.isArray(row) && typeof row[0] === "string") out.push(row[0] as string);
    }
    return out;
  } catch {
    return [];
  }
}

function buildWaybackCandidatesWithTs(directUrl: string, timestamps: string[]) {
  const base = buildWaybackCandidates(directUrl);
  const u = stripJina(directUrl);
  const out = new Set<string>(base);
  for (const ts of timestamps) {
    out.add(`https://web.archive.org/web/${ts}im_/${u}`);
    out.add(`https://web.archive.org/web/${ts}fw_/${u}`);
    out.add(`https://web.archive.org/web/${ts}id_/${u}`);
  }
  return Array.from(out);
}

function detectEncoding(buffer: Buffer, contentType: string | null | undefined): string {
  const ct = (contentType || "").toLowerCase();
  const fromCt = (() => {
    const m = ct.match(/charset=([^;\s]+)/i);
    return m ? m[1].trim() : undefined;
  })();
  const normalize = (enc: string) => {
    const e = enc.toLowerCase();
    if (/(shift[_-]?jis|sjis|windows-31j)/i.test(e)) return "shift_jis";
    if (/(euc[_-]?jp)/i.test(e)) return "euc-jp";
    if (/utf-?8/i.test(e)) return "utf-8";
    return e;
  };
  let enc = fromCt ? normalize(fromCt) : undefined;
  if (!enc || enc === "utf-8") {
    const head = buffer.slice(0, 4096).toString("ascii").toLowerCase();
    const m1 = head.match(/<meta[^>]+charset\s*=\s*([\w-]+)/i);
    const m2 = head.match(/content-type[^>]*charset\s*=\s*([\w-]+)/i);
    const cand = m1?.[1] || m2?.[1];
    if (cand) enc = normalize(cand);
  }
  return enc || "utf-8";
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
      const buffer = Buffer.from(ab);
      const enc = detectEncoding(buffer, res.headers.get("content-type"));
      return iconv.decode(buffer, enc as any);
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
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function saveBannerFromIndex(indexUrl: string, html: string) {
  try {
    const $ = cheerio.load(html);
    const bannerSrc = $("img[src*='banner']").first().attr("src") || $("img").first().attr("src");
    if (!bannerSrc) return;
    const bannerAbs = toAbsoluteUrl(bannerSrc, indexUrl);
    if (!bannerAbs) return;
    const { buffer } = await fetchBinary(bannerAbs);
    await ensureDir(BANNERS_DIR);
    const ext = getImageExtension(bannerAbs, ".png");
    await fs.writeFile(path.join(BANNERS_DIR, `${FESTIVAL_SLUG}${ext}`), buffer);
  } catch {
    // ignore banner failures
  }
}

function sanitizeWhitespace(v?: string | null) {
  if (!v) return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t || undefined;
}

function sanitizeMultiline(v?: string | null) {
  if (!v) return undefined;
  const out = v
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return out || undefined;
}

function parseIndex2018(html: string, assetsBase: string): IndexEntry[] {
  const $ = cheerio.load(html);
  const entries: IndexEntry[] = [];

  const rows = $("table tr");
  rows.each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 5) return;
    // Column layout (rows): 0:No, 1:Icon, 2:Work/Author, 3:Genre/Engine, 4:DL, 5:Streaming/Post, 6:Forum
    const noCell = tds.eq(0);
    const noText = sanitizeWhitespace(noCell.text());
    if (!noText || !/^\d{1,3}$/.test(noText)) return;
    const num = noText.padStart(2, "0");

    const iconUrl = tds.eq(1).find("img").attr("src");
    const workCell = tds.eq(2);
    const a = workCell.find("a").first();
    const detailRel = a.attr("href");
    // prefer using <br>-split HTML parts, then strip tags
    const aHtml = a.html() || workCell.html() || "";
    const aParts = aHtml.replace(/<br\s*\/?\s*>/gi, "\n").split(/\n/)
      .map((x) => x.replace(/<[^>]+>/g, "").trim()).filter(Boolean);
    const title = aParts.length > 0 ? sanitizeWhitespace(aParts[0]) : (sanitizeWhitespace(a.text()) || sanitizeWhitespace(workCell.text()) || `Work ${num}`);
    const author = aParts.length >= 2 ? sanitizeWhitespace(aParts[1]) : undefined;
    // genre/engine split by <br>
    const gHtml = tds.eq(3).html() || "";
    const gParts = gHtml.replace(/<br\s*\/?\s*>/gi, "\n").split(/\n/).map((x) => x.replace(/<[^>]+>/g, "").trim()).filter(Boolean);
    const genre = gParts[0] ? sanitizeWhitespace(gParts[0]) : sanitizeWhitespace(tds.eq(3).text());
    const engine = gParts[1] ? sanitizeWhitespace(gParts[1]) : undefined;
    const dlCell = tds.eq(4);
    const downloadUrl = dlCell.find("a").first().attr("href");
    const streamingRaw = sanitizeWhitespace(tds.eq(5).text());
    const forumUrl = tds.eq(6).find("a").attr("href");

    entries.push({
      index: num,
      no: noText,
      title: title!,
      iconUrl: iconUrl ? toAbsoluteUrl(iconUrl, assetsBase) : undefined,
      author,
      genre,
      engine,
      streamingRaw,
      detailUrl: detailRel ? toAbsoluteUrl(detailRel, assetsBase) : undefined,
      forumUrl: forumUrl ? toAbsoluteUrl(forumUrl, assetsBase) : undefined,
      downloadUrl: downloadUrl ? toAbsoluteUrl(downloadUrl, assetsBase) : undefined,
    });
  });
  return entries;
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
      if (abs.toLowerCase().includes("counter")) return;
      if (/\/icons?\//i.test(abs)) return;
      screenshotSet.add(abs);
    };
    $("img").each((_, el) => {
      const img = $(el);
      const src = img.attr("src");
      addIfImage(src ?? undefined);
      // handle hover swaps
      const onOver = img.attr("onmouseover");
      const onOut = img.attr("onmouseout");
      const pick = (val?: string | null) => {
        if (!val) return;
        const m = val.match(/["']([^"']+\.(?:png|jpe?g|gif|bmp))["']/i);
        if (m) addIfImage(m[1]);
      };
      pick(onOver);
      pick(onOut);
      const attr = (el as cheerio.Element).attribs ?? {};
      for (const v of Object.values(attr)) {
        if (typeof v === "string") addIfImage(v);
      }
    });
    $("a").each((_, el) => addIfImage($(el).attr("href")));
    if (screenshotSet.size > 0) result.screenshots = Array.from(screenshotSet);

    const findRowText = (label: string) => {
      const cells = $(`td:contains(${label})`);
      let pick: cheerio.Cheerio | undefined;
      cells.each((_, el) => {
        const t = $(el).text().replace(/[\s\u3000]+/g, " ").trim();
        const normalized = t.replace(/[\[\(（【\]\)】]/g, "");
        if (normalized.startsWith(label) || normalized.includes(`${label}：`) || normalized.includes(`${label}:`)) {
          pick = $(el);
          return false;
        }
        return;
      });
      if (!pick) return undefined;
      const rawHtml = pick.first().html() || pick.first().text();
      const parts = rawHtml.split(/<br\s*\/?\s*>/i);
      if (parts.length > 1) {
        const contentHtml = parts.slice(1).join("<br>");
        return sanitizeMultiline(contentHtml);
      }
      const pattern = new RegExp(`^[\\s\\S]*?(?:[【\u3010\[(]?${label}[】\u3011\])?)\s*[:：]?\s*`, "u");
      const html2 = rawHtml.replace(pattern, "");
      return sanitizeMultiline(html2);
    };
    result.authorComment = findRowText("作者コメント") || findRowText("作者のコメント") || findRowText("作者") || findRowText("備考");
    result.hostComment = findRowText("管理人コメント") || findRowText("主催コメント");

    return result;
  } catch (error) {
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
  try {
    const files = await fs.readdir(SCREENSHOTS_DIR);
    await Promise.all(
      files.filter((f) => f.startsWith(index)).map((f) => fs.unlink(path.join(SCREENSHOTS_DIR, f)).catch(() => undefined))
    );
  } catch {}
  const skipped: ScreenshotSkip[] = [];
  const failures: string[] = [];
  const saved: string[] = [];
  const hashSet = new Set<string>();
  let order = 1;
  for (const src of sources) {
    try {
      const { buffer, contentType } = await fetchBinary(src);
      if (!looksLikeImageBuffer(buffer, contentType)) { failures.push(src + ` (not image: ${contentType || "unknown"})`); continue; }
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
    } catch (err) {
      failures.push(src + " => " + (err as Error).message);
    }
  }
  return { paths: saved, skipped, failures };
}

async function tryFetchIndexHtml(): Promise<{ url: string; html: string; sourcesTried: string[] } | undefined> {
  try {
    const localFiles = await fs.readdir(CATCH_DIR).catch(() => [] as string[]);
    const preferred = localFiles.filter((f) => /(index|menu_?entry|menu_top|top)\.html$/i.test(f));
    if (preferred.length > 0) {
      const file = preferred.sort()[0];
      const html = await fs.readFile(path.join(CATCH_DIR, file), "utf8");
      return { url: `file://${file}`, html, sourcesTried: [path.join(CATCH_DIR, file)] };
    }
  } catch {}

  const bases = [
    ...(process.argv[2] ? [process.argv[2]] : []),
    "https://vipkohaku.x.fc2.com/2018GW2/",
    "http://vipkohaku.x.fc2.com/2018GW2/",
  ];
  const pages = ["index.html", "top.html", "menu_entry.html", "menu_top.html", "index.htm", "top.htm"]; 
  const tried: string[] = [];
  for (const b of bases) {
    for (const p of pages) {
      const u = new URL(p, b).toString();
      tried.push(u);
      const wbTs = await fetchSnapshotTimestamps(u, 50);
      const cands = buildWaybackCandidatesWithTs(u, wbTs);
      for (const cand of cands) {
        try {
          const html = await fetchText(cand);
          // Skip FC2 age-gate page
          if (/年齢認証|adult_eula/i.test(html)) continue;
          return { url: cand, html, sourcesTried: tried.slice() };
        } catch {}
      }
    }
  }
  return undefined;
}

async function run() {
  await ensureDir(CATCH_DIR);
  await ensureDir(BANNERS_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);

  const indexCandidate = await tryFetchIndexHtml();
  if (!indexCandidate) {
    const empty: WorkEntryOut[] = [];
    const summary = [{ index: "--", status: "error" as const, error: "Failed to resolve 2018-gw-2 index page from known candidates.", sourcesTried: [] as string[] }];
    await fs.writeFile(OUTPUT_WORKS, JSON.stringify(empty, null, 2), "utf8");
    await fs.writeFile(SUMMARY_PATH, JSON.stringify(summary, null, 2), "utf8");
    console.error("Could not locate 2018-gw-2 index. Please update festival-urls.json with a resolvable URL or add HTML to catch/2018-gw-2.");
    return;
  }

  const { url: indexUrl, html: indexHtml, sourcesTried } = indexCandidate;
  await fs.writeFile(path.join(CATCH_DIR, path.basename(indexUrl) || "index.html"), indexHtml, "utf8");
  const assetsBase = indexUrl;
  await saveBannerFromIndex(assetsBase, indexHtml);

  const entries = parseIndex2018(indexHtml, assetsBase);
  const out: WorkEntryOut[] = [];
  const summary: SnapshotRecord[] = [];

  for (const e of entries) {
    const detail = await parseDetailGeneric(e.detailUrl);
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
      sourcesTried,
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
