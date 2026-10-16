import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { Festival, WorkEntry, WorkDownload } from "../src/lib/types";
import { imageExtension, writeJson } from "./recover-entry-table";

const id = "2012-kouhaku", root = `catch/${id}`, cache = `${root}/source/recovery`;
const base = "http://www45.atpages.jp/vipkohaku2012/";
type Capture = { originalUrl: string; requestedUrl: string; actualUrl: string; contentType: string | null; retrievedAt: string; file?: string; proxyRegion?: string; proxyNode?: string; originalBodySha256?: string; originalBodyBytes?: number; sanitizedForRestrictedContent?: boolean };

async function main() {
  const manifestPath = `${cache}/manifest.json`;
  const manifest: Record<string, Capture> = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const previous = JSON.parse(await fs.readFile(`${root}/recovery.json`, "utf8").catch(() => "{}"));
  const source = cheerio.load(iconv.decode(await fs.readFile(`${root}/investigation/cgi-hk.bin`), "shift_jis"));
  const links = source('a[href*="_v="][href*="tpl=view2"]').toArray();
  if (links.length !== 96) throw new Error(`Expected 96 source entries, found ${links.length}`);
  const workPath = `src/data/works/${id}.json`, legacyPath = `${root}/legacy-works.json`;
  await fs.copyFile(workPath, legacyPath, fs.constants.COPYFILE_EXCL).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
  const legacy: WorkEntry[] = JSON.parse(await fs.readFile(legacyPath, "utf8"));
  const inventory: string[][] = JSON.parse(await fs.readFile(`${root}/investigation/original-timemap.bin`, "utf8"));
  const backups: { entries: Array<{ no: string; downloads: Array<{ href: string; label: string }> }> } = JSON.parse(await fs.readFile(`${root}/mirror-backup-links.json`, "utf8"));
  const originalManifest: Record<string, Capture> = JSON.parse(await fs.readFile(`${root}/source/original-view/manifest.json`, "utf8"));
  const thumbnailPage = Object.entries(originalManifest).find(([, m]) => m.originalUrl.includes("tpl=view3"));
  if (!thumbnailPage) throw new Error("Missing source thumbnail catalogue");
  const thumbnail = cheerio.load(iconv.decode(await fs.readFile(`${root}/source/original-view/${thumbnailPage[0]}`), "shift_jis"));
  const awardsPage = Object.entries(originalManifest).find(([, m]) => m.originalUrl.endsWith("/enq4.html"));
  if (!awardsPage) throw new Error("Missing source awards page");
  const awards = cheerio.load(iconv.decode(await fs.readFile(`${root}/source/original-view/${awardsPage[0]}`), "shift_jis"));
  const rankings = [];
  for (const [file, metadata] of Object.entries(originalManifest)) if (metadata.originalUrl.includes("/db2/profile.cgi")) rankings.push(cheerio.load(iconv.decode(await fs.readFile(`${root}/source/original-view/${file}`), "shift_jis")));
  const failures: Array<{ owner: string; sourceUrl: string; error: string }> = [];
  const works: WorkEntry[] = [], entries = [], contentRestrictions = [];
  const restricted = new Set(["017"]);
  const plain = (html: string) => {
    const $ = cheerio.load(html, {}, false);
    $("script,style").remove();
    $("br").replaceWith("\n");
    return $.root().text().trim();
  };
  async function image(original: string, owner: string, kind: "icons" | "screenshots" | "banners") {
    const key = `image-${new URL(original).pathname.replace(/[^\w.-]/g, "_")}.bin`;
    try {
      let bytes: Buffer;
      if (manifest[key]) bytes = await fs.readFile(`${cache}/${manifest[key].file ?? key}`);
      else {
        if (!process.argv.includes("--fetch")) throw new Error(previous.failures?.find((f: { sourceUrl: string }) => f.sourceUrl === original)?.error.replace(/^Error:\s*/, "") || "Missing cached image; use --fetch through Hong Kong proxy");
        const row = inventory.slice(1).find((r) => new URL(r[0]).href === original);
        const requestedUrl = `https://web.archive.org/web/${row?.[2] ?? "20130608011757"}id_/${original}`;
        const r = await fetch(requestedUrl, { signal: AbortSignal.timeout(120000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        bytes = Buffer.from(await r.arrayBuffer());
        imageExtension(bytes);
        await fs.writeFile(`${cache}/${key}`, bytes);
        manifest[key] = { originalUrl: original, requestedUrl, actualUrl: r.url, contentType: r.headers.get("content-type"), retrievedAt: new Date().toISOString(), proxyRegion: "Hong Kong", file: key };
        await writeJson(manifestPath, manifest);
      }
      const local = `/${kind}/${id}/${path.posix.basename(new URL(original).pathname).replace(/\.[^.]+$/, "")}.${imageExtension(bytes)}`;
      await fs.mkdir(path.dirname(`public${local}`), { recursive: true });
      await fs.writeFile(`public${local}`, bytes);
      return local;
    } catch (error) { failures.push({ owner, sourceUrl: original, error: String(error) }); return undefined; }
  }
  async function comment(html: string, url: string, owner: string) {
    const $ = cheerio.load(html, {}, false);
    $("script,style,iframe,object,embed,form,input,button").remove();
    for (const e of $("*").toArray()) {
      const node = $(e), src = node.attr("src"), href = node.attr("href");
      if (/monospace|ＭＳ|MS PGothic/i.test(`${node.attr("style") || ""} ${node.attr("face") || ""}`)) node.addClass("AA");
      for (const a of Object.keys(e.attribs)) if (!["href", "class", "src"].includes(a)) node.removeAttr(a);
      if (href) { const target = new URL(href, url); if (/^https?:$/.test(target.protocol)) node.attr("href", target.href); else node.removeAttr("href"); }
      if (src) { const local = await image(new URL(src, url).href, owner, "screenshots"); if (local) node.attr("src", local); else node.remove(); }
    }
    return `<div class="source-comment">${($.root().html() || "").trim()}</div>`;
  }
  for (const link of links) {
    const url = new URL(source(link).attr("href")!, base).href, no = new URL(url).searchParams.get("_v")!;
    const capture = manifest[`db/entry${no}.html`];
    if (!capture) throw new Error(`Missing original detail ${no}`);
    if (!restricted.has(no) && capture.sanitizedForRestrictedContent) throw new Error(`Refresh altered source cache before restoring ${no}`);
    const $ = cheerio.load(iconv.decode(await fs.readFile(`${cache}/${capture.file}`), "shift_jis"));
    const cells = $("#box2 table#entrylist td").toArray();
    const heading = cells.map((td) => $(td).text().trim()).find((t) => t.startsWith(`No.${no} - `));
    if (!heading) throw new Error(`Wrong detail response for ${no}`);
    const title = heading.slice(`No.${no} - `.length), fields: Record<string, string> = {};
    for (const td of cells) for (const label of ["ジャンル", "ツール", "配信/投稿", "作者", "作者コメント", "管理人コメント"]) {
      const html = $(td).html() || "";
      if (html.startsWith(`${label}：`)) fields[label] = html.slice(`${label}：`.length).replace(/^\s*<br\s*\/?>/i, "");
    }
    if (!fields["作者"] || !fields["ツール"]) throw new Error(`Missing detail fields ${no}`);
    const old = legacy.find((w) => w.no === no);
    const work: WorkEntry = { id: old?.id || `${id}-work-${no}`, festivalId: id, no, title: old?.source?.titleUrl ? old.title : title, author: plain(fields["作者"]), engine: plain(fields["ツール"]), category: plain(fields["ジャンル"] || "") };
    if (work.title !== title) work.originalTitle = title;
    const icon = $("#box2 th img[src]").first().attr("src");
    const gallery = new Set<string>();
    for (const img of $('#box2 img[src^="_img/s/"]').toArray()) {
      gallery.add(new URL($(img).attr("src")!, url).href);
      for (const attr of ["onmouseover", "onmouseout"]) for (const match of ($(img).attr(attr) || "").matchAll(/this\.src\s*=\s*['"]([^'"]+)['"]/g)) gallery.add(new URL(match[1], url).href);
    }
    if (restricted.has(no)) {
      work.contentRestricted = true;
      const uniqueIcon = icon && !["rpg.png", "yomu.png", "miru.png", "ksg.png"].includes(path.posix.basename(icon));
      const rankingResources: Array<{ path: string; kind: string }> = [];
      for (const ranking of rankings) for (const table of ranking("table#entrylist").filter((_, t) => ranking(t).find("tr").first().text().slice(0, 200).includes(`No.${no}`)).toArray()) {
        for (const img of ranking(table).find("img[src]").toArray()) {
          const imageUrl = new URL(ranking(img).attr("src")!, `${base}db2/profile.cgi`);
          rankingResources.push({ path: imageUrl.pathname.slice(new URL(base).pathname.length), kind: imageUrl.pathname.includes("/_img/i/") ? "icon" : "screenshot" });
        }
      }
      for (const img of thumbnail("a[href]").filter((_, a) => new URL(thumbnail(a).attr("href")!, url).searchParams.get("_v") === no).find("img[src]").toArray()) gallery.add(new URL(thumbnail(img).attr("src")!, url).href);
      for (const img of awards("a[href]").filter((_, a) => new URL(awards(a).attr("href")!, base).searchParams.get("_v") === no).closest("table").find("img[src]").toArray()) gallery.add(new URL(awards(img).attr("src")!, base).href);
      contentRestrictions.push({ no, sourcePath: `db/entry${no}.html`, resources: [...(uniqueIcon ? [{ path: new URL(icon, url).pathname.slice(new URL(base).pathname.length), kind: "icon" }] : []), ...[...gallery].map((s) => ({ path: new URL(s).pathname.slice(new URL(base).pathname.length), kind: "screenshot" })), ...rankingResources], relatedUrls: $("#box2 table#entrylist a[href]").toArray().map((a) => new URL($(a).attr("href")!, url).href).filter((s) => /yahoo\.jp|jbbs\.|enq-maker/.test(s)), reason: "Existing awards record explicitly identifies sexualized underage characters in No.017; retain its neutral template without original descriptions, media or related links. Generic shared catalogue icons remain available to other entries." });
    } else {
      work.source = { url, snapshotUrl: capture.actualUrl, ...(old?.source?.titleUrl ? { titleUrl: old.source.titleUrl } : {}) };
      work.streaming = plain(fields["配信/投稿"] || "");
      work.authorComment = await comment(fields["作者コメント"] || "", url, work.id);
      work.hostComment = await comment(fields["管理人コメント"] || "", url, work.id);
      work.updates = $("#box2 .new dl").toArray().map((dl) => $(dl).children().toArray().map((e) => $(e).text().trim()).join("\n")).join("\n");
      if (icon) work.icon = await image(new URL(icon, url).href, work.id, "icons");
      work.ss = [];
      for (const s of gallery) { const local = await image(s, work.id, "screenshots"); if (local) work.ss.push(local); }
      if (!work.ss.length) delete work.ss;
      const downloads: WorkDownload[] = [];
      for (const a of $("#box2 table#entrylist a[href]").toArray()) {
        const label = $(a).text().trim(), rawHref = $(a).attr("href")!.trim();
        if (!rawHref || rawHref.startsWith("#") || /^javascript:/i.test(rawHref)) continue;
        const href = new URL(rawHref, url).href;
        if (label === "BBS" && new URL(href).pathname.includes("/bbs/read.cgi/")) work.forum = href;
        if (/ダウンロード|パッチ|修正/.test(label) && !downloads.some((d) => d.url === href)) downloads.push({ url: href, label });
      }
      for (const backup of backups.entries.find((e) => e.no === no)?.downloads ?? []) {
        const backupUrl = new URL(backup.href).href;
        if (!downloads.some((d) => d.url === backupUrl)) downloads.push({ url: backupUrl, label: `保管庫（${backup.label}）`, detail: "祭典ミラーの作品一覧に掲載された Google Drive 保管リンク" });
      }
      if (downloads.length === 1) work.download = downloads[0];
      if (downloads.length > 1) work.downloads = downloads;
    }
    works.push(work);
    const row = source(link).closest("tr"), submission = cells.map((td) => $(td).text()).join("\n").match(/提出状況：([^)]*)\)/)?.[1];
    entries.push({ no, id: work.id, sourcePath: `db/entry${no}.html`, sourceUrl: url, team: row.children("td").eq(1).attr("class"), engineKey: plain(row.children("td").first().html()?.split(/<br\s*\/?>/i)[0] || "").split("/").slice(1).join("/"), submissionStatus: submission, galleryUrls: restricted.has(no) ? [] : [...gallery], status: work.contentRestricted ? "restricted-template" : "detail-recovered" });
    console.log(`Recovered ${no}`);
  }
  const banners = [];
  const linkPage = Object.entries(originalManifest).find(([, m]) => m.originalUrl === `${base}link.html`);
  if (!linkPage) throw new Error("Missing original link page with official banner references");
  const home = cheerio.load(iconv.decode(await fs.readFile(`${root}/source/original-view/${linkPage[0]}`), "shift_jis"));
  for (const img of home('img[src*="bnkohaku2012"]').toArray()) { const local = await image(new URL(home(img).attr("src")!, base).href, id, "banners"); if (local && !banners.includes(local)) banners.push(local); }
  const sanitizedSources = [];
  const sourceCopies: Array<{ file: string; metadata: Capture }> = [
    ...[...restricted].map((no) => ({ file: `${cache}/${manifest[`db/entry${no}.html`].file}`, metadata: manifest[`db/entry${no}.html`] })),
    ...Object.entries(originalManifest).filter(([, m]) => m.originalUrl.endsWith("/enq4.html") || m.originalUrl.includes("/db2/profile.cgi")).map(([file, metadata]) => ({ file: `${root}/source/original-view/${file}`, metadata })),
  ];
  for (const sourceCopy of sourceCopies) {
    const bytes = await fs.readFile(sourceCopy.file), doc = cheerio.load(iconv.decode(bytes, "shift_jis")), affected = new Set<string>();
    const original = new URL(sourceCopy.metadata.originalUrl), number = original.searchParams.get("_v");
    if (number && restricted.has(number)) {
      doc("td").each((_, td) => {
        for (const label of ["作者コメント", "管理人コメント"]) if ((doc(td).html() || "").startsWith(`${label}：`)) doc(td).html(`${label}：<br>制限された内容`);
      });
      affected.add(number);
    } else for (const no of restricted) {
      let tables = doc("a[href]").filter((_, a) => new URL(doc(a).attr("href")!, original).searchParams.get("_v") === no).closest("table");
      if (!tables.length && original.pathname.includes("/db2/")) {
        tables = doc("table#entrylist").filter((_, t) => doc(t).find("tr").first().text().slice(0, 200).includes(`No.${no}`));
        tables.find("tr").first().find("td").last().append(`<a href="${base}db/profile.cgi?_v=${no}&amp;tpl=view2">作品紹介</a>`);
      }
      tables.each((_, table) => {
        if (original.pathname.endsWith("/enq4.html")) doc(table).find("td").filter((_, td) => doc(td).text().trim().startsWith("作品総評")).html("作品総評：<br>制限された内容");
        else if (doc(table).find(".new").length) doc(table).find(".new").html(`<dl><h3><a href="${base}db/profile.cgi?_v=${no}&amp;tpl=view2">作品紹介</a></h3><p>制限された内容</p></dl>`);
        else doc(table).find("tr").slice(1).find("td").html("制限された内容");
        affected.add(no);
      });
    }
    if (!affected.size) throw new Error(`Restricted source block not identified: ${sourceCopy.file}`);
    const sanitized = iconv.encode(doc.html(), "shift_jis"), metadata = sourceCopy.metadata;
    metadata.originalBodySha256 ??= createHash("sha256").update(bytes).digest("hex");
    metadata.originalBodyBytes ??= bytes.length;
    metadata.sanitizedForRestrictedContent = true;
    if (!bytes.equals(sanitized)) await fs.writeFile(sourceCopy.file, sanitized);
    sanitizedSources.push({ file: sourceCopy.file, sourceUrl: metadata.originalUrl, affectedNumbers: [...affected], originalBodySha256: metadata.originalBodySha256, originalBodyBytes: metadata.originalBodyBytes, sanitizedSha256: createHash("sha256").update(sanitized).digest("hex") });
  }
  await writeJson(`${root}/restricted-source-cache-review.json`, { sources: sanitizedSources, note: "Restricted descriptions and reviews are replaced with neutral text in tracked source caches as well as public pages. The omitted original bodies retain only hashes and acquisition metadata; other source bytes remain unchanged." });
  await writeJson(`${root}/source/original-view/manifest.json`, originalManifest);
  await writeJson(workPath, works);
  await writeJson(manifestPath, manifest);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, sourceEncoding: "shift_jis", liveSourceAvailable: false, entries, contentRestrictions, failures, desktopReview: "pending", note: "Original CGI query links are retained as source URLs and mapped to local static detail pages only for offline replay. Archive requests use Hong Kong; live original/migration/mirror checks use Japan." });
  const festivals: Festival[] = JSON.parse(await fs.readFile("src/data/festivals.json", "utf8"));
  const festival = festivals.find((f) => f.id === id)!;
  festival.banners = banners;
  delete festival.hasDetail;
  await writeJson("src/data/festivals.json", festivals);
  console.log(`${works.length} entries; ${restricted.size} templates; ${failures.length} image gaps.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
