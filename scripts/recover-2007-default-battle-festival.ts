import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import sharp from "sharp";
import { imageExtension, writeJson } from "./recover-entry-table";
import type { WorkEntry } from "../src/lib/types";

const id = "2007-default-battle-festival", root = `catch/${id}`;
const base = "https://vipkohaku.x.fc2.com/2007def/";
type Capture = { originalUrl: string; requestedUrl: string; actualUrl: string; file: string; bytes: number; sha256: string; timestamp: string; cdxDigestVerified?: boolean; cdxDigestUnavailable?: boolean; expectedDigest?: string; actualDigest?: string; captureVerification?: string };
const read = async <T,>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, "utf8"));
const normalize = (value: string) => value.normalize("NFKC").replace(/\s/g, "");

async function main() {
  const manifest = await read<Record<string, Capture>>(`${root}/source/archive/manifest.json`);
  const checks = await read<Array<{ originalUrl: string; cdxDigestVerified: boolean; expectedDigest: string; actualDigest: string; rows: string[][] }>>(`${root}/investigation/capture-digest-checks.json`);
  const detail = await read<Capture & { mementoDatetime: string; expectedDigest: string; actualDigest: string }>(`${root}/investigation/detail14-replay.json`);
  const image = await read<Capture & { mementoDatetime: string }>(`${root}/investigation/detail14-image-replay.json`);
  for (const [source, originalUrl] of [[detail, `${base}14.html`], [image, `${base}14.png`]] as const) {
    manifest[originalUrl] = { originalUrl, requestedUrl: source.requestedUrl, actualUrl: source.actualUrl, file: source.file.replace(/^source\/archive\//, ""), bytes: source.bytes, sha256: source.sha256, timestamp: new Date(source.mementoDatetime).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14), ...(source.cdxDigestVerified ? { cdxDigestVerified: true, expectedDigest: source.expectedDigest, actualDigest: source.actualDigest } : {}) };
  }
  for (const check of checks) {
    if (!check.cdxDigestVerified) throw new Error(`Unverified source digest: ${new URL(check.originalUrl).pathname}`);
    Object.assign(manifest[check.originalUrl], { cdxDigestVerified: true, expectedDigest: check.expectedDigest, actualDigest: check.actualDigest, captureVerification: "Response body matches the exact capture's CDX SHA-1 digest." });
    delete manifest[check.originalUrl].cdxDigestUnavailable;
  }
  if (!manifest[`${base}14.html`].cdxDigestVerified) throw new Error("Detail 14 digest not verified");
  for (const capture of Object.values(manifest)) {
    const bytes = await fs.readFile(`${root}/source/archive/${capture.file}`);
    if (createHash("sha256").update(bytes).digest("hex") !== capture.sha256) throw new Error("Cached source hash mismatch");
  }
  await writeJson(`${root}/source/archive/manifest.json`, manifest);
  const decode = async (capture: Capture) => {
    const bytes = await fs.readFile(`${root}/source/archive/${capture.file}`), text = iconv.decode(bytes, "shift_jis");
    if (text.includes("\uFFFD") || !iconv.encode(text, "shift_jis").equals(bytes)) throw new Error("Source encoding roundtrip failed");
    return cheerio.load(text);
  };
  const catalogue = manifest[`${base}index.html`], $index = await decode(catalogue);
  const worksFile = `src/data/works/${id}.json`, works = await read<WorkEntry[]>(worksFile);
  const comparisons = works.map((work) => ({ no: work.no, matches: normalize($index(`a[href="${work.no}.html"]`).text()) === normalize(work.title) }));
  if (comparisons.length !== 26 || comparisons.some((row) => !row.matches)) throw new Error("Catalogue identity mismatch");
  await writeJson(`${root}/investigation/title-comparison.json`, comparisons);
  const banner = manifest[`${base}defo.png`], bannerBytes = await fs.readFile(`${root}/source/archive/${banner.file}`);
  if (imageExtension(bannerBytes) !== "png") throw new Error("Festival banner format mismatch");
  await fs.writeFile(`public/banners/${id}.png`, bannerBytes);
  const festivals = await read<Array<{ id: string; banners: string[] }>>("src/data/festivals.json");
  festivals.find((festival) => festival.id === id)!.banners = [`/banners/${id}.png`];
  await writeJson("src/data/festivals.json", festivals);
  const screenshot = manifest[`${base}14.png`], screenshotBytes = await fs.readFile(`${root}/source/archive/${screenshot.file}`);
  if (imageExtension(screenshotBytes) !== "png") throw new Error("Screenshot format mismatch");
  const dimensions = await sharp(screenshotBytes).metadata();
  await fs.mkdir(`public/screenshots/${id}`, { recursive: true });
  await fs.writeFile(`public/screenshots/${id}/14.png`, screenshotBytes);
  const entries = [], sourceDetailGaps = [];
  const captureIndex = await read<{ results: Array<{ file: string; queryUrl: string; rows: string[][]; error?: string }> }>(`${root}/investigation/detail-capture-index.json`);
  for (const work of works) {
    const sourcePath = `${work.no}.html`, capture = manifest[new URL(sourcePath, base).href];
    work.source = { url: new URL(sourcePath, base).href, titleUrl: catalogue.requestedUrl, ...(capture ? { snapshotUrl: capture.requestedUrl } : {}) };
    delete work.detailDisabled;
    if (!capture) {
      work.sourceDetailUnavailable = true;
      const evidence = captureIndex.results.find((row) => row.file === sourcePath);
      sourceDetailGaps.push({ no: work.no, sourcePath, sourceUrl: work.source.url, cdxQueryUrl: evidence?.queryUrl, successfulCdxCaptures: evidence?.rows ? Math.max(0, evidence.rows.length - 1) : null, ...(evidence?.error ? { error: evidence.error } : {}) });
      continue;
    }
    const $ = await decode(capture);
    const fields: Array<[string, "author" | "category" | "engine" | "streaming"]> = [["作者", "author"], ["作者名", "author"], ["製作者", "author"], ["ジャンル", "category"], ["ツクール", "engine"], ["使用ツール", "engine"], ["配信/投稿", "streaming"]];
    $("tr").each((_, element) => {
      const cells = $(element).children("td,th");
      if (cells.length !== 2) return;
      const label = normalize(cells.eq(0).text()).replace(/[:：]/g, ""), field = fields.find(([name]) => normalize(name) === label);
      if (field && cells.eq(1).text().trim()) work[field[1]] = cells.eq(1).text().trim();
    });
    $("td,th").each((_, element) => {
      const cell = $(element).clone();
      cell.find("br").replaceWith("\n");
      const text = cell.text().trim();
      for (const [label, field] of fields) {
        const match = text.match(new RegExp(`^[ \\t\\u3000]*■?[ \\t\\u3000]*${label}[:：][ \\t\\u3000]*([^\\n]+)`, "m"));
        if (match?.[1].trim()) work[field] = match[1].trim();
      }
    });
    const downloads: string[] = [];
    $("a[href]").each((_, element) => {
      const url = new URL($(element).attr("href")!, capture.originalUrl);
      if (/\.(zip|lzh|rar|7z)$/i.test(url.pathname) || url.hostname === "drive.google.com") downloads.push(url.href);
      if (url.hostname === "yy55.60.kg" && url.pathname.includes("/test/read.cgi/viprpg/")) work.forum = url.href;
    });
    if (downloads.length) work.downloads = [...new Set(downloads)].map((url) => ({ url, label: "DL" }));
    work.ss = [...new Set([...(work.ss ?? []), `/screenshots/${id}/14.png`])];
    $("script,noscript,style,iframe,form,object,embed,img,link,meta").remove();
    $("*").each((_, element) => { for (const attr of Object.keys(element.attribs)) if (attr.startsWith("on") || ["background", "bgcolor", "color", "face", "size", "align", "nowrap", "style", "width", "height"].includes(attr)) $(element).removeAttr(attr); });
    $("a[href]").each((_, element) => {
      const url = new URL($(element).attr("href")!, capture.originalUrl), target = url.pathname.match(/\/2007def\/(\d{2})\.html$/);
      $(element).attr("href", target ? `/works/${id}-work-${target[1]}` : url.hostname === new URL(base).hostname && url.pathname === `${new URL(base).pathname}index.html` ? `/#${id}` : url.href);
    });
    work.sourceContent = $("body").html()?.trim();
    delete work.sourceDetailUnavailable;
    entries.push({ no: work.no, sourcePath, snapshotUrl: capture.requestedUrl, sourceSha256: capture.sha256, screenshotSource: screenshot, screenshotDimensions: { width: dimensions.width, height: dimensions.height }, downloadSources: downloads });
  }
  await writeJson(worksFile, works);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, sourceEncoding: "shift_jis", catalogueEntries: works.length, catalogueCapture: catalogue, entries, sourceDetailGaps, sourceEvidence: [`${root}/investigation/source-probes.json`, `${root}/investigation/migration-source-probe.json`, `${root}/investigation/migration-http-source-probe.json`, `${root}/investigation/detail-capture-index.json`, `${root}/investigation/capture-digest-checks.json`, `${root}/investigation/infoseek-index-replay.json`, `${root}/investigation/forum-replay-probe.json`], festivalBanner: { ...banner, sourcePath: "defo.png", width: 200, height: 40, local: `/banners/${id}.png` }, originalHeader: { sourcePath: "top.png", width: 900, height: 100 }, handling: "Official mirrored catalogue titles compared mechanically. Preserve source body and explicitly labelled metadata directly without content screening. The linked Infoseek snapshot does not match this catalogue; the forum replay exposes no first-post source links. Historical download links are retained without claiming availability. Each remaining detail has an exact successful-capture query with zero results; this does not prove permanent archive absence.", desktopReview: "pending" });
  const rows = checks.flatMap((check) => check.rows.slice(1));
  const detailRows = captureIndex.results.flatMap((result) => result.rows?.slice(1) ?? []);
  await writeJson(`${root}/investigation/original-timemap.bin`, [["original", "first", "last", "mimetype"], ...[...rows, ...detailRows].map((row) => [row[0], row[1], row[1], row[3]])]);
  console.log(JSON.stringify({ works: works.length, details: entries.length, detailGaps: sourceDetailGaps.length, screenshots: 1, sourceCaches: Object.keys(manifest).length }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
