import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import { imageExtension, writeJson } from "./recover-entry-table";
import { readStaticStringArray, replaceStaticArray } from "./source-static-array";
import { getDictionary } from "../src/lib/i18n";

async function main() {
  const id = "2015-summer", root = `catch/${id}`;
  const output = `public/original-pages/${id}`;
  const sourceBase = "http://viprpgsum15.webcrow.jp/";
  await fs.mkdir(output, { recursive: true });
  const copied = new Set<string>(), missing: string[] = [];
  const externalImages: { entries?: Array<{ sourceUrl: string; cacheFile?: string; status: string }> } = JSON.parse(await fs.readFile(`${root}/external-image-recovery.json`, "utf8").catch(() => "{}"));
  async function copy(original: string, cacheFile: string) {
    const url = new URL(original);
    if (url.hostname !== new URL(sourceBase).hostname) return;
    const relative = decodeURIComponent(url.pathname.slice(1));
    if (relative.startsWith("../") || relative.split("/").includes("..")) throw new Error("Unsafe source asset path");
    if (/^(?:ss|icon)\/4(?:\D|$)/.test(relative)) throw new Error("Restricted media cannot be published");
    await fs.mkdir(path.dirname(`${output}/${relative}`), { recursive: true });
    await fs.copyFile(cacheFile, `${output}/${relative}`);
    copied.add(relative);
  }
  const media = JSON.parse(await fs.readFile(`${root}/source/recovery/manifest.json`, "utf8"));
  for (const [filename, metadata] of Object.entries(media) as Array<[string, { requestedUrl: string }]>) {
    const original = metadata.requestedUrl.replace(/^https?:\/\/web\.archive\.org\/web\/\d+[a-z_]*\/(https?:\/\/)/, "$1");
    await copy(original, `${root}/source/recovery/${filename}`);
  }
  const recovered = JSON.parse(await fs.readFile(`${root}/image-recovery.json`, "utf8"));
  for (const item of recovered.entries) if (item.status === "recovered") await copy(item.sourceUrl, item.cacheFile);
  const inventory: string[][] = JSON.parse(await fs.readFile(`${root}/investigation/original-timemap.bin`, "utf8"));
  const cacheDir = `${root}/source/original-view`;
  await fs.mkdir(cacheDir, { recursive: true });
  for (const row of inventory.slice(1).filter((row) => row[3].startsWith("image/") && /^\/[^/]+$/.test(new URL(row[0]).pathname))) {
    const filename = new URL(row[0]).pathname.slice(1), cacheFile = `${cacheDir}/${filename}.bin`;
    let bytes = await fs.readFile(cacheFile).catch(() => undefined);
    if (!bytes) {
      const url = `https://web.archive.org/web/${row[2] || row[1]}id_/${row[0]}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) { missing.push(row[0]); continue; }
      bytes = Buffer.from(await response.arrayBuffer());
      imageExtension(bytes);
      await fs.writeFile(cacheFile, bytes);
    }
    await copy(row[0], cacheFile);
  }
  const data = iconv.decode(await fs.readFile(`${root}/investigation/data.bin`), "shift_jis");
  const values = readStaticStringArray(data, "game");
  const restricted = getDictionary("ja");
  const restrictedLabel = "非表示";
  for (const column of [6, 7]) values[4 * 14 + column] = "";
  for (const column of [8, 9, 13]) values[4 * 14 + column] = restricted.restrictedContentText;
  for (const column of [4, 5]) values[4 * 14 + column] = restrictedLabel;
  for (const column of [10, 11]) values[4 * 14 + column] = ".svg";
  values[4 * 14 + 12] = "no";
  await fs.writeFile(`${output}/data.js`, replaceStaticArray(data, "game", values));
  const table = iconv.decode(await fs.readFile(`${root}/investigation/main_table.bin`), "shift_jis");
  if (!/function\s+tmain\s*\(i\)\s*\{/.test(table)) throw new Error("Unexpected source renderer");
  await fs.writeFile(`${output}/main_table.js`, table);
  const detail = iconv.decode(await fs.readFile(`${root}/investigation/main_ss.bin`), "shift_jis")
    .replace(/https?:\/\/viprpgsum15\.webcrow\.jp\/?(?=["' >])/g, "index.html")
    + `\nif(Number(location.search.slice(1).split('&')[0])===4){document.querySelectorAll('a[href=""]').forEach(function(a){a.replaceWith(document.createTextNode(${JSON.stringify(restrictedLabel)}));});}\n`;
  await fs.writeFile(`${output}/main_ss.js`, detail);
  const generatedPlaceholders = ["icon/4.svg", "ss/4.svg"];
  for (const file of generatedPlaceholders) {
    const small = file.startsWith("icon/");
    await fs.mkdir(path.dirname(`${output}/${file}`), { recursive: true });
    await fs.writeFile(`${output}/${file}`, `<svg xmlns="http://www.w3.org/2000/svg" width="${small ? 32 : 640}" height="${small ? 32 : 480}" viewBox="0 0 ${small ? "32 32" : "640 480"}"><rect width="100%" height="100%" fill="#eef1f4" stroke="#c6cdd5"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#536174" font-family="sans-serif" font-size="${small ? 22 : 24}">${small ? "◇" : restricted.restrictedContent}</text></svg>`);
  }
  const css = iconv.decode(await fs.readFile(`${root}/investigation/css1.bin`), "shift_jis").replace(/@charset\s+["'][^"']+["'];/i, '@charset "UTF-8";');
  await fs.writeFile(`${output}/css1.css`, css);
  for (const [target, cache] of [["index.html", "archive-index"], ["sakuhin.html", "detail-template"]]) {
    const $ = cheerio.load(iconv.decode(await fs.readFile(`${root}/investigation/${cache}.bin`), "shift_jis"));
    $("meta[charset]").attr("charset", "utf-8");
    $('meta[http-equiv="content-type"]').attr("content", "text/html; charset=UTF-8");
    $("script[src]").each((_, element) => {
      const src = $(element).attr("src") ?? "";
      if (!["data.js", "main_table.js", "main_ss.js"].includes(src)) $(element).remove();
    });
    for (const element of $("img[src]").toArray()) {
      const src = $(element).attr("src")!;
      if (/^(?:https?:)?\/\//.test(src)) {
        const recovered = externalImages.entries?.find((entry) => entry.status === "recovered" && new URL(entry.sourceUrl).href === new URL(src, sourceBase).href);
        if (recovered?.cacheFile) {
          const bytes = await fs.readFile(recovered.cacheFile);
          const filename = `linked/${path.parse(new URL(src, sourceBase).pathname).name}.${imageExtension(bytes)}`;
          await fs.mkdir(path.dirname(`${output}/${filename}`), { recursive: true });
          await fs.writeFile(`${output}/${filename}`, bytes);
          copied.add(filename);
          $(element).attr("src", filename);
        } else {
          missing.push(src);
          $(element).replaceWith($(element).attr("alt") ?? "");
        }
      }
    }
    await fs.writeFile(`${output}/${target}`, $.html());
  }
  const manifestPath = "src/data/original-views.json";
  const views = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  views[id] = { entry: `/original-pages/${id}/index.html`, status: "available-with-documented-omissions" };
  await writeJson(manifestPath, views);
  await writeJson(`${root}/original-view.json`, { festivalId: id, entry: views[id].entry, sourceFiles: ["archive-index", "detail-template", "data", "main_table", "main_ss", "css1"].map((name) => `${root}/investigation/${name}.bin`), copiedAssets: [...copied], generatedPlaceholders, missingResources: missing, changes: ["Text encoding normalized to UTF-8 without changing layout.", "External tracking scripts are not included.", "Restricted entry No.04 retains its list row and detail structure with fixed neutral text and generated image placeholders; original restricted descriptions, media and links are not copied.", "Original scripts execute only inside a sandboxed frame."], desktopReview: "pending" });
  console.log(`Built original view with ${copied.size} local resources; ${missing.length} external or unavailable resources documented.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
