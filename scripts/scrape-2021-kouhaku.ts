import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const FESTIVAL_ID = "2021-kouhaku";
const FESTIVAL_SLUG = "2021-kouhaku";
const SITE_BASE = "https://w.atwiki.jp/vipkohaku2021";
const LIST_URL = `${SITE_BASE}/pages/113.html`;
const HOME_URL = `${SITE_BASE}/pages/1.html`;

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
const SMALL_IMAGE_LIMIT = 100; // <100px => icon/thumbnail

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)" +
  " Chrome/130.0.0.0 Safari/537.36";

interface IndexItem {
  pageUrl: string; // absolute detail page URL
  no?: string;
  iconUrl?: string; // from list (fallback)
  title?: string;
  author?: string;
  category?: string;
  engine?: string;
  hostComment?: string;
  forumUrl?: string;
}

interface DetailData {
  no?: string; // e.g., 07
  title?: string;
  author?: string;
  category?: string;
  engine?: string;
  streaming?: string;
  forum?: string;
  downloadSource?: string[];
  iconCandidate?: string; // abs url
  screenshots: string[]; // abs urls
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

interface WorkOut {
  id: string;
  festivalId: string;
  no?: string;
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

interface SummaryItem {
  index: string; // same as no (or page index if missing)
  status: "ok" | "error";
  title?: string;
  icon?: string;
  downloadSource?: string[];
  screenshotReport?: { saved: number; skipped?: ScreenshotSkip[]; failures?: string[] };
  error?: string;
}

function sanitizeWhitespace(v?: string | null) {
  if (!v) return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t || undefined;
}

function sanitizeMultiline(v?: string | null) {
  if (!v) return undefined;
  return v
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n") || undefined;
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function fetchText(url: string) {
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
}

async function fetchBinary(url: string) {
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
}

function looksLikeImageBuffer(buffer: Buffer, contentType: string) {
  if (contentType.startsWith("image/")) return true;
  if (buffer.length >= 4) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true; // PNG
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return true; // JPEG
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return true; // GIF
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) return true; // BMP
  }
  return false;
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

async function saveBanner() {
  try {
    const home = await fetchText(HOME_URL);
    await ensureDir(CATCH_DIR);
    await fs.writeFile(path.join(CATCH_DIR, "home.html"), home, "utf8");
    const $ = cheerio.load(home);
    const src = $('img[src*="header"]').first().attr("src");
    if (!src) return;
    const abs = new URL(src, HOME_URL).toString();
    const { buffer, contentType } = await fetchBinary(abs);
    if (!looksLikeImageBuffer(buffer, contentType)) return;
    await ensureDir(BANNERS_DIR);
    const ext = getImageExtension(abs, ".png");
    await fs.writeFile(path.join(BANNERS_DIR, `${FESTIVAL_SLUG}${ext}`), buffer);
  } catch (err) {
    console.warn("Failed to save banner:", err);
  }
}

async function parseList(): Promise<IndexItem[]> {
  const html = await fetchText(LIST_URL);
  await ensureDir(CATCH_DIR);
  await fs.writeFile(path.join(CATCH_DIR, "list.html"), html, "utf8");
  const $ = cheerio.load(html);

  const items: IndexItem[] = [];
  const seen = new Set<string>();

  // Prefer the list table rows for canonical fields
  const listTable = $('table').filter((_, t) => $(t).find('th,strong').filter((_, el) => /作品一覧/.test($(el).text())).length > 0).first();
  const rows = (listTable.length ? listTable : $('table')).find('tr');

  rows.each((_, tr) => {
    const row = $(tr);
    const tds = row.find('td,th');
    if (tds.length < 5) return;
    const noText = (tds.eq(0).text() || '').trim();
    if (!/^\d{1,2}$/.test(noText)) return;
    const no = noText.padStart(2, '0');

    const iconImg = tds.eq(1).find('img').first();
    const iconUrl = iconImg.attr('src') ? new URL(iconImg.attr('src')!, LIST_URL).toString() : undefined;

    const link = tds.eq(2).find('a').first();
    const pageHref = link.attr('href') || '';
    const pageAbs = pageHref ? new URL(pageHref, LIST_URL).toString() : '';
    if (!/\/pages\/\d+\.html#id_/i.test(pageAbs)) return;
    if (seen.has(pageAbs)) return;
    seen.add(pageAbs);

    const parts = (link.html() || '').split(/<br\s*\/?\s*>/i).map(s => cheerio.load('<x>'+s+'</x>')('x').text().trim()).filter(Boolean);
    const title = parts[0];
    const author = parts[1];

    const catCell = tds.eq(3);
    const hostComment = (catCell.attr('title') || '').trim() || undefined;
    const catParts = (catCell.html() || '').split(/<br\s*\/?\s*>/i).map(s => cheerio.load('<x>'+s+'</x>')('x').text().trim()).filter(Boolean);
    const category = catParts[0];
    const engine = catParts[1];

    const forumA = tds.eq(4).find('a').first();
    const forumUrl = forumA && /感想/.test(forumA.text() || '') && forumA.attr('href') ? new URL(forumA.attr('href')!, LIST_URL).toString() : undefined;

    items.push({ pageUrl: pageAbs, no, iconUrl, title, author, category, engine, hostComment, forumUrl });
  });

  return items;
}

function stripLabel(line: string, label: string) {
  // Remove labels like 'タイトル' or '作者' at start, optionally followed by a colon and spaces
  const re = new RegExp(`^${label}[\u3000\s]*[：:]*[\u3000\s]*`);
  return line.replace(re, "").trim();
}

async function parseDetail(url: string, listIcon?: string): Promise<DetailData> {
  try {
    const html = await fetchText(url);
    const label = url.split("/").pop() || "page.html";
    await fs.writeFile(path.join(CATCH_DIR, label), html, "utf8");
    const $ = cheerio.load(html);

    const d: DetailData = { screenshots: [] };

    // Current page id used to filter attachments strictly to this entry
    const pageIdMatch = url.match(/\/pages\/(\d+)\.html/i);
    const pageId = pageIdMatch ? pageIdMatch[1] : undefined;

    // 1) Try to read the No from header text 'エントリーNo7'
    const entryHeader = $("* :contains('エントリーNo')").filter((_, el) => $(el).text().trim().match(/エントリーNo\s*\d+/)).first();
    const noMatch = entryHeader.text().match(/エントリーNo\s*(\d+)/);
    if (noMatch) d.no = noMatch[1].padStart(2, "0");

    // 2) Gather attachments and inline images (only this entry's attachments)
    const imgSet = new Set<string>();
    $("img").each((_, img) => {
      const src = $(img).attr("src") || "";
      if (!src) return;
      const abs = new URL(src, url).toString();
      if (!/\.(png|jpe?g|gif|bmp)$/i.test(abs)) return;
      if (/counter_img\.php/.test(abs)) return;
      // Exclude wiki chrome assets and other pages' headers
      const isAtwikiCommon = abs.includes("/common/_img/");
      const isHeaderImage = /\/attach\/11\/\d+\/header\.(png|jpe?g|gif)$/i.test(abs);
      const isThisEntryAttachment = pageId
        ? new RegExp(`/attach/${pageId}/`, "i").test(abs)
        : abs.includes("/attach/");
      if (isAtwikiCommon || isHeaderImage) return;
      if (!isThisEntryAttachment) return;
      imgSet.add(abs);
    });

    // 3) Extract fields from the description area: look for bold labels or simple text lines
    // Convert breaks to newlines for a text snapshot (limit to main content if possible)
    const contentRoot = $("#wikibody, .atwiki-main, body").first();
    const textLines: string[] = [];
    contentRoot.find("br").replaceWith("\n");
    const bodyText = contentRoot.text();
    for (const rawLine of bodyText.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      textLines.push(line);
    }

    // Prefer structured parsing of the 説明文 table
    let parsedFromTable = false;
    const descHeader = $("h2,h3,h4").filter((_, el) => $(el).text().trim().includes("説明文")).first();
    const descTable = descHeader.length ? descHeader.nextAll("table").first() : $("table").filter((_, t) => $(t).find("strong:contains('タイトル')").length > 0).first();
    if (descTable && descTable.length) {
      parsedFromTable = true;
      let seenMetaRow = false;
      let capturedDesc = false;
      descTable.find("tr").each((_, tr) => {
        const row = $(tr);
        const rowText = row.text();
        const cells = row.find("td");
        if (cells.length === 0) return;
        // タイトル/作者 as label in first cell, value in second
        const firstCellText = (cells.eq(0).text() || "").trim();
        if (/^タイトル\s*$/.test(firstCellText) && cells.length >= 2) {
          d.title = (cells.eq(1).text() || "").trim() || d.title;
          return;
        }
        if (/^作者\s*$/.test(firstCellText) && cells.length >= 2) {
          d.author = (cells.eq(1).text() || "").trim() || d.author;
          return;
        }
        // Combined ジャンル/使用ツール row
        if (cells.length === 1 || cells.attr("colspan") === "2" || cells.eq(0).attr("colspan") === "2") {
          const html = row.html() || "";
          // ジャンル:xxx
          const mGenre = html.match(/ジャンル[:：]\s*([^<\n]+)/);
          if (mGenre && !d.category) d.category = mGenre[1].trim();
          const mTool = html.match(/(使用)?ツール\s*[:：]\s*([^<\n]+)/);
          if (mTool && !d.engine) d.engine = mTool[2].trim();
          // Long description block (author comment)
          const cleaned = $("<div>" + html + "</div>").find("br").replaceWith("\n").end().text().trim();
          if (
            cleaned &&
            !/公開先/.test(cleaned) &&
            !/プレイ時間/.test(cleaned) &&
            !/ジャンル/.test(cleaned) &&
            !/ツール/.test(cleaned) &&
            !capturedDesc
          ) {
            d.authorComment = cleaned;
            capturedDesc = true;
          }
          return;
        }
      });
      // Fallback: if authorComment still empty, collect any large free-text cells
      if (!d.authorComment) {
        const candidates: string[] = [];
        descTable.find('td').each((_, td) => {
          const text = $(td).clone().find('br').replaceWith('\n').end().text().trim();
          if (!text) return;
          if (/公開先|感想掲示板|タイトル|作者|ジャンル|ツール|使用ツール|プレイ時間/.test(text)) return;
          if (text.length >= 40) candidates.push(text);
        });
        if (candidates.length) d.authorComment = candidates.join('\n');
      }
      // Streaming line often follows the table in a <strong>
      const streamLine = descTable.nextAll().slice(0, 10).find("strong").filter((_, el) => /配信|動画/.test($(el).text())).first();
      if (streamLine && streamLine.length) d.streaming = streamLine.text().trim();
    }

    // Fallbacks from plain text if table parsing failed
    if (!parsedFromTable) {
      const titleLine = textLines.find((l) => /^\s*タイトル/.test(l));
      if (titleLine) d.title = stripLabel(titleLine, "タイトル");
      const authorLine = textLines.find((l) => /^\s*作者/.test(l));
      if (authorLine) d.author = stripLabel(authorLine, "作者");
      const genreLine = textLines.find((l) => /^\s*ジャンル/.test(l));
      if (genreLine) d.category = stripLabel(genreLine, "ジャンル");
      const toolLine = textLines.find((l) => /^\s*(使用)?ツール/.test(l));
      if (toolLine) d.engine = stripLabel(toolLine, toolLine.includes("使用ツール") ? "使用ツール" : "ツール");
      const streamingLine = textLines.find((l) => /配信/.test(l) || /動画/.test(l) || /配信も動画もいいよ/.test(l));
      if (streamingLine) {
        if (streamingLine.includes("配信も動画もいいよ")) d.streaming = "配信も動画もいいよ";
        else d.streaming = stripLabel(streamingLine, "配信");
      }
      // author comment fallback via 紹介
      const introIdx = textLines.findIndex((l) => /^\s*紹介/.test(l));
      if (introIdx !== -1) {
        const after = textLines.slice(introIdx + 1);
        const stopIdx = after.findIndex((l) => /^(タイトル|作者|ジャンル|ツール|使用ツール|配信)/.test(l));
        const payload = (stopIdx === -1 ? after : after.slice(0, stopIdx)).join("\n").trim();
        if (payload) d.authorComment = payload;
      }
    }

    // Host comment optionally present
    const hostNode = $("*:contains('管理人コメント')").filter((_, el) => $(el).children().length === 0 && /管理人コメント/.test($(el).text())).first();
    if (hostNode && hostNode.length) {
      const txt = hostNode.text().trim();
      const m = txt.match(/管理人コメント[「『]?(.*?)[」』]?$/);
      if (m && m[1]) d.hostComment = m[1].trim();
    }

    // forum link
    const forumHref = $("a").filter((_, a) => /感想掲示板/.test($(a).text())).first().attr("href");
    if (forumHref) d.forum = new URL(forumHref, url).toString();

    // download entry links under "公開先" or any links on page dXX
    const downloadRefs: string[] = [];
    $("a").each((_, a) => {
      const t = ($(a).text() || "").trim();
      const href = $(a).attr("href") || "";
      if (/^d\d+$/i.test(t) || /公開先/.test(t)) {
        try { downloadRefs.push(new URL(href || url, url).toString()); } catch {}
      }
    });
    if (downloadRefs.length > 0) d.downloadSource = Array.from(new Set(downloadRefs));

    // Prefer list icon fallback if we find no small attachment
    if (listIcon) d.iconCandidate = listIcon;

    d.screenshots = Array.from(imgSet);
    return d;
  } catch (err) {
    console.warn("Failed to parse detail page", url, err);
    return { screenshots: [] };
  }
}

async function copyIcon(no: string | undefined, sources: string[]): Promise<string | undefined> {
  await ensureDir(ICONS_DIR);
  // Try to find a small image among sources
  let chosen: { url: string; buffer: Buffer } | undefined;
  for (const src of sources) {
    try {
      const { buffer, contentType } = await fetchBinary(src);
      if (!looksLikeImageBuffer(buffer, contentType)) continue;
      const dims = getImageDimensions(buffer);
      if (dims && dims.width < SMALL_IMAGE_LIMIT && dims.height < SMALL_IMAGE_LIMIT) {
        chosen = { url: src, buffer };
        break;
      }
    } catch {}
  }
  if (!chosen) return undefined;
  const ext = getImageExtension(chosen.url, ".png");
  const index = no ?? "xx";
  const file = `${index}${ext}`;
  await fs.writeFile(path.join(ICONS_DIR, file), chosen.buffer);
  return path.posix.join(RELATIVE_ICONS_DIR, file);
}

async function purgeEntryScreenshots(no: string) {
  try {
    const files = await fs.readdir(SCREENSHOTS_DIR);
    await Promise.all(
      files.filter((f) => f.startsWith(no)).map((f) => fs.unlink(path.join(SCREENSHOTS_DIR, f)).catch(() => undefined))
    );
  } catch {}
}

async function copyScreenshots(no: string, sources: string[]): Promise<DownloadResult> {
  await ensureDir(SCREENSHOTS_DIR);
  await purgeEntryScreenshots(no);
  const skipped: ScreenshotSkip[] = [];
  const failures: string[] = [];
  const saved: string[] = [];
  const hashSet = new Set<string>();

  let order = 1;
  for (const src of sources) {
    if (saved.length >= MAX_SCREENSHOTS) break;
    try {
      const { buffer, contentType } = await fetchBinary(src);
      if (!looksLikeImageBuffer(buffer, contentType)) {
        failures.push(`${src} (not image: ${contentType || "unknown"})`);
        continue;
      }
      const dims = getImageDimensions(buffer);
      if (dims && dims.width < SMALL_IMAGE_LIMIT && dims.height < SMALL_IMAGE_LIMIT) {
        skipped.push({ source: src, reason: "small" });
        continue;
      }
      const md5 = createHash("md5").update(buffer).digest("hex");
      if (hashSet.has(md5)) {
        skipped.push({ source: src, reason: "duplicate" });
        continue;
      }
      hashSet.add(md5);
      const ext = getImageExtension(src, ".png");
      const file = order === 1 ? `${no}${ext}` : `${no}-${String(order).padStart(2, "0")}${ext}`;
      await fs.writeFile(path.join(SCREENSHOTS_DIR, file), buffer);
      saved.push(path.posix.join(RELATIVE_SCREENSHOTS_DIR, file));
      order += 1;
    } catch (err) {
      failures.push(`${src} => ${(err as Error).message}`);
    }
  }

  return { paths: saved, skipped, failures };
}

async function run() {
  await ensureDir(CATCH_DIR);
  await ensureDir(BANNERS_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);

  await saveBanner();

  const list = await parseList();

  const works: WorkOut[] = [];
  const summary: SummaryItem[] = [];

  for (const item of list) {
    const detail = await parseDetail(item.pageUrl, item.iconUrl);
    const index = item.no || detail.no || (item.pageUrl.match(/(\d+)\.html/)?.[1] ?? "");

    // Build icon candidates: prefer list icon; then small attachments
    const iconCandidates: string[] = [];
    if (item.iconUrl) iconCandidates.push(item.iconUrl);
    for (const src of detail.screenshots) {
      const lower = src.toLowerCase();
      if (lower.includes("icon") || lower.includes("%e3%82%a2%e3%82%a4%e3%82%b3%e3%83%b3")) iconCandidates.push(src);
    }
    const iconLocal = await copyIcon(index, iconCandidates);

    // Screenshots: big images (detail.screenshots), filtered and deduped
    const ssNo = (detail.no || item.no) ?? index;
    const screenshotResult = ssNo ? await copyScreenshots(ssNo, detail.screenshots) : { paths: [], skipped: [], failures: [] } as any;

    const work: WorkOut = {
      id: `${FESTIVAL_ID}-work-${index}`,
      festivalId: FESTIVAL_ID,
      no: index,
      title: sanitizeWhitespace(item.title) ?? sanitizeWhitespace(detail.title) ?? `Work ${index}`,
      author: sanitizeWhitespace(item.author) ?? sanitizeWhitespace(detail.author) ?? "",
      category: sanitizeWhitespace(item.category) ?? sanitizeWhitespace(detail.category),
      engine: sanitizeWhitespace(item.engine) ?? sanitizeWhitespace(detail.engine),
      streaming: sanitizeWhitespace(detail.streaming),
      forum: item.forumUrl ?? detail.forum,
      authorComment: sanitizeMultiline(detail.authorComment),
      hostComment: sanitizeMultiline(detail.hostComment ?? item.hostComment),
      icon: iconLocal,
      ss: screenshotResult.paths.length > 0 ? screenshotResult.paths : undefined,
    };
    works.push(work);

    summary.push({
      index: detail.no ?? index,
      status: "ok",
      title: work.title,
      icon: iconLocal,
      downloadSource: detail.downloadSource,
      screenshotReport: { saved: screenshotResult.paths.length, skipped: screenshotResult.skipped.length ? screenshotResult.skipped : undefined, failures: screenshotResult.failures.length ? screenshotResult.failures : undefined },
    });
  }

  await fs.writeFile(OUTPUT_WORKS, JSON.stringify(works, null, 2), "utf8");
  await fs.writeFile(SUMMARY_PATH, JSON.stringify(summary, null, 2), "utf8");
  console.log(`Saved works to ${OUTPUT_WORKS}`);
  console.log(`Summary written to ${SUMMARY_PATH}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
