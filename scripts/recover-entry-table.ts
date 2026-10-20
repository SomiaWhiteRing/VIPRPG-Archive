import fs from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { Festival, WorkEntry } from "../src/lib/types";

const fetchEnabled = process.argv.includes("--fetch");
export function decodeSource(bytes: Buffer, fallback: string) {
  const hasUtf8Bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  const declared = bytes.subarray(0, 4096).toString("latin1").match(/charset\s*=\s*["']?\s*([\w-]+)/i)?.[1];
  const declaredIsValid = declared && iconv.encodingExists(declared) && (!/^utf-?8$/i.test(declared) || isUtf8(bytes));
  return iconv.decode(bytes, hasUtf8Bom ? "utf-8" : declaredIsValid ? declared : fallback);
}
type Capture = { requestedUrl: string; actualUrl: string; contentType: string; retrievedAt: string };

export async function writeJson(file: string, value: unknown) {
  const text = JSON.stringify(value, null, 2) + "\n";
  if (await fs.readFile(file, "utf8").catch(() => undefined) === text) return;
  const temporary = `${file}.next`;
  await fs.writeFile(temporary, text);
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(temporary, file); return; }
    catch (error) {
      if (attempt === 2 || !["EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export function imageExtension(bytes: Buffer) {
  const hex = bytes.subarray(0, 8).toString("hex");
  if (hex === "89504e470d0a1a0a") return "png";
  if (hex.startsWith("ffd8ff")) return "jpg";
  if (bytes.subarray(0, 3).toString() === "GIF") return "gif";
  if (bytes.subarray(0, 2).toString() === "BM") return "bmp";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "webp";
  if (bytes.subarray(4, 12).toString() === "ftypavif") return "avif";
  if (hex.startsWith("00000100")) return "ico";
  throw new Error("Response is not a recognized image");
}

export interface EntryTableConfig {
  id: string;
  originalBase: string;
  indexName: string;
  expectedEntries: number;
  bannerSelector: string;
  liveChecks: string[];
  encoding?: string;
  categoryColumn?: number;
}

export async function recoverEntryTable(config: EntryTableConfig) {
  const root = `catch/${config.id}`;
  const cacheDir = `${root}/source/recovery`;
  const reportPath = `${root}/recovery.json`;
  await fs.mkdir(cacheDir, { recursive: true });
  const originalBase = config.originalBase;
  // Direct original and linked migration roots were checked first; their failures are preserved here.
  const indexMeta = JSON.parse(await fs.readFile(`${root}/investigation/${config.indexName}.json`, "utf8"));
  const encoding = config.encoding ?? "shift_jis";
  const index = cheerio.load(iconv.decode(await fs.readFile(`${root}/investigation/${config.indexName}.bin`), encoding));
  const inventory: string[][] = JSON.parse(await fs.readFile(`${root}/investigation/original-timemap.bin`, "utf8"));
  const worksPath = `src/data/works/${config.id}.json`;
  const works: WorkEntry[] = JSON.parse(await fs.readFile(worksPath, "utf8"));
  const manifestPath = `${cacheDir}/manifest.json`;
  const manifest: Record<string, Capture> = JSON.parse(await fs.readFile(manifestPath, "utf8").catch(() => "{}"));
  const previous: { failures?: Array<{ requestedUrl: string; error: string }>; unavailablePreloads?: Array<{ requestedUrl: string; error: string }>; corrections?: Array<{ no: string; before: string; after: string; sourceUrl: string }> } = JSON.parse(await fs.readFile(reportPath, "utf8").catch(() => "{}"));
  const failures: Array<{ owner: string; requestedUrl: string; error: string }> = [];
  const unavailablePreloads: Array<{ owner: string; requestedUrl: string; error: string }> = [];
  const entries = [];
  const corrections = [...(previous.corrections ?? [])].filter((correction) => !works.some((work) => work.no === correction.no && work.source?.titleUrl));

  function archived(original: string) {
    const normalized = new URL(original).href;
    const row = inventory.slice(1).find((row) => new URL(row[0]).href === normalized);
    const timestamp = row ? row[2] || row[1] : indexMeta.actualUrl.match(/\/web\/(\d+)/)[1];
    return `https://web.archive.org/web/${timestamp}id_/${row?.[0] ?? original}`;
  }
  async function capture(url: string, filename: string) {
    const file = `${cacheDir}/${filename}`;
    if (manifest[filename]?.requestedUrl === url) return { bytes: await fs.readFile(file), ...manifest[filename] };
    if (!fetchEnabled) {
      const known = [...(previous.failures ?? []), ...(previous.unavailablePreloads ?? [])].find((failure) => failure.requestedUrl === url);
      throw new Error(known?.error.replace(/^Error:\s*/, "") ?? `Cache missing; use --fetch: ${filename}`);
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(40000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(file, bytes);
    manifest[filename] = { requestedUrl: url, actualUrl: response.url, contentType: response.headers.get("content-type") ?? "", retrievedAt: new Date().toISOString() };
    await writeJson(manifestPath, manifest);
    return { bytes, ...manifest[filename] };
  }
  async function image(original: string, owner: string, filename: string, target: string, optionalPreload = false) {
    const requestedUrl = archived(original);
    const knownUnused = optionalPreload && previous.unavailablePreloads?.find((entry) => entry.requestedUrl === requestedUrl);
    if (knownUnused && !manifest[filename]) {
      unavailablePreloads.push({ owner, requestedUrl, error: knownUnused.error });
      return undefined;
    }
    try {
      const result = await capture(requestedUrl, filename);
      const output = `${target}.${imageExtension(result.bytes)}`;
      await fs.mkdir(path.dirname(`public${output}`), { recursive: true });
      const saved = await fs.readFile(`public${output}`).catch(() => undefined);
      if (!saved?.equals(result.bytes)) await fs.writeFile(`public${output}`, result.bytes);
      return output;
    } catch (error) {
      (optionalPreload ? unavailablePreloads : failures).push({ owner, requestedUrl, error: String(error) });
      return undefined;
    }
  }
  function plainText(html: string, base: string) {
    const $ = cheerio.load(html);
    $("script,style,form").remove();
    $("br").replaceWith("\n");
    $("p,div,li").append("\n");
    $("a[href]").each((_, element) => {
      const anchor = $(element);
      const href = new URL(anchor.attr("href")!, base).href;
      anchor.append(` (${href})`);
    });
    return $.root().text().replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  const hrefs = [...new Set(index("a[href]").toArray().map((anchor) => index(anchor).attr("href")!).filter((href) => /^entry\d+\.html$/.test(href)))];
  if (hrefs.length !== config.expectedEntries) throw new Error(`Unexpected original index size: ${hrefs.length}`);

  if (process.argv.includes("--pages-only")) {
    const candidates = [];
    for (const href of hrefs) {
      const no = href.match(/entry(\d+)\.html$/)![1];
      const result = await capture(archived(new URL(href, originalBase).href), `${no}-detail.bin`);
      const text = cheerio.load(iconv.decode(result.bytes, encoding)).root().text();
      const terms = ["幼女", "児童", "小学生", "ロリ", "ショタ", "エロ", "陵辱", "脱衣", "R-18", "18禁"].filter((term) => text.includes(term));
      if (terms.length) candidates.push({ no, terms });
      if (Number(no) % 20 === 0) console.log(`${no}: source page cached`);
    }
    await writeJson(`${root}/page-audit.json`, { entries: hrefs.length, encoding, contentReviewCandidates: candidates });
    return;
  }

  for (const href of hrefs) {
    const no = href.match(/entry(\d+)\.html$/)![1];
    const existing = works.find((work) => work.no === no);
    const originalUrl = new URL(href, originalBase).href;
    try {
      const result = await capture(archived(originalUrl), `${no}-detail.bin`);
      const $ = cheerio.load(iconv.decode(result.bytes, encoding));
      const table = $("table").first();
      const heading = table.find("tr").first().find("td").last().text().trim();
      const identity = heading.match(/^No[.．]\s*(\d+)[\s　]+([\s\S]+)$/i);
      if (!identity || Number(identity[1]) !== Number(no)) throw new Error(`Unexpected detail identity: ${heading}`);
      const pageTitle = identity[2].trim();
      const title = existing?.source?.titleUrl ? existing.title : pageTitle;
      const work: WorkEntry = { ...(existing ?? { id: `${config.id}-work-${no}`, festivalId: config.id, no, author: "" }), title };
      if (existing?.source?.titleUrl && pageTitle !== title) work.originalTitle = pageTitle;
      if (existing && existing.title.replace(/\s/g, "") !== title.replace(/\s/g, "")) {
        corrections.push({ no, before: existing.title, after: title, sourceUrl: result.actualUrl });
      }
      const row = index(`a[href="${href}"]`).first().closest("tr").children("td");
      work.streaming = plainText(index(row[5]).html() ?? "", originalBase);
      if (config.categoryColumn !== undefined) work.category = plainText(index(row[config.categoryColumn]).html() ?? "", originalBase).split("\n")[0].trim();
      for (const cell of table.find("td").toArray()) {
        const text = plainText($(cell).html() ?? "", originalUrl);
        if (text.startsWith("作者：")) work.author = text.slice("作者：".length).trim();
        if (text.startsWith("ジャンル：")) work.category = text.slice("ジャンル：".length).trim();
        if (text.startsWith("配信/投稿：")) work.streaming = text.slice("配信/投稿：".length).trim();
        if (text.startsWith("ツクール：")) work.engine = text.slice("ツクール：".length).trim();
        const commentField = text.startsWith("作者コメント：") ? "authorComment" : text.startsWith("管理人コメント：") ? "hostComment" : undefined;
        if (commentField) {
          const label = commentField === "authorComment" ? "作者コメント：" : "管理人コメント：";
          const content = text.slice(label.length).trim();
          const embedded = [];
          for (const [i, img] of $(cell).find("img[src]").toArray().entries()) {
            const src = new URL($(img).attr("src")!, originalUrl).href;
            const asset = await image(src, work.id, `${no}-${commentField}-${i + 1}.bin`, `/screenshots/${config.id}/${no}-${commentField}-${i + 1}`);
            if (asset) embedded.push(`<img src="${asset}" alt="">`);
          }
          work[commentField] = embedded.length
            ? content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>") + embedded.join("<br>")
            : content;
        }
      }
      const download = table.find("a[href]").toArray().find((a) => $(a).attr("href")?.trim() && $(a).text().includes("ダウンロード"));
      const forum = table.find("a[href]").toArray().find((a) => $(a).attr("href")?.trim() && $(a).text().includes("感想掲示板"));
      if (download) work.download = { url: new URL($(download).attr("href")!, originalUrl).href, label: $(download).text().trim() };
      else delete work.download;
      if (forum) work.forum = new URL($(forum).attr("href")!, originalUrl).href;
      else delete work.forum;
      work.source = { ...work.source, url: originalUrl, snapshotUrl: result.actualUrl.replace(/id_\//, "/") };

      const detailIconSrc = table.find("tr").first().find("img").first().attr("src");
      const iconSrc = detailIconSrc || index(row[1]).find("img").first().attr("src");
      if (iconSrc) {
        const asset = await image(new URL(iconSrc, originalUrl).href, work.id, `${no}-icon.bin`, `/icons/${config.id}/${no}`);
        if (asset) work.icon = asset;
      }
      const screenshotRefs = table.find("tr").eq(1).find("img[src]").toArray().map((img) => $(img).attr("src")!);
      // Preserve alternate screenshots declared by the original hover handlers; never execute archived JS.
      for (const img of table.find("img").toArray()) {
        for (const attribute of ["onmouseover", "onmouseout"]) {
          for (const match of $(img).attr(attribute)?.matchAll(/this\.src\s*=\s*["']([^"']+)["']/g) ?? []) screenshotRefs.push(match[1]);
        }
      }
      const displayed = new Set(screenshotRefs.map((src) => new URL(src, originalUrl).href));
      for (const script of $("script").toArray()) {
        const array = $(script).text().match(/\bimg\s*=\s*new Array\s*\(([\s\S]*?)\)/);
        for (const match of array?.[1].matchAll(/["']([^"']+)["']/g) ?? []) screenshotRefs.push(match[1]);
      }
      const originals = [...new Set(screenshotRefs.map((src) => new URL(src, originalUrl).href))];
      const screenshots = [];
      const recoveredPreloads = [];
      let displayedRecovered = 0;
      for (const [i, original] of originals.entries()) {
        const asset = await image(original, work.id, `${no}-ss${i + 1}.bin`, `/screenshots/${config.id}/${no}-${i + 1}`, !displayed.has(original));
        if (asset) {
          if (displayed.has(original)) {
            screenshots.push(asset);
            displayedRecovered++;
          } else recoveredPreloads.push({ sourceUrl: original, asset });
        }
      }
      if (screenshots.length) work.ss = screenshots;
      else delete work.ss;
      delete work.detailDisabled;
      if (existing) works[works.indexOf(existing)] = work;
      else works.push(work);
      entries.push({ id: work.id, no, status: "detail-recovered", source: work.source, iconRecovered: Boolean(work.icon), iconSource: detailIconSrc ? "detail" : "index", screenshotsLinked: displayed.size, screenshotsLinkedRecovered: displayedRecovered, screenshotsRecovered: screenshots.length, additionalPreloadsRecovered: recoveredPreloads.length, additionalPreloads: recoveredPreloads, downloadVerified: false });
    } catch (error) {
      failures.push({ owner: existing?.id ?? `${config.id}-work-${no}`, requestedUrl: archived(originalUrl), error: String(error) });
      entries.push({ id: existing?.id ?? `${config.id}-work-${no}`, no, status: "detail-pending" });
    }
    await writeJson(reportPath, { festivalId: config.id, originalBase, sourceEncoding: encoding, indexCapture: indexMeta.actualUrl, liveChecks: config.liveChecks.map((name) => `${root}/investigation/${name}.json`), entries, corrections, titleVariants: works.filter((work) => work.originalTitle).map((work) => ({ no: work.no, title: work.title, originalTitle: work.originalTitle, titleUrl: work.source?.titleUrl })), failures, unavailablePreloads, note: "Original source checked first; live roots were unreachable. Preload-only images are retained separately from the displayed screenshot gallery, including successful cached files and unavailable URLs. Download links are historical source links, not availability checks." });
    console.log(`${no}: ${entries.at(-1)?.status}`);
  }
  works.sort((a, b) => Number(a.no) - Number(b.no));
  await writeJson(worksPath, works);
  const banners = [];
  for (const img of index(config.bannerSelector).toArray()) {
    const src = new URL(index(img).attr("src")!, originalBase).href;
    const asset = await image(src, config.id, `banner-${banners.length + 1}.bin`, `/banners/${config.id}-${banners.length + 1}`);
    if (asset) banners.push(asset);
  }
  if (banners.length) {
    const festivalsPath = "src/data/festivals.json";
    const festivals: Festival[] = JSON.parse(await fs.readFile(festivalsPath, "utf8"));
    festivals.find((festival) => festival.id === config.id)!.banners = banners;
    await writeJson(festivalsPath, festivals);
  }
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  report.failures = failures;
  report.banners = banners;
  await writeJson(reportPath, report);
  console.log(`Recovered ${entries.filter((entry) => entry.status === "detail-recovered").length}/${hrefs.length} details; ${failures.length} pending requests.`);
}
