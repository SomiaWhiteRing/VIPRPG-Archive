import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

const FESTIVAL_ID = "2022-kouhaku";
const FESTIVAL_SLUG = "2022-kouhaku";
const BASE_URL = "https://viprpg2022kohaku.x.2nt.com";
// We will always start from a Wayback snapshot of the top page
const INDEX_WB_TS = "20240325002843"; // observed snapshot with entries list on front page
const INDEX_URL = `https://web.archive.org/web/${INDEX_WB_TS}/https://viprpg2022kohaku.x.2nt.com/`;

const OUTPUT_WORKS = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const CATCH_DIR = path.join(process.cwd(), "catch", FESTIVAL_SLUG);
const SUMMARY_PATH = path.join(CATCH_DIR, `${FESTIVAL_SLUG}-scrape-summary.json`);

const PUBLIC_DIR = path.join(process.cwd(), "public");
const BANNERS_DIR = path.join(PUBLIC_DIR, "banners");
const ICONS_DIR = path.join(PUBLIC_DIR, "icons", FESTIVAL_SLUG);
const SCREENSHOTS_DIR = path.join(PUBLIC_DIR, "screenshots", FESTIVAL_SLUG);

const RELATIVE_BANNERS_DIR = "/banners";
const RELATIVE_ICONS_DIR = `/icons/${FESTIVAL_SLUG}`;
const RELATIVE_SCREENSHOTS_DIR = `/screenshots/${FESTIVAL_SLUG}`;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

interface IndexEntry {
  index: string; // numeric string
  title: string;
  authorMaybe?: string;
  iconUrl?: string; // Wayback proxied
  mainScreenshotUrl?: string; // Wayback proxied
  detailUrl?: string; // Wayback proxied
}

interface DetailEntry {
  author?: string;
  category?: string;
  engine?: string;
  streaming?: string;
  forumUrl?: string;
  downloadUrl?: string;
  downloadLabel?: string;
  authorComment?: string;
  hostComment?: string;
  screenshots: string[]; // Wayback proxied absolute URLs
}

interface WorkOut {
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

interface ScreenshotSkip { source: string; reason: "small" | "duplicate" }

interface SnapshotRecord {
  index: string;
  status: "ok" | "error";
  title?: string;
  icon?: string;
  note?: string;
  downloadSource?: string[];
  screenshotReport?: { saved: number; skipped?: ScreenshotSkip[]; failures?: string[] };
  error?: string;
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function fetchText(url: string) {
  let last: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Connection: "close",
        },
        redirect: "follow",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      } as any);
      if (!(res as any).ok) throw new Error(`HTTP ${(res as any).status} for ${url}`);
      return await (res as any).text();
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  // curl fallback
  try {
    const args = [
      "-sSL",
      "--fail",
      "--http1.1",
      "-A",
      USER_AGENT,
      "-H",
      "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      url,
    ];
    const { stdout } = await execFileAsync("curl", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    return stdout;
  } catch (err2) {
    last = err2;
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function fetchBinary(url: string) {
  let last: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          Connection: "close",
        },
        redirect: "follow",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      } as any);
      if (!(res as any).ok) throw new Error(`HTTP ${(res as any).status} for ${url}`);
      const ab = await (res as any).arrayBuffer();
      return Buffer.from(ab);
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  // curl fallback
  try {
    const args = ["-sSL", "--fail", "--http1.1", "-A", USER_AGENT, url];
    const { stdout } = await execFileAsync("curl", args, { encoding: "buffer", maxBuffer: 100 * 1024 * 1024 as any });
    // @ts-ignore
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } catch (err2) {
    last = err2;
  }
  throw last instanceof Error ? last : new Error(String(last));
}

function sanitizeWhitespace(value: string | undefined | null) {
  if (!value) return undefined;
  const result = value.replace(/\s+/g, " ").trim();
  return result || undefined;
}

function sanitizeMultiline(value: string | undefined | null) {
  if (!value) return undefined;
  const trimmed = value
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return trimmed || undefined;
}

function toAbsolute(url: string | undefined) {
  if (!url) return undefined;
  try { return new URL(url, INDEX_URL).toString(); } catch { return undefined; }
}

async function loadIndex(): Promise<string> {
  await ensureDir(CATCH_DIR);
  const file = path.join(CATCH_DIR, "index.html");
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    const html = await fetchText(INDEX_URL);
    await fs.writeFile(file, html, "utf8");
    return html;
  }
}

function parseIndex(html: string): IndexEntry[] {
  const $ = cheerio.load(html);
  const entries: IndexEntry[] = [];
  // The front page includes the list under <ol class="entries"> with .entry-card
  $("ol.entries > li.entry-card").each((_, li) => {
    const $li = $(li);
    const $a = $li.find("a").first();
    const detailUrl = $a.attr("href") || undefined;
    const $h3 = $a.find("h3.entry-title").first();
    let index = $h3.attr("id") || "";
    index = index.trim();
    const title = ($h3.text() || "").replace(/^\s*\d+\s*/, "").trim();
    const iconUrl = $h3.find("img").attr("src") || undefined;
    const mainScreenshotUrl = $li.attr("data-src") || undefined;
    // Author hint: second li in .entry-list-info
    let authorMaybe: string | undefined;
    const $lis = $a.find("ul.entry-list-info > li");
    if ($lis.length >= 2) {
      authorMaybe = ($lis.eq(1).text() || "").trim();
    }
    if (!index || !title) return;
    entries.push({ index, title, authorMaybe, iconUrl, mainScreenshotUrl, detailUrl });
  });
  // sort by numeric index
  entries.sort((a, b) => parseInt(a.index, 10) - parseInt(b.index, 10));
  return entries;
}

function textFrom($: cheerio.CheerioAPI, el: cheerio.Cheerio<any>) {
  return (el.text() || "").replace(/\s+/g, " ").trim();
}

function extractDD($: cheerio.CheerioAPI, $dl: cheerio.Cheerio<any>, label: string): string | undefined {
  let out: string | undefined;
  $dl.find("dt").each((_, dt) => {
    const $dt = $(dt);
    if (textFrom($, $dt) === label) {
      const $dd = $dt.next("dd");
      if ($dd.length) {
        // Replace <br> with newlines then strip tags
        const html = $dd.html() || "";
        const withBr = html.replace(/<br\s*\/?\s*>/gi, "\n");
        const t = cheerio.load(`<div>${withBr}</div>`)('div').text();
        out = sanitizeMultiline(t);
      }
    }
  });
  return out;
}

function collectScreenshotsFromDetail($: cheerio.CheerioAPI): string[] {
  const urls: string[] = [];
  $("img").each((_, img) => {
    const src = ($(img).attr("src") || "").trim();
    if (!src) return;
    if (/\/entries\/\d+\/screenshots\//.test(src) && !/icon/i.test(src)) {
      urls.push(src);
    }
  });
  return Array.from(new Set(urls));
}

async function loadDetail(detailUrl: string): Promise<{ html: string; ts: string }> {
  const abs = toAbsolute(detailUrl)!;
  // Extract Wayback timestamp from URL like /web/20230327172026/https://...
  const m = abs.match(/\/web\/(\d{14})\//);
  const ts = m ? m[1] : INDEX_WB_TS;
  const idx = abs.replace(/^.*\/entries\/(\d+)\/.*/, "$1");
  const file = path.join(CATCH_DIR, `entry-${idx}.html`);
  try {
    return { html: await fs.readFile(file, "utf8"), ts };
  } catch {
    // Try direct detail URL first
    try {
      const html = await fetchText(abs);
      await fs.writeFile(file, html, "utf8");
      return { html, ts };
    } catch {
      // Fall back to CDX to find a working snapshot for this entry
      const entryPath = abs.replace(/^.*\/entries\/(\d+)\/.*/, (s) => s.substring(s.indexOf("/entries/")));
      const target = `${BASE_URL}${entryPath}`;
      const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(target)}&output=json&filter=statuscode:200&filter=mimetype:text/html&fl=timestamp,original&limit=50`;
      const jsonText = await fetchText(cdxUrl);
      let tsFallback: string | undefined;
      try {
        const rows = JSON.parse(jsonText) as string[][];
        // rows[0] is header; pick the latest row
        const list = rows.slice(1);
        if (list.length) tsFallback = list[list.length - 1][0];
      } catch {}
      if (!tsFallback) throw new Error(`No snapshot via CDX for ${target}`);
      const wbUrl = `https://web.archive.org/web/${tsFallback}/` + target;
      const html = await fetchText(wbUrl);
      await fs.writeFile(file, html, "utf8");
      return { html, ts: tsFallback };
    }
  }
}

function parseDetail(html: string): DetailEntry {
  const $ = cheerio.load(html);
  const $dl = $("dl.entry-info");
  const author = extractDD($, $dl, "作者");
  const category = extractDD($, $dl, "ジャンル");
  const engineRaw = extractDD($, $dl, "ツクール");
  const engine = engineRaw?.replace(/^\s*\S+\s*/, (m) => m.includes("RPG") ? m : "").trim() || engineRaw || undefined;
  const streaming = extractDD($, $dl, "配信/投稿");
  const authorComment = extractDD($, $dl, "コメント");
  // Host comment label differs slightly
  let hostComment = extractDD($, $dl, "管理人から一言");
  if (!hostComment) hostComment = extractDD($, $dl, "主催コメント");

  // Menu: download + forum
  let downloadUrl: string | undefined;
  let downloadLabel: string | undefined;
  let forumUrl: string | undefined;
  $(".entry-menu a").each((_, a) => {
    const href = ($(a).attr("href") || "").trim();
    const text = textFrom($, $(a));
    if (/感想/.test(text) && href) forumUrl = href;
    if (/Download/i.test(text) && href) {
      downloadUrl = href;
      const small = $(a).find("small").text();
      downloadLabel = small ? small.replace(/[()]/g, "").trim() : undefined;
    }
  });

  const screenshots = collectScreenshotsFromDetail($).map((s) => toAbsolute(s)!).filter(Boolean) as string[];
  return { author, category, engine, streaming, authorComment, hostComment, forumUrl, downloadUrl, downloadLabel, screenshots };
}

async function downloadImage(url: string, outPath: string) {
  const buf = await fetchBinary(url);
  await ensureDir(path.dirname(outPath));
  await fs.writeFile(outPath, buf);
}

async function main() {
  await ensureDir(CATCH_DIR);
  await ensureDir(BANNERS_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);

  const indexHtml = await loadIndex();
  const entries = parseIndex(indexHtml);

  // Banners (from assets on the site) via Wayback
  const bannerCandidates = [
    `https://web.archive.org/web/${INDEX_WB_TS}im_/https://viprpg2022kohaku.x.2nt.com/assets/banner-kohaku-2022.png`,
    `https://web.archive.org/web/${INDEX_WB_TS}im_/https://viprpg2022kohaku.x.2nt.com/assets/banner-kohaku-2022-2.png`,
    `https://web.archive.org/web/${INDEX_WB_TS}im_/https://viprpg2022kohaku.x.2nt.com/assets/banner-kohaku-2022-3.png`,
  ];
  const bannerSaved: string[] = [];
  for (let i = 0; i < bannerCandidates.length; i++) {
    try {
      const url = bannerCandidates[i];
      const out = i === 0 ? path.join(BANNERS_DIR, `${FESTIVAL_SLUG}.png`) : path.join(BANNERS_DIR, `${FESTIVAL_SLUG}-${i + 1}.png`);
      await downloadImage(url, out);
      bannerSaved.push(path.posix.join(RELATIVE_BANNERS_DIR, path.basename(out)));
    } catch {
      // ignore missing banners
    }
  }

  const workOut: WorkOut[] = [];
  const snapshots: SnapshotRecord[] = [];

  for (const e of entries) {
    try {
      const detailAbs = toAbsolute(e.detailUrl)!;
      const { html: detailHtml } = await loadDetail(detailAbs);
      const detail = parseDetail(detailHtml);

      // Save icon
      if (e.iconUrl) {
        try {
          const iconAbs = toAbsolute(e.iconUrl)!;
          const iconExt = path.extname(new URL(iconAbs).pathname).toLowerCase() || ".png";
          const iconOut = path.join(ICONS_DIR, `${e.index}${iconExt}`);
          if (!fss.existsSync(iconOut)) {
            await downloadImage(iconAbs, iconOut);
          }
        } catch {}
      }
      // Save screenshots (from detail)
      let saved = 0;
      let idx = 0;
      for (const s of detail.screenshots) {
        const u = new URL(s);
        const ext = path.extname(u.pathname).toLowerCase() || ".png";
        const name = idx === 0 ? `${e.index}${ext}` : `${e.index}-${String(idx + 1).padStart(2, "0")}${ext}`;
        const out = path.join(SCREENSHOTS_DIR, name);
        try {
          if (!fss.existsSync(out)) {
            await downloadImage(s, out);
          }
          saved++; idx++;
        } catch {}
      }
      // Fallback: use list card main image when no detail screenshots saved
      if (saved === 0 && e.mainScreenshotUrl) {
        try {
          const abs = toAbsolute(e.mainScreenshotUrl)!;
          const ext = path.extname(new URL(abs).pathname).toLowerCase() || ".png";
          const out = path.join(SCREENSHOTS_DIR, `${e.index}${ext}`);
          if (!fss.existsSync(out)) {
            await downloadImage(abs, out);
            saved = 1;
          }
        } catch {}
      }

      const work: WorkOut = {
        id: `${FESTIVAL_SLUG}-work-${e.index}`,
        festivalId: FESTIVAL_SLUG,
        no: e.index,
        title: e.title,
        author: detail.author || "",
        category: detail.category,
        engine: detail.engine,
        streaming: detail.streaming,
        forum: detail.forumUrl,
        authorComment: detail.authorComment,
        hostComment: detail.hostComment,
        // icon path resolved below based on existing files
      };
      // resolve icon ext
      for (const ext of [".png", ".jpg", ".jpeg", ".webp"]) {
        const p = path.join(ICONS_DIR, `${e.index}${ext}`);
        if (fss.existsSync(p)) {
          work.icon = path.posix.join(RELATIVE_ICONS_DIR, `${e.index}${ext}`);
          break;
        }
      }
      const ssRel: string[] = [];
      for (const ext of [".png", ".jpg", ".jpeg", ".webp"]) {
        const p1 = path.join(SCREENSHOTS_DIR, `${e.index}${ext}`);
        if (fss.existsSync(p1)) { ssRel.push(path.posix.join(RELATIVE_SCREENSHOTS_DIR, `${e.index}${ext}`)); break; }
      }
      for (let k = 2; k <= 12; k++) {
        for (const ext of [".png", ".jpg", ".jpeg", ".webp"]) {
          const name = `${e.index}-${String(k).padStart(2, "0")}${ext}`;
          if (fss.existsSync(path.join(SCREENSHOTS_DIR, name))) { ssRel.push(path.posix.join(RELATIVE_SCREENSHOTS_DIR, name)); break; }
        }
      }
      if (ssRel.length) work.ss = ssRel;
      workOut.push(work);

      snapshots.push({
        index: e.index,
        status: "ok",
        title: e.title,
        icon: work.icon,
        note: `ダウンロード: ${detail.downloadUrl ? 1 : 0}件`,
        downloadSource: detail.downloadUrl ? [detail.downloadUrl] : [],
        screenshotReport: { saved },
      });
    } catch (err) {
      // Fallback: build a minimal work from index when detail fails
      const stub: WorkOut = {
        id: `${FESTIVAL_SLUG}-work-${e.index}`,
        festivalId: FESTIVAL_SLUG,
        no: e.index,
        title: e.title,
        author: e.authorMaybe || "",
      } as WorkOut;
      workOut.push(stub);
      snapshots.push({ index: e.index, status: "ok", title: e.title, note: "detail fetch failed; stub from index" });
    }
  }

  await ensureDir(path.dirname(OUTPUT_WORKS));
  await fs.writeFile(OUTPUT_WORKS, JSON.stringify(workOut, null, 2), "utf8");

  await ensureDir(CATCH_DIR);
  await fs.writeFile(
    SUMMARY_PATH,
    JSON.stringify(
      {
        festivalId: FESTIVAL_SLUG,
        generatedAt: new Date().toISOString(),
        banners: bannerSaved,
        stats: { captured: workOut.length, skipped: 0 },
        entries: snapshots,
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(`Updated: ${OUTPUT_WORKS}`);
  console.log(`Summary: ${SUMMARY_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
