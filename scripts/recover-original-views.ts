import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import { imageExtension, writeJson } from "./recover-entry-table";
import { getDictionary } from "../src/lib/i18n";
import type { WorkEntry } from "../src/lib/types";

const configurations: Record<string, { base: string; manifests: string[]; seeds: Record<string, string>; encoding?: string; liveSource?: boolean; frames?: { menuPage: string; menuName: string; mainName: string } }> = {
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

async function main() {
  const id = process.argv[2], config = configurations[id];
  if (!config) throw new Error(`Choose one festival: ${Object.keys(configurations).join(", ")}`);
  const root = `catch/${id}`, output = `public/original-pages/${id}`, cache = `${root}/source/original-view`;
  await fs.mkdir(cache, { recursive: true });
  const base = new URL(config.base);
  const encoding = config.encoding ?? "shift_jis";
  const inventory: string[][] = JSON.parse(await fs.readFile(`${root}/investigation/original-timemap.bin`, "utf8"));
  const cached = new Map<string, string>();
  const queue = new Set<string>(), files = new Map<string, Buffer>(), failures: Array<{ url: string; requestedUrl?: string; error: string }> = [];
  const recovery = JSON.parse(await fs.readFile(`${root}/recovery.json`, "utf8"));
  const restrictions: Array<{ no: string; sourcePath: string; resources: Array<{ path: string; kind: string }> }> = recovery.contentRestrictions ?? [];
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
    if (original.hostname !== base.hostname || !original.pathname.startsWith(base.pathname)) return undefined;
    const value = decodeURIComponent(original.pathname.slice(base.pathname.length)) || "index.html";
    if (value.split("/").some((part) => part === "..") || value.includes("\\")) throw new Error("Unsafe original resource path");
    return value;
  }
  function enqueue(url: string, owner: string) {
    const absolute = new URL(unarchive(url), owner).href, local = relative(absolute);
    if (local && blocked.has(local)) return blocked.get(local);
    if (local && /\.(?:html?|css|js|png|jpe?g|gif|bmp|webp|ico|mp3|wav|ogg|mid|avi|ogv|txt|zip)$/i.test(local)) {
      queue.add(absolute);
      return local;
    }
    return local && files.has(local) ? local : undefined;
  }
  function localReference(value: string, owner: string, local: string) {
    if (/^(?:data:|javascript:|mailto:)/i.test(value) || value.startsWith("#")) return value;
    const target = enqueue(value, owner), url = new URL(value, owner);
    return target ? (path.posix.relative(path.posix.dirname(local), target) || path.posix.basename(target)) + url.search + url.hash : url.href;
  }
  function rewriteCSS(text: string, owner: string, local: string) {
    return text.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/g, (_, value) => `url("${localReference(value, owner, local)}")`);
  }
  function rewriteAbsoluteStrings(text: string, owner: string, local: string) {
    return text.replace(/(["'])(https?:\/\/[^"']+)\1/g, (_, quote, value) => `${quote}${localReference(value, owner, local)}${quote}`);
  }
  for (const source of config.manifests) {
    const entries = JSON.parse(await fs.readFile(`${root}/${source}`, "utf8"));
    for (const [file, metadata] of Object.entries(entries) as Array<[string, { requestedUrl: string; originalUrl?: string }]>) {
      const original = metadata.originalUrl ?? unarchive(metadata.requestedUrl), local = relative(original);
      if (!local || blocked.has(local)) continue;
      cached.set(local, `${root}/${path.posix.dirname(source)}/${file}`);
      queue.add(original);
    }
  }
  for (const [name, file] of Object.entries(config.seeds)) {
    cached.set(name, `${root}/${file}`);
    queue.add(new URL(name, base).href);
  }
  for (const [file, metadata] of Object.entries(manifest) as Array<[string, { originalUrl: string }]>) {
    const local = relative(metadata.originalUrl);
    if (local && !cached.has(local)) cached.set(local, `${cache}/${file}`);
  }
  const invalidPreloads: string[] = (recovery.unavailablePreloads ?? []).map((entry: { requestedUrl: string }) => new URL(unarchive(entry.requestedUrl)).href);
  for (const original of queue) {
    const local = relative(original)!;
    if (files.has(local)) continue;
    let requestedUrl: string | undefined;
    try {
      let bytes: Buffer;
      if (cached.has(local)) bytes = await fs.readFile(cached.get(local)!);
      else {
        if (!process.argv.includes("--fetch")) throw new Error("Missing cached resource; use --fetch");
        const row = inventory.slice(1).find((row) => relative(row[0]) === local);
        const fallback = inventory.slice(1).find((row) => relative(row[0]) === "index.html");
        const capture = row ?? fallback;
        const archiveUrl = capture && `https://web.archive.org/web/${capture[2] || capture[1]}id_/${row?.[0] ?? original}`;
        const urls = config.liveSource ? [new URL(local, base).href, archiveUrl] : [archiveUrl];
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
      if (!/\.html?$/i.test(local) && /^\s*<(?:!doctype|html)\b/i.test(bytes.subarray(0, 256).toString("utf8"))) throw new Error("HTML returned instead of a source resource");
      if (/\.(?:png|jpe?g|gif|bmp|webp|ico)$/i.test(local)) imageExtension(bytes);
      if (/\.html?$/i.test(local)) {
        const $ = cheerio.load(iconv.decode(bytes, encoding));
        for (const restriction of restrictions) {
          const work = catalogue.find((work) => work.no === restriction.no)!;
          const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
          if (local === restriction.sourcePath) {
            const rows = $("table").first().find("tr");
            rows.eq(0).find("a").replaceWith("非表示");
            rows.eq(1).children("td").html(`<p align="center"><img src="${path.posix.relative(path.posix.dirname(local), `restricted/${restriction.no}-screenshot.svg`)}" width="640" height="480" alt="${restrictedText.restrictedContent}"></p>`);
            rows.eq(2).children("td").html(`<p style="font-size:14px;line-height:25px">作者名：${escape(work.author)}<br>製作ツール：${escape(work.engine ?? "")}<br>ジャンル：${escape(work.category ?? "")}<br>作者コメント：${restrictedText.restrictedContentText}<br>━━━━━━━━━━━━━━━━━━━━━━━━━<br>管理人からのコメント<br>${restrictedText.restrictedContentText}</p>`);
          }
          if (local !== restriction.sourcePath) $("a[href]").filter((_, a) => new URL($(a).attr("href")!, original).pathname === new URL(restriction.sourcePath, base).pathname).each((_, a) => {
            const row = $(a).closest("tr");
            row.find("img").attr("src", path.posix.relative(path.posix.dirname(local), `restricted/${restriction.no}-icon.svg`)).removeAttr("onmouseover onmouseout");
            row.find("a").each((_, link) => { if (new URL($(link).attr("href")!, original).pathname !== new URL(restriction.sourcePath, base).pathname) $(link).replaceWith("非表示"); });
            if (local === "index.html") row.children("td").eq(6).text("非表示");
          });
        }
        $("base").remove();
        $('img[src*="media.fc2.com/counter_img.php"]').remove();
        $("meta[charset]").attr("charset", "UTF-8");
        $("meta[http-equiv]").each((_, element) => {
          if ($(element).attr("http-equiv")?.toLowerCase() === "content-type") $(element).attr("content", "text/html; charset=UTF-8");
        });
        $("script").each((_, element) => {
          const script = $(element), src = script.attr("src");
          if ((src && !relative(new URL(src, original).href)) || /fc2footerparam|geovisit\(|var\s+jps\s*=|archive_analytics|__wm\./.test(script.html() ?? "")) script.remove();
          else if (!src) script.html(rewriteAbsoluteStrings((script.html() ?? "").replace(/(["'])([^"'\r\n]+)\1/g, (literal, quote, value) => {
            let url;
            try { url = new URL(value, original).href; } catch { return literal; }
            return invalidPreloads.includes(url) ? `${quote}data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=${quote}` : literal;
          }), original, local));
        });
        $("[src],[href],[background]").each((_, element) => {
          const node = $(element);
          for (const attr of ["src", "href", "background"]) {
            const value = node.attr(attr);
            if (!value || value.startsWith("#") || /^(?:data:|javascript:|mailto:)/i.test(value)) continue;
            node.attr(attr, localReference(value, original, local));
          }
        });
        $("*").each((_, element) => {
          for (const attr of Object.keys(element.attribs)) if (attr.startsWith("on")) $(element).attr(attr, rewriteAbsoluteStrings($(element).attr(attr)!, original, local));
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
        const css = iconv.decode(bytes, encoding).replace(/@charset\s+["'][^"']+["'];/i, '@charset "UTF-8";');
        bytes = Buffer.from(rewriteCSS(css, original, local));
      } else if (/\.js$/i.test(local)) bytes = Buffer.from(rewriteAbsoluteStrings(iconv.decode(bytes, encoding), original, local));
      files.set(local, bytes);
    } catch (error) { failures.push({ url: original, requestedUrl, error: String(error) }); }
  }
  const omittedBackgrounds: Array<{ page: string; resource: string }> = [];
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
    if (omittedBackgrounds.some((omission) => omission.page === local)) files.set(local, Buffer.from($.html()));
  }
  for (const [local, bytes] of files) {
    const target = `${output}/${local}`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
  if (!files.has("index.html")) throw new Error("Original index was not recovered");
  const viewsPath = "src/data/original-views.json", views = JSON.parse(await fs.readFile(viewsPath, "utf8"));
  const preloadResources = {
    unavailableUnused: invalidPreloads.length,
    cachedUnused: (recovery.entries ?? []).reduce((total: number, entry: { additionalPreloadsRecovered?: number }) => total + (entry.additionalPreloadsRecovered ?? 0), 0),
    evidence: `${root}/recovery.json`,
  };
  views[id] = { entry: `/original-pages/${id}/index.html`, status: failures.length ? "available-with-documented-omissions" : "available" };
  await writeJson(viewsPath, views);
  await writeJson(`${root}/original-view.json`, { festivalId: id, sourceEncoding: encoding, entry: views[id].entry, sourceManifests: config.manifests, sourcePages: config.seeds, files: [...files.keys()], generatedPlaceholders, preloadResources, missingResources: failures, omittedBackgrounds, changes: [`Original HTML and CSS normalized from ${encoding} to UTF-8.`, "Same-site links, CSS resources and absolute script/hover URLs use local paths.", "External hosting trackers removed; unavailable unused preloads replaced with an empty image.", "Original pages are displayed inside a sandboxed frame.", ...(omittedBackgrounds.length ? ["Unavailable background references are omitted; the original background colors are retained and missing resources remain documented."] : []), ...(restrictions.length ? ["Restricted entries retain their catalogue row and full detail structure with fixed neutral text and generated placeholders; original restricted descriptions, media and related links are not published."] : []), ...(config.frames ? ["A scoped local message forwards menu clicks to the sibling frame while preserving the original frameset and sandbox isolation."] : [])], desktopReview: "pending" });
  console.log(`${id}: ${files.size} files; ${failures.length} missing resources.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
