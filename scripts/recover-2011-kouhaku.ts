import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { Festival, WorkEntry, WorkDownload } from "../src/lib/types";
import { imageExtension, writeJson } from "./recover-entry-table";

const id = "2011-kouhaku", root = `catch/${id}`, cache = `${root}/source/recovery`, base = "http://vipkohaku2011.web.fc2.com/";
type Capture = { originalUrl: string; requestedUrl: string; actualUrl: string; file: string };

async function main() {
  const manifest: Record<string, Capture> = JSON.parse(await fs.readFile(`${cache}/manifest.json`, "utf8"));
  const decode = async (file: string) => cheerio.load(iconv.decode(await fs.readFile(`${cache}/${manifest[file].file}`), "shift_jis"));
  const index = await decode("entry/entry_menu.html"), indexUrl = `${base}entry/entry_menu.html`;
  const anchors = index('a[href]').toArray().filter((a) => /^\d{3}\.html#toppage$/.test(index(a).attr("href") || ""));
  if (anchors.length !== 98) throw new Error(`Unexpected catalogue size ${anchors.length}`);
  const workFile = `src/data/works/${id}.json`, legacyFile = `${root}/legacy-works.json`;
  await fs.copyFile(workFile, legacyFile, fs.constants.COPYFILE_EXCL).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
  const legacy: WorkEntry[] = JSON.parse(await fs.readFile(legacyFile, "utf8"));
  const patches = await decode("page04.html");
  const backup: { sourceUrl: string; files: Array<{ name: string }> } = JSON.parse(await fs.readFile(`${root}/investigation/public-backup-listing.json`, "utf8"));
  const missing = JSON.parse(await fs.readFile(`${root}/investigation/asset-fetch.json`, "utf8")).failures;
  const failures: Array<{ sourceUrl: string; error: string }> = [], entries = [], titleDifferences = [], works: WorkEntry[] = [];
  async function image(url: string, kind: "icons" | "screenshots" | "banners") {
    const capture = Object.values(manifest).find((m) => m.originalUrl === url);
    if (!capture) {
      if (!failures.some((f) => f.sourceUrl === url)) failures.push({ sourceUrl: url, error: JSON.stringify(missing.find((f: { sourceUrl: string }) => f.sourceUrl === url)?.errors || "No cached image; source research remains open") });
      return undefined;
    }
    const bytes = await fs.readFile(`${cache}/${capture.file}`);
    const local = `/${kind}/${id}/${path.posix.basename(new URL(url).pathname).replace(/\.[^.]+$/, "")}.${imageExtension(bytes)}`;
    await fs.mkdir(path.dirname(`public${local}`), { recursive: true });
    if (!(await fs.readFile(`public${local}`).catch(() => undefined))?.equals(bytes)) await fs.writeFile(`public${local}`, bytes);
    return local;
  }
  async function comment(html: string, owner: string, stripHostLabel = false) {
    if (stripHostLabel) html = html.replace(/^((?:\s|<[^>]+>)*)管理人コメント[：:]/, "$1");
    const $ = cheerio.load(html, {}, false);
    $("script,style,iframe,object,embed,form,input,button").remove();
    for (const e of $("*").toArray()) {
      const node = $(e), href = node.attr("href"), src = node.attr("src");
      for (const attr of Object.keys(e.attribs)) if (!["href", "src", "class", "colspan", "rowspan"].includes(attr)) node.removeAttr(attr);
      if (e.tagName === "pre") node.attr("style", "max-width:100%;overflow-x:auto");
      if (href) { const u = new URL(href, owner); if (/^https?:$/.test(u.protocol)) node.attr("href", u.href); else node.removeAttr("href"); }
      if (src) { const local = await image(new URL(src, owner).href, "screenshots"); if (local) node.attr("src", local); else node.replaceWith('<span class="archive-missing-image">［原資料の画像は未取得です］</span>'); }
    }
    return `<div class="source-comment">${($.root().html() || "").trim()}</div>`;
  }
  for (const a of anchors) {
    const no = index(a).attr("href")!.slice(0, 3), sourcePath = `entry/${no}.html`, sourceUrl = new URL(sourcePath, base).href;
    const $ = await decode(sourcePath), tables = $("#main table"), heading = tables.eq(1).find("td").first().text().trim();
    const match = heading.match(/^No(\d{3})\.\s*-\s*([\s\S]+)$/);
    const rows = tables.eq(2).children("tbody").children("tr"), cells = rows.toArray().map((r) => $(r).children("td").first());
    if (!match || match[1] !== no || rows.length !== 7) throw new Error(`Unexpected source structure ${sourcePath}`);
    const value = (i: number, label: string) => { const text = cells[i].text().trim(); if (!text.startsWith(label)) throw new Error(`Missing field ${no}/${label}`); return text.slice(label.length).trim(); };
    const old = legacy.find((w) => Number(w.no) === Number(no)), title = match[2].trim();
    if (old && title !== old.title) titleDifferences.push({ no, before: old.title, after: title, sourceUrl });
    const work: WorkEntry = { id: old?.id || `${id}-work-${no}`, festivalId: id, no, title, author: value(1, "作者："), engine: value(0, "使用ツール："), category: value(2, "ジャンル："), streaming: value(3, "動画・配信："), source: { url: sourceUrl, snapshotUrl: manifest[sourcePath].actualUrl } };
    const row = index(a).closest("tr").children(), icon = tables.eq(1).find("img[src]").first().attr("src");
    if (icon) work.icon = await image(new URL(icon, sourceUrl).href, "icons");
    work.authorComment = await comment(cells[4].html() || "", sourceUrl);
    work.hostComment = await comment(cells[5].html() || "", sourceUrl, true);
    const downloads: WorkDownload[] = [], forums: string[] = [];
    const addLinks = (links: Array<{ href: string; label: string }>, owner: string) => {
      for (const link of links) {
        if (link.href.startsWith("#") || !/^https?:$/.test(new URL(link.href, owner).protocol)) continue;
        const url = new URL(link.href, owner).href;
        if (/^https?:\/\/jbbs\.(?:livedoor|shitaraba)\./.test(url)) { forums.push(url); continue; }
        if (/^https?:\/\/(?:www\.)?(?:twitter|x)\.com\//.test(url)) continue;
        if (!downloads.some((d) => d.url === url)) downloads.push({ url, label: link.label });
      }
    };
    addLinks(cells[6].find('a[href]').toArray().map((l) => ({ href: $(l).attr("href")!, label: $(l).text().trim() })), sourceUrl);
    addLinks(row.eq(4).find('a[href]').toArray().map((l) => ({ href: index(l).attr("href")!, label: index(l).text().trim() })), indexUrl);
    const patch = patches('a[href]').filter((_, l) => patches(l).attr("href") === `entry/${no}.html#toppage`).first().closest("tr").children();
    addLinks(patch.eq(3).find('a[href]').toArray().map((l) => ({ href: patches(l).attr("href")!, label: `修正 ${patches(l).text().trim()}` })), `${base}page04.html`);
    const backupFiles = backup.files.filter((f) => f.name.match(/^kohaku2011_(\d{3})/)?.[1] === no);
    if (backupFiles.length) downloads.push({ url: backup.sourceUrl, label: "公開保管庫", detail: backupFiles.map((f) => f.name).join("\n") });
    if (no === "087") {
      const supplement = await fs.readFile(`${root}/source/backup/supplement.txt`, "utf8"), url = supplement.match(/https?:\/\/[^』\s]+/)?.[0];
      if (url) downloads.push({ url, label: "公開保管庫の補足に記載された配布先" });
    }
    if (downloads.length === 1) work.download = downloads[0]; else if (downloads.length) work.downloads = downloads;
    if (forums.length) work.forum = forums[0];
    const updates = $(".new dl").toArray().flatMap((dl) => $(dl).children("dt").toArray().map((dt) => `${$(dt).text().trim()}\n${$(dt).next("dd").text().trim()}`));
    if (patch.length) updates.push(`祭典の修正一覧：${patch.eq(5).text().trim()}`);
    const sources = new Set<string>();
    for (const img of $('#main img[src]').toArray().filter((img) => /(?:^|\/)ss\//.test($(img).attr("src") || ""))) {
      sources.add(new URL($(img).attr("src")!, sourceUrl).href);
      for (const attr of ["onmouseover", "onmouseout"]) for (const m of ($(img).attr(attr) || "").matchAll(/this\.src\s*=\s*['"]([^'"]+)['"]/g)) sources.add(new URL(m[1], sourceUrl).href);
    }
    work.ss = [];
    for (const url of sources) { const local = await image(url, "screenshots"); if (local && !work.ss.includes(local)) work.ss.push(local); }
    if (!work.ss.length) delete work.ss;
    const missingImages = [...sources].filter((u) => !Object.values(manifest).some((m) => m.originalUrl === u));
    if (missingImages.length) updates.push(`編纂注：原資料のスクリーンショット ${missingImages.length} 件は未取得です。保存できた画像のみ表示しています。`);
    if (updates.length) work.updates = updates.join("\n\n");
    works.push(work); entries.push({ no, id: work.id, sourcePath, sourceUrl, snapshotUrl: manifest[sourcePath].actualUrl, sourceTeam: row.eq(1).attr("class"), sourceToolAndCategory: row.eq(1).text().trim(), sourceSubmissionMarker: index(a).text().trim().startsWith("★") ? "★" : "", gallerySources: [...sources], missingImages });
  }
  if (titleDifferences.length) throw new Error("Title differences require source evidence before replacing established titles");
  const top = await decode("index_top.html"), banners: string[] = [];
  for (const img of top('img[src]').toArray().filter((i) => /^img\/bnkohaku2011/.test(top(i).attr("src") || ""))) { const local = await image(new URL(top(img).attr("src")!, base).href, "banners"); if (local && !banners.includes(local)) banners.push(local); }
  for (const file of ["support-fetch.json", "support-fetch-2.json", "support-fetch-3.json"]) for (const f of JSON.parse(await fs.readFile(`${root}/investigation/${file}`, "utf8").catch(() => "[]"))) {
    if (f.error && !failures.some((g) => g.sourceUrl === f.originalUrl)) failures.push({ sourceUrl: f.originalUrl, error: f.error });
  }
  await writeJson(workFile, works);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, sourceEncoding: "shift_jis", liveSourceAvailable: false, entries, titleDifferences, contentRestrictions: [], failures, backupEvidence: ["investigation/wiki-backup-links.json", "investigation/public-backup-listing.json", "source/backup/manifest.json"], note: "Directly preserve all 98 linked source records, including No.000 sample, without content screening. Only actual displayed/hover screenshot URLs enter the gallery. Missing assets remain research gaps, not proof of permanent loss. Historical downloads and patches are retained; the public backup folder and exact listed filenames supplement them without claiming that package contents were downloaded or checked.", desktopReview: "pending" });
  const festivals: Festival[] = JSON.parse(await fs.readFile("src/data/festivals.json", "utf8")), festival = festivals.find((f) => f.id === id)!;
  festival.banners = banners; festival.columns = ["no", "icon", "work", "type", "streaming", "download", "forum"]; delete festival.hasDetail;
  await writeJson("src/data/festivals.json", festivals);
  console.log({ records: works.length, comments: works.length * 2, icons: works.filter((w) => w.icon).length, screenshots: works.reduce((n, w) => n + (w.ss?.length || 0), 0), banners: banners.length, sourceGaps: failures.length });
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
