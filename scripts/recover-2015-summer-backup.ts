import fs from "node:fs/promises";
import { inflateRawSync, crc32 } from "node:zlib";
import iconv from "iconv-lite";
import { imageExtension, writeJson } from "./recover-entry-table";
import { readStaticStringArray } from "./source-static-array";

async function main() {
  const root = "catch/2015-summer";
  const index = JSON.parse(await fs.readFile(`${root}/investigation/owner-archive-files.json`, "utf8")) as {
    publicPage: string;
    files: Array<{ name: string; flags: number; method: number; crc32: number; compressedSize: number; size: number; offset: number }>;
  };
  const session = JSON.parse(await fs.readFile("test-results/2015-summer-owner-archive-session.json", "utf8"));
  const cacheDir = `${root}/source/owner-backup`;
  await fs.mkdir(cacheDir, { recursive: true });
  async function range(start: number, end: number) {
    const response = await fetch(session.url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(40000) });
    if (response.status !== 206) {
      await response.body?.cancel();
      throw new Error(`Byte range was not honored (HTTP ${response.status})`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== end - start + 1) throw new Error("Byte range length mismatch");
    return bytes;
  }
  async function extract(file: typeof index.files[number], cacheFile: string) {
    const cached = await fs.readFile(cacheFile).catch(() => undefined);
    if (cached && cached.length === file.size && crc32(cached) === file.crc32) return cached;
    if (file.flags & 1) throw new Error("Encrypted ZIP entry is unsupported");
    const header = await range(file.offset, file.offset + 29);
    if (header.readUInt32LE(0) !== 0x04034b50) throw new Error("Invalid local ZIP header");
    const start = file.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const compressed = await range(start, start + file.compressedSize - 1);
    const bytes = file.method === 0 ? compressed : file.method === 8 ? inflateRawSync(compressed) : undefined;
    if (!bytes || bytes.length !== file.size || crc32(bytes) !== file.crc32) throw new Error("ZIP entry integrity check failed");
    await fs.writeFile(cacheFile, bytes);
    return bytes;
  }
  const dataEntry = index.files.find((file) => file.name === "viprpgsummer2015/data.js");
  if (!dataEntry) throw new Error("Owner backup has no source manifest");
  const backupData = await extract(dataEntry, `${cacheDir}/data.bin`);
  const original = readStaticStringArray(iconv.decode(await fs.readFile(`${root}/investigation/data.bin`), "shift_jis"), "game");
  const backup = readStaticStringArray(iconv.decode(backupData, "shift_jis"), "game");
  if (backup.length !== original.length) throw new Error("Backup entry count differs from the original source");
  for (let i = 0; i < original.length; i += 14) {
    if (backup[i] !== original[i] || backup[i + 1] !== original[i + 1]) throw new Error(`Backup identity differs at No.${i / 14}`);
  }
  if (process.argv.includes("--shell")) {
    const files = [];
    for (const file of index.files.filter((entry) => /^viprpgsummer2015\/[^/]+\.(?:html?|js|css|png|gif|jpe?g|ico)$/i.test(entry.name))) {
      const name = file.name.split("/").at(-1)!;
      const cacheFile = name === "data.js" ? `${cacheDir}/data.bin` : `${cacheDir}/root_${name}.bin`;
      await extract(file, cacheFile);
      files.push({ name, cacheFile, size: file.size, crc32: file.crc32 });
      console.log(`Original shell: ${name}`);
    }
    await writeJson(`${root}/original-shell.json`, { festivalId: "2015-summer", ownerBackupPage: index.publicPage, rangeOnly: true, restrictedMediaRetrieved: false, files });
    return;
  }
  const report = JSON.parse(await fs.readFile(`${root}/recovery.json`, "utf8"));
  const previous = JSON.parse(await fs.readFile(`${root}/image-recovery.json`, "utf8").catch(() => "{}"));
  const queue: Array<{ owner: string; sourceUrl: string }> = previous.queue ?? report.gaps;
  const entries = [];
  for (const gap of queue) {
    // Do not retrieve restricted entry media, even if a ZIP bundles it with other works.
    if (gap.owner === "2015-summer-work-04") throw new Error("Restricted media appeared in the recovery queue");
    const pathname = new URL(gap.sourceUrl).pathname.replace(/^\//, "");
    const file = index.files.find((file) => file.name === `viprpgsummer2015/${pathname}`);
    if (!file) {
      entries.push({ ...gap, status: "pending", reason: "Not present under the source-declared path in the owner backup" });
    } else {
      try {
        const cacheFile = `${cacheDir}/${pathname.replaceAll("/", "_")}.bin`;
        const bytes = await extract(file, cacheFile);
        const format = imageExtension(bytes);
        entries.push({ ...gap, status: "recovered", ownerBackupPage: index.publicPage, zipEntry: file.name, cacheFile, format, size: file.size, crc32: file.crc32 });
      } catch (error) {
        entries.push({ ...gap, status: "pending", reason: String(error).replaceAll(session.url, index.publicPage) });
      }
    }
    await writeJson(`${root}/image-recovery.json`, { festivalId: "2015-summer", ownerBackupPage: index.publicPage, backupManifestIdentityChecked: 77, rangeOnly: true, restrictedMediaRetrieved: false, queue, entries });
    console.log(`${gap.owner}: ${entries.at(-1)?.status}`);
  }
  console.log(`Recovered ${entries.filter((entry) => entry.status === "recovered").length}/${queue.length} missing images from the owner backup.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
