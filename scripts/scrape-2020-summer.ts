import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const FESTIVAL_ID = "2020-summer";
const FESTIVAL_SLUG = "2020-summer";
const BASE_URL = "https://vipfesarc.neocities.org/s2020";
const INDEX_URL = `${BASE_URL}/`;

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
  no: string; // raw number
  title: string;
  author: string;
  category?: string;
  engine?: string;
  streaming?: string;
  forum?: string;
  iconUrl?: string;
  thumbUrl?: string;
  detailUrl?: string;
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
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
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
    let bannerBuffer: Buffer | undefined;
    let ext = ".png";
    const dataImg = $("img[src^='data:image']").first().attr("src");
    if (dataImg && dataImg.startsWith("data:image")) {
      const m = dataImg.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (m) {
        const [, mime, b64] = m;
        try {
          bannerBuffer = Buffer.from(b64, "base64");
          if (mime.toLowerCase() === "image/jpeg") ext = ".jpg";
          else if (mime.toLowerCase() === "image/png") ext = ".png";
          else if (mime.toLowerCase() === "image/gif") ext = ".gif";
        } catch {}
      }
    }
    if (!bannerBuffer) {
      const src = $("img[src*='banner']").first().attr("src") || "/image/banner1.png";
      const abs = new URL(src, INDEX_URL).toString();
      const { buffer } = await fetchBinary(abs);
      bannerBuffer = buffer; ext = getImageExtension(abs, ".png");
    }
    if (bannerBuffer) {
      await ensureDir(BANNERS_DIR);
      await fs.writeFile(path.join(BANNERS_DIR, `${FESTIVAL_SLUG}${ext}`), bannerBuffer);
    }
  } catch (e) {
    console.warn("Failed to save banner:", (e as Error).message);
  }
}

function parseIndex(html: string): IndexEntry[] {
  const $ = cheerio.load(html);
  const items: IndexEntry[] = [];
  $(".wrapUnder-contents-listItem-descriptionTitle").each((_, el) => {
    const titleDiv = $(el);
    const container = titleDiv.closest(".wrapUnder-contents-listItem, .wrapUnder-contents-listItem2");
    if (!container.length) return;
    const imgA = container.find(".wrapUnder-contents-listItem-img a").first();
    const detailHref = imgA.attr("href");
    const thumbImg = imgA.find("img").attr("src");
    const iconUrl = titleDiv.find("img").attr("src");
    const titleA = titleDiv.find("a").first();
    const fullTitle = sanitizeWhitespace(titleA.text()) ?? "";
    let no: string | undefined;
    let m = fullTitle.match(/No\.(\d+)/i);
    if (m) no = m[1];
    if (!no) {
      const alt = titleDiv.find('img').attr('alt') || '';
      const m2 = alt.match(/No\.(\d+)/i);
      if (m2) no = m2[1];
    }
    if (!no && detailHref) {
      const m3 = detailHref.match(/entry(\d+)\.html/i);
      if (m3) no = m3[1];
    }
    if (!no) return;
    const index = no.padStart(2, "0");
    const title = fullTitle.replace(/No\.\d+\s*/i, "");
    const desc = container.find(".wrapUnder-contents-listItem-description");
    const textHtml = desc.find(".wrapUnder-contents-listItem-descriptionText").html() || "";
    const withBr = textHtml.replace(/<br\s*\/?>(\s*)/gi, "\n");
    const txt = cheerio.load(`<div>${withBr}</div>`)('div').text();
    const line = (re: RegExp) => { const m = txt.match(re); return m ? sanitizeWhitespace(m[1]) ?? undefined : undefined; };
    const author = line(/【作者】([^\n]+)/) ?? "";
    const engine = line(/【ツール】([^\n]+)/) || line(/【使用ツール】([^\n]+)/);
    const category = line(/【ジャンル】([^\n]+)/);
    const streaming = line(/【配信\/投稿】([^\n]+)/);
    const forumHref = desc.find("a").filter((_, a) => /【感想】/.test($(a).text())).attr("href");
    const dlHref = desc.find("a").filter((_, a) => /【DL/.test($(a).text())).attr("href");
    items.push({
      index, no,
      title, author, category, engine, streaming,
      forum: forumHref ? new URL(forumHref, INDEX_URL).toString() : undefined,
      iconUrl: iconUrl ? new URL(iconUrl, INDEX_URL).toString() : undefined,
      thumbUrl: thumbImg ? new URL(thumbImg, INDEX_URL).toString() : undefined,
      detailUrl: detailHref ? new URL(detailHref, INDEX_URL).toString() : undefined,
      downloadUrl: dlHref ? new URL(dlHref, INDEX_URL).toString() : undefined,
    });
  });
  return items;
}

function stripLeadingLabelFromHtml(html: string, label: string) {
  // Remove everything up to and including label + optional colon and first <br>
  const re = new RegExp(`^[\\s\\S]*?${label}[：:]?\\s*(?:<br\\s*\\/?>\\s*)?`, "i");
  return html.replace(re, "").trim();
}

async function parseDetail(url?: string): Promise<DetailEntry> {
  if (!url) return {};
  try {
    const html = await fetchText(url);
    const name = url.split("/").pop() || "entry.html";
    await ensureDir(CATCH_DIR);
    await fs.writeFile(path.join(CATCH_DIR, name), html, "utf8");
    const $ = cheerio.load(html);
    const result: DetailEntry = {};
    const table = $("#entry");
    const shotSet = new Set<string>();
    const addIfImage = (u?: string | null) => {
      if (!u) return; const abs = new URL(u, url).toString();
      if (!/\.(png|jpe?g|gif|bmp|webp|avif)$/i.test(abs)) return; // image extension gate
      if (abs.toLowerCase().includes("/img/icon/")) return; // skip 32x32 icon
      shotSet.add(abs);
    };
    // Primary screenshot(s) in the first tbody tr
    table.find("img").each((_, img) => {
      addIfImage($(img).attr("src"));
      const onOver = $(img).attr("onmouseover");
      if (onOver) {
        const m = onOver.match(/this\.src='([^']+)'/);
        if (m) addIfImage(m[1]);
      }
    });
    // Basic fields
    const rawText = table.text().replace(/\s+/g, " ").trim();
    const lx = (re: RegExp) => { const m = rawText.match(re); return m ? sanitizeWhitespace(m[1]) : undefined; };
    result.author = lx(/作者：([^\s].*?)(?: ジャンル| ツール| 配信|$)/);
    result.category = lx(/ジャンル：([^\s].*?)(?: ツール| 配信|$)/);
    result.engine = lx(/ツール：([^\s].*?)(?: 配信|$)/) || lx(/使用ツール：([^\s].*?)(?: 配信|$)/);
    result.streaming = lx(/配信\/投稿：([^\s].*?)(?: 作者コメント|$)/);
    // Comments: keep original HTML and strip leading label to avoid duplication in UI
    const htmlAuthorCell = table.find("td:contains('作者コメント')").first().html() || "";
    if (htmlAuthorCell) {
      result.authorComment = stripLeadingLabelFromHtml(htmlAuthorCell, "作者コメント");
    }
    const htmlHostCell = table.find("td:contains('管理人コメント')").first().html() || "";
    if (htmlHostCell) {
      result.hostComment = stripLeadingLabelFromHtml(htmlHostCell, "管理人コメント");
    }
    // Links
    table.find("a").each((_, a) => {
      const text = ($(a).text() || "").trim();
      const href = $(a).attr("href");
      if (!href) return;
      const abs = new URL(href, url).toString();
      if (/【?感想】?/.test(text)) result.forumUrl = abs;
      if (/【?DL/.test(text) || /ダウンロード/.test(text)) result.downloadUrl = abs;
    });
    result.screenshots = Array.from(shotSet);
    return result;
  } catch (e) {
    return {};
  }
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
      if (!looksLikeImageBuffer(buffer, contentType)) { failures.push(src); continue; }
      const dim = getImageDimensions(buffer);
      if (dim && (dim.width < SMALL_IMAGE_LIMIT || dim.height < SMALL_IMAGE_LIMIT)) {
        skipped.push({ source: src, reason: "small" });
        continue;
      }
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

async function main() {
  await ensureDir(CATCH_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);
  await saveBanner();
  const html = await fetchText(INDEX_URL);
  await fs.writeFile(path.join(CATCH_DIR, "index.html"), html, "utf8");
  const entries = parseIndex(html);
  const out: WorkEntryOut[] = [];
  const snapshots: SnapshotRecord[] = [];
  for (const e of entries) {
    const record: SnapshotRecord = { index: e.index, status: "ok", title: e.title };
    try {
      const detail = await parseDetail(e.detailUrl);
      const icon = await copyIcon(e.index, e.iconUrl);
      record.icon = icon;
      const shots = detail.screenshots || [];
      const { paths: ss, skipped, failures } = await copyScreenshots(e.index, shots);
      if (skipped.length || failures.length) record.screenshotReport = { saved: ss.length, skipped, failures };
      const work: WorkEntryOut = {
        id: `${FESTIVAL_SLUG}-${e.index}`,
        festivalId: FESTIVAL_ID,
        no: e.index,
        title: e.title,
        author: e.author,
        category: e.category || detail.category,
        engine: e.engine || detail.engine,
        streaming: e.streaming || detail.streaming,
        forum: e.forum || detail.forumUrl,
        authorComment: detail.authorComment,
        hostComment: detail.hostComment,
        icon,
      };
      if (ss.length > 0) (work as any).ss = ss;
      out.push(work);
      if (e.downloadUrl || detail.downloadUrl) record.downloadSource = [e.downloadUrl, detail.downloadUrl].filter(Boolean) as string[];
    } catch (err) {
      record.status = "error";
      record.error = (err as Error).message;
    }
    snapshots.push(record);
  }
  await fs.writeFile(OUTPUT_WORKS, JSON.stringify(out, null, 2), "utf8");
  await fs.writeFile(SUMMARY_PATH, JSON.stringify(snapshots, null, 2), "utf8");
  console.log(`Saved ${out.length} works to ${OUTPUT_WORKS}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
