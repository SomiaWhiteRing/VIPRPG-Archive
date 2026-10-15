import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import { imageExtension, writeJson } from "./recover-entry-table";
import type { Festival, WorkEntry } from "../src/lib/types";

const id = "2014-kouhaku", root = `catch/${id}`, cache = `${root}/source/recovery`;
const base = "http://www.geocities.jp/vipkohaku2014/";
type Capture = { requestedUrl: string; actualUrl: string; contentType: string; retrievedAt?: string };

async function main() {
  await fs.mkdir(cache, { recursive: true });
  const manifestPath = `${cache}/manifest.json`;
  const manifest: Record<string, Capture> = JSON.parse(await fs.readFile(manifestPath, "utf8").catch(() => "{}"));
  const inventory: string[][] = JSON.parse(await fs.readFile(`${root}/investigation/original-timemap.bin`, "utf8"));
  const indexMeta = JSON.parse(await fs.readFile(`${root}/investigation/index.json`, "utf8"));
  const index = cheerio.load(iconv.decode(await fs.readFile(`${root}/investigation/index.bin`), "shift_jis"));
  const hrefs = [...new Set(index("a[href]").toArray().map((a) => index(a).attr("href")!).filter((href) => /^entry\/\d+\.html$/.test(href)))];
  if (hrefs.length !== 113) throw new Error(`Unexpected source entry count: ${hrefs.length}`);
  function archived(original: string) {
    const row = inventory.slice(1).find((row) => new URL(row[0]).href === original);
    const timestamp = row ? row[2] || row[1] : indexMeta.actualUrl.match(/\/web\/(\d+)/)[1];
    return `https://web.archive.org/web/${timestamp}id_/${row?.[0] ?? original}`;
  }
  async function capture(original: string, filename: string) {
    const requestedUrl = archived(original);
    if (manifest[filename]?.requestedUrl === requestedUrl) return fs.readFile(`${cache}/${filename}`);
    const no = filename.match(/^(\d+)-detail\.bin$/)?.[1];
    if (no && ["000", "001"].includes(no)) {
      const bytes = await fs.readFile(`${root}/investigation/detail${no}.bin`);
      const metadata = JSON.parse(await fs.readFile(`${root}/investigation/detail${no}.json`, "utf8"));
      manifest[filename] = { ...metadata, contentType: "text/html" };
      await fs.writeFile(`${cache}/${filename}`, bytes);
      return bytes;
    }
    if (!process.argv.includes("--fetch")) throw new Error(`Missing source cache: ${filename}`);
    const response = await fetch(requestedUrl, { signal: AbortSignal.timeout(40000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(`${cache}/${filename}`, bytes);
    manifest[filename] = { requestedUrl, actualUrl: response.url, contentType: response.headers.get("content-type") ?? "", retrievedAt: new Date().toISOString() };
    return bytes;
  }
  const failures: Array<{ owner: string; sourceUrl: string; error: string }> = [];
  for (let offset = 0; offset < hrefs.length; offset += 3) {
    await Promise.all(hrefs.slice(offset, offset + 3).map(async (href) => {
      const no = href.match(/(\d+)\.html$/)![1], original = new URL(href, base).href;
      try { await capture(original, `${no}-detail.bin`); }
      catch (error) { failures.push({ owner: no, sourceUrl: original, error: String(error) }); }
    }));
    await writeJson(manifestPath, manifest);
    if (offset % 30 === 0) console.log(`Source pages checked: ${Math.min(offset + 3, hrefs.length)}/${hrefs.length}`);
  }
  const candidates = [];
  for (const href of hrefs) {
    const no = href.match(/(\d+)\.html$/)![1];
    if (!manifest[`${no}-detail.bin`]) continue;
    const text = cheerio.load(iconv.decode(await fs.readFile(`${cache}/${no}-detail.bin`), "shift_jis")).root().text();
    const words = ["ロリ", "幼女", "児童", "小学生", "未成年", "エロ", "陵辱", "脱衣"].filter((word) => text.includes(word));
    if (words.length) candidates.push({ no, terms: words });
  }
  await writeJson(`${root}/page-audit.json`, { entries: hrefs.length, cached: hrefs.length - failures.length, failures, contentReviewCandidates: candidates });
  if (failures.length) throw new Error(`${failures.length} source pages are still missing`);
  if (process.argv.includes("--pages-only")) return;

  const worksPath = `src/data/works/${id}.json`;
  const existing: WorkEntry[] = JSON.parse(await fs.readFile(worksPath, "utf8"));
  const previous = JSON.parse(await fs.readFile(`${root}/recovery.json`, "utf8").catch(() => "{}"));
  const corrections: Array<{ no: string; before: string; after: string; sourceUrl: string }> = (previous.corrections ?? []).filter((correction: { no: string }) => !existing.some((work) => work.no === correction.no && work.source?.titleUrl));
  const works: WorkEntry[] = [], entries = [];
  const contentRestrictions = [];
  const assets = new Map<string, string>();
  function plain(html: string) {
    const $ = cheerio.load(html);
    $("script,style").remove();
    $("br").replaceWith("\n");
    return $.root().text().replace(/\r/g, "").trim();
  }
  async function image(original: string, owner: string, kind: "icons" | "screenshots" | "banners") {
    if (assets.has(original)) return assets.get(original);
    const resource = new URL(original).pathname.slice(new URL(base).pathname.length).replace(/[^\w.-]/g, "_");
    try {
      const bytes = await capture(original, `image-${resource}.bin`);
      const basename = resource.replace(/\.[^.]+$/, "");
      const target = `/${kind}/${id}/${basename}.${imageExtension(bytes)}`;
      await fs.mkdir(path.dirname(`public${target}`), { recursive: true });
      const saved = await fs.readFile(`public${target}`).catch(() => undefined);
      if (!saved?.equals(bytes)) await fs.writeFile(`public${target}`, bytes);
      assets.set(original, target);
      await writeJson(manifestPath, manifest);
      return target;
    } catch (error) {
      failures.push({ owner, sourceUrl: original, error: String(error) });
      return undefined;
    }
  }
  async function comment(html: string, owner: string) {
    const $ = cheerio.load(html, {}, false);
    $("script,style,iframe,object,embed,form,input,button").remove();
    $("a").each((_, element) => {
      const anchor = $(element), href = anchor.attr("href");
      if (anchor.text().includes("感想掲示板へ")) anchor.remove();
      else if (href && /^https?:/.test(new URL(href, base).href)) anchor.attr("href", new URL(href, base).href);
      else anchor.replaceWith(anchor.html() ?? "");
    });
    for (const element of $("*").toArray()) {
      const node = $(element);
      if (/MS PGothic|ＭＳ Ｐゴシック|monospace/i.test(node.attr("style") ?? "")) node.addClass("AA");
      for (const attr of Object.keys(element.attribs)) if (!["href", "src", "alt", "class", "width", "height"].includes(attr)) node.removeAttr(attr);
    }
    for (const img of $("img[src]").toArray()) {
      const node = $(img), original = new URL(node.attr("src")!, `${base}entry/`).href;
      const small = Number(node.attr("width")) > 0 && Number(node.attr("width")) < 100 && Number(node.attr("height")) < 100;
      const local = await image(original, owner, small ? "icons" : "screenshots");
      if (local) {
        node.attr("src", local);
        if (small) node.addClass("comment-face");
      } else node.remove();
    }
    const content = ($.root().html() ?? "").trim().replace(/^(?:\s*<br\s*\/?>)+/i, "").replace(/(?:<br\s*\/?>\s*)+$/i, "").trim();
    return `<div class="source-comment">${content}</div>`;
  }
  for (const href of hrefs) {
    const no = href.match(/(\d+)\.html$/)![1], filename = `${no}-detail.bin`, original = new URL(href, base).href;
    const $ = cheerio.load(iconv.decode(await fs.readFile(`${cache}/${filename}`), "shift_jis"));
    const table = $("table").first(), heading = table.find("tr").first().children("td").first().clone();
    heading.find("a").remove();
    const headingText = plain(heading.html() ?? "");
    const identity = headingText.match(/^No[.．]\s*(\d+)[\s　]+([^\n]+)/i);
    if (!identity || Number(identity[1]) !== Number(no)) throw new Error(`Unexpected source identity for ${no}`);
    const anchor = index(`a[href="${href}"]`).filter((_, a) => index(a).text().trim().length > 0).first();
    const row = anchor.closest("tr").children("td");
    const listedTitle = anchor.text().trim();
    const pageTitle = headingText.replace(/\s/g, "").includes(listedTitle.replace(/\s/g, "")) ? listedTitle : identity[2].trim();
    const cell = table.find("tr").eq(2).children("td").last();
    const html = cell.find("p").first().html() ?? cell.html() ?? "", text = plain(html);
    const author = text.match(/作者名[：:]\s*([\s\S]*?)\s*製作ツール[：:]/)?.[1].trim();
    const engine = text.match(/製作ツール[：:]\s*([\s\S]*?)\s*ジャンル[：:]/)?.[1].trim();
    const category = text.match(/ジャンル[：:]\s*([\s\S]*?)\s*作者コメント[：:]/)?.[1].trim();
    const authorStart = html.indexOf("作者コメント："), hostStart = html.indexOf("管理人からのコメント");
    if (author === undefined || engine === undefined || category === undefined || authorStart < 0 || hostStart < authorStart) throw new Error(`Unexpected metadata labels for ${no}`);
    const old = existing.find((work) => Number(work.no) === Number(no));
    const title = old?.source?.titleUrl ? old.title : pageTitle;
    const work: WorkEntry = { id: old?.id ?? `${id}-work-${no}`, festivalId: id, no, title, author, engine, category };
    if (old && old.title.replace(/\s/g, "") !== title.replace(/\s/g, "")) corrections.push({ no, before: old.title, after: title, sourceUrl: manifest[filename].actualUrl });
    if (no === "039") {
      work.contentRestricted = true;
      works.push(work);
      const resources = [];
      const icon = index(row[1]).find("img[src]").first().attr("src");
      if (icon) resources.push({ path: new URL(icon, base).pathname.slice(new URL(base).pathname.length), kind: "icon" });
      for (const img of table.find("tr").eq(1).find("img[src]").toArray()) {
        resources.push({ path: new URL($(img).attr("src")!, original).pathname.slice(new URL(base).pathname.length), kind: "screenshot" });
        for (const attr of ["onmouseover", "onmouseout"]) for (const match of ($(img).attr(attr) ?? "").matchAll(/this\.src\s*=\s*['"]([^'"]+)['"]/g)) resources.push({ path: new URL(match[1], original).pathname.slice(new URL(base).pathname.length), kind: "screenshot" });
      }
      contentRestrictions.push({ no, sourcePath: href, resources: [...new Map(resources.map((r) => [r.path, r])).values()], reason: "Graphic sexual imagery is replaced with a neutral template; original descriptions, media and related links are not published." });
      entries.push({ no, title, status: "restricted-template" });
      continue;
    }
    work.streaming = plain(index(row[6]).html() ?? "");
    const download = table.find("tr").first().find("a[href]").filter((_, a) => $(a).text().includes("ダウンロード")).first();
    if (download.attr("href")) work.download = { url: new URL(download.attr("href")!, original).href, label: plain(index(row[4]).find("a").first().html() ?? "") || download.text().trim() };
    const forum = cell.find("a[href]").filter((_, a) => $(a).text().includes("感想掲示板へ")).first().attr("href");
    if (forum) work.forum = new URL(forum, original).href;
    work.authorComment = await comment(html.slice(authorStart + "作者コメント：".length, hostStart).replace(/[━─]{5,}\s*(?:<br\s*\/?>)?\s*$/i, ""), work.id);
    work.hostComment = await comment(html.slice(hostStart + "管理人からのコメント".length), work.id);
    work.source = { ...old?.source, url: original, snapshotUrl: manifest[filename].actualUrl.replace(/id_\//, "/") };
    const icon = index(row[1]).find("img[src]").first().attr("src");
    if (icon) work.icon = await image(new URL(icon, base).href, work.id, "icons");
    const screenshots = new Set<string>();
    for (const img of table.find("tr").eq(1).find("img[src]").toArray()) {
      screenshots.add(new URL($(img).attr("src")!, original).href);
      for (const attr of ["onmouseover", "onmouseout"]) for (const match of ($(img).attr(attr) ?? "").matchAll(/this\.src\s*=\s*['"]([^'"]+)['"]/g)) screenshots.add(new URL(match[1], original).href);
    }
    const localScreenshots = [];
    for (const screenshot of screenshots) {
      const local = await image(screenshot, work.id, "screenshots");
      if (local) localScreenshots.push(local);
    }
    if (localScreenshots.length) work.ss = localScreenshots;
    if (old?.source?.titleUrl && pageTitle !== title) work.originalTitle = pageTitle;
    works.push(work);
    entries.push({ no, title, screenshotsExpected: screenshots.size, screenshotsRecovered: localScreenshots.length, sourceUrl: manifest[filename].actualUrl });
    console.log(`${no}: ${localScreenshots.length}/${screenshots.size} screenshots`);
  }
  const banners = [];
  for (const img of index('img[src="img/kohaku2014b.png"]').toArray()) {
    const banner = await image(new URL(index(img).attr("src")!, base).href, id, "banners");
    if (banner) banners.push(banner);
  }
  await writeJson(worksPath, works);
  const festivals: Festival[] = JSON.parse(await fs.readFile("src/data/festivals.json", "utf8"));
  const festival = festivals.find((festival) => festival.id === id)!;
  delete festival.hasDetail;
  festival.banners = banners;
  await writeJson("src/data/festivals.json", festivals);
  await writeJson(`${root}/recovery.json`, { festivalId: id, entries, corrections, titleVariants: works.filter((work) => work.originalTitle).map((work) => ({ no: work.no, title: work.title, originalTitle: work.originalTitle, titleUrl: work.source?.titleUrl })), failures, banners, contentRestrictions, status: "awaiting-desktop-review", contentReview: "Keyword candidates were inspected in context. No.039 uses a complete neutral template for graphic sexual imagery. The Florida substring and nonsexual child/adventure references are not restrictions." });
  console.log(`Recovered ${works.length} works; ${failures.length} required resource gaps.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
