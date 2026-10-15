import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { Festival, WorkEntry } from "../src/lib/types";

const cacheDir = "catch/2014-gw/source";
const manifestPath = `${cacheDir}/manifest.json`;
const fetchEnabled = process.argv.includes("--fetch");
type Capture = { requestedUrl: string; actualUrl: string; contentType: string };

function originalUrl(url: string, base: string) {
  const absolute = new URL(url, base).href;
  return absolute.replace(/^https?:\/\/web\.archive\.org\/web\/\d+[a-z_]*\/(https?:\/\/)/, "$1");
}

function archiveUrl(url: string, capture: string) {
  const timestamp = capture.match(/\/web\/(\d+)/)?.[1];
  if (!timestamp) throw new Error(`Missing capture timestamp: ${capture}`);
  return `https://web.archive.org/web/${timestamp}id_/${url}`;
}

function imageExtension(bytes: Buffer) {
  const hex = bytes.subarray(0, 8).toString("hex");
  if (hex === "89504e470d0a1a0a") return "png";
  if (hex.startsWith("ffd8ff")) return "jpg";
  if (bytes.subarray(0, 3).toString() === "GIF") return "gif";
  if (bytes.subarray(0, 2).toString() === "BM") return "bmp";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "webp";
  if (hex.startsWith("00000100")) return "ico";
  throw new Error("Response is not a recognized image");
}

async function main() {
  await fs.mkdir(cacheDir, { recursive: true });
  const manifest: Record<string, Capture> = JSON.parse(await fs.readFile(manifestPath, "utf8").catch(() => "{}"));
  const previous: { failures?: Array<{ url: string; error: string }> } = JSON.parse(await fs.readFile("catch/2014-gw/recovery.json", "utf8").catch(() => "{}"));
  const failures: Array<{ owner: string; url: string; error: string }> = [];
  const screenshotRecovery: { entries?: Array<{ originalRequestUrl: string; status: string; localPath?: string }> } = JSON.parse(await fs.readFile("catch/2014-gw/screenshot-recovery.json", "utf8").catch(() => "{}"));
  async function capture(url: string, filename: string) {
    const file = `${cacheDir}/${filename}`;
    if (manifest[filename]?.requestedUrl === url) {
      return { bytes: await fs.readFile(file), ...manifest[filename] };
    }
    if (!fetchEnabled) {
      const knownFailure = previous.failures?.find((failure) => failure.url === url);
      throw new Error(knownFailure?.error.replace(/^Error:\s*/, "") ?? `Cache missing; use --fetch: ${filename}`);
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(40000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(file, bytes);
    manifest[filename] = { requestedUrl: url, actualUrl: response.url, contentType: response.headers.get("content-type") ?? "" };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    return { bytes, ...manifest[filename] };
  }
  async function image(url: string, owner: string, target: string) {
    try {
      const recovered = screenshotRecovery.entries?.find((entry) => entry.originalRequestUrl === url && entry.status === "recovered");
      if (recovered?.localPath) {
        await fs.access(`public${recovered.localPath}`);
        return recovered.localPath;
      }
      const filename = `image-${path.basename(target)}.bin`;
      const result = await capture(url, filename);
      const ext = imageExtension(result.bytes);
      const output = `${target}.${ext}`;
      await fs.mkdir(path.dirname(`public${output}`), { recursive: true });
      await fs.writeFile(`public${output}`, result.bytes);
      return output;
    } catch (error) {
      failures.push({ owner, url, error: String(error) });
      console.log(`Image pending for ${owner}: ${String(error)}`);
      return undefined;
    }
  }

  // Original host is linked by the preserved 2018 GW page; not the dead mirror in festival-urls.json.
  const indexOriginal = "http://viprpg2014gw.web.fc2.com/";
  const index = await capture("https://web.archive.org/web/20190520193752id_/http://viprpg2014gw.web.fc2.com/", "index-raw.bin");
  const $ = cheerio.load(iconv.decode(index.bytes, "shift_jis"));
  if (!$("title").text().includes("GW祭2014")) throw new Error("Unexpected index page");
  const worksPath = "src/data/works/2014-gw.json";
  const works: WorkEntry[] = JSON.parse(await fs.readFile(worksPath, "utf8"));
  const anchors = $('a[href]').toArray().filter((el) => /^entry\/\d+\.html$/.test($(el).attr("href") ?? ""));
  if (anchors.length !== works.length) throw new Error("Index entry count changed; review before importing");
  const entries = [];
  const plainText = (html: string, base = indexOriginal) => {
    const fragment = cheerio.load(html);
    fragment("br").replaceWith("\n");
    fragment("script,style,form").remove();
    fragment("a[href]").each((_, element) => {
      const anchor = fragment(element);
      anchor.append(` (${originalUrl(anchor.attr("href")!, base)})`);
    });
    fragment("p,div,li").append("\n");
    return fragment.root().text().replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  };

  for (const anchor of anchors) {
    const href = $(anchor).attr("href")!;
    const no = href.match(/(\d+)\.html$/)![1];
    const work = works.find((entry) => entry.no === no);
    if (!work) throw new Error(`Unknown entry: ${no}`);
    const url = originalUrl(href, indexOriginal);
    try {
      const result = await capture(archiveUrl(url, index.actualUrl), `${no}.bin`);
      const detail = cheerio.load(iconv.decode(result.bytes, "shift_jis"));
      const table = detail("table").first();
      const title = table.find("tr").first().find("b").last().text().trim();
      if (title.replace(/\s/g, "") !== work.title.replace(/\s/g, "")) {
        throw new Error(`Title mismatch: ${title}`);
      }
      const cells = $(anchor).closest("tr").children("td");
      work.category = plainText($(cells[0]).html() ?? "").split("\n").slice(1).join("\n").trim();
      work.streaming = $(cells[6]).text().trim();
      for (const cell of table.find("td").toArray()) {
        const text = plainText(detail(cell).html() ?? "", url);
        if (text.startsWith("作者：")) work.author = text.slice("作者：".length).trim();
        if (text.startsWith("作成ツクール：")) work.engine = text.slice("作成ツクール：".length).trim();
        if (text.startsWith("作者コメント")) work.authorComment = text.slice("作者コメント".length).trim();
        if (text.startsWith("管理人コメント")) work.hostComment = text.slice("管理人コメント".length).trim();
      }
      const download = table.find("a").toArray().find((el) => detail(el).text().includes("ダウンロード"));
      const forum = table.find("a").toArray().find((el) => detail(el).text().includes("感想掲示板"));
      if (download) work.download = { url: originalUrl(detail(download).attr("href")!, url), label: detail(download).text().trim() };
      if (forum) work.forum = originalUrl(detail(forum).attr("href")!, url);
      work.source = { url, snapshotUrl: result.actualUrl.replace(/id_\//, "/") };
      const screenshots = [];
      for (const img of table.find("img").toArray()) {
        const src = detail(img).attr("src");
        if (!src) continue;
        const original = originalUrl(src, url);
        if (!/\/(?:ic|ss)\d+[^/]*\./i.test(original)) continue;
        const isIcon = /\/ic\d/i.test(original);
        const target = isIcon ? `/icons/2014-gw/${no}` : `/screenshots/2014-gw/${no}-${screenshots.length + 1}`;
        const asset = await image(archiveUrl(original, result.actualUrl), work.id, target);
        if (asset) {
          if (isIcon) work.icon = asset;
          else screenshots.push(asset);
        }
      }
      if (screenshots.length) work.ss = screenshots;
      delete work.detailDisabled;
      entries.push({ id: work.id, status: "detail-recovered", source: work.source, downloadVerified: false });
    } catch (error) {
      failures.push({ owner: work.id, url, error: String(error) });
      console.log(`Detail pending for ${no}: ${String(error)}`);
      entries.push({ id: work.id, status: "detail-pending" });
    }
    // Each original response is already cached; publish data once after this bounded batch.
    console.log(`${no}: ${entries.at(-1)?.status}`);
  }
  await fs.writeFile(worksPath, JSON.stringify(works, null, 2) + "\n");
  const banners = [];
  for (const img of $('img[src*="picture/bn"]').toArray()) {
    const original = originalUrl($(img).attr("src")!, indexOriginal);
    const asset = await image(archiveUrl(original, index.actualUrl), "2014-gw", `/banners/2014-gw-${banners.length + 1}`);
    if (asset) banners.push(asset);
  }
  const festivalsPath = "src/data/festivals.json";
  const festivals: Festival[] = JSON.parse(await fs.readFile(festivalsPath, "utf8"));
  festivals.find((festival) => festival.id === "2014-gw")!.banners = banners;
  await fs.writeFile(festivalsPath, JSON.stringify(festivals, null, 2) + "\n");
  await fs.writeFile("catch/2014-gw/recovery.json", JSON.stringify({
    festivalId: "2014-gw", indexOriginal, indexCapture: index.actualUrl,
    notes: "Recovered only from observed index/detail links; historical download URLs are not availability checks. Image failures remain pending.",
    entries, failures,
  }, null, 2) + "\n");
  console.log(`Recovered ${entries.filter((entry) => entry.status === "detail-recovered").length}/${works.length} details; ${failures.length} pending requests.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
