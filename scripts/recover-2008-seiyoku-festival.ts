import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { ProxyAgent } from "undici";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import { imageExtension, writeJson } from "./recover-entry-table";
import type { WorkEntry } from "../src/lib/types";

const id = "2008-seiyoku-festival", root = `catch/${id}`;
const base = "https://vipkohaku.x.fc2.com/";
const resources = ["seiyoku.htm", "japanes_001.gif", "bg_title.jpg"];
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Capture = { originalUrl: string; requestedUrl: string; actualUrl: string; timestamp?: string; file: string; bytes: number; sha256: string; cdxDigestVerified?: boolean; proxyRegion: string; exitCountry: string };

function cdxDigest(bytes: Buffer) {
  const bits = [...createHash("sha1").update(bytes).digest()].map((n) => n.toString(2).padStart(8, "0")).join("");
  let result = "";
  for (let i = 0; i < bits.length; i += 5) result += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[Number.parseInt(bits.slice(i, i + 5), 2)];
  return result;
}

function structure(bytes: Buffer) {
  const $ = cheerio.load(iconv.decode(bytes, "shift_jis"));
  const numbers: number[] = [];
  $("a[href]").each((_, e) => { const match = $(e).text().trim().match(/^NO\.\s*(\d+)/i); if (match) numbers.push(Number(match[1])); });
  return { numbers, anchors: $("a[href]").length, images: $("img").length, scripts: $("script").length };
}

async function retrieve(mode: "source" | "archive") {
  if (mode === "archive" && !process.argv.includes("--archive-only")) throw new Error("Archive requests require --archive-only");
  await fs.mkdir(`${root}/investigation`, { recursive: true });
  const country = mode === "source" ? "JP" : "HK";
  const port = Number(process.argv.find((arg) => arg.startsWith("--proxy-port="))?.split("=")[1] ?? (mode === "source" ? 37997 : 7897));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid proxy port");
  const dispatcher = new ProxyAgent(`http://127.0.0.1:${port}`);
  const only = process.argv.find((arg) => arg.startsWith("--resource="))?.split("=")[1];
  if (only && !resources.includes(only)) throw new Error("Unknown resource");
  const manifest: Record<string, Capture> = only ? JSON.parse(await fs.readFile(`${root}/source/${mode}/manifest.json`, "utf8")) : {};
  const attempts: Array<Record<string, unknown>> = [];
  const cache = `${root}/source/${mode}`;
  await fs.mkdir(cache, { recursive: true });
  try {
    const route = await fetch("http://ip-api.com/json/?fields=status,countryCode", { dispatcher, signal: AbortSignal.timeout(15000) });
    const exit = await route.json() as { countryCode?: string };
    if (exit.countryCode !== country) throw new Error(`Expected ${country} exit, received ${exit.countryCode ?? "unknown"}`);
    const timemap: string[][] = [["original", "timestamp", "statuscode", "mimetype", "digest"]];
    for (const file of resources.filter((file) => !only || file === only)) {
      let urls: Array<{ url: string; original: string; timestamp?: string; digest?: string }>;
      if (mode === "source") urls = ["https:", "http:"].map((scheme) => ({ url: new URL(file, base).href.replace(/^https:/, scheme), original: new URL(file, base).href.replace(/^https:/, scheme) }));
      else {
        const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(new URL(file, base).href)}&output=json&fl=original,timestamp,statuscode,mimetype,digest`;
        let rows: string[][] = [];
        try {
          const response = await fetch(cdxUrl, { dispatcher, signal: AbortSignal.timeout(45000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          rows = await response.json() as string[][];
          await writeJson(`${root}/investigation/${file.replace(/\./g, "-")}-cdx.json`, rows);
          timemap.push(...rows.slice(1));
        } catch (error) { attempts.push({ resource: file, phase: "CDX", error: String(error) }); }
        const usable = rows.slice(1).filter((row) => row[2] === "200" || row[2] === "-");
        // The known 2019 festival snapshot is retained independently of newer hosting error captures.
        urls = [{ url: `https://web.archive.org/web/20190330131509id_/${base}${file}`, original: `${base}${file}`, timestamp: "20190330131509", digest: usable.find((row) => row[1] === "20190330131509")?.[4] }];
        const reference = "20190330131509";
        const preferred = usable.sort((a, b) => Number(a[1] > reference) - Number(b[1] > reference) || (a[1] <= reference ? b[1].localeCompare(a[1]) : a[1].localeCompare(b[1])));
        for (const row of preferred) if (!urls.some((u) => u.timestamp === row[1])) urls.push({ url: `https://web.archive.org/web/${row[1]}id_/${row[0]}`, original: row[0], timestamp: row[1], digest: row[4] });
        if (file === "seiyoku.htm") urls.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
      }
      for (const candidate of urls) {
        try {
          const response = await fetch(candidate.url, { dispatcher, signal: AbortSignal.timeout(25000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const bytes = Buffer.from(await response.arrayBuffer());
          const candidateDir = `${cache}/candidates`;
          await fs.mkdir(candidateDir, { recursive: true });
          await fs.writeFile(`${candidateDir}/${file}-${candidate.timestamp ?? new URL(candidate.url).protocol.slice(0, -1)}.bin`, bytes);
          if (candidate.digest && candidate.digest !== "-" && cdxDigest(bytes) !== candidate.digest) throw new Error("Archived bytes differ from the CDX digest");
          const stats = file.endsWith("htm") ? structure(bytes) : undefined;
          if (stats && (stats.numbers.length !== 2 || !stats.numbers.includes(5) || !stats.numbers.includes(10))) throw new Error("Response does not contain source catalogue numbers 05 and 10");
          if (!stats) imageExtension(bytes);
          await fs.writeFile(`${cache}/${file}`, bytes);
          manifest[file] = { originalUrl: candidate.original, requestedUrl: candidate.url, actualUrl: response.url, ...(candidate.timestamp ? { timestamp: candidate.timestamp } : {}), file, bytes: bytes.length, sha256: sha(bytes), ...(candidate.digest && candidate.digest !== "-" ? { cdxDigestVerified: true } : {}), proxyRegion: mode === "source" ? "Japan" : "Hong Kong", exitCountry: country };
          attempts.push({ resource: file, url: candidate.url, status: response.status, bytes: bytes.length, ...(stats ? { structure: stats } : {}) });
          break;
        } catch (error) { attempts.push({ resource: file, url: candidate.url, error: String(error) }); }
      }
    }
    await writeJson(`${cache}/manifest.json`, manifest);
    await writeJson(`${root}/investigation/${mode}${only ? "-" + only.replace(/\./g, "-") : ""}-retrieval.json`, { exitCountry: country, proxyPort: port, resources: Object.keys(manifest), attempts });
    if (mode === "archive" && !only) await fs.writeFile(`${root}/investigation/original-timemap.bin`, JSON.stringify(timemap) + "\n");
    console.log(JSON.stringify({ mode, exitCountry: country, recovered: Object.keys(manifest), attempts: attempts.length }));
  } finally { await dispatcher.close(); }
}

async function prepare() {
  const file = `src/data/works/${id}.json`;
  const works = JSON.parse(await fs.readFile(file, "utf8")) as WorkEntry[];
  const manifest = JSON.parse(await fs.readFile(`${root}/source/archive/manifest.json`, "utf8")) as Record<string, Capture>;
  const capture = manifest["seiyoku.htm"];
  if (!capture) throw new Error("No captured source catalogue");
  const bytes = await fs.readFile(`${root}/source/archive/${capture.file}`);
  const decoded = iconv.decode(bytes, "shift_jis");
  if (!iconv.encode(decoded, "shift_jis").equals(bytes) || decoded.includes("\ufffd")) throw new Error("Source encoding mismatch");
  const $ = cheerio.load(decoded);
  const entries = new Map<string, { title: string; href: string }>();
  $("a[href]").each((_, e) => {
    const text = $(e).text().replace(/\s+/g, " ").trim();
    const match = text.match(/^NO\.\s*(\d+)\s+([\s\S]+)$/i);
    if (match) entries.set(match[1].padStart(2, "0"), { title: match[2], href: new URL($(e).attr("href")!, base).href });
  });
  if (entries.size !== works.length || works.some((work) => !entries.has(work.no!))) throw new Error("Catalogue number mismatch");
  const titlesMatch = works.every((work) => work.title.replace(/\s+/g, " ").trim() === entries.get(work.no!)!.title);
  if (!titlesMatch) throw new Error("Catalogue title comparison needs investigation; no source text displayed");
  const baseline = `${root}/investigation/pre-recovery-baseline.json`;
  if (!(await fs.stat(baseline).catch(() => undefined))) await writeJson(baseline, { entries: works.length, numbers: works.map((work) => work.no), disabled: works.filter((work) => work.detailDisabled).length, withSource: works.filter((work) => work.source).length });
  for (const work of works) {
    work.source = { url: new URL("seiyoku.htm", base).href, snapshotUrl: capture.requestedUrl };
    work.download = { ...work.download, url: entries.get(work.no!)!.href };
    work.sourceDetailUnavailable = true;
    delete work.detailDisabled;
  }
  await writeJson(file, works);
  await writeJson(`${root}/recovery.json`, { festivalId: id, sourceEncoding: "shift_jis", byteRoundtrip: true, entries: works.map((work) => ({ no: work.no, sourcePath: "seiyoku.htm", downloadSourceUrl: work.download!.url, catalogueOnly: true })), titleComparisons: { compared: works.length, matching: works.length, manualContentReview: false }, sourceDesign: "One shared catalogue page containing two numbered download anchors (05 and 10), with no individual introduction links or screenshot references. Do not invent intervening catalogue numbers or individual source pages.", selectedCapture: capture, sourceEvidence: [`${root}/investigation/source-retrieval.json`, `${root}/investigation/archive-retrieval.json`, `${root}/investigation/archive-seiyoku-htm-retrieval.json`, `${root}/source/archive/manifest.json`], failures: ["japanes_001.gif", "bg_title.jpg"].map((sourcePath) => ({ sourceUrl: new URL(sourcePath, base).href, error: "Japan source requests failed. Known Hong Kong Wayback snapshot requests returned 404; CDX records are redirects/revisits, not successful image captures." })), handling: "Preserve catalogue text and historic download addresses directly. No content-based screening or restriction decisions. Missing ornamental backgrounds remain documented without invented replacements.", desktopReview: "pending" });
  console.log(JSON.stringify({ mode: "prepare", numbers: works.map((work) => work.no), titlesMatching: works.length, screenshotsReferencedInSource: 0, catalogueOnlyDetails: works.length }));
}

async function main() {
  if (process.argv[2] === "source-probe") return retrieve("source");
  if (process.argv[2] === "archive-only") return retrieve("archive");
  if (process.argv[2] === "prepare") return prepare();
  throw new Error("Use source-probe, archive-only --archive-only, or prepare");
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
