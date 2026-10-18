import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { WorkEntry } from "../src/lib/types";
import { imageExtension } from "./recover-entry-table";

const festivalId = "2010-summer";
const root = `catch/${festivalId}`;
const sourceRoot = `${root}/source/archive`;
const base = "https://vipkohaku.x.fc2.com/2010s/";
const worksPath = `src/data/works/${festivalId}.json`;
const json = async <T>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, "utf8")) as T;
const writeJson = async (file: string, value: unknown) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const digest = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
const resourceKey = (value: string) => {
  const url = new URL(value, base);
  return `${url.hostname.toLowerCase()}${url.pathname}${url.search}`;
};

async function saveVerified(source: string, target: string, expectedHash: string) {
  try {
    if (digest(await fs.readFile(target)) !== expectedHash) throw new Error(`Refusing to overwrite a non-matching source asset: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") await fs.copyFile(source, target);
    else throw error;
  }
}

async function main() {
  const oldWorks = await json<WorkEntry[]>(`${root}/legacy-works.json`);
  const manifest = await json<Record<string, { originalUrl: string; file: string; status: number; contentType: string; bytes: number; sha256?: string; archiveUrl?: string; archiveTimestamp?: string }>>(`${sourceRoot}/manifest.json`);
  const assetsByUrl = new Map(Object.entries(manifest).map(([localPath, value]) => [resourceKey(value.originalUrl), { localPath, ...value }]));
  const indexPath = `${sourceRoot}/index.html.bin`;
  const index = cheerio.load(iconv.decode(await fs.readFile(indexPath), "shift_jis"));
  const sourceRows = new Map<string, { sourcePath: string; sourceUrl: string; iconUrl?: string }>();
  for (const anchor of index("a[href]").toArray()) {
    let url: URL;
    try { url = new URL(index(anchor).attr("href")!, new URL("index.html", base)); }
    catch { continue; }
    const match = url.hostname === "vipkohaku.x.fc2.com" && url.pathname.match(/\/2010s\/ss_(\d+)\.html$/i);
    if (!match) continue;
    const no = match[1].padStart(3, "0"), row = index(anchor).closest("tr"), icon = row.find("td").first().find("img[src]").first().attr("src");
    sourceRows.set(no, { sourcePath: url.pathname.slice(new URL(base).pathname.length), sourceUrl: url.href, ...(icon ? { iconUrl: new URL(icon, url).href } : {}) });
  }
  if (sourceRows.size !== 92) throw new Error(`Expected 92 linked archived details; got ${sourceRows.size}.`);

  const oldByNo = new Map(oldWorks.map((work) => [String(work.no).padStart(3, "0"), work]));
  const updated: WorkEntry[] = [];
  const entries: Array<{ no: string; sourceUrl: string; snapshotUrl?: string; sourceContentBytes: number; iconCaptured: boolean; screenshotsCaptured: number; missingImages: number }> = [];
  const missingSourcePages: Array<{ no: string; sourcePath: string; sourceUrl: string; reason: string }> = [];
  const missingImages: Array<{ no: string; url: string }> = [];
  const sourceOnlyDetails = [...sourceRows.keys()].filter((no) => !oldByNo.has(no)).sort();
  let directIconsAdded = 0, directScreenshotsAdded = 0, capturedDetailPages = 0;
  const screenshotDirectory = `screenshots/${festivalId}-source`;
  const iconDirectory = `icons/${festivalId}-source`;
  await fs.mkdir(`public/${screenshotDirectory}`, { recursive: true });
  await fs.mkdir(`public/${iconDirectory}`, { recursive: true });

  for (const old of oldWorks) {
    const no = String(old.no).padStart(3, "0"), row = sourceRows.get(no);
    const expectedPath = `ss_${String(Number(no)).padStart(2, "0")}.html`;
    const sourceUrl = row?.sourceUrl ?? new URL(expectedPath, base).href;
    const pageAsset = row ? manifest[row.sourcePath] : undefined;
    const work: WorkEntry = { ...old, source: { ...(old.source ?? {}), url: sourceUrl } };
    let sourceContentBytes = 0, iconCaptured = false, pageMissingImages = 0;

    if (row?.iconUrl) {
      const iconAsset = assetsByUrl.get(resourceKey(row.iconUrl));
      if (iconAsset?.status === 200) {
        const bytes = await fs.readFile(`${sourceRoot}/${iconAsset.file}`), extension = imageExtension(bytes), publicPath = `/${iconDirectory}/${no}.${extension}`;
        await saveVerified(`${sourceRoot}/${iconAsset.file}`, `public${publicPath}`, digest(bytes));
        work.icon = publicPath;
        iconCaptured = true;
        directIconsAdded += 1;
      }
    }

    if (!row || !pageAsset || pageAsset.status !== 200) {
      work.detailDisabled = true;
      missingSourcePages.push({ no, sourcePath: expectedPath, sourceUrl, reason: "The existing catalogue entry has no matching HTTP 200 detail snapshot in the captured 2010s CDX prefix; direct source access failed on the verified Japan node." });
      updated.push(work);
      entries.push({ no, sourceUrl, sourceContentBytes, iconCaptured, screenshotsCaptured: 0, missingImages: 0 });
      continue;
    }

    const pageBytes = await fs.readFile(`${sourceRoot}/${pageAsset.file}`);
    const $ = cheerio.load(iconv.decode(pageBytes, "shift_jis"));
    const body = $("body").first();
    if (!body.length) throw new Error(`Captured detail page ${row.sourcePath} has no body.`);
    const screenshots: string[] = [];
    const seenScreenshots = new Set<string>();
    for (const image of body.find("img[src]").toArray()) {
      const raw = $(image).attr("src")!;
      let originalUrl: string;
      try { originalUrl = new URL(raw, row.sourceUrl).href; }
      catch { $(image).replaceWith('<span class="archive-missing-image">［原资料图片未取得］</span>'); pageMissingImages += 1; continue; }
      const asset = assetsByUrl.get(resourceKey(originalUrl));
      if (!asset || asset.status !== 200) {
        missingImages.push({ no, url: originalUrl });
        $(image).replaceWith('<span class="archive-missing-image">［原资料图片未取得］</span>');
        pageMissingImages += 1;
        continue;
      }
      const bytes = await fs.readFile(`${sourceRoot}/${asset.file}`), extension = imageExtension(bytes), basename = path.posix.basename(asset.localPath);
      if (/^ss[_-]?\d+\.(?:png|jpe?g|gif)$/i.test(basename) && !seenScreenshots.has(resourceKey(originalUrl))) {
        seenScreenshots.add(resourceKey(originalUrl));
        const screenshotPath = `/${screenshotDirectory}/${no}-${String(screenshots.length + 1).padStart(2, "0")}.${extension}`;
        await saveVerified(`${sourceRoot}/${asset.file}`, `public${screenshotPath}`, digest(bytes));
        screenshots.push(screenshotPath);
        directScreenshotsAdded += 1;
      }
      $(image).attr({ src: `/original-pages/${festivalId}/${asset.localPath}`, alt: "" }).removeAttr("srcset");
    }
    body.find("form,noscript,iframe,object,embed,canvas,script,style,source").remove();
    body.find("[srcset]").removeAttr("srcset");
    work.sourceContent = body.html()?.trim() ?? "";
    if (!work.sourceContent) throw new Error(`Source serialization was empty for ${no}.`);
    work.source = { ...(old.source ?? {}), url: row.sourceUrl, snapshotUrl: pageAsset.archiveUrl };
    if (screenshots.length) work.ss = screenshots;
    else delete work.ss;
    delete work.detailDisabled;
    if (work.contentRestricted !== old.contentRestricted) throw new Error(`Restriction marker changed for ${no}.`);
    sourceContentBytes = Buffer.byteLength(work.sourceContent);
    capturedDetailPages += 1;
    updated.push(work);
    entries.push({ no, sourceUrl: row.sourceUrl, snapshotUrl: pageAsset.archiveUrl, sourceContentBytes, iconCaptured, screenshotsCaptured: screenshots.length, missingImages: pageMissingImages });
  }

  const bannerNames = [...new Set(index("img[src]").toArray().map((img) => path.posix.basename(new URL(index(img).attr("src")!, new URL("index.html", base)).pathname)).filter((name) => /^(?:banner|ban\d+)\.(?:png|jpe?g|gif)$/i.test(name)))];
  const festivalPath = "src/data/festivals.json", festivals = await json<Array<{ id: string; banners: string[] }>>(festivalPath), festival = festivals.find((item) => item.id === festivalId);
  if (!festival) throw new Error(`Festival registry entry ${festivalId} is missing.`);
  await fs.mkdir("public/banners", { recursive: true });
  const banners: string[] = [];
  for (const [index, name] of bannerNames.entries()) {
    const asset = assetsByUrl.get(resourceKey(new URL(name, base).href));
    if (!asset || asset.status !== 200) continue;
    const bytes = await fs.readFile(`${sourceRoot}/${asset.file}`), extension = imageExtension(bytes), publicPath = `/banners/${festivalId}-${String(index + 1).padStart(2, "0")}.${extension}`;
    await saveVerified(`${sourceRoot}/${asset.file}`, `public${publicPath}`, digest(bytes));
    banners.push(publicPath);
  }
  festival.banners = banners;
  const registryBytes = Buffer.from(`${JSON.stringify(festivals, null, 2)}\n`), registryHandle = await fs.open(festivalPath, "r+");
  try { await registryHandle.writeFile(registryBytes); await registryHandle.truncate(registryBytes.length); } finally { await registryHandle.close(); }
  const workBytes = Buffer.from(`${JSON.stringify(updated, null, 2)}\n`), workHandle = await fs.open(worksPath, "r+");
  try { await workHandle.writeFile(workBytes); await workHandle.truncate(workBytes.length); } finally { await workHandle.close(); }

  const recovery = await json<Record<string, unknown>>(`${root}/recovery.json`);
  recovery.entries = entries;
  recovery.sourceOnlyDetails = sourceOnlyDetails.map((no) => ({ no, sourcePath: sourceRows.get(no)!.sourcePath, sourceUrl: sourceRows.get(no)!.sourceUrl, reason: "Archived original index and detail page exist, but there is no matching WorkEntry in the pre-recovery catalogue; page remains accessible in original view without inferred structured fields." }));
  recovery.sourceDetailGaps = missingSourcePages;
  recovery.unavailableResources = missingImages.map((image) => ({ originalUrl: image.url, kind: "image", status: "not-in-captured-CDX-prefix", reason: "Referenced by a captured detail page but absent from all successful 2010s-prefix CDX records." }));
  recovery.banners = banners;
  recovery.dataCapture = { catalogueWorks: oldWorks.length, capturedDetailPages, sourceOnlyDetails: sourceOnlyDetails.length, catalogueIdsWithoutCdxPage: missingSourcePages.length, directIconsAdded, directScreenshotsAdded, missingDetailImages: missingImages.length, sourceContentPages: capturedDetailPages, manualEntryContentReview: false, manuallyAppliedRestrictions: 0 };
  recovery.desktopReview = "pending";
  await writeJson(`${root}/recovery.json`, recovery);
  await writeJson(`${root}/source-comparison.json`, { festivalId, existingCatalogueWorks: oldWorks.length, sourceIndexLinks: sourceRows.size, capturedDetailPages, sourceOnlyIds: sourceOnlyDetails, existingCatalogueIdsWithoutSnapshot: missingSourcePages.map((gap) => gap.no), directIconsAdded, directScreenshotsAdded, missingDetailImages: missingImages, manualEntryContentReview: false, titleTextManuallyReviewed: false, restrictionChanges: 0, entries });
  console.log(JSON.stringify({ catalogueWorks: updated.length, capturedDetailPages, sourceOnlyDetails: sourceOnlyDetails.length, detailGaps: missingSourcePages.length, directIconsAdded, directScreenshotsAdded, missingImages: missingImages.length, banners: banners.length }, null, 2));
}

void main();
