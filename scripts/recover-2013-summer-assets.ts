import fs from "node:fs/promises";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import { imageExtension, writeJson } from "./recover-entry-table";

const root = "catch/2013-summer", cache = `${root}/source/recovery`;
const base = "http://www.geocities.jp/viprpgsummer2013/";
type Capture = { originalUrl: string; requestedUrl: string; actualUrl: string; contentType?: string | null; retrievedAt?: string };

async function main() {
  const manifestPath = `${cache}/manifest.json`;
  const manifest: Record<string, Capture> = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const inventory: string[][] = JSON.parse(await fs.readFile(`${root}/investigation/original-timemap.bin`, "utf8"));
  const resources = new Map<string, string[]>();
  const pages = Object.entries(manifest).filter(([file]) => file.endsWith(".html.bin")).map(([file, meta]) => ({ file: `${cache}/${file}`, original: meta.originalUrl, capture: meta.actualUrl }));
  if (pages.length !== 72) throw new Error(`Expected 72 cached details, found ${pages.length}`);
  for (const file of ["index", "main", "menu"]) {
    const meta = JSON.parse(await fs.readFile(`${root}/investigation/${file}.json`, "utf8"));
    pages.push({ file: `${root}/investigation/${file}.bin`, original: meta.originalUrl, capture: meta.actualUrl });
  }
  for (const page of pages) {
    const $ = cheerio.load(iconv.decode(await fs.readFile(page.file), "shift_jis"));
    const refs = $("img[src],[background]").toArray().map((e) => $(e).attr("src") || $(e).attr("background")!);
    for (const img of $("img").toArray()) for (const attr of ["onmouseover", "onmouseout"]) for (const match of $(img).attr(attr)?.matchAll(/this\.src\s*=\s*['"]([^'"]+)['"]/g) ?? []) refs.push(match[1]);
    for (const ref of refs) {
      const url = new URL(ref, page.original).href;
      if (!url.startsWith(base) || !/\.(?:png|gif|jpe?g|bmp|ico|webp)$/i.test(new URL(url).pathname)) continue;
      resources.set(url, [...new Set([...(resources.get(url) || []), page.capture])]);
    }
  }
  const list = [...resources], failures: Array<{ originalUrl: string; attempts: Array<{ url: string; error: string }> }> = [];
  const concurrency = process.argv.includes("--serial") ? 1 : 3;
  for (let offset = 0; offset < list.length; offset += concurrency) {
    await Promise.all(list.slice(offset, offset + concurrency).map(async ([original, owners]) => {
      const filename = `asset-${new URL(original).pathname.slice(new URL(base).pathname.length).replace(/[^\w.-]/g, "_")}.bin`;
      if (manifest[filename]?.originalUrl === original && await fs.access(`${cache}/${filename}`).then(() => true, () => false)) return;
      const row = inventory.slice(1).find((r) => new URL(r[0]).href === original);
      const timestamps = row ? [row[2], row[1]] : owners.map((owner) => owner.match(/\/web\/(\d+)/)?.[1]);
      const attempts = [];
      for (const timestamp of [...new Set(timestamps.filter(Boolean))]) {
        const url = `https://web.archive.org/web/${timestamp}id_/${row?.[0] || original}`;
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const bytes = Buffer.from(await response.arrayBuffer());
          imageExtension(bytes);
          await fs.writeFile(`${cache}/${filename}`, bytes);
          manifest[filename] = { originalUrl: original, requestedUrl: url, actualUrl: response.url, contentType: response.headers.get("content-type"), retrievedAt: new Date().toISOString() };
          return;
        } catch (error) { attempts.push({ url, error: `${String(error)} ${String((error as Error & { cause?: unknown }).cause || "")}`.trim() }); }
      }
      failures.push({ originalUrl: original, attempts });
    }));
    await writeJson(manifestPath, manifest);
    await writeJson(`${root}/asset-review.json`, { resources: list.length, failures, checked: Math.min(offset + concurrency, list.length), scope: "Raw source assets only; no catalogue or public files changed." });
    if (offset % 30 === 0) console.log(`Assets ${Math.min(offset + concurrency, list.length)}/${list.length}`);
  }
  console.log(`Checked ${list.length} source assets; ${failures.length} pending.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
