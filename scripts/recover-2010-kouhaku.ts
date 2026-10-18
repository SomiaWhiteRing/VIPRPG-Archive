import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { WorkDownload, WorkEntry } from "../src/lib/types";

const festivalId = "2010-kouhaku";
const root = `catch/${festivalId}`;
const sourceRoot = `${root}/source/original`;
const base = "https://vipkohaku20102.web.fc2.com/";
const json = async <T>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, "utf8")) as T;
const writeJson = async (file: string, value: unknown) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const digest = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

async function main() {
  const worksPath = `src/data/works/${festivalId}.json`;
  const legacyPath = `${root}/legacy-works.json`;
  let oldWorks: WorkEntry[];
  try { oldWorks = await json<WorkEntry[]>(legacyPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    oldWorks = await json<WorkEntry[]>(worksPath);
    await fs.copyFile(worksPath, legacyPath);
  }
  const manifest = await json<Record<string, { originalUrl: string; file: string; status: number; contentType: string; bytes: number }>>(`${sourceRoot}/manifest.json`);
  const resourceKey = (value: string) => { const url = new URL(value, base); return `${url.hostname.toLowerCase()}${url.pathname}${url.search}`; };
  const menu = cheerio.load(iconv.decode(await fs.readFile(`${sourceRoot}/menu_entry.html`), "shift_jis"));
  const sourceNumbers = [...new Set(menu("a[href]").toArray().flatMap((anchor) => {
    try {
      const url = new URL(menu(anchor).attr("href")!, new URL("menu_entry.html", base));
      const match = url.hostname === "vipkohaku20102.web.fc2.com" && url.pathname.match(/^\/entry\/(\d{3})\.html$/);
      return match ? [match[1]] : [];
    } catch { return []; }
  }))].sort();
  const workNumbers = oldWorks.map((work) => work.no).filter((no): no is string => Boolean(no)).sort();
  if (oldWorks.length !== 103 || sourceNumbers.length !== 103 || sourceNumbers.some((no, index) => no !== workNumbers[index])) {
    throw new Error("The direct source menu does not map exactly to the 103 existing work numbers.");
  }
  const assetsByUrl = new Map(Object.entries(manifest).map(([localPath, value]) => [value.originalUrl, { localPath, ...value }]));
  const assetsByResourceKey = new Map(Object.entries(manifest).map(([localPath, value]) => [resourceKey(value.originalUrl), { localPath, ...value }]));
  const oldByNo = new Map(oldWorks.map((work) => [work.no!, work]));
  const updated: WorkEntry[] = [];
  const pageRecords: Array<{ no: string; sourcePath: string; sourceUrl: string; bodyImages: number; iconHashMatched: boolean; screenshotHashMatched: boolean; addedScreenshots: number; downloadLinks: number; sourceContentBytes: number }> = [];
  let directIconHashMatches = 0, directIconsAdded = 0, directScreenshotHashMatches = 0, addedScreenshots = 0, downloadCount = 0;
  const missingResources: Array<{ no: string; url: string }> = [];
  const hoverImageUrls = new Set<string>();
  const iconDirectory = `public/icons/${festivalId}-source`;
  const screenshotDirectory = `public/screenshots/${festivalId}-source`;
  await fs.mkdir(iconDirectory, { recursive: true });
  await fs.mkdir(screenshotDirectory, { recursive: true });
  const publicHash = async (publicPath: string) => {
    try { return digest(await fs.readFile(`public${publicPath}`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  };
  const capturedBytes = async (asset: { file: string }) => fs.readFile(`${sourceRoot}/${asset.file}`);

  for (const no of sourceNumbers) {
    const old = oldByNo.get(no)!;
    const sourcePath = `entry/${no}.html`;
    const sourceUrl = new URL(sourcePath, base).href;
    const pageFile = no === "000" ? "entry/000.html" : `entries/${no}.html.bin`;
    const pageHTML = iconv.decode(await fs.readFile(`${sourceRoot}/${pageFile}`), "shift_jis");
    const $ = cheerio.load(pageHTML);
    const body = $("body").first();
    if (!body.length) throw new Error(`The captured page for ${no} has no body.`);
    $("[onmouseover],[onmouseenter],[onmouseout],[onmouseleave]").each((_, element) => {
      for (const attribute of ["onmouseover", "onmouseenter", "onmouseout", "onmouseleave"]) {
        const handler = $(element).attr(attribute) ?? "";
        for (const match of handler.matchAll(/(?:url\(\s*["']?|["'])([^"')]+?\.(?:png|jpe?g|gif)(?:\?[^"')]+)?)(?:["']?\s*\)|["'])/gi)) {
          try { const url = new URL(match[1], sourceUrl); if (url.hostname === new URL(base).hostname) hoverImageUrls.add(url.href); } catch { /* Ignore malformed decorative references. */ }
        }
      }
    });

    let iconPath = old.icon;
    let iconHashMatched = false;
    let pageScreenshotHashMatched = false;
    const screenshotPaths = [...(old.ss ?? [])];
    const usedScreenshotUrls: string[] = [];
    const bodyImages = body.find("img[src]").toArray();
    for (const image of bodyImages) {
      const originalUrl = new URL($(image).attr("src")!, sourceUrl);
      if (originalUrl.hostname === "media.fc2.com" && originalUrl.pathname === "/counter_img.php") {
        $(image).remove();
        continue;
      }
      const asset = assetsByUrl.get(originalUrl.href);
      if (!asset || asset.status !== 200) {
        missingResources.push({ no, url: originalUrl.href });
        $(image).replaceWith('<span class="archive-missing-image">［原資料の画像は未取得です］</span>');
        continue;
      }
      const bytes = await capturedBytes(asset), sourceHash = digest(bytes), pathname = originalUrl.pathname;
      if (/\/(?:entry|entries)\/icon\//.test(pathname)) {
        const oldHash = iconPath ? await publicHash(iconPath) : undefined;
        if (oldHash === sourceHash) {
          iconHashMatched = true;
          directIconHashMatches += 1;
        } else {
          const extension = path.extname(pathname).toLowerCase();
          const newPath = `/icons/${festivalId}-source/${no}${extension}`;
          const target = `public${newPath}`;
          try {
            const existing = await fs.readFile(target);
            if (digest(existing) !== sourceHash) throw new Error(`Refusing to overwrite a non-matching source icon for ${no}.`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") await fs.copyFile(`${sourceRoot}/${asset.file}`, target);
            else throw error;
          }
          iconPath = newPath;
          directIconsAdded += 1;
        }
        $(image).replaceWith(`<img class="source-content-icon" src="${iconPath}" alt="">`);
      } else if (/\/(?:entry|entries)\/ss\//.test(pathname)) {
        usedScreenshotUrls.push(originalUrl.href);
        let matched = false;
        for (const local of screenshotPaths) if (await publicHash(local) === sourceHash) { matched = true; break; }
        if (matched) { directScreenshotHashMatches += 1; pageScreenshotHashMatched = true; }
        else {
          const extension = path.extname(pathname).toLowerCase();
          const newPath = `/screenshots/${festivalId}-source/${no}-${String(addedScreenshots + 1).padStart(2, "0")}${extension}`;
          const target = `public${newPath}`;
          try {
            const existing = await fs.readFile(target);
            if (digest(existing) !== sourceHash) throw new Error(`Refusing to overwrite a non-matching source screenshot for ${no}.`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") await fs.copyFile(`${sourceRoot}/${asset.file}`, target);
            else throw error;
          }
          screenshotPaths.unshift(newPath);
          addedScreenshots += 1;
        }
        const imageLabel = `截图 ${String(usedScreenshotUrls.length).padStart(2, "0")}（查看截图列表）`;
        const parentAnchor = $(image).parent("a");
        if (parentAnchor.length) parentAnchor.attr("href", "#detail-screenshots").removeAttr("target").text(imageLabel);
        else $(image).replaceWith(`<a class="source-image-reference" href="#detail-screenshots">${imageLabel}</a>`);
      } else {
        const localImage = `/original-pages/${festivalId}/${asset.localPath}`;
        $(image).attr({ src: localImage, alt: "" }).removeAttr("srcset");
      }
    }
    body.find("form,noscript,iframe,object,embed,source,canvas,script,style").remove();
    body.find("[srcset]").removeAttr("srcset");
    body.find("a[href]").each((_, anchor) => {
      const value = $(anchor).attr("href")!;
      if (value.startsWith("#")) { $(anchor).removeAttr("target"); return; }
      let url: URL;
      try { url = new URL(value, sourceUrl); } catch { $(anchor).removeAttr("href target"); return; }
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) { $(anchor).removeAttr("href target"); return; }
      if (url.hostname === new URL(base).hostname && url.pathname.startsWith(new URL(base).pathname)) {
        const local = url.pathname.slice(new URL(base).pathname.length) || "index.html";
        $(anchor).attr("href", `/original-pages/${festivalId}/${local}${url.search}${url.hash}`);
      }
      $(anchor).removeAttr("target");
    });
    body.add(body.find("*")).each((_, element) => {
      for (const attribute of Object.keys(element.attribs)) {
        if (attribute.startsWith("on")) { $(element).removeAttr(attribute); continue; }
        if (["href", "src", "class", "id", "title", "alt", "colspan", "rowspan", "scope", "align", "valign", "width", "height", "border", "cellpadding", "cellspacing", "style"].includes(attribute)) {
          if (attribute === "style" && /(?:url\s*\(|expression\s*\(|javascript:)/i.test($(element).attr(attribute) || "")) $(element).removeAttr(attribute);
          continue;
        }
        $(element).removeAttr(attribute);
      }
    });

    const downloads: WorkDownload[] = [];
    const rawPage = cheerio.load(pageHTML);
    rawPage("body a[href]").each((_, anchor) => {
      const url = new URL(rawPage(anchor).attr("href")!, sourceUrl);
      if (url.hostname === "ux.getuploader.com" || url.hostname === "drive.google.com" || /\.(?:zip|rar|7z|lzh)(?:$|\?)/i.test(url.href)) {
        if (!downloads.some((download) => download.url === url.href)) downloads.push({ url: url.href, label: rawPage(anchor).text().trim() || "原页下载入口" });
      }
    });
    downloadCount += downloads.length;
    const sourceContent = body.html()?.trim() ?? "";
    if (!sourceContent) throw new Error(`Source serialization was empty for ${no}.`);
    const work: WorkEntry = { ...old, author: old.author, source: { ...(old.source ?? {}), url: sourceUrl }, sourceContent, ss: screenshotPaths, ...(iconPath ? { icon: iconPath } : {}) };
    delete work.detailDisabled;
    if (downloads.length > 1) { work.downloads = downloads; delete work.download; }
    else if (downloads.length === 1) { work.download = downloads[0]; delete work.downloads; }
    if (work.contentRestricted !== old.contentRestricted) throw new Error(`Restriction marker changed for ${no}.`);
    updated.push(work);
    pageRecords.push({ no, sourcePath, sourceUrl, bodyImages: bodyImages.length, iconHashMatched, screenshotHashMatched: usedScreenshotUrls.length === 1 && pageScreenshotHashMatched, addedScreenshots: screenshotPaths.length - (old.ss?.length ?? 0), downloadLinks: downloads.length, sourceContentBytes: Buffer.byteLength(sourceContent) });
  }

  if (updated.length !== 103 || updated.some((work) => work.detailDisabled) || updated.some((work) => work.contentRestricted)) throw new Error("The direct source page mapping is incomplete or changed a restriction.");
  const screenshotHashes = new Set<string>();
  for (const work of updated) for (const screenshot of work.ss ?? []) { const hash = await publicHash(screenshot); if (hash) screenshotHashes.add(hash); }
  let hoverImageLinksCaptured = 0, hoverImageLinksMatched = 0;
  for (const url of hoverImageUrls) {
    const asset = assetsByResourceKey.get(resourceKey(url));
    if (!asset || asset.status !== 200) continue;
    hoverImageLinksCaptured += 1;
    if (screenshotHashes.has(digest(await capturedBytes(asset)))) hoverImageLinksMatched += 1;
  }
  await fs.mkdir(`public/banners/${festivalId}`, { recursive: true });
  const bannerFiles = await json<Record<string, { originalUrl: string; file: string; status?: number; contentType?: string; bytes?: number; requestedUrl?: string; actualUrl?: string; retrievedAt?: string; proxyRegion?: string; archiveUrl?: string; archiveTimestamp?: string; sha256?: string }>>(`${sourceRoot}/manifest.json`);
  const festivalPath = "src/data/festivals.json", festivals = await json<Array<{ id: string; banners: string[] }>>(festivalPath), festival = festivals.find((entry) => entry.id === festivalId);
  if (!festival) throw new Error(`Festival registry entry ${festivalId} is missing.`);
  const banner1 = Object.values(bannerFiles).find((asset) => asset.originalUrl.endsWith("/img/bnkohaku2010.png"));
  const banner2 = Object.values(bannerFiles).find((asset) => asset.originalUrl.endsWith("/img/bnkohaku2010_2.png"));
  if (!banner1 || !banner2) throw new Error("Direct festival banner files are missing.");
  for (const [source, target] of [[banner1, `public/banners/${festivalId}-01.png`], [banner2, `public/banners/${festivalId}-02.png`]] as const) {
    const digestSource = digest(await fs.readFile(`${sourceRoot}/${source.file}`));
    try {
      const existing = await fs.readFile(target);
      if (digest(existing) !== digestSource) throw new Error(`Refusing to overwrite a non-matching banner ${target}.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") await fs.copyFile(`${sourceRoot}/${source.file}`, target);
      else throw error;
    }
  }
  festival.banners = [`/banners/${festivalId}-01.png`, `/banners/${festivalId}-02.png`, "/banners/2010-kouhaku.png"];

  const externalAssets = await json<{ externalAssets: Array<{ url: string }> }>(`${root}/investigation/resource-inventory.json`);
  const reusePlan = [
    { url: "http://vipkouhaku05.cs.land.to/viprpgkouhaku2009-top.png", manifest: "catch/2011-kouhaku/source/linked/manifest.json", file: "kouhaku2009.png" },
    { url: "http://www.geocities.jp/vipkouhaku/vipkohaku_second02.png", manifest: "catch/2011-kouhaku/source/linked/manifest.json", file: "kouhaku2006.png" },
    { url: "http://music.geocities.jp/kouhaku03_01/kouhaku2007.png", manifest: "catch/2011-kouhaku/source/linked/manifest.json", file: "kouhaku2007.png" },
    { url: "http://vipkouhaku05.cs.land.to/vip2008.png", manifest: "catch/2011-kouhaku/source/linked/manifest.json", file: "kouhaku2008.png" },
  ];
  const reusedExternal: Array<{ url: string; localPath: string; sourceManifest: string; sha256: string; bytes: number }> = [];
  await fs.mkdir(`${sourceRoot}/linked`, { recursive: true });
  for (const item of reusePlan) {
    if (!externalAssets.externalAssets.some((asset) => asset.url === item.url)) throw new Error(`Expected external source asset is missing from the inventory: ${item.url}`);
    const priorManifest = await json<Record<string, { originalUrl: string; file: string; status?: number; contentType?: string; bytes?: number; actualUrl?: string; retrievedAt?: string }>>(item.manifest);
    const prior = Object.values(priorManifest).find((asset) => asset.originalUrl === item.url);
    if (!prior) throw new Error(`No exact archived capture exists for ${item.url}`);
    const priorBytes = await fs.readFile(path.join(path.dirname(item.manifest), prior.file));
    const sourceSha256 = digest(priorBytes);
    const localPath = `linked/${item.file}`;
    const target = `${sourceRoot}/${localPath}`;
    try {
      if (digest(await fs.readFile(target)) !== sourceSha256) throw new Error(`Refusing to overwrite a non-matching archived asset ${target}.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") await fs.copyFile(path.join(path.dirname(item.manifest), prior.file), target);
      else throw error;
    }
    const bytes = await fs.stat(target);
    bannerFiles[localPath] = { originalUrl: item.url, requestedUrl: item.url, actualUrl: prior.actualUrl ?? item.url, file: localPath, status: prior.status ?? 200, contentType: prior.contentType ?? "image/png", bytes: bytes.size, retrievedAt: prior.retrievedAt ?? "reused-verified-capture", proxyRegion: "reused exact URL from prior archive capture" };
    reusedExternal.push({ url: item.url, localPath, sourceManifest: item.manifest, sha256: sourceSha256, bytes: bytes.size });
  }
  const archivedExternalUrl = "http://www.geocities.jp/vipkohaku2010_1/img/bnkohaku2010.png";
  if (!externalAssets.externalAssets.some((asset) => asset.url === archivedExternalUrl)) throw new Error("Expected archived external banner is missing from the inventory.");
  const archivedExternalPath = "linked/kouhaku2010.png";
  const archivedExternalBytes = await fs.readFile(`${sourceRoot}/${archivedExternalPath}`);
  if (archivedExternalBytes.length !== 9166 || digest(archivedExternalBytes) !== digest(await fs.readFile(`${sourceRoot}/assets/source-0212.png`))) throw new Error("The exact Wayback banner capture does not match its archived size and direct-source duplicate.");
  const archiveUrl = "https://web.archive.org/web/20110503114456id_/http://www.geocities.jp/vipkohaku2010_1/img/bnkohaku2010.png";
  bannerFiles[archivedExternalPath] = { originalUrl: archivedExternalUrl, requestedUrl: archiveUrl, actualUrl: archiveUrl, archiveUrl, archiveTimestamp: "20110503114456", file: archivedExternalPath, status: 200, contentType: "image/png", bytes: archivedExternalBytes.length, retrievedAt: "2026-10-18T04:04:04.000Z", proxyRegion: "Hong Kong", sha256: digest(archivedExternalBytes) };
  const archivedExternal = [{ url: archivedExternalUrl, localPath: archivedExternalPath, archiveUrl, archiveTimestamp: "20110503114456", proxyRegion: "Hong Kong", sha256: digest(archivedExternalBytes), bytes: archivedExternalBytes.length }];
  const originalResources = Object.fromEntries(Object.entries(bannerFiles).map(([localPath, asset]) => [asset.originalUrl, localPath]));
  await writeJson(`${sourceRoot}/manifest.json`, bannerFiles);
  const unresolvedExternal = externalAssets.externalAssets.filter((asset) => !Object.hasOwn(originalResources, asset.url));
  await writeJson(`${root}/original-resources.json`, { originalResources, reusedExternal, archivedExternal, unresolvedExternal });
  const registryBytes = Buffer.from(`${JSON.stringify(festivals, null, 2)}\n`), registryHandle = await fs.open(festivalPath, "r+");
  try { await registryHandle.writeFile(registryBytes); await registryHandle.truncate(registryBytes.length); } finally { await registryHandle.close(); }
  const workBytes = Buffer.from(`${JSON.stringify(updated, null, 2)}\n`), workHandle = await fs.open(worksPath, "r+");
  try { await workHandle.writeFile(workBytes); await workHandle.truncate(workBytes.length); } finally { await workHandle.close(); }
  await writeJson(`${root}/source-comparison.json`, { festivalId, entryCount: updated.length, sourceMenuLinks: 103, pageFilesCaptured: 103, sourceScreenshotsMatchedBySha256: directScreenshotHashMatches, sourceIconsMatchedBySha256: directIconHashMatches, sourceIconsUpdatedToDirectBytes: directIconsAdded, hoverImageSourceUrls: hoverImageUrls.size, hoverImageLinksCaptured, hoverImageLinksMatchedToExistingScreenshots: hoverImageLinksMatched, downloads: downloadCount, missingDirectResources: missingResources, reusedExternalAssets: reusedExternal, archivedExternalAssets: archivedExternal, unresolvedExternalAssets: unresolvedExternal, manualEntryContentReview: false, titleTextManuallyReviewed: false, restrictionChanges: 0, entries: pageRecords });
  const recovery = await json<Record<string, unknown>>(`${root}/recovery.json`);
  const directCaptureLog = await json<{ items: Array<{ relative: string; url: string; bytes: number; sha256: string }>; batches: Array<{ index: number; start: number; count: number; region: string; completedAt: string }> }>(`${root}/investigation/direct-resource-capture-log.json`);
  const directManifestEntries = Object.entries(bannerFiles).filter(([, asset]) => asset.proxyRegion === "Japan" && asset.status === 200);
  const directSourcePages = directManifestEntries.filter(([, asset]) => asset.contentType?.includes("text/html")).map(([localPath]) => localPath).sort();
  const directSourceAssets = directManifestEntries.filter(([, asset]) => !asset.contentType?.includes("text/html"));
  recovery.sourcePages = directSourcePages;
  recovery.entries = pageRecords;
  recovery.contentRestrictions = [];
  recovery.sourceDetailGaps = [];
  recovery.dataCapture = { works: updated.length, capturedDetailPages: pageRecords.length, directSourcePages: directSourcePages.length, directSourceAssets: directSourceAssets.length, supplementalResourceCaptures: directCaptureLog.items.length, supplementalResourceBatches: directCaptureLog.batches, sourceScreenshotHashMatches: directScreenshotHashMatches, sourceIconHashMatches: directIconHashMatches, directIconsUpdated: directIconsAdded, hoverImageSourceUrls: hoverImageUrls.size, hoverImageLinksCaptured, hoverImageLinksMatchedToExistingScreenshots: hoverImageLinksMatched, addedScreenshots, downloads: downloadCount, manualEntryContentReview: false, manuallyAppliedRestrictions: 0 };
  recovery.unavailableResources = unresolvedExternal.map((asset) => ({ originalUrl: asset.url, kind: asset.kind, status: "no-exact-local-capture", reason: "No exact-URL capture is available in the current source archive; the original URL remains recorded." }));
  recovery.sourceAvailability = { ...(recovery.sourceAvailability as Record<string, unknown>), directSourcePages: directSourcePages.length, directSourceAssets: directSourceAssets.length, archivedExternal, unresolvedExternal };
  recovery.originalResources = originalResources;
  recovery.externalResourceEvidence = { reusedExternal, archivedExternal, unresolvedExternal };
  recovery.desktopReview = "pending";
  await writeJson(`${root}/recovery.json`, recovery);
  console.log(JSON.stringify({ works: updated.length, sourceContentPages: pageRecords.length, screenshots: updated.reduce((n, work) => n + (work.ss?.length ?? 0), 0), directScreenshotMatches: directScreenshotHashMatches, directIconsUpdated: directIconsAdded, hoverImages: hoverImageLinksMatched, downloads: downloadCount, banners: festival.banners.length }, null, 2));
}

void main();
