import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import { decodeSource, imageExtension, writeJson } from "./recover-entry-table";
import { getDictionary } from "../src/lib/i18n";
import type { WorkEntry } from "../src/lib/types";
import { rewriteSummer2012Source } from "./source-2012-summer-view";

const configurations: Record<string, { base: string; entry?: string; manifests: string[]; seeds: Record<string, string>; seedUrls?: Record<string, string>; cgiProfile?: boolean; encoding?: string; encodingOverrides?: Record<string, string>; liveSource?: boolean; disabledLocalLinks?: string[]; externalResources?: Record<string, string>; preserveExternalExtensions?: string[]; frames?: { menuPage: string; menuName: string; mainName: string } }> = {
  "2025-summer": {
    base: "https://itch.io/jam/viprpgnatunozin2025/",
    manifests: ["source/live/manifest.json", "source/archive/manifest.json", "source/styles/manifest.json", "source/assets/manifest.json"],
    seeds: {},
    encoding: "utf-8",
    liveSource: true,
    preserveExternalExtensions: [".zip", ".rar", ".7z", ".exe"],
  },
  "2025-gw": {
    base: "https://itch.io/jam/vip-gw2025/",
    manifests: ["source/live/manifest.json", "source/styles/manifest.json", "source/assets/manifest.json"],
    seeds: {},
    encoding: "utf-8",
    liveSource: true,
    preserveExternalExtensions: [".zip", ".rar", ".7z", ".exe"],
  },
  "2005-kouhaku": {
    base: "http://vipkouhaku05.cs.land.to/",
    manifests: ["source/archive/manifest.json"],
    seeds: {},
    encoding: "shift_jis",
    preserveExternalExtensions: [".zip"],
  },
  "2006-summer": {
    base: "http://www.geocities.jp/gavumu/",
    entry: "top.htm",
    manifests: ["source/original-archive/manifest.json"],
    seeds: {},
    encoding: "shift_jis",
    frames: { menuPage: "fure-m.htm", menuName: "left", mainName: "right" },
    preserveExternalExtensions: [".zip"],
  },
  "2006-kouhaku": {
    base: "http://www.geocities.jp/vipkouhaku/",
    manifests: ["source/archive/manifest.json", "source/original-archive/manifest.json"],
    seeds: {},
    encoding: "shift_jis",
    frames: { menuPage: "menu.htm", menuName: "left", mainName: "right" },
    preserveExternalExtensions: [".zip"],
  },
  "2006-gw": {
    base: "http://www.geocities.jp/viprpg_gw/",
    manifests: ["source/original-archive/manifest.json"],
    seeds: {},
    encoding: "euc-jp",
    encodingOverrides: { "index.html": "shift_jis", "tenpure.html": "shift_jis" },
    frames: { menuPage: "leftmenu.html", menuName: "leftmenu.", mainName: "main" },
    preserveExternalExtensions: [".zip"],
  },
  "2007-summer": {
    base: "https://vipkohaku.x.fc2.com/2007s/",
    manifests: ["source/archive/manifest.json"],
    seeds: {},
    encoding: "shift_jis",
    frames: { menuPage: "menu.html", menuName: "", mainName: "sita" },
    preserveExternalExtensions: [".zip"],
  },
  "2007-gw": {
    base: "https://vipkohaku.x.fc2.com/2007GW/",
    manifests: ["source/archive/manifest.json"],
    seeds: {},
    encoding: "shift_jis",
  },
  "2007-default-battle-festival": {
    base: "https://vipkohaku.x.fc2.com/2007def/",
    manifests: ["source/archive/manifest.json"],
    seeds: {},
    encoding: "shift_jis",
  },
  "2008-summer": {
    base: "http://www.geocities.jp/viprpg_natunozin08/",
    manifests: ["source/archive/manifest.json"],
    seeds: {},
    encoding: "shift_jis",
  },
  "2008-seiyoku-festival": {
    base: "https://vipkohaku.x.fc2.com/",
    entry: "seiyoku.htm",
    manifests: ["source/archive/manifest.json"],
    seeds: { "seiyoku.htm": "source/archive/seiyoku.htm" },
    disabledLocalLinks: ["index.html"],
    encoding: "shift_jis",
  },
  "2008-kouhaku": {
    base: "https://vipkohaku.x.fc2.com/2008/",
    manifests: ["source/archive/manifest.json"],
    seeds: { "index.html": "source/archive/index.html" },
    encoding: "shift_jis",
  },
  "2011-summer": {
    base: "http://www.geocities.jp/viprpg_summer11/",
    entry: "index.htm",
    manifests: ["source/original/manifest.json"],
    seeds: { "index.htm": "investigation/original-index.bin" },
    encoding: "euc-jp",
  },
  "2011-kouhaku": {
    base: "http://vipkohaku2011.web.fc2.com/",
    manifests: ["source/recovery/manifest.json", "source/linked/manifest.json"],
    seeds: { "index.html": "investigation/index.bin" },
    frames: { menuPage: "menu_top.html", menuName: "menu", mainName: "main" },
    externalResources: {
      "http://vipkouhaku05.cs.land.to/viprpgkouhaku2009-top.png": "linked/kouhaku2005.png",
      "http://www.geocities.jp/vipkouhaku/vipkohaku_second02.png": "linked/kouhaku2006.png",
      "http://music.geocities.jp/kouhaku03_01/kouhaku2007.png": "linked/kouhaku2007.png",
      "http://vipkouhaku05.cs.land.to/vip2008.png": "linked/kouhaku2008.png",
    },
  },
  "2011-gw": {
    base: "https://vipgw2011.web.fc2.com/",
    manifests: ["source/recovery/manifest.json"],
    seeds: { "index.html": "investigation/original-live.bin" },
    encoding: "euc-jp", liveSource: true,
  },
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
  "2011-toppatsu-festival": {
    base: "https://w.atwiki.jp/toppatuviprpg/",
    manifests: ["source/original/manifest.json"],
    seeds: { "index.html": "source/original/index.html" },
    encoding: "utf-8", liveSource: true,
  },
  "2010-gw": {
    base: "https://vipkohaku.x.fc2.com/2010GW/",
    entry: "index.html",
    manifests: ["source/archive/manifest.json"],
    seeds: { "index.html": "source/archive/index.html.bin" },
    encoding: "shift_jis", liveSource: true,
  },
  "2010-kouhaku": {
    base: "https://vipkohaku20102.web.fc2.com/",
    entry: "index.html",
    manifests: ["source/original/manifest.json"],
    seeds: { "index.html": "source/original/index.html.bin", "index_entry.html": "source/original/index_entry.html", "index_green.html": "source/original/index_green.html" },
    encoding: "shift_jis", liveSource: true,
    frames: { menuPage: "menu_top.html", menuName: "menu", mainName: "main" },
  },
  "2010-summer": {
    base: "https://vipkohaku.x.fc2.com/2010s/",
    entry: "index.html",
    manifests: ["source/archive/manifest.json"],
    seeds: { "index.html": "source/archive/index.html.bin" },
    encoding: "shift_jis",
  },
  "2009-kouhaku": {
    base: "http://vipkouhaku09.web.fc2.com/",
    entry: "index.htm",
    manifests: ["source/original/manifest.json"],
    seeds: { "index.htm": "source/original/index.htm.bin" },
    encoding: "shift_jis", liveSource: true,
    preserveExternalExtensions: [".zip"],
  },
  "2009-ksgfestival": {
    base: "https://vipkohaku.x.fc2.com/2009ksg/",
    entry: "index.html",
    manifests: ["source/archive/manifest.json"],
    seeds: { "index.html": "source/archive/index.html.bin" },
    encoding: "euc-jp", liveSource: true,
    preserveExternalExtensions: [".zip"],
  },
  "2009-silver-week-miruge-festival": {
    base: "https://vipkohaku.x.fc2.com/2009miru/",
    entry: "index.html",
    manifests: ["source/archive/manifest.json"],
    seeds: { "index.html": "source/archive/index.html.bin" },
    encoding: "shift_jis", liveSource: true,
    preserveExternalExtensions: [".zip"],
  },
  "2008-gw": {
    base: "https://vipkohaku.x.fc2.com/2008GW/",
    entry: "index.html",
    manifests: ["source/archive/manifest.json"],
    seeds: { "index.html": "source/archive/index-20220428072419.bin" },
    encoding: "shift_jis",
  },
  "2008-jisaku-battle-festival": {
    base: "https://w.atwiki.jp/viprpg_battle/",
    entry: "index.html",
    manifests: ["source/archive/manifest.json", "source/live/original-view-manifest.json"],
    seeds: { "index.html": "source/archive/index-20191216100856.bin" },
    seedUrls: { "index.html": "https://w.atwiki.jp/viprpg_battle/" },
    encoding: "utf-8",
  },
  "2008-chuuni-festival": {
    base: "https://vipkohaku.x.fc2.com/2008chu/",
    entry: "index.html",
    manifests: ["source/archive/manifest.json"],
    seeds: { "index.html": "source/archive/index-20190518093109.bin" },
    encoding: "shift_jis",
  },
  "2009-summer": {
    base: "https://vipkohaku.x.fc2.com/2009s/",
    entry: "index.html",
    manifests: ["source/archive/manifest.json"],
    seeds: { "index.html": "source/archive/index-20211203045641.bin" },
    encoding: "shift_jis",
    externalResources: {
      "http://yy701.60.kg/test/read.cgi/viprpg2009summer/1243982686/": "forum/embedded-thread.html",
    },
  },
  "2009-gw": {
    base: "https://vipgw2011.web.fc2.com/vip_2009gw/",
    entry: "index.html",
    manifests: ["source/original/manifest.json"],
    seeds: { "index.html": "source/original/index.html.bin" },
    encoding: "euc-jp", liveSource: true,
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
  const omittedCssResources: Array<{ originalUrl: string; status: number }> = [];
  const omittedBackgrounds: Array<{ page: string; resource: string }> = [];
  const omittedHovers: Array<{ page: string; resource: string }> = [];
  const recovery = JSON.parse(await fs.readFile(`${root}/recovery.json`, "utf8"));
  if (["2025-gw", "2025-summer"].includes(id) || id === "2006-kouhaku" || id === "2012-toppuu-festival" || id === "2011-toppatsu-festival" || id === "2008-jisaku-battle-festival" || id === "2010-gw" || id === "2010-kouhaku" || id === "2010-summer") config.externalResources = recovery.originalResources;
  const sourceDetailGapPaths = new Set<string>((recovery.sourceDetailGaps ?? []).map((gap: { sourcePath: string }) => gap.sourcePath));
  const unavailableSourcePagePaths = new Set<string>((recovery.unavailableSourcePages ?? []).map((gap: { sourcePath: string }) => gap.sourcePath));
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
    if (id === "2011-gw" && original.pathname.startsWith("/vip_2009gw/")) return undefined;
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
    if (id === "2008-summer" && value === "index.htm") return "index.html";
    if (value.split("/").some((part) => part === "..") || value.includes("\\")) throw new Error("Unsafe original resource path");
    return value.endsWith("/") ? `${value}index.html` : value;
  }
  function enqueue(url: string, owner: string) {
    const absolute = new URL(unarchive(url), owner).href, local = relative(absolute);
    if (local && blocked.has(local)) return blocked.get(local);
    if (local && ((id === "2010-gw" && sourceDetailGapPaths.has(local)) || (["2008-jisaku-battle-festival", "2008-kouhaku", "2008-summer", "2007-default-battle-festival", "2007-gw", "2007-summer", "2006-kouhaku", "2006-summer"].includes(id) && (sourceDetailGapPaths.has(local) || unavailableSourcePagePaths.has(local))))) return local;
    if (local && /\.(?:html?|css|js|png|jpe?g|gif|bmp|webp|ico|cur|svg|mp3|wav|ogg|mid|avi|ogv|txt|zip|woff2?|ttf|eot)$/i.test(local)) {
      queue.add(absolute);
      return local;
    }
    return local && files.has(local) ? local : undefined;
  }
  function localReference(value: string, owner: string, local: string) {
    if (/^(?:data:|javascript:|mailto:)/i.test(value) || value.startsWith("#")) return value;
    const url = new URL(value, owner);
    if (config.preserveExternalExtensions?.some((extension) => url.pathname.toLowerCase().endsWith(extension.toLowerCase()))) return url.href;
    const target = enqueue(value, owner);
    return target ? (path.posix.relative(path.posix.dirname(local), target) || path.posix.basename(target)) + (config.cgiProfile && url.pathname.endsWith("/profile.cgi") ? "" : url.search) + url.hash : url.href;
  }
  function rewriteCSS(text: string, owner: string, local: string) {
    return text.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/g, (_, value) => {
      const reference = localReference(value, owner, local);
      if ((!reference || /^https?:/i.test(reference)) && id === "2008-jisaku-battle-festival") {
        const resource = new URL(value, owner);
        omittedBackgrounds.push({ page: local, resource: resource.pathname });
        return "none";
      }
      return `url("${reference}")`;
    });
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
    const resourceEncoding = config.encodingOverrides?.[local] ?? encoding;
    if (files.has(local)) continue;
    let requestedUrl: string | undefined;
    try {
      let bytes: Buffer;
      if (cached.has(local)) bytes = await fs.readFile(cached.get(local)!);
      else {
        if (!process.argv.includes("--fetch")) {
          const known = previousMissing.find((failure) => failure.url === original);
          const sourceFailure = (recovery.failures ?? []).find((failure: { sourceUrl?: string }) => failure.sourceUrl === original);
          requestedUrl = known?.requestedUrl ?? sourceFailure?.requestedUrl;
          const error = !known || known.error.includes("Missing cached resource") ? sourceFailure?.error : known.error;
          throw new Error(error?.replace(/^Error:\s*/, "") ?? "Missing cached resource; use --fetch");
        }
        const row = inventory.slice(1).find((row) => relative(row[0]) === local);
        const fallback = inventory.slice(1).find((row) => relative(row[0]) === (config.entry ?? "index.html"));
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
        const $ = cheerio.load(decodeSource(bytes, resourceEncoding));
        if (id === "2011-summer" && local.startsWith("sub/")) {
          $('link[rel*=ICON][href="picture/favicon.ico"],link[rel*=icon][href="picture/favicon.ico"]').attr("href", "../picture/favicon.ico");
          compatibilityFixes.push({ page: local, change: "Resolve the subsidiary page's template favicon against the original main catalogue's shared picture directory." });
        }
        if (id === "2011-summer" && local === "index.htm") {
          for (const gap of recovery.catalogueSlotRepairs ?? []) {
            const work = catalogue.find((w) => w.no === gap.no), a = $('a[href]').filter((_, e) => $(e).attr("href") === gap.sourcePath).first();
            if (!work || !a.length) continue;
            const row = a.closest("tr").attr("data-archive-catalogue-recovered", work.no!), cells = row.children();
            a.text(gap.sourceCatalogueTitle || work.title).attr({ href: `${gap.sharedSourcePath}#archive-entry-${work.no}`, title: "原一覧の空欄を60の陣の原一覧に基づいて補記し、実際の共用紹介ページへ接続。" }).after('<small>［編纂補記］</small>');
            cells.eq(3).text(work.source?.authorOmitted ? "未記載" : work.author);
            cells.eq(4).text(work.category || "未記載"); cells.eq(5).text(work.engine || "未記載");
            if (work.forum) cells.eq(8).find("a").attr("href", work.forum).text("掲示板（60の陣のリンク）");
            compatibilityFixes.push({ page: local, change: `Restore catalogue slot No.${work.no} from the original 60-no-jin catalogue and link its actual shared introduction column; label the repair explicitly.` });
          }
        }
        if (id === "2011-summer" && local === recovery.sharedIntroduction?.sourceDetail) {
          const headings = $("table").first().children("tbody").children("tr").first().children();
          for (const member of recovery.sharedIntroduction.members) headings.eq(member.column).attr("id", `archive-entry-${member.no}`);
          compatibilityFixes.push({ page: local, change: "Retain the complete six-column source introduction; add scoped fragment anchors for the numbered works assigned by the original subsidiary catalogue." });
        }
        if (id === "2011-summer" && local === "sub/60nojin.htm") {
          $('a[href="entry/entry0.htm"]').attr("href", "../entry/entry0.htm");
          $("table").first().children("tbody").children("tr").each((_, tr) => {
            const no = $(tr).children().eq(1).text().trim();
            if (recovery.sharedIntroduction.members.some((m: { no: string }) => m.no === no)) $(tr).find('a[href="../entry/entry60.htm"]').attr("href", `../entry/entry60.htm#archive-entry-${no}`);
          });
          compatibilityFixes.push({ page: local, change: "Repair the template's sample link against the main source catalogue and focus each entry's actual shared introduction column." });
        }
        if (id === "2011-kouhaku") {
          $("noscript").remove();
          $("script").filter((_, e) => /TWTR\.Widget|twttr/.test($(e).html() || "")).remove();
          $("a[href]").each((_, e) => {
            const a = $(e), href = a.attr("href")!;
            if (local === "entry/000.html" && href === "#") { a.removeAttr("href target"); return; }
            const target = new URL(href, original);
            if (target.hostname === base.hostname && [base.pathname, `${base.pathname}index.html`].includes(target.pathname)) a.attr({ href: new URL("index_top.html", base).href, target: local === "menu_top.html" ? "main" : "_self" });
          });
          if (local === "entry.html") {
            $("frameset").replaceWith('<body><a href="entry/entry_menu.html">作品一覧</a></body>');
            $("head").append('<meta http-equiv="refresh" content="0;url=entry/entry_menu.html">');
            compatibilityFixes.push({ page: local, change: "Flatten the invisible single-child frameset into its actual catalogue page to preserve same-frame navigation inside the sandbox." });
          }
        }
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
        if (id === "2011-toppatsu-festival" || id === "2008-jisaku-battle-festival") {
          $("script,noscript,iframe,form,body>header,body>footer,.atwiki-headbar,#atwiki-fixed-nav,#atwiki-modal-search-form,#pageTabs,#editmenu,#toolBox,#toolBoxTour,#ads,#left-ads,#right-ads,#atwiki-ads-overlay,#body_footer,#at_social_links2,[id^='div-gpt-ad-'],.atwiki-modal-bg,.atwiki-modal-wrap,.atwiki-modal,#atwiki_menubar a[href*='/pedit/']").remove();
          $("link").filter((_, e) => !($(e).attr("rel") || "").includes("stylesheet") || !/base_101default\.css|pc_common\.css|atwiki_common\.css/.test($(e).attr("href") || "")).remove();
          $("source,[srcset]").each((_, e) => { if (e.tagName === "source") $(e).remove(); else $(e).removeAttr("srcset"); });
          $("*").each((_, e) => { for (const attr of Object.keys(e.attribs)) if (attr.startsWith("on")) $(e).removeAttr(attr); });
          if (id === "2008-jisaku-battle-festival") {
            $('img[src*="b.st-hatena.com"]').remove();
            $('img[src*="/attach/"]').each((_, element) => {
              $(element).replaceWith('<span class="archive-missing-image" data-missing-resource="festival-banner" style="display:inline-block;box-sizing:border-box;padding:.75rem;border:1px dashed #7a8795;background:#f2f4f6;color:#394452;vertical-align:middle">［原资料图片未取得］</span>');
            });
          }
          $("a[href]").each((_, e) => {
            const value = $(e).attr("href")!;
            if (value.startsWith("#")) return;
            const url = new URL(value, original), mapped = config.externalResources?.[url.href];
            if (id === "2008-jisaku-battle-festival" && (url.hostname === base.hostname || url.hostname === "login.atwiki.jp")) {
              const target = url.hostname === base.hostname ? relative(url.href) : url.pathname.match(/\/viprpg_battle\/(pages\/\d+\.html)$/)?.[1];
              if (target && (cached.has(target) || files.has(target) || sourceDetailGapPaths.has(target) || unavailableSourcePagePaths.has(target))) {
                $(e).attr("href", path.posix.relative(path.posix.dirname(local), target) || path.posix.basename(target)).removeAttr("target");
              } else $(e).removeAttr("href target");
              return;
            }
            if (url.hostname === base.hostname && !mapped && !cached.has(relative(url.href) || "")) $(e).removeAttr("href target");
          });
          compatibilityFixes.push({ page: local, change: "Preserve the captured AtWiki content and source theme; remove hosting navigation, advertising, scripts and posting controls, and use local captured images and same-site page links." });
        }
        if (id === "2009-gw" && $("form").length) {
          $("form").remove();
          compatibilityFixes.push({ page: local, change: "Remove the source submission form from the offline static replay." });
        }
        if (id === "2010-gw") {
          $("script,noscript,iframe,form,object,embed,canvas").remove();
          $("img[src]").each((_, e) => {
            const url = new URL($(e).attr("src")!, original);
            if (url.hostname === "media.fc2.com" && url.pathname === "/counter_img.php") $(e).remove();
          });
          $("[srcset]").removeAttr("srcset");
          $("*").each((_, e) => { for (const attr of Object.keys(e.attribs)) if (attr.startsWith("on")) $(e).removeAttr(attr); });
          compatibilityFixes.push({ page: local, change: "Preserve the captured catalogue, one archived work page and original layout assets; remove the posting form and remote visitor counter." });
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
        if ((id === "2008-gw" || id === "2008-chuuni-festival" || id === "2009-summer") && $('img[src*="media.fc2.com/counter_img.php"]').length) {
          compatibilityFixes.push({ page: local, change: "Remove the uncaptured external visitor counter to keep the replay offline and avoid a live third-party request." });
        }
        $('img[src*="media.fc2.com/counter_img.php"]').remove();
        $('img[src*="netriver.jp/countriver/"]').remove();
        if (id === "2008-gw" || id === "2008-chuuni-festival" || id === "2009-summer" || id === "2008-kouhaku" || id === "2008-seiyoku-festival" || id === "2008-summer" || id === "2007-default-battle-festival" || id === "2007-gw" || id === "2007-summer" || id === "2006-gw" || id === "2006-kouhaku" || id === "2006-summer" || id === "2005-kouhaku" || ["2025-gw", "2025-summer"].includes(id)) {
          const activeElements = $("script,noscript,form,object,embed").length;
          $("script,noscript,form,object,embed").remove();
          const unarchivedLoads = $("img[src],iframe[src],link[rel~='stylesheet'][href],video[src],audio[src],source[src]").toArray().filter((element) => {
            const attribute = element.tagName === "link" ? "href" : "src";
            const value = $(element).attr(attribute);
            return !value || !relative(new URL(value, original).href);
          });
          for (const element of unarchivedLoads) $(element).remove();
          $("*").each((_, element) => {
            for (const attribute of Object.keys(element.attribs)) if (attribute.startsWith("on")) $(element).removeAttr(attribute);
          });
          if (activeElements || unarchivedLoads.length) compatibilityFixes.push({ page: local, change: `Remove ${activeElements} script or active-control elements and ${unarchivedLoads.length} uncaptured external auto-load resources from the static replay.` });
        }
        $("meta[charset]").attr("charset", "UTF-8");
        $("meta[http-equiv]").each((_, element) => {
          if ($(element).attr("http-equiv")?.toLowerCase() === "content-type") $(element).attr("content", "text/html; charset=UTF-8");
        });
        if (!$("meta[charset]").length && !$("meta[http-equiv]").toArray().some((element) => $(element).attr("http-equiv")?.toLowerCase() === "content-type")) $("head").prepend('<meta charset="UTF-8">');
        if (id === "2009-silver-week-miruge-festival") {
          const scriptCount = $("script,noscript").length;
          $("script,noscript").remove();
          if (scriptCount) compatibilityFixes.push({ page: local, change: "Remove source scripts and noscript tracking from the static replay; preserve the captured markup, styles and links." });
        }
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
        if (["2025-gw", "2025-summer"].includes(id)) {
          if (id === "2025-summer") $('link[rel="manifest"]').remove();
          if (id === "2025-summer" && local === "index.html") {
            let labelled = 0;
            $('a[href]').each((_, element) => {
              const node = $(element), target = relative(new URL(node.attr('href')!, original).href);
              if (!target?.startsWith('rate/') || !target.endsWith('.html') || !cached.has(target) || node.text().trim() || node.children().length) return;
              node.text('［投稿］').attr({ 'data-archive-note': 'empty-source-link', title: '原リンクに表示文字がないため補記した投稿ページへの案内。' });
              labelled++;
            });
            if (labelled) compatibilityFixes.push({ page: local, change: `Add an explicitly annotated short label to ${labelled} empty source anchors targeting captured submission pages; preserve the original raw HTML separately.` });
          }
          if (local === "screenshots.html" && recovery.screenshotOverview?.appendSourceFile) {
            const page = JSON.parse(await fs.readFile(`${root}/${recovery.screenshotOverview.appendSourceFile}`, "utf8"));
            $(".screenshot_grid_widget").append(page.content);
            $(".grid_loader,.next_page").remove();
            compatibilityFixes.push({ page: local, change: `Append the captured final screenshot batch to the original grid. Preserve its ${recovery.screenshotOverview.totalItems} source cells independently of the project gallery images.` });
          }
          $("[data-background_image]").each((_, element) => {
            const node = $(element), source = node.attr("data-background_image");
            if (source) node.attr("style", `${node.attr("style") || ""};background-image:url(${JSON.stringify(source)})`).removeAttr("data-background_image");
          });
          $("script,noscript,form,object,embed").remove();
          $("img").each((_, image) => {
            const node = $(image);
            const source = node.attr("src") || node.attr("data-lazy_src") || node.attr("data-src") || node.attr("srcset")?.split(",")[0].trim().split(/\s+/)[0];
            if (source) node.attr("src", source);
            else node.remove();
            node.removeAttr("srcset data-lazy_src data-src");
          });
          $('link[rel="preconnect"],link[rel="dns-prefetch"],link[rel="preload"][as="script"]').remove();
          compatibilityFixes.push({ page: local, change: "Render captured lazy image URLs without platform JavaScript; use the stored desktop image source and keep scripts/forms inactive in the static reading copy." });
        }
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
        if (id === "2006-summer" && local === "fure-m.htm") {
          $("head").append('<style data-archive-menu-spacing>body>div[style*="absolute"]>p{margin:0;line-height:20px}</style>');
          compatibilityFixes.push({ page: local, change: "Remove default paragraph margins in the menu absolute-positioned rows. A 56px high layer at z-index 28 overlapped the No.17 and No.18 links at z-index 13; a 20px line box follows the source row spacing and restores pointer access." });
        }
        // Opaque sandbox origins prevent the legacy menu from navigating its sibling frame.
        const menuFrameSelector = config.frames && (config.frames.menuName ? `frame[name="${config.frames.menuName}"]` : 'frame:not([name]),frame[name=""]');
        const mainFrameSelector = config.frames && `frame[name="${config.frames.mainName}"]`;
        if (menuFrameSelector && mainFrameSelector && $(menuFrameSelector).length && $(mainFrameSelector).length) $("head").append(`<script>
          addEventListener('message',function(event){
            var menu=document.querySelector(${JSON.stringify(menuFrameSelector)}),main=document.querySelector(${JSON.stringify(mainFrameSelector)});
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
        let css = decodeSource(bytes, resourceEncoding).replace(/@charset\s+["'][^"']+["'];/i, '@charset "UTF-8";');
        if (id === "2011-toppatsu-festival") {
          const unavailableCss = new Set((recovery.cssResourceFailures ?? []).map((failure: { originalUrl: string }) => failure.originalUrl));
          css = css.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/g, (literal, value) => {
            let url: string;
            try { url = new URL(value, original).href; } catch { return literal; }
            if (!unavailableCss.has(url)) return literal;
            compatibilityFixes.push({ page: local, change: `Omit unavailable AtWiki CSS image ${url}; the 403 response is documented without a replacement image.` });
            const failure = (recovery.cssResourceFailures ?? []).find((item: { originalUrl: string }) => item.originalUrl === url);
            if (failure && !omittedCssResources.some((item) => item.originalUrl === url)) omittedCssResources.push({ originalUrl: url, status: failure.status });
            return "none";
          });
        }
        bytes = Buffer.from(rewriteCSS(css, original, local));
      } else if (/\.js$/i.test(local)) {
        let code = decodeSource(bytes, resourceEncoding);
        if (id === "2012-summer") code = rewriteSummer2012Source(code, local, (value) => localReference(value, original, local), (recovery.failures ?? []).map((f: { sourceUrl: string }) => f.sourceUrl.match(/\/ss\/no(\d+)\./)?.[1]).filter(Boolean).map(Number));
        bytes = Buffer.from(rewriteAbsoluteStrings(code, original, local));
      }
      files.set(local, bytes);
    } catch (error) { failures.push({ url: original, requestedUrl, error: String(error) }); }
  }
  const unavailable = new Set(failures.map((failure) => relative(failure.url)));
  if (id === "2009-summer" || id === "2008-kouhaku") for (const [local, bytes] of files) if (/\.css$/i.test(local)) {
    let omitted = 0;
    const css = bytes.toString("utf8").replace(/url\(\s*["']?([^"')]+)["']?\s*\)/g, (literal, value) => {
      const resource = relative(new URL(value, new URL(local, base)).href);
      if (!resource || !unavailable.has(resource)) return literal;
      omittedBackgrounds.push({ page: local, resource }); omitted += 1;
      return "none";
    });
    if (omitted) {
      files.set(local, Buffer.from(css));
      compatibilityFixes.push({ page: local, change: `Remove ${omitted} unavailable background resource reference(s) from the offline stylesheet.` });
    }
  }
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
    if (id === "2009-gw") $("link[rel*=stylesheet][href]").each((_, element) => {
      const node = $(element), resource = relative(new URL(node.attr("href")!, new URL(local, base)).href);
      if (!resource || !unavailable.has(resource)) return;
      node.remove();
      compatibilityFixes.push({ page: local, change: `Omit unavailable source stylesheet ${resource}; the direct 404 and empty CDX result are documented.` });
    });
    if (id === "2009-gw") $("link[rel]").each((_, element) => {
      const node = $(element);
      if (!(node.attr("rel") ?? "").toLowerCase().includes("icon")) return;
      const resource = relative(new URL(node.attr("href")!, new URL(local, base)).href);
      if (!resource || !unavailable.has(resource)) return;
      node.remove();
      compatibilityFixes.push({ page: local, change: `Omit unavailable source icon ${resource}; the direct 404 and empty CDX result are documented.` });
    });
    $("[onmouseover],[onmouseout]").each((_, element) => {
      for (const attr of ["onmouseover", "onmouseout"]) for (const match of ($(element).attr(attr) || "").matchAll(/this\.src\s*=\s*['"]([^'"]+)['"]/g)) {
        const resource = relative(new URL(match[1], new URL(local, base)).href);
        if (resource && unavailable.has(resource)) { $(element).removeAttr(attr); omittedHovers.push({ page: local, resource }); }
      }
    });
    if (id === "2011-kouhaku") $("img[src]").each((_, element) => {
      const node = $(element), resource = relative(new URL(node.attr("src")!, new URL(local, base)).href);
      if (!resource || !unavailable.has(resource)) return;
      const entry = (recovery.entries ?? []).find((e: { sourcePath: string }) => e.sourcePath === local);
      const replacement: string | undefined = entry?.gallerySources?.map((u: string) => relative(u)).find((p: string) => files.has(p));
      if (resource.startsWith("entry/ss/") && replacement) {
        node.attr("src", path.posix.relative(path.posix.dirname(local), replacement)).removeAttr("onmouseover onmouseout");
        node.after('<small class="archive-source-note">［原表示画像は未取得のため、同じ紹介ページの保存済み切替画像を表示］</small>');
        compatibilityFixes.push({ page: local, change: `Use the same source page's available hover image ${replacement} where ${resource} is unavailable, with an explicit archive note.` });
      } else {
        const screenshot = resource.startsWith("entry/ss/");
        node.replaceWith(`<span class="archive-missing-image" data-missing-resource="${resource}" style="display:inline-block;${screenshot ? "padding:2em;border:1px dashed #888;max-width:90%" : "font-size:10px"}">［${screenshot ? "原資料の画像は未取得です" : "画像未取得"}］</span>`);
        compatibilityFixes.push({ page: local, change: `Replace the broken image ${resource} with a fixed missing-source notice, without invented artwork.` });
      }
    });
    if (id === "2008-chuuni-festival" || id === "2009-summer" || id === "2008-kouhaku" || id === "2008-summer" || id === "2007-summer") {
      $("link[rel*=stylesheet][href]").each((_, element) => {
        const node = $(element), resource = relative(new URL(node.attr("href")!, new URL(local, base)).href);
        if (!resource || !unavailable.has(resource)) return;
        node.remove();
        compatibilityFixes.push({ page: local, change: `Omit unavailable source stylesheet ${resource}; direct requests and both scheme-specific CDX lookups found no usable capture.` });
      });
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
      $("img[src]").each((_, element) => {
        const node = $(element), resource = relative(new URL(node.attr("src")!, new URL(local, base)).href);
        if (!resource || !unavailable.has(resource)) return;
        node.replaceWith(`<span class="archive-missing-image" data-missing-resource="${resource}" style="display:inline-block;box-sizing:border-box;padding:.75rem;border:1px dashed #7a8795;background:#f2f4f6;color:#394452;vertical-align:middle">［原資料の画像は未取得です］</span>`);
        compatibilityFixes.push({ page: local, change: `Replace unavailable source image ${resource} with a compact, labelled placeholder.` });
      });
    }
    if (id === "2010-summer" || id === "2009-silver-week-miruge-festival") $("img[src]").each((_, element) => {
      const node = $(element), resource = relative(new URL(node.attr("src")!, new URL(local, base)).href);
      if (!resource || !unavailable.has(resource)) return;
      node.replaceWith('<span class="archive-missing-image">［原資料の画像は未取得です］</span>');
      compatibilityFixes.push({ page: local, change: `Replace the uncaptured source image ${resource} with a neutral missing-source notice.` });
    });
    if (id === "2010-gw") $("img[src]").each((_, element) => {
      const node = $(element), resource = relative(new URL(node.attr("src")!, new URL(local, base)).href);
      if (!resource || !unavailable.has(resource)) return;
      node.replaceWith('<span class="archive-missing-image">［原資料のスクリーンショット未取得］</span>');
      compatibilityFixes.push({ page: local, change: `Replace the unavailable archived screenshot ${resource} with a clearly labelled source-gap notice; add no replacement image.` });
    });
    if (id === "2010-gw") $("a[href]").each((_, element) => {
      const node = $(element), resource = relative(new URL(node.attr("href")!, new URL(local, base)).href);
      if (!resource || !unavailable.has(resource)) return;
      node.removeAttr("href target").attr({ "data-missing-resource": resource, title: "リンク先の原資料は取得できませんでした" }).append("［未取得］");
      compatibilityFixes.push({ page: local, change: `Label the unavailable source link ${resource} instead of leaving a broken local URL.` });
    });
    if (id === "2011-kouhaku") $("a[href]").each((_, element) => {
      const node = $(element), resource = relative(new URL(node.attr("href")!, new URL(local, base)).href);
      if (resource && unavailable.has(resource)) {
        node.removeAttr("href target").attr({ "data-missing-resource": resource, title: "リンク先の原資料は未取得です" }).append("［未取得］");
        compatibilityFixes.push({ page: local, change: `Label the unavailable linked source ${resource} instead of navigating to a broken local URL.` });
      }
    });
    if (id === "2011-gw" || id === "2011-kouhaku") $("link[rel*=icon][href],link[rel*=stylesheet][href]").each((_, element) => {
      const resource = relative(new URL($(element).attr("href")!, new URL(local, base)).href);
      if (resource && unavailable.has(resource)) {
        $(element).remove();
        compatibilityFixes.push({ page: local, change: "Omit an unavailable stylesheet or favicon reference; the source inline styling remains in place and the missing resource stays documented." });
      }
    });
    if (["2010-gw", "2012-kouhaku", "2011-gw", "2011-kouhaku", "2010-summer", "2009-kouhaku", "2009-ksgfestival", "2009-silver-week-miruge-festival", "2009-summer", "2008-gw", "2008-jisaku-battle-festival", "2008-chuuni-festival", "2009-gw", "2008-kouhaku", "2008-seiyoku-festival", "2008-summer", "2007-default-battle-festival", "2007-gw", "2007-summer", "2006-gw", "2006-kouhaku", "2006-summer", "2005-kouhaku", "2025-gw", "2025-summer"].includes(id) || [...omittedBackgrounds, ...omittedHovers].some((omission) => omission.page === local)) files.set(local, Buffer.from($.html()));
  }
  const generatedUnavailablePages: string[] = [];
  if (["2011-gw", "2010-gw", "2009-ksgfestival", "2008-chuuni-festival", "2008-jisaku-battle-festival", "2008-kouhaku", "2008-summer", "2007-default-battle-festival", "2007-gw", "2007-summer", "2006-kouhaku", "2006-summer"].includes(id)) for (const gap of recovery.sourceDetailGaps ?? []) {
    const work = catalogue.find((work) => work.no === gap.no);
    if (!work || files.has(gap.sourcePath)) continue;
    const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const downloads = work.downloads ?? (work.download ? [work.download] : []);
    const cataloguePath = work.source?.titleUrl ? relative(work.source.titleUrl) : undefined;
    const returnPath = cataloguePath && files.has(cataloguePath) ? cataloguePath : config.entry ?? "index.html";
    const backHref = path.posix.relative(path.posix.dirname(gap.sourcePath), returnPath);
    files.set(gap.sourcePath, Buffer.from(`<!doctype html><html lang="ja"><meta charset="UTF-8"><title>No.${escape(work.no)} ${escape(work.title)} — 原紹介ページ未取得</title>
      <style>body{max-width:800px;margin:2em auto;padding:0 1em;font-family:sans-serif;line-height:1.6}.note{padding:1em;border:1px solid #aab;background:#f0f3f7}dt{font-weight:bold}dd{margin-bottom:1em}</style>
      <body data-archive-source-unavailable="${escape(work.no)}"><p class="note">編纂補頁：原紹介ページは取得できていません。この画面は祭典の作品一覧に基づく案内で、原紹介ページの復元ではありません。</p>
      <h1>No.${escape(work.no)} ${escape(work.title)}</h1>${work.banner && !work.contentRestricted ? `<img src="${escape(work.banner.src)}" width="${work.banner.width}" height="${work.banner.height}" style="max-width:100%;height:auto" alt="">` : ""}${work.icon ? `<img src="${escape(work.icon)}" width="32" height="32" alt="">` : ""}
      <dl><dt>作者</dt><dd>${escape(work.author)}</dd>${work.group ? `<dt>組</dt><dd>${escape(work.group)}</dd>` : ""}<dt>ツール</dt><dd>${escape(work.engine || "")}</dd><dt>作者コメント</dt><dd>原紹介ページ未取得</dd><dt>管理人コメント</dt><dd>原紹介ページ未取得</dd><dt>スクリーンショット</dt><dd>${work.ss?.length ? work.ss.map((src) => `<img src="${escape(src)}" style="max-width:100%;height:auto" alt="保存済み画像">`).join("") : "未取得"}</dd></dl>
      ${downloads.map((d) => `<p><a href="${escape(d.url)}">${escape(d.label || "Download")}</a>（作品一覧掲載の過去の入口）</p>`).join("")}
      ${work.source?.titleUrl ? `<p><a href="${escape(work.source.titleUrl)}">公式の一覧資料</a></p>` : ""}<p><a href="${escape(backHref)}">作品一覧へ戻る</a></p></body></html>`));
    generatedUnavailablePages.push(gap.sourcePath);
    compatibilityFixes.push({ page: gap.sourcePath, change: "Generated labelled catalogue-only fallback for an unavailable original introduction. Original comments and screenshot are not invented; the source gap remains documented." });
  }
  if (id === "2008-chuuni-festival" || id === "2008-jisaku-battle-festival" || id === "2008-kouhaku" || id === "2008-summer" || id === "2007-summer" || id === "2006-kouhaku" || id === "2006-summer") for (const gap of recovery.unavailableSourcePages ?? []) {
    if (files.has(gap.sourcePath)) continue;
    const sample = gap.no === "000";
    const heading = sample ? "No.000 — 原ページ未取得" : "原ページ未取得";
    const returnToPatchOwner = id === "2006-summer" && gap.sourcePath === "no6patti.htm";
    const backHref = path.posix.relative(path.posix.dirname(gap.sourcePath), returnToPatchOwner ? "ss6.htm" : (id === "2006-kouhaku" || id === "2006-summer") ? "top.htm" : config.entry ?? "index.html");
    files.set(gap.sourcePath, Buffer.from(`<!doctype html><html lang="ja"><meta charset="UTF-8"><title>${heading}</title>
      <style>body{max-width:800px;margin:2em auto;padding:0 1em;font-family:sans-serif;line-height:1.6}.note{padding:1em;border:1px solid #aab;background:#f0f3f7}</style>
      <body data-archive-source-unavailable="${sample ? "sample" : "page"}"><main><h1>${heading}</h1><p class="note">このページの保存済み本文は見つかっていません。原資料の内容は補わず、一覧にあった番号とページ構造だけを残しています。</p><p><a href="${backHref}">${returnToPatchOwner ? "作品ページへ戻る" : "一覧へ戻る"}</a></p></main></body></html>`));
    generatedUnavailablePages.push(gap.sourcePath);
    compatibilityFixes.push({ page: gap.sourcePath, change: sample ? "Create a neutral local shell for the linked No.000 sample page; do not add it to the 24 registered works." : "Create a neutral local shell for an uncaptured auxiliary source page; preserve its local route without fabricating contents." });
  }
  if (id === "2009-kouhaku" && failures.some((failure) => new URL(failure.url).pathname === "/handin.htm")) {
    files.set("handin.htm", Buffer.from(`<!doctype html><html lang="zh-Hans"><meta charset="UTF-8"><title>原页面未取得</title><main><h1>原页面未取得</h1><p>日本节点下的源站请求返回 404；香港节点下的 Wayback 精确 URL 查询没有成功快照。</p><p><a href="index.htm">返回原站入口</a></p></main></html>`));
    generatedUnavailablePages.push("handin.htm");
    compatibilityFixes.push({ page: "handin.htm", change: "Create a labelled neutral page for a source 404 with no successful Hong Kong-node Wayback capture; do not present the remote error page as source content." });
  }
  if (["2009-kouhaku", "2009-ksgfestival", "2009-silver-week-miruge-festival"].includes(id) && config.preserveExternalExtensions?.includes(".zip")) {
    compatibilityFixes.push({ page: id === "2009-kouhaku" ? "sakuhin_list2.htm" : "index.html", change: "Keep source-listed game-package links at their direct external source URLs; do not copy the packages into the archive." });
  }
  if (id === "2008-kouhaku") for (const [local, bytes] of files) if (/\.html?$/i.test(local)) {
    const $ = cheerio.load(bytes.toString("utf8"));
    $("head").append('<style data-archive-desktop-fit>img{max-width:100%;height:auto}</style>');
    $('body[data-archive-source-unavailable] a[href="index.html"],body[data-archive-source-unavailable] a[href="../index.html"]').attr({ href: "sakuhin_frame.html", target: "frame2" });
    $("head").append(`<script data-archive-local-navigation>
      (function(){
        function valid(data){if(!data||data.type!=='archive-frame-navigation'||!/^frame[1-4]$/.test(data.target))return false;try{var u=new URL(data.url);return u.origin===location.origin&&u.pathname.startsWith('/original-pages/2008-kouhaku/')}catch(e){return false}}
        function route(data){var f=document.querySelector('frame[name="'+data.target+'"]');if(f)f.src=data.url;else if(parent!==window)parent.postMessage(data,'*')}
        addEventListener('message',function(e){var child=false;for(var i=0;i<frames.length;i++)if(frames[i]===e.source)child=true;if(child&&valid(e.data))route(e.data)});
        addEventListener('click',function(e){var a=e.target.closest('a[target]');if(!a)return;var d={type:'archive-frame-navigation',target:a.target,url:a.href};if(valid(d)){e.preventDefault();route(d)}});
      })();
    </script>`);
    files.set(local, Buffer.from($.html()));
  }
  if (id === "2008-kouhaku") compatibilityFixes.push({ page: "*.html", change: "Forward local named-frame navigation through the sandbox's nested frames, and constrain images to their existing frame width while preserving aspect ratio and natural size on wider desktop panes." });
  if (id === "2008-summer") compatibilityFixes.push({ page: "Work_list.htm", change: "Route the source catalogue's index.htm home link to the recovered root entry index.html." });
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
  const hasDocumentedOmissions = generatedUnavailablePages.length > 0 || failures.length > 0 || omittedCssResources.length > 0 || omittedBackgrounds.length > 0 || omittedHovers.length > 0;
  views[id] = { entry: `/original-pages/${id}/${config.entry ?? "index.html"}`, status: hasDocumentedOmissions ? "available-with-documented-omissions" : "available" };
  await writeJson(viewsPath, views);
  await writeJson(`${root}/original-view.json`, { festivalId: id, sourceEncoding: encoding, entry: views[id].entry, sourceManifests: config.manifests, sourcePages: config.seeds, files: [...files.keys()], generatedPlaceholders, ...(generatedUnavailablePages.length ? { generatedUnavailablePages } : {}), preloadResources, missingResources: failures, omittedCssResources, omittedBackgrounds, omittedHovers, compatibilityFixes, changes: [`Original HTML and CSS normalized from ${encoding} to UTF-8.`, "Same-site links, CSS resources and absolute script/hover URLs use local paths.", "External hosting trackers removed; unavailable unused preloads replaced with an empty image.", "Original pages are displayed inside a sandboxed frame.", ...(omittedCssResources.length ? ["Unavailable AtWiki CSS images are omitted without replacements and documented from their recorded 403 responses."] : []), ...(omittedBackgrounds.length ? ["Unavailable background references are omitted; the original background colors are retained and missing resources remain documented."] : []), ...(restrictions.length ? ["Restricted entries retain their catalogue row and full detail structure with fixed neutral text and generated placeholders; original restricted descriptions, media and related links are not published."] : []), ...(config.frames ? ["A scoped local message forwards menu clicks to the sibling frame while preserving the original frameset and sandbox isolation."] : [])], desktopReview: "pending" });
  console.log(`${id}: ${files.size} files; ${failures.length} missing resources.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
