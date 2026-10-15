import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as cheerio from "cheerio";
import type { Festival, WorkEntry, WorkDownload } from "../src/lib/types";
import { imageExtension, writeJson } from "./recover-entry-table";

const id = "2014-tsukusure-festival", root = `catch/${id}`, cache = `${root}/source/recovery`;
const base = "http://www.geocities.jp/viprpg2014material/";
type Capture = { requestedUrl: string; actualUrl: string; contentType: string | null; originalUrl?: string; retrievedAt: string };
type Block = { page: string; index: number; category: string; title: string; rows: string[]; images: string[]; files: WorkDownload[] };

function plain(html: string) {
  const $ = cheerio.load(html);
  $("*").contents().each((_, node) => { if (node.type === "text") node.data = node.data.replace(/[ \t\r\n]+/g, " "); });
  $("br").replaceWith("\n");
  return $.root().text().replace(/ +\n/g, "\n").replace(/\n +/g, "\n").trim();
}
const normalize = (text: string) => text.normalize("NFKC").replace(/\s/g, "");

async function main() {
  await fs.mkdir(cache, { recursive: true });
  const manifestPath = `${cache}/manifest.json`;
  const manifest: Record<string, Capture> = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const inventory: string[][] = JSON.parse(await fs.readFile(`${root}/investigation/original-timemap.bin`, "utf8"));
  const menu = cheerio.load(await fs.readFile(`${root}/investigation/entry.bin`, "utf8"));
  const materialForum = menu("a[href]").filter((_, e) => menu(e).text().includes("素材作品用感想")).first().attr("href")!;
  const gameForum = menu("a[href]").filter((_, e) => menu(e).text().includes("ゲーム作品用感想")).first().attr("href")!;
  const pages = menu('a[href^="c_"]').toArray().map((a) => ({ page: menu(a).attr("href")!, category: menu(a).text().replace(/[【】]/g, "") }));
  const blocks: Block[] = [], resources = new Set<string>();
  for (const { page, category } of pages) {
    const $ = cheerio.load(await fs.readFile(`${cache}/${page}.bin`, "utf8"));
    for (const element of $("img[src],a[href],[background]").toArray()) {
      const ref = $(element).attr("src") || $(element).attr("href") || $(element).attr("background");
      if (ref) {
        const url = new URL(ref, new URL(page, base));
        if (url.href.startsWith(base) && /\.(png|jpe?g|gif|bmp|webp|ico|mp3|wav|ogg|mid|avi|ogv|txt|zip)$/i.test(url.pathname)) resources.add(url.href);
      }
    }
    for (const [index, table] of $("table").filter((_, e) => !$(e).parents("table").length).toArray().entries()) {
      const cells = $(table).find("tr").toArray().map((tr) => $(tr).children("td").first());
      const rows = cells.map((td) => plain(td.html() || ""));
      const images = $(table).find("img[src]").toArray().map((e) => new URL($(e).attr("src")!, new URL(page, base)).href);
      const files: WorkDownload[] = [];
      for (const a of $(table).find("a[href]").toArray()) {
        const url = new URL($(a).attr("href")!, new URL(page, base)).href;
        const detail = plain($(a).closest("tr").next("tr").children("td").first().html() || "");
        if (!files.some((file) => file.url === url)) files.push({ url, label: $(a).text().trim() || path.posix.basename(new URL(url).pathname), ...(detail.startsWith("対応：") ? { detail } : {}) });
      }
      for (const img of $(table).find("img[src]").toArray()) if (!$(img).closest("a[href]").length) {
        const url = new URL($(img).attr("src")!, new URL(page, base)).href;
        if (!files.some((file) => file.url === url)) files.push({ url, label: path.posix.basename(new URL(url).pathname) });
      }
      blocks.push({ page, index, category, title: rows[0], rows, images, files });
    }
  }
  if (blocks.length !== 91) throw new Error(`Unexpected classified entry count: ${blocks.length}`);
  const top = cheerio.load(await fs.readFile(`${root}/investigation/top.bin`, "utf8"));
  for (const e of top("img[src],[background]").toArray()) resources.add(new URL(top(e).attr("src") || top(e).attr("background")!, base).href);
  const failures: Array<{ originalUrl: string; error: string }> = [];
  function archived(original: string) {
    const row = inventory.slice(1).find((row) => new URL(row[0]).href === original);
    if (!row) throw new Error(`No successful source capture listed: ${original}`);
    return `https://web.archive.org/web/${row[2] || row[1]}id_/${row[0]}`;
  }
  const resourceList = [...resources];
  const concurrency = process.argv.includes("--serial") ? 1 : 3;
  for (let offset = 0; offset < resourceList.length; offset += concurrency) {
    await Promise.all(resourceList.slice(offset, offset + concurrency).map(async (original) => {
      const relative = new URL(original).pathname.slice(new URL(base).pathname.length);
      const file = `asset-${relative.replace(/[^\w.-]/g, "_")}.bin`;
      try {
        if (manifest[file]?.originalUrl === original) { await fs.access(`${cache}/${file}`); return; }
        if (!process.argv.includes("--fetch")) throw new Error("Source asset not cached; use --fetch");
        const requestedUrl = archived(original);
        const response = await fetch(requestedUrl, { signal: AbortSignal.timeout(40000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.url}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (/^\s*<(?:!doctype|html)\b/i.test(bytes.subarray(0, 256).toString("utf8"))) throw new Error("HTML returned instead of the source asset");
        if (/\.(png|jpe?g|gif|bmp|webp|ico)$/i.test(relative)) imageExtension(bytes);
        await fs.writeFile(`${cache}/${file}`, bytes);
        manifest[file] = { originalUrl: original, requestedUrl, actualUrl: response.url, contentType: response.headers.get("content-type"), retrievedAt: new Date().toISOString() };
      } catch (error) { failures.push({ originalUrl: original, error: `${String(error)} ${String((error as Error & { cause?: unknown }).cause ?? "")}`.trim() }); }
    }));
    await writeJson(manifestPath, manifest);
    if (offset % 30 === 0) console.log(`Assets checked: ${Math.min(offset + concurrency, resourceList.length)}/${resourceList.length}`);
  }
  await writeJson(`${root}/asset-review.json`, { resources: resourceList.length, failures, blocks: blocks.length });
  if (process.argv.includes("--assets-only")) return;
  const local = new Map<string, string>();
  for (const original of resourceList) {
    const relative = new URL(original).pathname.slice(new URL(base).pathname.length), file = `asset-${relative.replace(/[^\w.-]/g, "_")}.bin`;
    if (!manifest[file]) continue;
    const bytes = await fs.readFile(`${cache}/${file}`), isImage = /\.(png|jpe?g|gif|bmp|webp|ico)$/i.test(relative);
    const stem = relative.replace(/\.[^.]+$/, "").replace(/[^\w.-]/g, "_");
    const ext = isImage ? imageExtension(bytes) : path.posix.extname(relative).slice(1);
    const directory = relative === "mate/2014material.png" ? "banners" : isImage ? "screenshots" : "materials";
    const output = `/${directory}/${id}/${stem}.${ext}`;
    await fs.mkdir(path.dirname(`public${output}`), { recursive: true });
    const saved = await fs.readFile(`public${output}`).catch(() => undefined);
    if (!saved?.equals(bytes)) await fs.writeFile(`public${output}`, bytes);
    local.set(original, output);
  }
  const workPath = `src/data/works/${id}.json`;
  const previewPath = `${root}/audio-preview-review.json`;
  const previousPreviews: { entries?: Array<{ sourceUrl: string; sourceSha256: string; previewUrl: string }> } = JSON.parse(await fs.readFile(previewPath, "utf8").catch(() => "{}"));
  const previewMap = new Map<string, string>(), previewEntries = [];
  for (const [original, saved] of local) if (/\.wav$/i.test(saved)) {
    const bytes = await fs.readFile(`public${saved}`), offset = bytes.indexOf(Buffer.from("fmt "));
    if (offset < 0 || bytes.readUInt16LE(offset + 8) !== 2) continue;
    const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
    const previewUrl = `/materials/${id}/previews/${path.posix.basename(saved)}`;
    const previous = previousPreviews.entries?.find((entry) => entry.sourceUrl === original && entry.sourceSha256 === sourceSha256 && entry.previewUrl === previewUrl);
    if (!previous || !await fs.access(`public${previewUrl}`).then(() => true, () => false)) {
      await fs.mkdir(path.dirname(`public${previewUrl}`), { recursive: true });
      const result = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", `public${saved}`, "-c:a", "pcm_s16le", `public${previewUrl}`], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(`Audio preview conversion failed: ${result.stderr || result.error}`);
    }
    previewMap.set(original, previewUrl);
    previewEntries.push({ sourceUrl: original, originalUrl: saved, sourceSha256, previewUrl, sourceCodec: "MS ADPCM", previewCodec: "PCM signed 16-bit", originalPreserved: true });
  }
  await writeJson(previewPath, { entries: previewEntries });
  const legacyPath = `${root}/legacy-unverified-works.json`;
  if (!await fs.access(legacyPath).then(() => true, () => false)) await fs.copyFile(workPath, legacyPath);
  const legacy: WorkEntry[] = JSON.parse(await fs.readFile(legacyPath, "utf8"));
  const usedLegacy = new Set<string>(), works: WorkEntry[] = [], mappings = [];
  for (const block of blocks) {
    const game = block.page === "c_ksg.html";
    const old = game ? legacy.find((work) => normalize(work.title) === normalize(block.title)) : undefined;
    if (old) usedLegacy.add(old.id);
    const pageKey = block.page.replace(/^c_|\.html$/g, "");
    const work: WorkEntry = { id: old?.id || `${id}-${game ? "game" : "material"}-${pageKey}-${String(block.index + 1).padStart(2, "0")}`, festivalId: id, title: block.title, author: "", category: block.category };
    const value = (prefix: string) => block.rows.find((row) => row.startsWith(prefix))?.slice(prefix.length).trim();
    work.author = value("作者：") || value("作者名：") || "";
    const compatibility = block.rows.filter((row) => row.startsWith("対応：")).map((row) => row.slice(3).trim());
    work.engine = compatibility.length ? [...new Set(compatibility)].join(" / ") : block.rows.find((row) => row.startsWith("RPGツクール"));
    const escape = (text: string | undefined) => text?.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    work.authorComment = escape(value("作者コメント："));
    work.hostComment = escape(value("管理人から："));
    if (game && value("ジャンル：")) work.category = `${block.category} / ${value("ジャンル：")}`;
    if (!game) work.materialInfo = { archivePermission: value("VIPRPG素材保管@wikiでの保管："), externalUsePermission: value("VIPRPG外での使用："), notes: value("備考：") };
    work.ss = block.images.map((url) => local.get(url)).filter((url): url is string => Boolean(url));
    if (!work.ss.length) delete work.ss;
    work.downloads = block.files.map((file) => {
      const saved = local.get(file.url);
      return { ...file, url: saved || file.url, ...(saved ? { filename: path.posix.basename(new URL(file.url).pathname).replace(/\.[^.]+$/, path.posix.extname(saved)) } : {}), ...(previewMap.has(file.url) ? { previewUrl: previewMap.get(file.url) } : {}) };
    });
    if (!work.downloads.length) delete work.downloads;
    work.forum = game ? gameForum : materialForum;
    work.source = { url: new URL(block.page, base).href, snapshotUrl: manifest[`${block.page}.bin`].actualUrl.replace(/id_\//, "/"), ...(!work.author ? { authorOmitted: true } : {}) };
    works.push(work);
    mappings.push({ id: work.id, page: block.page, sourceTable: block.index, title: block.title, legacyId: old?.id });
  }
  const unresolvedLegacy = legacy.filter((work) => !usedLegacy.has(work.id));
  await writeJson(`${root}/legacy-reconciliation.json`, { officialTables: 91, materialTables: 83, gameTables: 8, distinctSourceTitles: new Set(blocks.map((b) => b.title)).size, matchedLegacyIds: [...usedLegacy], unresolvedLegacy, note: "The original site ended updates on 2014-11-01 with eight game entries. Unconfirmed old catalogue records remain preserved for research and are not asserted to belong to this festival." });
  await writeJson(workPath, works);
  const festivals: Festival[] = JSON.parse(await fs.readFile("src/data/festivals.json", "utf8"));
  const festival = festivals.find((f) => f.id === id)!;
  festival.columns = ["work", "type", "download", "forum"];
  const termsHeading = top("td").filter((_, e) => top(e).text().trim() === "素材の利用規約").first();
  festival.materialTerms = plain(termsHeading.parent("tr").next("tr").children("td").first().html() || "");
  if (!festival.materialTerms.includes("第三者による再配布")) throw new Error("Source material terms were not recovered");
  delete festival.hasDetail;
  const banner = local.get(new URL("./mate/2014material.png", base).href);
  festival.banners = banner ? [banner] : [];
  await writeJson("src/data/festivals.json", festivals);
  await writeJson(`${root}/recovery.json`, { festivalId: id, entries: mappings, failures, materialTables: 83, gameTables: 8, authorOmitted: works.filter((work) => !work.author).length, legacyEvidence: `${root}/legacy-reconciliation.json`, status: "awaiting-desktop-review" });
  console.log(`Recovered ${works.length} source tables; ${unresolvedLegacy.length} old records preserved as unverified; ${failures.length} asset gaps.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
