import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { AnyNode } from "domhandler";

const execFileAsync = promisify(execFile);

const FESTIVAL_ID = "2016-summer-2";
const FESTIVAL_SLUG = "2016-summer-2";
const BASE_URL = "http://viprpgsummer2016.web.fc2.com/";
const INDEX_URL = new URL("index.html", BASE_URL).toString();
const CSS_URL = new URL("gw_style.css", BASE_URL).toString();
const BANNER_URL = new URL("URAsummer2016.png", BASE_URL).toString();

const OUTPUT_WORKS = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const CATCH_DIR = path.join(process.cwd(), "catch", FESTIVAL_SLUG);
const SOURCE_DIR = path.join(CATCH_DIR, "source");
const DETAIL_HTML_DIR = path.join(CATCH_DIR, "detail-html");
const SUMMARY_PATH = path.join(CATCH_DIR, `${FESTIVAL_SLUG}-scrape-summary.json`);

const PUBLIC_DIR = path.join(process.cwd(), "public");
const BANNERS_DIR = path.join(PUBLIC_DIR, "banners");
const ICONS_DIR = path.join(PUBLIC_DIR, "icons", FESTIVAL_SLUG);
const SCREENSHOTS_DIR = path.join(PUBLIC_DIR, "screenshots", FESTIVAL_SLUG);

const RELATIVE_ICONS_DIR = `/icons/${FESTIVAL_SLUG}`;
const RELATIVE_SCREENSHOTS_DIR = `/screenshots/${FESTIVAL_SLUG}`;

const CURL_BIN = process.platform === "win32" ? "curl.exe" : "curl";
const CURL_MAX_BUFFER = 20 * 1024 * 1024;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)" +
  " Chrome/130.0.0.0 Safari/537.36";

const GENRE_MAP: Record<string, string> = {
  genreACT: "アクション",
  genreARPG: "ARPG",
  genreDEFOKSG: "デフォksg",
  genredRPG: "RPG",
  genreERG: "erg",
  genreGAMU: "ガム",
  genreHOROR: "ホラー",
  genreHUSIGI: "不思議",
  genreIROIRO: "いろいろ",
  genrekACT: "アクション",
  genreKSG: "ksg",
  genreKSG2: "ksg",
  genreKSG3: "ksg",
  genreMIRUGE: "見るゲ",
  genreMIRUGEr15g: "見るゲ/R15G",
  genreMIRUKSG: "見るksg",
  genreMOS: "モス",
  genreNAZO: "謎",
  genreOKSG: "oksg",
  genrePUZZLE: "パズル",
  genreRPG: "RPG",
  genresACT: "アクション",
  genreSENRYAKU: "戦略",
  genreSHOWYOU: "しょうゆ",
  genreTANSAKU: "探索",
  genreTANSAKURPG: "探索RPG",
  genreTOOL: "ツール",
  genreUNKO: "うんこ",
  genreYARUGE: "やるゲ",
};

interface IndexEntry {
  no: string;
  title: string;
  author: string;
  category?: string;
  engine?: string;
  streaming?: string;
  detailUrl: string;
  iconUrl?: string;
  downloadUrl?: string;
  patchUrl?: string;
  forum?: string;
  isLate: boolean;
}

interface DetailInfo {
  screenshotUrls: string[];
  downloadUrls: string[];
  forum?: string;
  authorComment?: string;
  hostComment?: string;
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
  download?: {
    url: string;
  };
  forum?: string;
  authorComment?: string;
  hostComment?: string;
  icon?: string;
  ss?: string[];
}

interface SummaryEntry {
  index: string;
  status: "ok" | "error";
  title?: string;
  detailSource?: string;
  iconSource?: string;
  forum?: string;
  downloadSource?: string[];
  patchSource?: string;
  screenshotSources?: string[];
  icon?: string;
  screenshots?: string[];
  note?: string;
  error?: string;
}

interface SummaryFile {
  festivalId: string;
  generatedAt: string;
  banner?: string;
  bannerSource?: string;
  sourceFiles: {
    index: string;
    css: string;
  };
  stats: {
    captured: number;
    withDownload: number;
    withPatch: number;
    withScreenshots: number;
    errors: number;
  };
  entries: SummaryEntry[];
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function saveJson(filePath: string, value: unknown) {
  return fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sanitizeInline(value?: string | null) {
  if (!value) return undefined;
  const result = value.replace(/[\u00a0\u200b]/g, " ").replace(/\s+/g, " ").trim();
  return result || undefined;
}

function normalizeMultiline(value?: string | null) {
  if (!value) return undefined;
  const lines = value
    .replace(/\r/g, "")
    .replace(/[\u00a0\u200b]/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim());

  const normalizedLines: string[] = [];
  let lastWasBlank = true;

  for (const line of lines) {
    if (!line) {
      if (!lastWasBlank) {
        normalizedLines.push("");
        lastWasBlank = true;
      }
      continue;
    }

    normalizedLines.push(line);
    lastWasBlank = false;
  }

  while (normalizedLines[0] === "") {
    normalizedLines.shift();
  }
  while (normalizedLines[normalizedLines.length - 1] === "") {
    normalizedLines.pop();
  }

  const result = normalizedLines.join("\n").trim();
  return result || undefined;
}

function assetExtensionFromUrl(input: string, fallback = ".png") {
  const base = input.split(/[?#]/)[0];
  const ext = path.extname(base).toLowerCase();
  if (ext === ".jpeg") return ".jpg";
  return ext || fallback;
}

function parseCssContentMap(css: string, prefix: string) {
  const result = new Map<string, string>();
  const pattern = new RegExp(`\\.${prefix}(\\d+):before\\s*\\{content:\\s*"([^"]*)"\\s*\\}`, "g");

  for (const match of css.matchAll(pattern)) {
    const key = match[1].padStart(3, "0");
    const value = sanitizeInline(match[2]);
    if (value) {
      result.set(key, value);
    }
  }

  return result;
}

function mapGenreFilename(src?: string) {
  if (!src) return undefined;
  const fileName = path.basename(src, path.extname(src));
  return GENRE_MAP[fileName] ?? fileName.replace(/^genre/, "");
}

function extractPopupImages(element: cheerio.Cheerio<AnyNode>) {
  const values: string[] = [];

  for (const attribute of ["onmouseover", "onmouseout", "onclick"]) {
    const raw = element.attr(attribute) || element.attr(attribute.toLowerCase());
    if (!raw) continue;

    for (const match of raw.matchAll(/'([^']+\.(?:png|gif|jpg|jpeg))'/gi)) {
      values.push(new URL(match[1], BASE_URL).toString());
    }
  }

  return Array.from(new Set(values));
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
  return undefined;
}

async function curlBuffer(url: string) {
  const { stdout } = await execFileAsync(
    CURL_BIN,
    ["-L", "-f", "-sS", "--retry", "3", "--retry-delay", "1", "-A", USER_AGENT, url],
    {
      encoding: "buffer",
      maxBuffer: CURL_MAX_BUFFER,
    }
  );

  return stdout as Buffer;
}

async function fetchText(url: string) {
  const buffer = await curlBuffer(url);
  return iconv.decode(buffer, "shift_jis");
}

async function fetchBinary(url: string) {
  return curlBuffer(url);
}

async function saveTextFile(filePath: string, content: string) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf8");
}

function extractBlockText($: cheerio.CheerioAPI, block: cheerio.Cheerio<AnyNode>) {
  const clone = block.clone();

  clone.find("br").replaceWith("\n");
  clone.find("p").each((_, element) => {
    $(element).prepend("\n");
    $(element).append("\n");
  });
  clone.find("div").each((_, element) => {
    $(element).prepend("\n");
    $(element).append("\n");
  });

  return normalizeMultiline(clone.text());
}

function stripLabel(value: string | undefined, label: RegExp) {
  if (!value) return undefined;
  return value.replace(label, "").trim();
}

async function downloadIcon(no: string, sourceUrl?: string) {
  if (!sourceUrl) return undefined;
  const buffer = await fetchBinary(sourceUrl);
  await ensureDir(ICONS_DIR);
  const fileName = `${no}${assetExtensionFromUrl(sourceUrl, ".png")}`;
  const outputPath = path.join(ICONS_DIR, fileName);
  await fs.writeFile(outputPath, buffer);
  return path.posix.join(RELATIVE_ICONS_DIR, fileName);
}

async function downloadScreenshots(no: string, sources: string[]) {
  if (sources.length === 0) return [];

  await ensureDir(SCREENSHOTS_DIR);
  const saved: string[] = [];

  for (let index = 0; index < sources.length; index += 1) {
    const sourceUrl = sources[index];
    const buffer = await fetchBinary(sourceUrl);
    const dimensions = getImageDimensions(buffer);
    if (dimensions && dimensions.width < 100 && dimensions.height < 100) {
      continue;
    }

    const suffix = index === 0 ? "" : `-0${index + 1}`;
    const fileName = `${no}${suffix}${assetExtensionFromUrl(sourceUrl, ".png")}`;
    const outputPath = path.join(SCREENSHOTS_DIR, fileName);
    await fs.writeFile(outputPath, buffer);
    saved.push(path.posix.join(RELATIVE_SCREENSHOTS_DIR, fileName));
  }

  return saved;
}

async function saveBanner() {
  const buffer = await fetchBinary(BANNER_URL);
  await ensureDir(BANNERS_DIR);
  const outputPath = path.join(BANNERS_DIR, `${FESTIVAL_SLUG}.png`);
  await fs.writeFile(outputPath, buffer);
  return `/banners/${FESTIVAL_SLUG}.png`;
}

function parseIndexEntries(
  $: cheerio.CheerioAPI,
  authorMap: Map<string, string>,
  tkoolMap: Map<string, string>
) {
  const entries: IndexEntry[] = [];

  for (const row of $("table[summary='TIME TABLE'] tr").toArray()) {
    const cells = $(row).children("td");
    if (cells.length < 10) {
      continue;
    }

    const detailLink = cells.eq(3).find("a[href$='.html']").first();
    const detailHref = detailLink.attr("href");
    if (!detailHref) {
      continue;
    }

    const no = sanitizeInline(cells.eq(0).text())?.replace(/\D/g, "");
    if (!no) {
      continue;
    }

    const noPadded = no.padStart(3, "0");
    const title = sanitizeInline(cells.eq(3).text());
    const author = authorMap.get(noPadded) ?? "";
    const engine = tkoolMap.get(noPadded);
    const category = mapGenreFilename(cells.eq(2).find("img").first().attr("src") || undefined);
    const iconUrl = cells.eq(1).find("img").first().attr("src")
      ? new URL(cells.eq(1).find("img").first().attr("src")!, BASE_URL).toString()
      : undefined;
    const streaming = sanitizeInline(cells.eq(6).text());
    const downloadUrl = cells.eq(7).find("a[href]").first().attr("href") || undefined;
    const patchUrl = cells.eq(8).find("a[href]").first().attr("href") || undefined;
    const forum = cells.eq(9).find("a[href]").first().attr("href") || undefined;

    if (!title) {
      continue;
    }

    entries.push({
      no: noPadded,
      title,
      author,
      category,
      engine,
      streaming,
      detailUrl: new URL(detailHref, BASE_URL).toString(),
      iconUrl,
      downloadUrl,
      patchUrl,
      forum,
      isLate: $(row).attr("class") === "yellow",
    });
  }

  return entries;
}

async function parseDetail(detailUrl: string, no: string) {
  const html = await fetchText(detailUrl);
  await saveTextFile(path.join(DETAIL_HTML_DIR, `${no}.html`), html);

  const $ = cheerio.load(html);
  const root = $(".waku1").first();
  const screenshotImg = root.find("center img").first();
  const screenshotUrls = Array.from(
    new Set(
      [
        screenshotImg.attr("src") ? new URL(screenshotImg.attr("src")!, detailUrl).toString() : undefined,
        ...extractPopupImages(screenshotImg),
      ].filter((value): value is string => Boolean(value))
    )
  );

  let authorComment: string | undefined;
  let hostComment: string | undefined;
  const downloadUrls: string[] = [];
  let forum = root.find("iframe[src*='jbbs.shitaraba.net']").first().attr("src") || undefined;

  for (const blockElement of root.children(".waku2").toArray()) {
    const block = $(blockElement);
    const text = extractBlockText($, block);
    if (!text) continue;

    if (text.startsWith("最高にCOOLな作者コメント")) {
      authorComment = stripLabel(text, /^\s*最高にCOOLな作者コメント[:：]?\s*/);
    } else if (text.startsWith("管理人コメント")) {
      hostComment = stripLabel(text, /^\s*管理人コメント[:：]?\s*/);
    }

    for (const link of block.find("a[href*='download']").toArray()) {
      const href = $(link).attr("href");
      if (href) {
        downloadUrls.push(href);
      }
    }

    const iframeSrc = block.find("iframe[src*='jbbs.shitaraba.net']").attr("src");
    if (iframeSrc) {
      forum = iframeSrc;
    }
  }

  return {
    screenshotUrls,
    downloadUrls: Array.from(new Set(downloadUrls)),
    forum,
    authorComment,
    hostComment,
  } satisfies DetailInfo;
}

async function main() {
  await ensureDir(CATCH_DIR);
  await ensureDir(SOURCE_DIR);
  await ensureDir(DETAIL_HTML_DIR);

  const [indexHtml, cssText] = await Promise.all([fetchText(INDEX_URL), fetchText(CSS_URL)]);
  await saveTextFile(path.join(SOURCE_DIR, "index.html"), indexHtml);
  await saveTextFile(path.join(SOURCE_DIR, "gw_style.css"), cssText);

  const authorMap = parseCssContentMap(cssText, "author");
  const tkoolMap = parseCssContentMap(cssText, "tkool");
  const $ = cheerio.load(indexHtml);
  const entries = parseIndexEntries($, authorMap, tkoolMap);

  if (entries.length !== 58) {
    throw new Error(`Expected 58 entries, got ${entries.length}`);
  }

  const banner = await saveBanner();
  const works: WorkEntryOut[] = [];
  const summaryEntries: SummaryEntry[] = [];

  for (const entry of entries) {
    try {
      const detail = await parseDetail(entry.detailUrl, entry.no);
      const icon = await downloadIcon(entry.no, entry.iconUrl);
      const screenshots = await downloadScreenshots(entry.no, detail.screenshotUrls);
      const allDownloadSources = Array.from(new Set([entry.downloadUrl, ...detail.downloadUrls].filter(Boolean))) as string[];

      const work: WorkEntryOut = {
        id: `${FESTIVAL_ID}-work-${entry.no}`,
        festivalId: FESTIVAL_ID,
        no: entry.no,
        title: entry.title,
        author: entry.author || "(未記入)",
      };

      if (entry.category) work.category = entry.category;
      if (entry.engine) work.engine = entry.engine;
      if (entry.streaming) work.streaming = entry.streaming;
      if (allDownloadSources[0]) {
        work.download = {
          url: allDownloadSources[0],
        };
      }
      if (detail.forum || entry.forum) work.forum = detail.forum || entry.forum;
      if (detail.authorComment) work.authorComment = detail.authorComment;
      if (detail.hostComment) work.hostComment = detail.hostComment;
      if (icon) work.icon = icon;
      if (screenshots.length > 0) work.ss = screenshots;

      works.push(work);
      summaryEntries.push({
        index: entry.no,
        status: "ok",
        title: entry.title,
        detailSource: entry.detailUrl,
        iconSource: entry.iconUrl,
        forum: detail.forum || entry.forum,
        downloadSource: allDownloadSources,
        patchSource: entry.patchUrl,
        screenshotSources: detail.screenshotUrls,
        icon,
        screenshots,
        note: entry.isLate ? "Listed with the yellow late-entry row style on the index page." : undefined,
      });
    } catch (error) {
      summaryEntries.push({
        index: entry.no,
        status: "error",
        title: entry.title,
        detailSource: entry.detailUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const errors = summaryEntries.filter((entry) => entry.status === "error");
  if (errors.length > 0) {
    throw new Error(`Encountered ${errors.length} parse errors`);
  }

  const summary: SummaryFile = {
    festivalId: FESTIVAL_ID,
    generatedAt: new Date().toISOString(),
    banner,
    bannerSource: BANNER_URL,
    sourceFiles: {
      index: path.relative(process.cwd(), path.join(SOURCE_DIR, "index.html")).replace(/\\/g, "/"),
      css: path.relative(process.cwd(), path.join(SOURCE_DIR, "gw_style.css")).replace(/\\/g, "/"),
    },
    stats: {
      captured: works.length,
      withDownload: works.filter((entry) => Boolean(entry.download?.url)).length,
      withPatch: entries.filter((entry) => Boolean(entry.patchUrl)).length,
      withScreenshots: works.filter((entry) => Boolean(entry.ss?.length)).length,
      errors: 0,
    },
    entries: summaryEntries,
  };

  await saveJson(OUTPUT_WORKS, works);
  await saveJson(SUMMARY_PATH, summary);

  console.log(`Archived ${works.length} entries for ${FESTIVAL_ID}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
