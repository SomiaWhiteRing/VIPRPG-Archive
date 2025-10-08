import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { load, CheerioAPI, Element, Cheerio } from "cheerio";

const FESTIVAL_ID = "2023-summer";
const FESTIVAL_SLUG = "2023-summer";
const SOURCE_ROOT = path.join(process.cwd(), "[html]23夏24紅白GW", "[2023夏(wiki)]");
const INDEX_HTML = path.join(SOURCE_ROOT, "index.html");

const CATCH_DIR = path.join(process.cwd(), "catch", FESTIVAL_SLUG);
const OUTPUT_WORKS = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const SUMMARY_PATH = path.join(CATCH_DIR, `${FESTIVAL_SLUG}-scrape-summary.json`);

const PUBLIC_DIR = path.join(process.cwd(), "public");
const BANNERS_DIR = path.join(PUBLIC_DIR, "banners");
const ICONS_DIR = path.join(PUBLIC_DIR, "icons", FESTIVAL_SLUG);
const SCREENSHOTS_DIR = path.join(PUBLIC_DIR, "screenshots", FESTIVAL_SLUG);

const RELATIVE_BANNERS_DIR = "/banners";
const RELATIVE_ICONS_DIR = `/icons/${FESTIVAL_SLUG}`;
const RELATIVE_SCREENSHOTS_DIR = `/screenshots/${FESTIVAL_SLUG}`;

const MAX_SCREENSHOTS = 6;
const SMALL_IMAGE_LIMIT = 100;

interface IndexEntry {
  index: string;
  detailHref?: string;
  iconUrl?: string;
  screenshotUrl?: string;
  genreLines: string[];
  titleFromIndex?: string;
  authorFromIndex?: string;
}


interface DetailData {
  index: string;
  title: string;
  author: string;
  category?: string;
  engine?: string;
  streaming?: string;
  authorComment?: string;
  hostComment?: string;
  downloadSources: string[];
  forumUrl?: string;
  attachments: string[];
  screenshotSources: string[];
}

interface ScreenshotSkip {
  source: string;
  reason: "small" | "duplicate";
}

interface ScreenshotResult {
  paths: string[];
  skipped: ScreenshotSkip[];
  failures: string[];
}

interface SnapshotRecord {
  index: string;
  status: "ok" | "error";
  title?: string;
  icon?: string;
  note?: string;
  downloadSource?: string[];
  screenshotReport?: {
    saved: number;
    skipped?: ScreenshotSkip[];
    failures?: string[];
  };
  error?: string;
}

interface WorkEntry {
  id: string;
  festivalId: string;
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

function sanitizeWhitespace(value: string | undefined | null) {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed || undefined;
}

function sanitizeMultiline(value: string | undefined | null) {
  if (!value) return undefined;
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line, idx, arr) => line.length > 0 || (idx > 0 && arr[idx - 1].length === 0));
  const filtered = lines.filter((line, idx) => line.length > 0 || (idx > 0 && lines[idx - 1].length > 0));
  const result = filtered.join("\n").trim();
  return result || undefined;
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function emptyDir(dir: string) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await emptyDir(target);
          await fs.rmdir(target);
        } else {
          await fs.unlink(target);
        }
      })
    );
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
}

function isEngineLine(value: string) {
  const pattern = /(ツクール|RM|2000|2003|VX|VXAce|MV|MZ|SRPG|Unity|ウディタ|WOLF|ティラノ|S2003|S2000|S2K|GameMaker|Construct|SS2K|S2000)/i;
  return pattern.test(value);
}

function resolveLocalAsset(url: string | undefined) {
  if (!url) return undefined;
  try {
    const parsed = new URL(url, "https://dummy.example");
    const segments = parsed.pathname.split("/").filter(Boolean);
    const attachIndex = segments.indexOf("attach");
    if (attachIndex === -1) return undefined;
    const relative = segments.slice(attachIndex + 1);
    if (relative.length === 0) return undefined;
    return path.join(SOURCE_ROOT, "attach", ...relative);
  } catch {
    return undefined;
  }
}

async function collectLocalAttachmentUrls(pageId: string) {
  const baseDir = path.join(SOURCE_ROOT, "attach", pageId);
  const results: string[] = [];
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(baseDir, entry.name);
      const files = await fs.readdir(dirPath, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile()) continue;
        results.push(`https://img.atwiki.jp/viprpg23s/attach/${pageId}/${entry.name}/${file.name}`);
      }
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      console.warn(`Failed to list attachments for ${pageId}: ${err.message}`);
    }
  }
  return results;
}

function getImageExtension(input: string, fallback = ".png") {
  const base = input.split(/[?#]/)[0];
  const ext = path.extname(base).toLowerCase();
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

function readTextFile(filePath: string) {
  return fs.readFile(filePath, "utf8");
}

function normalizeIndex(value: string) {
  const num = parseInt(value, 10);
  if (Number.isNaN(num)) return value.trim();
  return String(num).padStart(2, "0");
}

function parseGenreLines(cell: Cheerio<Element>, $: CheerioAPI) {
  const parts: string[] = [];
  cell.contents().each((_, el) => {
    if (el.type === "text") {
      const text = (el.data ?? "").trim();
      if (text) parts.push(text);
    } else if (el.type === "tag" && el.name !== "br") {
      const text = $(el).text().trim();
      if (text) parts.push(text);
    }
  });
  return parts;
}

async function parseIndex(): Promise<IndexEntry[]> {
  const html = await readTextFile(INDEX_HTML);
  const $ = load(html);
  const table = $("div#atwiki_table_sample table").first();
  const rows = table.find("tr");
  const entries: IndexEntry[] = [];

  rows.each((rowIndex, rowElement) => {
    if (rowIndex === 0) return;
    const row = $(rowElement);
    const cells = row.find("td");
    if (cells.length < 7) return;

    const indexText = sanitizeWhitespace($(cells[0]).text());
    if (!indexText) return;
    const index = normalizeIndex(indexText);

    const titleCell = $(cells[3]).clone();
    titleCell.find("br").replaceWith("|||");
    const titlePieces = titleCell
      .text()
      .split("|||")
      .map((segment) => sanitizeWhitespace(segment))
      .filter((segment): segment is string => Boolean(segment));
    const rawHref = $(cells[3]).find("a").first().attr("href") ?? undefined;
    const detailHref = rawHref ? rawHref.replace(/^\.\//, "") : undefined;
    const iconUrl = $(cells[1]).find("img").first().attr("src") ?? undefined;
    const screenshotUrl = $(cells[2]).find("img").first().attr("src") ?? undefined;
    const genreLines = parseGenreLines($(cells[4]), $);
    const titleFromIndex = titlePieces[0];
    const authorFromIndex = titlePieces.length > 1 ? titlePieces[titlePieces.length - 1] : undefined;

    entries.push({ index, detailHref, iconUrl, screenshotUrl, genreLines, titleFromIndex, authorFromIndex });
  });

  return entries;
}

function findHeader($page: CheerioAPI, text: string) {
  return $page("h4").filter((_, el) => $page(el).text().includes(text)).first();
}

function parseMetaLine(text: string) {
  const normalized = text.replace(/\u3000/g, " ").replace(/／/g, "/");
  const parts = normalized.split("/").map((part) => part.trim()).filter(Boolean);
  let author: string | undefined;
  let genre: string | undefined;
  let tool: string | undefined;
  for (const part of parts) {
    if (part.startsWith("作者：")) {
      author = part.replace("作者：", "").trim();
    } else if (part.startsWith("ジャンル：")) {
      genre = part.replace("ジャンル：", "").trim();
    } else if (part.startsWith("使用ツール：")) {
      tool = part.replace("使用ツール：", "").trim();
    }
  }
  return { author, genre, tool };
}

function extractTitleParts(rawTitle: string) {
  const titleMatch = rawTitle.match(/^No\.\s*(\d+)\s*(.*)$/);
  let index = "";
  let title = rawTitle.trim();
  if (titleMatch) {
    index = normalizeIndex(titleMatch[1]);
    title = titleMatch[2].trim();
  }
  const suffixMatch = title.match(/^(.*?)\s*【(.+?)】$/);
  let suffix: string | undefined;
  if (suffixMatch) {
    title = suffixMatch[1].trim();
    suffix = suffixMatch[2].trim();
  }
  return { index, title, suffix };
}

function uniq<T>(items: T[]) {
  return Array.from(new Set(items));
}

function normalizeUrlList(urls: Array<string | undefined>) {
  return uniq(
    urls
      .map((url) => (url ?? "").trim())
      .filter((value) => value.length > 0)
  );
}

async function parseDetail(entry: IndexEntry): Promise<DetailData> {
  if (!entry.detailHref) {
    throw new Error("Missing detail link");
  }
  const detailPath = entry.detailHref.startsWith("pages/")
    ? path.join(SOURCE_ROOT, entry.detailHref)
    : path.join(SOURCE_ROOT, "pages", entry.detailHref);
  const html = await readTextFile(detailPath);
  const $page = load(html);
  const body = $page("#wikibody");
  if (!body.length) {
    throw new Error("Detail body not found");
  }

  const titleRaw = body.find("h2").first().text().trim();
  if (!titleRaw) {
    throw new Error("Title missing in detail");
  }
  const { index, title, suffix } = extractTitleParts(titleRaw);

  const metaHeader = body.find("h4").first();
  if (!metaHeader.length) {
    throw new Error("Metadata header missing");
  }
  const meta = parseMetaLine(metaHeader.text().trim());

  const streamingHeader = findHeader($page, "配信/動画");
  const streamingText = streamingHeader.length
    ? sanitizeWhitespace(streamingHeader.text().split("：").slice(1).join(":"))
    : undefined;

  const downloadHeader = findHeader($page, "DL");
  const forumHeader = findHeader($page, "感想");

  const downloadSources = normalizeUrlList([
    ...downloadHeader
      .find("a")
      .map((_, el) => $page(el).attr("href") ?? "")
      .get(),
    ...downloadHeader
      .nextUntil("h4")
      .find("a")
      .map((_, el) => $page(el).attr("href") ?? "")
      .get(),
  ]);

  const forumUrl = forumHeader.find("a").attr("href") ?? undefined;

  const commentElements = streamingHeader.length && downloadHeader.length
    ? streamingHeader.nextUntil(downloadHeader)
    : $page([]);
  const commentText = sanitizeMultiline(
    commentElements
      .map((_, el) => $page(el).text())
      .get()
      .join("\n")
  );

  const pageId = entry.detailHref
    .replace(/^\.\//, "")
    .replace(/^pages\//, "")
    .replace(/\.html$/, "");

  const attachLinks = body
    .find("div.attach a")
    .map((_, el) => $page(el).attr("href") ?? "")
    .get();

  const localAttachments = await collectLocalAttachmentUrls(pageId);
  const attachments = normalizeUrlList([...attachLinks, ...localAttachments]);

  const detailIndex = index || entry.index;

  const category = sanitizeWhitespace(meta.genre);
  let engine: string | undefined = sanitizeWhitespace(meta.tool);

  if (!engine && suffix && isEngineLine(suffix)) {
    engine = suffix;
  }

  return {
    index: detailIndex,
    title,
    author: sanitizeWhitespace(meta.author) ?? sanitizeWhitespace(entry.authorFromIndex) ?? "不明",
    category,
    engine,
    streaming: sanitizeWhitespace(streamingText),
    authorComment: commentText,
    hostComment: undefined,
    downloadSources,
    forumUrl,
    attachments,
    screenshotSources: attachments,
  };
}

async function readLocalImage(url: string) {
  const localPath = resolveLocalAsset(url);
  if (!localPath) {
    throw new Error(`Unable to resolve asset for ${url}`);
  }
  const buffer = await fs.readFile(localPath);
  return { localPath, buffer };
}

async function pickIconSource(primary: string | undefined, attachments: string[]) {
  const candidates = normalizeUrlList([primary, ...attachments]).filter(Boolean);
  for (const source of candidates) {
    try {
      const { buffer } = await readLocalImage(source);
      const dims = getImageDimensions(buffer);
      if (dims && dims.width <= SMALL_IMAGE_LIMIT && dims.height <= SMALL_IMAGE_LIMIT) {
        return { source, buffer };
      }
    } catch (error) {
      console.warn(`Icon probe failed for ${source} =>`, error);
    }
  }
  for (const source of candidates) {
    try {
      const { buffer } = await readLocalImage(source);
      return { source, buffer };
    } catch (error) {
      console.warn(`Icon fallback probe failed for ${source} =>`, error);
    }
  }
  return undefined;
}

async function copyIcon(index: string, primaryUrl: string | undefined, attachments: string[]) {
  const picked = await pickIconSource(primaryUrl, attachments);
  if (!picked) return undefined;
  try {
    const extension = getImageExtension(picked.source, ".png");
    const destFile = `${index}${extension}`;
    const destPath = path.join(ICONS_DIR, destFile);
    await fs.writeFile(destPath, picked.buffer);
    return `${RELATIVE_ICONS_DIR}/${destFile}`;
  } catch (error) {
    console.warn(`Icon copy failed for ${index}: ${picked.source} =>`, error);
    return undefined;
  }
}

function isImageSource(source: string) {
  const base = source.split(/[?#]/)[0].toLowerCase();
  return /(\.png|\.jpg|\.jpeg|\.gif|\.bmp)$/.test(base);
}

async function copyScreenshots(index: string, urls: string[]) {
  const uniqueSources = normalizeUrlList(urls).filter(isImageSource);
  const seenHashes = new Set<string>();
  const candidates: Array<{ buffer: Buffer; extension: string; source: string; dims?: { width: number; height: number } }> = [];
  const skipped: ScreenshotSkip[] = [];
  const failures: string[] = [];

  for (const source of uniqueSources) {
    if (!source) continue;
    try {
      const { buffer } = await readLocalImage(source);
      const dims = getImageDimensions(buffer);
      if (dims && dims.width < SMALL_IMAGE_LIMIT && dims.height < SMALL_IMAGE_LIMIT) {
        skipped.push({ source, reason: "small" });
        continue;
      }
      const hash = createHash("md5").update(buffer).digest("hex");
      if (seenHashes.has(hash)) {
        skipped.push({ source, reason: "duplicate" });
        continue;
      }
      seenHashes.add(hash);
      const extension = getImageExtension(source, ".png");
      candidates.push({ buffer, extension, source, dims });
    } catch (error) {
      console.warn(`Screenshot copy failed for ${index}: ${source} =>`, error);
      failures.push(source);
    }
  }

  if (candidates.length === 0) {
    return { paths: [], skipped, failures } satisfies ScreenshotResult;
  }

  const usable = candidates.slice(0, MAX_SCREENSHOTS);
  const paths: string[] = [];
  for (let i = 0; i < usable.length; i += 1) {
    const candidate = usable[i];
    const suffix = i === 0 ? "" : `-${String(i + 1).padStart(2, "0")}`;
    const destFile = `${index}${suffix}${candidate.extension}`;
    const destPath = path.join(SCREENSHOTS_DIR, destFile);
    await fs.writeFile(destPath, candidate.buffer);
    paths.push(`${RELATIVE_SCREENSHOTS_DIR}/${destFile}`);
  }

  return { paths, skipped, failures } satisfies ScreenshotResult;
}

async function findBannerFile() {
  const attachRoot = path.join(SOURCE_ROOT, "attach");
  const stack = [attachRoot];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (/banner/i.test(entry.name)) {
        return fullPath;
      }
    }
  }
  return undefined;
}

async function copyBanner() {
  try {
    const bannerFile = await findBannerFile();
    if (!bannerFile) {
      console.warn("Banner not found");
      return undefined;
    }
    const buffer = await fs.readFile(bannerFile);
    const extension = path.extname(bannerFile) || ".png";
    const destPath = path.join(BANNERS_DIR, `${FESTIVAL_SLUG}${extension}`);
    await fs.writeFile(destPath, buffer);
    return `${RELATIVE_BANNERS_DIR}/${FESTIVAL_SLUG}${extension}`;
  } catch (error) {
    console.warn("Failed to copy banner", error);
    return undefined;
  }
}

function buildCategoryAndEngine(entry: IndexEntry, detail: DetailData) {
  const lines = entry.genreLines.slice();
  let engine = detail.engine;
  let category = detail.category;

  if (lines.length > 0) {
    const maybeEngine = lines[lines.length - 1];
    if (isEngineLine(maybeEngine)) {
      if (!engine) {
        engine = maybeEngine;
      }
      lines.pop();
    }
    if (lines.length > 0) {
      category = lines.join(" / ");
    }
  }

  return { category: sanitizeWhitespace(category), engine: sanitizeWhitespace(engine) };
}

async function main() {
  await ensureDir(CATCH_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);
  await ensureDir(BANNERS_DIR);

  await emptyDir(ICONS_DIR);
  await emptyDir(SCREENSHOTS_DIR);

  const banner = await copyBanner();

  const entries = await parseIndex();
  const works: WorkEntry[] = [];
  const snapshots: SnapshotRecord[] = [];

  for (const entry of entries) {
    try {
      const detail = await parseDetail(entry);
      const { category, engine } = buildCategoryAndEngine(entry, detail);
      const iconPath = await copyIcon(entry.index, entry.iconUrl, detail.attachments);

      const screenshotSources = detail.screenshotSources.length
        ? detail.screenshotSources
        : entry.screenshotUrl
        ? [entry.screenshotUrl]
        : [];
      const screenshotResult = await copyScreenshots(entry.index, screenshotSources);

      const work: WorkEntry = {
        id: `${FESTIVAL_ID}-work-${entry.index}`,
        festivalId: FESTIVAL_ID,
        title: detail.title,
        author: detail.author,
        category,
        engine,
        streaming: detail.streaming,
        forum: detail.forumUrl,
        authorComment: detail.authorComment,
        hostComment: detail.hostComment,
      };

      if (iconPath) {
        work.icon = iconPath;
      }
      if (screenshotResult.paths.length > 0) {
        work.ss = screenshotResult.paths;
      }

      works.push(work);

      const noteParts: string[] = [];
      if (detail.downloadSources.length === 0) {
        noteParts.push("ダウンロード: 未提供");
      } else {
        noteParts.push(`ダウンロード: ${detail.downloadSources.length}件`);
      }
      if (screenshotResult.skipped.length > 0) {
        const small = screenshotResult.skipped.filter((item) => item.reason === "small").length;
        const dup = screenshotResult.skipped.filter((item) => item.reason === "duplicate").length;
        if (small > 0) noteParts.push(`skipped small: ${small}`);
        if (dup > 0) noteParts.push(`skipped dup: ${dup}`);
      }
      if (screenshotResult.failures.length > 0) {
        noteParts.push(`screenshot failures: ${screenshotResult.failures.length}`);
      }

      snapshots.push({
        index: entry.index,
        status: "ok",
        title: work.title,
        icon: work.icon,
        note: noteParts.length ? noteParts.join("; ") : undefined,
        downloadSource: detail.downloadSources.length ? detail.downloadSources : undefined,
        screenshotReport: {
          saved: screenshotResult.paths.length,
          skipped: screenshotResult.skipped.length ? screenshotResult.skipped : undefined,
          failures: screenshotResult.failures.length ? screenshotResult.failures : undefined,
        },
      });
    } catch (error) {
      console.error(`Failed to process entry ${entry.index}:`, error);
      snapshots.push({
        index: entry.index,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  works.sort((a, b) => a.id.localeCompare(b.id));
  await fs.writeFile(OUTPUT_WORKS, `${JSON.stringify(works, null, 2)}\n`, "utf8");

  const summary = {
    festivalId: FESTIVAL_ID,
    generatedAt: new Date().toISOString(),
    banner: banner ?? undefined,
    stats: {
      captured: works.length,
      skipped: snapshots.filter((item) => item.status !== "ok").length,
    },
    entries: snapshots,
    unmatched: [],
  };

  await fs.writeFile(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(`Captured ${works.length} works. Errors: ${summary.stats.skipped}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
