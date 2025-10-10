import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const FESTIVAL_ID = "2021-summer";
const FESTIVAL_SLUG = "2021-summer";
const BASE_URL = "https://viprpg2021s.kenkenpa.net";
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
  no: string; // raw no text
  title: string;
  author: string;
  category?: string;
  engine?: string;
  iconUrl?: string;
  detailUrl?: string;
  forumUrl?: string;
  streamingRaw?: string;
  downloadUrl?: string;
}

interface DetailEntry {
  author?: string;
  category?: string;
  engine?: string;
  streaming?: string;
  authorComment?: string;
  hostComment?: string;
  screenshots?: string[];
  forumUrl?: string;
  downloadUrl?: string;
}

interface ScreenshotSkip { source: string; reason: "small" | "duplicate"; }

interface SnapshotRecord {
  index: string;
  status: "ok" | "error";
  title?: string;
  icon?: string;
  downloadSource?: string[];
  screenshotReport?: { saved: number; skipped?: ScreenshotSkip[]; failures?: string[] };
  error?: string;
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

async function fetchText(url: string) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml", Connection: "close" },
    cache: "no-store",
    redirect: "follow",
    referrerPolicy: "no-referrer",
  } as RequestInit);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

async function fetchBinary(url: string) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8", Connection: "close" },
    cache: "no-store",
    redirect: "follow",
    referrerPolicy: "no-referrer",
  } as RequestInit);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const ab = await res.arrayBuffer();
  return { buffer: Buffer.from(ab), contentType: (res.headers.get("content-type") ?? "").toLowerCase() };
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

async function saveBanner() {
  try {
    const html = await fetchText(INDEX_URL);
    await ensureDir(CATCH_DIR);
    await fs.writeFile(path.join(CATCH_DIR, "index.html"), html, "utf8");
    const $ = cheerio.load(html);
    const src = $("img[src*='banner']").first().attr("src") || "/image/banner1.png";
    const abs = new URL(src, INDEX_URL).toString();
    const { buffer } = await fetchBinary(abs);
    await ensureDir(BANNERS_DIR);
    const ext = getImageExtension(abs, ".png");
    await fs.writeFile(path.join(BANNERS_DIR, `${FESTIVAL_SLUG}${ext}`), buffer);
  } catch (e) {
    console.warn("Failed to save banner:", (e as Error).message);
  }
}

function parseIndex(html: string): IndexEntry[] {
  const $ = cheerio.load(html);
  const rows = $("#table2 tbody tr").toArray();
  const entries: IndexEntry[] = [];
  for (const tr of rows) {
    const row = $(tr);
    const tds = row.find("td");
    if (tds.length < 6) continue;
    const noText = sanitizeWhitespace(tds.eq(0).text());
    if (!noText) continue;
    if (!/^\d{1,2}$/.test(noText)) continue;
    const no = noText;
    const index = no.padStart(2, "0");
    const iconUrl = tds.eq(1).find("img").attr("src");
    const a = tds.eq(2).find("a").first();
    const title = sanitizeWhitespace(a.text()) ?? `Work ${index}`;
    const author = sanitizeWhitespace(tds.eq(2).find("span.font75").text()) ?? "";
    const category = sanitizeWhitespace(tds.eq(3).contents().first().text());
    const engine = sanitizeWhitespace(tds.eq(3).find("span.font75").text());
    const dlA = tds.eq(4).find("a").first();
    const downloadUrl = dlA.attr("href");
    const streamingRaw = sanitizeWhitespace(tds.eq(5).text());
    const forumA = tds.eq(6).find("a").first();
    const forumUrl = forumA.attr("href");
    const href = a.attr("href");
    const detailUrl = href ? new URL(href, INDEX_URL).toString() : undefined;
    const iconAbs = iconUrl ? new URL(iconUrl, INDEX_URL).toString() : undefined;
    const forumAbs = forumUrl ? new URL(forumUrl, INDEX_URL).toString() : undefined;
    const downloadAbs = downloadUrl ? new URL(downloadUrl, INDEX_URL).toString() : undefined;
    entries.push({ index, no, title, author, category, engine, iconUrl: iconAbs, detailUrl, forumUrl: forumAbs, streamingRaw, downloadUrl: downloadAbs });
  }
  return entries;
}

async function copyIcon(index: string, source?: string | null): Promise<string | undefined> {
  if (!source) return undefined;
  await ensureDir(ICONS_DIR);
  try {
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
  // Purge old files for this index to keep directory clean
  try {
    const files = await fs.readdir(SCREENSHOTS_DIR);
    await Promise.all(
      files
        .filter((f) => f.startsWith(index))
        .map((f) => fs.unlink(path.join(SCREENSHOTS_DIR, f)).catch(() => undefined))
    );
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
      if (!contentType.startsWith("image/")) { failures.push(src + ` (not image: ${contentType || "unknown"})`); continue; }
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
    } catch (e) {
      failures.push(src + " => " + (e as Error).message);
    }
  }
  return { paths: saved, skipped, failures };
}

async function parseDetail(url?: string): Promise<DetailEntry> {
  if (!url) return {};
  try {
    const html = await fetchText(url);
    const name = url.split("/").pop() || "detail.html";
    await ensureDir(CATCH_DIR);
    await fs.writeFile(path.join(CATCH_DIR, name), html, "utf8");
    const $ = cheerio.load(html);
    const result: DetailEntry = {};
    const table = $("#entry");
    // Screenshots: collect <img> src + common alternate handlers, and image links
    const shotSet = new Set<string>();
    const addIfImage = (u?: string | null) => {
      if (!u) return;
      try {
        const abs = new URL(u, url).toString();
        if (!/\.(png|jpe?g|gif|bmp)$/i.test(abs)) return;
        const lower = abs.toLowerCase();
        if (lower.includes("noicon")) return;
        if (lower.includes("counter_img.php")) return;
        shotSet.add(abs);
      } catch {}
    };

    table.find("img").each((_, img) => {
      const el = $(img);
      addIfImage(el.attr("src"));
      const attrs = ["onmouseover", "onmouseout", "data-src", "data-alt-src", "data-hover-src"];
      for (const a of attrs) {
        const v = el.attr(a);
        if (!v) continue;
        const m1 = v.match(/['\"]([^'\"]+\.(?:png|jpe?g|gif|bmp))['\"]/i);
        if (m1) addIfImage(m1[1]);
        const m2 = v.match(/([\w\-/.]+\.(?:png|jpe?g|gif|bmp))/i);
        if (m2) addIfImage(m2[1]);
      }
    });
    // Also collect image links inside table
    table.find('a[href$=".png"],a[href$=".jpg"],a[href$=".jpeg"],a[href$=".gif"],a[href$=".bmp"]').each((_, a) => {
      addIfImage($(a).attr('href'));
    });
    if (shotSet.size) result.screenshots = Array.from(shotSet);

    const textOf = (label: string) => {
      const cell = table.find(`td:contains(${label})`).filter((_, el) => $(el).text().trim().startsWith(label)).first();
      if (!cell.length) return undefined;
      const raw = cell.html() || cell.text();
      const withBreaks = raw.replace(/<br\s*\/?>(\s*)/gi, "\n");
      const plain = cheerio.load(`<div>${withBreaks}</div>`)('div').text();
      return sanitizeMultiline(plain.replace(new RegExp(`^${label}[\u3000\s]*[：:]*[\u3000\s]*`), ""));
    };

    result.author = textOf("作者");
    result.category = textOf("ジャンル");
    result.engine = textOf("ツール") || textOf("使用ツール");
    result.streaming = textOf("配信/投稿");
    result.authorComment = textOf("作者コメント");
    // host comment may include a line break after label
    result.hostComment = textOf("管理人コメント");

    // Forum & download from row with links
    const linksRow = table.find("a").filter((_, a) => /ダウンロード|感想掲示板/.test($(a).text())).closest("td");
    if (linksRow && linksRow.length) {
      const dl = linksRow.find("a:contains('ダウンロード')").attr("href");
      if (dl) result.downloadUrl = new URL(dl, url).toString();
      const forum = linksRow.find("a:contains('感想掲示板')").attr("href");
      if (forum) result.forumUrl = new URL(forum, url).toString();
    }
    return result;
  } catch (e) {
    console.warn("Failed to parse detail:", url, e);
    return {};
  }
}

async function run() {
  await ensureDir(CATCH_DIR);
  await ensureDir(BANNERS_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);

  await saveBanner();

  const indexHtml = await fetchText(INDEX_URL);
  const list = parseIndex(indexHtml);

  const works: WorkEntryOut[] = [];
  const summary: SnapshotRecord[] = [];

  for (const e of list) {
    const detail = await parseDetail(e.detailUrl);
    const iconLocal = await copyIcon(e.index, e.iconUrl);
    const shots = detail.screenshots && detail.screenshots.length > 0 ? detail.screenshots : [];
    const shotResult = await copyScreenshots(e.index, shots);

    const work: WorkEntryOut = {
      id: `${FESTIVAL_ID}-work-${e.index}`,
      festivalId: FESTIVAL_ID,
      no: e.no,
      title: e.title,
      author: e.author,
      category: e.category ?? detail.category,
      engine: e.engine ?? detail.engine,
      streaming: detail.streaming ?? e.streamingRaw,
      forum: detail.forumUrl ?? e.forumUrl,
      authorComment: detail.authorComment,
      hostComment: detail.hostComment,
      icon: iconLocal,
      ss: shotResult.paths.length > 0 ? shotResult.paths : undefined,
    };
    works.push(work);

    summary.push({
      index: e.index,
      status: "ok",
      title: e.title,
      icon: iconLocal,
      downloadSource: (detail.downloadUrl || e.downloadUrl) ? [detail.downloadUrl || e.downloadUrl!].filter(Boolean) as string[] : undefined,
      screenshotReport: { saved: shotResult.paths.length, skipped: shotResult.skipped.length ? shotResult.skipped : undefined, failures: shotResult.failures.length ? shotResult.failures : undefined },
    });
  }

  await fs.writeFile(OUTPUT_WORKS, JSON.stringify(works, null, 2), "utf8");
  await fs.writeFile(SUMMARY_PATH, JSON.stringify(summary, null, 2), "utf8");
  console.log(`Saved works to ${OUTPUT_WORKS}`);
  console.log(`Summary written to ${SUMMARY_PATH}`);
}

run().catch((err) => { console.error(err); process.exit(1); });
