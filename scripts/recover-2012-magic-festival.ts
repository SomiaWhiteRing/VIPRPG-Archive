import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import { createHash } from "node:crypto";
import type { Festival, WorkEntry } from "../src/lib/types";
import { imageExtension, writeJson } from "./recover-entry-table";

const id = "2012-magic-festival", root = `catch/${id}`, cache = `${root}/source/recovery`;
const base = "http://magicalviprpg2012.web.fc2.com/";
type Capture = { originalUrl: string; requestedUrl: string; actualUrl: string; file: string; contentType: string | null; retrievedAt: string; proxyRegion: string; originalBodySha256?: string; sanitizedForRestrictedContent?: boolean };

async function main() {
  const manifest: Record<string, Capture> = JSON.parse(await fs.readFile(`${cache}/manifest.json`, "utf8"));
  const index = cheerio.load(iconv.decode(await fs.readFile(`${root}/investigation/top-live.bin`), "shift_jis"));
  const rows = index("tr").toArray().filter((tr) => /^\d+$/.test(index(tr).children("td").first().text().trim()));
  if (rows.length !== 43) throw new Error(`Unexpected source catalogue: ${rows.length}`);
  const workPath = `src/data/works/${id}.json`, legacyPath = `${root}/legacy-works.json`;
  await fs.copyFile(workPath, legacyPath, fs.constants.COPYFILE_EXCL).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
  const old: WorkEntry[] = JSON.parse(await fs.readFile(legacyPath, "utf8"));
  const restricted = new Set<string>(), works: WorkEntry[] = [], entries = [], contentRestrictions = [], failures: Array<{ sourceUrl: string; error: string }> = [], historicalDownloads = [], omittedBodies = [];
  const previous = JSON.parse(await fs.readFile(`${root}/recovery.json`, "utf8").catch(() => "{}"));
  function plain(html: string) { const $ = cheerio.load(html, {}, false); $("br").replaceWith("\n"); return $.root().text().trim(); }
  async function image(url: string, kind: "icons" | "screenshots" | "banners") {
    const key = `asset-${new URL(url).pathname.replace(/[^\w.-]/g, "_")}.bin`;
    try {
      let bytes: Buffer;
      if (manifest[key]) bytes = await fs.readFile(`${cache}/${manifest[key].file}`);
      else {
        if (!process.argv.includes("--fetch")) throw new Error(previous.failures?.find((f: { sourceUrl: string }) => f.sourceUrl === url)?.error || "Missing cached source asset; use --fetch through Japan");
        const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        bytes = Buffer.from(await r.arrayBuffer()); imageExtension(bytes);
        await fs.writeFile(`${cache}/${key}`, bytes);
        manifest[key] = { originalUrl: url, requestedUrl: url, actualUrl: r.url, file: key, contentType: r.headers.get("content-type"), retrievedAt: new Date().toISOString(), proxyRegion: "Japan" };
        await writeJson(`${cache}/manifest.json`, manifest);
      }
      const local = `/${kind}/${id}/${path.posix.basename(new URL(url).pathname).replace(/\.[^.]+$/, "")}.${imageExtension(bytes)}`;
      await fs.mkdir(path.dirname(`public${local}`), { recursive: true }); await fs.writeFile(`public${local}`, bytes);
      return local;
    } catch (error) { failures.push({ sourceUrl: url, error: String(error) }); return undefined; }
  }
  async function comment(html: string, owner: string) {
    const $ = cheerio.load(html, {}, false); $("script,style,iframe,object,embed,form,input,button").remove();
    for (const e of $("*").toArray()) {
      const node = $(e), href = node.attr("href"), src = node.attr("src");
      if (/MS PGothic|ＭＳ|monospace/i.test(`${node.attr("style") || ""} ${node.attr("face") || ""}`)) node.addClass("AA");
      for (const key of Object.keys(e.attribs)) if (!["href", "src", "class"].includes(key)) node.removeAttr(key);
      if (href) { const u = new URL(href, owner); if (/^https?:$/.test(u.protocol)) node.attr("href", u.href); else node.removeAttr("href"); }
      if (src) { const local = await image(new URL(src, owner).href, "screenshots"); if (local) node.attr("src", local); else node.remove(); }
    }
    const contents = ($.root().html() || "").trim();
    return `<div class="source-comment">${/[┏┓┗┛┃━]/.test($.root().text()) ? `<div class="AA" style="max-width:100%;overflow-x:auto">${contents}</div>` : contents}</div>`;
  }
  for (const row of rows) {
    const cells = index(row).children("td"), no = cells.first().text().trim(), link = cells.eq(2).find("a").first(), href = link.attr("href"), legacy = old.find((w) => Number(w.no) === Number(no));
    const listTitle = plain(link.length ? link.html() || "" : (cells.eq(2).html() || "").split(/<br\s*\/?>/i)[0]).replace(/^[★■]/, "").trim();
    const work: WorkEntry = { id: legacy?.id || `${id}-work-${no}`, festivalId: id, no, title: listTitle, author: cells.eq(2).find("font").text().trim(), engine: cells.eq(3).text().trim(), category: cells.eq(4).text().trim() };
    const icon = new URL(cells.eq(1).find("img").attr("src")!, base).href;
    if (!href) {
      work.detailDisabled = true; work.streaming = cells.eq(5).text().trim(); work.icon = await image(icon, "icons");
      works.push(work); entries.push({ no, status: "source-catalogue-only", reason: "Source sample row has no detail, download or forum link." }); continue;
    }
    const url = new URL(href, base).href, capture = manifest[href];
    if (!capture) throw new Error(`Missing source detail: ${href}`);
    if (capture.sanitizedForRestrictedContent) {
      if (!process.argv.includes("--fetch")) throw new Error(`Source detail ${no} was previously sanitized; use --fetch to restore it.`);
      const response = await fetch(capture.requestedUrl, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} while restoring source detail ${no}`);
      await fs.writeFile(`${cache}/${capture.file}`, Buffer.from(await response.arrayBuffer()));
      capture.actualUrl = response.url;
      capture.contentType = response.headers.get("content-type");
      capture.retrievedAt = new Date().toISOString();
      delete capture.sanitizedForRestrictedContent;
      delete capture.originalBodySha256;
    }
    const bytes = await fs.readFile(`${cache}/${capture.file}`), $ = cheerio.load(iconv.decode(bytes, "shift_jis")), table = $("table").first();
    const title = $("title").text().trim(), fields: Record<string, string> = {};
    for (const td of table.find("td").toArray()) {
      const label = $(td).children("b").first().text().trim();
      if (!["術者名◇", "魔具◇", "コメント◇", "マスターから◇"].includes(label)) continue;
      const copy = $(td).clone(); copy.children("b").first().remove();
      fields[label] = (copy.html() || "").replace(/^\s*<br\s*\/?>/i, "").trim();
    }
    if (!fields["術者名◇"] || !fields["魔具◇"]) throw new Error(`Missing source metadata: ${no}`);
    work.title = legacy?.source?.titleUrl ? legacy.title : title;
    if (work.title !== title) work.originalTitle = title;
    work.author = plain(fields["術者名◇"]); work.engine = plain(fields["魔具◇"]);
    const gallery = table.find("tr").eq(1).find("img[src]").toArray().map((img) => new URL($(img).attr("src")!, url).href);
    if (restricted.has(no)) {
      work.contentRestricted = true;
      const links = [...table.find("a[href]").toArray().map((a) => new URL($(a).attr("href")!, url).href), ...cells.find("a[href]").toArray().map((a) => new URL(index(a).attr("href")!, base).href)].filter((s) => s !== url);
      contentRestrictions.push({ no, sourcePath: href, resources: [{ path: new URL(icon).pathname.slice(1), kind: "icon" }, ...gallery.map((s) => ({ path: new URL(s).pathname.slice(1), kind: "screenshot" }))], relatedUrls: [...new Set(links)], reason: "Existing source description or host comment records sexualized young characters; retain the neutral template." });
      for (const td of table.find("td").toArray()) if (["コメント◇", "マスターから◇"].includes($(td).children("b").first().text().trim())) $(td).html(`<b>${$(td).children("b").first().text()}</b><br>制限された内容`);
      capture.originalBodySha256 ??= createHash("sha256").update(bytes).digest("hex"); capture.sanitizedForRestrictedContent = true;
      const sanitized = iconv.encode($.html(), "shift_jis"); if (!bytes.equals(sanitized)) await fs.writeFile(`${cache}/${capture.file}`, sanitized);
      omittedBodies.push({ no, file: `${cache}/${capture.file}`, originalBodySha256: capture.originalBodySha256, sanitizedSha256: createHash("sha256").update(sanitized).digest("hex") });
    } else {
      work.source = { url, ...(legacy?.source?.titleUrl ? { titleUrl: legacy.source.titleUrl } : {}) };
      work.streaming = cells.eq(5).text().trim(); work.icon = await image(icon, "icons");
      work.authorComment = await comment(fields["コメント◇"] || "", url); work.hostComment = await comment(fields["マスターから◇"] || "", url);
      const ss = []; for (const source of gallery) { const local = await image(source, "screenshots"); if (local) ss.push(local); } if (ss.length) work.ss = ss;
      const download = cells.eq(6).find("a[href]").first(), target = download.attr("href");
      if (target) work.download = { url: new URL(target, base).href, label: download.text().trim() };
      const forum = cells.eq(8).find("a[href]").attr("href"); if (forum) work.forum = new URL(forum, base).href;
      const modified = cells.eq(7).text().trim(); if (modified && modified !== "---") work.updates = `修正：${modified}`;
      if (no === "16") work.updates = "歴12年3月12日：作者都合により公開停止（原サイト更新履歴）";
      historicalDownloads.push({ no, indexDownload: work.download, originalDetailLinks: table.find("a[href]").toArray().filter((a) => /DL/.test($(a).text())).map((a) => ({ label: $(a).text().trim(), url: new URL($(a).attr("href")!, url).href })) });
    }
    const submissionMarker = link.text().trim().match(/^[★■]/)?.[0] || "";
    works.push(work); entries.push({ no, id: work.id, sourcePath: href, sourceUrl: url, sourceTitle: title, listTitle, submissionMarker, submissionStatus: no === "16" ? "withdrawn" : submissionMarker === "★" ? "submitted" : submissionMarker === "■" ? "late" : "not-submitted", status: restricted.has(no) ? "restricted-template" : "detail-recovered", galleryUrls: restricted.has(no) ? [] : gallery });
    console.log(`Recovered ${no}`);
  }
  const banners = [];
  for (const img of index('img[src^="banner/"]').toArray()) { const local = await image(new URL(index(img).attr("src")!, base).href, "banners"); if (local) banners.push(local); }
  await writeJson(workPath, works); await writeJson(`${cache}/manifest.json`, manifest);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, sourceEncoding: "shift_jis", liveSourceAvailable: true, entries, contentRestrictions, failures, withdrawnNumbers: ["16"], historicalDownloads, omittedBodies, note: "Use updated 2014 OneDrive links from the live catalogue; retired detail-page SkyDrive targets remain source evidence. Sample No.0 is catalogue-only and receives no invented detail. ★ submitted; ■ late. Restricted original media are not fetched.", desktopReview: "pending" });
  const festivals: Festival[] = JSON.parse(await fs.readFile("src/data/festivals.json", "utf8")), festival = festivals.find((f) => f.id === id)!;
  festival.banners = banners; delete festival.hasDetail; await writeJson("src/data/festivals.json", festivals);
  console.log(`${works.length} catalogue rows; ${restricted.size} full templates; ${failures.length} resource gaps.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
