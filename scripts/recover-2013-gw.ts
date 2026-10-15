import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { Festival, WorkEntry } from "../src/lib/types";
import { imageExtension, writeJson } from "./recover-entry-table";

const id = "2013-gw", root = `catch/${id}`, cache = `${root}/source/recovery`;
const base = "http://viprpg2013gw.web.fc2.com/";
type Capture = { originalUrl: string; requestedUrl: string; actualUrl: string; contentType: string | null; retrievedAt: string; previousErrors?: Array<{ url: string; error: string }> };

async function main() {
  await fs.mkdir(cache, { recursive: true });
  const manifestPath = `${cache}/manifest.json`;
  const manifest: Record<string, Capture> = JSON.parse(await fs.readFile(manifestPath, "utf8").catch(() => "{}"));
  const inventory: string[][] = JSON.parse(await fs.readFile(`${root}/investigation/original-timemap.bin`, "utf8"));
  const index = cheerio.load(iconv.decode(await fs.readFile(`${root}/investigation/original-live.bin`), "shift_jis"));
  const hrefs = [...new Set(index("a[href]").toArray().map((a) => index(a).attr("href")!).filter((href) => /^rpg\/g\d+\.html$/.test(href)))];
  if (hrefs.length !== 66) throw new Error(`Unexpected source catalogue size: ${hrefs.length}`);
  const legacyPath = `${root}/legacy-works.json`, workPath = `src/data/works/${id}.json`;
  await fs.copyFile(workPath, legacyPath, fs.constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const oldWorks: WorkEntry[] = JSON.parse(await fs.readFile(workPath, "utf8"));
  const baseline: WorkEntry[] = JSON.parse(await fs.readFile(legacyPath, "utf8"));
  const works: WorkEntry[] = [], entries = [], corrections: Array<{ no: string; before: string; after: string }> = [];
  const failures: Array<{ owner: string; sourceUrl: string; error: string }> = [];
  const unavailablePreloads: Array<{ owner: string; requestedUrl: string; error: string }> = [];
  async function capture(originalUrl: string, filename: string) {
    if (manifest[filename]?.originalUrl === originalUrl) return { bytes: await fs.readFile(`${cache}/${filename}`), metadata: manifest[filename] };
    if (!process.argv.includes("--fetch")) throw new Error(`Missing source cache: ${filename}; use --fetch`);
    const row = inventory.slice(1).find((row) => new URL(row[0]).href === originalUrl);
    const previousErrors: Array<{ url: string; error: string }> = [];
    for (const url of [originalUrl, ...(row ? [`https://web.archive.org/web/${row[2] || row[1]}id_/${row[0]}`] : [])]) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (/\.html$/i.test(originalUrl)) {
          if (!cheerio.load(iconv.decode(bytes, "shift_jis"))("title").text().includes("No.")) throw new Error("Unexpected detail page");
        } else imageExtension(bytes);
        await fs.writeFile(`${cache}/${filename}`, bytes);
        manifest[filename] = { originalUrl, requestedUrl: url, actualUrl: response.url, contentType: response.headers.get("content-type"), retrievedAt: new Date().toISOString(), ...(previousErrors.length ? { previousErrors } : {}) };
        return { bytes, metadata: manifest[filename] };
      } catch (error) { previousErrors.push({ url, error: String(error) }); }
    }
    throw new Error(JSON.stringify(previousErrors));
  }
  async function image(original: string, owner: string, kind: "icons" | "screenshots" | "banners", optional = false) {
    const relative = new URL(original).pathname.slice(1), stem = relative.replace(/\.[^.]+$/, "").replace(/[^\w.-]/g, "_");
    try {
      const { bytes } = await capture(original, `image-${relative.replace(/[^\w.-]/g, "_")}.bin`);
      const local = `/${kind}/${id}/${stem}.${imageExtension(bytes)}`;
      await fs.mkdir(path.dirname(`public${local}`), { recursive: true });
      const saved = await fs.readFile(`public${local}`).catch(() => undefined);
      if (!saved?.equals(bytes)) await fs.writeFile(`public${local}`, bytes);
      return local;
    } catch (error) {
      if (optional) unavailablePreloads.push({ owner, requestedUrl: original, error: String(error) });
      else failures.push({ owner, sourceUrl: original, error: String(error) });
      return undefined;
    }
  }
  function plain(html: string) {
    const $ = cheerio.load(html);
    $("script,style").remove();
    $("*").contents().each((_, node) => { if (node.type === "text") node.data = node.data.replace(/[\t\r\n ]+/g, " "); });
    $("br").replaceWith("\n");
    return $.root().text().replace(/ +\n/g, "\n").replace(/\n +/g, "\n").trim();
  }
  function comment(html: string) {
    const $ = cheerio.load(html, {}, false);
    $("script,style,iframe,object,embed,form,input,button").remove();
    for (const e of $("*").toArray()) {
      if (!["br", "b", "strong", "i", "u", "p", "h2", "h4", "font"].includes(e.name)) { $(e).replaceWith($(e).html() ?? ""); continue; }
      for (const attr of Object.keys(e.attribs)) $(e).removeAttr(attr);
    }
    return `<div class="source-comment">${($.root().html() ?? "").trim()}</div>`;
  }
  for (let offset = 0; offset < hrefs.length; offset += 4) {
    await Promise.all(hrefs.slice(offset, offset + 4).map(async (href) => {
      const no = href.match(/g(\d+)\.html$/)![1], url = new URL(href, base).href;
      const existing = oldWorks.find((work) => Number(work.no) === Number(no));
      try {
        const result = await capture(url, `${href.replace("/", "_")}.bin`);
        const $ = cheerio.load(iconv.decode(result.bytes, "shift_jis")), header = $("table").first(), table = $("table").eq(1);
        if (plain(header.find("td").first().html() || "") !== `No.${no}`) throw new Error("Unexpected source identity");
        const pageTitle = plain(header.find("td").last().html() || "");
        const title = existing?.source?.titleUrl ? existing.title : pageTitle;
        const oldTitle = baseline.find((work) => Number(work.no) === Number(no))?.title;
        if (oldTitle && oldTitle.replace(/\s/g, "") !== pageTitle.replace(/\s/g, "")) corrections.push({ no, before: oldTitle, after: pageTitle });
        const work: WorkEntry = { id: existing?.id || `${id}-work-${no}`, festivalId: id, no, title, author: "", source: { url, ...(result.metadata.actualUrl.includes("web.archive.org/web/") ? { snapshotUrl: result.metadata.actualUrl.replace(/id_\//, "/") } : {}), ...(existing?.source?.titleUrl ? { titleUrl: existing.source.titleUrl } : {}) } };
        if (title !== pageTitle) work.originalTitle = pageTitle;
        for (const row of table.find("tr").toArray()) {
          const cells = $(row).children("td"), label = plain(cells.first().html() || "");
          const field = ({ 作者: "author", ジャンル: "category", ツクール: "engine", "配信／投稿": "streaming" } as const)[label as "作者" | "ジャンル" | "ツクール" | "配信／投稿"];
          if (field && cells.length === 2) work[field] = plain(cells.last().html() || "");
          if (["作者コメント", "管理人コメント"].includes(label)) {
            const html = $(row).next("tr").children("td").html() || "";
            work[label === "作者コメント" ? "authorComment" : "hostComment"] = comment(html);
          }
        }
        for (const a of table.find("a[href]").toArray()) {
          const label = plain($(a).html() || "");
          if (label.includes("感想掲示板")) work.forum = new URL($(a).attr("href")!, url).href;
          else if (/提出|ダウンロード/.test(label)) work.download = { url: new URL($(a).attr("href")!, url).href, label };
        }
        const updated = plain(table.html() || "").match(/最終更新：\s*(\d{2}\/\d{2}|----)/);
        if (updated) work.updates = updated[0];
        const icon = header.find("img[src]").first().attr("src");
        if (icon) work.icon = await image(new URL(icon, url).href, work.id, "icons");
        const refs = table.find("tr").first().find("img[src]").toArray().map((e) => $(e).attr("src")!);
        for (const img of table.find("img").toArray()) for (const attr of ["onmouseover", "onmouseout"]) for (const m of $(img).attr(attr)?.matchAll(/this\.src\s*=\s*["']([^"']+)["']/g) ?? []) refs.push(m[1]);
        const displayed = [...new Set(refs.map((ref) => new URL(ref, url).href))], screenshots: string[] = [];
        for (const original of displayed) { const local = await image(original, work.id, "screenshots"); if (local) screenshots.push(local); }
        work.ss = screenshots;
        const additionalPreloads = [];
        for (const script of $("script").toArray()) for (const m of $(script).text().matchAll(/["']([^"']+\.(?:png|gif|jpe?g|bmp))["']/gi)) {
          const original = new URL(m[1], url).href;
          if (!original.startsWith(base) || displayed.includes(original)) continue;
          const local = await image(original, work.id, "screenshots", true);
          if (local) additionalPreloads.push({ sourceUrl: original, asset: local });
        }
        works.push(work);
        entries.push({ id: work.id, no, sourceUrl: url, screenshotsLinked: displayed.length, screenshotsRecovered: screenshots.length, additionalPreloads });
      } catch (error) { failures.push({ owner: existing?.id || no, sourceUrl: url, error: String(error) }); }
    }));
    await writeJson(manifestPath, manifest);
    console.log(`Details ${Math.min(offset + 4, hrefs.length)}/${hrefs.length}`);
  }
  works.sort((a, b) => Number(a.no) - Number(b.no));
  entries.sort((a, b) => Number(a.no) - Number(b.no));
  if (works.length !== 66) throw new Error(`Only ${works.length}/66 entries parsed; existing catalogue preserved`);
  const banners = [];
  for (const img of index('img[src^="2013GW"]').toArray()) { const local = await image(new URL(index(img).attr("src")!, base).href, id, "banners"); if (local) banners.push(local); }
  await writeJson(manifestPath, manifest);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, sourceEncoding: "shift_jis", liveSourceAvailable: true, entries, corrections, failures, unavailablePreloads, contentReview: `${root}/content-review.json`, note: "Live original URLs are requested first; exact known archive captures are fallbacks. Historical download links are preserved without claiming availability.", desktopReview: "pending" });
  await writeJson(workPath, works);
  const festivals: Festival[] = JSON.parse(await fs.readFile("src/data/festivals.json", "utf8"));
  const festival = festivals.find((f) => f.id === id)!;
  festival.banners = banners;
  delete festival.hasDetail;
  await writeJson("src/data/festivals.json", festivals);
  const urls: Array<{ slug: string; url: string }> = JSON.parse((await fs.readFile("catch/festival-urls.json", "utf8")).replace(/^\uFEFF/, ""));
  urls.find((f) => f.slug === id)!.url = new URL("index.html", base).href;
  await writeJson("catch/festival-urls.json", urls);
  console.log(`Recovered ${works.length} entries, ${banners.length} banners; ${failures.length} resource gaps.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
