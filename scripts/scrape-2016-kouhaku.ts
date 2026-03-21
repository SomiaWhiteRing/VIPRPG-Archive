import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import { Agent, setGlobalDispatcher } from "undici";

const FESTIVAL_ID = "2016-kouhaku";
const FESTIVAL_SLUG = "2016-kouhaku";
const BASE_URL = "https://viprpgkohaku2016.wixsite.com/kohaku2016";
const SEED_PAGE_URL = `${BASE_URL}/0-40`;
const LIST_PAGE_SEOS = ["0-40", "40-70"];

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

const MAX_SCREENSHOTS = 6;
const SMALL_IMAGE_LIMIT = 100;
const CURL_BIN = process.platform === "win32" ? "curl.exe" : "curl";
const CURL_MAX_BUFFER = 50 * 1024 * 1024;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)" +
  " Chrome/130.0.0.0 Safari/537.36";

const LOCAL_SEED_CANDIDATES = [
  path.join(process.cwd(), "tmp_2016_kouhaku_0_40.html"),
  path.join(process.cwd(), "catch", "2016-kouhaku", "source", "0-40.html"),
];

const LOCAL_MASTER_PAGE_JSON_CANDIDATES = [
  path.join(process.cwd(), "tmp_2016_kouhaku_master_page.json"),
];

const LOCAL_LIST_PAGE_JSON_CANDIDATES: Record<string, string[]> = {
  "0-40": [path.join(process.cwd(), "tmp_2016_kouhaku_0_40_page.json")],
  "40-70": [path.join(process.cwd(), "tmp_2016_kouhaku_40_70_page.json")],
};

const LOCAL_SHARED_HTML_CANDIDATES = [
  path.join(process.cwd(), "catch", "2016-kouhaku-7d12dc_8e42c46cdbc9ffc84f754b935b5577e3.html"),
];

const LOCAL_LIST_BLOCK_CANDIDATES: Record<string, string[]> = {
  "0-40": [path.join(process.cwd(), "catch", "2016-kouhaku-7d12dc_d02d92b9396b30295ed2650fe85dbbeb.html")],
  "40-70": [],
};

setGlobalDispatcher(
  new Agent({
    connect: {
      timeout: 30000,
    },
    headersTimeout: 30000,
    bodyTimeout: 30000,
  })
);

type JsonObject = Record<string, unknown>;

interface RouterPage {
  pageId: string;
  title: string;
  pageUriSEO: string;
  pageJsonFileName: string;
}

interface ViewerModel {
  site: {
    siteId: string;
    metaSiteId: string;
    siteRevision: number;
    externalBaseUrl: string;
  };
  siteFeaturesConfigs: {
    router: {
      pagesMap: Record<string, RouterPage>;
    };
  };
  siteAssets: {
    siteScopeParams: {
      pageJsonFileNames: Record<string, string>;
    };
  };
}

interface SharedDownloadSource {
  label: string;
  url: string;
}

interface DateInfo {
  registered?: string;
  submitted?: string;
  updated?: string;
}

interface ListEntry {
  index: string;
  no: string;
  pageSeo: string;
  detailUrl?: string;
  title: string;
  author?: string;
  genre?: string;
  engine?: string;
  streaming?: string;
  forum?: string;
  downloadSources: string[];
  dates?: DateInfo;
  iconUrl?: string;
  previewScreenshotUrl?: string;
}

interface DetailInfo {
  author?: string;
  genre?: string;
  engine?: string;
  streaming?: string;
  forum?: string;
  downloadSources: string[];
  dates?: DateInfo;
  authorComment?: string;
  hostComment?: string;
}

interface PageAssets {
  iconUrl?: string;
  screenshotUrls: string[];
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
  detailDisabled?: boolean;
}

interface ScreenshotSkip {
  source: string;
  reason: "small" | "duplicate";
}

interface DownloadResult {
  paths: string[];
  skipped: ScreenshotSkip[];
  failures: string[];
}

interface SummaryEntry {
  index: string;
  status: "ok" | "error";
  title?: string;
  pageSeo?: string;
  pageJsonSource?: string;
  detailSource?: string;
  icon?: string;
  iconSource?: string;
  forum?: string;
  dates?: DateInfo;
  downloadSource?: string[];
  screenshotSources?: string[];
  screenshotReport?: {
    saved: number;
    skipped?: ScreenshotSkip[];
    failures?: string[];
  };
  note?: string;
  error?: string;
}

interface SummaryFile {
  festivalId: string;
  generatedAt: string;
  banner?: string;
  bannerSource?: string;
  sharedDownloadSources: SharedDownloadSource[];
  stats: {
    captured: number;
    errors: number;
    detailDisabled: number;
  };
  entries: SummaryEntry[];
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readFirstExisting(paths: string[]) {
  for (const filePath of paths) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return undefined;
}

async function readJsonIfExists<T>(filePath: string) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function fetchTextWithCache(url: string, savePath: string, extraCandidates: string[] = []) {
  const cached = await readFirstExisting([savePath, ...extraCandidates]);
  if (cached !== undefined) {
    return cached;
  }

  const text = await fetchText(url);
  await saveTextFile(savePath, text);
  return text;
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function sanitizeWhitespace(value?: string | null) {
  if (!value) return undefined;
  const result = value.replace(/\s+/g, " ").trim();
  return result || undefined;
}

function normalizeTextBlock(value?: string | null) {
  if (!value) return undefined;
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function stripLabelText(value: string | undefined, labels: string[]) {
  if (!value) return undefined;
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`^(?:【)?(?:${escaped})(?:】)?[\\s　:：/／]*`, "i");
  const result = value.replace(pattern, "").trim();
  return result || undefined;
}

function assetExtensionFromUrl(input: string, fallback = ".png") {
  const clean = input.split(/[?#]/)[0];
  const ext = path.extname(clean).toLowerCase();
  if (ext === ".jpeg") return ".jpg";
  return ext || fallback;
}

function looksLikeImageBuffer(buffer: Buffer, contentType: string) {
  if (contentType.startsWith("image/")) return true;
  if (buffer.length >= 4) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true;
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return true;
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return true;
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) return true;
  }
  return false;
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

function toAbsoluteUrl(input: string | undefined, base: string) {
  if (!input) return undefined;
  try {
    return new URL(input, base).toString();
  } catch {
    return undefined;
  }
}

function normalizeExternalUrl(input: string | undefined) {
  if (!input) return undefined;
  return sanitizeWhitespace(input);
}

function getScreenshotSourceKey(input: string) {
  const normalized = sanitizeWhitespace(input) ?? input;
  const wixMediaMatch = normalized.match(/\/media\/([^/?]+?)(?:\/v1\/|$)/);
  return wixMediaMatch?.[1] ?? normalized;
}

function dedupeScreenshotSources(inputs: Array<string | undefined>) {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    if (!input) continue;
    const key = getScreenshotSourceKey(input);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(input);
  }

  return result;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function fetchWithCurl(url: string, accept: string) {
  return await new Promise<Buffer>((resolve, reject) => {
    execFile(
      CURL_BIN,
      [
        "--silent",
        "--show-error",
        "--location",
        "--retry",
        "5",
        "--retry-all-errors",
        "--connect-timeout",
        "30",
        "--max-time",
        "120",
        "--http1.1",
        "-A",
        USER_AGENT,
        "-H",
        `Accept: ${accept}`,
        url,
      ],
      {
        encoding: "buffer",
        maxBuffer: CURL_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      }
    );
  });
}

async function fetchText(url: string) {
  let lastError: unknown;
  const accept = "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8";

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: accept,
          Connection: "close",
        },
        cache: "no-store",
        redirect: "follow",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      } as RequestInit);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      return await response.text();
    } catch (error) {
      lastError = error;
      await delay(300 * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }

  try {
    return (await fetchWithCurl(url, accept)).toString("utf8");
  } catch (curlError) {
    throw new Error(`fetch failed (${getErrorMessage(lastError)}); curl fallback failed (${getErrorMessage(curlError)})`);
  }
}

async function fetchBinary(url: string) {
  let lastError: unknown;
  const accept = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: accept,
          Connection: "close",
        },
        cache: "no-store",
        redirect: "follow",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      } as RequestInit);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      return {
        buffer: Buffer.from(arrayBuffer),
        contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
      };
    } catch (error) {
      lastError = error;
      await delay(300 * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }

  try {
    return {
      buffer: await fetchWithCurl(url, accept),
      contentType: "",
    };
  } catch (curlError) {
    throw new Error(`fetch failed (${getErrorMessage(lastError)}); curl fallback failed (${getErrorMessage(curlError)})`);
  }
}

async function purgeWithPrefix(dir: string, prefix: string) {
  try {
    const entries = await fs.readdir(dir);
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => fs.unlink(path.join(dir, entry)).catch(() => undefined))
    );
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw error;
    }
  }
}

function padIndex(value: string | number) {
  return String(value).padStart(2, "0");
}

function parseDateInfo(text: string | undefined) {
  if (!text) return undefined;

  const pick = (label: string) => {
    const match = text.match(new RegExp(`【${label}(?:日)?】\\s*([0-9]{4}-[0-9]{2}-[0-9]{2}|-)`));
    const value = match?.[1];
    return value && value !== "-" ? value : undefined;
  };

  const dates: DateInfo = {
    registered: pick("登録"),
    submitted: pick("提出"),
    updated: pick("更新"),
  };

  return dates.registered || dates.submitted || dates.updated ? dates : undefined;
}

function dedupeStrings(values: Array<string | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }

  return result;
}

function toWixMediaUrl(input: unknown): string | undefined {
  if (typeof input !== "string" || !input.trim()) return undefined;
  if (/^https?:\/\//i.test(input)) return input;

  if (input.startsWith("wix:image://")) {
    const match = input.match(/^wix:image:\/\/v1\/([^/]+)/i);
    if (match?.[1]) {
      return `https://static.wixstatic.com/media/${match[1]}`;
    }
  }

  return `https://static.wixstatic.com/media/${input}`;
}

function extractViewerModel(html: string): ViewerModel {
  const match = html.match(/<script type="application\/json" id="wix-viewer-model">([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error("Failed to locate wix-viewer-model");
  }
  return JSON.parse(match[1]) as ViewerModel;
}

function extractFeatureUrl(html: string, featureId: string) {
  const $ = cheerio.load(html);
  const href = $(`link#features_${featureId}`).attr("href");
  if (!href) {
    throw new Error(`Failed to locate feature preload for ${featureId}`);
  }
  return href;
}

function buildPageJsonUrl(templateUrl: string, pageJsonFileName: string) {
  const url = new URL(templateUrl);
  url.searchParams.set("pageId", pageJsonFileName);
  return url.toString();
}

function parseSharedDownloadSources(html: string) {
  const $ = cheerio.load(html);
  const links: SharedDownloadSource[] = [];

  $("a[href]").each((_, element) => {
    const href = normalizeExternalUrl($(element).attr("href"));
    if (!href) return;
    const label = sanitizeWhitespace($(element).text()) ?? href;
    links.push({ label, url: href });
  });

  const deduped = new Map<string, SharedDownloadSource>();
  for (const link of links) {
    if (!deduped.has(link.url)) {
      deduped.set(link.url, link);
    }
  }

  return Array.from(deduped.values());
}

function parseListEntries(html: string): ListEntry[] {
  const $ = cheerio.load(html);
  const entries: ListEntry[] = [];

  $("table").each((_, tableElement) => {
    const table = $(tableElement);
    const titleAnchor = table.find("a[href*='/no-']").first();
    if (!titleAnchor.length) return;

    const titleText = sanitizeWhitespace(titleAnchor.text());
    if (!titleText) return;

    const titleMatch = titleText.match(/^No\.(\d+)[\s　]*(.+)$/);
    if (!titleMatch) return;

    const no = titleMatch[1];
    const index = padIndex(no);
    const title = sanitizeWhitespace(titleMatch[2]) ?? titleText;
    const detailUrl = toAbsoluteUrl(titleAnchor.attr("href") ?? undefined, BASE_URL);
    const pageSeo = detailUrl ? new URL(detailUrl).pathname.split("/").filter(Boolean).pop() ?? `no-${no}` : `no-${no}`;

    const firstRow = table.find("tr").first();
    const screenshotUrl = toAbsoluteUrl(firstRow.find("td").first().find("img").attr("src") ?? undefined, BASE_URL);
    const iconUrl = toAbsoluteUrl(firstRow.find("td").eq(1).find("img").attr("src") ?? undefined, BASE_URL);

    const detailsRow = table.find("tr").eq(2);
    const detailsText = normalizeTextBlock(detailsRow.text()) ?? "";

    const forumUrl = normalizeExternalUrl(table.find("a[href*='jbbs.shitaraba.net']").first().attr("href") ?? undefined);
    const downloadLinks = table
      .find("a[href]")
      .toArray()
      .map((element) => normalizeExternalUrl($(element).attr("href") ?? undefined))
      .filter((url): url is string => Boolean(url) && !url.includes("jbbs.shitaraba.net") && !url.includes("/no-"));

    const entry: ListEntry = {
      index,
      no,
      pageSeo,
      detailUrl,
      title,
      author: stripLabelText(
        sanitizeWhitespace(detailsText.match(/【作者名】\s*([^\n]+)/)?.[0]),
        ["作者名"]
      ),
      genre: stripLabelText(
        sanitizeWhitespace(detailsText.match(/【ジャンル】\s*([^\n]+)/)?.[0]),
        ["ジャンル"]
      ),
      engine: stripLabelText(
        sanitizeWhitespace(detailsText.match(/【使用ツール】\s*([^\n]+)/)?.[0]),
        ["使用ツール"]
      ),
      streaming: stripLabelText(
        sanitizeWhitespace(detailsText.match(/【作品配信許可／動画公開許可】\s*([^\n]+)/)?.[0]),
        ["作品配信許可／動画公開許可"]
      ),
      forum: forumUrl,
      downloadSources: dedupeStrings(downloadLinks),
      dates: parseDateInfo(normalizeTextBlock(table.find("tr").last().text())),
      iconUrl,
      previewScreenshotUrl: screenshotUrl,
    };

    entries.push(entry);
  });

  const unique = new Map<string, ListEntry>();
  for (const entry of entries) {
    if (!unique.has(entry.index)) {
      unique.set(entry.index, entry);
    }
  }

  return Array.from(unique.values()).sort((a, b) => Number(a.no) - Number(b.no));
}

function normalizeCommentFragment(fragment: string | undefined, baseUrl: string) {
  if (!fragment) return undefined;
  const $ = cheerio.load(`<div id="root">${fragment}</div>`);

  $("#root a[href]").each((_, element) => {
    const href = $(element).attr("href");
    const absolute = toAbsoluteUrl(href ?? undefined, baseUrl);
    if (absolute) {
      $(element).attr("href", absolute);
    }
    $(element).attr("target", "_blank");
    $(element).attr("rel", "noopener noreferrer");
  });

  let html = $("#root").html()?.trim() ?? "";
  html = html.replace(/^(?:<br\s*\/?>\s*)+/i, "").replace(/(?:\s*<br\s*\/?>)+$/i, "").trim();
  return html || undefined;
}

function parseDetailInfo(html: string, baseUrl: string): DetailInfo {
  const $ = cheerio.load(html);
  const cells = $("td").toArray().map((element) => $(element));

  const findCellByLabel = (label: string) =>
    cells.find((cell) => {
      const text = normalizeTextBlock(cell.text()) ?? "";
      return text.includes(`【${label}】`);
    });

  const extractSimple = (label: string) => {
    const cell = findCellByLabel(label);
    const text = normalizeTextBlock(cell?.text());
    return stripLabelText(text, [label]);
  };

  const extractComment = (label: string) => {
    const cell = findCellByLabel(label);
    if (!cell) return undefined;
    const htmlFragment = cell.html() ?? "";
    const stripped = htmlFragment.replace(new RegExp(`^\\s*【${label}】\\s*(?:<br\\s*\\/?>)?`, "i"), "");
    return normalizeCommentFragment(stripped, baseUrl);
  };

  const datesCell = cells.find((cell) => {
    const text = normalizeTextBlock(cell.text()) ?? "";
    return text.includes("【登録日】") || text.includes("【登録】");
  });

  const downloadSources = $("a[href]")
    .toArray()
    .map((element) => {
      const href = $(element).attr("href") ?? "";
      const text = normalizeTextBlock($(element).text()) ?? "";
      if (!href) return undefined;
      if (!/ダウンロード/.test(text) && !/mediafire|getuploader/i.test(href)) return undefined;
      return normalizeExternalUrl(href);
    })
    .filter((value): value is string => Boolean(value));

  const forum = normalizeExternalUrl($("iframe[src*='jbbs.shitaraba.net']").attr("src") ?? $("a[href*='jbbs.shitaraba.net']").attr("href") ?? undefined);

  return {
    author: extractSimple("作者名"),
    genre: extractSimple("ジャンル"),
    engine: extractSimple("使用ツール"),
    streaming: extractSimple("作品配信許可／動画公開許可"),
    forum,
    downloadSources: dedupeStrings(downloadSources),
    dates: parseDateInfo(normalizeTextBlock(datesCell?.text())),
    authorComment: extractComment("作者コメント"),
    hostComment: extractComment("管理人コメント"),
  };
}

function extractPageAssets(pageJson: JsonObject): PageAssets {
  const structure = ((pageJson.structure ?? {}) as JsonObject).components as Record<string, JsonObject> | undefined;
  const compProps = ((((pageJson.props ?? {}) as JsonObject).render ?? {}) as JsonObject).compProps as Record<string, JsonObject> | undefined;
  if (!structure || !compProps) {
    return { screenshotUrls: [] };
  }

  const iconCandidates: Array<{ url: string; area: number }> = [];
  const screenshotUrls: string[] = [];

  for (const [compId, component] of Object.entries(structure)) {
    const componentType = component.componentType;
    const pageId = component.pageId;
    if (pageId === "masterPage") continue;

    const props = compProps[compId] ?? {};

    if (componentType === "WPhoto") {
      const width = Number(props.width ?? props.containerWidth ?? 0);
      const height = Number(props.height ?? props.containerHeight ?? 0);
      const imageUrl = toWixMediaUrl(props.uri) ?? (typeof props.responsiveImageProps === "object" ? String((props.responsiveImageProps as JsonObject).fallbackSrc ?? "") : undefined);

      if (!imageUrl) continue;

      if (width > 0 && height > 0 && width <= SMALL_IMAGE_LIMIT && height <= SMALL_IMAGE_LIMIT) {
        iconCandidates.push({ url: imageUrl, area: width * height });
      } else if (width > SMALL_IMAGE_LIMIT || height > SMALL_IMAGE_LIMIT) {
        screenshotUrls.push(imageUrl);
      }
      continue;
    }

    if (componentType === "SlideShowSlide") {
      const fillLayers = props.fillLayers as JsonObject | undefined;
      const image = (fillLayers?.image ?? {}) as JsonObject;
      const imageUrl = toWixMediaUrl(image.uri);
      if (imageUrl) {
        screenshotUrls.push(imageUrl);
      }
    }
  }

  iconCandidates.sort((a, b) => a.area - b.area);

  return {
    iconUrl: iconCandidates[0]?.url,
    screenshotUrls: dedupeStrings(screenshotUrls),
  };
}

function extractPageHtmlComponentUrl(pageJson: JsonObject) {
  const structure = ((pageJson.structure ?? {}) as JsonObject).components as Record<string, JsonObject> | undefined;
  const compProps = ((((pageJson.props ?? {}) as JsonObject).render ?? {}) as JsonObject).compProps as Record<string, JsonObject> | undefined;
  if (!structure || !compProps) return undefined;

  for (const [compId, component] of Object.entries(structure)) {
    if (component.componentType !== "HtmlComponent") continue;
    const props = compProps[compId] ?? {};
    if (typeof props.url === "string" && props.url.length > 0) {
      return props.url;
    }
  }

  return undefined;
}

function extractBannerSource(masterPageJson: JsonObject) {
  const compProps = ((((masterPageJson.props ?? {}) as JsonObject).render ?? {}) as JsonObject).compProps as Record<string, JsonObject> | undefined;
  if (!compProps) return undefined;

  for (const props of Object.values(compProps)) {
    const width = Number(props.width ?? 0);
    const height = Number(props.height ?? 0);
    const uri = toWixMediaUrl(props.uri);
    if (!uri) continue;
    if (width >= 150 && height >= 30) {
      return uri;
    }
  }

  return undefined;
}

async function copyBanner(source: string | undefined) {
  if (!source) return undefined;
  await ensureDir(BANNERS_DIR);
  const { buffer, contentType } = await fetchBinary(source);
  if (!looksLikeImageBuffer(buffer, contentType)) {
    throw new Error(`Banner source is not an image: ${source}`);
  }
  const fileName = `${FESTIVAL_SLUG}${assetExtensionFromUrl(source, ".png")}`;
  await fs.writeFile(path.join(BANNERS_DIR, fileName), buffer);
  return `/banners/${fileName}`;
}

async function copyIcon(index: string, source: string | undefined) {
  if (!source) return undefined;
  await ensureDir(ICONS_DIR);
  const { buffer, contentType } = await fetchBinary(source);
  if (!looksLikeImageBuffer(buffer, contentType)) return undefined;
  const fileName = `${index}${assetExtensionFromUrl(source, ".png")}`;
  await fs.writeFile(path.join(ICONS_DIR, fileName), buffer);
  return path.posix.join(RELATIVE_ICONS_DIR, fileName);
}

async function copyScreenshots(index: string, sources: string[]) {
  await ensureDir(SCREENSHOTS_DIR);
  await purgeWithPrefix(SCREENSHOTS_DIR, index);

  const result: DownloadResult = {
    paths: [],
    skipped: [],
    failures: [],
  };

  const hashes = new Set<string>();
  let order = 1;

  for (const source of dedupeStrings(sources)) {
    if (result.paths.length >= MAX_SCREENSHOTS) break;
    try {
      const { buffer, contentType } = await fetchBinary(source);
      if (!looksLikeImageBuffer(buffer, contentType)) {
        result.failures.push(`${source} (not image: ${contentType || "unknown"})`);
        continue;
      }

      const dimensions = getImageDimensions(buffer);
      if (dimensions && dimensions.width < SMALL_IMAGE_LIMIT && dimensions.height < SMALL_IMAGE_LIMIT) {
        result.skipped.push({ source, reason: "small" });
        continue;
      }

      const digest = createHash("md5").update(buffer).digest("hex");
      if (hashes.has(digest)) {
        result.skipped.push({ source, reason: "duplicate" });
        continue;
      }

      hashes.add(digest);

      const fileName =
        order === 1
          ? `${index}${assetExtensionFromUrl(source, ".png")}`
          : `${index}-${String(order).padStart(2, "0")}${assetExtensionFromUrl(source, ".png")}`;

      await fs.writeFile(path.join(SCREENSHOTS_DIR, fileName), buffer);
      result.paths.push(path.posix.join(RELATIVE_SCREENSHOTS_DIR, fileName));
      order += 1;
    } catch (error) {
      result.failures.push(`${source} => ${(error as Error).message}`);
    }
  }

  return result;
}

async function saveTextFile(filePath: string, content: string) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf8");
}

async function run() {
  await ensureDir(CATCH_DIR);
  await ensureDir(SOURCE_DIR);
  await ensureDir(DETAIL_HTML_DIR);
  await ensureDir(BANNERS_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);

  const existingWorks = (await readJsonIfExists<WorkEntryOut[]>(OUTPUT_WORKS)) ?? [];
  const existingSummary = await readJsonIfExists<SummaryFile>(SUMMARY_PATH);
  const existingWorkByIndex = new Map(existingWorks.map((work) => [work.no, work]));
  const existingSummaryByIndex = new Map((existingSummary?.entries ?? []).map((entry) => [entry.index, entry]));

  const seedHtml =
    (await readFirstExisting(LOCAL_SEED_CANDIDATES)) ??
    (await fetchText(SEED_PAGE_URL));
  await saveTextFile(path.join(SOURCE_DIR, "0-40.html"), seedHtml);

  const viewerModel = extractViewerModel(seedHtml);
  const routerPages = Object.values(viewerModel.siteFeaturesConfigs.router.pagesMap);
  const pageJsonFileNames = viewerModel.siteAssets.siteScopeParams.pageJsonFileNames;

  const pageBySeo = new Map<string, RouterPage>();
  for (const page of routerPages) {
    pageBySeo.set(page.pageUriSEO, page);
  }

  const featureTemplateUrl = extractFeatureUrl(seedHtml, pageBySeo.get("0-40")?.pageId ?? "zsau1");
  const masterPageFeatureUrl = extractFeatureUrl(seedHtml, "masterPage");

  const masterPageJsonPath = path.join(SOURCE_DIR, "master-page.json");
  const masterPageJsonRaw = await fetchTextWithCache(masterPageFeatureUrl, masterPageJsonPath, LOCAL_MASTER_PAGE_JSON_CANDIDATES);
  const masterPageJson = JSON.parse(masterPageJsonRaw) as JsonObject;

  const sharedHtmlUrl = extractPageHtmlComponentUrl(masterPageJson);
  const sharedHtml = sharedHtmlUrl
    ? await fetchTextWithCache(sharedHtmlUrl, path.join(SOURCE_DIR, "shared-downloads.html"), LOCAL_SHARED_HTML_CANDIDATES)
    : "";

  const bannerSource = extractBannerSource(masterPageJson);
  const banner = await copyBanner(bannerSource);
  const sharedDownloadSources = sharedHtml ? parseSharedDownloadSources(sharedHtml) : [];

  const listEntries: ListEntry[] = [];
  for (const seo of LIST_PAGE_SEOS) {
    const page = pageBySeo.get(seo);
    if (!page) {
      throw new Error(`Missing router entry for list page ${seo}`);
    }

    const pageJsonUrl = buildPageJsonUrl(featureTemplateUrl, pageJsonFileNames[page.pageId] ?? `${page.pageJsonFileName}.json`);
    const pageJsonRaw = await fetchTextWithCache(
      pageJsonUrl,
      path.join(SOURCE_DIR, `${seo}-page.json`),
      LOCAL_LIST_PAGE_JSON_CANDIDATES[seo] ?? []
    );

    const pageJson = JSON.parse(pageJsonRaw) as JsonObject;
    const blockUrl = extractPageHtmlComponentUrl(pageJson);
    if (!blockUrl) {
      throw new Error(`Missing HtmlComponent for list page ${seo}`);
    }

    const blockHtml = await fetchTextWithCache(
      blockUrl,
      path.join(SOURCE_DIR, `${seo}-list.html`),
      LOCAL_LIST_BLOCK_CANDIDATES[seo] ?? []
    );
    listEntries.push(...parseListEntries(blockHtml));
  }

  const listByIndex = new Map<string, ListEntry>();
  for (const entry of listEntries.sort((a, b) => Number(a.no) - Number(b.no))) {
    if (!listByIndex.has(entry.index)) {
      listByIndex.set(entry.index, entry);
    }
  }

  const works: WorkEntryOut[] = [];
  const summaryEntries: SummaryEntry[] = [];

  for (const entry of Array.from(listByIndex.values()).sort((a, b) => Number(a.no) - Number(b.no))) {
    const cachedWork = existingWorkByIndex.get(entry.index);
    const cachedSummaryEntry = existingSummaryByIndex.get(entry.index);
    if (cachedWork && cachedSummaryEntry?.status === "ok") {
      works.push(cachedWork);
      summaryEntries.push(cachedSummaryEntry);
      continue;
    }

    try {
      const page = pageBySeo.get(entry.pageSeo);
      if (!page) {
        throw new Error(`Missing router entry for ${entry.pageSeo}`);
      }

      const detailPageJsonPath = path.join(SOURCE_DIR, "detail-pages", `${entry.index}.json`);
      const pageJsonUrl = buildPageJsonUrl(featureTemplateUrl, pageJsonFileNames[page.pageId] ?? `${page.pageJsonFileName}.json`);
      const pageJsonRaw = await fetchTextWithCache(pageJsonUrl, detailPageJsonPath);
      const pageJson = JSON.parse(pageJsonRaw) as JsonObject;

      const detailHtmlUrl = extractPageHtmlComponentUrl(pageJson);
      const assets = extractPageAssets(pageJson);

      let detailInfo: DetailInfo = { downloadSources: [] };
      if (detailHtmlUrl) {
        const detailHtml = await fetchTextWithCache(detailHtmlUrl, path.join(DETAIL_HTML_DIR, `${entry.index}.html`));
        detailInfo = parseDetailInfo(detailHtml, detailHtmlUrl);
      }

      const mergedDownloadSources = dedupeStrings([...entry.downloadSources, ...detailInfo.downloadSources]);
      const mergedForum = detailInfo.forum ?? entry.forum;
      const mergedDates = detailInfo.dates ?? entry.dates;
      const iconSource = assets.iconUrl ?? entry.iconUrl;
      const screenshotSources = dedupeScreenshotSources([
        ...assets.screenshotUrls,
        entry.previewScreenshotUrl,
      ]);

      const icon = await copyIcon(entry.index, iconSource);
      const screenshotReport = await copyScreenshots(entry.index, screenshotSources);

      const work: WorkEntryOut = {
        id: `${FESTIVAL_ID}-work-${entry.index}`,
        festivalId: FESTIVAL_ID,
        no: entry.index,
        title: entry.title,
        author: detailInfo.author ?? entry.author ?? "",
        category: detailInfo.genre ?? entry.genre,
        engine: detailInfo.engine ?? entry.engine,
        streaming: detailInfo.streaming ?? entry.streaming,
        forum: mergedForum,
        authorComment: detailInfo.authorComment,
        hostComment: detailInfo.hostComment,
        icon,
        ss: screenshotReport.paths.length > 0 ? screenshotReport.paths : undefined,
      };

      if (!work.authorComment && !work.hostComment && (!work.ss || work.ss.length === 0)) {
        work.detailDisabled = true;
      }

      works.push(work);

      summaryEntries.push({
        index: entry.index,
        status: "ok",
        title: work.title,
        pageSeo: entry.pageSeo,
        pageJsonSource: pageJsonUrl,
        detailSource: detailHtmlUrl,
        icon,
        iconSource,
        forum: mergedForum,
        dates: mergedDates,
        downloadSource: mergedDownloadSources,
        screenshotSources,
        screenshotReport: {
          saved: screenshotReport.paths.length,
          skipped: screenshotReport.skipped.length > 0 ? screenshotReport.skipped : undefined,
          failures: screenshotReport.failures.length > 0 ? screenshotReport.failures : undefined,
        },
        note: work.detailDisabled ? "detail disabled" : undefined,
      });
    } catch (error) {
      summaryEntries.push({
        index: entry.index,
        status: "error",
        title: entry.title,
        pageSeo: entry.pageSeo,
        error: (error as Error).message,
      });
    }
  }

  works.sort((a, b) => Number(a.no) - Number(b.no));
  summaryEntries.sort((a, b) => Number(a.index) - Number(b.index));

  const summary: SummaryFile = {
    festivalId: FESTIVAL_ID,
    generatedAt: new Date().toISOString(),
    banner,
    bannerSource,
    sharedDownloadSources,
    stats: {
      captured: works.length,
      errors: summaryEntries.filter((entry) => entry.status === "error").length,
      detailDisabled: works.filter((work) => work.detailDisabled).length,
    },
    entries: summaryEntries,
  };

  await fs.writeFile(OUTPUT_WORKS, JSON.stringify(works, null, 2), "utf8");
  await fs.writeFile(SUMMARY_PATH, JSON.stringify(summary, null, 2), "utf8");

  console.log(`Saved ${works.length} works to ${OUTPUT_WORKS}`);
  console.log(`Summary written to ${SUMMARY_PATH}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
