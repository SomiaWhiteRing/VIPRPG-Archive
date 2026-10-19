import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import * as cheerio from "cheerio";
import sharp from "sharp";
import { ProxyAgent } from "undici";
import { decodeSource, imageExtension, writeJson } from "./recover-entry-table";
import type { WorkEntry, WorkDownload } from "../src/lib/types";

const id = "2007-summer", root = `catch/${id}`;
type Capture = { originalUrl: string; requestedUrl: string; actualUrl: string; timestamp: string; file: string; bytes: number; sha256: string; expectedDigest: string; actualDigest: string; cdxDigestVerified: boolean; proxyRegion: string };
const read = async <T,>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, "utf8"));
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function cdxDigest(bytes: Buffer) {
  const bits = [...createHash("sha1").update(bytes).digest()].map((value) => value.toString(2).padStart(8, "0")).join("");
  return bits.match(/.{5}/g)!.map((part) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[parseInt(part, 2)]).join("");
}

async function archive() {
  if (!process.argv.includes("--archive-only")) throw new Error("Archive requests require --archive-only");
  const dispatcher = new ProxyAgent("http://127.0.0.1:7897");
  try {
    const exit = await (await fetch("http://ip-api.com/json/?fields=countryCode", { dispatcher, signal: AbortSignal.timeout(15000) })).json() as { countryCode?: string };
    if (exit.countryCode !== "HK") throw new Error("Hong Kong exit required");
    const rows = (await read<string[][]>(`${root}/investigation/available-prefix-cdx.json`)).slice(1);
    const topRows = (await read<{ rows: string[][] }>(`${root}/investigation/top-exact-cdx.json`)).rows;
    const newestTop = topRows.slice(1).find((row) => row[1] === "20230528073016");
    if (!newestTop) throw new Error("Known top-page snapshot missing from exact index");
    rows[rows.findIndex((row) => new URL(row[0]).pathname.endsWith("/top.html"))] = newestTop;
    const known = await read<Array<{ url: string; file: string; mementoDatetime: string }>>(`${root}/investigation/known-page-replays.json`);
    const manifestFile = `${root}/source/archive/manifest.json`;
    const manifest = await read<Record<string, Capture>>(manifestFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return {};
      throw error;
    });
    const results: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const [originalUrl, timestamp, , , expectedDigest] = row;
      const requestedUrl = `https://web.archive.org/web/${timestamp}id_/${originalUrl}`;
      const cached = manifest[originalUrl];
      if (cached?.timestamp === timestamp && cached.cdxDigestVerified && sha256(await fs.readFile(`${root}/source/archive/${cached.file}`)) === cached.sha256) {
        results.push({ originalUrl, status: "cached", cdxDigestVerified: true });
        continue;
      }
      const prior = known.find((page) => page.url === requestedUrl);
      let bytes: Buffer | undefined, actualUrl = requestedUrl;
      let status = 200, mementoDatetime: string | null = prior?.mementoDatetime ?? null;
      let networkRequest = false;
      try {
        if (prior) bytes = await fs.readFile(`${root}/${prior.file}`);
        else {
          networkRequest = true;
          for (let redirect = 0; redirect < 6; redirect++) {
            if (new URL(actualUrl).hostname !== "web.archive.org") throw new Error("Archive redirect left the archive host");
            const response = await fetch(actualUrl, { dispatcher, redirect: "manual", signal: AbortSignal.timeout(45000) });
            status = response.status;
            if (status === 429) {
              results.push({ originalUrl, requestedUrl, status, retryAfter: response.headers.get("retry-after") });
              await response.body?.cancel();
              await writeJson(`${root}/investigation/archive-retrieval.json`, { proxyRegion: "Hong Kong", stoppedByRateLimit: true, results });
              return;
            }
            if (status >= 300 && status < 400 && response.headers.get("location")) {
              actualUrl = new URL(response.headers.get("location")!, actualUrl).href;
              await response.body?.cancel();
              continue;
            }
            bytes = Buffer.from(await response.arrayBuffer());
            mementoDatetime = response.headers.get("memento-datetime");
            break;
          }
        }
        if (!bytes) throw new Error("No replay body obtained");
        const file = `capture-${sha256(Buffer.from(originalUrl)).slice(0, 20)}.bin`;
        await fs.writeFile(`${root}/source/archive/${file}`, bytes);
        const actualDigest = cdxDigest(bytes), verified = expectedDigest === actualDigest;
        results.push({ originalUrl, requestedUrl, actualUrl, status, mementoDatetime, file, bytes: bytes.length, expectedDigest, actualDigest, cdxDigestVerified: verified });
        if (status !== 200 || !mementoDatetime || !verified) throw new Error("Replay status, Memento, or CDX digest not verified");
        manifest[originalUrl] = { originalUrl, requestedUrl, actualUrl, timestamp, file, bytes: bytes.length, sha256: sha256(bytes), expectedDigest, actualDigest, cdxDigestVerified: true, proxyRegion: "Hong Kong" };
        await writeJson(manifestFile, manifest);
      } catch (error) { results.push({ originalUrl, requestedUrl, error: String(error) }); }
      await writeJson(`${root}/investigation/archive-retrieval.json`, { proxyRegion: "Hong Kong", planned: rows.length, results });
      console.log(JSON.stringify({ processed: results.filter((result) => result.cdxDigestVerified).length, planned: rows.length, cachedResources: Object.keys(manifest).length }));
      if (networkRequest) await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  } finally { await dispatcher.close(); }
}

async function prepare() {
  const base = "https://vipkohaku.x.fc2.com/2007s/";
  const sourcePath = (url: string) => {
    const value = new URL(url).pathname.slice(new URL(base).pathname.length) || "index.html";
    return value.endsWith("/") ? `${value}index.html` : value;
  };
  const manifest = await read<Record<string, Capture>>(`${root}/source/archive/manifest.json`);
  const byPath = new Map(Object.values(manifest).map((capture) => [sourcePath(capture.originalUrl), capture]));
  const documents: Array<{ sourcePath: string; declaredEncoding?: string; replacementCharacters: number }> = [];
  for (const capture of Object.values(manifest)) {
    const bytes = await fs.readFile(`${root}/source/archive/${capture.file}`);
    if (!capture.cdxDigestVerified || sha256(bytes) !== capture.sha256 || cdxDigest(bytes) !== capture.expectedDigest) throw new Error("Unverified source cache");
    if (/\.html$|\/$/.test(new URL(capture.originalUrl).pathname)) {
      const text = decodeSource(bytes, "shift_jis"), replacements = (text.match(/\uFFFD/g) ?? []).length;
      if (replacements) throw new Error("Source decoding introduced replacement characters");
      documents.push({ sourcePath: sourcePath(capture.originalUrl), declaredEncoding: bytes.subarray(0, 4096).toString("latin1").match(/charset\s*=\s*["']?\s*([\w-]+)/i)?.[1], replacementCharacters: replacements });
    }
  }
  const document = async (capture: Capture) => cheerio.load(decodeSource(await fs.readFile(`${root}/source/archive/${capture.file}`), "shift_jis"));
  const catalogue = byPath.get("ss.html")!, $index = await document(catalogue), file = `src/data/works/${id}.json`;
  const works = await read<WorkEntry[]>(file), normalize = (text: string) => text.normalize("NFKC").replace(/\s/g, "");
  const rowMap = new Map<string, { sourcePath: string; title: string; downloads: WorkDownload[] }>();
  $index("tr").slice(1).each((_, tr) => {
    const cells = $index(tr).children("td,th"), number = cells.eq(0).text().match(/\d+/)?.[0];
    if (!number) return;
    const no = String(Number(number)).padStart(2, "0");
    const sourcePaths = $index(tr).find("a[href]").toArray().map((a) => $index(a).attr("href")!).filter((href) => /^ss\d+\.html$/.test(href));
    if (sourcePaths.length !== 1) throw new Error(`Unexpected detail link count for ${no}`);
    const downloads = cells.eq(3).find("a[href]").toArray().map((a) => new URL($index(a).attr("href")!, catalogue.originalUrl)).filter((url) => /^https?:$/.test(url.protocol)).map((url) => ({ url: url.href, label: "DL" }));
    rowMap.set(no, { sourcePath: sourcePaths[0], title: cells.eq(1).text().trim(), downloads });
  });
  if (rowMap.size !== 97 || works.length !== 97 || works.some((work) => normalize(rowMap.get(work.no!)?.title ?? "") !== normalize(work.title))) throw new Error("Catalogue identity mismatch");
  const patches = await read<Array<{ row: number; no: string | null; titleMatches: boolean; patchUrls: string[]; updateLabel: string }>>(`${root}/investigation/patch-row-map.json`);
  if (patches.length !== 34 || patches.some((patch) => !works.some((work) => work.no === patch.no))) throw new Error("Patch identifiers not matched");
  const banner = byPath.get("natu1.png")!, bannerBytes = await fs.readFile(`${root}/source/archive/${banner.file}`), bannerExtension = imageExtension(bannerBytes), bannerDimensions = await sharp(bannerBytes).metadata();
  const bannerLocal = `/banners/${id}.${bannerExtension}`;
  await fs.writeFile(`public${bannerLocal}`, bannerBytes);
  const festivals = await read<Array<{ id: string; banners: string[] }>>("src/data/festivals.json");
  festivals.find((festival) => festival.id === id)!.banners = [bannerLocal];
  await writeJson("src/data/festivals.json", festivals);
  const captureIndex = await read<{ results: Array<{ file: string; queryUrl?: string; rows?: string[][]; error?: string }> }>(`${root}/investigation/detail-capture-index.json`);
  const entries = [], sourceDetailGaps = [], imageGaps: Array<{ no: string; originalUrl: string }> = [];
  for (const work of works) {
    const row = rowMap.get(work.no!)!, capture = byPath.get(row.sourcePath);
    work.source = { url: new URL(row.sourcePath, base).href, titleUrl: catalogue.requestedUrl, ...(capture ? { snapshotUrl: capture.requestedUrl } : {}) };
    delete work.detailDisabled;
    delete work.download;
    delete work.downloads;
    const patchLinks = patches.filter((patch) => patch.no === work.no).flatMap((patch) => patch.patchUrls.map((url) => ({ url, label: "patch" })));
    const downloads = [...row.downloads, ...patchLinks].filter((item, index, list) => list.findIndex((other) => other.url === item.url && other.label === item.label) === index);
    if (row.downloads.length) work.download = row.downloads[0];
    if (downloads.length) work.downloads = downloads;
    if (!capture) {
      work.sourceDetailUnavailable = true;
      const evidence = captureIndex.results.find((entry) => entry.file === row.sourcePath);
      sourceDetailGaps.push({ no: work.no, sourcePath: row.sourcePath, sourceUrl: work.source.url, cdxQueryUrl: evidence?.queryUrl, observedCaptureRows: evidence?.rows ? Math.max(0, evidence.rows.length - 1) : null, ...(evidence?.error ? { error: evidence.error } : {}) });
      continue;
    }
    const $ = await document(capture), screenshots = [], screenshotSources = [];
    const fields: Array<[string, "author" | "category" | "engine" | "streaming"]> = [["作者", "author"], ["作者名", "author"], ["ジャンル", "category"], ["使用ツール", "engine"], ["ツクール", "engine"], ["配信", "streaming"]];
    $("tr").each((_, tr) => {
      const cells = $(tr).children("td,th");
      if (cells.length !== 2) return;
      const label = normalize(cells.eq(0).text()).replace(/[:：■【】]/g, ""), field = fields.find(([name]) => normalize(name) === label);
      if (field && cells.eq(1).text().trim()) work[field[1]] = cells.eq(1).text().trim();
    });
    for (const img of $("img[src]").toArray()) {
      const url = new URL($(img).attr("src")!, capture.originalUrl);
      if (url.hostname !== new URL(base).hostname || !url.pathname.startsWith(new URL(base).pathname)) continue;
      const resourcePath = sourcePath(url.href), resource = byPath.get(resourcePath);
      if (!resource) { imageGaps.push({ no: work.no!, originalUrl: url.href }); continue; }
      const bytes = await fs.readFile(`${root}/source/archive/${resource.file}`), extension = imageExtension(bytes), dimensions = await sharp(bytes).metadata();
      const local = `/screenshots/${id}/${work.no}-${screenshots.length + 1}.${extension}`;
      await fs.mkdir(path.dirname(`public${local}`), { recursive: true });
      await fs.writeFile(`public${local}`, bytes);
      screenshots.push(local);
      screenshotSources.push({ sourcePath: resourcePath, local, width: dimensions.width, height: dimensions.height, ...resource });
    }
    if (screenshots.length) work.ss = screenshots;
    $("script,noscript,style,iframe,form,object,embed,img,link,meta").remove();
    $("*").each((_, element) => { for (const attr of Object.keys(element.attribs)) if (attr.startsWith("on") || ["background", "bgcolor", "color", "face", "size", "align", "nowrap", "style", "width", "height"].includes(attr)) $(element).removeAttr(attr); });
    $("a[href]").each((_, element) => {
      const url = new URL($(element).attr("href")!, capture.originalUrl), targetPath = sourcePath(url.href), targetWork = [...rowMap].find(([, value]) => value.sourcePath === targetPath)?.[0];
      $(element).attr("href", url.hostname === new URL(base).hostname && targetWork ? `/works/${id}-work-${targetWork}` : url.hostname === new URL(base).hostname && targetPath === "ss.html" ? `/#${id}` : url.href);
    });
    work.sourceContent = $("body").html()?.trim();
    delete work.sourceDetailUnavailable;
    entries.push({ no: work.no, sourcePath: row.sourcePath, snapshotUrl: capture.requestedUrl, sourceSha256: capture.sha256, screenshotSources });
  }
  const aux = await read<Array<{ sourcePath: string; queryUrl: string; rows?: string[][]; error?: string }>>(`${root}/investigation/auxiliary-capture-index.json`);
  const unavailableSourcePages = aux.filter((item) => !byPath.has(item.sourcePath)).map((item) => ({ sourcePath: item.sourcePath, sourceUrl: new URL(item.sourcePath, base).href, cdxQueryUrl: item.queryUrl, observedCaptureRows: item.rows ? Math.max(0, item.rows.length - 1) : null, ...(item.error ? { error: item.error } : {}) }));
  const linkedImages = await read<Array<{ originalUrl: string; requestedUrl: string; status?: number; imageSignature?: boolean; sourcePathUnchanged?: boolean; error?: string }>>(`${root}/investigation/linked-image-replays.json`);
  const failures = linkedImages.map((result) => ({ sourceUrl: result.originalUrl, requestedUrl: result.requestedUrl, error: result.error ?? (result.status === 200 && (!result.imageSignature || !result.sourcePathUnchanged) ? "Archive replay redirected to a different source path and returned a non-image body; no usable image recovered." : `Archive replay returned HTTP ${result.status}; source gap remains unresolved.`) }));
  await writeJson(file, works);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, sourceEncodingFallback: "shift_jis", documentEncodings: documents, catalogueEntries: works.length, catalogueCapture: catalogue, entries, sourceDetailGaps, unavailableSourcePages, imageGaps, failures, sourceEvidence: [`${root}/investigation/source-probes.json`, `${root}/investigation/detail-capture-index.json`, `${root}/investigation/shared-decoder-review.json`, `${root}/investigation/document-encoding-review.json`, `${root}/investigation/catalogue-encoding-review.json`, `${root}/investigation/additional-image-captures.json`, `${root}/investigation/linked-image-replays.json`], patchCatalogue: { capture: byPath.get("2007p/index.html"), rows: patches.length, identityVerifiedByExplicitNumber: patches.length, titleMatches: patches.filter((patch) => patch.titleMatches).length, titleVariantRows: patches.filter((patch) => !patch.titleMatches).map((patch) => ({ no: patch.no, row: patch.row })), sourceEvidence: `${root}/investigation/patch-row-map.json` }, banner: { sourcePath: "natu1.png", local: bannerLocal, width: bannerDimensions.width, height: bannerDimensions.height, ...banner }, frames: { menuPage: "menu.html", menuName: "", mainName: "sita" }, handling: "Preserve all source catalogue entries and original bytes without content review or restriction screening. Follow declared page encodings; retain raw EUC-JP byte aliases while producing stable Unicode. Keep primary catalogue titles and save patch links separately as patch, including explicit-number title variations. Historical package availability is not claimed.", desktopReview: "pending" });
  await writeJson(`${root}/investigation/original-timemap.bin`, [["original", "first", "last"], ...Object.values(manifest).map((capture) => [capture.originalUrl, capture.timestamp, capture.timestamp])]);
  console.log(JSON.stringify({ works: works.length, details: entries.length, detailGaps: sourceDetailGaps.length, screenshots: entries.reduce((sum, entry) => sum + entry.screenshotSources.length, 0), patchEntries: patches.length, auxiliaryGaps: unavailableSourcePages.length, imageGaps: imageGaps.length }));
}

const mode = process.argv[2] ?? "prepare";
const action = mode === "archive-only" ? archive : mode === "prepare" ? prepare : undefined;
if (!action) throw new Error("Choose prepare or archive-only --archive-only");
action().catch((error) => { console.error(error); process.exitCode = 1; });
