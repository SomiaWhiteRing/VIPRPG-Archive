import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import { imageExtension, writeJson } from "./recover-entry-table";
import { readStaticStringArray } from "./source-static-array";
import type { Festival, WorkEntry } from "../src/lib/types";

const root = "catch/2015-summer";
const sourceBase = "http://viprpgsum15.webcrow.jp/";
const cacheDir = `${root}/source/recovery`;

async function main() {
  const sourceText = iconv.decode(await fs.readFile(`${root}/investigation/data.bin`), "shift_jis");
  const game = readStaticStringArray(sourceText, "game");
  if (game.length !== 77 * 14) throw new Error("Unexpected original data shape");
  const inventory: string[][] = JSON.parse(await fs.readFile(`${root}/investigation/original-timemap.bin`, "utf8"));
  const mirrorInventory: string[][] = JSON.parse(await fs.readFile(`${root}/investigation/mirror-timemap.bin`, "utf8"));
  const manifestPath = `${cacheDir}/manifest.json`;
  await fs.mkdir(cacheDir, { recursive: true });
  const manifest: Record<string, { requestedUrl: string; actualUrl: string; contentType: string; retrievedAt: string }> = JSON.parse(await fs.readFile(manifestPath, "utf8").catch(() => "{}"));
  const worksPath = "src/data/works/2015-summer.json";
  const existing: WorkEntry[] = JSON.parse(await fs.readFile(worksPath, "utf8"));
  const works: WorkEntry[] = [];
  const entries = [];
  const gaps: Array<{ owner: string; sourceUrl: string; reason: string }> = [];
  const dataMeta = JSON.parse(await fs.readFile(`${root}/investigation/data.json`, "utf8"));
  const recoveredImages: { entries?: Array<{ sourceUrl: string; status: string; cacheFile?: string }> } = JSON.parse(await fs.readFile(`${root}/image-recovery.json`, "utf8").catch(() => "{}"));
  async function image(original: string, owner: string, filename: string, target: string) {
    const recovered = recoveredImages.entries?.find((entry) => entry.sourceUrl === original && entry.status === "recovered");
    if (recovered?.cacheFile) {
      const bytes = await fs.readFile(recovered.cacheFile);
      const output = `${target}.${imageExtension(bytes)}`;
      await fs.mkdir(path.dirname(`public${output}`), { recursive: true });
      await fs.writeFile(`public${output}`, bytes);
      return output;
    }
    const row = inventory.slice(1).find((row) => new URL(row[0]).href === original);
    const mirror = mirrorInventory.slice(1).find((row) => new URL(row[0]).pathname.replace("/2015s/", "/") === new URL(original).pathname);
    const capture = row ?? mirror;
    if (!capture) {
      gaps.push({ owner, sourceUrl: original, reason: "No successful capture in the checked original/mirror inventories; direct original source is currently unreachable. Further source discovery remains required." });
      return undefined;
    }
    const requestedUrl = `https://web.archive.org/web/${capture[2] || capture[1]}id_/${capture[0]}`;
    try {
      let bytes: Buffer;
      if (manifest[filename]?.requestedUrl === requestedUrl) bytes = await fs.readFile(`${cacheDir}/${filename}`);
      else {
        if (!process.argv.includes("--fetch")) throw new Error("Capture not cached; run with --fetch");
        const response = await fetch(requestedUrl, { signal: AbortSignal.timeout(40000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.url}`);
        bytes = Buffer.from(await response.arrayBuffer());
        await fs.writeFile(`${cacheDir}/${filename}`, bytes);
        manifest[filename] = { requestedUrl, actualUrl: response.url, contentType: response.headers.get("content-type") ?? "", retrievedAt: new Date().toISOString() };
        await writeJson(manifestPath, manifest);
      }
      const output = `${target}.${imageExtension(bytes)}`;
      await fs.mkdir(path.dirname(`public${output}`), { recursive: true });
      await fs.writeFile(`public${output}`, bytes);
      return output;
    } catch (error) {
      gaps.push({ owner, sourceUrl: original, reason: String(error) });
      return undefined;
    }
  }
  function text(html: string) {
    const $ = cheerio.load(html);
    $("br").replaceWith("\n");
    return $.root().text().trim();
  }
  async function comment(html: string, owner: string, no: string, field: string) {
    const $ = cheerio.load(html, {}, false);
    $("script,style,iframe,object,embed,form,input,button").remove();
    for (const element of $("*").toArray()) {
      const node = $(element);
      for (const name of Object.keys(element.attribs)) if (!(["href", "src", "alt", "class"].includes(name))) node.removeAttr(name);
      if (node.is("a")) {
        const href = node.attr("href");
        if (href && /^https?:/i.test(new URL(href, sourceBase).href)) node.attr("href", new URL(href, sourceBase).href);
        else node.replaceWith(node.html() ?? "");
      }
    }
    for (const [i, img] of $("img[src]").toArray().entries()) {
      const original = new URL($(img).attr("src")!, sourceBase).href;
      const local = await image(original, owner, `${no}-${field}-${i + 1}.bin`, `/screenshots/2015-summer/${no}-${field}-${i + 1}`);
      if (local) $(img).attr("src", local);
      else $(img).remove();
    }
    return $.root().html() ?? "";
  }
  for (let i = 0; i < 77; i++) {
    const row = game.slice(i * 14, (i + 1) * 14);
    const no = String(i).padStart(2, "0");
    const old = existing.find((work) => Number(work.no) === i);
    const pageTitle = text(row[0]);
    const work: WorkEntry = { id: old?.id ?? `2015-summer-work-${no}`, festivalId: "2015-summer", no, title: old?.source?.titleUrl ? old.title : pageTitle, author: text(row[1]), category: text(row[2]), engine: text(row[3]) };
    // This entry explicitly describes sexualized childlike characters; only non-graphic catalogue metadata is retained.
    if (i === 4) {
      work.contentRestricted = true;
      works.push(work);
      entries.push({ id: work.id, no, status: "metadata-reviewed-content-restricted", reason: "Sexualized minor/childlike-character material and its links are not copied into the public archive." });
      continue;
    }
    work.streaming = text(row[5]);
    work.updates = text(row[13]);
    if (row[6]) work.forum = new URL(row[6], sourceBase).href;
    if (row[7]) work.download = { url: new URL(row[7], sourceBase).href, label: row[4] };
    work.authorComment = await comment(row[8], work.id, no, "author");
    work.hostComment = await comment(row[9], work.id, no, "host");
    work.source = { ...old?.source, url: `${sourceBase}sakuhin.html?${i}`, snapshotUrl: dataMeta.actualUrl.replace(/id_\//, "/") };
    const icon = await image(`${sourceBase}icon/${i}${row[10]}`, work.id, `${no}-icon.bin`, `/icons/2015-summer/${no}`);
    if (icon) work.icon = icon;
    const originals = [`${sourceBase}ss/${i}${row[11]}`, ...(row[12] === "no" ? [] : [`${sourceBase}ss/${i}_${row[12]}`])];
    const screenshots = [];
    for (const [j, original] of originals.entries()) {
      const local = await image(original, work.id, `${no}-ss${j + 1}.bin`, `/screenshots/2015-summer/${no}-${j + 1}`);
      if (local) screenshots.push(local);
    }
    if (screenshots.length) work.ss = screenshots;
    if (old?.source?.titleUrl && pageTitle !== work.title) work.originalTitle = pageTitle;
    works.push(work);
    entries.push({ id: work.id, no, status: "metadata-recovered", screenshotsExpected: originals.length, screenshotsRecovered: screenshots.length, dataSource: dataMeta.actualUrl });
    await writeJson(`${root}/recovery.json`, { festivalId: "2015-summer", entries, gaps, sourceProof: [`${root}/investigation/data.json`, `${root}/investigation/main_table.json`, `${root}/investigation/main_ss.json`], status: "in-progress-source-discovery" });
    console.log(`${no}: metadata recovered; ${screenshots.length}/${originals.length} screenshots`);
  }
  await writeJson(worksPath, works);
  console.log(`Recovered ${works.length} catalogue records; ${gaps.length} source gaps; desktop review and the documented content restriction remain separate.`);
  // Banner files are listed by the source inventory; they are not substitutes for missing screenshots.
  const banners = [];
  for (const row of inventory.slice(1).filter((row) => /\/banner2?\.png$/.test(row[0]))) {
    const local = await image(new URL(row[0]).href, "2015-summer", `banner-${banners.length + 1}.bin`, `/banners/2015-summer-${banners.length + 1}`);
    if (local) banners.push(local);
  }
  if (banners.length) {
    const festivals: Festival[] = JSON.parse(await fs.readFile("src/data/festivals.json", "utf8"));
    festivals.find((festival) => festival.id === "2015-summer")!.banners = banners;
    await writeJson("src/data/festivals.json", festivals);
  }
  const report = JSON.parse(await fs.readFile(`${root}/recovery.json`, "utf8"));
  await writeJson(`${root}/recovery.json`, { ...report, gaps, banners, titleVariants: works.filter((work) => work.originalTitle).map((work) => ({ no: work.no, title: work.title, originalTitle: work.originalTitle, titleUrl: work.source?.titleUrl })), status: gaps.length ? "in-progress-source-discovery" : "awaiting-desktop-review", contentRestrictions: entries.filter((entry) => entry.status === "metadata-reviewed-content-restricted") });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
