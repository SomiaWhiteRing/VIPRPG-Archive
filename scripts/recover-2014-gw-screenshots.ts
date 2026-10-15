import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import type { WorkEntry } from "../src/lib/types";

const root = "catch/2014-gw";
const reportPath = `${root}/screenshot-recovery.json`;
const cacheDir = `${root}/source/live-screenshots`;

async function main() {
  await fs.mkdir(cacheDir, { recursive: true });
  const previous = JSON.parse(await fs.readFile(reportPath, "utf8").catch(() => "{}"));
  const pending = JSON.parse(await fs.readFile(`${root}/recovery.json`, "utf8"));
  const queue: Array<{ owner: string; url: string }> = previous.queue ?? pending.failures;
  const works: WorkEntry[] = JSON.parse(await fs.readFile("src/data/works/2014-gw.json", "utf8"));
  const index = cheerio.load(iconv.decode(await fs.readFile(`${root}/investigation/original-live.bin`), "shift_jis"));
  const sourceBase = "http://viprpg2014gw.web.fc2.com/";
  const manifestPath = `${cacheDir}/manifest.json`;
  const manifest: Record<string, { requestedUrl: string; actualUrl: string; contentType: string }> = JSON.parse(await fs.readFile(manifestPath, "utf8").catch(() => "{}"));
  async function capture(url: string, filename: string) {
    const file = `${cacheDir}/${filename}`;
    if (manifest[filename]?.requestedUrl === url) return { bytes: await fs.readFile(file), ...manifest[filename] };
    const response = await fetch(url, { signal: AbortSignal.timeout(40000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(file, bytes);
    manifest[filename] = { requestedUrl: url, actualUrl: response.url, contentType: response.headers.get("content-type") ?? "" };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    return { bytes, ...manifest[filename] };
  }
  const entries = [];
  for (const item of queue) {
    const work = works.find((work) => work.id === item.owner);
    if (!work) throw new Error(`Unknown work: ${item.owner}`);
    try {
      const anchor = index(`a[href="entry/${work.no}.html"]`).first();
      if (!anchor.length) throw new Error("Entry is not linked by the live index");
      const detailUrl = new URL(anchor.attr("href")!, sourceBase).href;
      const detail = await capture(detailUrl, `${work.no}-detail.bin`);
      const $ = cheerio.load(iconv.decode(detail.bytes, "shift_jis"));
      const table = $("table").first();
      const title = table.find("tr").first().find("b").last().text().trim();
      if (title.replace(/\s/g, "") !== work.title.replace(/\s/g, "")) throw new Error(`Title mismatch: ${title}`);
      const basename = item.url.split("/").at(-1);
      const image = table.find("img").toArray().find((img) => $(img).attr("src")?.split("/").at(-1) === basename);
      if (!image) throw new Error("The expected screenshot is not linked by this detail page");
      const imageUrl = new URL($(image).attr("src")!, detailUrl).href;
      const result = await capture(imageUrl, `${work.no}-image.bin`);
      const head = result.bytes.subarray(0, 8).toString("hex");
      const ext = head === "89504e470d0a1a0a" ? "png" : head.startsWith("ffd8ff") ? "jpg" : result.bytes.subarray(0, 3).toString() === "GIF" ? "gif" : result.bytes.subarray(0, 2).toString() === "BM" ? "bmp" : undefined;
      if (!ext) throw new Error("Response is not a PNG, JPEG, GIF or BMP");
      const localPath = `/screenshots/2014-gw/${work.no}-1.${ext}`;
      await fs.mkdir(path.dirname(`public${localPath}`), { recursive: true });
      await fs.writeFile(`public${localPath}`, result.bytes);
      work.ss = [localPath];
      entries.push({ id: work.id, originalRequestUrl: item.url, status: "recovered", mode: "live-source", detailUrl: detail.actualUrl, imageUrl: result.actualUrl, cacheFile: `${cacheDir}/${work.no}-image.bin`, localPath });
    } catch (error) {
      entries.push({ id: work.id, originalRequestUrl: item.url, status: "pending", error: String(error) });
    }
    await fs.writeFile(reportPath, JSON.stringify({ festivalId: "2014-gw", queue, evidence: { index: `${root}/investigation/original-live.json`, mirrorCheckpoint: `${root}/investigation/mirror-screenshot-checkpoint.json` }, entries }, null, 2) + "\n");
    console.log(`${work.no}: ${entries.at(-1)?.status}`);
  }
  await fs.writeFile("src/data/works/2014-gw.json", JSON.stringify(works, null, 2) + "\n");
  console.log(`Recovered ${entries.filter((entry) => entry.status === "recovered").length}/${queue.length} screenshots.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
