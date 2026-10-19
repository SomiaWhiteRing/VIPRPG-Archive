import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { ProxyAgent } from "undici";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import sharp from "sharp";
import type { WorkEntry } from "../src/lib/types";
import { imageExtension, writeJson } from "./recover-entry-table";

const id = "2008-summer", root = `catch/${id}`;
const base = "http://www.geocities.jp/viprpg_natunozin08/";
type Row = string[];
type Capture = { originalUrl: string; requestedUrl: string; actualUrl: string; timestamp: string; file: string; bytes: number; sha256: string; digest: string; cdxDigestVerified: boolean; captureVerification?: string; replayDigestDifference?: { observedDigest: string; identityEvidence: string; headerEvidence: string }; proxyRegion: string; exitCountry: string };
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function digest(bytes: Buffer) {
  const bits = [...createHash("sha1").update(bytes).digest()].map((n) => n.toString(2).padStart(8, "0")).join("");
  let result = "";
  for (let i = 0; i < bits.length; i += 5) result += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[Number.parseInt(bits.slice(i, i + 5), 2)];
  return result;
}

async function readJson<T>(file: string): Promise<T> { return JSON.parse(await fs.readFile(file, "utf8")) as T; }

async function inventory() {
  const rows = await readJson<Row[]>(`${root}/investigation/successful-prefix-cdx.json`);
  const legacy = await readJson<Row[]>("tmp_2008summer_timemap.json");
  await writeJson(`${root}/investigation/legacy-url-timemap.json`, legacy);
  const details = rows.slice(1).flatMap((row) => { const m = new URL(row[0]).pathname.match(/\/SS_(\d+)\.htm$/i); return m ? [m[1]] : []; });
  const groups: Record<string, number> = {};
  for (const row of rows.slice(1)) {
    const file = new URL(row[0]).pathname.split("/").at(-1)!;
    const kind = /SS_\d+_bana\./i.test(file) ? "entryBanners" : /SS_\d+\.(png|jpe?g|gif)$/i.test(file) ? "entryImages" : row[3];
    groups[kind] = (groups[kind] ?? 0) + 1;
  }
  await writeJson(`${root}/investigation/source-plan.json`, { festivalId: id, sourceBase: base, listedEntries: 92, successfulCapturePaths: rows.length - 1, detailNumbers: details, groups, scope: "Source structures, original bytes and resource metadata only; no entry-content screening." });
  await fs.writeFile(`${root}/investigation/original-timemap.bin`, JSON.stringify(rows) + "\n");
  console.log(JSON.stringify({ mode: "inventory", successfulPaths: rows.length - 1, details: details.length, groups }));
}

async function archiveOnly() {
  if (!process.argv.includes("--archive-only")) throw new Error("Use explicit --archive-only");
  const port = Number(process.argv.find((arg) => arg.startsWith("--proxy-port="))?.split("=")[1] ?? 7897);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid proxy port");
  const dispatcher = new ProxyAgent(`http://127.0.0.1:${port}`);
  const cache = `${root}/source/archive`;
  await fs.mkdir(cache, { recursive: true });
  const manifest = await readJson<Record<string, Capture>>(`${cache}/manifest.json`).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return {}; throw error; });
  try {
    const response = await fetch("http://ip-api.com/json/?fields=countryCode", { dispatcher, signal: AbortSignal.timeout(15000) });
    const route = await response.json() as { countryCode?: string };
    if (route.countryCode !== "HK") throw new Error(`Hong Kong exit required; observed ${route.countryCode ?? "unknown"}`);
    const rows = (await readJson<Row[]>(`${root}/investigation/successful-prefix-cdx.json`)).slice(1);
    const results: Array<Record<string, unknown>> = [];
    for (let start = 0; start < rows.length; start += 2) {
      const batch = await Promise.all(rows.slice(start, start + 2).map(async (row) => {
        const [originalUrl, timestamp, status, mime, expectedDigest] = row;
        const requestedUrl = `https://web.archive.org/web/${timestamp}id_/${originalUrl}`;
        const prior = manifest[originalUrl];
        if (prior && prior.digest === expectedDigest) {
          const bytes = await fs.readFile(`${cache}/${prior.file}`).catch(() => undefined);
          if (bytes && sha(bytes) === prior.sha256) return { originalUrl, cached: true, capture: prior };
        }
        try {
          let url = requestedUrl, res: Response | undefined;
          for (let redirect = 0; redirect < 6; redirect++) {
            if (new URL(url).hostname !== "web.archive.org") throw new Error("Archive redirect leaves the Hong Kong archive service; no live fallback performed");
            res = await fetch(url, { dispatcher, redirect: "manual", signal: AbortSignal.timeout(30000) });
            if (res.status >= 300 && res.status < 400 && res.headers.get("location")) { url = new URL(res.headers.get("location")!, url).href; continue; }
            break;
          }
          if (!res?.ok) throw new Error(`HTTP ${res?.status ?? "unknown"}`);
          const bytes = Buffer.from(await res.arrayBuffer());
          const file = `capture-${createHash("sha256").update(originalUrl).digest("hex").slice(0, 20)}.bin`;
          await fs.writeFile(`${cache}/${file}`, bytes);
          if (digest(bytes) !== expectedDigest) throw new Error("Archived bytes differ from the selected CDX digest; returned bytes retained");
          if (mime.startsWith("image/")) imageExtension(bytes);
          const capture: Capture = { originalUrl, requestedUrl, actualUrl: url, timestamp, file, bytes: bytes.length, sha256: sha(bytes), digest: expectedDigest, cdxDigestVerified: true, proxyRegion: "Hong Kong", exitCountry: "HK" };
          return { originalUrl, status, capture };
        } catch (error) { return { originalUrl, requestedUrl, error: String(error) }; }
      }));
      for (const result of batch) {
        if (result.capture) manifest[result.originalUrl] = result.capture;
        results.push({ originalUrl: result.originalUrl, ...(result.capture ? { bytes: result.capture.bytes, cached: "cached" in result && result.cached, saved: true, cdxDigestVerified: result.capture.cdxDigestVerified, ...(result.capture.replayDigestDifference ? { replayDigestDifference: result.capture.replayDigestDifference } : {}) } : { error: result.error }) });
      }
      await writeJson(`${cache}/manifest.json`, manifest);
      await writeJson(`${root}/investigation/archive-retrieval.json`, { region: "Hong Kong", exitCountry: "HK", proxyPort: port, planned: rows.length, processed: results.length, recovered: results.filter((r) => r.saved).length, matchingCdxDigests: results.filter((r) => r.cdxDigestVerified).length, replayDigestDifferences: results.filter((r) => r.replayDigestDifference).length, failures: results.filter((r) => r.error), resources: results });
      if (results.length % 10 === 0 || results.length === rows.length) console.log(JSON.stringify({ processed: results.length, planned: rows.length, recovered: results.filter((r) => r.saved).length, failures: results.filter((r) => r.error).length }));
    }
    if (results.some((result) => result.error)) process.exitCode = 1;
  } finally { await dispatcher.close(); }
}

async function prepare() {
  const file = `src/data/works/${id}.json`;
  const works = await readJson<WorkEntry[]>(file);
  const captures = Object.values(await readJson<Record<string, Capture>>(`${root}/source/archive/manifest.json`));
  const relative = (url: string) => new URL(url).pathname.slice(new URL(base).pathname.length) || "index.html";
  const byPath = new Map(captures.map((capture) => [relative(capture.originalUrl).toLowerCase(), capture]));
  const list = byPath.get("work_list.htm");
  const entry = byPath.get("index.html");
  if (!list || !entry) throw new Error("Source entry and catalogue required");
  const decode = async (capture: Capture) => {
    const bytes = await fs.readFile(`${root}/source/archive/${capture.file}`);
    const text = iconv.decode(bytes, "shift_jis");
    if (text.includes("\ufffd") || !iconv.encode(text, "shift_jis").equals(bytes)) throw new Error(`Source encoding mismatch: ${relative(capture.originalUrl)}`);
    return text;
  };
  const $list = cheerio.load(await decode(list));
  const listed = new Map<string, string>();
  $list("a[href]").each((_, element) => {
    const match = $list(element).attr("href")!.match(/^SS_(\d+)\.htm$/i);
    if (match) listed.set(match[1].padStart(2, "0"), $list(element).text().replace(/\s+/g, " ").trim());
  });
  if (listed.size !== works.length || works.some((work) => !listed.has(work.no!))) throw new Error("Source catalogue number mismatch");
  const differences = works.filter((work) => work.title.replace(/\s+/g, " ").trim() !== listed.get(work.no!)).map((work) => ({ no: work.no }));
  await writeJson(`${root}/investigation/title-comparison.json`, { compared: works.length, matching: works.length - differences.length, differences, method: "Mechanical normalized string comparison; no source text displayed." });
  if (differences.length) throw new Error("Catalogue title differences require investigation");
  const baseline = `${root}/investigation/pre-recovery-baseline.json`;
  if (!(await fs.stat(baseline).catch(() => undefined))) await writeJson(baseline, { works: works.length, disabled: works.filter((work) => work.detailDisabled).length, sourcePages: works.filter((work) => work.source).length, screenshotReferences: works.reduce((n, work) => n + (work.ss?.length ?? 0), 0), bannerReferences: works.filter((work) => work.banner).length });
  const imageSources: Array<Record<string, unknown>> = [];
  for (const work of works) { delete work.ss; delete work.banner; }
  for (const capture of captures) {
    const sourcePath = relative(capture.originalUrl);
    const match = sourcePath.match(/^SS_(\d+)([^/]*)\.(png|jpe?g|gif)$/i);
    if (!match) continue;
    const no = match[1].padStart(2, "0"), work = works.find((work) => work.no === no);
    if (!work) continue;
    const bytes = await fs.readFile(`${root}/source/archive/${capture.file}`);
    const extension = imageExtension(bytes);
    const dimensions = await sharp(bytes).metadata();
    if (!dimensions.width || !dimensions.height) throw new Error("Missing image dimensions");
    const banner = /^_bana$/i.test(match[2]);
    const local = banner ? `/banners/${id}/works/${no}.${extension}` : `/screenshots/${id}/${path.posix.basename(sourcePath).replace(/\.[^.]+$/, "")}.${extension}`;
    await fs.mkdir(path.dirname(`public${local}`), { recursive: true });
    await fs.writeFile(`public${local}`, bytes);
    if (banner) work.banner = { src: local, width: dimensions.width, height: dimensions.height };
    else work.ss = [...(work.ss ?? []), local];
    imageSources.push({ no, kind: banner ? "work-banner" : "screenshot", sourcePath, local, width: dimensions.width, height: dimensions.height, originalUrl: capture.originalUrl, snapshotUrl: capture.requestedUrl, sha256: capture.sha256 });
  }
  const sourceDetailGaps = [], entries = [];
  for (const work of works) {
    const sourcePath = `SS_${work.no}.htm`, capture = byPath.get(sourcePath.toLowerCase());
    work.source = { url: new URL(sourcePath, base).href, titleUrl: list.requestedUrl, ...(capture ? { snapshotUrl: capture.requestedUrl } : {}) };
    delete work.detailDisabled;
    if (!capture) {
      work.sourceDetailUnavailable = true;
      sourceDetailGaps.push({ no: work.no, sourcePath, sourceUrl: work.source.url });
      continue;
    }
    const $ = cheerio.load(await decode(capture));
    $("tr").each((_, element) => {
      const cells = $(element).children("td,th");
      if (cells.length !== 2) return;
      const label = cells.eq(0).text().normalize("NFKC").replace(/[\s:：]/g, "");
      const value = cells.eq(1).text().trim();
      if (!value) return;
      if (label === "ジャンル") work.category = value;
      if (["作者", "作者名", "製作者", "制作者", "HN", "ハンドルネーム"].includes(label)) work.author = value;
      if (["ツール", "使用ツール", "制作ツール"].includes(label)) work.engine = value;
      if (["配信", "実況"].includes(label)) work.streaming = value;
    });
    const downloads: string[] = [];
    $("a[href]").each((_, element) => {
      const href = new URL($(element).attr("href")!, capture.originalUrl);
      if (/\.(zip|lzh|rar|7z)$/i.test(href.pathname)) downloads.push(href.href);
      if (href.hostname === "yy64.60.kg" && /\/test\/read\.cgi\/kansoplus\//.test(href.pathname)) work.forum = href.href;
    });
    if (downloads.length) work.downloads = [...new Set(downloads)].map((url) => ({ url, label: "DL" }));
    $("script,noscript,style,iframe,form,object,embed,img,link,meta").remove();
    $('a[href*="chakumero.mobile.yahoo.co.jp"]').remove();
    $("*").each((_, element) => { for (const attr of Object.keys(element.attribs)) if (attr.startsWith("on") || ["background", "bgcolor", "color", "face", "size", "align", "nowrap", "style", "width", "height"].includes(attr)) $(element).removeAttr(attr); });
    $("a[href]").each((_, element) => {
      const url = new URL($(element).attr("href")!, capture.originalUrl);
      const target = url.pathname.match(/\/SS_(\d+)\.htm$/i);
      $(element).attr("href", target ? `/works/${id}-work-${target[1].padStart(2, "0")}` : /\/Work_list\.htm$/i.test(url.pathname) ? `/#${id}` : url.href);
    });
    work.sourceContent = $("body").html()?.trim();
    delete work.sourceDetailUnavailable;
    entries.push({ no: work.no, sourcePath, snapshotUrl: capture.requestedUrl, sourceSha256: capture.sha256, sourceBodySaved: Boolean(work.sourceContent), downloadSources: downloads });
  }
  const festivalBanner = byPath.get("natunozin_bana.png");
  if (festivalBanner) {
    const bytes = await fs.readFile(`${root}/source/archive/${festivalBanner.file}`);
    if (imageExtension(bytes) !== "png") throw new Error("Festival banner format mismatch");
    await fs.writeFile(`public/banners/${id}.png`, bytes);
    const festivalFile = "src/data/festivals.json";
    const festivals = await readJson<Array<{ id: string; banners: string[] }>>(festivalFile);
    festivals.find((festival) => festival.id === id)!.banners = [`/banners/${id}.png`];
    await writeJson(festivalFile, festivals);
  }
  await writeJson(file, works);
  const linked = await readJson<{ results: Array<{ originalUrl: string; requestedUrl: string; status?: number; error?: string; recovered: boolean }> }>(`${root}/investigation/linked-capture-results.json`).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return { results: [] };
    throw error;
  });
  const failures = linked.results.filter((result) => !result.recovered).map((result) => ({ sourceUrl: result.originalUrl, requestedUrl: result.requestedUrl, error: result.error ?? `Archive replay returned HTTP ${result.status}; source gap remains unresolved.` }));
  await writeJson(`${root}/recovery.json`, { festivalId: id, catalogueEntries: works.length, catalogueCapture: list, entryCapture: entry, entries, sourceDetailGaps, imageSources, unavailableSourcePages: [{ sourcePath: "meyasu.htm", sourceUrl: new URL("meyasu.htm", base).href }], failures, handling: "Catalogue titles compared mechanically. Source body markup and explicitly labelled fields copied directly; no content-based screening or new restrictions. Work banners remain separate from icons and screenshots. Historic package/forum links retained; availability not implied.", sourceEncoding: "shift_jis", desktopReview: "pending" });
  console.log(JSON.stringify({ mode: "prepare", works: works.length, details: entries.length, detailGaps: sourceDetailGaps.length, workBanners: works.filter((work) => work.banner).length, screenshots: works.reduce((n, work) => n + (work.ss?.length ?? 0), 0) }));
}

async function linkedCaptures() {
  if (!process.argv.includes("--archive-only")) throw new Error("Use explicit --archive-only");
  const dispatcher = new ProxyAgent("http://127.0.0.1:7897");
  const cache = `${root}/source/archive`;
  const manifest = await readJson<Record<string, Capture>>(`${cache}/manifest.json`);
  const localPath = (url: string) => new URL(url).pathname.slice(new URL(base).pathname.length) || "index.html";
  const known = new Set(Object.values(manifest).map((capture) => localPath(capture.originalUrl).toLowerCase()));
  const planned = new Map<string, { originalUrl: string; owner: string; timestamp: string }>();
  for (const capture of Object.values(manifest).filter((capture) => /\.html?$/i.test(new URL(capture.originalUrl).pathname))) {
    const $ = cheerio.load(iconv.decode(await fs.readFile(`${cache}/${capture.file}`), "shift_jis"));
    $("img[src],[background],a[href]").each((_, element) => {
      const value = $(element).attr("src") ?? $(element).attr("background") ?? $(element).attr("href");
      if (!value || value.startsWith("#")) return;
      const url = new URL(value, capture.originalUrl);
      if (url.hostname !== new URL(base).hostname || !url.pathname.startsWith(new URL(base).pathname)) return;
      const rel = localPath(url.href);
      if (!/\.(png|jpe?g|gif|htm|html)$/i.test(rel) || known.has(rel.toLowerCase())) return;
      if (!planned.has(rel.toLowerCase())) planned.set(rel.toLowerCase(), { originalUrl: url.href, owner: capture.originalUrl, timestamp: capture.timestamp });
    });
  }
  await writeJson(`${root}/investigation/linked-capture-plan.json`, [...planned.values()]);
  await fs.mkdir(`${cache}/linked-responses`, { recursive: true });
  const results: Array<Record<string, unknown>> = [];
  try {
    const route = await (await fetch("http://ip-api.com/json/?fields=countryCode", { dispatcher, signal: AbortSignal.timeout(15000) })).json() as { countryCode?: string };
    if (route.countryCode !== "HK") throw new Error("Hong Kong exit required");
    const items = [...planned.values()];
    for (let start = 0; start < items.length; start += 2) {
      const batch = await Promise.all(items.slice(start, start + 2).map(async (item) => {
        const requestedUrl = `https://web.archive.org/web/${item.timestamp}id_/${item.originalUrl}`;
        let url = requestedUrl;
        try {
          let response: Response | undefined;
          for (let redirect = 0; redirect < 6; redirect++) {
            if (new URL(url).hostname !== "web.archive.org") throw new Error("Replay redirect leaves the archive service; no live request made");
            response = await fetch(url, { dispatcher, redirect: "manual", signal: AbortSignal.timeout(20000) });
            if (response.status >= 300 && response.status < 400 && response.headers.get("location")) { url = new URL(response.headers.get("location")!, url).href; continue; }
            break;
          }
          if (!response) throw new Error("No replay response");
          const bytes = Buffer.from(await response.arrayBuffer());
          const file = `linked-responses/${createHash("sha256").update(item.originalUrl).digest("hex").slice(0, 20)}.bin`;
          await fs.writeFile(`${cache}/${file}`, bytes);
          if (!response.ok) return { ...item, requestedUrl, actualUrl: url, status: response.status, file, bytes: bytes.length };
          const replayOriginal = url.match(/\/web\/\d+[a-z_]*\/(https?:\/\/.*)$/)?.[1];
          if (!replayOriginal || new URL(replayOriginal).hostname !== new URL(item.originalUrl).hostname || new URL(replayOriginal).pathname.toLowerCase() !== new URL(item.originalUrl).pathname.toLowerCase()) throw new Error("Replay redirected to a different original source path");
          const memento = response.headers.get("memento-datetime");
          if (!memento) throw new Error("No archived capture datetime returned");
          if (/\.(png|jpe?g|gif)$/i.test(new URL(item.originalUrl).pathname)) imageExtension(bytes);
          const timestamp = new Date(memento).toISOString().replace(/\D/g, "").slice(0, 14);
          const capture: Capture = { originalUrl: item.originalUrl, requestedUrl: `https://web.archive.org/web/${timestamp}id_/${item.originalUrl}`, actualUrl: url, timestamp, file, bytes: bytes.length, sha256: sha(bytes), digest: "not-provided-by-success-index", cdxDigestVerified: false, captureVerification: "HTTP 200, Memento capture datetime, original source path and image signature where applicable; raw response retained.", proxyRegion: "Hong Kong", exitCountry: "HK" };
          return { ...item, requestedUrl, actualUrl: url, status: response.status, file, bytes: bytes.length, capture };
        } catch (error) { return { ...item, requestedUrl, actualUrl: url, error: String(error) }; }
      }));
      for (const item of batch) {
        if (item.capture) manifest[item.originalUrl] = item.capture;
        results.push({ originalUrl: item.originalUrl, requestedUrl: item.requestedUrl, actualUrl: item.actualUrl, status: item.status, file: item.file, bytes: item.bytes, error: item.error, recovered: Boolean(item.capture) });
      }
      await writeJson(`${cache}/manifest.json`, manifest);
      await writeJson(`${root}/investigation/linked-capture-results.json`, { region: "Hong Kong", planned: items.length, processed: results.length, recovered: results.filter((item) => item.recovered).length, results });
      if (results.length % 10 === 0 || results.length === items.length) console.log(JSON.stringify({ linkedProcessed: results.length, planned: items.length, recovered: results.filter((item) => item.recovered).length }));
    }
  } finally { await dispatcher.close(); }
}

async function main() {
  if (process.argv[2] === "inventory") return inventory();
  if (process.argv[2] === "archive-only") return archiveOnly();
  if (process.argv[2] === "prepare") return prepare();
  if (process.argv[2] === "linked-captures") return linkedCaptures();
  throw new Error("Use inventory, archive-only --archive-only, linked-captures --archive-only, or prepare");
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
