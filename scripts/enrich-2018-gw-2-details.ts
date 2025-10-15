import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const FESTIVAL_SLUG = "2018-gw-2";
const FC2_BASE = "https://vipkohaku.x.fc2.com/2018GW2/";
const GEO_BASE = "http://3rd.geocities.jp/viprpg2018/";

const WORKS_PATH = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const CATCH_DIR = path.join(process.cwd(), "catch", FESTIVAL_SLUG);

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)" +
  " Chrome/130.0.0.0 Safari/537.36";

async function ensureDir(dir: string) { await fs.mkdir(dir, { recursive: true }); }

async function fetchText(url: string) {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
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

function detailOriginalCandidates(no: string) {
  const n2 = no.padStart(2, "0");
  return [
    new URL(`entry${n2}.html`, FC2_BASE).toString(),
    new URL(`works/${Number(no)}.html`, FC2_BASE).toString(),
    new URL(`works/${n2}.html`, GEO_BASE).toString(),
  ];
}

async function main() {
  await ensureDir(CATCH_DIR);
  const works = JSON.parse(await fs.readFile(WORKS_PATH, "utf8")) as any[];
  let updated = 0, saved = 0;
  for (const w of works) {
    const needA = !w.authorComment || w.authorComment.trim() === "";
    const needH = !w.hostComment || w.hostComment.trim() === "";
    if (!needA && !needH) continue;
    const cands = detailOriginalCandidates(String(w.no));
    let done = false;
    for (const orig of cands) {
      const url = `https://web.archive.org/web/2/${orig}`;
      try {
        const html = await fetchText(url);
        const name = (new URL(orig).pathname.split("/").pop() || `entry${w.no}.html`).replace(/[^a-z0-9_.-]+/gi, "-");
        await fs.writeFile(path.join(CATCH_DIR, name), html, "utf8");
        saved += 1;
        const { authorComment, hostComment } = extractComments(html);
        if (needA && authorComment) { w.authorComment = authorComment; updated += 1; }
        if (needH && hostComment) { w.hostComment = hostComment; updated += 1; }
        if ((w.authorComment && w.authorComment.trim() !== "") || (w.hostComment && w.hostComment.trim() !== "")) { done = true; break; }
      } catch {}
    }
    if (!done) {
      // leave as-is; detailDisabled will be handled by UI or other scripts
    }
  }
  await fs.writeFile(WORKS_PATH, JSON.stringify(works, null, 2), "utf8");
  console.log(`updated comments: ${updated}, detail pages cached: ${saved}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

