import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import { imageExtension, writeJson } from "./recover-entry-table";
import type { Festival, WorkEntry } from "../src/lib/types";

const id = "2012-toppuu-festival", root = `catch/${id}`, base = "https://w.atwiki.jp/viprpgwind2012/";
type Capture = { originalUrl: string; actualUrl: string; file: string; contentType: string; no?: number };

async function main() {
  const pages: Record<string, Capture> = JSON.parse(await fs.readFile(`${root}/source/live/manifest.json`, "utf8"));
  const assets: Record<string, Capture> = JSON.parse(await fs.readFile(`${root}/source/assets/manifest.json`, "utf8"));
  const workFile = `src/data/works/${id}.json`, legacyFile = `${root}/legacy-works.json`;
  await fs.copyFile(workFile, legacyFile, fs.constants.COPYFILE_EXCL).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
  const old: WorkEntry[] = JSON.parse(await fs.readFile(legacyFile, "utf8"));
  const originalResources: Record<string, string> = {}, outputs = new Map<string, { bytes: Buffer; local: string }>();
  for (const [file, source] of Object.entries(assets)) {
    if (source.originalUrl.includes("atwiki_headbar.css")) continue;
    const bytes = await fs.readFile(`${root}/source/assets/${source.file || file}`), url = new URL(source.originalUrl);
    const extension = source.contentType.includes("css") ? "css" : source.contentType.includes("svg") ? "svg" : imageExtension(bytes);
    const local = `resources/${path.posix.basename(file, ".bin")}.${extension}`;
    originalResources[url.href] = local; outputs.set(url.href, { bytes, local });
  }
  const top = cheerio.load(await fs.readFile(`${root}/source/live/index.html.bin`, "utf8"));
  const attached = new Map<string, string>();
  top('a[href*="img.atwiki.jp/viprpgwind2012/attach/1/"]').each((_, a) => attached.set(top(a).text().trim(), new URL(top(a).attr("href")!, base).href));
  const aliases = [];
  for (const metadata of Object.values(pages)) {
    const $ = cheerio.load(await fs.readFile(`${root}/source/live/${metadata.file}`, "utf8"));
    const references = $("[src],[href]").toArray().flatMap((e) => [$(e).attr("src"), $(e).attr("href")].filter((s): s is string => Boolean(s)));
    for (const style of $("style").toArray()) for (const match of ($(style).html() || "").matchAll(/url\(["']?([^"')]+)["']?\)/g)) references.push(match[1]);
    for (const value of references) {
      let url: URL; try { url = new URL(value, metadata.actualUrl); } catch { continue; }
      if (url.hostname === "www48.atwiki.jp" && url.searchParams.get("act") === "open") {
        const actual = attached.get(url.searchParams.get("file") || "");
        if (actual && originalResources[actual]) { originalResources[url.href] = originalResources[actual]; aliases.push({ url: url.href, attachment: actual }); }
      }
    }
  }
  for (const protocol of ["http:", "https:"]) originalResources[`${protocol}//www48.atwiki.jp/viprpgwind2012/`] = "index.html";
  const canonicalImage = async (url: string, kind: "screenshots" | "banners", key: string) => {
    const source = outputs.get(url); if (!source) throw new Error(`Uncached source image ${url}`);
    const local = `/${kind}/${id}/${key}.${imageExtension(source.bytes)}`;
    await fs.mkdir(path.dirname(`public${local}`), { recursive: true }); await fs.writeFile(`public${local}`, source.bytes); return local;
  };
  function safeComment(html: string) {
    const $ = cheerio.load(html, {}, false); $("script,style,form,input,button,iframe,object,embed,picture,img,source").remove();
    $("*").each((_, e) => { for (const a of Object.keys(e.attribs)) if (a !== "href") $(e).removeAttr(a); if ($(e).attr("href")) $(e).attr("href", new URL($(e).attr("href")!, base).href); });
    return `<div class="source-comment">${($.root().html() || "").trim()}</div>`;
  }
  const works: WorkEntry[] = [], entries = [];
  for (const [file, metadata] of Object.entries(pages).sort((a, b) => (a[1].no || 0) - (b[1].no || 0))) {
    if (!metadata.no) continue;
    const $ = cheerio.load(await fs.readFile(`${root}/source/live/${metadata.file}`, "utf8")), body = $("#wikibody"), heading = body.find("blockquote").first().text().trim();
    const match = heading.match(/^No\.(\d+)\s+([\s\S]+)$/); if (!match || Number(match[1]) !== metadata.no) throw new Error(`Wrong source detail ${file}`);
    const no = match[1], late = /（遅刻組）/.test(match[2]), title = match[2].replace(/\s*（遅刻組）\s*$/, "").trim(), oldWork = old.find((w) => Number(w.no) === metadata.no);
    const summary = body.find("blockquote").first().nextAll("div").first().text();
    const category = summary.match(/ジャンル：([^\n]+)/)?.[1].trim(), engine = summary.match(/ツール：([^\n]+)/)?.[1].trim();
    if (!category || !engine) throw new Error(`Missing source category/tool ${no}`);
    const work: WorkEntry = { id: oldWork?.id || `${id}-work-${no}`, festivalId: id, no, title: oldWork?.source?.titleUrl ? oldWork.title : title, author: "", category, engine, source: { url: metadata.actualUrl, authorOmitted: true, ...(oldWork?.source?.titleUrl ? { titleUrl: oldWork.source.titleUrl } : {}) } };
    if (work.title !== title) work.originalTitle = title;
    const posting = body.find("h3").filter((_, h) => $(h).text().trim() === "投下時コメント").first().next("div");
    if (!posting.length) throw new Error(`Missing posting comment ${no}`); work.authorComment = safeComment(posting.html() || "");
    const captions = [], screenshots = [];
    for (const img of body.find("img.atwiki_plugin_ref[src]").toArray()) {
      const url = new URL($(img).attr("src")!, metadata.actualUrl).href;
      screenshots.push(await canonicalImage(url, "screenshots", `${no}-${screenshots.length + 1}`));
      const caption = $(img).closest("div").clone(); caption.find("picture,img,source").remove();
      captions.push((caption.html() || "").replace(/^\s*\.\s*(?:<br>)?/, "").trim());
    }
    work.ss = screenshots;
    const feedbackHeading = body.find("blockquote").filter((_, q) => $(q).text().trim() === "コメント").first();
    const feedback = feedbackHeading.nextAll().clone(); feedback.find("form").remove();
    const feedbackHtml = feedback.toArray().filter((e) => e.type === "tag" && e.tagName === "ul").map((e) => $.html(e)).join("");
    work.hostComment = safeComment(captions.map((c) => `<p>${c}</p>`).join("") + (feedbackHtml ? `<p>Wikiコメント：</p>${feedbackHtml}` : ""));
    const download = body.find('a[href]').filter((_, a) => $(a).text().trim() === "自動保管庫からDL").first();
    if (download.length) work.download = { url: new URL(download.attr("href")!, metadata.actualUrl).href, label: download.text().trim() };
    const reaction = body.find('a[href]').filter((_, a) => $(a).text().trim() === "スレでの反応").first(); if (reaction.length) work.forum = new URL(reaction.attr("href")!, metadata.actualUrl).href;
    const modified = body.find(".atwiki-lastmodify").text().trim(); work.updates = [late ? "遅刻組（原ページ記載）" : "", modified].filter(Boolean).join("\n");
    works.push(work); entries.push({ no, sourcePath: file, sourceUrl: metadata.actualUrl, sourceHeading: heading, authorOmitted: true, screenshots: screenshots.length, captions: captions.length, wikiCommentsHtml: Boolean(feedbackHtml), late });
  }
  if (works.length !== 19) throw new Error(`Unexpected source count ${works.length}`);
  const bannerUrl = attached.get("banner.png"); if (!bannerUrl) throw new Error("Missing source banner"); const banner = await canonicalImage(bannerUrl, "banners", "banner");
  await writeJson(workFile, works); await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, sourceEncoding: "utf-8", liveSourceAvailable: true, entries, contentRestrictions: [], failures: [], originalResources, resourceAliases: aliases, note: "Browser same-origin responses preserve exact UTF-8 source bytes where command-line requests receive a verification page. Original Wiki provides no creator names or streaming policy. Anonymous post IDs are retained in posting quotes, not promoted to creator names. Screenshot captions and existing reader comments are retained as editorial comments.", desktopReview: "pending" });
  const festivals: Festival[] = JSON.parse(await fs.readFile("src/data/festivals.json", "utf8")), festival = festivals.find((f) => f.id === id)!;
  festival.banners = [banner]; festival.columns = festival.columns.filter((c) => c !== "icon"); delete festival.hasDetail; await writeJson("src/data/festivals.json", festivals);
  console.log(`Recovered ${works.length} details; ${works.reduce((n,w)=>n+(w.ss?.length||0),0)} screenshots; 19 explicitly uncredited authors.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
