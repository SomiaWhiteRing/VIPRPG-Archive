import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import sharp from "sharp";
import { decodeSource, imageExtension, writeJson } from "./recover-entry-table";
import type { WorkEntry, WorkDownload } from "../src/lib/types";

const id = "2006-gw", root = `catch/${id}`, base = "http://www.geocities.jp/viprpg_gw/";
type Capture = { originalUrl: string; requestedUrl: string; actualUrl: string; timestamp: string; file: string; sha256: string; expectedDigest: string; cdxDigestVerified: boolean };
const read = async <T,>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, "utf8"));
const normalize = (value: string) => value.normalize("NFKC").replace(/\s/g, "");
const localPath = (url: string) => new URL(url).pathname.slice(new URL(base).pathname.length) || "index.html";
const overrides: Record<string, string> = { "index.html": "shift_jis", "tenpure.html": "shift_jis" };

async function main() {
  const manifest = await read<Record<string, Capture>>(`${root}/source/original-archive/manifest.json`);
  const byPath = new Map(Object.values(manifest).map((capture) => [localPath(capture.originalUrl), capture]));
  const encodingReview = [];
  for (const capture of Object.values(manifest)) {
    const bytes = await fs.readFile(`${root}/source/original-archive/${capture.file}`);
    if (!capture.cdxDigestVerified || createHash("sha256").update(bytes).digest("hex") !== capture.sha256) throw new Error("Source cache not verified");
    if (/\.html$|\/$/.test(capture.originalUrl)) {
      const sourcePath = localPath(capture.originalUrl), fallback = overrides[sourcePath] ?? "euc-jp", text = decodeSource(bytes, fallback);
      if (text.includes("\uFFFD")) throw new Error(`Unresolved source encoding: ${sourcePath}`);
      encodingReview.push({ sourcePath, fallback, replacementCharacters: 0 });
    }
  }
  await writeJson(`${root}/investigation/verified-document-encodings.json`, encodingReview);
  const document = async (capture: Capture) => cheerio.load(decodeSource(await fs.readFile(`${root}/source/original-archive/${capture.file}`), overrides[localPath(capture.originalUrl)] ?? "euc-jp"));
  const catalogue = byPath.get("main.html")!, $catalogue = await document(catalogue), plain = $catalogue("body").clone();
  plain.find("script,noscript,style").remove();
  plain.find("br").replaceWith("\n");
  const sourceRows = plain.text().split(/\r?\n/).map((line) => line.trim()).filter((line) => /^・「/.test(line)).map((line) => {
    const match = line.match(/^・「\s*([\s\S]*?)\s*」\s*作・([\s\S]*)$/);
    if (!match) throw new Error("Catalogue row not parsed");
    return { title: match[1].trim(), author: match[2].trim() };
  });
  if (sourceRows.length !== 31) throw new Error("Unexpected source catalogue size");
  const overview = byPath.get("sakuhinsyoukai.html")!, $overview = await document(overview);
  const introductions = $overview("a[href]").toArray().map((anchor) => ({ sourcePath: $overview(anchor).attr("href")!, title: $overview(anchor).text().trim().replace(/^・?「|」$/g, "") }));
  if (introductions.length !== 31 || introductions.some((entry) => !byPath.has(entry.sourcePath))) throw new Error("Original introduction not cached");
  const inventory = await read<{ rows: string[][] }>(`${root}/investigation/original-normalized-inventory.json`);
  const packages = new Map(inventory.rows.filter((row) => row[3] === "application/zip").map((row) => [localPath(row[0]), row]));
  const legacy = await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`);
  const works: WorkEntry[] = [], entries = [], imageGaps = [];
  for (let index = 0; index < sourceRows.length; index++) {
    const row = sourceRows[index], intro = introductions[index], no = String(index + 1).padStart(2, "0");
    const work: WorkEntry = { id: `${id}-work-${no}`, festivalId: id, no, title: row.title, author: row.author };
    if (normalize(intro.title) !== normalize(work.title)) work.originalTitle = intro.title;
    const capture = byPath.get(intro.sourcePath)!, $ = await document(capture);
    work.source = { url: capture.originalUrl, snapshotUrl: capture.requestedUrl, titleUrl: catalogue.requestedUrl };
    const fields: Array<[string, "engine" | "category" | "streaming"]> = [["ツクール", "engine"], ["使用ツール", "engine"], ["ジャンル", "category"], ["配信", "streaming"]];
    $("tr").each((_, tr) => {
      const cells = $(tr).children("td,th");
      if (cells.length !== 2) return;
      const label = normalize(cells.eq(0).text()).replace(/[:：■【】]/g, ""), field = fields.find(([name]) => normalize(name) === label);
      if (field && cells.eq(1).text().trim()) work[field[1]] = cells.eq(1).text().trim();
    });
    const screenshots = [], screenshotSources = [];
    for (const img of $("img[src]").toArray()) {
      const url = new URL($(img).attr("src")!, capture.originalUrl);
      if (url.hostname !== new URL(base).hostname || !url.pathname.startsWith(new URL(base).pathname)) continue;
      const resource = byPath.get(localPath(url.href));
      if (!resource) { imageGaps.push({ no, originalUrl: url.href }); continue; }
      const bytes = await fs.readFile(`${root}/source/original-archive/${resource.file}`), extension = imageExtension(bytes), dimensions = await sharp(bytes).metadata();
      const local = `/screenshots/${id}/${no}-${screenshots.length + 1}.${extension}`;
      await fs.mkdir(path.dirname(`public${local}`), { recursive: true });
      await fs.writeFile(`public${local}`, bytes);
      screenshots.push(local);
      screenshotSources.push({ sourcePath: localPath(resource.originalUrl), local, width: dimensions.width, height: dimensions.height, ...resource });
    }
    if (screenshots.length) work.ss = screenshots;
    const downloads: WorkDownload[] = [], packageSources = [];
    $("a[href]").each((_, anchor) => {
      const url = new URL($(anchor).attr("href")!, capture.originalUrl);
      if (!/\.zip$/i.test(url.pathname)) return;
      const pkg = packages.get(localPath(url.href));
      if (pkg) {
        downloads.push({ url: `https://web.archive.org/web/${pkg[1]}id_/${pkg[0]}`, label: "Wayback ZIP", filename: path.posix.basename(url.pathname) });
        packageSources.push({ originalUrl: url.href, cdxTimestamp: pkg[1], cdxDigest: pkg[4], bytesDownloaded: false });
      }
      downloads.push({ url: url.href, label: "Source ZIP", filename: path.posix.basename(url.pathname) });
    });
    if (downloads.length) { work.downloads = downloads; work.download = downloads[0]; }
    $("script,noscript,style,iframe,form,object,embed,img,link,meta").remove();
    $("*").each((_, element) => { for (const attr of Object.keys(element.attribs)) if (attr.startsWith("on") || ["background", "bgcolor", "color", "face", "size", "align", "nowrap", "style", "width", "height"].includes(attr)) $(element).removeAttr(attr); });
    $("a[href]").each((_, anchor) => {
      const url = new URL($(anchor).attr("href")!, capture.originalUrl), target = introductions.findIndex((entry) => entry.sourcePath === localPath(url.href));
      $(anchor).attr("href", url.hostname === new URL(base).hostname && target >= 0 ? `/works/${id}-work-${String(target + 1).padStart(2, "0")}` : url.href);
    });
    work.sourceContent = $("body").html()?.trim();
    works.push(work);
    entries.push({ no, sourcePath: intro.sourcePath, snapshotUrl: capture.requestedUrl, sourceSha256: capture.sha256, screenshotSources, packageSources });
  }
  const idMap = legacy.map((old) => ({ legacyId: old.id, correctedIds: works.filter((work) => normalize(work.title) === normalize(old.title) && normalize(work.author) === normalize(old.author)).map((work) => work.id) }));
  const merged = idMap.find((entry) => entry.legacyId === `${id}-work-11`);
  if (merged && merged.correctedIds.length === 0) merged.correctedIds = [`${id}-work-11`, `${id}-work-12`];
  await writeJson(`${root}/investigation/legacy-id-map.json`, { numbering: "Archive-assigned sequence following the original unnumbered bullet list. Legacy entries had no enabled detail routes.", sourceEvidence: "legacy-parser-diagnosis.json", mappings: idMap });
  const banner = byPath.get("festa.png")!, bannerBytes = await fs.readFile(`${root}/source/original-archive/${banner.file}`), bannerExtension = imageExtension(bannerBytes), bannerDimensions = await sharp(bannerBytes).metadata(), bannerLocal = `/banners/${id}.${bannerExtension}`;
  await fs.writeFile(`public${bannerLocal}`, bannerBytes);
  const festivals = await read<Array<{ id: string; banners: string[] }>>("src/data/festivals.json");
  festivals.find((festival) => festival.id === id)!.banners = [bannerLocal];
  await writeJson("src/data/festivals.json", festivals);
  await writeJson(`src/data/works/${id}.json`, works);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, catalogueCapture: catalogue, introductionListCapture: overview, catalogueEntries: works.length, sourceEncodingFallback: "euc-jp", encodingOverrides: overrides, entries, imageGaps, sourceDetailGaps: [], legacyCatalogueCorrection: { before: 30, after: 31, diagnosis: `${root}/investigation/legacy-parser-diagnosis.json`, identifierMap: `${root}/investigation/legacy-id-map.json` }, titleVariants: works.filter((work) => work.originalTitle).map((work) => ({ no: work.no, catalogueTitleUrl: work.source!.titleUrl, introductionUrl: overview.requestedUrl })), banner: { sourcePath: "festa.png", local: bannerLocal, width: bannerDimensions.width, height: bannerDimensions.height, ...banner }, sourceEvidence: [`${root}/investigation/original-origin-identity-review.json`, `${root}/investigation/original-normalized-inventory.json`, `${root}/investigation/original-archive-retrieval.json`, `${root}/investigation/catalogue-rows.json`], handling: "Rebuild the source's 31 separate catalogue lines; the legacy cross-line regex merged two entries at an author-name delimiter. Preserve catalogue names and the introduction-list title variation. Store original bytes and source content without content screening. Package links use observed archive index records, but package bytes were not downloaded or validated.", desktopReview: "pending" });
  await writeJson(`${root}/investigation/original-timemap.bin`, [["original", "first", "last"], ...Object.values(manifest).map((capture) => [capture.originalUrl, capture.timestamp, capture.timestamp])]);
  console.log(JSON.stringify({ works: works.length, originalDetails: entries.length, screenshotFiles: entries.reduce((sum, entry) => sum + entry.screenshotSources.length, 0), imageGaps: imageGaps.length, packageReferences: entries.reduce((sum, entry) => sum + entry.packageSources.length, 0) }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
