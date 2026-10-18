import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import { imageExtension, writeJson } from "./recover-entry-table";
import { getDictionary } from "../src/lib/i18n";
import type { WorkEntry } from "../src/lib/types";
import { rewriteSummer2012Source } from "./source-2012-summer-view";

const configurations: Record<string, { base: string; entry?: string; manifests: string[]; seeds: Record<string, string>; seedUrls?: Record<string, string>; cgiProfile?: boolean; encoding?: string; liveSource?: boolean; disabledLocalLinks?: string[]; externalResources?: Record<string, string>; frames?: { menuPage: string; menuName: string; mainName: string } }> = {
  "2011-denpa-game-festival": {
    base: "http://cryptic2011.web.fc2.com/",
    manifests: ["source/recovery/manifest.json"],
    seeds: { "index.html": "investigation/original-live.bin" },
    liveSource: true,
    frames: { menuPage: "menu.html", menuName: "menu", mainName: "main" },
  },
  "2012-toppuu-festival": {
    base: "https://w.atwiki.jp/viprpgwind2012/",
    manifests: ["source/live/manifest.json", "source/assets/manifest.json"],
    seeds: {}, encoding: "utf-8", liveSource: true,
  },
  "2012-summer": {
    base: "http://viprpgtkool.web.fc2.com/2012summer/",
    manifests: ["source/recovery/manifest.json"],
    seeds: { "index.html": "investigation/original-live.bin" },
    liveSource: true,
  },
  "2012-magic-festival": {
    base: "http://magicalviprpg2012.web.fc2.com/",
    manifests: ["source/recovery/manifest.json"],
    seeds: { "index.html": "investigation/original-live.bin", "top.html": "investigation/top-live.bin" },
    liveSource: true,
  },
  "2012-kouhaku": {
    base: "http://www45.atpages.jp/vipkohaku2012/",
    manifests: ["source/recovery/manifest.json"],
    seeds: { "index.html": "investigation/root-hk.bin", "db/index.html": "investigation/cgi-hk.bin" },
    seedUrls: { "db/index.html": "http://www45.atpages.jp/vipkohaku2012/db/profile.cgi?tpl=view" },
    cgiProfile: true,
    externalResources: {
      "http://ajax.googleapis.com/ajax/libs/jquery/1.7.1/jquery.min.js": "linked/jquery-1.7.1.min.js",
      "http://ajax.googleapis.com/ajax/libs/jquery/1.5.2/jquery.min.js": "linked/jquery-1.5.2.min.js",
      "http://vipkouhaku05.cs.land.to/viprpgkouhaku2009-top.png": "linked/kouhaku2005.png",
      "http://vipkouhaku05.cs.land.to/vip2008.png": "linked/kouhaku2008.png",
    },
  },
  "2012-gw": {
    base: "http://viprpg2012gw.web.fc2.com/",
    entry: "top.html",
    manifests: ["source/recovery/manifest.json"],
    seeds: { "top.html": "investigation/original-live.bin" },
    liveSource: true,
  },
  "2013-summer": {
    base: "http://www.geocities.jp/viprpgsummer2013/",
    manifests: ["source/recovery/manifest.json"],
    seeds: { "index.html": "investigation/index.bin", "main.html": "investigation/main.bin", "menu.html": "investigation/menu.bin" },
    frames: { menuPage: "menu.html", menuName: "menu", mainName: "main" },
    disabledLocalLinks: ["ss/-1.html"],
  },
  "2013-kouhaku": {
    base: "http://vipkohaku2013.web.fc2.com/",
    manifests: ["source/recovery/manifest.json", "source/external/manifest.json"],
    seeds: { "index.html": "investigation/original-live.bin" },
    liveSource: true,
    externalResources: {
      "http://ajax.googleapis.com/ajax/libs/jquery/1.7.1/jquery.min.js": "linked/jquery-1.7.1.min.js",
      "http://vipkouhaku05.cs.land.to/viprpgkouhaku2009-top.png": "linked/kouhaku2005.png",
      "http://vipkouhaku05.cs.land.to/vip2008.png": "linked/kouhaku2008.png",
      "http://www45.atpages.jp/vipkohaku2012/img/bnkohaku2012_2.png": "linked/kouhaku2012.png",
    },
  },
  "2013-gw": {
    base: "http://viprpg2013gw.web.fc2.com/",
    manifests: ["source/recovery/manifest.json"],
    seeds: { "index.html": "investigation/original-live.bin" },
    liveSource: true,
  },
  "2014-tsukusure-festival": {
    base: "http://www.geocities.jp/viprpg2014material/",
    manifests: ["source/recovery/manifest.json"],
    seeds: { "index.html": "investigation/index.bin", "entry.html": "investigation/entry.bin", "top.html": "investigation/top.bin" },
    encoding: "utf-8",
    frames: { menuPage: "entry.html", menuName: "2", mainName: "1" },
  },
  "2014-summer": {
    base: "http://www.geocities.jp/viprpg2014summer/",
    manifests: ["source/recovery/manifest.json"],
    seeds: { "index.html": "investigation/index.bin" },
    encoding: "euc-jp",
  },
  "2014-kouhaku": {
    base: "http://www.geocities.jp/vipkohaku2014/",
    manifests: ["source/recovery/manifest.json"],
    seeds: { "index.html": "investigation/index.bin" },
  },
  "2014-gw": {
    base: "http://viprpg2014gw.web.fc2.com/",
    manifests: ["source/manifest.json", "source/live-screenshots/manifest.json"],
    seeds: { "index.html": "investigation/original-live.bin" },
    liveSource: true,
  },
  "2015-gw": {
    base: "http://www.geocities.jp/viprpg2015gw/",
    manifests: ["source/recovery/manifest.json"],
    seeds: { "index.html": "investigation/archive-index.bin" },
  },
  "2015-kouhaku": {
    base: "http://www.geocities.jp/vipkohaku2015/",
    manifests: ["source/recovery/manifest.json"],
    seeds: { "index.html": "investigation/index.bin", "khmain.html": "investigation/khmain.bin", "khmenu.html": "investigation/khmenu.bin" },
    frames: { menuPage: "khmenu.html", menuName: "menu", mainName: "main" },
  },
};

function unarchive(url: string) {
  return url.replace(/^https?:\/\/web\.archive\.org\/web\/\d+[a-z_]*\/(https?:\/\/)/, "$1");
}

function decodeSource(bytes: Buffer, fallback: string) {
  const hasUtf8Bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  return iconv.decode(bytes, hasUtf8Bom ? "utf-8" : fallback);
}

async function main() {
  const id = process.argv[2], config = configurations[id];
  if (!config) throw new Error(`Choose one festival: ${Object.keys(configurations).join(", ")}`);
  const root = `catch/${id}`, output = `public/original-pages/${id}`, cache = `${root}/source/original-view`;
  await fs.mkdir(cache, { recursive: true });
  const base = new URL(config.base);
  const encoding = config.encoding ?? "shift_jis";
  const inventory: string[][] = JSON.parse(await fs.readFile(`${root}/investigation/original-timemap.bin`, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (config.liveSource && error.code === "ENOENT") return "[]";
    throw error;
  }));
  const cached = new Map<string, string>();
  const queue = new Set<string>(), files = new Map<string, Buffer>(), failures: Array<{ url: string; requestedUrl?: string; error: string }> = [];
  const compatibilityFixes: Array<{ page: string; change: string }> = [];
  const recovery = JSON.parse(await fs.readFile(`${root}/recovery.json`, "utf8"));
  if (id === "2012-toppuu-festival") config.externalResources = recovery.originalResources;
  const previousMissing: Array<{ url: string; requestedUrl?: string; error: string }> = JSON.parse(await fs.readFile(`${root}/original-view.json`, "utf8").catch(() => "{}")).missingResources ?? [];
  const restrictions: Array<{ no: string; sourcePath: string; resources: Array<{ path: string; kind: string }>; relatedUrls?: string[] }> = recovery.contentRestrictions ?? [];
  const catalogue: WorkEntry[] = JSON.parse(await fs.readFile(`src/data/works/${id}.json`, "utf8"));
  const blocked = new Map<string, string>();
  const generatedPlaceholders: string[] = [];
  const restrictedText = getDictionary("ja");
  for (const restriction of restrictions) {
    for (const kind of ["icon", "screenshot"]) {
      const placeholder = `restricted/${restriction.no}-${kind}.svg`, small = kind === "icon";
      generatedPlaceholders.push(placeholder);
      files.set(placeholder, Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${small ? 32 : 640}" height="${small ? 32 : 480}" viewBox="0 0 ${small ? "32 32" : "640 480"}"><rect width="100%" height="100%" fill="#eef1f4" stroke="#c6cdd5"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#536174" font-family="sans-serif" font-size="${small ? 22 : 24}">${small ? "◇" : restrictedText.restrictedContent}</text></svg>`));
    }
    for (const resource of restriction.resources) blocked.set(resource.path, `restricted/${restriction.no}-${resource.kind}.svg`);
  }
  const manifestPath = `${cache}/manifest.json`;
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8").catch(() => "{}"));
  function relative(url: string) {
    const original = new URL(unarchive(url), base);
    if (config.externalResources?.[original.href]) return config.externalResources[original.href];
    if (original.hostname !== base.hostname || !original.pathname.startsWith(base.pathname)) return undefined;
    const profile = original.pathname.slice(base.pathname.length).match(/^(db|db2|sc\d{2})\/profile\.cgi$/);
    if (config.cgiProfile && profile) {
      if (profile[1] !== "db") {
        if (original.searchParams.has("_v")) return undefined;
        return `${profile[1]}/${profile[1] === "db2" && original.searchParams.get("tpl") === "view2" ? "summary" : "index"}.html`;
      }
      const number = original.searchParams.get("_v"), template = original.searchParams.get("tpl");
      if (number && /^\d{3}$/.test(number) && template === "view2") return `db/entry${number}.html`;
      if (template === "view3") return "db/thumbnails.html";
      if (template === "view4") return "db/interim.html";
      if (!template || template === "view") return "db/index.html";
      return undefined;
    }
    const value = decodeURIComponent(original.pathname.slice(base.pathname.length)) || "index.html";
    if (value.split("/").some((part) => part === "..") || value.includes("\\")) throw new Error("Unsafe original resource path");
    return value;
  }
  function enqueue(url: string, owner: string) {
    const absolute = new URL(unarchive(url), owner).href, local = relative(absolute);
    if (local && blocked.has(local)) return blocked.get(local);
    if (local && /\.(?:html?|css|js|png|jpe?g|gif|bmp|webp|ico|svg|mp3|wav|ogg|mid|avi|ogv|txt|zip)$/i.test(local)) {
      queue.add(absolute);
      return local;
    }
    return local && files.has(local) ? local : undefined;
  }
  function localReference(value: string, owner: string, local: string) {
    if (/^(?:data:|javascript:|mailto:)/i.test(value) || value.startsWith("#")) return value;
    const target = enqueue(value, owner), url = new URL(value, owner);
    return target ? (path.posix.relative(path.posix.dirname(local), target) || path.posix.basename(target)) + (config.cgiProfile && url.pathname.endsWith("/profile.cgi") ? "" : url.search) + url.hash : url.href;
  }
  function rewriteCSS(text: string, owner: string, local: string) {
    return text.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/g, (_, value) => `url("${localReference(value, owner, local)}")`);
  }
  function rewriteAbsoluteStrings(text: string, owner: string, local: string) {
    return text.replace(/(["'])(https?:\/\/[^"']+)\1/g, (_, quote, value) => `${quote}${localReference(value, owner, local)}${quote}`);
  }
  for (const source of config.manifests) {
    const entries = JSON.parse(await fs.readFile(`${root}/${source}`, "utf8"));
    for (const [file, metadata] of Object.entries(entries) as Array<[string, { requestedUrl: string; originalUrl?: string; file?: string }]>) {
      const original = metadata.originalUrl ?? unarchive(metadata.requestedUrl), local = relative(original);
      if (!local || blocked.has(local)) continue;
      cached.set(local, `${root}/${path.posix.dirname(source)}/${metadata.file ?? file}`);
      queue.add(original);
    }
  }
  for (const [name, file] of Object.entries(config.seeds)) {
    cached.set(name, `${root}/${file}`);
    queue.add(config.seedUrls?.[name] ?? new URL(name, base).href);
  }
  for (const [file, metadata] of Object.entries(manifest) as Array<[string, { originalUrl: string }]>) {
    const local = relative(metadata.originalUrl);
    if (local && !cached.has(local)) cached.set(local, `${cache}/${file}`);
  }
  if (id === "2012-summer") for (const failure of recovery.failures ?? []) queue.add(failure.sourceUrl);
  const invalidPreloads: string[] = (recovery.unavailablePreloads ?? []).map((entry: { requestedUrl: string }) => new URL(unarchive(entry.requestedUrl)).href);
  for (const original of queue) {
    const local = relative(original)!;
    if (files.has(local)) continue;
    let requestedUrl: string | undefined;
    try {
      let bytes: Buffer;
      if (cached.has(local)) bytes = await fs.readFile(cached.get(local)!);
      else {
        if (!process.argv.includes("--fetch")) {
          const known = previousMissing.find((failure) => failure.url === original);
          requestedUrl = known?.requestedUrl;
          const sourceFailure = (recovery.failures ?? []).find((failure: { sourceUrl?: string }) => failure.sourceUrl === original);
          const error = known?.error.includes("Missing cached resource") ? sourceFailure?.error : known?.error;
          throw new Error(error?.replace(/^Error:\s*/, "") ?? "Missing cached resource; use --fetch");
        }
        const row = inventory.slice(1).find((row) => relative(row[0]) === local);
        const fallback = inventory.slice(1).find((row) => relative(row[0]) === "index.html");
        const capture = row ?? fallback;
        const archiveUrl = capture && `https://web.archive.org/web/${capture[2] || capture[1]}id_/${row?.[0] ?? original}`;
        // Keep Japan source requests and Hong Kong archive requests in separate batches.
        const urls = process.argv.includes("--archive-only") ? [archiveUrl] : config.liveSource ? [original] : [archiveUrl];
        let recovered: Buffer | undefined;
        const errors = [];
        for (const url of [...new Set(urls.filter((url): url is string => Boolean(url)))]) {
          requestedUrl = url;
          try {
            const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const candidate = Buffer.from(await response.arrayBuffer());
            if (/\.(?:png|jpe?g|gif|bmp|webp|ico)$/i.test(local)) imageExtension(candidate);
            recovered = candidate;
            const filename = `${Object.keys(manifest).length + 1}.bin`;
            await fs.writeFile(`${cache}/${filename}`, recovered);
            manifest[filename] = { originalUrl: original, requestedUrl: url, actualUrl: response.url, contentType: response.headers.get("content-type"), retrievedAt: new Date().toISOString(), ...(errors.length ? { previousErrors: errors } : {}) };
            await writeJson(manifestPath, manifest);
            break;
          } catch (error) { errors.push({ url, error: String(error) }); }
        }
        if (!recovered) throw new Error(errors.length ? JSON.stringify(errors) : "No original capture listed");
        bytes = recovered;
      }
      if (encoding !== "utf-8" && bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) compatibilityFixes.push({ page: local, change: "Decode this resource using its UTF-8 BOM instead of the festival default encoding." });
      if (!/\.html?$/i.test(local) && /^\s*<(?:!doctype|html)\b/i.test(bytes.subarray(0, 256).toString("utf8"))) throw new Error("HTML returned instead of a source resource");
      if (/\.(?:png|jpe?g|gif|bmp|webp|ico)$/i.test(local)) imageExtension(bytes);
      if (/\.html?$/i.test(local)) {
        const $ = cheerio.load(decodeSource(bytes, encoding));
        if (id === "2012-toppuu-festival") {
          $("script,noscript,iframe,form,body>header,body>footer,#atwiki-fixed-nav,#atwiki-modal-search-form,#editmenu,#ads,#left-ads,#right-ads,#atwiki-ads-overlay,#body_footer,#at_social_links2,[id^='div-gpt-ad-']").remove();
          $("link").filter((_, e) => !($(e).attr("rel") || "").includes("stylesheet") || /atwiki_headbar|font-awesome/.test($(e).attr("href") || "")).remove();
          $("source,[srcset]").each((_, e) => { if (e.tagName === "source") $(e).remove(); else $(e).removeAttr("srcset"); });
          $("*").each((_, e) => { for (const attr of Object.keys(e.attribs)) if (attr.startsWith("on")) $(e).removeAttr(attr); });
          $("a[href]").each((_, e) => {
            const value = $(e).attr("href")!;
            if (value.startsWith("#")) return;
            const url = new URL(value, original), mapped = config.externalResources?.[url.href];
            if ((url.hostname === base.hostname || url.hostname === "www48.atwiki.jp") && !mapped && !cached.has(relative(url.href) || "")) $(e).removeAttr("href target");
          });
          compatibilityFixes.push({ page: local, change: "Preserve Wiki content, existing comments, theme and catalogue navigation; remove hosting ads, scripts, editing/posting controls and unavailable Wiki administration links. Use full source images instead of responsive thumbnail requests." });
        }
        for (const restriction of restrictions) {
          const work = catalogue.find((work) => work.no === restriction.no)!;
          const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
          if (id === "2012-kouhaku" && (local === "enq4.html" || local.startsWith("db2/"))) {
            $("a[href]").filter((_, a) => relative(new URL($(a).attr("href")!, original).href) === restriction.sourcePath).closest("table").each((_, table) => {
              if (local === "db2/index.html") {
                $(table).find("tr").slice(1).find("td").html(`【コメント】<br>${restrictedText.restrictedContentText}`);
                $(table).find("img").attr("src", path.posix.relative(path.posix.dirname(local), `restricted/${restriction.no}-icon.svg`));
                return;
              }
              const image = path.posix.relative(path.posix.dirname(local), `restricted/${restriction.no}-screenshot.svg`);
              const workLink = path.posix.relative(path.posix.dirname(local), restriction.sourcePath);
              const metadataRows = local.startsWith("db2/") ? `<tr><td class="white">ツール：${escape(work.engine || "")}<br>ジャンル：${escape(work.category || "")}</td></tr>` : "";
              $(table).html(`<tr><td class="red"><a href="${workLink}">No.${restriction.no} - ${escape(work.title)}</a></td></tr>
                <tr><td class="gray">作者：${escape(work.author)}</td></tr>
                ${metadataRows}
                <tr><td class="white">作品総評：<br>${restrictedText.restrictedContentText}</td></tr>
                <tr><td class="white"><img src="${image}" width="640" height="480" alt="${restrictedText.restrictedContent}"></td></tr>`);
            });
          }
          if (local === restriction.sourcePath) {
            if (id === "2012-kouhaku") {
              const box = $("#box2"), navigation = box.find("table#entrylist").first().html();
              const image = path.posix.relative(path.posix.dirname(local), `restricted/${restriction.no}-screenshot.svg`);
              const icon = path.posix.relative(path.posix.dirname(local), `restricted/${restriction.no}-icon.svg`);
              box.html(`<table id="entrylist" width="640">${navigation}</table>
                <table id="entrylist" width="640"><tr><th class="black"><img src="${icon}" width="32" height="32"></th><td class="red">No.${restriction.no} - ${escape(work.title)}</td></tr></table>
                <img src="${image}" width="640" height="480" alt="${restrictedText.restrictedContent}">
                <table id="entrylist" width="640"><tr><td class="red">${restrictedText.restrictedContentText}</td></tr>
                <tr><td>ジャンル：${escape(work.category || "")}</td></tr><tr><td>ツール：${escape(work.engine || "")}</td></tr>
                <tr><td>配信/投稿：${restrictedText.restrictedContent}</td></tr><tr><td>作者：${escape(work.author)}</td></tr>
                <tr><td>作者コメント：<br>${restrictedText.restrictedContentText}</td></tr>
                <tr><td class="gray">管理人コメント：<br>${restrictedText.restrictedContentText}</td></tr>
                <tr><td>更新履歴：<br>${restrictedText.restrictedContent}</td></tr></table>`);
            } else if (id === "2012-magic-festival") {
              const image = path.posix.relative(path.posix.dirname(local), `restricted/${restriction.no}-screenshot.svg`);
              const icon = path.posix.relative(path.posix.dirname(local), `restricted/${restriction.no}-icon.svg`);
              $("table").first().html(`<tr><td><img src="${icon}" width="32" height="32"><b>${escape(work.title)}</b></td></tr>
                <tr><td><img src="${image}" width="640" height="480" alt="${restrictedText.restrictedContent}"></td></tr>
                <tr><td>${restrictedText.restrictedContentText}</td></tr>
                <tr><td><b>術者名◇</b> ${escape(work.author)}</td></tr>
                <tr><td><b>魔具◇</b> ${escape(work.engine || "")}</td></tr>
                <tr><td><b>ジャンル◇</b> ${escape(work.category || "")}</td></tr>
                <tr><td><b>配信／投稿◇</b> ${restrictedText.restrictedContent}</td></tr>
                <tr><td><b>コメント◇</b><br>${restrictedText.restrictedContentText}</td></tr>
                <tr><td><b>マスターから◇</b><br>${restrictedText.restrictedContentText}</td></tr>`);
            } else if (id === "2012-gw") {
              const image = path.posix.relative(path.posix.dirname(local), `restricted/${restriction.no}-screenshot.svg`);
              $("h2").first().text(work.title);
              $("table").first().html(`<tr><td><img src="${image}" width="640" height="480" alt="${restrictedText.restrictedContent}"></td></tr>
                <tr><td>${restrictedText.restrictedContentText}</td></tr>
                <tr><td><p><strong>タイトル：</strong>${escape(work.title)}</p></td></tr>
                <tr><td><p><strong>作者名：</strong>${escape(work.author)}</p></td></tr>
                <tr><td><p><strong>ツクール名：</strong>${escape(work.engine || "")}</p></td></tr>
                <tr><td><p><strong>コメント：</strong>${restrictedText.restrictedContentText}</p></td></tr>
                <tr><td><p><strong>動画配信：</strong>${restrictedText.restrictedContent}</p></td></tr>
                <tr><td><p><strong>管理人より：</strong>${restrictedText.restrictedContentText}</p></td></tr>`);
            } else if (id === "2013-kouhaku") {
              const navigation = $("table").first().html();
              const image = path.posix.relative(path.posix.dirname(local), `restricted/${restriction.no}-screenshot.svg`);
              const icon = path.posix.relative(path.posix.dirname(local), `restricted/${restriction.no}-icon.svg`);
              $("body").html(`<div id="container" align="center">
                <table width="640" border="1" bgcolor="#ffffff">${navigation}</table>
                <table width="640" border="1" bgcolor="#ffffff"><tr><th width="32"><img src="${icon}" width="32" height="32"></th><td bgcolor="#dddddd">No.${restriction.no} - ${escape(work.title)}</td></tr></table>
                <img src="${image}" width="640" height="480" alt="${restrictedText.restrictedContent}">
                <table width="640" border="1" bgcolor="#ffffff">
                  <tr><td colspan="2" bgcolor="#ff7777">${restrictedText.restrictedContentText}</td></tr>
                  <tr><td>作者：${escape(work.author)}</td><td>使用ツール：${escape(work.engine || "")}</td></tr>
                  <tr><td>ジャンル：${escape(work.category || "")}</td><td>配信/投稿：${restrictedText.restrictedContent}</td></tr>
                  <tr><td colspan="2">作者コメント：<br>${restrictedText.restrictedContentText}</td></tr>
                  <tr><td colspan="2" bgcolor="#dddddd">管理人コメント：<br>${restrictedText.restrictedContentText}</td></tr>
                  <tr><td colspan="2">更新履歴：<br>${restrictedText.restrictedContent}</td></tr>
                </table></div>`);
            } else {
            const rows = $("table").first().find("tr");
            rows.eq(0).find("a").replaceWith("非表示");
            rows.eq(1).children("td").html(`<p align="center"><img src="${path.posix.relative(path.posix.dirname(local), `restricted/${restriction.no}-screenshot.svg`)}" width="640" height="480" alt="${restrictedText.restrictedContent}"></p>`);
            rows.eq(2).children("td").html(`<p style="font-size:14px;line-height:25px">作者名：${escape(work.author)}<br>製作ツール：${escape(work.engine ?? "")}<br>ジャンル：${escape(work.category ?? "")}<br>作者コメント：${restrictedText.restrictedContentText}<br>━━━━━━━━━━━━━━━━━━━━━━━━━<br>管理人からのコメント<br>${restrictedText.restrictedContentText}</p>`);
            }
          }
          if (local !== restriction.sourcePath) $("a[href]").filter((_, a) => relative(new URL($(a).attr("href")!, original).href) === restriction.sourcePath).each((_, a) => {
            const row = id === "2012-kouhaku" && local === "db/thumbnails.html" ? $(a).closest("p") : $(a).closest("tr");
            const kind = id === "2012-kouhaku" && local === "db/thumbnails.html" ? "screenshot" : "icon";
            row.find("img").attr("src", path.posix.relative(path.posix.dirname(local), `restricted/${restriction.no}-${kind}.svg`)).removeAttr("onmouseover onmouseout");
            if (id === "2012-kouhaku" && local === "db/thumbnails.html") row.find("table").last().find("td").eq(3).text(restrictedText.restrictedContent);
            row.find("a").each((_, link) => { if (relative(new URL($(link).attr("href")!, original).href) !== restriction.sourcePath) $(link).replaceWith("非表示"); });
            if (id === "2012-kouhaku" && local === "db/index.html") row.children("td").eq(3).text(restrictedText.restrictedContent);
            if (local === "index.html") row.children("td").eq(6).text("非表示");
            if (id === "2012-gw" && local === "top.html") row.children("td").eq(5).text(restrictedText.restrictedContent);
            if (id === "2012-magic-festival" && local === "top.html") row.children("td").eq(5).text(restrictedText.restrictedContent);
          });
          if (restriction.relatedUrls?.length) $("a[href]").filter((_, a) => restriction.relatedUrls!.includes(new URL($(a).attr("href")!, original).href)).replaceWith(restrictedText.restrictedContent);
        }
        if (id === "2012-kouhaku" && ["db/index.html", "db/thumbnails.html"].includes(local)) {
          for (const entry of recovery.entries) {
            const anchor = $("a[href]").filter((_, a) => new URL($(a).attr("href")!, original).searchParams.get("_v") === entry.no).first();
            const table = local === "db/thumbnails.html" ? anchor.closest("p") : anchor.closest("table");
            table.attr({ "data-entry": entry.no, "data-team": entry.team || "", "data-tool": entry.engineKey || "", "data-submission": entry.submissionStatus || "" });
          }
          $("#box2 td").filter((_, td) => /^\[全件\]/.test($(td).text().trim())).first().attr("id", "archive-entry-summary");
          $('select[name="genre"]').prop("disabled", true).attr("title", "原サイトのジャンル検索用データが保存されていないため利用できません。");
          compatibilityFixes.push({ page: local, change: "Restore team/tool/submission filters and ordering from source metadata. Genre filtering is disabled because its server-only keyword categories are not present in captured HTML." });
        }
        if (id === "2012-kouhaku" && /^(db2|sc\d{2})\//.test(local)) {
          $("form select,form input[type='button'],form input[type='submit']").prop("disabled", true).attr("title", "保存された集計結果を表示しています。サーバー側の絞り込み・並べ替えは利用できません。");
          $("form [onclick]").removeAttr("onclick");
          compatibilityFixes.push({ page: local, change: "Preserve the captured ranking table and its ordering; unavailable server-side filter/sort controls are disabled." });
        }
        $("base").remove();
        if (id === "2012-kouhaku") $("noscript,#geniee_overray_base,#geniee_overray_tag,link[rel='alternate'],img[src*='geniee.jp']").remove();
        $('img[src*="media.fc2.com/counter_img.php"]').remove();
        $('img[src*="netriver.jp/countriver/"]').remove();
        $("meta[charset]").attr("charset", "UTF-8");
        $("meta[http-equiv]").each((_, element) => {
          if ($(element).attr("http-equiv")?.toLowerCase() === "content-type") $(element).attr("content", "text/html; charset=UTF-8");
        });
        if (!$("meta[charset]").length && !$("meta[http-equiv]").toArray().some((element) => $(element).attr("http-equiv")?.toLowerCase() === "content-type")) $("head").prepend('<meta charset="UTF-8">');
        $("script").each((_, element) => {
          const script = $(element), src = script.attr("src");
          if ((src && !relative(new URL(src, original).href)) || /fc2footerparam|geovisit\(|var\s+jps\s*=|archive_analytics|__wm\./.test(script.html() ?? "") || (id === "2012-magic-festival" && /fhp_c_pc/.test(script.html() ?? "")) || (id === "2012-kouhaku" && /_gaq|googletag|geniee_|var ID=|twitter-wjs/.test(script.html() ?? ""))) script.remove();
          else if (!src) {
            let code = script.html() ?? "";
            if (id === "2012-summer" && /^sakuhin_?\.html$/.test(local)) {
              code = rewriteSummer2012Source(code, local, (value) => localReference(value, original, local), (recovery.failures ?? []).map((f: { sourceUrl: string }) => f.sourceUrl.match(/\/ss\/no(\d+)\./)?.[1]).filter(Boolean).map(Number));
              compatibilityFixes.push({ page: local, change: "Preserve dynamic detail navigation while omitting sample forum placeholders and disabling nonexistent boundary entries." });
            }
            if (id === "2012-kouhaku" && ["db/index.html", "db/thumbnails.html"].includes(local) && /function jump\(/.test(code)) {
              script.html(`function jump(){
                var form=document.forms.namedItem('form'), rows=Array.from(document.querySelectorAll('[data-entry]'));
                var value=function(name){return decodeURIComponent(form.elements.namedItem(name).value).trim();};
                var team=value('team'),tool=value('tool'),status=value('pres');
                if(!window.archiveFilterEnd){
                  window.archiveFilterEnd=document.createElement('div');window.archiveFilterEnd.style.clear='both';
                  rows[0].parentNode.insertBefore(window.archiveFilterEnd,rows[0]);
                  document.querySelectorAll('#box2 p[style*="clear"]').forEach(function(p){p.remove();});
                }
                rows.sort(function(a,b){return Number(a.dataset.entry)-Number(b.dataset.entry);});
                if(value('rvs'))rows.reverse();
                rows.forEach(function(row){
                  row.hidden=Boolean((team&&row.dataset.team!==team)||(tool&&!row.dataset.tool.includes(tool))||(status&&row.dataset.submission!==status));
                  window.archiveFilterEnd.parentNode.insertBefore(row,window.archiveFilterEnd);
                });
                var summary=document.getElementById('archive-entry-summary');
                if(summary)summary.textContent=(team||tool||status?'[検索結果]':'[全件]')+'（'+rows.filter(function(r){return !r.hidden;}).length+'件） '+(value('rvs')?'降順':'昇順');
              }`);
              return;
            }
            if (id === "2013-kouhaku" && code.includes("$setFilter.children('a')")) {
              code = code.replace("$setFilter.children('a')", "$setFilter.find('a')");
              compatibilityFixes.push({ page: local, change: "Bind the source filter links inside their existing paragraph wrapper." });
            }
            script.html(rewriteAbsoluteStrings(code.replace(/(["'])([^"'\r\n]+)\1/g, (literal, quote, value) => {
            let url;
            try { url = new URL(value, original).href; } catch { return literal; }
            return invalidPreloads.includes(url) ? `${quote}data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=${quote}` : literal;
          }), original, local));
          }
        });
        $("[src],[href],[background]").each((_, element) => {
          const node = $(element);
          for (const attr of ["src", "href", "background"]) {
            const value = node.attr(attr);
            if (!value || value.startsWith("#") || /^(?:data:|javascript:|mailto:)/i.test(value)) continue;
            if (attr === "href" && config.disabledLocalLinks?.includes(relative(new URL(value, original).href) || "")) {
              node.removeAttr("href target");
              if (!compatibilityFixes.some((fix) => fix.page === local && fix.change === "Disable nonexistent boundary navigation.")) compatibilityFixes.push({ page: local, change: "Disable nonexistent boundary navigation." });
              continue;
            }
            node.attr(attr, localReference(value, original, local));
            if (attr === "href" && node.attr("target") === "_blank" && /\.html?$/i.test(relative(new URL(value, original).href) || "")) node.attr("target", "_self");
          }
        });
        $("*").each((_, element) => {
          for (const attr of Object.keys(element.attribs)) if (attr.startsWith("on")) {
            const text = $(element).attr(attr)!;
            for (const match of text.matchAll(/this\.src\s*=\s*['"]([^'"]+)['"]/g)) enqueue(match[1], original);
            $(element).attr(attr, rewriteAbsoluteStrings(text, original, local));
          }
        });
        $("[style],style").each((_, element) => {
          const text = $(element).attr("style") ?? $(element).html() ?? "";
          if ($(element).attr("style") !== undefined) $(element).attr("style", rewriteCSS(text, original, local));
          else $(element).html(rewriteCSS(text, original, local));
        });
        // Opaque sandbox origins prevent the legacy menu from navigating its sibling frame.
        if (config.frames && local === "index.html") $("head").append(`<script>
          addEventListener('message',function(event){
            var menu=document.querySelector(${JSON.stringify(`frame[name="${config.frames.menuName}"]`)}),main=document.querySelector(${JSON.stringify(`frame[name="${config.frames.mainName}"]`)});
            if(!menu||!main||event.source!==menu.contentWindow||event.data?.type!=='archive-main-navigation')return;
            var url=new URL(event.data.url,location.href);
            if(url.origin===location.origin&&url.pathname.startsWith(location.pathname.slice(0,location.pathname.lastIndexOf('/')+1)))main.src=url.href;
          });
        </script>`);
        if (config.frames && local === config.frames.menuPage) $("body").append(`<script>
          addEventListener('click',function(event){
            var a=event.target.closest(${JSON.stringify(`a[target="${config.frames.mainName}"]`)});if(!a)return;
            var url=new URL(a.href);
            if(url.origin!==location.origin)return;
            event.preventDefault();parent.postMessage({type:'archive-main-navigation',url:url.href},'*');
          });
        </script>`);
        bytes = Buffer.from($.html());
      } else if (/\.css$/i.test(local)) {
        const css = decodeSource(bytes, encoding).replace(/@charset\s+["'][^"']+["'];/i, '@charset "UTF-8";');
        bytes = Buffer.from(rewriteCSS(css, original, local));
      } else if (/\.js$/i.test(local)) {
        let code = decodeSource(bytes, encoding);
        if (id === "2012-summer") code = rewriteSummer2012Source(code, local, (value) => localReference(value, original, local), (recovery.failures ?? []).map((f: { sourceUrl: string }) => f.sourceUrl.match(/\/ss\/no(\d+)\./)?.[1]).filter(Boolean).map(Number));
        bytes = Buffer.from(rewriteAbsoluteStrings(code, original, local));
      }
      files.set(local, bytes);
    } catch (error) { failures.push({ url: original, requestedUrl, error: String(error) }); }
  }
  const omittedBackgrounds: Array<{ page: string; resource: string }> = [];
  const omittedHovers: Array<{ page: string; resource: string }> = [];
  const unavailable = new Set(failures.map((failure) => relative(failure.url)));
  for (const [local, bytes] of files) if (/\.html?$/i.test(local)) {
    const $ = cheerio.load(bytes.toString("utf8"));
    $("[background]").each((_, element) => {
      const resource = relative(new URL($(element).attr("background")!, new URL(local, base)).href);
      if (resource && unavailable.has(resource)) {
        $(element).removeAttr("background");
        omittedBackgrounds.push({ page: local, resource });
      }
    });
    if (id === "2012-kouhaku") {
      $("[style],style").each((_, element) => {
        const node = $(element), inline = node.attr("style"), text = inline ?? node.html() ?? "";
        const cleaned = text.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/g, (literal, value) => {
          const resource = relative(new URL(value, new URL(local, base)).href);
          if (!resource || !unavailable.has(resource)) return literal;
          omittedBackgrounds.push({ page: local, resource });
          return "none";
        });
        if (inline !== undefined) node.attr("style", cleaned); else node.html(cleaned);
      });
      $("img[src],link[rel*=icon]").each((_, element) => {
        const node = $(element), value = node.attr("src") || node.attr("href");
        if (!value) return;
        const resource = relative(new URL(value, new URL(local, base)).href);
        if (!resource || !unavailable.has(resource)) return;
        if (resource.endsWith("rss.gif")) { node.replaceWith("RSS"); compatibilityFixes.push({ page: local, change: "Use the source RSS label as text where its folder-specific badge is not archived." }); }
        else if (element.tagName === "link") node.remove();
      });
    }
    $("[onmouseover],[onmouseout]").each((_, element) => {
      for (const attr of ["onmouseover", "onmouseout"]) for (const match of ($(element).attr(attr) || "").matchAll(/this\.src\s*=\s*['"]([^'"]+)['"]/g)) {
        const resource = relative(new URL(match[1], new URL(local, base)).href);
        if (resource && unavailable.has(resource)) { $(element).removeAttr(attr); omittedHovers.push({ page: local, resource }); }
      }
    });
    if (id === "2012-kouhaku" || [...omittedBackgrounds, ...omittedHovers].some((omission) => omission.page === local)) files.set(local, Buffer.from($.html()));
  }
  for (const [local, bytes] of files) {
    const target = `${output}/${local}`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    const existing = await fs.readFile(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (!existing?.equals(bytes)) await fs.writeFile(target, bytes);
  }
  if (!files.has(config.entry ?? "index.html")) throw new Error("Original entry page was not recovered");
  const viewsPath = "src/data/original-views.json", views = JSON.parse(await fs.readFile(viewsPath, "utf8"));
  const preloadResources = {
    unavailableUnused: invalidPreloads.length,
    cachedUnused: (recovery.entries ?? []).reduce((total: number, entry: { additionalPreloadsRecovered?: number }) => total + (entry.additionalPreloadsRecovered ?? 0), 0),
    evidence: `${root}/recovery.json`,
  };
  views[id] = { entry: `/original-pages/${id}/${config.entry ?? "index.html"}`, status: failures.length ? "available-with-documented-omissions" : "available" };
  await writeJson(viewsPath, views);
  await writeJson(`${root}/original-view.json`, { festivalId: id, sourceEncoding: encoding, entry: views[id].entry, sourceManifests: config.manifests, sourcePages: config.seeds, files: [...files.keys()], generatedPlaceholders, preloadResources, missingResources: failures, omittedBackgrounds, omittedHovers, compatibilityFixes, changes: [`Original HTML and CSS normalized from ${encoding} to UTF-8.`, "Same-site links, CSS resources and absolute script/hover URLs use local paths.", "External hosting trackers removed; unavailable unused preloads replaced with an empty image.", "Original pages are displayed inside a sandboxed frame.", ...(omittedBackgrounds.length ? ["Unavailable background references are omitted; the original background colors are retained and missing resources remain documented."] : []), ...(restrictions.length ? ["Restricted entries retain their catalogue row and full detail structure with fixed neutral text and generated placeholders; original restricted descriptions, media and related links are not published."] : []), ...(config.frames ? ["A scoped local message forwards menu clicks to the sibling frame while preserving the original frameset and sandbox isolation."] : [])], desktopReview: "pending" });
  console.log(`${id}: ${files.size} files; ${failures.length} missing resources.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
