import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const FESTIVAL_ID = "2020-kouhaku";
const FESTIVAL_SLUG = "2020-kouhaku";
const BASE_URL = "https://viprpg2020kohaku.xxxxxxxx.jp";
const INDEX_URL = `${BASE_URL}/`;

const OUTPUT_WORKS = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const CATCH_DIR = path.join(process.cwd(), "catch", FESTIVAL_SLUG);
const SUMMARY_PATH = path.join(CATCH_DIR, `${FESTIVAL_SLUG}-scrape-summary.json`);

const PUBLIC_DIR = path.join(process.cwd(), "public");
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
  no: string; // raw
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
  authorComment?: string;
  hostComment?: string;
  screenshots?: string[];
  hostIcons?: string[]; // absolute URLs of small icon images found in host comment cell
  hostHtml?: string; // raw HTML of the host comment cell
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
  const lines = v.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const out = lines.join("\n").trim();
  return out || undefined;
}

async function ensureDir(dir: string) { await fs.mkdir(dir, { recursive: true }); }

async function fetchText(url: string) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, cache: "no-store", redirect: "follow", referrerPolicy: "no-referrer" } as RequestInit);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

async function fetchBinary(url: string) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, cache: "no-store", redirect: "follow", referrerPolicy: "no-referrer" } as RequestInit);
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
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) { return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }; }
  if (buffer.length >= 26 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) { while (offset < buffer.length && buffer[offset] !== 0xff) offset++; if (offset + 1 >= buffer.length) break; const marker = buffer[offset + 1]; offset += 2; if (marker === 0xd8 || marker === 0xd9) continue; if (marker === 0xda) break; if (offset + 7 >= buffer.length) break; const length = buffer.readUInt16BE(offset); if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xcc) { if (offset + 5 >= buffer.length) break; const height = buffer.readUInt16BE(offset + 3); const width = buffer.readUInt16BE(offset + 5); return { width, height }; } offset += length; }
  }
  if (buffer.length >= 10 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) { return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }; }
  if (buffer.length >= 26 && buffer[0] === 0x42 && buffer[1] === 0x4d) { const width = buffer.readInt32LE(18); const height = Math.abs(buffer.readInt32LE(22)); return { width, height }; }
  return undefined;
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
    const engine = line(/【使用ツール】([^\n]+)/);
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
      if (!u) return; const abs = new URL(u, url).toString(); if (!/\.(png|jpe?g|gif|bmp)$/i.test(abs)) return; if (abs.toLowerCase().includes("counter_img.php")) return; shotSet.add(abs);
    };
    table.find("img").each((_, img) => {
      const el = $(img); addIfImage(el.attr("src")); const over = el.attr("onmouseover"); const out = el.attr("onmouseout");
      for (const v of [over, out]) { if (!v) continue; const m = v.match(/['\"]([^'\"]+\.(?:png|jpe?g|gif|bmp))['\"]/i); if (m) addIfImage(m[1]); }
    });
    if (shotSet.size) result.screenshots = Array.from(shotSet);
    const textOf = (label: string) => {
      const cell = table.find(`td:contains(${label})`).filter((_, el) => $(el).text().trim().startsWith(label)).first();
      if (!cell.length) return undefined; const raw = cell.html() || cell.text(); const withBr = raw.replace(/<br\s*\/?>(\s*)/gi, "\n"); const plain = cheerio.load(`<div>${withBr}</div>`)('div').text(); return sanitizeMultiline(plain.replace(new RegExp(`^${label}[\u3000\s]*[：:]*[\u3000\s]*`), ""));
    };
    // 作者评论
    result.authorComment = textOf("作者コメント");
    // 主催评论：2020 页通常在作者评论下一行，包含角色图标(img/icon/)的那一格
    // 目标：保留原始 HTML 结构（<img> + 文本 + <br>），后续将 <img src> 替换为本地路径
    let hostFromIconCell: string | undefined;
    let hostIconSrcs: string[] = [];
    try {
      const authorTr = table.find('td').filter((_, el) => $(el).text().trim().startsWith('作者コメント')).closest('tr');
      let hostTd = authorTr.length
        ? authorTr.nextAll('tr').find('td:has(img[src*="/img/icon/"])').first()
        : table.find('td:has(img[src*="/img/icon/"])').first();
      if (hostTd && hostTd.length) {
        const htmlCell = hostTd.clone();
        // 采集图标绝对 URL，并将 HTML 中的 img 替换为占位符，便于后续按序替换为本地路径
        const imgs = htmlCell.find('img');
        let order = 1;
        imgs.each((_, img) => {
          const src = $(img).attr('src') || '';
          if (src) {
            try { hostIconSrcs.push(new URL(src, url).toString()); } catch {}
          }
          // 规范化属性，移除内联尺寸，仅保留 alt 和 src（后续替换）
          const alt = $(img).attr('alt') || '';
          $(img).attr('alt', alt);
          $(img).removeAttr('width').removeAttr('height');
          $(img).attr('src', `__HOST_ICON_${String(order).padStart(2, '0')}__`);
          order += 1;
        });
        // hostHtml 模板：包含 <img src="__HOST_ICON_01__"> + 文本 + <br> 的原始结构
        result.hostHtml = (htmlCell.html() || '').trim() || undefined;
        // 纯文本备用：换行替换 <br> 后提取文本
        const textClean = hostTd.clone().find('br').replaceWith('\n').end().text().trim();
        hostFromIconCell = sanitizeMultiline(textClean);
      }
    } catch {}
    // 若存在“管理人コメント”标签也尝试作为后备
    const hostFromLabel = textOf("管理人コメント");
    result.hostComment = hostFromIconCell || hostFromLabel;
    if (hostIconSrcs.length) result.hostIcons = Array.from(new Set(hostIconSrcs));
    return result;
  } catch { return {}; }
}

async function copyIcon(index: string, source?: string): Promise<string | undefined> {
  if (!source) return undefined;
  await ensureDir(ICONS_DIR);
  try {
    const { buffer, contentType } = await fetchBinary(source);
    if (!looksLikeImageBuffer(buffer, contentType)) return undefined;
    const ext = getImageExtension(source, ".png");
    const file = `${index}${ext}`;
    await fs.writeFile(path.join(ICONS_DIR, file), buffer);
    return path.posix.join(RELATIVE_ICONS_DIR, file);
  } catch { return undefined; }
}

async function copyHostIcons(index: string, sources: string[] | undefined): Promise<string[] | undefined> {
  if (!sources || sources.length === 0) return undefined;
  await ensureDir(ICONS_DIR);
  const saved: string[] = [];
  let i = 1;
  for (const src of sources) {
    try {
      const { buffer, contentType } = await fetchBinary(src);
      if (!looksLikeImageBuffer(buffer, contentType)) continue;
      const ext = getImageExtension(src, ".png");
      const file = `host-${index}-${String(i).padStart(2, '0')}${ext}`;
      await fs.writeFile(path.join(ICONS_DIR, file), buffer);
      saved.push(path.posix.join(RELATIVE_ICONS_DIR, file));
      i += 1;
    } catch {}
  }
  return saved.length > 0 ? saved : undefined;
}

async function copyScreenshots(index: string, sources: string[]): Promise<{ paths: string[]; skipped: ScreenshotSkip[]; failures: string[] }> {
  await ensureDir(SCREENSHOTS_DIR);
  const skipped: ScreenshotSkip[] = [];
  const failures: string[] = [];
  const saved: string[] = [];
  const hashSet = new Set<string>();
  let order = 1;
  for (const src of sources) {
    if (saved.length >= MAX_SCREENSHOTS) break;
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
    } catch (e) { failures.push(src + " => " + (e as Error).message); }
  }
  return { paths: saved, skipped, failures };
}

async function run() {
  await ensureDir(CATCH_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);

  const html = await fetchText(INDEX_URL);
  await fs.writeFile(path.join(CATCH_DIR, "index.html"), html, "utf8");
  const list = parseIndex(html);

  const works: WorkEntryOut[] = [];
  const summary: SnapshotRecord[] = [];

  for (const e of list) {
    const detail = await parseDetail(e.detailUrl);
    const iconLocal = await copyIcon(e.index, e.iconUrl);
    const hostIconsLocal = await copyHostIcons(e.index, detail.hostIcons);
    const sources = new Set<string>();
    if (detail.screenshots) detail.screenshots.forEach((s) => sources.add(s));
    if (sources.size === 0 && e.thumbUrl) sources.add(e.thumbUrl);
    const shotResult = await copyScreenshots(e.index, Array.from(sources));

    // 构造 hostComment：优先使用 HTML 模板 + 本地图标；否则回退到纯文本
    let hostCommentHtml: string | undefined;
    if (detail.hostHtml && hostIconsLocal && hostIconsLocal.length) {
      let html = detail.hostHtml;
      hostIconsLocal.forEach((local, i) => {
        const idx = String(i + 1).padStart(2, '0');
        html = html.replace(new RegExp(`__HOST_ICON_${idx}__`, 'g'), local);
      });
      // 万一存在比已保存图标更多的占位符，清理为无 src 的占位以免破图
      html = html.replace(/__HOST_ICON_\d{2}__/g, '');
      hostCommentHtml = html;
    }

    const work: WorkEntryOut = {
      id: `${FESTIVAL_ID}-work-${e.index}`,
      festivalId: FESTIVAL_ID,
      no: e.no,
      title: e.title,
      author: e.author,
      category: e.category,
      engine: e.engine,
      streaming: e.streaming,
      forum: e.forum,
      authorComment: detail.authorComment,
      hostComment: hostCommentHtml ?? detail.hostComment,
      icon: iconLocal,
      ss: shotResult.paths.length > 0 ? shotResult.paths : undefined,
    };
    works.push(work);

    summary.push({
      index: e.index,
      status: "ok",
      title: e.title,
      icon: iconLocal,
      downloadSource: e.downloadUrl ? [e.downloadUrl] : undefined,
      screenshotReport: { saved: shotResult.paths.length, skipped: shotResult.skipped.length ? shotResult.skipped : undefined, failures: shotResult.failures.length ? shotResult.failures : undefined },
      // host comment icons saved locally (for audit/reference only)
      ...(hostIconsLocal ? { hostCommentImages: hostIconsLocal } as any : {}),
    });
  }

  await fs.writeFile(OUTPUT_WORKS, JSON.stringify(works, null, 2), "utf8");
  await fs.writeFile(SUMMARY_PATH, JSON.stringify(summary, null, 2), "utf8");
  console.log(`Saved works to ${OUTPUT_WORKS}`);
  console.log(`Summary written to ${SUMMARY_PATH}`);
}

run().catch((err) => { console.error(err); process.exit(1); });
