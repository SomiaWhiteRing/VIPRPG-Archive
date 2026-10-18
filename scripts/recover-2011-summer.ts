import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { Festival, WorkEntry, WorkDownload } from "../src/lib/types";
import { imageExtension, writeJson } from "./recover-entry-table";

const id = "2011-summer", root = `catch/${id}`, cache = `${root}/source/original`, base = "http://www.geocities.jp/viprpg_summer11/";
type Capture = { originalUrl: string; actualUrl: string; file: string };

async function main() {
  const manifest: Record<string, Capture> = JSON.parse(await fs.readFile(`${cache}/manifest.json`, "utf8"));
  const index = cheerio.load(iconv.decode(await fs.readFile(`${root}/investigation/original-index.bin`), "euc-jp"));
  const mirror = cheerio.load(iconv.decode(await fs.readFile(`${root}/investigation/mirror-latest-index.bin`), "euc-jp"));
  const earlier = cheerio.load(iconv.decode(await fs.readFile(`${root}/investigation/original-index-20110810113102.bin`), "euc-jp"));
  const subjects: { subjects: Array<{ title: string; url: string }> } = JSON.parse(await fs.readFile(`${root}/investigation/official-subject-title-review.json`, "utf8"));
  const corrections: Array<{ no: string; previousTitle: string; primaryCatalogueTitle: string; officialUrl: string; correctionConfirmed: boolean }> = JSON.parse(await fs.readFile(`${root}/investigation/established-title-review.json`, "utf8"));
  const indexCapture = JSON.parse(await fs.readFile(`${root}/investigation/original-index.json`, "utf8"));
  const earlierCapture = JSON.parse(await fs.readFile(`${root}/investigation/original-index-20110810113102.json`, "utf8"));
  const sharedMap: { sourceCatalogue: string; sourceDetail: string; members: Array<{ no: string; column: number; title: string; sourcePath: string; catalogueSourcePath: string }> } = JSON.parse(await fs.readFile(`${root}/investigation/shared-introduction-map.json`, "utf8"));
  const group = cheerio.load(iconv.decode(await fs.readFile(`${cache}/${manifest[sharedMap.sourceCatalogue].file}`), "euc-jp"));
  const late = cheerio.load(iconv.decode(await fs.readFile(`${cache}/${manifest['sub/chikokunojin.htm'].file}`), "euc-jp"));
  const backup: { sourceUrl: string; files: Array<{ name: string }> } = JSON.parse(await fs.readFile(`${root}/investigation/public-backup-listing.json`, "utf8"));
  const anchors = index('a[href]').toArray().filter((a) => /^entry\/entry\d+\.htm$/.test(index(a).attr("href") || ""));
  if (anchors.length !== 108) throw new Error(`Unexpected source catalogue: ${anchors.length}`);
  const workFile = `src/data/works/${id}.json`, legacyFile = `${root}/legacy-works.json`;
  const current: WorkEntry[] = JSON.parse(await fs.readFile(workFile, "utf8"));
  await fs.copyFile(workFile, legacyFile, fs.constants.COPYFILE_EXCL).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
  const legacy: WorkEntry[] = JSON.parse(await fs.readFile(legacyFile, "utf8"));
  const fetchedAssets: Array<{ sourceUrl: string; error?: string }> = JSON.parse(await fs.readFile(`${root}/investigation/original-asset-fetch.json`, "utf8"));
  const detailFetch: Array<{ sourcePath: string; error?: string }> = JSON.parse(await fs.readFile(`${root}/investigation/original-detail-fetch.json`, "utf8"));
  const works: WorkEntry[] = [], entries = [], titleDifferences = [], sourceDetailGaps = [], failures: Array<{ sourceUrl: string; error: string }> = [];
  async function image(url: string, kind: "icons" | "screenshots" | "banners") {
    const capture = Object.values(manifest).find((m) => m.originalUrl === url);
    if (!capture) { if (!failures.some((f) => f.sourceUrl === url)) failures.push({ sourceUrl: url, error: fetchedAssets.find((f) => f.sourceUrl === url)?.error || "Missing source cache" }); return undefined; }
    const bytes = await fs.readFile(`${cache}/${capture.file}`), local = `/${kind}/${id}/${path.posix.basename(new URL(url).pathname).replace(/\.[^.]+$/, "")}.${imageExtension(bytes)}`;
    await fs.mkdir(path.dirname(`public${local}`), { recursive: true });
    if (!(await fs.readFile(`public${local}`).catch(() => undefined))?.equals(bytes)) await fs.writeFile(`public${local}`, bytes);
    return local;
  }
  async function comment(html: string, owner: string) {
    const $ = cheerio.load(html, {}, false); $("script,style,iframe,object,embed,form,input,button").remove();
    for (const e of $("*").toArray()) {
      const node = $(e), href = node.attr("href"), src = node.attr("src");
      for (const attr of Object.keys(e.attribs)) if (!["href", "src", "class", "colspan", "rowspan"].includes(attr)) node.removeAttr(attr);
      if (e.tagName === "pre") node.attr("style", "max-width:100%;overflow-x:auto");
      if (href) { const u = new URL(href, owner); if (/^https?:$/.test(u.protocol)) node.attr("href", u.href); else node.removeAttr("href"); }
      if (src) { const local = await image(new URL(src, owner).href, "screenshots"); if (local) node.attr("src", local); else node.replaceWith("［原資料の画像は未取得です］"); }
    }
    return `<div class="source-comment">${($.root().html() || "").trim()}</div>`;
  }
  for (const a of anchors) {
    const catalogueSourcePath = index(a).attr("href")!, no = catalogueSourcePath.match(/entry(\d+)\.htm$/)![1], shared = sharedMap.members.find((m) => m.no === no);
    const sourcePath = shared?.sourcePath || catalogueSourcePath, sourceUrl = new URL(sourcePath, base).href;
    const groupRow = group('table').first().children('tbody').children('tr').filter((_, tr) => group(tr).children().eq(1).text().trim() === no).first().children();
    const useGroup = Boolean(shared && no !== "60"), row = useGroup ? groupRow : index(a).closest("tr").children(), rowAPI = useGroup ? group : index;
    const old = legacy.find((w) => Number(w.no) === Number(no)), listTitle = index(a).text().trim() || groupRow.eq(2).find('a').text().trim();
    const subject = subjects.subjects.find((s) => Number(s.title.match(/^No[.．]?\s*(\d+)/)?.[1]) === Number(no));
    const subjectTitle = subject?.title.replace(/^No[.．]?\s*\d+\s*/, "").replace(/\(\d+\)$/, "").trim();
    const saved = current.find((w) => Number(w.no) === Number(no)), keepConfirmedTitle = Boolean(saved?.source?.titleUrl && saved.title === subjectTitle);
    const earlierAnchor = earlier('a[href]').filter((_, l) => earlier(l).attr("href") === catalogueSourcePath).first(), earlierTitle = earlierAnchor.text().trim();
    const correction = corrections.find((c) => Number(c.no) === Number(no) && c.previousTitle === old?.title && c.primaryCatalogueTitle === listTitle && c.correctionConfirmed);
    if (old && old.title !== listTitle && !correction) throw new Error(`Established title differs from official catalogue: ${no}`);
    const work: WorkEntry = { id: old?.id || `${id}-work-${no.padStart(3, "0")}`, festivalId: id, no, title: listTitle || subjectTitle || earlierTitle || `No.${no}（題名未取得）`, author: row.eq(3).text().trim() || "—", source: { url: sourceUrl } };
    if (keepConfirmedTitle) { work.title = saved!.title; work.source!.titleUrl = subject!.url; }
    const category = row.eq(4).text().trim(), engine = row.eq(5).text().trim(); if (category) work.category = category; if (engine) work.engine = engine;
    if (!row.eq(3).text().trim()) work.source!.authorOmitted = true;
    if (!listTitle && subject) work.source!.titleUrl = subject.url;
    if (correction) work.source!.titleUrl = correction.officialUrl;
    if (!listTitle && earlierTitle && earlierTitle === work.title) {
      const earlierRow = earlierAnchor.closest("tr").children();
      work.author = earlierRow.eq(3).text().trim() || "—"; work.source!.authorOmitted = work.author === "—";
      const oldCategory = earlierRow.eq(4).text().trim(), oldEngine = earlierRow.eq(5).text().trim(); if (oldCategory) work.category = oldCategory; if (oldEngine) work.engine = oldEngine;
    }
    const rowOwner = useGroup ? `${base}${sharedMap.sourceCatalogue}` : base;
    const icon = row.eq(0).find("img[src]").attr("src"); if (icon) work.icon = await image(new URL(icon, rowOwner).href, "icons");
    const downloads: WorkDownload[] = [];
    const addDownloads = (links: Array<{ href: string; text: string }>, owner: string, prefix = "") => {
      for (const link of links) {
        if (link.href.startsWith("#")) continue; const url = new URL(link.href, owner);
        if (!/^https?:$/.test(url.protocol)) continue;
        const local = url.href.startsWith(base) && /\.zip$/i.test(url.pathname) && Object.values(manifest).some((m) => m.originalUrl === url.href) ? `/original-pages/${id}/${url.pathname.slice(new URL(base).pathname.length)}` : undefined;
        const value = local || url.href;
        if (!downloads.some((d) => d.url === value)) downloads.push({ url: value, label: `${local ? "保存済み：" : ""}${prefix}${link.text}`, ...(local ? { filename: path.posix.basename(url.pathname), detail: "原ページ掲載の配布ファイル。ZIPの内容は未検査です。" } : {}) });
      }
    };
    addDownloads(row.eq(7).find('a[href]').toArray().map((l) => ({ href: rowAPI(l).attr("href")!, text: rowAPI(l).text().trim() })), rowOwner);
    if (shared && !useGroup) addDownloads(groupRow.eq(7).find('a[href]').toArray().map((l) => ({ href: group(l).attr('href')!, text: group(l).text().trim() })), `${base}${sharedMap.sourceCatalogue}`, "60の陣：");
    const lateRow = late('a[href]').filter((_, l) => late(l).attr('href') === `../${catalogueSourcePath}`).first().closest('tr').children();
    addDownloads(lateRow.eq(7).find('a[href]').toArray().map((l) => ({ href: late(l).attr('href')!, text: late(l).text().trim() })), `${base}sub/chikokunojin.htm`, "遅刻の陣：");
    const mirrorRow = mirror('a[href]').filter((_, l) => mirror(l).attr("href") === catalogueSourcePath).first().closest("tr").children();
    addDownloads(mirrorRow.eq(7).find('a[href]').toArray().map((l) => ({ href: mirror(l).attr("href")!, text: mirror(l).text().trim() })), "https://vipkohaku.x.fc2.com/2011s/", "代理保管庫：");
    const backupFiles = backup.files.filter((f) => Number(f.name.match(/^2011summer_no(\d+)/)?.[1]) === Number(no));
    if (backupFiles.length) downloads.push({ url: backup.sourceUrl, label: "公開保管庫", detail: backupFiles.map((f) => f.name).join("\n") });
    if (downloads.length === 1) work.download = downloads[0]; else if (downloads.length) work.downloads = downloads;
    const forum = row.eq(8).find('a[href]').first().attr("href"); if (forum) work.forum = new URL(forum, base).href;
    const updateNotes: string[] = [], catalogueUpdate = row.eq(7).text().trim(); if (catalogueUpdate && no !== "0") updateNotes.push(`作品一覧の配布・更新欄：${catalogueUpdate}`);
    const capture = manifest[sourcePath];
    let gallerySources: string[] = [];
    if (capture) {
      const $ = cheerio.load(iconv.decode(await fs.readFile(`${cache}/${capture.file}`), "euc-jp")), rows = $("table").first().children("tbody").children("tr");
      if (rows.length !== 9) throw new Error(`Unexpected source rows ${sourcePath}`);
      const value = (n: number, label: string) => { const cell = rows.eq(n).children().filter((_, e) => $(e).text().trim().startsWith(label)).first(), value = shared && n !== 8 ? rows.eq(n).children().eq(shared.column + 1) : cell.next(); if (!cell.length || !value.length) throw new Error(`Unexpected field ${sourcePath}/${label}`); return value; };
      const title = (shared ? rows.eq(0).children().eq(shared.column).text() : $("h2").first().text()).trim().replace(/^No\.\d+\s*/, "").trim();
      const alternativeTitle = title !== work.title ? title : listTitle !== work.title ? listTitle : undefined;
      if (alternativeTitle) { work.originalTitle = alternativeTitle; work.source!.titleUrl = keepConfirmedTitle ? subject!.url : useGroup ? `${base}${sharedMap.sourceCatalogue}` : subject?.url || `${base}index.htm#1`; titleDifferences.push({ no, keptTitle: work.title, originalTitle: alternativeTitle, sourceCatalogueTitle: listTitle, sourceHeadingTitle: title, evidence: work.source!.titleUrl, sample: no === "0" }); }
      work.author = value(2, "作者名").text().trim(); work.category = value(3, "ジャンル").text().trim(); work.engine = value(4, "使用ツクール").text().trim();
      const streaming = value(5, "動画投稿・配信").text().trim(); if (streaming) work.streaming = streaming;
      work.authorComment = await comment(value(6, "コメント").html() || "", sourceUrl);
      work.hostComment = await comment(value(8, "管理人").html() || "", sourceUrl);
      work.source!.snapshotUrl = capture.actualUrl;
      const galleryUrls = new Set<string>();
      for (const img of (shared ? rows.eq(1).children().eq(shared.column) : rows.eq(1)).find('img[src]').toArray()) {
        galleryUrls.add(new URL($(img).attr("src")!, sourceUrl).href);
        for (const attr of ["onmouseover", "onmouseout"]) for (const match of ($(img).attr(attr) || "").matchAll(/this\.src\s*=\s*['"]([^'"]+)['"]/g)) galleryUrls.add(new URL(match[1], sourceUrl).href);
      }
      gallerySources = [...galleryUrls];
      const gallery: string[] = []; for (const url of gallerySources) { const local = await image(url, "screenshots"); if (local && !gallery.includes(local)) gallery.push(local); }
      if (gallery.length) work.ss = gallery;
      if (gallery.length < gallerySources.length) updateNotes.push("編纂注：原資料のスクリーンショットの一部は未取得です。保存できた画像のみ表示しています。");
      if (shared) updateNotes.push(`編纂注：「60の陣」の番号対応に基づき、共用紹介ページの第${shared.column + 1}列を収録しています。管理人コメントは共通欄です。`);
      if (shared && keepConfirmedTitle && listTitle !== work.title) updateNotes.push(`編纂注：公式感想スレッドでは「${work.title}」、原サイトの「60の陣」一覧では「${listTitle}」と記載されています。題名の相違と各出典をそのまま記録しています。`);
    } else {
      if (![62, 67, 76, 80, 81].includes(Number(no))) throw new Error(`Unexpected missing introduction ${no}`);
      work.source = { ...work.source!, url: `${base}index.htm#1`, snapshotUrl: !listTitle && earlierTitle === work.title ? earlierCapture.actualUrl : indexCapture.actualUrl };
      updateNotes.push("編纂注：原紹介ページとスクリーンショットは未取得です。作者・ジャンル・ツール・配布先は祭典の作品一覧に基づきます。");
      if (!listTitle && earlierTitle === work.title) updateNotes.push("編纂注：後年の作品一覧はこの行が空欄のため、2011年8月10日の一覧記録を参照しています。");
      if (no === "81") updateNotes.push("編纂注：題名・作者は未取得です。原一覧の掲示板リンクは No.80 と同じスレッドを指しています。");
      sourceDetailGaps.push({ no, sourcePath, sourceUrl, error: detailFetch.find((f) => f.sourcePath === sourcePath)?.error || "No source cache", evidence: [`${root}/investigation/original-detail-fetch.json`, `${root}/investigation/original-site-cdx.bin`, `${root}/investigation/detail-fetch.json`] });
    }
    if (updateNotes.length) work.updates = updateNotes.join("\n\n");
    works.push(work); entries.push({ no, id: work.id, sourcePath, sourceUrl, catalogueSourcePath, listTitle, gallerySources, ...(shared ? { sharedColumn: shared.column, sharedCatalogueEvidence: `${base}${sharedMap.sourceCatalogue}` } : {}), ...(subject ? { officialTitleEvidence: subject.url } : {}), ...(!listTitle && earlierTitle === work.title ? { earlierCatalogueEvidence: earlierCapture.actualUrl } : {}), status: capture ? "detail-recovered" : "catalogue-recovered-detail-unavailable" });
  }
  const banners: string[] = [];
  for (const img of index('img[src]').toArray().filter((i) => /natunozin_11bana/.test(index(i).attr("src") || ""))) { const local = await image(new URL(index(img).attr("src")!, base).href, "banners"); if (local && !banners.includes(local)) banners.push(local); }
  await writeJson(workFile, works);
  const catalogueSlotRepairs = sharedMap.members.filter((m) => m.no !== "60").map((m) => ({ no: m.no, sourcePath: m.catalogueSourcePath, sharedSourcePath: m.sourcePath, column: m.column, sourceCatalogueTitle: m.title }));
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, sourceEncoding: "euc-jp", liveSourceAvailable: false, entries, sourceDetailGaps, sharedIntroduction: sharedMap, catalogueSlotRepairs, titleDifferences, titleCorrections: corrections, contentRestrictions: [], failures, note: "Preserve all 108 source-linked records without content screening, including No.0 SS sample. The original 60-no-jin subsidiary catalogue explicitly assigns six numbered entries to the shared introduction; its author/genre/tool fields uniquely identify each column. The late-submission page supplements historical download links. ZIP bytes are preserved without inspecting or executing game contents.", desktopReview: "pending" });
  const festivals: Festival[] = JSON.parse(await fs.readFile("src/data/festivals.json", "utf8")), festival = festivals.find((f) => f.id === id)!;
  festival.banners = banners; delete festival.hasDetail; await writeJson("src/data/festivals.json", festivals);
  console.log({ records: works.length, originalIntroductions: works.length - sourceDetailGaps.length, catalogueOnly: sourceDetailGaps.length, icons: works.filter((w) => w.icon).length, screenshots: works.reduce((n, w) => n + (w.ss?.length || 0), 0), banners: banners.length, imageGaps: failures.length });
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
