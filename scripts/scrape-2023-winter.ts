import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const execFileAsync = promisify(execFile);

// Festival constants
const FESTIVAL_ID = "2023-winter";
const FESTIVAL_SLUG = "2023-winter";
const JAM_URL = "https://itch.io/jam/viprmwinterjam2023-anno-draconis";

// Directories and files
const CATCH_DIR = path.join(process.cwd(), "catch", FESTIVAL_SLUG);
const OUTPUT_WORKS = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const SUMMARY_PATH = path.join(CATCH_DIR, `${FESTIVAL_SLUG}-scrape-summary.json`);
const JAM_HTML = path.join(CATCH_DIR, "jam.html");
const JAM_HTML_ORIGINAL = path.join(CATCH_DIR, "jam.original.html");
const ENTRIES_HTML = path.join(CATCH_DIR, "entries.html");
const SCREENSHOTS_HTML = path.join(CATCH_DIR, "screenshots.html");
const ENTRIES_DATA_JSON = path.join(CATCH_DIR, "entries-data.json");
const GAME_CACHE_DIR = path.join(CATCH_DIR, "game");
const RATE_CACHE_DIR = path.join(CATCH_DIR, "rate");

const PUBLIC_DIR = path.join(process.cwd(), "public");
const BANNERS_DIR = path.join(PUBLIC_DIR, "banners");
const ICONS_DIR = path.join(PUBLIC_DIR, "icons", FESTIVAL_SLUG);
const SCREENSHOTS_DIR = path.join(PUBLIC_DIR, "screenshots", FESTIVAL_SLUG);

const RELATIVE_BANNERS_DIR = "/banners";
const RELATIVE_ICONS_DIR = `/icons/${FESTIVAL_SLUG}`;
const RELATIVE_SCREENSHOTS_DIR = `/screenshots/${FESTIVAL_SLUG}`;
const MAX_SCREENSHOTS = 6;

const CURL_BASE_ARGS = ["--silent", "--show-error", "--retry", "3", "--retry-delay", "1", "--compressed"];

// Types
interface TableEntry {
  index: string; // display no (e.g., 01)
  gameUrl?: string;
  rateUrl?: string;
  variant?: string;
  detailDisabled?: boolean;
  title: string;
  author: string;
  category?: string;
  engine?: string;
  streaming?: string;
  iconUrl?: string;
  downloadLink?: string;
  downloadLabel?: string;
  forumLink?: string;
}

interface JamGameEntry {
  rateUrl: string;
  gameUrl: string;
  title: string;
  author: string;
  cover?: string;
  shortText?: string;
}

function normalizeKey(title?: string, author?: string) {
  const norm = (s?: string) => (s ?? "").toLowerCase().replace(/\s+/g, "").replace(/[“”"'、，,。．\.\-—_\(\)（）\[\]【】]/g, "");
  return `${norm(title)}@@${norm(author)}`;
}

interface ScreenshotSkip { source: string; reason: "small" | "duplicate" }
interface ScreenshotResult { paths: string[]; failures: string[]; skipped: ScreenshotSkip[] }

interface WorkEntry {
  id: string;
  festivalId: string;
  no?: string;
  title: string;
  icon?: string;
  category?: string;
  engine?: string;
  author: string;
  streaming?: string;
  forum?: string;
  authorComment?: string;
  hostComment?: string;
  ss?: string[];
  detailDisabled?: boolean;
}

interface SnapshotRecord {
  index: string;
  status: "ok" | "skipped" | "error";
  title?: string;
  icon?: string;
  note?: string;
  downloadSource?: string[];
  screenshotReport?: { saved: number; skipped?: ScreenshotSkip[]; failures?: string[] };
  error?: string;
}

// Utilities
async function ensureDir(dir: string) { await fs.mkdir(dir, { recursive: true }); }

function sanitizeWhitespace(value: string | undefined) {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed || undefined;
}

function normalizeUrl(url: string | undefined, base?: string) {
  if (!url) return undefined;
  try {
    return new URL(url, base ?? "https://itch.io").toString();
  } catch { return undefined; }
}

function readerize(url: string) {
  // Prefix all HTML page fetches via r.jina.ai as a transparent reader proxy
  if (!/^https?:\/\//i.test(url)) return url; // should already be absolute
  if (/^https:\/\/r\.jina\.ai\//i.test(url)) return url; // already wrapped
  return `https://r.jina.ai/${url}`;
}

async function runCurlText(url: string) {
  const readerUrl = readerize(url);
  try {
    const args = [...CURL_BASE_ARGS, "--location", "--fail", readerUrl];
    const { stdout } = await execFileAsync("curl", args, { encoding: "utf8" });
    return stdout as unknown as string;
  } catch {
    const res = await fetch(readerUrl, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  }
}

async function runCurlTextDirect(url: string) {
  // Direct HTML fetch for parsing only (fallback when reader snapshot is not parseable)
  try {
    const args = [...CURL_BASE_ARGS, "--location", "--fail", url];
    const { stdout } = await execFileAsync("curl", args, { encoding: "utf8" });
    return stdout as unknown as string;
  } catch {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  }
}

async function downloadBinary(url: string) {
  // Binary assets must be fetched directly (not via r.jina.ai)
  try {
    const args = [...CURL_BASE_ARGS, "--location", "--fail", url, "-H", "Referer:"];
    const { stdout } = (await execFileAsync("curl", args, { encoding: "buffer" })) as unknown as { stdout: Buffer };
    return stdout;
  } catch {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  }
}

function bufferLooksLikeHtml(buffer: Buffer) {
  if (buffer.length === 0) return true;
  if (buffer[0] === 0x3c) {
    const second = buffer[1];
    if (second === 0x21 || second === 0x68 || second === 0x48 || second === 0x3f) return true;
  }
  try {
    const sample = buffer.slice(0, 256).toString("utf8").trimStart().toLowerCase();
    if (!sample) return false;
    return sample.startsWith("<!doctype") || sample.startsWith("<html") || sample.startsWith("<head") || sample.startsWith("<body");
  } catch { return false; }
}

function getImageExtension(url: string, fallback = ".png") {
  const clean = url.split(/[?#]/)[0];
  const ext = path.extname(clean).toLowerCase();
  if (ext === ".jpeg") return ".jpg";
  if (ext) return ext;
  return fallback;
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
      if (offset + 1 >= buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      const isSOF = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (isSOF) {
        if (length >= 7) {
          const height = buffer.readUInt16BE(offset + 3);
          const width = buffer.readUInt16BE(offset + 5);
          return { width, height };
        }
        break;
      }
      offset += length;
    }
  }
  if (buffer.length >= 10) {
    const header = buffer.toString("ascii", 0, 6);
    if (header === "GIF87a" || header === "GIF89a") {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
  }
  if (buffer.length >= 26 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    const width = buffer.readInt32LE(18);
    const height = Math.abs(buffer.readInt32LE(22));
    return { width, height };
  }
  return undefined;
}

// Caching jam pages via r.jina.ai
async function ensureJamCaches() {
  await ensureDir(CATCH_DIR);
  // Jam overview
  if (!(await fileExists(JAM_HTML))) {
    const html = await runCurlText(JAM_URL);
    await fs.writeFile(JAM_HTML, html, "utf8");
  }
  // Save original HTML for parser fallback if reader snapshot is markdown
  if (!(await fileExists(JAM_HTML_ORIGINAL))) {
    try {
      const htmlDirect = await runCurlTextDirect(JAM_URL);
      await fs.writeFile(JAM_HTML_ORIGINAL, htmlDirect, "utf8");
    } catch {
      // best effort
    }
  }
  // Discover entries/screenshots from jam nav
  const jamHtml = await fs.readFile(JAM_HTML, "utf8");
  const $ = cheerio.load(jamHtml);
  const navLinks = new Set<string>();
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href") || "";
    if (/\/jam\//i.test(href) && /\/entries\b/i.test(href)) {
      const abs = normalizeUrl(href, JAM_URL);
      if (abs) navLinks.add(abs);
    }
    if (/\/jam\//i.test(href) && /\/screenshots\b/i.test(href)) {
      const abs = normalizeUrl(href, JAM_URL);
      if (abs) navLinks.add(abs);
    }
  });
  let entriesUrl: string | undefined;
  let screenshotsUrl: string | undefined;
  for (const link of navLinks) {
    if (/\/entries\b/i.test(link)) entriesUrl = link;
    if (/\/screenshots\b/i.test(link)) screenshotsUrl = link;
  }
  if (entriesUrl && !(await fileExists(ENTRIES_HTML))) {
    const html = await runCurlText(entriesUrl);
    await fs.writeFile(ENTRIES_HTML, html, "utf8");
  }
  if (screenshotsUrl && !(await fileExists(SCREENSHOTS_HTML))) {
    const html = await runCurlText(screenshotsUrl);
    await fs.writeFile(SCREENSHOTS_HTML, html, "utf8");
  }
  // Try to detect a JSON endpoint from jam page
  if (!(await fileExists(ENTRIES_DATA_JSON))) {
    const scripts = $("script").map((_, el) => $(el).html() || "").get().join("\n");
    const m = scripts.match(/https?:\/\/[^\"']*\bentries[^\"']*json[^\"']*/i);
    if (m && m[0]) {
      try {
        const jsonText = await runCurlText(m[0]);
        await fs.writeFile(ENTRIES_DATA_JSON, jsonText, "utf8");
      } catch {
        // Ignore if not resolvable
      }
    }
  }
}

async function ensureBanner() {
  const html = await fs.readFile(JAM_HTML, "utf8");
  let bannerUrl: string | undefined;
  try {
    const $ = cheerio.load(html);
    const content = $(".jam_content").first();
    content.find("img").each((_, el) => {
      if (bannerUrl) return;
      const src = normalizeUrl($(el).attr("src"));
      if (!src) return;
      if (!/img\.itch\.zone\/aW1n/i.test(src)) return;
      bannerUrl = src;
    });
  } catch {
    // ignore
  }
  if (!bannerUrl) {
    // Fallback: parse reader snapshot text and pick first itch.zone image from Markdown section
    const m = html.match(/https:\/\/img\.itch\.zone\/[A-Za-z0-9_\-=\/\.\%]+/);
    if (m) bannerUrl = m[0];
  }
  if (!bannerUrl) return undefined;
  await ensureDir(BANNERS_DIR);
  const extension = getImageExtension(bannerUrl, ".png");
  const fileName = `${FESTIVAL_SLUG}${extension}`;
  const destPath = path.join(BANNERS_DIR, fileName);
  if (!(await fileExists(destPath))) {
    try {
      const buffer = await downloadBinary(bannerUrl);
      if (bufferLooksLikeHtml(buffer) || buffer.length === 0) {
        return undefined;
      }
      await fs.writeFile(destPath, buffer);
    } catch {
      // 忽略横幅下载失败，后续可重试
      return undefined;
    }
  }
  return `${RELATIVE_BANNERS_DIR}/${fileName}`;
}

async function ensureIcon(index: string, iconUrl: string | undefined) {
  if (!iconUrl) return undefined;
  await ensureDir(ICONS_DIR);
  const extension = getImageExtension(iconUrl, ".png");
  const fileName = `${index}${extension}`;
  const destPath = path.join(ICONS_DIR, fileName);
  if (await fileExists(destPath)) {
    return `${RELATIVE_ICONS_DIR}/${fileName}`;
  }
  try {
    const buffer = await downloadBinary(iconUrl);
    if (bufferLooksLikeHtml(buffer)) {
      return undefined;
    }
    await fs.writeFile(destPath, buffer);
    return `${RELATIVE_ICONS_DIR}/${fileName}`;
  } catch {
    return undefined;
  }
}

async function fileExists(target: string) {
  try { await fs.access(target); return true; } catch { return false; }
}

async function purgeScreenshots(index: string) {
  try {
    const files = await fs.readdir(SCREENSHOTS_DIR);
    await Promise.all(
      files.filter((file) => file.startsWith(index)).map((file) => fs.unlink(path.join(SCREENSHOTS_DIR, file)).catch(() => undefined)),
    );
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw error;
  }
}

type ScreenshotGroup = { order: number; urls: string[] };

async function ensureScreenshots(index: string, groups: ScreenshotGroup[] | string[]) {
  const candidates = Array.isArray(groups)
    ? (typeof (groups as any)[0] === "string" ? (groups as string[]).map((u, i) => ({ order: i, urls: [u] })) : (groups as ScreenshotGroup[]))
    : [];
  if (candidates.length === 0) {
    return { paths: [], failures: [], skipped: [] } as ScreenshotResult;
  }
  await ensureDir(SCREENSHOTS_DIR);
  const seenHashes = new Set<string>();
  const paths: string[] = [];
  const failures: string[] = [];
  const skipped: ScreenshotSkip[] = [];
  await purgeScreenshots(index);

  for (const group of candidates.sort((a, b) => a.order - b.order)) {
    if (paths.length >= MAX_SCREENSHOTS) break;
    let savedThisGroup = false;
    for (const url of group.urls) {
      try {
        const buffer = await downloadBinary(url);
        if (bufferLooksLikeHtml(buffer) || buffer.length === 0) { failures.push(url); continue; }
        const dims = getImageDimensions(buffer);
        if (dims && dims.width < 100 && dims.height < 100) { skipped.push({ source: url, reason: "small" }); continue; }
        const hash = createHash("md5").update(buffer).digest("hex");
        if (seenHashes.has(hash)) { skipped.push({ source: url, reason: "duplicate" }); continue; }
        seenHashes.add(hash);
        const suffix = paths.length > 0 ? `-${String(paths.length + 1).padStart(2, "0")}` : "";
        const extension = getImageExtension(url, ".png");
        const fileName = `${index}${suffix}${extension}`;
        const destPath = path.join(SCREENSHOTS_DIR, fileName);
        await fs.writeFile(destPath, buffer);
        paths.push(`${RELATIVE_SCREENSHOTS_DIR}/${fileName}`);
        savedThisGroup = true;
        break;
      } catch {
        failures.push(url);
        continue;
      }
    }
    if (!savedThisGroup) continue;
  }
  return { paths, failures, skipped } as ScreenshotResult;
}

function cleanTitle(raw: string) { return raw.replace(/[★☆◎◇◆△▽※♪♭♫\s]+/g, " ").trim(); }

// Parsing
async function parseTable(): Promise<Map<string, TableEntry>> {
  // Prefer parsing from reader snapshot's Markdown section; original is often React-driven
  const jamText = await fs.readFile(JAM_HTML, "utf8");
  const rows = new Map<string, TableEntry>();
  if (/^\s*Title:\s*/m.test(jamText) && /\nMarkdown Content:\n/m.test(jamText)) {
    const [, mdBlockRaw = ""] = jamText.split(/\nMarkdown Content:\n/);
    const lines = mdBlockRaw.split(/\r?\n/);
    for (const line of lines) {
      const ln = line.replace(/\*\*/g, "").trim();
      // Expect lines like: 1 ![img](iconURL) [Title](rateUrl) Author [■](forum)
      const mIndex = ln.match(/^(\d{1,2})/);
      if (!mIndex) continue;
      const indexText = mIndex[1];
      const imgMatch = ln.match(/!\[[^\]]*\]\(([^)]+)\)/);
      const iconUrl = normalizeUrl(imgMatch?.[1]);

      // Collect links
      const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
      const links: { label: string; href: string }[] = [];
      let lm: RegExpExecArray | null;
      while ((lm = linkRe.exec(ln))) {
        links.push({ label: lm[1], href: normalizeUrl(lm[2]) || lm[2] });
      }
      const workLinks = links.filter((l) => /\/jam\/.+\/rate\//i.test(l.href));
      if (workLinks.length === 0) continue;
      const forumLink = links.filter((l) => !/\/jam\/.+\/rate\//i.test(l.href)).pop()?.href;

      const author = (() => {
        // Text after last work link closing
        const lastWork = workLinks[workLinks.length - 1];
        const lastIdx = ln.lastIndexOf(`](${lastWork.href})`);
        if (lastIdx >= 0) {
          const tail = ln.slice(lastIdx + `](${lastWork.href})`.length);
          const cut = tail.split("[")[0] || tail; // stop before next link (forum)
          const cleaned = cut.replace(/[★☆◎◇◆△▽※♪♭♫\s]+/g, " ").trim();
          return cleaned;
        }
        return "";
      })();

      const titleCellText = ln; // not used directly, titles come from links
      const streaming = undefined;
      const category = undefined;
      const engine = undefined;

      const linkCount = workLinks.length;
      for (let i = 0; i < linkCount; i++) {
        const variant = linkCount > 1 ? String.fromCharCode(97 + i) : undefined;
        const title = cleanTitle(workLinks[i].label);
        const rateUrl = normalizeUrl(workLinks[i].href);
        const key = rateUrl ?? `${indexText}-${variant ?? i}`;
        rows.set(key, {
          index: indexText,
          variant,
          detailDisabled: true, // until mapped to gameUrl later
          gameUrl: undefined,
          rateUrl: rateUrl,
          title,
          author,
          category,
          engine,
          streaming,
          iconUrl,
          forumLink,
        });
      }
    }
    return rows;
  }

  // Fallback: attempt DOM table parse from original HTML (rare)
  const useOriginal = await fileExists(JAM_HTML_ORIGINAL);
  const content = await fs.readFile(useOriginal ? JAM_HTML_ORIGINAL : JAM_HTML, "utf8");
  const $ = cheerio.load(content);
  $("table tbody tr").each((_, element) => {
    const cells = $(element).find("td");
    if (cells.length < 4) return; // winter columns are fewer
    const indexText = sanitizeWhitespace(cells.eq(0).text());
    if (!indexText) return;
    const iconUrl = normalizeUrl(cells.eq(1).find("img").attr("src"));
    const titleCell = cells.eq(2);
    const titleLinks = titleCell.find("a");
    let authorText = titleCell.text();
    titleLinks.each((_, a) => { const t = $(a).text(); if (t) authorText = authorText.replace(t, ""); });
    const author = sanitizeWhitespace(authorText) ?? "";
    const forumAnchor = cells.eq(3).find("a[href]").first();
    const forumLink = normalizeUrl(forumAnchor.attr("href"));

    const linkCount = titleLinks.length || 1;
    for (let i = 0; i < linkCount; i++) {
      const variant = linkCount > 1 ? String.fromCharCode(97 + i) : undefined;
      const link = titleLinks.eq(i);
      const href = normalizeUrl(link.attr("href"));
      const rateUrl = href && /\/jam\/.+\/rate\//i.test(href) ? href : undefined;
      const title = cleanTitle(link.text() || titleCell.text());
      const key = rateUrl ?? `${indexText}-${variant ?? i}`;
      rows.set(key, {
        index: indexText,
        variant,
        detailDisabled: !rateUrl,
        rateUrl,
        title,
        author,
        iconUrl,
        forumLink,
      });
    }
  });
  return rows;
}

async function parseEntriesData(): Promise<Map<string, JamGameEntry>> {
  if (!(await fileExists(ENTRIES_DATA_JSON))) return new Map();
  const raw = await fs.readFile(ENTRIES_DATA_JSON, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.jam_games)) return new Map();
  const map = new Map<string, JamGameEntry>();
  for (const item of parsed.jam_games) {
    const rateUrl = normalizeUrl(item.url, "https://itch.io");
    const gameUrl = normalizeUrl(item.game?.url);
    if (!rateUrl || !gameUrl) continue;
    const entry: JamGameEntry = {
      rateUrl,
      gameUrl,
      title: item.game?.title ?? "",
      author: item.game?.user?.name ?? item.game?.user?.url ?? "",
      cover: item.game?.cover,
      shortText: item.game?.short_text,
    };
    map.set(gameUrl, entry);
  }
  return map;
}

async function parseEntriesFromJamSubmissions(): Promise<{ byGame: Map<string, JamGameEntry>; byRate: Map<string, JamGameEntry> }> {
  // Prefer original HTML for DOM parsing
  const html = await fs.readFile((await fileExists(JAM_HTML_ORIGINAL)) ? JAM_HTML_ORIGINAL : JAM_HTML, "utf8");
  const $ = cheerio.load(html);
  const byGame = new Map<string, JamGameEntry>();
  const byRate = new Map<string, JamGameEntry>();
  $("#entries .game_grid_widget .game_cell").each((_, cell) => {
    const gameLink = $(cell).find(".game_title a").first();
    const href = normalizeUrl(gameLink.attr("href"));
    const title = gameLink.text().trim();
    const author = $(cell).find(".game_author a").first().text().trim();
    const cover = $(cell).find(".game_thumb img").first().attr("data-lazy_src") || $(cell).find(".game_thumb img").first().attr("src") || undefined;
    if (!href) return;
    if (/\/jam\/.+\/rate\//i.test(href)) {
      const rateUrl = href;
      const je: JamGameEntry = { rateUrl, gameUrl: "", title, author, cover };
      byRate.set(rateUrl, je);
    } else {
      const gameUrl = href;
      const je: JamGameEntry = { rateUrl: "", gameUrl, title, author, cover };
      byGame.set(gameUrl, je);
    }
  });
  return { byGame, byRate };
}

function sanitizeFileName(input: string) {
  return input.replace(/[^a-z0-9-_]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

async function fetchGameHtml(index: string, jamEntry: JamGameEntry) {
  await ensureDir(GAME_CACHE_DIR);
  const slugPart = sanitizeFileName(jamEntry.gameUrl);
  const filePath = path.join(GAME_CACHE_DIR, `${index}_${slugPart}.html`);
  if (await fileExists(filePath)) return fs.readFile(filePath, "utf8");
  const html = await runCurlText(jamEntry.gameUrl);
  await fs.writeFile(filePath, html, "utf8");
  return html;
}
async function fetchGameHtmlByUrl(index: string, url: string) {
  await ensureDir(GAME_CACHE_DIR);
  const slugPart = sanitizeFileName(url);
  const filePath = path.join(GAME_CACHE_DIR, `${index}_${slugPart}.html`);
  if (await fileExists(filePath)) return fs.readFile(filePath, "utf8");
  const html = await runCurlText(url);
  await fs.writeFile(filePath, html, "utf8");
  return html;
}

async function fetchRateHtml(index: string, rateUrl: string) {
  await ensureDir(RATE_CACHE_DIR);
  const slugPart = sanitizeFileName(rateUrl);
  const filePath = path.join(RATE_CACHE_DIR, `${index}_${slugPart}.html`);
  if (await fileExists(filePath)) return fs.readFile(filePath, "utf8");
  const html = await runCurlText(rateUrl);
  await fs.writeFile(filePath, html, "utf8");
  return html;
}

async function fetchRateHtmlDirect(index: string, rateUrl: string) {
  await ensureDir(RATE_CACHE_DIR);
  const slugPart = sanitizeFileName(rateUrl);
  const filePath = path.join(RATE_CACHE_DIR, `${index}_${slugPart}.original.html`);
  if (await fileExists(filePath)) return fs.readFile(filePath, "utf8");
  const html = await runCurlTextDirect(rateUrl);
  await fs.writeFile(filePath, html, "utf8");
  return html;
}

function htmlToPlainText(html: string) {
  const normalized = html.replace(/<br\s*\/?\s*>/gi, "\n");
  const text = cheerio.load(`<div>${normalized}</div>`, undefined, false)("div").text();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line, idx, arr) => line || (idx > 0 && arr[idx - 1] !== ""));
  return lines.join("\n").trim();
}

function extractDescription($: cheerio.CheerioAPI) {
  const container = $(".formatted_description").first();
  if (!container.length) return undefined;
  container.find("script,style").remove();
  const html = container.html();
  if (!html) return undefined;
  const text = htmlToPlainText(html);
  return text || undefined;
}

function extractHostName($: cheerio.CheerioAPI) {
  const hostText = $(".jam_host_header a").first().text().trim();
  if (hostText) return hostText;
  return undefined;
}

function extractCommentsFromRate($: cheerio.CheerioAPI, hostName?: string) {
  let authorComment: string | undefined;
  $("section.field_responses p").each((_, el) => {
    if (authorComment) return;
    const strong = $(el).find("strong").first();
    const label = strong.text().trim();
    if (!label) return;
    if (label.includes("作者コメント") || label.includes("作者\u30b3\u30e1\u30f3\u30c8")) {
      const raw = $(el).html() || "";
      const stripped = raw.replace(/<strong[\s\S]*?<\/strong>\s*(?:<br\s*\/?\s*>)?/i, "");
      authorComment = htmlToPlainText(stripped) || undefined;
    }
  });

  let hostComment: string | undefined;
  const expected = hostName?.toLowerCase();
  $(".community_post").each((_, el) => {
    const author = $(el).find(".post_header .post_author a").first().text().trim();
    if (!author) return;
    if (!expected || author.toLowerCase() === expected) {
      const bodyHtml = $(el).find(".post_content .post_body").first().html() || "";
      const text = htmlToPlainText(bodyHtml);
      if (text && !hostComment) hostComment = text;
    }
  });
  return { authorComment, hostComment } as const;
}

function parseRateReaderMarkdown(reader: string) {
  try {
    const marker = "Markdown Content:\n";
    const idx = reader.indexOf(marker);
    const content = (idx >= 0 ? reader.slice(idx + marker.length) : reader).replace(/\r\n?/g, "\n");
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pickLine = (label: string) => {
      const m = content.match(new RegExp(`${esc(`**${label}**`)}\\n+([^\\n]+)`, "i"));
      return m && m[1] ? m[1].trim() : undefined;
    };
    const pickBlock = (label: string) => {
      const m = content.match(new RegExp(`${esc(`**${label}**`)}\\n+([\\s\\S]*?)(?:\\n\\*\\*|\\nLeave a comment|\\nComments)`, "i"));
      if (m && m[1]) {
        const text = m[1].split("\n").map((l) => l.trim()).filter(Boolean).join("\n").trim();
        return text || undefined;
      }
      return undefined;
    };

    const gameUrl = (() => {
      const m = content.match(/\]\((https?:\/\/[\w.-]+\.itch\.io\/[\w\-\/.%]+)\)\s*\n\*\*/);
      if (m) return m[1];
      const m2 = content.match(/\((https?:\/\/[\w.-]+\.itch\.io\/[\w\-\/.%]+)\).*?(?:View game page|itch\.io page)/i);
      return m2 ? m2[1] : undefined;
    })();

    const hostComment = (() => {
      const cmIdx = content.indexOf("\nComments");
      const tail = cmIdx >= 0 ? content.slice(cmIdx) : content;
      const m = tail.match(/VIPRPGAD2023admin[\s\S]*?\n+([^\n]+)\n/);
      return m && m[1] ? m[1].trim() : undefined;
    })();

    const category = pickLine("ジャンル");
    const engine = pickLine("使用ツール");
    const streaming = pickLine("配信・動画化の可否") || pickLine("配信動画化の可否") || pickLine("配信/動画");
    const authorComment = pickBlock("作者コメント");

    return { category, engine, streaming, authorComment, hostComment, gameUrl } as const;
  } catch {
    return {} as { category?: string; engine?: string; streaming?: string; authorComment?: string; hostComment?: string; gameUrl?: string };
  }
}

function extractMetaFromRate($: cheerio.CheerioAPI) {
  // 从评分页正文中抽取元数据，兼容 Reader(**ラベル**) 与 原始【ラベル】样式
  const blocks: string[] = [];
  $(".formatted_description, .jam_submission_page, body").each((_, el) => {
    const html = (cheerio as any).load(el).root().html() || "";
    if (html) blocks.push(html);
  });
  const textPlain = htmlToPlainText(blocks.join("\n"));
  const textMd = $.root().text();
  const text = `${textMd}\n${textPlain}`;
  const pick = (re: RegExp) => {
    const m = text.match(re);
    return m && m[1] ? m[1].trim() : undefined;
  };
  const category = pick(/【ジャンル】\s*([^\n【]+)/) || pick(/\*\*ジャンル\*\*[\r\n]+([^\r\n]+)/);
  const engine = pick(/【使用ツール】\s*([^\n【]+)/) || pick(/\*\*使用ツール\*\*[\r\n]+([^\r\n]+)/);
  const streaming = pick(/【(?:配信[\/／]?投稿|配信[・・\/／]?動画化の可否|配信\/動画)】\s*([^\n【]+)/) || pick(/\*\*(?:配信[・・\/／]?動画化の可否|配信\/動画)\*\*[\r\n]+([^\r\n]+)/);
  return { category, engine, streaming } as const;
}

function deriveGameUrlFromRate($: cheerio.CheerioAPI, base = "https://itch.io") {
  let gameUrl: string | undefined;
  $("*:contains('Play game')").each((_, el) => {
    if (gameUrl) return;
    const block = $(el).closest("div, section, aside");
    const link = block.find("a[href]").filter((_, a) => /https?:\/\//.test($(a).attr("href") || "")).first();
    const href = normalizeUrl(link.attr("href"), base);
    if (href && /https?:\/\/.+\.itch\.io\//i.test(href)) gameUrl = href;
  });
  if (gameUrl) return gameUrl;
  $("a[href]").each((_, a) => {
    if (gameUrl) return;
    const href = normalizeUrl($(a).attr("href"), base);
    if (!href) return;
    if (/\/jam\//i.test(href)) return;
    if (/https?:\/\/.+\.itch\.io\//i.test(href)) gameUrl = href;
  });
  if (gameUrl) return gameUrl;
  // Reader 文本回退：直接从文本中匹配 *.itch.io 链接
  const text = $.root().text();
  const m = text.match(/https?:\/\/[\w.-]+\.itch\.io\/[\w\-\/.%]+/i);
  if (m) return m[0];
  return gameUrl;
}

function collectScreenshotCandidates($: cheerio.CheerioAPI, jamEntry: JamGameEntry) {
  type Group = { id: string; order: number; urls: string[] };
  const groups: Group[] = [];
  let orderSeq = 0;

  $(".screenshot_list a").each((_, a) => {
    const img = $(a).find("img").first();
    const id = img.attr("data-screenshot_id") || img.attr("id") || `${orderSeq}`;
    const href = $(a).attr("href") || $(a).attr("data-image_lightbox");
    const urls: string[] = [];
    if (href) urls.push(href);
    const src = img.attr("src");
    if (src) urls.push(src);
    groups.push({ id, order: orderSeq++, urls });
  });

  if (groups.length === 0) {
    $(".screenshot_list img[src]").each((_, el) => {
      const id = $(el).attr("data-screenshot_id") || $(el).attr("id") || `${orderSeq}`;
      const urls: string[] = [];
      const srcset = $(el).attr("srcset");
      if (srcset) {
        const parsed = srcset.split(",").map((part) => part.trim().split(/\s+/)[0]).filter(Boolean);
        if (parsed.length) urls.push(parsed[parsed.length - 1]);
      }
      const src = $(el).attr("src");
      if (src) urls.push(src);
      groups.push({ id, order: orderSeq++, urls });
    });
  }

  // Fallback strictly from the current game page: try og:image or prominent imgs
  if (groups.length === 0) {
    const og = $('meta[property="og:image"]').attr('content');
    if (og) {
      const ogOriginal = og.replace(/\/\d+x\d+(?:%23c)?\//i, "/original/");
      groups.push({ id: "og", order: orderSeq++, urls: [ogOriginal, og] });
    }
  }
  if (groups.length === 0) {
    const candidates: string[] = [];
    $(".game_header img, .image_grid img, .screenshot_grid img, .formatted_description img, img[data-lazy_src], img[src]").each((_, el) => {
      const lazy = $(el).attr("data-lazy_src");
      const src = $(el).attr("src");
      const link = lazy || src;
      if (link && /https?:\/\//i.test(link)) candidates.push(link);
    });
    if (candidates.length) {
      const norm = Array.from(new Set(candidates.map((u) => u.replace(/\/\d+x\d+(?:%23c)?\//i, "/original/"))));
      groups.push({ id: "fallback", order: orderSeq++, urls: norm });
    }
  }

  const normalized: ScreenshotGroup[] = groups.map((g) => ({
    order: g.order,
    urls: Array.from(new Set(g.urls.map((u) => normalizeUrl(u)).filter((u): u is string => Boolean(u)))),
  }));
  return normalized;
}

function collectScreenshotCandidatesFromReaderMarkdown(reader: string) {
  type Group = { order: number; urls: string[] };
  const marker = "Markdown Content:\n";
  const idx = reader.indexOf(marker);
  const content = (idx >= 0 ? reader.slice(idx + marker.length) : reader).replace(/\r\n?/g, "\n");
  const urls = Array.from(new Set((content.match(/https?:\/\/img\.itch\.zone\/[\w\-\/\.=:%\?]+/g) || []).map((u) => u.replace(/\/\d+x\d+(?:%23c)?\//i, "/original/"))));
  const groups: ScreenshotGroup[] = urls.map((u, i) => ({ order: i, urls: [u] }));
  return groups;
}

function extractDownloadSources(table: TableEntry, $: cheerio.CheerioAPI, gameUrl: string) {
  const sources = new Set<string>();
  if (table.downloadLink) sources.add(table.downloadLink);
  if (gameUrl) sources.add(gameUrl);
  const scriptText = $("script").map((_, el) => $(el).html() ?? "").get().join("\n");
  const match = scriptText.match(/\"generate_download_url\":\"([^\"]+)\"/);
  if (match) { sources.add(match[1].replace(/\\\//g, "/")); }
  return Array.from(sources);
}

async function processEntry(table: TableEntry, jamEntry: JamGameEntry) {
  const displayNo = table.index;
  const baseIndex = displayNo.padStart(2, "0");
  const variant = (table as any).variant ? String((table as any).variant) : "";
  const fileIndex = variant ? `${baseIndex}${variant}` : baseIndex;
  // 先抓评分页，抽取字段与真实 gameUrl
  const rateUrl = table.rateUrl || jamEntry.rateUrl;
  if (!rateUrl) throw new Error("No page URL available");
  const rateHtml = await fetchRateHtml(fileIndex, rateUrl);
  const readerParsed = parseRateReaderMarkdown(rateHtml);
  let $rate = cheerio.load(rateHtml);
  // 若 Reader 版未能解析出 gameUrl，再回退直连 HTML
  let resolvedGameUrl = readerParsed.gameUrl || deriveGameUrlFromRate($rate) || jamEntry.gameUrl;
  if (!resolvedGameUrl) {
    try {
      const rateHtmlDirect = await fetchRateHtmlDirect(fileIndex, rateUrl);
      const $rateDirect = cheerio.load(rateHtmlDirect);
      const direct = deriveGameUrlFromRate($rateDirect);
      if (direct) {
        resolvedGameUrl = direct;
        $rate = $rateDirect; // 元数据从直连页取更稳
      }
    } catch {}
  }
  const baseMeta = extractMetaFromRate($rate);
  const meta = {
    category: readerParsed.category ?? baseMeta.category,
    engine: readerParsed.engine ?? baseMeta.engine,
    streaming: readerParsed.streaming ?? baseMeta.streaming,
  } as { category?: string; engine?: string; streaming?: string };
  const baseComments = extractCommentsFromRate($rate, "VIPRPGAD2023admin");
  const authorComment = readerParsed.authorComment ?? baseComments.authorComment;
  const hostComment = readerParsed.hostComment ?? baseComments.hostComment;

  // 再抓真实游戏页，用于截图与兜底描述
  let description: string | undefined;
  let screenshotCandidates: ScreenshotGroup[] | string[] = [];
  if (resolvedGameUrl) {
    const gameHtml = await fetchGameHtmlByUrl(fileIndex, resolvedGameUrl);
    const $game = cheerio.load(gameHtml);
    description = extractDescription($game);
    screenshotCandidates = collectScreenshotCandidates($game, jamEntry);
    if (!screenshotCandidates.length) {
      screenshotCandidates = collectScreenshotCandidatesFromReaderMarkdown(gameHtml);
    }
  }
  const screenshotResult = await ensureScreenshots(fileIndex, screenshotCandidates);
  const iconPath = await ensureIcon(fileIndex, table.iconUrl);

  const work: WorkEntry = {
    id: `${FESTIVAL_ID}-work-${fileIndex}`,
    festivalId: FESTIVAL_ID,
    no: displayNo,
    title: table.title || jamEntry.title,
    category: meta.category ?? table.category,
    engine: meta.engine ?? table.engine,
    author: table.author || jamEntry.author,
    streaming: meta.streaming ?? table.streaming,
    forum: table.forumLink,
    authorComment: authorComment ?? description ?? jamEntry.shortText ?? undefined,
    hostComment: hostComment ?? undefined,
    detailDisabled: resolvedGameUrl ? undefined : true,
  };

  if (iconPath) work.icon = iconPath;
  if (screenshotResult.paths.length > 0) work.ss = screenshotResult.paths;

  const noteParts: string[] = [];
  if (screenshotResult.failures.length > 0) noteParts.push(`screenshot failures: ${screenshotResult.failures.length}`);
  const skippedSmall = screenshotResult.skipped.filter((item) => item.reason === "small").length;
  if (skippedSmall > 0) noteParts.push(`skipped small images: ${skippedSmall}`);
  const skippedDup = screenshotResult.skipped.filter((item) => item.reason === "duplicate").length;
  if (skippedDup > 0) noteParts.push(`skipped duplicates: ${skippedDup}`);

  const snapshot: SnapshotRecord = {
    index: displayNo,
    status: "ok",
    title: work.title,
    icon: work.icon,
    note: noteParts.length ? noteParts.join("; ") : undefined,
    downloadSource: extractDownloadSources(table, $rate, resolvedGameUrl || rateUrl),
    screenshotReport: {
      saved: screenshotResult.paths.length,
      skipped: screenshotResult.skipped.length ? screenshotResult.skipped : undefined,
      failures: screenshotResult.failures.length ? screenshotResult.failures : undefined,
    },
  };
  return { work, snapshot };
}

async function processEntryTableOnly(table: TableEntry) {
  const displayNo = table.index;
  const baseIndex = displayNo.padStart(2, "0");
  const variant = (table as any).variant ? String((table as any).variant) : "";
  const fileIndex = variant ? `${baseIndex}${variant}` : baseIndex;
  // 从 rate 提取尽可能多的元信息与截图
  let meta: { category?: string; engine?: string; streaming?: string } = {};
  let authorComment: string | undefined;
  let hostComment: string | undefined;
  let screenshotCandidates: ScreenshotGroup[] | string[] = [];
  if (table.rateUrl) {
    const rateHtml = await fetchRateHtml(fileIndex, table.rateUrl);
    const $rate = cheerio.load(rateHtml);
    meta = extractMetaFromRate($rate);
    const c = extractCommentsFromRate($rate, "VIPRPGAD2023admin");
    authorComment = c.authorComment;
    hostComment = c.hostComment;
    const u = deriveGameUrlFromRate($rate);
    if (u) {
      const gameHtml = await fetchGameHtmlByUrl(fileIndex, u);
      const $game = cheerio.load(gameHtml);
      if (!authorComment) authorComment = extractDescription($game);
      screenshotCandidates = collectScreenshotCandidates($game, { rateUrl: "", gameUrl: u, title: table.title, author: table.author });
      if (!screenshotCandidates.length) {
        screenshotCandidates = collectScreenshotCandidatesFromReaderMarkdown(gameHtml);
      }
    }
  }
  const ss = await ensureScreenshots(fileIndex, screenshotCandidates);
  const iconPath = await ensureIcon(fileIndex, table.iconUrl);
  const work: WorkEntry = {
    id: `${FESTIVAL_ID}-work-${fileIndex}`,
    festivalId: FESTIVAL_ID,
    no: displayNo,
    title: table.title,
    category: meta.category ?? table.category,
    engine: meta.engine ?? table.engine,
    author: table.author,
    streaming: meta.streaming ?? table.streaming,
    forum: table.forumLink,
    authorComment: authorComment,
    hostComment: hostComment,
    ss: ss.paths.length ? ss.paths : undefined,
    detailDisabled: ss.paths.length ? undefined : true,
  };
  if (iconPath) work.icon = iconPath;
  const snapshot: SnapshotRecord = {
    index: displayNo,
    status: "ok",
    title: work.title,
    icon: work.icon,
    note: ss.paths.length ? undefined : "detail disabled: no game url",
    downloadSource: table.downloadLink ? [table.downloadLink] : undefined,
    screenshotReport: { saved: ss.paths.length, failures: ss.failures.length ? ss.failures : undefined, skipped: ss.skipped.length ? ss.skipped : undefined },
  };
  return { work, snapshot };
}

async function main() {
  await ensureDir(BANNERS_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);
  await ensureDir(GAME_CACHE_DIR);
  await ensureJamCaches();

  const bannerLocal = await ensureBanner();

  const [tableMap, jamJsonMap, jamGridDual] = await Promise.all([
    parseTable(),
    parseEntriesData(),
    parseEntriesFromJamSubmissions(),
  ]);

  const jamMap = new Map<string, JamGameEntry>([...jamJsonMap, ...jamGridDual.byGame]);
  const jamByRate = new Map<string, JamGameEntry>();
  for (const entry of jamJsonMap.values()) { if (entry.rateUrl) jamByRate.set(entry.rateUrl, entry); }
  for (const entry of jamGridDual.byRate.values()) { if (entry.rateUrl) jamByRate.set(entry.rateUrl, entry); }

  const jamByTitle = new Map<string, JamGameEntry>();
  for (const entry of jamMap.values()) {
    jamByTitle.set(normalizeKey(entry.title, entry.author), entry);
    jamByTitle.set(normalizeKey(entry.title, undefined), entry);
  }

  for (const row of tableMap.values()) {
    if (!row.gameUrl) {
      if (row.rateUrl) {
        const byRate = jamByRate.get(row.rateUrl);
        if (byRate) { (row as any).gameUrl = byRate.gameUrl; (row as any).detailDisabled = false; continue; }
      }
      const candidate = jamByTitle.get(normalizeKey(row.title, row.author)) || jamByTitle.get(normalizeKey(row.title, undefined));
      if (candidate) { (row as any).gameUrl = candidate.gameUrl; (row as any).detailDisabled = false; }
    }
  }

  const works: WorkEntry[] = [];
  const snapshots: SnapshotRecord[] = [];
  const missingTable: SnapshotRecord[] = [];

  for (const tableEntry of tableMap.values()) {
    const jamEntry = tableEntry.gameUrl ? jamMap.get(tableEntry.gameUrl) : (tableEntry.rateUrl ? jamByRate.get(tableEntry.rateUrl) : undefined);
    if (!jamEntry) {
      try {
        const { work, snapshot } = await processEntryTableOnly(tableEntry);
        works.push(work); snapshots.push(snapshot);
      } catch (error) {
        snapshots.push({
          index: tableEntry.index,
          status: "error",
          title: tableEntry.title,
          downloadSource: tableEntry.downloadLink ? [tableEntry.downloadLink] : undefined,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    if (jamEntry?.gameUrl) { jamMap.delete(jamEntry.gameUrl); }
    try {
      const { work, snapshot } = await processEntry(tableEntry, jamEntry);
      works.push(work); snapshots.push(snapshot);
    } catch (error) {
      const sources = [tableEntry.downloadLink, jamEntry.gameUrl].filter((v): v is string => Boolean(v));
      snapshots.push({
        index: tableEntry.index,
        status: "error",
        title: tableEntry.title,
        downloadSource: sources.length ? sources : undefined,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const jamEntry of jamMap.values()) {
    missingTable.push({ index: "?", status: "skipped", title: jamEntry.title, note: "present in submissions but not in overview table", downloadSource: [jamEntry.gameUrl] });
  }

  works.sort((a, b) => a.id.localeCompare(b.id));
  await fs.writeFile(OUTPUT_WORKS, `${JSON.stringify(works, null, 2)}\n`, "utf8");

  const summary = {
    festivalId: FESTIVAL_ID,
    generatedAt: new Date().toISOString(),
    banner: bannerLocal ? `${bannerLocal}` : undefined,
    stats: { captured: works.length, skipped: snapshots.filter((item) => item.status !== "ok").length },
    entries: snapshots,
    unmatched: missingTable,
  };
  await fs.writeFile(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(`Captured ${works.length} works. Skipped: ${summary.stats.skipped}.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
