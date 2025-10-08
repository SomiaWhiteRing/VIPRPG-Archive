import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { load, CheerioAPI, Cheerio, Element } from "cheerio";
import type { AnyNode } from "domhandler";

const FESTIVAL_ID = "2023-kouhaku";
const FESTIVAL_SLUG = "2023-kouhaku";
const SOURCE_ROOT = path.join(process.cwd(), "[html]23夏24紅白GW", "[2023紅白]");
const ENTRY_DIR = path.join(SOURCE_ROOT, "entry");
const IMG_DIR = path.join(ENTRY_DIR, "img");

const OUTPUT_DIR = path.join(process.cwd(), "catch", FESTIVAL_SLUG);
const OUTPUT_WORKS = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const SUMMARY_PATH = path.join(OUTPUT_DIR, `${FESTIVAL_SLUG}-scrape-summary.json`);

const PUBLIC_DIR = path.join(process.cwd(), "public");
const BANNERS_DIR = path.join(PUBLIC_DIR, "banners");
const ICONS_DIR = path.join(PUBLIC_DIR, "icons", FESTIVAL_SLUG);
const SCREENSHOTS_DIR = path.join(PUBLIC_DIR, "screenshots", FESTIVAL_SLUG);

const RELATIVE_BANNERS_DIR = "/banners";
const RELATIVE_ICONS_DIR = `/icons/${FESTIVAL_SLUG}`;
const RELATIVE_SCREENSHOTS_DIR = `/screenshots/${FESTIVAL_SLUG}`;

const MAX_SCREENSHOTS = 6;
const SMALL_IMAGE_LIMIT = 100;

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
  downloadLabels?: string[];
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

interface DownloadButton {
  href: string;
  label: string;
}

interface ParsedEntry {
  index: string;
  title: string;
  author: string;
  category?: string;
  engine?: string;
  streaming?: string;
  authorComment?: string;
  hostComment?: string;
  forum?: string;
  iconSource?: string;
  screenshotSources: string[];
  downloadButtons: DownloadButton[];
  entryPath: string;
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
  const result = filtered.join("\n");
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

function normalizeIndex(value: string) {
  const num = parseInt(value, 10);
  if (Number.isNaN(num)) return value.trim();
  return String(num).padStart(2, "0");
}

async function listEntryFiles() {
  const entries = await fs.readdir(ENTRY_DIR);
  return entries.filter((name) => /^\d{2}\.html$/.test(name)).sort();
}

function extractRichText($: CheerioAPI, nodes: Cheerio<Element>) {
  const htmlSegments = nodes
    .map((_, el) => $(el).clone().wrap('<div/>').parent().html() ?? '')
    .get();
  if (htmlSegments.length === 0) {
    return undefined;
  }
  const rawHtml = htmlSegments.join('\n');
  const normalized = rawHtml
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a [^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis, (_match, href, textContent) => {
      const text = (textContent as string).replace(/<[^>]+>/g, '').trim();
      if (!href) return text;
      return `${text} (${href})`;
    });
  const stripped = normalized.replace(/<[^>]+>/g, '');
  return sanitizeMultiline(stripped);
}

function normalizeUrlList(urls: Array<string | undefined>) {
  const set = new Set<string>();
  for (const raw of urls) {
    if (!raw) continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    set.add(trimmed);
  }
  return Array.from(set);
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

async function readAsset(entryDir: string, raw: string | undefined) {
  if (!raw) return undefined;
  let candidate: string | undefined;
  if (/^file:\/\//i.test(raw)) {
    candidate = raw.replace(/^file:\/\//i, "");
  } else if (/^https?:/i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.hostname.includes("viprpg23k") || url.hostname.includes("viprpg")) {
        candidate = path.join(SOURCE_ROOT, decodeURIComponent(url.pathname.replace(/^\//, "")));
      }
    } catch {
      candidate = undefined;
    }
  } else {
    const cleaned = raw.replace(/^\.\//, "");
    candidate = path.resolve(entryDir, cleaned);
  }
  if (!candidate) return undefined;
  try {
    const buffer = await fs.readFile(candidate);
    return { buffer, absolutePath: candidate };
  } catch {
    return undefined;
  }
}

async function readImage(entryDir: string, source: string | undefined) {
  if (!source) return undefined;
  if (/^file:\/\//i.test(source)) {
    const absolute = source.replace(/^file:\/\//i, "");
    try {
      const buffer = await fs.readFile(absolute);
      return { buffer, absolutePath: absolute };
    } catch {
      return undefined;
    }
  }
  const asset = await readAsset(entryDir, source);
  if (asset) return asset;
  return undefined;
}

async function parseEntry(fileName: string): Promise<ParsedEntry> {
  const index = fileName.replace(/\.html$/, "");
  const filePath = path.join(ENTRY_DIR, fileName);
  const html = await fs.readFile(filePath, "utf8");
  const $ = load(html);

  const header = $("h2").first();
  const iconSrc = header.find("img").attr("src") ?? undefined;
  header.find("img").remove();
  const headerText = sanitizeWhitespace(header.text()) ?? "";
  const headerMatch = headerText.match(/^No\.\s*(\d+)\s*(.*)$/i);
  let title = headerText;
  let engineFromHeader: string | undefined;
  if (headerMatch) {
    title = headerMatch[2].trim();
  }
  const suffixMatch = title.match(/^(.*)\[(.+?)\]$/);
  if (suffixMatch) {
    title = suffixMatch[1].trim();
    engineFromHeader = suffixMatch[2].trim();
  }

  let author: string | undefined;
  let category: string | undefined;
  let engine: string | undefined = engineFromHeader;
  let streaming: string | undefined;

const infoNode = $("h3").first();
  if (infoNode.length) {
    const infoClone = infoNode.clone();
    infoClone.find("br").replaceWith("|||");
    const segments = infoClone
      .text()
      .split("|||")
      .map((segment) => sanitizeWhitespace(segment))
      .filter((segment): segment is string => Boolean(segment));

    for (const segment of segments) {
      if (!streaming && segment.includes("配信")) {
        streaming = sanitizeWhitespace(segment);
      }

      segment
        .split("/")
        .map((part) => sanitizeWhitespace(part))
        .filter((part): part is string => Boolean(part))
        .forEach((part) => {
          if (part.startsWith("作者：")) {
            author = sanitizeWhitespace(part.replace("作者：", ""));
          } else if (part.startsWith("ジャンル：")) {
            category = sanitizeWhitespace(part.replace("ジャンル：", ""));
          } else if (part.startsWith("使用ツール：") || part.startsWith("制作ツール：")) {
            engine = sanitizeWhitespace(part.replace(/^[^：]+：/, ""));
          }
        });
    }
  }
  const detailNode = $("div.detail").first();
  const authorComment = detailNode.length ? extractRichText($, detailNode) : undefined;

  let hostComment: string | undefined;
  const hostHeader = $("h4").filter((_, el) => $(el).text().includes("管理人"));
  if (hostHeader.length) {
    const fragments: string[] = [];
    let node: AnyNode | null = hostHeader.first()[0]?.nextSibling ?? null;
    while (node) {
      if (node.type === "tag" && node.name === "h4") break;
      if (node.type === "tag" && $(node).hasClass("e_btn")) break;
      if (node.type === "tag" && node.name === "hr") break;
      if (node.type === "tag") {
        const segment = extractRichText($, $(node as Element));
        if (segment) fragments.push(segment);
      } else if (node.type === "text") {
        const textValue = sanitizeWhitespace(node.data ?? "");
        if (textValue) fragments.push(textValue);
      }
      node = node.nextSibling ?? null;
    }
    hostComment = sanitizeMultiline(fragments.join("\n"));
  }

  const downloadButtons: DownloadButton[] = [];
  let forum: string | undefined;
  $(".e_btn a").each((_, el) => {
    const link = $(el);
    const href = sanitizeWhitespace(link.attr("href"));
    if (!href) return;
    const label = sanitizeWhitespace(link.text()) ?? "";
    if (link.hasClass("btn_dlvote") || label.includes("DL")) {
      downloadButtons.push({ href, label });
    } else if (!forum) {
      forum = href;
    }
  });

  const screenshotSources = $(".entry_carousel_img img")
    .map((_, el) => $(el).attr("src") ?? "")
    .get()
    .filter((src) => src.length > 0);

  return {
    index: normalizeIndex(index),
    title,
    author: author ?? "不明",
    category,
    engine,
    streaming,
    authorComment,
    hostComment,
    forum,
    iconSource: iconSrc,
    screenshotSources,
    downloadButtons,
    entryPath: filePath,
  };
}

async function copyIcon(index: string, primary: string | undefined, entryDir: string) {
  const candidates: string[] = [];
  if (primary) candidates.push(primary);
  for (const ext of [".png", ".gif", ".jpg", ".jpeg"] as const) {
    const byName = path.join(IMG_DIR, `i${index}${ext}`);
    try {
      await fs.access(byName);
      candidates.push(`file://${byName}`);
    } catch {}
  }

  const smallCandidates: { source: string; buffer: Buffer; ext: string }[] = [];
  const fallback: { source: string; buffer: Buffer; ext: string }[] = [];

  for (const candidate of candidates) {
    const asset = await readImage(entryDir, candidate);
    if (!asset) continue;
    const dims = getImageDimensions(asset.buffer);
    const extCandidate = path.extname(candidate.startsWith("file://") ? candidate.replace(/^file:\/\//i, "") : candidate.split(/[?#]/)[0]) || ".png";
    const ext = extCandidate.toLowerCase() === ".jpeg" ? ".jpg" : extCandidate.toLowerCase();
    if (dims && dims.width <= SMALL_IMAGE_LIMIT && dims.height <= SMALL_IMAGE_LIMIT) {
      smallCandidates.push({ source: candidate, buffer: asset.buffer, ext });
    } else {
      fallback.push({ source: candidate, buffer: asset.buffer, ext });
    }
  }

  const chosen = smallCandidates[0] ?? fallback[0];
  if (!chosen) return undefined;

  const destFile = `${index}${chosen.ext}`;
  const destPath = path.join(ICONS_DIR, destFile);
  await fs.writeFile(destPath, chosen.buffer);
  return `${RELATIVE_ICONS_DIR}/${destFile}`;
}

async function copyScreenshots(index: string, sources: string[], entryDir: string) {
  const unique = normalizeUrlList(sources);
  const seenHashes = new Set<string>();
  const candidates: Array<{ buffer: Buffer; extension: string; source: string; dims?: { width: number; height: number } }> = [];
  const skipped: ScreenshotSkip[] = [];
  const failures: string[] = [];

  for (const source of unique) {
    const asset = await readImage(entryDir, source);
    if (!asset) {
      failures.push(source);
      continue;
    }
    const dims = getImageDimensions(asset.buffer);
    if (dims && dims.width < SMALL_IMAGE_LIMIT && dims.height < SMALL_IMAGE_LIMIT) {
      skipped.push({ source, reason: "small" });
      continue;
    }
    const hash = createHash("md5").update(asset.buffer).digest("hex");
    if (seenHashes.has(hash)) {
      skipped.push({ source, reason: "duplicate" });
      continue;
    }
    seenHashes.add(hash);
    const extCandidate = path.extname(source.split(/[?#]/)[0]) || ".png";
    const extension = extCandidate.toLowerCase() === ".jpeg" ? ".jpg" : extCandidate.toLowerCase();
    candidates.push({ buffer: asset.buffer, extension, source, dims });
  }

  if (candidates.length === 0) {
    return { paths: [], skipped, failures } satisfies ScreenshotResult;
  }

  const limited = candidates.slice(0, MAX_SCREENSHOTS);
  const paths: string[] = [];
  for (let i = 0; i < limited.length; i += 1) {
    const candidate = limited[i];
    const suffix = i === 0 ? "" : `-${String(i + 1).padStart(2, "0")}`;
    const destFile = `${index}${suffix}${candidate.extension}`;
    const destPath = path.join(SCREENSHOTS_DIR, destFile);
    await fs.writeFile(destPath, candidate.buffer);
    paths.push(`${RELATIVE_SCREENSHOTS_DIR}/${destFile}`);
  }

  return { paths, skipped, failures } satisfies ScreenshotResult;
}

async function copyBanner() {
  const bannerFile = path.join(SOURCE_ROOT, "img", "banner23.png");
  try {
    const buffer = await fs.readFile(bannerFile);
    const destPath = path.join(BANNERS_DIR, `${FESTIVAL_SLUG}.png`);
    await fs.writeFile(destPath, buffer);
    return `${RELATIVE_BANNERS_DIR}/${FESTIVAL_SLUG}.png`;
  } catch (error) {
    console.warn("Failed to copy banner", error);
    return undefined;
  }
}

function extractDownloadLabels(buttons: DownloadButton[]) {
  return buttons.map((btn) => btn.label || btn.href);
}

function extractDownloadSources(buttons: DownloadButton[]) {
  return normalizeUrlList(buttons.map((btn) => btn.href));
}

async function main() {
  await ensureDir(OUTPUT_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);
  await ensureDir(BANNERS_DIR);

  await emptyDir(ICONS_DIR);
  await emptyDir(SCREENSHOTS_DIR);

  const banner = await copyBanner();

  const entryFiles = await listEntryFiles();
  const works: WorkEntry[] = [];
  const snapshots: SnapshotRecord[] = [];

  for (const fileName of entryFiles) {
    try {
      const parsed = await parseEntry(fileName);
      const detailDir = path.dirname(parsed.entryPath);

      const iconPath = await copyIcon(parsed.index, parsed.iconSource, detailDir);
      const screenshotResult = await copyScreenshots(parsed.index, parsed.screenshotSources, detailDir);

      const work: WorkEntry = {
        id: `${FESTIVAL_ID}-work-${parsed.index}`,
        festivalId: FESTIVAL_ID,
        title: parsed.title,
        author: parsed.author,
        category: parsed.category,
        engine: parsed.engine,
        streaming: parsed.streaming,
        forum: parsed.forum,
        authorComment: parsed.authorComment,
        hostComment: parsed.hostComment,
      };
      if (iconPath) {
        work.icon = iconPath;
      }
      if (screenshotResult.paths.length > 0) {
        work.ss = screenshotResult.paths;
      }
      works.push(work);

      const downloadSources = extractDownloadSources(parsed.downloadButtons);
      const downloadLabels = extractDownloadLabels(parsed.downloadButtons);

      const noteParts: string[] = [];
      if (downloadSources.length > 0) {
        noteParts.push(`ダウンロード: ${downloadLabels.join(", ")}`);
      } else {
        noteParts.push("ダウンロード: 未提供");
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
        index: parsed.index,
        status: "ok",
        title: parsed.title,
        icon: iconPath,
        note: noteParts.join("; ") || undefined,
        downloadSource: downloadSources.length ? downloadSources : undefined,
        downloadLabels: downloadLabels.length ? downloadLabels : undefined,
        screenshotReport: {
          saved: screenshotResult.paths.length,
          skipped: screenshotResult.skipped.length ? screenshotResult.skipped : undefined,
          failures: screenshotResult.failures.length ? screenshotResult.failures : undefined,
        },
      });
    } catch (error) {
      console.error(`Failed to process entry ${fileName}:`, error);
      const index = fileName.replace(/\.html$/, "");
      snapshots.push({
        index: normalizeIndex(index),
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
