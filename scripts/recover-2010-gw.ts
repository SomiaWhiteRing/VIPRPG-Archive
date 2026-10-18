import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { WorkDownload, WorkEntry } from "../src/lib/types";

const festivalId = "2010-gw";
const root = `catch/${festivalId}`;
const sourceRoot = `${root}/source/archive`;
const archiveBase = "https://vipkohaku.x.fc2.com/2010GW/";
const snapshot014Url = "https://web.archive.org/web/20210710122528id_/https://vipkohaku.x.fc2.com/2010GW/014.html";
const json = async <T>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, "utf8")) as T;
const writeJson = async (file: string, value: unknown) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

async function main() {
  const oldWorks = await json<WorkEntry[]>(`src/data/works/${festivalId}.json`);
  const manifest = await json<Record<string, { originalUrl: string; file: string; bytes: number }>>(`${sourceRoot}/manifest.json`);
  const sourceIndex = iconv.decode(await fs.readFile(`${sourceRoot}/index.html.bin`), "shift_jis");
  const index$ = cheerio.load(sourceIndex);
  const sourcePages = [...new Set(index$("a[href]").toArray().flatMap((anchor) => {
    try {
      const url = new URL(index$(anchor).attr("href")!, archiveBase);
      const match = url.hostname === "vipkohaku.x.fc2.com" && url.pathname.match(/^\/2010GW\/(\d{3})\.html$/);
      return match ? [match[1]] : [];
    } catch { return []; }
  }))].sort();
  const workNos = oldWorks.map((work) => work.no).filter((no): no is string => Boolean(no)).sort();
  if (oldWorks.length !== 68 || sourcePages.length !== 68 || sourcePages.some((no, i) => no !== workNos[i])) {
    throw new Error("The archived catalogue does not map exactly to the 68 existing work numbers.");
  }
  const legacyPath = `${root}/legacy-works.json`;
  try { await fs.access(legacyPath); } catch { await fs.copyFile(`src/data/works/${festivalId}.json`, legacyPath); }

  const missingImageUrls: string[] = [];
  const updated: WorkEntry[] = [];
  let downloadedLinks = 0;
  for (const old of oldWorks) {
    const sourcePath = `${old.no}.html`;
    const sourceUrl = new URL(sourcePath, archiveBase).href;
    const pageCaptured = old.no === "014";
    const work: WorkEntry = { ...old, source: { ...(old.source ?? {}), url: sourceUrl, ...(pageCaptured ? { snapshotUrl: snapshot014Url } : {}) } };
    if (pageCaptured) {
      const page = iconv.decode(await fs.readFile(`${sourceRoot}/014.html.bin`), "shift_jis");
      const $ = cheerio.load(page);
      const body = $("body").first();
      if (!body.length || body.find("script").length > 1) throw new Error("The captured No.014 page failed its structural check.");
      let imageOrdinal = 0;
      for (const image of body.find("img[src]").toArray()) {
        const url = new URL($(image).attr("src")!, sourceUrl);
        if (url.hostname === "media.fc2.com" && url.pathname === "/counter_img.php") {
          $(image).remove();
          continue;
        }
        const captured = Object.entries(manifest).find(([, value]) => value.originalUrl === url.href);
        if (!captured) {
          missingImageUrls.push(url.href);
          imageOrdinal += 1;
          $(image).replaceWith(`<span class="archive-missing-image">原資料の画像 ${String(imageOrdinal).padStart(2, "0")} は未取得です</span>`);
          continue;
        }
        imageOrdinal += 1;
        const extension = path.extname(captured[1].file).toLowerCase();
        const name = `work-${old.no}-${String(imageOrdinal).padStart(2, "0")}${extension}`;
        await fs.mkdir(`public/screenshots/${festivalId}`, { recursive: true });
        await fs.copyFile(`${sourceRoot}/${captured[1].file}`, `public/screenshots/${festivalId}/${name}`);
        work.ss = [...(work.ss ?? []), `/screenshots/${festivalId}/${name}`];
        $(image).replaceWith(`<a class="source-image-reference" href="#detail-screenshots">画像 ${String(imageOrdinal).padStart(2, "0")}（截图请查看上方）</a>`);
      }
      body.find("form,script,noscript,iframe,object,embed,style,source,canvas").remove();
      body.find("[srcset]").removeAttr("srcset");
      body.find("a[href]").each((_, anchor) => {
        const value = $(anchor).attr("href")!;
        if (value.startsWith("#")) { $(anchor).removeAttr("target"); return; }
        let url: URL;
        try { url = new URL(value, sourceUrl); } catch { $(anchor).removeAttr("href target"); return; }
        if (!["http:", "https:", "mailto:"].includes(url.protocol)) { $(anchor).removeAttr("href target"); return; }
        if (url.hostname === new URL(archiveBase).hostname && url.pathname.startsWith(new URL(archiveBase).pathname)) {
          const local = url.pathname.slice(new URL(archiveBase).pathname.length) || "index.html";
          $(anchor).attr("href", `/original-pages/${festivalId}/${local}${url.search}${url.hash}`);
        }
        $(anchor).removeAttr("target");
      });
      body.add(body.find("*")).each((_, element) => {
        for (const attribute of Object.keys(element.attribs)) {
          if (attribute.startsWith("on")) { $(element).removeAttr(attribute); continue; }
          if (["href", "class", "id", "title", "alt", "colspan", "rowspan", "scope", "align", "valign", "width", "height", "border", "cellpadding", "cellspacing", "style"].includes(attribute)) {
            if (attribute === "style" && /(?:url\s*\(|expression\s*\(|javascript:)/i.test($(element).attr(attribute) || "")) $(element).removeAttr(attribute);
            continue;
          }
          $(element).removeAttr(attribute);
        }
      });
      const downloads: WorkDownload[] = [];
      body.find("a[href]").each((_, anchor) => {
        const url = new URL($(anchor).attr("href")!, sourceUrl);
        if (url.hostname === "drive.google.com" && !downloads.some((download) => download.url === url.href)) {
          downloads.push({ url: url.href, label: $(anchor).text().trim() || "原页下载入口" });
        }
      });
      downloadedLinks += downloads.length;
      if (downloads.length > 1) work.downloads = downloads;
      else if (downloads.length === 1) work.download = downloads[0];
      work.sourceContent = body.html()?.trim() ?? "";
      delete work.detailDisabled;
    }
    updated.push(work);
  }
  if (updated.some((work) => work.contentRestricted)) throw new Error("This recovery must not create or change content restrictions.");

  const banners = ["gw2010banner01.png", "gw2010banner02.png"];
  await fs.mkdir(`public/banners/${festivalId}`, { recursive: true });
  for (const name of banners) await fs.copyFile(`${sourceRoot}/assets/${name}`, `public/banners/${festivalId}/${name}`);
  const festivalsPath = "src/data/festivals.json";
  const festivals = await json<Array<{ id: string; banners: string[] }>>(festivalsPath);
  const festival = festivals.find((entry) => entry.id === festivalId);
  if (!festival) throw new Error(`Festival registry entry ${festivalId} is missing.`);
  festival.banners = banners.map((name) => `/banners/${festivalId}/${name}`);
  const registryBytes = Buffer.from(`${JSON.stringify(festivals, null, 2)}\n`);
  const registryHandle = await fs.open(festivalsPath, "r+");
  try { await registryHandle.writeFile(registryBytes); await registryHandle.truncate(registryBytes.length); }
  finally { await registryHandle.close(); }
  await writeJson(`src/data/works/${festivalId}.json`, updated);

  const recovery = await json<Record<string, unknown>>(`${root}/recovery.json`);
  const allSourceRecords = updated.map((work) => ({ no: work.no, sourceUrl: work.source?.url, snapshotUrl: work.source?.snapshotUrl, pageCaptured: work.no === "014", detailDisabled: Boolean(work.detailDisabled) }));
  recovery.entries = allSourceRecords;
  recovery.sourceDetailGaps = allSourceRecords.filter((entry) => !entry.pageCaptured).map((entry) => ({ no: entry.no, sourcePath: `${entry.no}.html`, sourceUrl: entry.sourceUrl, reason: "No direct-source response was available and the Wayback site-wide CDX result contains no capture for this page." }));
  recovery.originalResources = Object.fromEntries(Object.entries(manifest).filter(([, value]) => /\.(?:png|jpe?g|gif|bmp|webp|css)$/i.test(value.file)).map(([, value]) => [value.originalUrl, value.file]));
  const unavailableResources = [...((recovery.unavailableResources as Array<Record<string, unknown>>) ?? [])];
  for (const resource of [...missingImageUrls.map((url) => ({ url, kind: "screenshot" })), { url: new URL("ss000.gif", archiveBase).href, kind: "source-link" }]) {
    if (!unavailableResources.some((entry) => entry.originalUrl === resource.url)) unavailableResources.push({ originalUrl: resource.url, kind: resource.kind, status: "not-captured" });
  }
  recovery.unavailableResources = unavailableResources;
  recovery.dataCapture = { works: updated.length, catalogueLinks: sourcePages.length, capturedDetailPages: 1, detailGaps: 67, screenshotFiles: updated.reduce((n, work) => n + (work.ss?.length ?? 0), 0), missingScreenshotFiles: missingImageUrls.length, missingSourceLinks: 1, downloads: downloadedLinks, banners: banners.length, manuallyReviewedEntryContent: false, manuallyAppliedRestrictions: 0 };
  recovery.desktopReview = "pending";
  await writeJson(`${root}/recovery.json`, recovery);
  await writeJson(`${root}/source-comparison.json`, { festivalId, works: updated.length, sourceCatalogueLinks: sourcePages.length, mappedWorkNumbers: sourcePages.length, capturedDetailPages: 1, detailGaps: 67, page014MissingImageCount: missingImageUrls.length, missingRootAssetLinks: 1, titleTextManuallyReviewed: false, restrictionChanges: 0 });
  console.log(JSON.stringify({ works: updated.length, sourceLinks: sourcePages.length, capturedDetailPages: 1, detailGaps: 67, screenshots: updated.reduce((n, work) => n + (work.ss?.length ?? 0), 0), downloads: downloadedLinks, banners: banners.length }, null, 2));
}

void main();
