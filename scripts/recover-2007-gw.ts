import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import sharp from "sharp";
import { imageExtension, writeJson } from "./recover-entry-table";
import type { WorkEntry } from "../src/lib/types";

const id = "2007-gw", root = `catch/${id}`, base = "https://vipkohaku.x.fc2.com/2007GW/";
type Capture = { originalUrl: string; requestedUrl: string; actualUrl: string; timestamp: string; file: string; sha256: string; expectedDigest: string; cdxDigestVerified: boolean };
const read = async <T,>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, "utf8"));
const normalize = (value: string) => value.normalize("NFKC").replace(/\s/g, "");
const sourcePath = (url: string) => new URL(url).pathname.slice(new URL(base).pathname.length);

async function main() {
  const manifest = await read<Record<string, Capture>>(`${root}/source/archive/manifest.json`);
  const byPath = new Map(Object.values(manifest).map((capture) => [sourcePath(capture.originalUrl), capture]));
  for (const capture of Object.values(manifest)) {
    const bytes = await fs.readFile(`${root}/source/archive/${capture.file}`);
    if (!capture.cdxDigestVerified || createHash("sha256").update(bytes).digest("hex") !== capture.sha256) throw new Error("Unverified source cache");
  }
  const decode = async (capture: Capture) => {
    const bytes = await fs.readFile(`${root}/source/archive/${capture.file}`), text = iconv.decode(bytes, "shift_jis");
    if (text.includes("\uFFFD") || !iconv.encode(text, "shift_jis").equals(bytes)) throw new Error("Source encoding roundtrip failed");
    return cheerio.load(text);
  };
  const catalogue = byPath.get("index.html")!, $index = await decode(catalogue);
  const section = (table: ReturnType<typeof $index>) => {
    const preceding = table.prevAll().toArray().find((element) => $index(element).is("h2") || $index(element).find("h2").length > 0);
    const heading = preceding && ($index(preceding).is("h2") ? $index(preceding) : $index(preceding).find("h2").last());
    return { table, heading: heading ? normalize(heading.text()) : "" };
  };
  const catalogueTables = $index("table").filter((_, table) => section($index(table)).heading === "作品紹介");
  const sourcePaths = new Set(catalogueTables.find("a[href]").toArray().map((anchor) => $index(anchor).attr("href")!).filter((href) => /^entry\/\d{3}\.html$/.test(href)));
  if (sourcePaths.size !== 62) throw new Error("Unexpected source catalogue size");
  const file = `src/data/works/${id}.json`, previous = await read<WorkEntry[]>(file);
  const works = previous.filter((work) => sourcePaths.has(`entry/${work.no!.padStart(3, "0")}.html`));
  if (works.length !== sourcePaths.size) throw new Error("Catalogue records missing");
  const comparisons = works.map((work) => ({ no: work.no, sourcePath: `entry/${work.no!.padStart(3, "0")}.html`, matches: normalize($index(`a[href="entry/${work.no!.padStart(3, "0")}.html"]`).text().trim().replace(/\s+\[XP\]$/, "")) === normalize(work.title) }));
  if (comparisons.some((row) => !row.matches)) throw new Error("Catalogue title mismatch");
  await writeJson(`${root}/investigation/catalogue-section-review.json`, { sourceSection: "作品紹介", catalogueEntries: sourcePaths.size, tableEntryCounts: catalogueTables.toArray().map((table) => $index(table).find('a[href^="entry/"]').length), zeroEntryRetained: true, handling: "Both source tables belong to the works-introduction section. Preserve all 62 linked entries without inferring roles from numbers, titles, or content." });
  await writeJson(`${root}/investigation/catalogue-title-comparison.json`, comparisons);
  const banners = [];
  for (const [index, name] of ["image/banner01.png", "image/banner02.gif"].entries()) {
    const capture = byPath.get(name)!;
    const bytes = await fs.readFile(`${root}/source/archive/${capture.file}`), extension = imageExtension(bytes), dimensions = await sharp(bytes).metadata();
    const local = `/banners/${id}${index ? "-02" : ""}.${extension}`;
    await fs.writeFile(`public${local}`, bytes);
    banners.push({ sourcePath: name, local, width: dimensions.width, height: dimensions.height, ...capture });
  }
  const festivals = await read<Array<{ id: string; banners: string[] }>>("src/data/festivals.json");
  festivals.find((festival) => festival.id === id)!.banners = banners.map((banner) => banner.local);
  await writeJson("src/data/festivals.json", festivals);
  const captureIndex = await read<{ results: Array<{ file: string; queryUrl?: string; rows?: string[][]; error?: string }> }>(`${root}/investigation/detail-capture-index.json`);
  const anchors = $index("a[href]").toArray(), globalImages = new Set(["image/gw.png", "image/banner01.png", "image/banner02.gif", "image/bg.png"]);
  const entries = [], sourceDetailGaps = [], imageGaps: Array<{ no?: string; originalUrl: string }> = [];
  for (const work of works) {
    const entryPath = `entry/${work.no!.padStart(3, "0")}.html`, capture = byPath.get(entryPath);
    work.source = { url: new URL(entryPath, base).href, titleUrl: catalogue.requestedUrl, ...(capture ? { snapshotUrl: capture.requestedUrl } : {}) };
    delete work.detailDisabled;
    const anchorIndex = anchors.findIndex((anchor) => $index(anchor).attr("href") === entryPath), next = anchors[anchorIndex + 1];
    const catalogueDownload = next && $index(next).text().trim() === "ファイル" ? new URL($index(next).attr("href")!, base).href : undefined;
    if (catalogueDownload) work.download = { url: catalogueDownload, label: "DL" };
    if (!capture) {
      work.sourceDetailUnavailable = true;
      const evidence = captureIndex.results.find((row) => row.file === entryPath);
      sourceDetailGaps.push({ no: work.no, sourcePath: entryPath, sourceUrl: work.source.url, cdxQueryUrl: evidence?.queryUrl, observedCaptureRows: evidence?.rows ? Math.max(0, evidence.rows.length - 1) : null, ...(evidence?.error ? { error: evidence.error } : {}) });
      continue;
    }
    const $ = await decode(capture), screenshots = [], screenshotSources = [], downloads: string[] = [];
    const fields: Array<[string, "author" | "category" | "engine" | "streaming"]> = [["作者", "author"], ["作者名", "author"], ["ジャンル", "category"], ["使用ツール", "engine"], ["ツクール", "engine"], ["配信", "streaming"]];
    $("p,li,dt,h1,h2,h3,h4").each((_, element) => {
      const block = $(element).clone();
      block.find("br").replaceWith("\n");
      for (const [label, field] of fields) {
        const match = block.text().match(new RegExp(`^[ \\t\\u3000]*■?[ \\t\\u3000]*${label}[:：][ \\t\\u3000]*([^\\n]+)`, "m"));
        if (match?.[1].trim()) work[field] = match[1].trim();
      }
    });
    for (const img of $("img[src]").toArray()) {
      const url = new URL($(img).attr("src")!, capture.originalUrl);
      if (url.hostname !== new URL(base).hostname || !url.pathname.startsWith(new URL(base).pathname)) continue;
      const resourcePath = sourcePath(url.href);
      if (globalImages.has(resourcePath)) continue;
      const resource = byPath.get(resourcePath);
      if (!resource) { imageGaps.push({ no: work.no, originalUrl: url.href }); continue; }
      const bytes = await fs.readFile(`${root}/source/archive/${resource.file}`), extension = imageExtension(bytes), dimensions = await sharp(bytes).metadata();
      const local = `/screenshots/${id}/${work.no}-${screenshots.length + 1}.${extension}`;
      await fs.mkdir(path.dirname(`public${local}`), { recursive: true });
      await fs.writeFile(`public${local}`, bytes);
      screenshots.push(local);
      screenshotSources.push({ sourcePath: resourcePath, local, width: dimensions.width, height: dimensions.height, ...resource });
    }
    if (screenshots.length) work.ss = screenshots;
    $("a[href]").each((_, element) => {
      const url = new URL($(element).attr("href")!, capture.originalUrl);
      if (/\.(zip|lzh|rar|7z)$/i.test(url.pathname) || url.hostname === "drive.google.com" || url.hostname === "box.yahoo.co.jp") downloads.push(url.href);
      if (url.hostname === "yy53.60.kg" && url.pathname.includes("/test/read.cgi/")) work.forum = url.href;
    });
    if (downloads.length) work.downloads = [...new Set(downloads)].map((url) => ({ url, label: "DL" }));
    $("script,noscript,style,iframe,form,object,embed,img,link,meta").remove();
    $("*").each((_, element) => { for (const attr of Object.keys(element.attribs)) if (attr.startsWith("on") || ["background", "bgcolor", "color", "face", "size", "align", "nowrap", "style", "width", "height"].includes(attr)) $(element).removeAttr(attr); });
    $("a[href]").each((_, element) => {
      const url = new URL($(element).attr("href")!, capture.originalUrl), target = url.pathname.match(/\/2007GW\/entry\/(\d{3})\.html$/);
      $(element).attr("href", target && sourcePaths.has(`entry/${target[1]}.html`) ? `/works/${id}-work-${String(Number(target[1])).padStart(2, "0")}` : url.hostname === new URL(base).hostname && url.pathname === `${new URL(base).pathname}index.html` ? `/#${id}` : url.href);
    });
    work.sourceContent = $("body").html()?.trim();
    delete work.sourceDetailUnavailable;
    entries.push({ no: work.no, sourcePath: entryPath, snapshotUrl: capture.requestedUrl, sourceSha256: capture.sha256, screenshotSources, catalogueDownload, detailDownloadSources: downloads });
  }
  await writeJson(file, works);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, sourceEncoding: "shift_jis", catalogueEntries: works.length, catalogueCapture: catalogue, entries, sourceDetailGaps, imageGaps, banners, catalogueSectionEvidence: `${root}/investigation/catalogue-section-review.json`, sourceEvidence: [`${root}/investigation/source-probes.json`, `${root}/investigation/source-dns-check.json`, `${root}/investigation/detail-capture-index.json`, `${root}/investigation/rate-limit-checkpoint.json`, `${root}/investigation/entry-capture-results.json`, `${root}/investigation/root-resource-captures.json`, `${root}/investigation/css-background-capture.json`], handling: "Preserve source markup and explicitly labelled metadata directly, without content review or restriction screening. Both tables belong to the works-introduction section, so retain all linked entries including 000. Catalogue and detail download links are historical source links, not availability checks. Query failures remain unresolved, not evidence of absent captures.", desktopReview: "pending" });
  await writeJson(`${root}/investigation/original-timemap.bin`, [["original", "first", "last"], ...Object.values(manifest).map((capture) => [capture.originalUrl, capture.timestamp, capture.timestamp])]);
  console.log(JSON.stringify({ works: works.length, sourceDetails: entries.length, sourceDetailGaps: sourceDetailGaps.length, sourceCaches: Object.keys(manifest).length, screenshots: entries.reduce((sum, entry) => sum + entry.screenshotSources.length, 0), unresolvedImageRefs: imageGaps.length }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
