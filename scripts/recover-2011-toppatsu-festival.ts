import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import type { WorkDownload, WorkEntry } from "../src/lib/types";

const festivalId = "2011-toppatsu-festival";
const root = `catch/${festivalId}`;
const captureRoot = `${root}/source/original`;
const publicScreenshotRoot = `public/screenshots/${festivalId}`;
const base = "https://w.atwiki.jp/toppatuviprpg/";
const json = async <T>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, "utf8")) as T;
const writeJson = async (file: string, value: unknown) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
async function main() {
  const oldWorks = await json<WorkEntry[]>(`src/data/works/${festivalId}.json`);
  const manifest = await json<Record<string, { originalUrl?: string; file?: string; bytes?: number }>>(`${captureRoot}/manifest.json`);
  const titleComparison = await json<Array<{ no: string; pageId: number; titleMatch: boolean; listMatch: boolean }>>(`${root}/investigation/title-source-comparison.json`);
  const pageAssets = new Map(Object.entries(manifest).filter(([key, value]) => /^pages\/\d+\.html$/.test(key) && value.originalUrl).map(([key, value]) => [value.originalUrl!, key]));
  const imageAssets = new Map(Object.entries(manifest).filter(([key, value]) => key.startsWith("assets/") && value.originalUrl).map(([key, value]) => [value.originalUrl!, key]));
  const bodyList = cheerio.load(await fs.readFile(`${captureRoot}/pages/13.html`, "utf8"));
  const pageIds = [...new Set(bodyList("#wikibody a[href]").toArray().flatMap((anchor) => {
    try {
      const url = new URL(bodyList(anchor).attr("href")!, base);
      const match = url.hostname === "w.atwiki.jp" && url.pathname.match(/^\/toppatuviprpg\/pages\/(\d+)\.html$/);
      const id = match ? Number(match[1]) : 0;
      return id >= 15 && id <= 40 ? [id] : [];
    } catch { return []; }
  }))].sort((a, b) => a - b);
  if (oldWorks.length !== 26 || titleComparison.length !== 26 || pageIds.length !== 26 || !titleComparison.every((entry) => entry.titleMatch && entry.listMatch)) {
    throw new Error("The source list, title comparison and legacy catalogue must agree on all 26 entries before saving.");
  }
  const legacyPath = `${root}/legacy-works.json`;
  try { await fs.access(legacyPath); } catch { await fs.copyFile(`src/data/works/${festivalId}.json`, legacyPath); }

  const workByPage = new Map(titleComparison.map((entry) => [entry.pageId, oldWorks.find((work) => work.no === entry.no)!]));
  const details: Array<{ no: string; pageId: number; sourcePath: string; titleMatch: boolean; images: number; downloads: number; sourceContentBytes: number }> = [];
  const updated: WorkEntry[] = [];
  const missingImages: Array<{ no: string; url: string }> = [];
  await fs.mkdir(publicScreenshotRoot, { recursive: true });

  for (const pageId of pageIds) {
    const old = workByPage.get(pageId);
    if (!old) throw new Error(`No legacy work maps to source page ${pageId}.`);
    const sourcePath = `pages/${pageId}.html`;
    const sourceUrl = new URL(sourcePath, base).href;
    const sourceHTML = await fs.readFile(`${captureRoot}/${sourcePath}`, "utf8");
    const $ = cheerio.load(sourceHTML);
    const body = $("#wikibody").first();
    if (!body.length || body.find("h2").length !== 1 || body.find("h2").first().text().trim() !== old.title) {
      throw new Error(`Source structure/title check failed for ${old.no}; no content was changed.`);
    }
    const screenshotPaths: string[] = [];
    let imageIndex = 0;
    for (const image of body.find("img[src]").toArray()) {
      const originalUrl = new URL($(image).attr("src")!, sourceUrl).href;
      const asset = imageAssets.get(originalUrl);
      if (!asset) { missingImages.push({ no: old.no!, url: originalUrl }); continue; }
      const extension = path.extname(asset).toLowerCase();
      if (!/^\.(?:png|jpe?g|gif|bmp|webp|svg)$/.test(extension)) throw new Error(`Unsupported captured image format for ${old.no}.`);
      imageIndex += 1;
      const targetName = `work-${old.no}-${String(imageIndex).padStart(2, "0")}${extension}`;
      const target = `${publicScreenshotRoot}/${targetName}`;
      const localPath = `/screenshots/${festivalId}/${targetName}`;
      screenshotPaths.push(localPath);
      await fs.copyFile(`${captureRoot}/${asset}`, target);
      $(image).replaceWith(`<a class="source-image-reference" href="#detail-screenshots">画像 ${String(imageIndex).padStart(2, "0")}（スクリーンショット一覧）</a>`);
    }
    if (missingImages.length) continue;

    const sanitized = body.clone();
    sanitized.find("h2,#toolBox,form,input,select,button,textarea,script,style,noscript,iframe,object,embed,source,canvas").remove();
    sanitized.find("[srcset]").removeAttr("srcset");
    sanitized.find("a[href]").each((_, anchor) => {
      const value = $(anchor).attr("href")!;
      if (value.startsWith("#")) { $(anchor).removeAttr("target"); return; }
      let url: URL;
      try { url = new URL(value, sourceUrl); } catch { $(anchor).removeAttr("href target"); return; }
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) { $(anchor).removeAttr("href target"); return; }
      const pageResource = pageAssets.get(url.href);
      if (pageResource) {
        const local = pageResource === "index.html" ? "index.html" : pageResource;
        $(anchor).attr("href", `/original-pages/${festivalId}/${local}${url.search}${url.hash}`);
      }
      $(anchor).removeAttr("target");
    });
    sanitized.add(sanitized.find("*")).each((_, element) => {
      for (const attribute of Object.keys(element.attribs)) {
        if (attribute.startsWith("on")) { $(element).removeAttr(attribute); continue; }
        if (["href", "class", "id", "title", "alt", "colspan", "rowspan", "scope", "align", "valign", "width", "height", "border", "cellpadding", "cellspacing", "style"].includes(attribute)) {
          if (attribute === "style" && /(?:url\s*\(|expression\s*\(|javascript:)/i.test($(element).attr(attribute) || "")) $(element).removeAttr(attribute);
          continue;
        }
        $(element).removeAttr(attribute);
      }
    });
    const sourceContent = sanitized.html()?.trim() ?? "";
    if (!sourceContent) throw new Error(`Source content serialization is empty for ${old.no}.`);

    const downloads: WorkDownload[] = [];
    body.find("a[href]").each((_, anchor) => {
      const url = new URL($(anchor).attr("href")!, sourceUrl);
      if ((url.hostname === "www.viprpg.org" && url.pathname === "/archive/dlcount.cgi") || url.hostname === "ux.getuploader.com") {
        if (!downloads.some((download) => download.url === url.href)) downloads.push({ url: url.href, label: $(anchor).text().trim() || "作品ダウンロード" });
      }
    });
    const work: WorkEntry = {
      ...old,
      author: old.author,
      source: { url: sourceUrl },
      sourceContent,
      ss: screenshotPaths,
      ...(downloads.length > 1 ? { downloads } : downloads.length === 1 ? { download: downloads[0] } : {}),
    };
    delete work.detailDisabled;
    updated.push(work);
    details.push({ no: old.no!, pageId, sourcePath, titleMatch: true, images: screenshotPaths.length, downloads: downloads.length, sourceContentBytes: Buffer.byteLength(sourceContent) });
  }
  if (missingImages.length) throw new Error(`${missingImages.length} source images lack captured assets; no work catalogue was saved.`);
  if (updated.length !== 26 || new Set(updated.map((work) => work.id)).size !== 26 || updated.some((work) => work.contentRestricted)) {
    throw new Error("The replacement catalogue is incomplete, duplicated or unexpectedly changed a restriction marker.");
  }
  await writeJson(`src/data/works/${festivalId}.json`, updated);
  const recovery = await json<Record<string, unknown>>(`${root}/recovery.json`);
  recovery.entries = details.map(({ no, pageId, sourcePath, ...entry }) => ({ no, pageId, sourcePath, sourceUrl: new URL(sourcePath, base).href, ...entry }));
  recovery.contentRestrictions = [];
  recovery.dataCapture = { workEntries: updated.length, sourcePages: details.length, screenshots: details.reduce((total, entry) => total + entry.images, 0), directDownloads: details.reduce((total, entry) => total + entry.downloads, 0), manuallyReviewedEntryContent: false, manuallyAppliedRestrictions: 0 };
  recovery.desktopReview = "pending";
  await writeJson(`${root}/recovery.json`, recovery);
  await writeJson(`${root}/source-comparison.json`, { festivalId, entryCount: details.length, titleMismatches: 0, sourceLinks: [{ kind: "index", url: base, localPath: "index.html" }, { kind: "list", url: new URL("pages/13.html", base).href, localPath: "pages/13.html" }, { kind: "list", url: new URL("pages/14.html", base).href, localPath: "pages/14.html" }], entries: details, manuallyReviewedEntryContent: false, sourceContentPreservedAsStructuredHTML: true });
  console.log(JSON.stringify({ entries: updated.length, screenshots: details.reduce((total, entry) => total + entry.images, 0), downloads: details.reduce((total, entry) => total + entry.downloads, 0), sourceContentBytes: details.reduce((total, entry) => total + entry.sourceContentBytes, 0) }, null, 2));
}

void main();
