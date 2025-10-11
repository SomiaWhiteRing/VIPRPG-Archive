import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const FESTIVAL_ID = "2019-gw";
const FESTIVAL_SLUG = "2019-gw";

const OUTPUT_WORKS = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const CATCH_DIR = path.join(process.cwd(), "catch", FESTIVAL_SLUG);
const SUMMARY_PATH = path.join(CATCH_DIR, `${FESTIVAL_SLUG}-scrape-summary.json`);

const PUBLIC_DIR = path.join(process.cwd(), "public");
const BANNERS_DIR = path.join(PUBLIC_DIR, "banners");
const ICONS_DIR = path.join(PUBLIC_DIR, "icons", FESTIVAL_SLUG);
const SCREENSHOTS_DIR = path.join(PUBLIC_DIR, "screenshots", FESTIVAL_SLUG);

const RELATIVE_ICONS_DIR = `/icons/${FESTIVAL_SLUG}`;
const RELATIVE_SCREENSHOTS_DIR = `/screenshots/${FESTIVAL_SLUG}`;

// 按页面实际提供的数量保存截图，不做上限限制；仅过滤极小图标
const SMALL_IMAGE_LIMIT = 100;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)" +
  " Chrome/130.0.0.0 Safari/537.36";

type Maybe<T> = T | undefined;

interface IndexEntry {
  index: string; // 2/3-digit number text
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

// 始终直连：禁用 Wayback 与代理
const DIRECT_ONLY = true;

function buildWaybackCandidates(directUrl: string) {
  const u = stripJina(directUrl);
  const jina = `https://r.jina.ai/${u}`;
  if (DIRECT_ONLY) return [u];
  return [u, jina, `https://web.archive.org/web/2im_/${u}`, `https://web.archive.org/web/2fw_/${u}`, `https://web.archive.org/web/2id_/${u}`];
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

function parseIndexGeneric(html: string, assetsBase: string): IndexEntry[] {
  const $ = cheerio.load(html);
  const entries: IndexEntry[] = [];

  function pushEntry(noText: string, tds: cheerio.Cheerio) {
    const num = noText.padStart(2, "0");
    // 2019GW table: th(No.), td0(icon), td1(work/author), td2(genre/tool), td3(dl), td4(streaming), td5(forum)
    const iconUrl = tds.eq(0).find("img").attr("src");
    const workCell = tds.eq(1);
    const a = workCell.find("a").first();
    const detailRel = a.attr("href");
    const aHtml = a.html() || workCell.html() || "";
    const aParts = aHtml.replace(/<br\s*\/?\s*>/gi, "\n").split(/\n/).map((x) => x.trim()).filter(Boolean);
    const title = aParts.length > 0 ? sanitizeWhitespace(aParts[0]) : (sanitizeWhitespace(a.text()) || sanitizeWhitespace(workCell.text()) || `Work ${num}`);
    // author is after a <br> within the anchor text
    const author = (() => {
      const html = a.html() || workCell.html() || "";
      const parts = html.replace(/<br\s*\/?\s*>/gi, "\n").split(/\n/).map((x) => x.trim()).filter(Boolean);
      return parts.length >= 2 ? sanitizeWhitespace(parts[1]) : undefined;
    })();
    const genre = sanitizeWhitespace(tds.eq(2).contents().first().text());
    const engine = sanitizeWhitespace(tds.eq(2).find("span, small, .font75").text()) || sanitizeWhitespace(tds.eq(2).contents().last().text());
    const dlCell = tds.eq(3);
    const downloadUrl = dlCell.find("a").first().attr("href");
    const streamingRaw = sanitizeWhitespace(tds.eq(4).text());
    const forumUrl = tds.eq(5).find("a").attr("href");

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
  }

  const rows = $("table tr");
  rows.each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 3) return;
    let noText: string | undefined;
    const thText = $(tr).find("th").first().text().trim();
    if (/^\d{1,3}$/.test(thText)) noText = thText;
    if (!noText) {
      const first = tds.eq(0).text().trim();
      if (/^\d{1,3}$/.test(first)) noText = first;
      const noMatch = first.match(/No\s*(\d{1,3})/i);
      if (!noText && noMatch) noText = noMatch[1];
    }
    if (!noText) return;
    pushEntry(noText, tds);
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
      // 特殊：处理 onmouseover/onmouseout 中的切换大图
      const onOver = img.attr("onmouseover");
      const onOut = img.attr("onmouseout");
      const pick = (val?: string | null) => {
        if (!val) return;
        const m = val.match(/["']([^"']+\.(?:png|jpe?g|gif|bmp))["']/i);
        if (m) addIfImage(m[1]);
      };
      pick(onOver);
      pick(onOut);
      // 其他属性值中若直接是图片路径也收集
      const attr = (el as cheerio.Element).attribs ?? {};
      for (const v of Object.values(attr)) {
        if (typeof v === "string") addIfImage(v);
      }
    });
    $("a").each((_, el) => addIfImage($(el).attr("href")));
    if (screenshotSet.size > 0) result.screenshots = Array.from(screenshotSet);

    const findRowText = (label: string) => {
      // 兼容形如：【作者コメント】/作者コメント：/作者： 等前缀
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
      // 优先按 <br> 分割，丢弃第一段标签部分
      const parts = rawHtml.split(/<br\s*\/?\s*>/i);
      if (parts.length > 1) {
        const contentHtml = parts.slice(1).join("<br>");
        return sanitizeMultiline(contentHtml);
      }
      // 回退：移除标签与冒号
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
  // purge old
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
  // If user has placed offline HTML snapshots, prefer those
  try {
    const localFiles = await fs.readdir(CATCH_DIR).catch(() => [] as string[]);
    const preferred = localFiles.filter((f) => /index|menu_?entry|top/i.test(f) && f.toLowerCase().endsWith(".html"));
    if (preferred.length > 0) {
      const file = preferred.sort()[0];
      const html = await fs.readFile(path.join(CATCH_DIR, file), "utf8");
      return { url: `file://${file}`, html, sourcesTried: [path.join(CATCH_DIR, file)] };
    }
  } catch {}

  // Candidates assembled from common hosts and paths used by VIPRPG festivals
  const bases = [
    // User-provided base URL via CLI arg has highest priority
    ...(process.argv[2] ? [process.argv[2]] : []),
    "https://viprpg2019gw.x.2nt.com/",
    "http://viprpg2019gw.x.2nt.com/",
    "https://viprpg2019gw.web.fc2.com/",
    "http://viprpg2019gw.web.fc2.com/",
    "https://viprpg2019gw.x.fc2.com/",
    "http://viprpg2019gw.x.fc2.com/",
    "https://viprpg2019gw.nobody.jp/",
    "http://viprpg2019gw.nobody.jp/",
    "https://viprpg2019gw.suppa.jp/",
    "http://viprpg2019gw.suppa.jp/",
    "https://viprpg2019gw.kenkenpa.net/",
    "http://viprpg2019gw.kenkenpa.net/",
    "https://viprpg2019gw.xdomain.jp/",
    "http://viprpg2019gw.xdomain.jp/",
  ];
  const pages = ["index.html", "top.html", "index_entry.html", "menu_entry.html", "menu_top.html", "index.htm", "top.htm"]; 
  const tried: string[] = [];
  for (const b of bases) {
    for (const p of pages) {
      const u = new URL(p, b).toString();
      tried.push(u);
      try {
        const html = await fetchText(u);
        return { url: u, html, sourcesTried: tried.slice() };
      } catch {}
      // Try Jina Reader proxy for HTML pages (removes referer/scripts)
      try {
        const jr = `https://r.jina.ai/${u}`;
        const html = await fetchText(jr);
        return { url: jr, html, sourcesTried: tried.slice() };
      } catch {}
      // Try Wayback latest snapshot
      try {
        const wb = `https://web.archive.org/web/2/${u}`; // auto-redirects to closest snapshot
        const html = await fetchText(wb);
        return { url: wb, html, sourcesTried: tried.slice() };
      } catch {}
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
    const summary = [{ index: "--", status: "error" as const, error: "Failed to resolve 2019-gw index page from known candidates.", sourcesTried: [] as string[] }];
    await fs.writeFile(OUTPUT_WORKS, JSON.stringify(empty, null, 2), "utf8");
    await fs.writeFile(SUMMARY_PATH, JSON.stringify(summary, null, 2), "utf8");
    console.error("Could not locate 2019-gw index. Please update festival-urls.json with a resolvable URL or add HTML to catch/2019-gw.");
    return;
  }

  const { url: indexUrl, html: indexHtml, sourcesTried } = indexCandidate;
  await fs.writeFile(path.join(CATCH_DIR, path.basename(indexUrl) || "index.html"), indexHtml, "utf8");
  // Prefer CLI arg as network base when offline 'file:' is used
  const assetsBase = indexUrl.startsWith("file:") && process.argv[2] ? process.argv[2] : indexUrl;
  await saveBannerFromIndex(assetsBase, indexHtml);

  const entries = parseIndexGeneric(indexHtml, assetsBase);
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
