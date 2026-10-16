import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import { readStaticLiteralArray, replaceStaticArray } from "./source-static-array";
import { imageExtension, writeJson } from "./recover-entry-table";
import type { Festival, WorkEntry } from "../src/lib/types";

const id = "2012-summer", root = `catch/${id}`, cache = `${root}/source/recovery`, base = "http://viprpgtkool.web.fc2.com/2012summer/";
type Capture = { originalUrl: string; requestedUrl: string; actualUrl: string; file: string; contentType: string | null; retrievedAt: string; proxyRegion: string; originalBodySha256?: string; sanitizedForRestrictedContent?: boolean };

async function main() {
  const manifest: Record<string, Capture> = JSON.parse(await fs.readFile(`${cache}/manifest.json`, "utf8")), bytes = await fs.readFile(`${cache}/data.js.bin`);
  const code = iconv.decode(bytes, "shift_jis"), data = readStaticLiteralArray(code, "DATA");
  if (data.length !== 990) throw new Error(`Unexpected source array length ${data.length}`);
  const file = `src/data/works/${id}.json`, legacyFile = `${root}/legacy-works.json`;
  await fs.copyFile(file, legacyFile, fs.constants.COPYFILE_EXCL).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
  const legacy: WorkEntry[] = JSON.parse(await fs.readFile(legacyFile, "utf8"));
  const restrictions = new Set([8, 9, 29, 35, 37, 47, 48, 49, 51, 54, 89]), noIcon = new Set([32, 55, 64, 81, 86, 89]), gifIcon = new Set([14, 15, 78]);
  const works: WorkEntry[] = [], entries = [], contentRestrictions = [], failures: Array<{ sourceUrl: string; error: string }> = [];
  const prior = JSON.parse(await fs.readFile(`${root}/recovery.json`, "utf8").catch(() => "{}"));
  const plain = (text: string) => { const $ = cheerio.load(text, {}, false); $("br").replaceWith("\n"); return $.root().text().trim(); };
  async function image(original: string, kind: "icons" | "screenshots" | "banners") {
    const key = `asset-${new URL(original).pathname.replace(/[^\w.-]/g, "_")}.bin`;
    try {
      let b: Buffer;
      if (manifest[key]) b = await fs.readFile(`${cache}/${manifest[key].file}`);
      else {
        if (!process.argv.includes("--fetch")) throw new Error(prior.failures?.find((e: { sourceUrl: string }) => e.sourceUrl === original)?.error.replace(/^(?:Error:\s*)+/, "") || "Missing cached source asset; use --fetch through Japan");
        const r = await fetch(original, { signal: AbortSignal.timeout(60000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`);
        b = Buffer.from(await r.arrayBuffer()); if (!b.length) throw new Error(`Empty image body (HTTP ${r.status})`); imageExtension(b); await fs.writeFile(`${cache}/${key}`, b);
        manifest[key] = { originalUrl: original, requestedUrl: original, actualUrl: r.url, file: key, contentType: r.headers.get("content-type"), retrievedAt: new Date().toISOString(), proxyRegion: "Japan" };
        await writeJson(`${cache}/manifest.json`, manifest);
      }
      const local = `/${kind}/${id}/${path.posix.basename(new URL(original).pathname).replace(/\.[^.]+$/, "")}.${imageExtension(b)}`;
      await fs.mkdir(path.dirname(`public${local}`), { recursive: true }); await fs.writeFile(`public${local}`, b); return local;
    } catch (error) { failures.push({ sourceUrl: original, error: String(error) }); return undefined; }
  }
  async function comment(text: string) {
    const $ = cheerio.load(text, {}, false); $("script,style,iframe,object,embed,form,input,button").remove();
    for (const e of $("*").toArray()) {
      const node = $(e), href = node.attr("href"), src = node.attr("src");
      for (const attr of Object.keys(e.attribs)) if (!["href", "src", "class"].includes(attr)) node.removeAttr(attr);
      if (href) { const u = new URL(href, base); if (/^https?:$/.test(u.protocol)) node.attr("href", u.href); else node.removeAttr("href"); }
      if (src) { const local = await image(new URL(src, base).href, "screenshots"); if (local) node.attr("src", local); else node.remove(); }
    }
    const html = $.root().html() || "", aa = /[┏┓┗┛┃━]/.test($.root().text()) || /(?:∧|￣￣|─){2}/.test($.root().text());
    return `<div class="source-comment">${aa ? `<div class="AA" style="max-width:100%;overflow-x:auto">${html}</div>` : html}</div>`;
  }
  for (let no = 0; no < 90; no++) {
    const values = data.slice(no * 11, no * 11 + 11);
    if (values[10] !== 0 || typeof values[9] !== "number") throw new Error(`Invalid source record ${no}`);
    const old = legacy.find((w) => Number(w.no) === no), title = plain(String(values[0])), author = plain(String(values[1])), sourcePath = no === 14 ? "sakuhin_.html" : "sakuhin.html", sourceUrl = `${base}${sourcePath}?no=${no}&mode=default`;
    const work: WorkEntry = { id: old?.id || `${id}-work-${no}`, festivalId: id, no: String(no), title: old?.source?.titleUrl ? old.title : title || `No.${no}（原題記載なし）`, author, engine: plain(String(values[3])) };
    if (title && title !== work.title) work.originalTitle = title;
    const category = plain(String(values[2])); if (category) work.category = category;
    const iconPath = noIcon.has(no) ? undefined : `icon/no${no}.${gifIcon.has(no) ? "gif" : "png"}`, ssPath = `ss/no${no}.png`;
    if (restrictions.has(no)) {
      work.contentRestricted = true; work.category = "制限された内容";
      const urls = [`http://jbbs.livedoor.jp/bbs/read.cgi/game/54712/${values[6]}`];
      if (values[4] !== "---") urls.push(`https://onedrive.live.com/?cid=487dc4e52d4a7554&id=487DC4E52D4A7554!${values[9]}`);
      contentRestrictions.push({ no: String(no), sourcePath: `${sourcePath}?no=${no}&mode=default`, resources: [...(iconPath ? [{ path: iconPath, kind: "icon" }] : []), { path: ssPath, kind: "screenshot" }], relatedUrls: urls, reason: "Sexual promotion, sexualized young characters, or sexual promotional imagery mixed with child imagery; retain a complete neutral template." });
      data[no * 11 + 7] = "制限された内容"; data[no * 11 + 8] = "制限された内容";
    } else {
      work.source = { url: sourceUrl, ...(author ? {} : { authorOmitted: true }), ...(old?.source?.titleUrl ? { titleUrl: old.source.titleUrl } : {}) };
      work.streaming = plain(String(values[5])); work.authorComment = await comment(String(values[7])); work.hostComment = await comment(String(values[8]));
      if (iconPath) work.icon = await image(new URL(iconPath, base).href, "icons");
      const ss = await image(new URL(ssPath, base).href, "screenshots"); if (ss) work.ss = [ss];
      if (values[4] !== "---" && Number(values[9]) >= 0) work.download = { url: `https://onedrive.live.com/?cid=487dc4e52d4a7554&id=487DC4E52D4A7554!${values[9]}`, label: plain(String(values[4])) };
      if (/^\d{10}$/.test(String(values[6]))) work.forum = `http://jbbs.livedoor.jp/bbs/read.cgi/game/54712/${values[6]}`;
    }
    works.push(work); entries.push({ no, sourceUrl, sourcePath, titleOmitted: !title, authorOmitted: !author, sourceTitle: title, sourceCategory: category, iconPath, screenshotPath: ssPath, status: restrictions.has(no) ? "restricted-template" : "detail-recovered", splitLabelDuplicatesMainUrl: no === 51 || no === 67 });
    console.log(`Recovered ${no}`);
  }
  const banner = await image(`${base}banner.png`, "banners");
  const dataCapture = manifest["data.js"]; dataCapture.originalBodySha256 ??= createHash("sha256").update(bytes).digest("hex"); dataCapture.sanitizedForRestrictedContent = true;
  const sanitized = iconv.encode(replaceStaticArray(code, "DATA", data), "shift_jis"); if (!bytes.equals(sanitized)) await fs.writeFile(`${cache}/data.js.bin`, sanitized);
  await writeJson(`${cache}/manifest.json`, manifest); await writeJson(file, works);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, sourceEncoding: "shift_jis", liveSourceAvailable: true, sourceData: { file: "data.js", entries: 90, fieldsPerEntry: 11, originalBodySha256: dataCapture.originalBodySha256, restrictedCommentsNeutralized: true }, entries, contentRestrictions, failures, note: "Paths and OneDrive IDs follow the actual source display scripts. No.14 intentionally omits title, author and genre; use an explicitly annotated number rather than invent a name. No.0 forum ID 1 is a sample placeholder. Missing source-list icons are intentional, not missing downloads.", desktopReview: "pending" });
  const festivals: Festival[] = JSON.parse(await fs.readFile("src/data/festivals.json", "utf8")), festival = festivals.find((f) => f.id === id)!;
  festival.banners = banner ? [banner] : []; delete festival.hasDetail; await writeJson("src/data/festivals.json", festivals);
  console.log(`${works.length} rows; ${restrictions.size} templates; ${failures.length} resource failures.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
