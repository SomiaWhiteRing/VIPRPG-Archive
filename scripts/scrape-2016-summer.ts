import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";

const FESTIVAL_ID = "2016-summer";
const FESTIVAL_SLUG = "2016-summer";
const ORIGINAL_URL = "http://www.geocities.jp/viprpgsun2016/viptop.html";
const ATTACHMENT_URL =
  "https://img.atwiki.jp/vip_rpg/attach/502/2108/VIPRPG%E5%A4%8F%E3%81%AE%E9%99%A32016.html";

const SOURCE_CANDIDATES = [
  path.join(
    "C:",
    "Users",
    "旻",
    "AppData",
    "Local",
    "Temp",
    "playwright-mcp-output",
    "1774097311304",
    "VIPRPG夏の陣2016.html"
  ),
  path.join(process.cwd(), "tmp_2016_summer_viptop.html"),
];

const OUTPUT_WORKS = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const CATCH_DIR = path.join(process.cwd(), "catch", FESTIVAL_SLUG);
const SOURCE_DIR = path.join(CATCH_DIR, "source");
const SUMMARY_PATH = path.join(CATCH_DIR, `${FESTIVAL_SLUG}-scrape-summary.json`);
const SOURCE_COPY_PATH = path.join(SOURCE_DIR, "viptop-atwiki-attachment.html");

const META_MARKERS = [
  "作者：",
  "作者名：",
  "ジャンル：",
  "ジャンル；",
  "《ジャンル》：",
  "配信：",
  "公開：",
  "公開；",
  "配信＆公開：",
  "《作品の配信許可／動画公開許可》",
  "ツクール：",
  "感想はコチラ",
];

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
}

interface SummaryEntry {
  index: string;
  status: "ok" | "error";
  title?: string;
  previewImageSource?: string;
  screenshotList?: string;
  screenshotPreviewSource?: string;
  forum?: string;
  downloadSource?: string[];
  note?: string;
  error?: string;
}

interface SummaryFile {
  festivalId: string;
  generatedAt: string;
  sourceOriginalUrl: string;
  sourceAttachmentUrl: string;
  sourceHtml: string;
  bannerCandidates: string[];
  stats: {
    captured: number;
    withDownload: number;
    withForum: number;
    withScreenshotList: number;
    withoutLocalAssets: number;
  };
  entries: SummaryEntry[];
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function readFirstExisting(paths: string[]) {
  for (const filePath of paths) {
    try {
      return {
        filePath,
        content: await fs.readFile(filePath, "utf8"),
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
    }
  }

  throw new Error(`Source HTML not found. Tried: ${paths.join(", ")}`);
}

function saveJson(filePath: string, value: unknown) {
  return fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sanitizeInline(value?: string | null) {
  if (!value) return undefined;
  const result = value.replace(/[\u00a0\u200b]/g, " ").replace(/\s+/g, " ").trim();
  return result || undefined;
}

function normalizeMetaText(value: string) {
  return value
    .replace(/[\u00a0\u200b]/g, " ")
    .replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10))
    .replace(/Ⅺ/g, "11")
    .replace(/Ⅹ/g, "10")
    .replace(/Ⅸ/g, "9")
    .replace(/Ⅷ/g, "8")
    .replace(/Ⅶ/g, "7")
    .replace(/Ⅵ/g, "6")
    .replace(/Ⅴ/g, "5")
    .replace(/Ⅳ/g, "4")
    .replace(/Ⅲ/g, "3")
    .replace(/Ⅱ/g, "2")
    .replace(/Ⅰ/g, "1")
    .replace(/\s+/g, " ")
    .trim();
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

function firstPositiveIndex(haystack: string, needles: string[]) {
  let result = haystack.length;

  for (const needle of needles) {
    const index = haystack.indexOf(needle);
    if (index >= 0 && index < result) {
      result = index;
    }
  }

  return result;
}

function extractField(text: string, labels: string[]) {
  const label = labels.find((value) => text.includes(value));
  if (!label) return undefined;

  const start = text.indexOf(label) + label.length;
  const rest = text.slice(start);
  const end = firstPositiveIndex(rest, META_MARKERS);
  return sanitizeInline(rest.slice(0, end));
}

function extractStreaming(text: string) {
  const combined = extractField(text, ["配信＆公開：", "《作品の配信許可／動画公開許可》"]);
  if (combined) {
    return combined;
  }

  const streaming = extractField(text, ["配信："]);
  const release = extractField(text, ["公開：", "公開；"]);

  if (streaming && release) {
    return `${streaming}／${release}`;
  }

  return streaming || release;
}

function extractCommentText($: cheerio.CheerioAPI, cell: cheerio.Cheerio<AnyNode>) {
  const clone = cell.clone();

  clone.find("br").replaceWith("\n");
  clone.find("p").each((_, element) => {
    $(element).prepend("\n");
    $(element).append("\n");
  });
  clone.find("pre").each((_, element) => {
    $(element).prepend("\n");
    $(element).append("\n");
  });
  clone.find("div").each((_, element) => {
    $(element).prepend("\n");
    $(element).append("\n");
  });

  const text = normalizeMultiline(clone.text());
  return text
    ?.replace(/^\s*作者によるコメント[:：；]?\s*/, "")
    .replace(/^\s*管理人による一言[:：；]?\s*/, "")
    .replace(/^\s*管理人によるコメント[:：；]?\s*/, "")
    .trim();
}

function toOriginalAssetUrl(localAssetPath?: string) {
  if (!localAssetPath) return undefined;
  const fileName = localAssetPath.split("/").pop();
  if (!fileName) return undefined;
  return new URL(fileName, ORIGINAL_URL).toString();
}

function padNo(no: string) {
  return no === "EX" ? "EX" : no.padStart(2, "0");
}

function buildTitle(metaText: string) {
  const entryPrefix = metaText.match(/^エントリー\s*NO\s*(?:EX|\d+)\s*[:：]\s*/i);
  if (!entryPrefix) {
    throw new Error(`Failed to locate entry prefix in: ${metaText}`);
  }

  const rest = metaText.slice(entryPrefix[0].length);
  const end = firstPositiveIndex(rest, META_MARKERS);
  const title = sanitizeInline(rest.slice(0, end));

  if (!title) {
    throw new Error(`Failed to extract title from: ${metaText}`);
  }

  return title;
}

async function main() {
  const source = await readFirstExisting(SOURCE_CANDIDATES);

  await ensureDir(CATCH_DIR);
  await ensureDir(SOURCE_DIR);
  await fs.writeFile(SOURCE_COPY_PATH, source.content, "utf8");

  const $ = cheerio.load(source.content);
  const tables = $("body > table").toArray();

  if (tables.length !== 50) {
    throw new Error(`Expected 50 top-level tables, got ${tables.length}`);
  }

  const works: WorkEntryOut[] = [];
  const summaryEntries: SummaryEntry[] = [];

  for (const table of tables) {
    try {
      const directCells = $(table).children("tbody").children("tr").first().children("td");
      if (directCells.length < 2) {
        throw new Error("Entry table missing required cells");
      }

      const previewCell = directCells.eq(0);
      const contentCell = directCells.eq(1);
      const screenshotCell = directCells.eq(2);
      const nestedRows = contentCell.find("table").first().find("tr").toArray();

      if (nestedRows.length === 0) {
        throw new Error("Entry metadata row missing");
      }

      const metaCell = $(nestedRows[0]).find("td").first();
      const metaText = normalizeMetaText(metaCell.text());
      const noMatch = metaText.match(/^エントリー\s*NO\s*(EX|\d+)/i);

      if (!noMatch) {
        throw new Error(`Failed to parse entry number from: ${metaText}`);
      }

      const rawNo = noMatch[1].toUpperCase();
      const no = padNo(rawNo);
      const title = buildTitle(metaText);
      const author = extractField(metaText, ["作者：", "作者名："]);

      if (!author) {
        throw new Error(`Failed to extract author from: ${metaText}`);
      }

      const category = extractField(metaText, ["ジャンル：", "ジャンル；", "《ジャンル》："]);
      const engine = extractField(metaText, ["ツクール："])?.replace(/\s*※.*$/, "").trim();
      const streaming = extractStreaming(metaText);
      const forum = metaCell.find("a[href*='jbbs.shitaraba.net']").first().attr("href") || undefined;

      const previewImageLocal = previewCell.find("img").first().attr("src") || undefined;
      const previewImageSource = toOriginalAssetUrl(previewImageLocal);
      const screenshotList = screenshotCell.find("a[href]").first().attr("href") || undefined;
      const screenshotPreviewLocal = screenshotCell.find("img").first().attr("src") || undefined;
      const screenshotPreviewSource = toOriginalAssetUrl(screenshotPreviewLocal);
      const downloadSource = Array.from(
        new Set(
          previewCell
            .find("a[href]")
            .map((_, element) => $(element).attr("href"))
            .get()
            .filter((value): value is string => Boolean(value))
        )
      );

      let authorComment: string | undefined;
      let hostComment: string | undefined;

      for (const row of nestedRows.slice(1)) {
        const rowCell = $(row).find("td").first();
        const rowText = rowCell.text();

        if (/作者によるコメント/.test(rowText)) {
          authorComment = extractCommentText($, rowCell);
        } else if (/管理人による(?:一言|コメント)/.test(rowText)) {
          hostComment = extractCommentText($, rowCell);
        }
      }

      const work: WorkEntryOut = {
        id: `${FESTIVAL_ID}-work-${rawNo === "EX" ? "ex" : no}`,
        festivalId: FESTIVAL_ID,
        no,
        title,
        author,
      };

      if (category) work.category = category;
      if (engine) work.engine = engine;
      if (streaming) work.streaming = streaming;
      if (downloadSource[0]) {
        work.download = {
          url: downloadSource[0],
        };
      }
      if (forum) work.forum = forum;
      if (authorComment) work.authorComment = authorComment;
      if (hostComment) work.hostComment = hostComment;

      works.push(work);
      summaryEntries.push({
        index: no,
        status: "ok",
        title,
        previewImageSource,
        screenshotList,
        screenshotPreviewSource,
        forum,
        downloadSource,
        note: "Recovered from the atwiki-attached saved HTML. Local icon and screenshot assets were not recovered.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summaryEntries.push({
        index: String(summaryEntries.length),
        status: "error",
        error: message,
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
    sourceOriginalUrl: ORIGINAL_URL,
    sourceAttachmentUrl: ATTACHMENT_URL,
    sourceHtml: path.relative(process.cwd(), SOURCE_COPY_PATH).replace(/\\/g, "/"),
    bannerCandidates: [
      new URL("vipsun2016b.png", ORIGINAL_URL).toString(),
      new URL("vipsun2016b2.png", ORIGINAL_URL).toString(),
    ],
    stats: {
      captured: works.length,
      withDownload: works.filter((entry) => Boolean(entry.download?.url)).length,
      withForum: works.filter((entry) => Boolean(entry.forum)).length,
      withScreenshotList: summaryEntries.filter((entry) => Boolean(entry.screenshotList)).length,
      withoutLocalAssets: works.length,
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
