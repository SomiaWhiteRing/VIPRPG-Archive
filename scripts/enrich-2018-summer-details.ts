import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const FESTIVAL_SLUG = "2018-summer";
const FC2_BASE = "https://vipkohaku.x.fc2.com/2018s/";
const GEO_BASE = "https://www.geocities.jp/tkoolvip2018summer/";

const WORKS_PATH = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const CATCH_DIR = path.join(process.cwd(), "catch", FESTIVAL_SLUG);

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)" +
  " Chrome/130.0.0.0 Safari/537.36";

interface TimemapRow {
  original: string;
  mimetype: string;
  timestamp: string;
  endtimestamp: string;
}

async function ensureDir(dir: string) { await fs.mkdir(dir, { recursive: true }); }

async function fetchText(url: string) {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Connection: "close",
        },
        cache: "no-store",
        redirect: "follow",
        referrerPolicy: "no-referrer",
      } as RequestInit);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function fetchTimemap(base: string, saveName: string): Promise<TimemapRow[]> {
  const tmUrl = `https://web.archive.org/web/timemap/json?url=${encodeURIComponent(base)}&matchType=prefix&collapse=urlkey&output=json&fl=original%2Cmimetype%2Ctimestamp%2Cendtimestamp%2Cgroupcount%2Cuniqcount&filter=!statuscode%3A%5B45%5D..&limit=10000`;
  const text = await fetchText(tmUrl);
  await ensureDir(CATCH_DIR);
  await fs.writeFile(path.join(CATCH_DIR, saveName), text, "utf8");
  const raw = JSON.parse(text) as unknown[];
  if (!Array.isArray(raw) || raw.length < 2) return [];
  const header = raw[0] as string[];
  const out: TimemapRow[] = [];
  for (const row of raw.slice(1) as any[]) {
    out.push({
      original: String(row[header.indexOf("original")] ?? ""),
      mimetype: String(row[header.indexOf("mimetype")] ?? ""),
      timestamp: String(row[header.indexOf("timestamp")] ?? ""),
      endtimestamp: String(row[header.indexOf("endtimestamp")] ?? ""),
    });
  }
  return out;
}

function buildWaybackUrl(ts: string, original: string, kind: "fw_" | "im_" | "id_" = "fw_") {
  const u = original;
  return `https://web.archive.org/web/${ts}${kind}/${u}`;
}

function buildDetailRowsByIndex(rows: TimemapRow[], kind: "fc2" | "geo") {
  const map = new Map<string, TimemapRow[]>();
  for (const r of rows) {
    const u = r.original;
    const m = kind === "fc2" ? u.match(/\/2018s\/entry(\d{2,3})\.html$/i) : u.match(/\/tkoolvip2018summer\/entry(\d{2,3})\.html$/i);
    if (m) {
      const idx = m[1].padStart(2, "0");
      const list = map.get(idx) ?? [];
      list.push(r);
      map.set(idx, list);
    }
  }
  for (const [k,v] of map) v.sort((a,b)=> a.timestamp.localeCompare(b.timestamp));
  return map;
}

function sanitizeMultiline(v?: string | null) {
  if (!v) return undefined;
  const out = v
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return out || undefined;
}

function extractComments(html: string) {
  const $ = cheerio.load(html);
  const pick = (label: string) => {
    const cells = $(`td:contains(${label})`);
    let found: cheerio.Cheerio | undefined;
    cells.each((_, el) => {
      const t = $(el).text().replace(/[\s\u3000]+/g, " ").trim();
      const normalized = t.replace(/[\[\(（【\]\)】]/g, "");
      if (normalized.startsWith(label) || normalized.includes(`${label}：`) || normalized.includes(`${label}:`)) { found = $(el); return false; }
      return;
    });
    if (!found) return undefined;
    const rawHtml = found.first().html() || found.first().text();
    const parts = rawHtml.split(/<br\s*\/?\s*>/i);
    if (parts.length > 1) return sanitizeMultiline(parts.slice(1).join("<br>"));
    return sanitizeMultiline(rawHtml.replace(/^[\s\S]*?[:：]/, ""));
  };
  const authorComment = pick("作者コメント") || pick("作者のコメント") || pick("備考");
  const hostComment = pick("管理人コメント") || pick("主催コメント");
  return { authorComment, hostComment };
}

async function main() {
  const arr = JSON.parse(await fs.readFile(WORKS_PATH, "utf8")) as any[];
  const fc2Tm = await fetchTimemap(FC2_BASE, "timemap.json");
  const geoTm = await fetchTimemap(GEO_BASE, "timemap-geocities.json");
  const fc2Detail = buildDetailRowsByIndex(fc2Tm, "fc2");
  const geoDetail = buildDetailRowsByIndex(geoTm, "geo");
  let updated = 0;
  let savedHtml = 0;
  for (const w of arr) {
    const idx = String(w.no).padStart(2, "0");
    const needAuthor = !w.authorComment || w.authorComment.trim() === "";
    const needHost = !w.hostComment || w.hostComment.trim() === "";
    if (!needAuthor && !needHost) continue;
    const candidates: string[] = [];
    for (const r of (fc2Detail.get(idx) || [])) {
      const ts = r.endtimestamp || r.timestamp;
      candidates.push(buildWaybackUrl(ts, r.original, "fw_"));
    }
    for (const r of (geoDetail.get(idx) || [])) {
      const ts = r.endtimestamp || r.timestamp;
      candidates.push(buildWaybackUrl(ts, r.original, "fw_"));
    }
    for (const url of candidates) {
      try {
        const html = await fetchText(url);
        const name = (new URL(url).pathname.split("/").pop() || `entry${idx}.html`).replace(/[^a-z0-9_.-]+/gi, "-");
        await ensureDir(CATCH_DIR);
        await fs.writeFile(path.join(CATCH_DIR, name), html, "utf8");
        savedHtml += 1;
        const { authorComment, hostComment } = extractComments(html);
        if (needAuthor && authorComment) { w.authorComment = authorComment; updated += 1; }
        if (needHost && hostComment) { w.hostComment = hostComment; updated += 1; }
        if ((w.authorComment && w.authorComment.trim() !== "") || (w.hostComment && w.hostComment.trim() !== "")) break;
      } catch {}
    }
    if ((!w.authorComment || w.authorComment.trim() === "") && (!w.hostComment || w.hostComment.trim() === "") && (!w.ss || w.ss.length === 0)) {
      w.detailDisabled = true;
    } else if (w.detailDisabled) {
      delete w.detailDisabled;
    }
  }
  await fs.writeFile(WORKS_PATH, JSON.stringify(arr, null, 2), "utf8");
  console.log(`updated comments: ${updated}, html saved: ${savedHtml}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

