import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { Festival, WorkEntry, WorkDownload } from "../src/lib/types";
import { imageExtension, writeJson } from "./recover-entry-table";

const id = "2013-summer", root = `catch/${id}`, cache = `${root}/source/recovery`;
const base = "http://www.geocities.jp/viprpgsummer2013/";
const liveBase = "http://viprpgsummer2013.at-ninja.jp/";

async function main() {
  const assets: { checked: number; resources: number; failures: unknown[] } = JSON.parse(await fs.readFile(`${root}/asset-review.json`, "utf8"));
  if (assets.checked !== assets.resources || assets.failures.length) throw new Error("Complete source asset recovery before publishing this catalogue");
  const manifest: Record<string, { originalUrl: string; actualUrl: string }> = JSON.parse(await fs.readFile(`${cache}/manifest.json`, "utf8"));
  const liveManifest: Record<string, { originalUrl: string; actualUrl: string }> = JSON.parse(await fs.readFile(`${root}/source/live/manifest.json`, "utf8"));
  const liveComparison = JSON.parse(await fs.readFile(`${root}/live-comparison.json`, "utf8"));
  if (liveComparison.liveDetails !== 72 || liveComparison.changedPages.length) throw new Error("Review differences between the live migration and original archive before publishing");
  const index = cheerio.load(iconv.decode(await fs.readFile(`${root}/source/live/main.html.bin`), "shift_jis"));
  const hrefs = [...new Set(index("a[href]").toArray().map((a) => index(a).attr("href")!).filter((href) => /^ss\/\d+\.html$/.test(href)))];
  if (hrefs.length !== 72) throw new Error(`Unexpected source index size: ${hrefs.length}`);
  const workPath = `src/data/works/${id}.json`, legacyPath = `${root}/legacy-works.json`;
  await fs.copyFile(workPath, legacyPath, fs.constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const current: WorkEntry[] = JSON.parse(await fs.readFile(workPath, "utf8"));
  const baseline: WorkEntry[] = JSON.parse(await fs.readFile(legacyPath, "utf8"));
  const works: WorkEntry[] = [], entries = [], corrections = [];
  const archiveFallback = new Set<string>();
  function plain(html: string) {
    const $ = cheerio.load(html);
    $("script,style").remove();
    $("*").contents().each((_, n) => { if (n.type === "text") n.data = n.data.replace(/[\t\r\n ]+/g, " "); });
    $("br").replaceWith("\n");
    return $.root().text().replace(/ +\n/g, "\n").replace(/\n +/g, "\n").trim();
  }
  async function image(original: string, kind: "icons" | "screenshots" | "banners") {
    const sourceBase = original.startsWith(liveBase) ? liveBase : base;
    const relative = new URL(original).pathname.slice(new URL(sourceBase).pathname.length), stem = relative.replace(/[^\w.-]/g, "_");
    const filename = `asset-${stem}.bin`;
    const live = liveManifest[filename]?.originalUrl === new URL(relative, liveBase).href;
    if (!live && manifest[filename]?.originalUrl !== new URL(relative, base).href) throw new Error(`Missing exact source image: ${original}`);
    if (!live) archiveFallback.add(relative);
    const bytes = await fs.readFile(live ? `${root}/source/live/${filename}` : `${cache}/${filename}`);
    const output = `/${kind}/${id}/${stem.replace(/\.[^.]+$/, "")}.${imageExtension(bytes)}`;
    await fs.mkdir(path.dirname(`public${output}`), { recursive: true });
    const saved = await fs.readFile(`public${output}`).catch(() => undefined);
    if (!saved?.equals(bytes)) await fs.writeFile(`public${output}`, bytes);
    return output;
  }
  async function comment(html: string, url: string) {
    const $ = cheerio.load(html, {}, false);
    $("script,style,iframe,object,embed,form,input,button").remove();
    $("b").first().filter((_, e) => /^(?:コメント|管理者からのコメント)：$/.test($(e).text())).remove();
    for (const e of $("*").toArray()) {
      const node = $(e);
      if (/MS PGothic|ＭＳ Ｐゴシック|monospace/i.test(`${node.attr("style") || ""} ${node.attr("face") || ""}`)) node.addClass("AA");
      for (const a of Object.keys(e.attribs)) if (!["href", "src", "alt", "class", "width", "height"].includes(a)) node.removeAttr(a);
      if (node.attr("href")) {
        const target = new URL(node.attr("href")!, url);
        if (/^https?:$/.test(target.protocol)) node.attr("href", target.href);
        else node.removeAttr("href");
      }
    }
    for (const img of $("img[src]").toArray()) {
      const node = $(img), original = new URL(node.attr("src")!, url).href;
      const small = original.includes("/ico/") || (Number(node.attr("width")) > 0 && Number(node.attr("width")) < 100);
      node.attr("src", await image(original, small ? "icons" : "screenshots"));
      if (small) node.addClass("comment-face");
    }
    return `<div class="source-comment">${($.root().html() || "").replace(/^(?:\s*<br\s*\/?>)+/i, "").trim()}</div>`;
  }
  for (const href of hrefs) {
    const filename = `${href.replace("/", "_")}.bin`, url = new URL(href, liveBase).href;
    const $ = cheerio.load(iconv.decode(await fs.readFile(`${root}/source/live/${filename}`), "shift_jis")), table = $("table").first();
    const header = table.find("tr").first().children("td"), no = header.eq(1).text().trim().match(/^No\.(\d+)$/)?.[1];
    if (!no || Number(no) !== Number(href.match(/(\d+)\.html$/)![1])) throw new Error(`Unexpected source identity: ${href}`);
    const old = current.find((w) => Number(w.no) === Number(no)), pageTitle = plain(header.eq(2).html() || "");
    const title = old?.source?.titleUrl ? old.title : pageTitle;
    const work: WorkEntry = { id: old?.id || `${id}-work-${no}`, festivalId: id, no, title, author: "", source: { url, snapshotUrl: manifest[filename].actualUrl.replace(/id_\//, "/"), ...(old?.source?.titleUrl ? { titleUrl: old.source.titleUrl } : {}) } };
    if (title !== pageTitle) work.originalTitle = pageTitle;
    for (const cell of table.find("td").toArray()) {
      const html = $(cell).html() || "", text = plain(html);
      if (text.startsWith("作者：")) work.author = text.slice(3).trim();
      if (text.startsWith("ジャンル：")) { work.category = text.slice(5).split("使用ツール：")[0].trim(); work.engine = text.split("使用ツール：")[1]?.trim(); }
      if (text.startsWith("配信：")) work.streaming = text;
      if (text.startsWith("コメント：")) work.authorComment = await comment(html, url);
      if (text.startsWith("管理者からのコメント：")) work.hostComment = await comment(html, url);
      if (text.startsWith("最近の更新：")) work.updates = text.slice("最近の更新：".length).trim();
    }
    const downloads: WorkDownload[] = [];
    const primary = header.eq(2).find("a[href]").first().attr("href");
    if (primary?.trim()) downloads.push({ url: new URL(primary, url).href, label: plain(header.last().html() || "") });
    for (const a of table.find("a[href]").toArray()) {
      const href = $(a).attr("href")!.trim(), label = plain($(a).html() || "");
      if (!href) continue;
      const absolute = new URL(href, url).href;
      if (label.includes("感想掲示板")) work.forum = absolute;
      else if (/パッチ|修正ファイル|ダウンロード/.test(label) && !downloads.some((d) => d.url === absolute)) downloads.push({ url: absolute, label });
    }
    if (downloads.length === 1) work.download = downloads[0];
    if (downloads.length > 1) work.downloads = downloads;
    const icon = header.first().find("img[src]").first().attr("src");
    if (icon) work.icon = await image(new URL(icon, url).href, "icons");
    const refs = table.find("tr").eq(1).find("img[src]").toArray().map((img) => new URL($(img).attr("src")!, url).href);
    for (const img of table.find("tr").eq(1).find("img[src]").toArray()) for (const a of ["onmouseover", "onmouseout"]) for (const m of $(img).attr(a)?.matchAll(/this\.src\s*=\s*['"]([^'"]+)['"]/g) ?? []) refs.push(new URL(m[1], url).href);
    work.ss = [];
    for (const source of [...new Set(refs)]) work.ss.push(await image(source, "screenshots"));
    const oldTitle = baseline.find((w) => Number(w.no) === Number(no))?.title;
    if (oldTitle && oldTitle.replace(/\s/g, "") !== pageTitle.replace(/\s/g, "")) corrections.push({ no, before: oldTitle, after: pageTitle });
    works.push(work);
    entries.push({ no, id: work.id, screenshots: work.ss.length });
  }
  works.sort((a, b) => Number(a.no) - Number(b.no));
  const banners = [];
  for (const img of index('img[src="picture/smj2013.png"]').toArray()) banners.push(await image(new URL(index(img).attr("src")!, liveBase).href, "banners"));
  await writeJson(workPath, works);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, preferredSourceBase: liveBase, liveSourceEvidence: `${root}/live-comparison.json`, archiveFallback: [...archiveFallback], sourceEncoding: "shift_jis", entries, corrections, failures: [], contentReview: `${root}/content-review.json`, desktopReview: "pending" });
  const festivals: Festival[] = JSON.parse(await fs.readFile("src/data/festivals.json", "utf8"));
  const festival = festivals.find((f) => f.id === id)!;
  festival.banners = banners;
  delete festival.hasDetail;
  await writeJson("src/data/festivals.json", festivals);
  const urls: Array<{ slug: string; url: string }> = JSON.parse((await fs.readFile("catch/festival-urls.json", "utf8")).replace(/^\uFEFF/, ""));
  urls.find((f) => f.slug === id)!.url = liveBase;
  await writeJson("catch/festival-urls.json", urls);
  console.log(`Recovered ${works.length} details, ${works.reduce((n, w) => n + (w.ss?.length || 0), 0)} gallery references and ${banners.length} banner.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
