import fs from "node:fs/promises";
import path from "node:path";
import iconv from "iconv-lite";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)" +
  " Chrome/130.0.0.0 Safari/537.36";

function containsClosedMarker(html: string): boolean {
  const markers = [
    /この掲示板は閉鎖されています。?/,
    /掲示板は閉鎖されています。?/, // variation
    /このスレッドは存在しません。?/, // generic missing thread
    /rentalbbs\.shitaraba\.com/i, // closure redirect hint
  ];
  const text = html.replace(/\s+/g, " ");
  return markers.some((re) => re.test(text));
}

function detectEncoding(buf: Buffer, contentType: string | null | undefined): string {
  const ct = (contentType || "").toLowerCase();
  const m = ct.match(/charset=([^;\s]+)/i);
  const normalize = (e: string) => {
    const s = e.toLowerCase();
    if (/(shift[_-]?jis|sjis|windows-31j)/i.test(s)) return "shift_jis";
    if (/(euc[_-]?jp)/i.test(s)) return "euc-jp";
    if (/utf-?8/i.test(s)) return "utf-8";
    return s;
  };
  let enc = m ? normalize(m[1]) : undefined;
  if (!enc || enc === "utf-8") {
    const head = buf.slice(0, 4096).toString("ascii");
    const m1 = head.match(/<meta[^>]+charset\s*=\s*([\w-]+)/i);
    const m2 = head.match(/content-type[^>]*charset\s*=\s*([\w-]+)/i);
    const cand = (m1?.[1] || m2?.[1]);
    if (cand) enc = normalize(cand);
  }
  return enc || "utf-8";
}

async function checkLive(url?: string): Promise<boolean> {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (/^jbbs\.shitaraba\.net$/i.test(u.hostname) && /\/bbs\/read\.cgi\//i.test(u.pathname)) {
      // Historical read.cgi threads are commonly closed/removed; prefer Wayback for reliability
      return false;
    }
  } catch {}
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Connection: "close",
      },
      redirect: "follow",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    } as RequestInit);
    if (!res.ok) return false;
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    const enc = detectEncoding(buf, res.headers.get("content-type"));
    const html = iconv.decode(buf, enc as any);
    if (!html || html.length === 0) return false;
    if (containsClosedMarker(html)) return false;
    // additional generic failure markers
    if (/404 Not Found/i.test(html)) return false;
    if (/403 Forbidden/i.test(html)) return false;
    if (/ＥＲＲＯＲ|ERROR/iu.test(html) && /スレッドがありません|Not Found|禁止/iu.test(html)) return false;
    return true;
  } catch {
    return false;
  }
}

function isWayback(url: string) {
  try { return new URL(url).hostname === "web.archive.org"; } catch { return false; }
}

async function pickWayback(url: string): Promise<string | undefined> {
  const best = `https://web.archive.org/web/2/${url}`;
  // Probe best-match; Wayback returns 200 even when not archived, so inspect content
  try {
    const res = await fetch(best, { headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" } as any });
    if (res.ok) {
      const txt = await res.text();
      if (!/has not archived that URL/i.test(txt)) {
        return best;
      }
    }
  } catch {}
  // Fallback to CDX search for latest 200 snapshot
  try {
    const api = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&filter=statuscode:200&fl=timestamp&limit=5&collapse=digest`;
    const res = await fetch(api, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } as any });
    if (!res.ok) return undefined;
    const text = await res.text();
    const data = JSON.parse(text) as unknown[];
    if (!Array.isArray(data) || data.length < 2) return undefined;
    const last = (data as any[]).slice(-1)[0];
    if (Array.isArray(last) && typeof last[0] === "string") {
      const ts = last[0] as string;
      return `https://web.archive.org/web/${ts}/${url}`;
    }
  } catch {}
  // No archived snapshot
  return undefined;
}

async function processFile(file: string) {
  const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  const raw = await fs.readFile(abs, "utf8");
  const arr = JSON.parse(raw) as any[];
  let changed = 0, checked = 0, keptWayback = 0;
  for (const w of arr) {
    const forum = w.forum as string | undefined;
    if (!forum) continue;
    checked += 1;
    if (isWayback(forum)) { keptWayback += 1; continue; }
    const ok = await checkLive(forum);
    if (ok) continue;
    const wb = await pickWayback(forum);
    if (wb && wb !== forum) { w.forum = wb; changed += 1; }
    else if (!wb) { delete (w as any).forum; changed += 1; }
  }
  if (changed > 0) await fs.writeFile(abs, JSON.stringify(arr, null, 2), "utf8");
  console.log(`${path.basename(file)}: checked=${checked}, changed=${changed}, keptWayback=${keptWayback}`);
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("Usage: tsx scripts/fix-forum-links.ts <works.json> [more.json...]");
    process.exit(2);
  }
  for (const f of files) await processFile(f);
}

main().catch((err) => { console.error(err); process.exit(1); });
