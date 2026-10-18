import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { Festival, WorkEntry, WorkDownload } from "../src/lib/types";
import { imageExtension, writeJson } from "./recover-entry-table";

const id = "2011-gw", root = `catch/${id}`, cache = `${root}/source/recovery`, base = "https://vipgw2011.web.fc2.com/";
type Capture = { originalUrl: string; requestedUrl: string; actualUrl: string; file: string; contentType: string | null; retrievedAt: string; proxyRegion: string };

async function main() {
  const manifest: Record<string, Capture> = JSON.parse(await fs.readFile(`${cache}/manifest.json`, "utf8"));
  const index = cheerio.load(iconv.decode(await fs.readFile(`${root}/investigation/original-live.bin`), "euc-jp"));
  const links = index('a[href]').toArray().filter((a) => /^entry\/\d+\.html$/.test(index(a).attr("href") || ""));
  if (links.length !== 89) throw new Error(`Unexpected source catalogue: ${links.length}`);
  const workFile = `src/data/works/${id}.json`, legacyFile = `${root}/legacy-works.json`;
  const current: WorkEntry[] = JSON.parse(await fs.readFile(workFile, "utf8"));
  await fs.copyFile(workFile, legacyFile, fs.constants.COPYFILE_EXCL).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
  const legacy: WorkEntry[] = JSON.parse(await fs.readFile(legacyFile, "utf8"));
  const works: WorkEntry[] = [], entries = [], sourceDetailGaps = [], titleDifferences = [], failures: Array<{ sourceUrl: string; error: string }> = [];
  const previous = JSON.parse(await fs.readFile(`${root}/recovery.json`, "utf8").catch(() => "{}"));
  async function image(url: string, kind: "icons" | "screenshots" | "banners") {
    const key = `asset-${new URL(url).pathname.replace(/[^\w.-]/g, "_")}.bin`;
    try {
      let bytes: Buffer;
      if (manifest[key]) bytes = await fs.readFile(`${cache}/${manifest[key].file}`);
      else {
        if (!process.argv.includes("--fetch")) throw new Error(previous.failures?.find((f: { sourceUrl: string }) => f.sourceUrl === url)?.error || "Missing cached source image; use --fetch through Japan");
        const r = await fetch(url, { signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`);
        bytes = Buffer.from(await r.arrayBuffer()); imageExtension(bytes); await fs.writeFile(`${cache}/${key}`, bytes);
        manifest[key] = { originalUrl: url, requestedUrl: url, actualUrl: r.url, file: key, contentType: r.headers.get("content-type"), retrievedAt: new Date().toISOString(), proxyRegion: "Japan" };
        await writeJson(`${cache}/manifest.json`, manifest);
      }
      const local = `/${kind}/${id}/${path.posix.basename(new URL(url).pathname).replace(/\.[^.]+$/, "")}.${imageExtension(bytes)}`;
      await fs.mkdir(path.dirname(`public${local}`), { recursive: true });
      const existing = await fs.readFile(`public${local}`).catch(() => undefined);
      if (!existing?.equals(bytes)) await fs.writeFile(`public${local}`, bytes);
      return local;
    } catch (error) { failures.push({ sourceUrl: url, error: String(error) }); return undefined; }
  }
  async function comment(html: string, owner: string) {
    const $ = cheerio.load(html, {}, false); $("script,style,iframe,object,embed,form,input,button").remove();
    for (const e of $("*").toArray()) {
      const node = $(e), href = node.attr("href"), src = node.attr("src");
      for (const attr of Object.keys(e.attribs)) if (!["href", "src", "class"].includes(attr)) node.removeAttr(attr);
      if (e.tagName === "pre") node.attr("style", "max-width:100%;overflow-x:auto");
      if (href) { const u = new URL(href, owner); if (/^https?:$/.test(u.protocol)) node.attr("href", u.href); else node.removeAttr("href"); }
      if (src) { const local = await image(new URL(src, owner).href, "screenshots"); if (local) node.attr("src", local); else node.remove(); }
    }
    return `<div class="source-comment">${($.root().html() || "").trim()}</div>`;
  }
  for (const a of links) {
    const sourcePath = index(a).attr("href")!, fileNo = sourcePath.match(/\/(\d+)\.html$/)![1], no = index(a).text().match(/^No\.(\d+)/)![1], row = index(a).closest("tr").children("td");
    const listTitle = index(a).text().trim().replace(/^No\.\d+\s*/, ""), old = legacy.find((w) => Number(w.no) === Number(no)), saved = current.find((w) => Number(w.no) === Number(no)), sourceUrl = new URL(sourcePath, base).href;
    const work: WorkEntry = { id: old?.id || `${id}-work-${fileNo}`, festivalId: id, no, title: saved?.source?.titleUrl ? saved.title : listTitle, author: row.eq(2).find("font").text().trim(), engine: row.eq(3).text().trim(), source: { url: sourceUrl, ...(saved?.source?.titleUrl ? { titleUrl: saved.source.titleUrl } : {}) } };
    const icon = row.eq(1).find("img[src]").attr("src"); if (icon) work.icon = await image(new URL(icon, base).href, "icons");
    const downloads: WorkDownload[] = [];
    row.eq(4).find('a[href]').each((_, l) => { downloads.push({ url: new URL(index(l).attr("href")!, base).href, label: index(l).text().trim() }); });
    row.eq(5).find('a[href]').each((_, l) => { downloads.push({ url: new URL(index(l).attr("href")!, base).href, label: `修正 ${index(l).text().trim()}` }); });
    if (downloads.length === 1) work.download = downloads[0]; else if (downloads.length > 1) work.downloads = downloads;
    const revision = row.eq(5).text().trim(); if (revision) work.updates = `一覧の修正欄：${revision}`;
    const forum = row.eq(6).find("a[href]").first().attr("href"); if (forum) work.forum = new URL(forum, base).href;
    const capture = manifest[sourcePath];
    if (!capture) {
      if (fileNo !== "063") throw new Error(`Unexpected missing source detail ${sourcePath}`);
      work.source = { url: `${base}#works`, titleUrl: "https://jbbs.shitaraba.net/bbs/read.cgi/game/52496/1304208533/" };
      work.updates = [work.updates, "編纂注：原紹介ページとスクリーンショットは未取得です。作者・ツール・アイコン・配布先は祭典の作品一覧に基づきます。"].filter(Boolean).join("\n");
      sourceDetailGaps.push({ no, sourcePath, sourceUrl, error: "Source HTTP 404; exact archive index and availability lookup returned no capture. Keep catalogue-derived metadata and a labelled generated fallback, without invented source comments or screenshots.", evidence: [`${root}/investigation/detail-fetch.json`, `${root}/investigation/entry063-cdx.bin`, `${root}/investigation/entry063-availability.bin`, `${root}/investigation/entry063-forum-migrated.json`] });
    } else {
      const $ = cheerio.load(iconv.decode(await fs.readFile(`${cache}/${capture.file}`), "euc-jp")), heading = $("body > p").eq(1), title = heading.find("strong").first().text().trim();
      const author = heading.find("font").first().text().trim(), tool = $("body > strong").first().text().trim(), pres = $("pre");
      if (!title || !author || !tool || pres.length !== 3) throw new Error(`Unexpected detail layout ${no}`);
      work.author = author; work.engine = tool;
      if (title !== work.title) { work.originalTitle = title; work.source!.titleUrl ??= `${base}#works`; }
      if (old && old.title !== title) titleDifferences.push({ no, previousTitle: old.title, detailTitle: title, listTitle, keptTitle: work.title, evidence: work.source!.titleUrl || `${base}#works` });
      work.authorComment = await comment($.html(pres.eq(1)), sourceUrl);
      const host = pres.eq(2).clone(); host.html((host.html() || "").replace(/^\s*管理人から一言[:：](?:\r?\n){0,2}/, "")); work.hostComment = await comment($.html(host), sourceUrl);
      const gallery = $("img[src]").toArray().filter((i) => !$(i).parents("pre").length && /(?:^|\/)ss\//.test($(i).attr("src")!)).map((i) => new URL($(i).attr("src")!, sourceUrl).href);
      work.ss = [];
      for (const url of gallery) { const local = await image(url, "screenshots"); if (local) work.ss.push(local); }
    }
    works.push(work); entries.push({ no, id: work.id, sourcePath, sourceUrl, listTitle, sourceSubmissionMarker: row.eq(0).text().trim(), status: capture ? "detail-recovered" : "catalogue-recovered-detail-unavailable" });
  }
  const banners: string[] = [];
  for (const img of index('img[src="image/banner.png"]').toArray()) { const local = await image(new URL(index(img).attr("src")!, base).href, "banners"); if (local) banners.push(local); }
  await writeJson(workFile, works); await writeJson(`${cache}/manifest.json`, manifest);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, sourceEncoding: "euc-jp", liveSourceAvailable: true, entries, sourceDetailGaps, titleDifferences, contentRestrictions: [], failures, note: "Source records are saved without content screening. One original introduction page is unavailable; retain its real catalogue metadata and an explicit missing-page notice. No.00 (entry/000.html) is explicitly identified as a source sample. Download and correction links are historical entries, not availability claims.", desktopReview: "pending" });
  const festivals: Festival[] = JSON.parse(await fs.readFile("src/data/festivals.json", "utf8")), festival = festivals.find((f) => f.id === id)!;
  festival.banners = banners; festival.columns = ["no", "icon", "work", "type", "download", "forum"]; delete festival.hasDetail;
  await writeJson("src/data/festivals.json", festivals);
  console.log(`${works.length} catalogue records; ${works.length - sourceDetailGaps.length} source introductions; ${sourceDetailGaps.length} unavailable detail; ${failures.length} image gaps.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
