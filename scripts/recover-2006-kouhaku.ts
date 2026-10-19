import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import sharp from "sharp";
import { ProxyAgent } from "undici";
import { decodeSource, imageExtension, writeJson } from "./recover-entry-table";
import type { WorkEntry, WorkDownload } from "../src/lib/types";

const id = "2006-kouhaku", root = `catch/${id}`, base = "http://www.geocities.jp/vipkouhaku/";
type Capture = { originalUrl: string; requestedUrl: string; actualUrl: string; timestamp: string; file: string; bytes: number; sha256: string; expectedDigest: string; cdxDigestVerified: boolean; proxyRegion: string };
type Index = { base: string; queryUrl: string; status?: number; rows?: string[][]; error?: string };
const read = async <T,>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, "utf8"));
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const normalize = (text: string) => text.normalize("NFKC").replace(/\s/g, "");
const sourcePath = (url: string) => {
  const pathname = new URL(url).pathname;
  const local = pathname.startsWith("/vipkouhaku/") ? pathname.slice("/vipkouhaku/".length) || "index.html" : `accounts/${pathname.slice(1)}`;
  return local.endsWith("/") ? `${local}index.html` : local;
};

async function archive() {
  const dispatcher = new ProxyAgent("http://127.0.0.1:7897");
  try {
    const exit = await (await fetch("http://ip-api.com/json/?fields=countryCode", { dispatcher, signal: AbortSignal.timeout(15000) })).json() as { countryCode?: string };
    if (exit.countryCode !== "HK") throw new Error("Hong Kong exit required");
    const indexes = await read<Index[]>(`${root}/investigation/linked-original-accounts-cdx.json`);
    const rows = [...(await read<string[][]>(`${root}/investigation/original-scoped-cdx.json`)).slice(1), ...indexes.flatMap((index) => index.rows?.slice(1) ?? [])].filter((row) => !/zip|octet-stream/.test(row[3]));
    const directory = `${root}/source/original-archive`, manifestFile = `${directory}/manifest.json`;
    const manifest = await read<Record<string, Capture>>(manifestFile);
    const reportFile = `${root}/investigation/distributed-archive-retrieval.json`;
    const results = (await read<{ results: Array<Record<string, unknown>> }>(reportFile).catch(() => ({ results: [] }))).results;
    let completed = 0;
    for (const [originalUrl, timestamp, , , expectedDigest] of rows) {
      const prior = manifest[originalUrl];
      if (prior?.cdxDigestVerified && sha256(await fs.readFile(`${directory}/${prior.file}`)) === prior.sha256) { completed++; continue; }
      const requestedUrl = `https://web.archive.org/web/${timestamp}id_/${originalUrl}`;
      try {
        const response = await fetch(requestedUrl, { dispatcher, signal: AbortSignal.timeout(45000) });
        if (response.status === 429) {
          await writeJson(reportFile, { stoppedByRateLimit: true, retryAfter: response.headers.get("retry-after"), results });
          await response.body?.cancel();
          return;
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        const bits = [...createHash("sha1").update(bytes).digest()].map((value) => value.toString(2).padStart(8, "0")).join("");
        const actualDigest = bits.match(/.{5}/g)!.map((part) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[parseInt(part, 2)]).join("");
        const file = `capture-${sha256(Buffer.from(originalUrl)).slice(0, 20)}-${sha256(bytes).slice(0, 8)}.bin`;
        await fs.writeFile(`${directory}/${file}`, bytes);
        const capture = { originalUrl, requestedUrl, actualUrl: response.url, timestamp, file, bytes: bytes.length, sha256: sha256(bytes), expectedDigest, actualDigest, status: response.status, mementoDatetime: response.headers.get("memento-datetime"), cdxDigestVerified: response.status === 200 && !!response.headers.get("memento-datetime") && actualDigest === expectedDigest, proxyRegion: "Hong Kong" };
        results.push(capture);
        if (capture.cdxDigestVerified) { manifest[originalUrl] = capture; completed++; }
      } catch (error) { results.push({ originalUrl, requestedUrl, error: String(error) }); }
      await writeJson(manifestFile, manifest);
      await writeJson(reportFile, { proxyRegion: "Hong Kong", completed, planned: rows.length, results });
      console.log(JSON.stringify({ completed, planned: rows.length }));
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    await writeJson(reportFile, { proxyRegion: "Hong Kong", completed, planned: rows.length, results });
  } finally { await dispatcher.close(); }
}

async function prepare() {
  type Resource = Capture & { directory: string };
  const resources: Resource[] = [];
  for (const directory of ["archive", "original-archive"]) {
    const manifest = await read<Record<string, Capture>>(`${root}/source/${directory}/manifest.json`);
    for (const capture of Object.values(manifest)) {
      if (!capture.cdxDigestVerified || sha256(await fs.readFile(`${root}/source/${directory}/${capture.file}`)) !== capture.sha256) throw new Error("Unverified source bytes");
      resources.push({ ...capture, directory });
    }
  }
  const auxiliaryReplays = await read<Array<{ originalUrl: string; requestedUrl: string; status?: number; mementoDatetime?: string; error?: string }>>(`${root}/investigation/auxiliary-nearest-replays.json`);
  if (auxiliaryReplays.length !== 5 || auxiliaryReplays.some((replay) => replay.status === 200 && replay.mementoDatetime)) throw new Error("Auxiliary replay evidence needs reconciliation");
  const unavailableSourcePages = auxiliaryReplays.filter((replay) => /\.htm$/.test(replay.originalUrl)).map((replay) => ({ sourcePath: sourcePath(replay.originalUrl), sourceUrl: replay.originalUrl, evidence: `${root}/investigation/auxiliary-unfiltered-cdx.json`, replay }));
  const failures = auxiliaryReplays.map((replay) => ({ sourceUrl: replay.originalUrl, requestedUrl: replay.requestedUrl, error: replay.error ?? `No matching capture in the queried source-prefix indexes; the nearest replay returned HTTP ${replay.status}. This does not establish global absence.` }));
  const bytes = (resource: Resource) => fs.readFile(`${root}/source/${resource.directory}/${resource.file}`);
  const document = async (resource: Resource) => {
    const text = decodeSource(await bytes(resource), "shift_jis");
    if (text.includes("\uFFFD")) throw new Error(`Unresolved source encoding: ${resource.originalUrl}`);
    return cheerio.load(text);
  };
  const originals = resources.filter((resource) => resource.directory === "original-archive");
  const catalogue = originals.find((resource) => resource.originalUrl.endsWith("/vipkouhaku/index_game.htm"))!;
  const etaCatalogue = originals.find((resource) => resource.originalUrl.endsWith("/vipkouhaku/etapage.htm"))!;
  const links = await read<Array<{ no: number; url: string; catalogue: string; title: string }>>(`${root}/investigation/original-detail-links.json`);
  const indexRows = (await read<Index[]>(`${root}/investigation/linked-original-accounts-cdx.json`)).flatMap((index) => index.rows?.slice(1) ?? []);
  const packageSources: Array<{ no: string; originalUrl: string; timestamp: string; digest: string; bytesDownloaded: boolean }> = [];
  if (links.length !== 92 || new Set(links.map((entry) => entry.no)).size !== 92) throw new Error("Expected 92 explicitly linked source entries");
  const $catalogue = await document(catalogue), groups = new Map<number, string>();
  $catalogue("table").first().find("tr").slice(1).each((_, tr) => {
    $catalogue(tr).children("td").each((column, td) => {
      const no = $catalogue(td).text().normalize("NFKC").match(/\[No\.(\d+)\]/i)?.[1];
      if (no) groups.set(Number(no), column === 0 ? "紅組" : "白組");
    });
  });
  if (groups.size !== 90) throw new Error("Expected 90 numbered entries under the source's red/white columns");
  const originalResources: Record<string, string> = {};
  for (const resource of originals) originalResources[new URL(resource.originalUrl).href] = sourcePath(resource.originalUrl);
  for (const link of links) originalResources[new URL(link.url).href] = sourcePath(link.url);
  for (const resource of resources.filter((resource) => resource.directory === "archive")) {
    const pathname = new URL(resource.originalUrl).pathname;
    const filename = pathname.endsWith("/") ? "index.html" : path.posix.basename(pathname), number = filename.match(/^(?:sakuhin_|ss_)(\d+)/)?.[1];
    const link = number ? links.find((link) => link.no === Number(number)) : undefined;
    originalResources[resource.originalUrl] = link ? path.posix.join(path.posix.dirname(sourcePath(link.url)), filename) : filename || "index.html";
  }
  // The late original menu points these pages at the migrated mirror. Replay
  // their saved original-site counterparts rather than the unavailable mirror.
  for (const page of ["touhyou.htm", "tenpure.htm", "sanka.htm"]) {
    if (!originalResources[new URL(page, base).href]) throw new Error("Original auxiliary counterpart is not cached");
    originalResources[new URL(page, "https://vipkohaku.x.fc2.com/2006/").href] = page;
  }
  const works: WorkEntry[] = [], entries = [], sourceDetailGaps = [], imageGaps = [];
  const catalogueComparison = [];
  const oldRows = await read<Array<{ no: number; title: string }>>(`${root}/investigation/catalogue-rows.json`);
  const eta = await document(etaCatalogue), etaRows = new Map<number, { downloads: WorkDownload[]; title: string }>();
  eta("tr").slice(1).each((_, tr) => {
    const cells = eta(tr).children("td"), no = Number(cells.eq(0).text().normalize("NFKC").trim());
    if (!Number.isInteger(no) || !links.some((link) => link.no === no)) return;
    const downloads: WorkDownload[] = [];
    for (const column of [2, 3]) cells.eq(column).find("a[href]").each((_, a) => { downloads.push({ url: new URL(eta(a).attr("href")!, etaCatalogue.originalUrl).href, label: column === 2 ? "Source ZIP" : "patch" }); });
    etaRows.set(no, { downloads, title: cells.eq(1).text().trim() });
  });
  const easyCapture = originals.find((resource) => resource.originalUrl.endsWith("/index_easy.htm"))!;
  const easy = await document(easyCapture), easyDownloads = new Map<number, WorkDownload[]>();
  easy("tr").slice(1).each((_, tr) => {
    const cells = easy(tr).children("td"), no = Number(cells.eq(0).text().normalize("NFKC").trim());
    if (!Number.isInteger(no) || !links.some((link) => link.no === no)) return;
    const downloads: WorkDownload[] = [];
    for (const column of [2, 3]) cells.eq(column).find("a[href]").each((_, a) => { downloads.push({ url: new URL(easy(a).attr("href")!, easyCapture.originalUrl).href, label: column === 2 ? "Source ZIP" : "patch" }); });
    easyDownloads.set(no, downloads);
  });
  for (const link of links.sort((a, b) => a.no - b.no)) {
    const no = String(link.no).padStart(2, "0"), local = sourcePath(link.url);
    const capture = originals.find((resource) => new URL(resource.originalUrl).href === new URL(link.url).href) ?? resources.find((resource) => resource.directory === "archive" && new URL(resource.originalUrl).pathname.endsWith(`/sakuhin_${no}.htm`));
    const work: WorkEntry = { id: `${id}-work-${no}`, festivalId: id, no, title: link.title, author: "", ...(groups.has(link.no) ? { group: groups.get(link.no) } : {}), source: { url: link.url, titleUrl: link.catalogue === "etapage.htm" ? etaCatalogue.requestedUrl : catalogue.requestedUrl, ...(capture ? { snapshotUrl: capture.requestedUrl } : {}) } };
    const mirrorRow = oldRows.find((row) => Number(row.no) === link.no);
    catalogueComparison.push({ no, originalCatalogue: link.catalogue, mirrorCataloguePresent: !!mirrorRow, titleMatches: mirrorRow ? normalize(mirrorRow.title) === normalize(link.title) : null });
    const downloads = [...(easyDownloads.get(link.no) ?? []), ...(etaRows.get(link.no)?.downloads ?? [])];
    if (!capture) {
      work.sourceDetailUnavailable = true;
      sourceDetailGaps.push({ no, sourcePath: local, sourceUrl: link.url, evidence: `${root}/investigation/linked-original-accounts-cdx.json` });
    } else {
      const $ = await document(capture), screenshots = [], screenshotSources = [];
      if (!normalize($("td").first().text()).includes(normalize(link.title))) work.originalTitle = $("td").first().text().trim();
      for (const img of $("img[src]").toArray()) {
        const url = new URL($(img).attr("src")!, capture.originalUrl);
        if (!/^ss_\d+\./i.test(path.posix.basename(url.pathname))) continue;
        const resource = resources.find((resource) => resource.directory === capture.directory && new URL(resource.originalUrl).href === url.href) ?? resources.find((resource) => new URL(resource.originalUrl).pathname.endsWith(`/${path.posix.basename(url.pathname)}`));
        if (!resource) { imageGaps.push({ no, originalUrl: url.href }); continue; }
        const image = await bytes(resource), extension = imageExtension(image), dimensions = await sharp(image).metadata(), imageLocal = `/screenshots/${id}/${no}-${screenshots.length + 1}.${extension}`;
        await fs.mkdir(path.dirname(`public${imageLocal}`), { recursive: true });
        await fs.writeFile(`public${imageLocal}`, image);
        screenshots.push(imageLocal);
        screenshotSources.push({ local: imageLocal, width: dimensions.width, height: dimensions.height, ...resource });
        originalResources[url.href] = originalResources[resource.originalUrl];
      }
      if (screenshots.length) work.ss = screenshots;
      $("a[href]").each((_, a) => {
        const url = new URL($(a).attr("href")!, capture.originalUrl);
        if (/\.zip$/i.test(url.pathname) || /drive\.google\.com|box\.yahoo\.co\.jp/.test(url.hostname)) downloads.push({ url: url.href, label: /sabun|patch/i.test(url.pathname) ? "patch" : "Source download" });
      });
      $("script,noscript,style,iframe,form,object,embed,img,link,meta").remove();
      $("*").each((_, element) => { for (const attr of Object.keys(element.attribs)) if (attr.startsWith("on") || ["background", "bgcolor", "color", "face", "size", "align", "nowrap", "style", "width", "height"].includes(attr)) $(element).removeAttr(attr); });
      $("a[href]").each((_, a) => { $(a).attr("href", new URL($(a).attr("href")!, capture.originalUrl).href); });
      work.sourceContent = $("body").html()?.trim();
      entries.push({ no, sourcePath: local, capture, screenshotSources });
    }
    const mirror = resources.find((resource) => resource.directory === "archive" && new URL(resource.originalUrl).pathname.endsWith(`/sakuhin_${no}.htm`));
    if (mirror && mirror !== capture) {
      const $mirror = await document(mirror);
      $mirror("a[href]").each((_, a) => {
        const url = new URL($mirror(a).attr("href")!, mirror.originalUrl);
        if (/\.zip$/i.test(url.pathname) || /drive\.google\.com|box\.yahoo\.co\.jp/.test(url.hostname)) downloads.push({ url: url.href, label: /sabun|patch/i.test(url.pathname) ? "patch" : "Mirror download" });
      });
    }
    const archivedDownloads: WorkDownload[] = [];
    for (const download of downloads) {
      if (!/\.zip$/i.test(new URL(download.url).pathname)) continue;
      const index = indexRows.find((row) => new URL(row[0]).href === new URL(download.url).href);
      if (!index) continue;
      archivedDownloads.push({ url: `https://web.archive.org/web/${index[1]}id_/${index[0]}`, label: download.label === "patch" ? "patch (Wayback)" : "Wayback ZIP" });
      packageSources.push({ no, originalUrl: index[0], timestamp: index[1], digest: index[4], bytesDownloaded: false });
    }
    const unique = [...archivedDownloads, ...downloads].filter((download, index, all) => all.findIndex((other) => other.url === download.url) === index);
    if (unique.length) { work.downloads = unique; work.download = unique.find((download) => /drive\.google\.com/.test(new URL(download.url).hostname)) ?? unique.find((download) => !download.label?.startsWith("patch")); }
    works.push(work);
  }
  const banners = [];
  for (const filename of ["vipkohaku_second.png", "vipkohaku_second02.png"]) {
    const capture = originals.find((resource) => resource.originalUrl.endsWith(`/vipkouhaku/${filename}`))!;
    const image = await bytes(capture), extension = imageExtension(image), local = `/banners/${id}-${banners.length + 1}.${extension}`, dimensions = await sharp(image).metadata();
    await fs.writeFile(`public${local}`, image);
    banners.push({ local, width: dimensions.width, height: dimensions.height, capture });
  }
  const festivals = await read<Array<{ id: string; banners: string[]; columns: string[] }>>("src/data/festivals.json");
  const festival = festivals.find((festival) => festival.id === id)!;
  festival.banners = banners.map((banner) => banner.local);
  festival.columns = ["no", "work", "group", "download"];
  await writeJson("src/data/festivals.json", festivals);
  await writeJson(`src/data/works/${id}.json`, works);
  await writeJson(`${root}/investigation/catalogue-comparison.json`, catalogueComparison);
  await writeJson(`${root}/investigation/original-timemap.bin`, [["original", "first", "last"], ...resources.map((resource) => [resource.originalUrl, resource.timestamp, resource.timestamp])]);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, catalogueEntries: works.length, catalogueCapture: catalogue, etaCatalogueCapture: etaCatalogue, easyCatalogueCapture: easyCapture, entries, sourceDetailGaps, imageGaps, unavailableSourcePages, failures, originalResources, banners, packageSources, sourceEvidence: [`${root}/investigation/original-live-probes.json`, `${root}/investigation/original-scoped-cdx.json`, `${root}/investigation/linked-original-accounts-cdx.json`, `${root}/investigation/distributed-archive-retrieval.json`, `${root}/investigation/final-original-resource-verification.json`, `${root}/investigation/catalogue-comparison.json`, `${root}/investigation/legacy-parser-diagnosis.json`, `${root}/investigation/auxiliary-unfiltered-cdx.json`, `${root}/investigation/auxiliary-nearest-replays.json`], legacyCatalogueCorrection: { before: 23, after: 92, linkedMainEntries: 67, unlinkedMainEntries: 23, etaEntries: 25, etaAdditionalNumbers: [91, 92] }, handling: "Save original bytes and source content without content screening. Combine the main and auxiliary catalogues by explicit source numbers and links. Red/white are groups. Preserve historical and newer mirror package links, with archive references only where an exact CDX record exists; package bytes have not been downloaded or validated.", desktopReview: "pending" });
  console.log(JSON.stringify({ works: works.length, details: entries.length, detailGaps: sourceDetailGaps.length, screenshots: entries.reduce((sum, entry) => sum + entry.screenshotSources.length, 0), imageGaps: imageGaps.length }));
}

(process.argv.includes("--archive-only") ? archive() : prepare()).catch((error) => { console.error(error); process.exitCode = 1; });
