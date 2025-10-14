import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const FESTIVAL_ID = "2018-gw";
const FESTIVAL_SLUG = "2018-gw";
const BASE_ORIGIN = "https://vipkohaku.x.fc2.com/2018GW/";

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

type Maybe<T> = T | undefined;

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

function buildWaybackUrl(ts: string, original: string, kind: "im_" | "id_" | "fw_" = "id_") {
  const u = original.startsWith("http") ? original : new URL(original, BASE_ORIGIN).toString();
  return `https://web.archive.org/web/${ts}${kind}/${u}`;
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
      return await res.text();
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
  } catch {}
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
    const noCell = tds.eq(0);
    const noText = sanitizeWhitespace(noCell.text());
    if (!noText || !/^\d{1,3}$/.test(noText)) return;
    const num = noText.padStart(2, "0");
    const iconUrl = tds.eq(1).find("img").attr("src");
    const workCell = tds.eq(2);
    const a = workCell.find("a").first();
    const detailRel = a.attr("href");
    const aHtml = a.html() || workCell.html() || "";
    const aParts = aHtml.replace(/<br\s*\/?\s*>/gi, "\n").split(/\n/)
      .map((x) => x.replace(/<[^>]+>/g, "").trim()).filter(Boolean);
    const title = aParts.length > 0 ? sanitizeWhitespace(aParts[0]) : (sanitizeWhitespace(a.text()) || sanitizeWhitespace(workCell.text()) || `Work ${num}`);
    const author = aParts.length >= 2 ? sanitizeWhitespace(aParts[1]) : undefined;
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
  } catch {
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
  } catch { return undefined; }
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

async function fetchTimemap(base: string): Promise<TimemapRow[]> {
  const tmUrl = `https://web.archive.org/web/timemap/json?url=${encodeURIComponent(base)}&matchType=prefix&collapse=urlkey&output=json&fl=original%2Cmimetype%2Ctimestamp%2Cendtimestamp%2Cgroupcount%2Cuniqcount&filter=!statuscode%3A%5B45%5D..&limit=10000`;
  const text = await fetchText(tmUrl);
  await ensureDir(CATCH_DIR);
  await fs.writeFile(path.join(CATCH_DIR, "timemap.json"), text, "utf8");
  const raw = JSON.parse(text) as unknown;
  if (!Array.isArray(raw) || raw.length < 2) return [];
  const header = raw[0] as unknown[];
  const idx = {
    original: (header as string[]).indexOf("original"),
    mimetype: (header as string[]).indexOf("mimetype"),
    timestamp: (header as string[]).indexOf("timestamp"),
    endtimestamp: (header as string[]).indexOf("endtimestamp"),
    groupcount: (header as string[]).indexOf("groupcount"),
    uniqcount: (header as string[]).indexOf("uniqcount"),
  };
  const out: TimemapRow[] = [];
  for (const row of raw.slice(1) as unknown[]) {
    if (!Array.isArray(row)) continue;
    const rec: TimemapRow = {
      original: String(row[idx.original] ?? ""),
      mimetype: String(row[idx.mimetype] ?? ""),
      timestamp: String(row[idx.timestamp] ?? ""),
      endtimestamp: String(row[idx.endtimestamp] ?? ""),
      groupcount: Number(row[idx.groupcount] ?? 0),
      uniqcount: Number(row[idx.uniqcount] ?? 0),
    };
    out.push(rec);
  }
  return out;
}

function buildAssetMaps(rows: TimemapRow[]) {
  const iconByIndex = new Map<string, TimemapRow>();
  const detailByIndex = new Map<string, TimemapRow>();
  const ssByIndex = new Map<string, TimemapRow[]>();
  for (const r of rows) {
    const u = r.original;
    if (!u.includes("/2018GW/")) continue;
    // detail e.g. /2018GW/entry01.html
    const md = u.match(/\/2018GW\/(?:index|top|menu_(?:entry|top)\.html|index\.html)$/i);
    // not used here
    const mDetail = u.match(/\/2018GW\/entry(\d{2,3})\.html$/i);
    if (mDetail) {
      const idx = mDetail[1].padStart(2, "0");
      // prefer later snapshot
      const prev = detailByIndex.get(idx);
      if (!prev || r.endtimestamp > prev.endtimestamp) detailByIndex.set(idx, r);
      continue;
    }
    // icon: /2018GW/entry/icon01.png or icon001.png
    const mIcon = u.match(/\/2018GW\/entry\/icon0*(\d{1,3})\.(png|jpe?g|gif|bmp)$/i);
    if (mIcon) {
      const idx = mIcon[1].padStart(2, "0");
      const prev = iconByIndex.get(idx);
      if (!prev || r.endtimestamp > prev.endtimestamp) iconByIndex.set(idx, r);
      continue;
    }
    // screenshots: under /2018GW/entry/, image but not icon
    if (/\/2018GW\/entry\//i.test(u) && /\.(png|jpe?g|gif|bmp)$/i.test(u) && !/\/entry\/icon/i.test(u) && !/counter/i.test(u)) {
      // best-effort infer index from filename or parent path
      let idx: string | undefined;
      const mNum = u.match(/(?:^|[^\d])(\d{2})(?:[^\d]|\.|$)/); // pick 2-digit group
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

async function run() {
  await ensureDir(CATCH_DIR);
  await ensureDir(BANNERS_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);

  // 1) Fetch index page (Wayback latest) to parse table metadata
  const indexRows = await fetchTimemap(BASE_ORIGIN);
  const indexHtmlRow = indexRows.find((r) => /\/(top|index|menu_entry|menu_top)\.html$/i.test(r.original))
    || indexRows.find((r) => /\/(top|index)\.htm$/i.test(r.original));
  if (!indexHtmlRow) {
    await fs.writeFile(OUTPUT_WORKS, JSON.stringify([], null, 2), "utf8");
    await fs.writeFile(SUMMARY_PATH, JSON.stringify([{ index: "--", status: "error", error: "missing index in timemap" }], null, 2), "utf8");
    console.error("No index html found in timemap");
    return;
  }
  const indexUrlCandidates = [
    buildWaybackUrl(indexHtmlRow.endtimestamp || indexHtmlRow.timestamp, indexHtmlRow.original, "fw_"),
    buildWaybackUrl(indexHtmlRow.timestamp || indexHtmlRow.endtimestamp, indexHtmlRow.original, "fw_"),
    `https://web.archive.org/web/2/${indexHtmlRow.original}`,
  ];
  let indexUrl = indexUrlCandidates[0];
  let indexHtml: string | undefined;
  for (const cand of indexUrlCandidates) {
    try { indexHtml = await fetchText(cand); indexUrl = cand; break; } catch {}
  }
  if (!indexHtml) throw new Error("Failed to fetch index html from wayback candidates");
  await fs.writeFile(path.join(CATCH_DIR, path.basename(new URL(indexHtmlRow.original).pathname) || "index.html"), indexHtml, "utf8");
  await saveBannerFromIndex(indexUrl, indexHtml);

  // 2) Parse entries from index
  const entries = parseIndex2018(indexHtml, indexUrl);

  // 3) Build asset maps from full timemap
  const { iconByIndex, detailByIndex, ssByIndex } = buildAssetMaps(indexRows);

  const out: WorkEntryOut[] = [];
  const summary: SnapshotRecord[] = [];

  for (const e of entries) {
    // prefer detail page from timemap when available
    const detailRow = detailByIndex.get(e.index);
    let detailSnapshot = detailRow ? buildWaybackUrl(detailRow.endtimestamp || detailRow.timestamp, detailRow.original, "fw_") : e.detailUrl;
    let detail: DetailEntry = {};
    if (detailSnapshot) {
      try { detail = await parseDetailGeneric(detailSnapshot); }
      catch {
        // fallback to closest snapshot redirect
        try { detail = await parseDetailGeneric(`https://web.archive.org/web/2/${detailRow?.original}`); }
        catch { detail = {}; }
      }
    }

    // icon from timemap if available, else from list
    const iconRow = iconByIndex.get(e.index);
    const iconSnapshot = iconRow ? buildWaybackUrl(iconRow.endtimestamp || iconRow.timestamp, iconRow.original, "im_") : (e.iconUrl ?? undefined);
    const iconLocal = await copyIcon(e.index, iconSnapshot);

    // screenshot sources: union of detail parsed images + timemap best-guess
    const screenshotSources = new Set<string>();
    if (detail.screenshots) detail.screenshots.forEach((u) => screenshotSources.add(u));
    const tmScreens = ssByIndex.get(e.index) || [];
    for (const r of tmScreens) {
      const s = buildWaybackUrl(r.endtimestamp || r.timestamp, r.original, "im_");
      screenshotSources.add(s);
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
      sourcesTried: [indexUrl],
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
