import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import ts from "typescript";
import type { Festival, WorkEntry, WorkDownload } from "../src/lib/types";
import { imageExtension, writeJson } from "./recover-entry-table";

const id = "2011-denpa-game-festival", root = `catch/${id}`, cache = `${root}/source/recovery`, base = "http://cryptic2011.web.fc2.com/";
type Capture = { originalUrl: string; requestedUrl: string; actualUrl: string; file: string; contentType: string | null; retrievedAt: string; proxyRegion: string };

async function main() {
  const manifest: Record<string, Capture> = JSON.parse(await fs.readFile(`${cache}/manifest.json`, "utf8"));
  const menu = cheerio.load(iconv.decode(await fs.readFile(`${cache}/${manifest["menu.html"].file}`), "shift_jis"));
  const links = menu('a[href]').toArray().filter((a) => /^page\/page\d+\.html$/.test(menu(a).attr("href") || ""));
  if (links.length !== 43) throw new Error(`Unexpected source catalogue count: ${links.length}`);
  const menuMetadata = new Map<string, { title?: string; marker?: string }>();
  for (const script of menu("script").toArray()) {
    const ast = ts.createSourceFile("menu.js", menu(script).html() || "", ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function visit(node: ts.Node) {
      if (ts.isIfStatement(node) && ts.isBinaryExpression(node.expression) && node.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken && node.expression.left.getText(ast) === "data" && ts.isStringLiteral(node.expression.right) && /^\d+$/.test(node.expression.right.text)) {
        const metadata: { title?: string; marker?: string } = {}; let target = "";
        function readLiteral(child: ts.Node) {
          if (ts.isCallExpression(child) && child.expression.getText(ast) === "document.getElementById" && child.arguments[0] && ts.isStringLiteral(child.arguments[0])) target = child.arguments[0].text;
          if (ts.isBinaryExpression(child) && child.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(child.left) && child.left.name.text === "innerHTML" && ts.isStringLiteral(child.right)) {
            if (target === "titleword") metadata.title = child.right.text;
            if (target === "submit") metadata.marker = child.right.text;
          }
          ts.forEachChild(child, readLiteral);
        }
        readLiteral(node.thenStatement); menuMetadata.set(node.expression.right.text, metadata);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  if (menuMetadata.size !== 43) throw new Error(`Unexpected menu metadata count: ${menuMetadata.size}`);
  const workFile = `src/data/works/${id}.json`, legacyFile = `${root}/legacy-works.json`;
  await fs.copyFile(workFile, legacyFile, fs.constants.COPYFILE_EXCL).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
  const legacy: WorkEntry[] = JSON.parse(await fs.readFile(legacyFile, "utf8"));
  const previous = JSON.parse(await fs.readFile(`${root}/recovery.json`, "utf8").catch(() => "{}"));
  const failures: Array<{ sourceUrl: string; error: string }> = [], works: WorkEntry[] = [], entries = [], titleDifferences = [];
  function plain(html: string) { const $ = cheerio.load(html, {}, false); $("br").replaceWith("\n"); return $.root().text().trim(); }
  async function image(url: string, kind: "icons" | "screenshots" | "banners") {
    const key = `asset-${new URL(url).pathname.replace(/[^\w.-]/g, "_")}.bin`;
    try {
      let bytes: Buffer;
      if (manifest[key]) bytes = await fs.readFile(`${cache}/${manifest[key].file}`);
      else {
        if (!process.argv.includes("--fetch")) throw new Error(previous.failures?.find((f: { sourceUrl: string }) => f.sourceUrl === url)?.error || "Missing cached source asset; use --fetch through Japan");
        const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer()); imageExtension(bytes);
        await fs.writeFile(`${cache}/${key}`, bytes);
        manifest[key] = { originalUrl: url, requestedUrl: url, actualUrl: response.url, file: key, contentType: response.headers.get("content-type"), retrievedAt: new Date().toISOString(), proxyRegion: "Japan" };
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
      if (/MS PGothic|ＭＳ|monospace/i.test(`${node.attr("style") || ""} ${node.attr("face") || ""}`)) node.addClass("AA");
      for (const attr of Object.keys(e.attribs)) if (!["href", "src", "class"].includes(attr)) node.removeAttr(attr);
      if (href) { const url = new URL(href, owner); if (/^https?:$/.test(url.protocol)) node.attr("href", url.href); else node.removeAttr("href"); }
      if (src) { const local = await image(new URL(src, owner).href, "screenshots"); if (local) node.attr("src", local); else node.remove(); }
    }
    return `<div class="source-comment">${($.root().html() || "").trim()}</div>`;
  }
  for (const [order, a] of links.entries()) {
    const sourcePath = menu(a).attr("href")!, no = sourcePath.match(/page(\d+)\.html$/)![1], capture = manifest[sourcePath];
    if (!capture) throw new Error(`Missing source page ${sourcePath}`);
    const url = new URL(sourcePath, base).href, $ = cheerio.load(iconv.decode(await fs.readFile(`${cache}/${capture.file}`), "shift_jis")), table = $("table").first();
    const title = $("title").text().trim(), fields = new Map<string, string>();
    for (const td of table.find("td").toArray()) {
      const label = $(td).find("b").first().text().trim();
      if (!["Author:", "Tool:", "Message:"].includes(label)) continue;
      const copy = $(td).clone(); copy.find("b").first().remove(); fields.set(label, copy.html() || "");
    }
    if (!title || !fields.has("Author:") || !fields.has("Tool:") || !fields.has("Message:")) throw new Error(`Missing source fields ${sourcePath}`);
    const old = legacy.find((w) => Number(w.no) === Number(no)), author = plain(fields.get("Author:")!), metadata = menuMetadata.get(no);
    if (!metadata?.title) throw new Error(`Missing menu title ${no}`);
    const work: WorkEntry = { id: old?.id || `${id}-work-${no.padStart(3, "0")}`, festivalId: id, no, title: old?.source?.titleUrl ? old.title : metadata.title, author, engine: plain(fields.get("Tool:")!), source: { url, ...(author ? {} : { authorOmitted: true }), ...(old?.source?.titleUrl ? { titleUrl: old.source.titleUrl } : metadata.title !== title ? { titleUrl: `${base}menu.html` } : {}) } };
    if (work.title !== title) work.originalTitle = title;
    if (old && old.title !== title) titleDifferences.push({ no, previousTitle: old.title, sourceTitle: title, menuTitle: metadata.title, keptTitle: work.title, evidence: `${base}menu.html` });
    const icon = menu(a).find("img[src]").first().attr("src"); if (icon) work.icon = await image(new URL(icon, base).href, "icons");
    work.authorComment = await comment(fields.get("Message:")!, url);
    const gallery = table.find("tr").eq(1).find("img[src]").toArray().map((img) => new URL($(img).attr("src")!, url).href);
    work.ss = []; for (const source of gallery) { const local = await image(source, "screenshots"); if (local) work.ss.push(local); }
    const downloads: WorkDownload[] = [];
    const downloadCell = table.find("td").filter((_, td) => $(td).find("b").first().text().trim() === "Download:").first();
    const extra = downloadCell.clone(); extra.find("b").first().remove(); extra.find("a").remove(); const detail = plain(extra.html() || "");
    downloadCell.find("a[href]").each((_, link) => { const href = $(link).attr("href")!, label = $(link).text().trim(); if (!href || href.startsWith("#") || /^javascript:/i.test(href)) return; if (label === "Feel-BBS") work.forum = new URL(href, url).href; else downloads.push({ url: new URL(href, url).href, label: label || "Download", ...(detail ? { detail } : {}) }); });
    if (downloads.length === 1) work.download = downloads[0]; else if (downloads.length > 1) work.downloads = downloads;
    works.push(work); entries.push({ no, sourcePath, sourceUrl: url, sourceOrder: order, menuTitle: metadata.title, menuMarker: metadata.marker, menuHover: menu(a).find("img").attr("onmouseover"), galleryUrls: gallery, downloadLinks: downloads.length, status: "detail-recovered", ...(no === "0" ? { numberFromSourceFilename: true, menuNumberNotDisplayed: true } : {}) });
  }
  works.sort((a, b) => Number(a.no) - Number(b.no));
  const top = cheerio.load(iconv.decode(await fs.readFile(`${cache}/${manifest["top.html"].file}`), "shift_jis")), banners: string[] = [];
  for (const img of top('img[src^="banner/"]').toArray()) { const local = await image(new URL(top(img).attr("src")!, base).href, "banners"); if (local) banners.push(local); }
  await writeJson(workFile, works); await writeJson(`${cache}/manifest.json`, manifest);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, sourceEncoding: "shift_jis", liveSourceAvailable: true, entries, titleDifferences, contentRestrictions: [], failures, note: "Save source records directly without content screening. No.0 is an actual linked page with its own title and message; its number follows the source filename because the menu does not display a number. No per-entry genre, streaming policy or host comment is supplied. The source menu's two-dimensional grid and hover metadata remain in the original view. Download URLs are historical entries, not verified available files.", desktopReview: "pending" });
  const festivals: Festival[] = JSON.parse(await fs.readFile("src/data/festivals.json", "utf8")), festival = festivals.find((f) => f.id === id)!;
  festival.banners = banners; festival.columns = ["no", "icon", "work", "type", "download", "forum"]; delete festival.hasDetail;
  await writeJson("src/data/festivals.json", festivals);
  console.log(`${works.length} details; ${works.reduce((n,w)=>n+(w.ss?.length || 0),0)} screenshots; ${failures.length} resource gaps.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
