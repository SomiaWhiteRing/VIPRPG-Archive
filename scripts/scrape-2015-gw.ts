import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const execFileAsync = promisify(execFile);

const FESTIVAL_ID = "2015-gw";
const FESTIVAL_SLUG = "2015-gw";
const REVIEW_URL =
  "https://tekunosuo.yamatoblog.net/%E3%82%B2%E3%83%BC%E3%83%A0%E3%83%AC%E3%83%93%E3%83%A5%E3%83%BC/" +
  "viprpg2015gw%E3%83%AC%E3%83%93%E3%83%A5%E3%83%BC";
const ORIGINAL_URL = "https://vipkohaku.x.fc2.com/2015GW/index.html";
const ORIGINAL_FALLBACK_URL = "http://www.geocities.jp/viprpg2015gw/";
const BANNER_SOURCE = "https://viprpg2021gw.x.2nt.com/gw2015.png";

const OUTPUT_WORKS = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const CATCH_DIR = path.join(process.cwd(), "catch", FESTIVAL_SLUG);
const SOURCE_DIR = path.join(CATCH_DIR, "source");
const SUMMARY_PATH = path.join(CATCH_DIR, `${FESTIVAL_SLUG}-scrape-summary.json`);

const PUBLIC_DIR = path.join(process.cwd(), "public");
const BANNERS_DIR = path.join(PUBLIC_DIR, "banners");

const CURL_BIN = process.platform === "win32" ? "curl.exe" : "curl";
const CURL_MAX_BUFFER = 20 * 1024 * 1024;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)" +
  " Chrome/130.0.0.0 Safari/537.36";

interface WorkEntryOut {
  id: string;
  festivalId: string;
  no: string;
  title: string;
  author: string;
  detailDisabled: boolean;
}

interface SummaryEntry {
  index: string;
  status: "ok";
  title: string;
  note: string;
}

interface SummaryFile {
  festivalId: string;
  generatedAt: string;
  banner?: string;
  bannerSource?: string;
  sourceFiles: {
    reviewHtml: string;
  };
  sourceNotes: string[];
  stats: {
    captured: number;
    missingPrimaryMetadata: number;
  };
  entries: SummaryEntry[];
}

interface ParsedEntry {
  no: string;
  title: string;
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function saveJson(filePath: string, value: unknown) {
  return fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
  return buffer.toString("utf8");
}

async function fetchBinary(url: string) {
  return curlBuffer(url);
}

function normalizeLine(value: string) {
  return value.replace(/[\u00a0\u200b]/g, " ").replace(/\s+/g, " ").trim();
}

function htmlToPlainLines(html: string) {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n");
  const $ = cheerio.load(`<div id="root">${withBreaks}</div>`);

  return $("#root")
    .text()
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => normalizeLine(line))
    .filter(Boolean);
}

function extractReviewHtml(html: string) {
  const $ = cheerio.load(html);

  for (const blockElement of $(".EntryInnerBlock").toArray()) {
    const block = $(blockElement);
    const title = normalizeLine(block.find(".EntryTitle a").first().text());
    if (title === "VIPRPG2015GWレビュー") {
      const entryHtml = block.find(".EntryText").first().html();
      if (!entryHtml) {
        throw new Error("Review block exists but has no HTML");
      }
      return entryHtml;
    }
  }

  throw new Error("Could not find the VIPRPG2015GW review block");
}

function parseEntries(reviewHtml: string) {
  const lines = htmlToPlainLines(reviewHtml);
  const entries: ParsedEntry[] = [];
  let expectedIndex = 1;

  for (const line of lines) {
    if (line === "おまけ") {
      break;
    }

    const expectedNo = String(expectedIndex).padStart(2, "0");
    const match = line.match(new RegExp(`^(${expectedNo})(.+)$`));
    if (!match) {
      continue;
    }

    entries.push({
      no: match[1],
      title: normalizeLine(match[2]),
    });
    expectedIndex += 1;
  }

  if (entries.length !== 71) {
    throw new Error(`Expected 71 numbered entries, got ${entries.length}`);
  }

  for (let index = 0; index < entries.length; index += 1) {
    const expectedNo = String(index + 1).padStart(2, "0");
    if (entries[index].no !== expectedNo) {
      throw new Error(`Expected entry ${expectedNo}, got ${entries[index].no}`);
    }
  }

  return entries;
}

async function saveBanner() {
  const buffer = await fetchBinary(BANNER_SOURCE);
  await ensureDir(BANNERS_DIR);
  await fs.writeFile(path.join(BANNERS_DIR, `${FESTIVAL_SLUG}.png`), buffer);
  return `/banners/${FESTIVAL_SLUG}.png`;
}

async function main() {
  await ensureDir(CATCH_DIR);
  await ensureDir(SOURCE_DIR);

  const reviewHtmlPage = await fetchText(REVIEW_URL);
  await fs.writeFile(path.join(SOURCE_DIR, "viprpg2015gw-review.html"), reviewHtmlPage, "utf8");

  const reviewHtml = extractReviewHtml(reviewHtmlPage);
  const entries = parseEntries(reviewHtml);
  const banner = await saveBanner();

  const works: WorkEntryOut[] = entries.map((entry) => ({
    id: `${FESTIVAL_ID}-work-${entry.no}`,
    festivalId: FESTIVAL_ID,
    no: entry.no,
    title: entry.title,
    author: "",
    detailDisabled: true,
  }));

  const summaryEntries: SummaryEntry[] = entries.map((entry) => ({
    index: entry.no,
    status: "ok",
    title: entry.title,
    note: "Recovered from the 2015-05-07 external review page because the original FC2/Geocities festival pages are no longer accessible.",
  }));

  const summary: SummaryFile = {
    festivalId: FESTIVAL_ID,
    generatedAt: new Date().toISOString(),
    banner,
    bannerSource: BANNER_SOURCE,
    sourceFiles: {
      reviewHtml: path.relative(process.cwd(), path.join(SOURCE_DIR, "viprpg2015gw-review.html")).replace(/\\/g, "/"),
    },
    sourceNotes: [
      `Original festival URL now resolves to an FC2 violation/403 page: ${ORIGINAL_URL}`,
      `Former Geocities root is no longer directly accessible: ${ORIGINAL_FALLBACK_URL}`,
      `This archive checkpoint captures the full numbered title list (01-71) and banner, but author/category/engine/detail metadata could not be recovered from a stable primary source.`,
    ],
    stats: {
      captured: works.length,
      missingPrimaryMetadata: works.length,
    },
    entries: summaryEntries,
  };

  await saveJson(OUTPUT_WORKS, works);
  await saveJson(SUMMARY_PATH, summary);

  console.log(`Archived ${works.length} title-only entries for ${FESTIVAL_ID}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
