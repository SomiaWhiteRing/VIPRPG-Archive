import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { Festival, WorkEntry, WorkDownload } from "../src/lib/types";
import { imageExtension, writeJson } from "./recover-entry-table";

const id = "2012-gw", root = `catch/${id}`, cache = `${root}/source/recovery`, base = "http://viprpg2012gw.web.fc2.com/";
type Capture = { originalUrl: string; requestedUrl: string; actualUrl: string; contentType: string | null; retrievedAt: string };

async function main() {
  const manifestPath = `${cache}/manifest.json`;
  const manifest: Record<string, Capture> = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const index = cheerio.load(iconv.decode(await fs.readFile(`${root}/investigation/original-live.bin`), "shift_jis"));
  const hrefs = [...new Set(index("a[href]").toArray().map((a) => index(a).attr("href")!).filter((href) => /^en_\d+\.html$/.test(href)))];
  if (hrefs.length !== 60) throw new Error(`Unexpected source catalogue size: ${hrefs.length}`);
  const workPath = `src/data/works/${id}.json`, legacyPath = `${root}/legacy-works.json`;
  await fs.copyFile(workPath, legacyPath, fs.constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const current: WorkEntry[] = JSON.parse(await fs.readFile(workPath, "utf8")), baseline: WorkEntry[] = JSON.parse(await fs.readFile(legacyPath, "utf8"));
  const works: WorkEntry[] = [], entries = [], corrections = [], contentRestrictions = [], failures: Array<{ owner: string; sourceUrl: string; error: string }> = [];
  const previous: { failures?: Array<{ sourceUrl: string; error: string }> } = JSON.parse(await fs.readFile(`${root}/recovery.json`, "utf8").catch(() => "{}"));
  function plain(html: string) {
    const $ = cheerio.load(html);
    $("script,style").remove();
    $("*").contents().each((_, n) => { if (n.type === "text") n.data = n.data.replace(/[\r\n\t ]+/g, " "); });
    $("br").replaceWith("\n");
    return $.root().text().replace(/ +\n/g, "\n").replace(/\n +/g, "\n").trim();
  }
  function comment(html: string) {
    const $ = cheerio.load(html, {}, false);
    $("script,style,iframe,object,embed,form,input,button").remove();
    $("strong").first().filter((_, e) => ["コメント：", "管理人より："].includes($(e).text())).remove();
    for (const e of $("*").toArray()) {
      const node = $(e);
      if (/MS PGothic|ＭＳ Ｐゴシック|monospace/i.test(`${node.attr("style") || ""} ${node.attr("face") || ""}`)) node.addClass("AA");
      for (const a of Object.keys(e.attribs)) if (!["href", "class"].includes(a)) node.removeAttr(a);
      if (node.attr("href")) { const url = new URL(node.attr("href")!, base); if (/^https?:$/.test(url.protocol)) node.attr("href", url.href); else node.removeAttr("href"); }
    }
    return `<div class="source-comment">${($.root().html() || "").trim()}</div>`;
  }
  async function image(original: string, owner: string, kind: "icons" | "screenshots" | "banners") {
    const relative = new URL(original).pathname.slice(1), key = relative.replace(/[^\w.-]/g, "_"), file = `image-${key}.bin`;
    try {
      let bytes: Buffer;
      if (manifest[file]?.originalUrl === original) bytes = await fs.readFile(`${cache}/${file}`);
      else {
        if (!process.argv.includes("--fetch")) throw new Error(previous.failures?.find((f) => f.sourceUrl === original)?.error.replace(/^Error:\s*/, "") || `Missing cache: ${file}; use --fetch`);
        const response = await fetch(original, { signal: AbortSignal.timeout(25000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer());
        imageExtension(bytes);
        await fs.writeFile(`${cache}/${file}`, bytes);
        manifest[file] = { originalUrl: original, requestedUrl: original, actualUrl: response.url, contentType: response.headers.get("content-type"), retrievedAt: new Date().toISOString() };
      }
      const output = `/${kind}/${id}/${key.replace(/\.[^.]+$/, "")}.${imageExtension(bytes)}`;
      await fs.mkdir(path.dirname(`public${output}`), { recursive: true });
      const saved = await fs.readFile(`public${output}`).catch(() => undefined);
      if (!saved?.equals(bytes)) await fs.writeFile(`public${output}`, bytes);
      return output;
    } catch (error) { failures.push({ owner, sourceUrl: original, error: String(error) }); return undefined; }
  }
  for (let offset = 0; offset < hrefs.length; offset += 4) {
    await Promise.all(hrefs.slice(offset, offset + 4).map(async (href) => {
      const url = new URL(href, base).href, $ = cheerio.load(iconv.decode(await fs.readFile(`${cache}/${href}.bin`), "shift_jis")), table = $("table").first();
      const row = index(`a[href="${href}"]`).first().closest("tr").children("td"), no = row.first().text().trim();
      if (!/^\d+$/.test(no) || Number(no) !== Number(href.match(/(\d+)\.html$/)![1])) throw new Error(`Unexpected original entry number: ${no}`);
      const fields: Record<string, string> = {};
      for (const p of table.find("p").toArray()) {
        const text = plain($(p).html() || "");
        for (const [label, key] of [["タイトル：", "title"], ["作者名：", "author"], ["ツクール名：", "engine"], ["動画配信：", "streaming"]]) if (text.startsWith(label)) fields[key] = text.slice(label.length).trim();
      }
      if (!fields.title || !fields.author || !fields.engine) throw new Error(`Missing source metadata: ${no}`);
      const old = current.find((w) => Number(w.no) === Number(no));
      const title = old?.source?.titleUrl ? old.title : fields.title;
      const work: WorkEntry = { id: old?.id || `${id}-work-${no}`, festivalId: id, no, title, author: fields.author, engine: fields.engine, category: plain(index(row[3]).html() || "") };
      const icon = index(row[1]).find("img[src]").first().attr("src");
      const gallery = table.find("tr").first().find("img[src]").toArray().map((i) => new URL($(i).attr("src")!, url).href);
      if (no === "45") {
        work.contentRestricted = true;
        const resources = [...(icon ? [{ path: new URL(icon, base).pathname.slice(1), kind: "icon" }] : []), ...gallery.map((s) => ({ path: new URL(s).pathname.slice(1), kind: "screenshot" }))];
        const relatedUrls = [...table.find("a[href]").toArray().map((a) => $(a).attr("href")!.trim()), ...index(row).find("a[href]").toArray().map((a) => index(a).attr("href")!.trim())].filter((h) => h && new URL(h, base).href !== url).map((h) => new URL(h, base).href);
        contentRestrictions.push({ no, sourcePath: href, resources, relatedUrls: [...new Set(relatedUrls)], reason: "Sexualized young characters in source media; keep a complete neutral template and omit descriptions, original media and related links." });
      } else {
        work.streaming = fields.streaming;
        work.source = { url, ...(old?.source?.titleUrl ? { titleUrl: old.source.titleUrl } : {}) };
        if (title !== fields.title) work.originalTitle = fields.title;
        for (const p of table.find("p").toArray()) {
          const html = $(p).html() || "", text = plain(html);
          if (text.startsWith("コメント：")) work.authorComment = comment(html);
          if (text.startsWith("管理人より：")) work.hostComment = comment(html);
        }
        if (icon) work.icon = await image(new URL(icon, base).href, work.id, "icons");
        work.ss = [];
        for (const source of gallery) { const local = await image(source, work.id, "screenshots"); if (local) work.ss.push(local); }
        const downloads: WorkDownload[] = [];
        for (const a of table.find("a[href]").toArray()) {
          const href = $(a).attr("href")!.trim(), label = plain($(a).html() || "");
          if (!href) continue;
          if (label.includes("感想掲示板")) work.forum = new URL(href, url).href;
          else if (/ＤＬ|DL/.test(label)) downloads.push({ url: new URL(href, url).href, label });
        }
        for (const a of index(row[7]).find("a[href]").toArray()) {
          const href = index(a).attr("href")!.trim();
          if (href && !downloads.some((d) => d.url === new URL(href, base).href)) downloads.push({ url: new URL(href, base).href, label: `修正 ${plain(index(a).html() || "")}` });
        }
        if (downloads.length === 1) work.download = downloads[0];
        if (downloads.length > 1) work.downloads = downloads;
      }
      const before = baseline.find((w) => Number(w.no) === Number(no))?.title;
      if (before && before.replace(/\s/g, "") !== fields.title.replace(/\s/g, "")) corrections.push({ no, before, after: fields.title });
      works.push(work);
      entries.push({ no, id: work.id, status: work.contentRestricted ? "restricted-template" : "detail-recovered" });
    }));
    await writeJson(manifestPath, manifest);
    console.log(`Details ${Math.min(offset + 4, hrefs.length)}/${hrefs.length}`);
  }
  works.sort((a, b) => Number(a.no) - Number(b.no));
  entries.sort((a, b) => Number(a.no) - Number(b.no));
  corrections.sort((a, b) => Number(a.no) - Number(b.no));
  const banners = [];
  for (const img of index('img[src^="gw_bana"]').toArray()) { const local = await image(new URL(index(img).attr("src")!, base).href, id, "banners"); if (local) banners.push(local); }
  await writeJson(manifestPath, manifest);
  await writeJson(workPath, works);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, sourceEncoding: "shift_jis", liveSourceAvailable: true, entries, corrections, failures, contentRestrictions, note: "Index markers describe submission state: ◆ submitted, ▲ late submission, × not submitted. Historical main downloads and correction links are preserved separately.", desktopReview: "pending" });
  const festivals: Festival[] = JSON.parse(await fs.readFile("src/data/festivals.json", "utf8"));
  const festival = festivals.find((f) => f.id === id)!;
  festival.banners = banners;
  delete festival.hasDetail;
  await writeJson("src/data/festivals.json", festivals);
  console.log(`Recovered ${works.length} catalogue entries, ${contentRestrictions.length} neutral template; ${failures.length} resource gaps.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
