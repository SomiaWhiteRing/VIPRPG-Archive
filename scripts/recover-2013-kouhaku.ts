import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { Festival, WorkEntry, WorkDownload } from "../src/lib/types";
import { imageExtension, writeJson } from "./recover-entry-table";

const id = "2013-kouhaku", root = `catch/${id}`, cache = `${root}/source/recovery`;
const base = "http://vipkohaku2013.web.fc2.com/";
type Capture = { originalUrl: string; requestedUrl: string; actualUrl: string; contentType: string | null; retrievedAt: string; previousErrors?: Array<{ url: string; error: string }> };

async function main() {
  const manifestPath = `${cache}/manifest.json`;
  const manifest: Record<string, Capture> = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const inventory: string[][] = JSON.parse(await fs.readFile(`${root}/investigation/original-timemap.bin`, "utf8"));
  const index = cheerio.load(iconv.decode(await fs.readFile(`${root}/investigation/original-live.bin`), "shift_jis"));
  const hrefs = [...new Set(index("a[href]").toArray().map((a) => index(a).attr("href")!).filter((href) => /^ent\/\d+\.html$/.test(href)))];
  if (hrefs.length !== 76) throw new Error(`Unexpected source catalogue size: ${hrefs.length}`);
  const workPath = `src/data/works/${id}.json`, legacyPath = `${root}/legacy-works.json`;
  await fs.copyFile(workPath, legacyPath, fs.constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const current: WorkEntry[] = JSON.parse(await fs.readFile(workPath, "utf8"));
  const baseline: WorkEntry[] = JSON.parse(await fs.readFile(legacyPath, "utf8"));
  const previous: { failures?: Array<{ sourceUrl: string; error: string }> } = JSON.parse(await fs.readFile(`${root}/recovery.json`, "utf8").catch(() => "{}"));
  const works: WorkEntry[] = [], entries = [], corrections = [], contentRestrictions = [];
  const failures: Array<{ owner: string; sourceUrl: string; error: string }> = [];
  function plain(html: string) {
    const $ = cheerio.load(html);
    $("script,style").remove();
    $("*").contents().each((_, node) => { if (node.type === "text") node.data = node.data.replace(/[\r\n\t ]+/g, " "); });
    $("br").replaceWith("\n");
    return $.root().text().replace(/ +\n/g, "\n").replace(/\n +/g, "\n").trim();
  }
  async function capture(originalUrl: string, filename: string) {
    if (manifest[filename]?.originalUrl === originalUrl) return { bytes: await fs.readFile(`${cache}/${filename}`), metadata: manifest[filename] };
    if (!process.argv.includes("--fetch")) {
      const known = previous.failures?.find((failure) => failure.sourceUrl === originalUrl);
      throw new Error(known?.error.replace(/^Error:\s*/, "") ?? `Missing cache: ${filename}; use --fetch`);
    }
    const row = inventory.slice(1).find((r) => new URL(r[0]).href === originalUrl), previousErrors = [];
    for (const url of [originalUrl, ...(row ? [`https://web.archive.org/web/${row[2] || row[1]}id_/${row[0]}`] : [])]) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const bytes = Buffer.from(await r.arrayBuffer());
        imageExtension(bytes);
        await fs.writeFile(`${cache}/${filename}`, bytes);
        manifest[filename] = { originalUrl, requestedUrl: url, actualUrl: r.url, contentType: r.headers.get("content-type"), retrievedAt: new Date().toISOString(), ...(previousErrors.length ? { previousErrors } : {}) };
        return { bytes, metadata: manifest[filename] };
      } catch (error) { previousErrors.push({ url, error: String(error) }); }
    }
    throw new Error(JSON.stringify(previousErrors));
  }
  async function image(original: string, owner: string, kind: "icons" | "screenshots" | "banners") {
    const relative = new URL(original).pathname.slice(1), key = relative.replace(/[^\w.-]/g, "_");
    try {
      const { bytes } = await capture(original, `image-${key}.bin`);
      const output = `/${kind}/${id}/${key.replace(/\.[^.]+$/, "")}.${imageExtension(bytes)}`;
      await fs.mkdir(path.dirname(`public${output}`), { recursive: true });
      const saved = await fs.readFile(`public${output}`).catch(() => undefined);
      if (!saved?.equals(bytes)) await fs.writeFile(`public${output}`, bytes);
      return output;
    } catch (error) { failures.push({ owner, sourceUrl: original, error: String(error) }); return undefined; }
  }
  async function comment(html: string, owner: string, url: string) {
    const $ = cheerio.load(html, {}, false);
    $("script,style,iframe,object,embed,form,input,button").remove();
    for (const e of $("*").toArray()) {
      const node = $(e);
      if (/ＭＳ Ｐゴシック|MS PGothic|monospace/i.test(node.attr("style") || "")) node.addClass("AA");
      for (const attr of Object.keys(e.attribs)) if (!["href", "src", "alt", "class", "width", "height"].includes(attr)) node.removeAttr(attr);
      if (node.attr("href")) node.attr("href", new URL(node.attr("href")!, url).href);
    }
    for (const img of $("img[src]").toArray()) {
      const node = $(img), source = new URL(node.attr("src")!, url).href;
      const small = Number(node.attr("width")) > 0 && Number(node.attr("width")) < 100;
      const output = await image(source, owner, small ? "icons" : "screenshots");
      if (output) { node.attr("src", output); if (small) node.addClass("comment-face"); }
      else node.remove();
    }
    return `<div class="source-comment">${($.root().html() || "").replace(/^(?:\s*<br\s*\/?>)+/i, "").trim()}</div>`;
  }
  for (let offset = 0; offset < hrefs.length; offset += 4) {
    await Promise.all(hrefs.slice(offset, offset + 4).map(async (href) => {
      const no = href.match(/(\d+)\.html$/)![1], url = new URL(href, base).href;
      const bytes = await fs.readFile(`${cache}/${href.replace("/", "_")}.bin`), $ = cheerio.load(iconv.decode(bytes, "shift_jis"));
      const header = $("table").eq(1), table = $("table").eq(2), heading = plain(header.html() || "");
      const identity = heading.match(/^No\.(\d+)\s*-\s*(?:★)?([\s\S]+)$/);
      if (!identity || Number(identity[1]) !== Number(no)) throw new Error(`Unexpected identity: ${heading}`);
      const pageTitle = identity[2].trim(), old = current.find((w) => Number(w.no) === Number(no));
      const title = old?.source?.titleUrl ? old.title : pageTitle;
      const work: WorkEntry = { id: old?.id || `${id}-work-${no}`, festivalId: id, no, title, author: "" };
      for (const cell of table.find("td").toArray()) {
        const html = $(cell).html() || "", text = plain(html);
        for (const [label, field] of [["作者：", "author"], ["使用ツール：", "engine"], ["ジャンル：", "category"], ["配信/投稿：", "streaming"]] as const) if (text.startsWith(label)) work[field] = text.slice(label.length).trim();
      }
      const gallery = $("#container > img[src]").toArray();
      const screenshotRefs = gallery.map((img) => new URL($(img).attr("src")!, url).href);
      for (const img of gallery) for (const attr of ["onmouseover", "onmouseout"]) for (const m of $(img).attr(attr)?.matchAll(/this\.src\s*=\s*['"]([^'"]+)['"]/g) ?? []) screenshotRefs.push(new URL(m[1], url).href);
      const icon = header.find("img[src]").first().attr("src");
      if (no === "33") {
        work.contentRestricted = true;
        delete work.streaming;
        const resources = [...(icon ? [{ path: new URL(icon, url).pathname.slice(1), kind: "icon" }] : []), ...[...new Set(screenshotRefs)].map((s) => ({ path: new URL(s).pathname.slice(1), kind: "screenshot" }))];
        const relatedUrls = table.find("a[href]").toArray().map((a) => $(a).attr("href")!.trim()).filter(Boolean).map((href) => new URL(href, url).href);
        contentRestrictions.push({ no, sourcePath: href, resources, relatedUrls, reason: "Graphic sexual and non-consensual content; retain a complete neutral template and omit source descriptions, media and related links." });
      } else {
        work.source = { url, ...(old?.source?.titleUrl ? { titleUrl: old.source.titleUrl } : {}) };
        if (title !== pageTitle) work.originalTitle = pageTitle;
        if (icon) work.icon = await image(new URL(icon, url).href, work.id, "icons");
        work.ss = [];
        for (const original of [...new Set(screenshotRefs)]) { const local = await image(original, work.id, "screenshots"); if (local) work.ss.push(local); }
        const downloads: WorkDownload[] = [];
        for (const a of table.find("a[href]").toArray()) {
          const href = $(a).attr("href")!.trim(), label = plain($(a).html() || "");
          if (!href) continue;
          const source = new URL(href, url).href;
          if (label === "BBS") work.forum = source;
          else if (/ダウンロード|パッチ/.test(label) && !downloads.some((d) => d.url === source)) downloads.push({ url: source, label });
        }
        if (downloads.length === 1) work.download = downloads[0];
        if (downloads.length > 1) work.downloads = downloads;
        for (const cell of table.find("td").toArray()) {
          const html = $(cell).html() || "", text = plain(html);
          if (text.startsWith("作者コメント：")) work.authorComment = await comment(html.replace(/^\s*作者コメント：/, ""), work.id, url);
          if (text.startsWith("管理人コメント：")) work.hostComment = await comment(html.replace(/^\s*管理人コメント：/, ""), work.id, url);
          if (text.startsWith("更新履歴：")) work.updates = text.slice("更新履歴：".length).trim();
        }
      }
      const oldTitle = baseline.find((w) => Number(w.no) === Number(no))?.title;
      if (oldTitle && oldTitle.replace(/\s/g, "") !== pageTitle.replace(/\s/g, "")) corrections.push({ no, before: oldTitle, after: pageTitle });
      works.push(work);
      entries.push({ no, id: work.id, status: work.contentRestricted ? "restricted-template" : "detail-recovered", screenshotsLinked: new Set(screenshotRefs).size, screenshotsRecovered: work.ss?.length || 0 });
    }));
    await writeJson(manifestPath, manifest);
    console.log(`Details ${Math.min(offset + 4, hrefs.length)}/${hrefs.length}`);
  }
  works.sort((a, b) => Number(a.no) - Number(b.no));
  entries.sort((a, b) => Number(a.no) - Number(b.no));
  corrections.sort((a, b) => Number(a.no) - Number(b.no));
  const banners = [];
  for (const img of index('img[src^="img/bnkohaku2013_"]').toArray()) { const output = await image(new URL(index(img).attr("src")!, base).href, id, "banners"); if (output) banners.push(output); }
  await writeJson(manifestPath, manifest);
  await writeJson(workPath, works);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, sourceEncoding: "shift_jis", liveSourceAvailable: true, entries, corrections, failures, contentRestrictions, note: "The leading star is the source submission-status mark, not part of the title. Main downloads and patches are preserved separately. Restricted content is represented by a complete neutral template.", desktopReview: "pending" });
  const festivals: Festival[] = JSON.parse(await fs.readFile("src/data/festivals.json", "utf8"));
  const festival = festivals.find((f) => f.id === id)!;
  festival.banners = banners;
  delete festival.hasDetail;
  await writeJson("src/data/festivals.json", festivals);
  const urls: Array<{ slug: string; url: string }> = JSON.parse((await fs.readFile("catch/festival-urls.json", "utf8")).replace(/^\uFEFF/, ""));
  urls.find((f) => f.slug === id)!.url = base;
  await writeJson("catch/festival-urls.json", urls);
  console.log(`Recovered ${works.length} catalogue entries; ${contentRestrictions.length} neutral templates; ${failures.length} resource gaps.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
