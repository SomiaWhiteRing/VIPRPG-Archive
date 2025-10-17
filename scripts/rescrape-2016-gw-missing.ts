import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";

const FESTIVAL_ID = "2016-gw";
const FESTIVAL_SLUG = "2016-gw";

const WORKS_PATH = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const CATCH_DIR = path.join(process.cwd(), "catch", FESTIVAL_SLUG);
const PUBLIC_DIR = path.join(process.cwd(), "public");
const ICONS_DIR = path.join(PUBLIC_DIR, "icons", FESTIVAL_SLUG);
const SCREENSHOTS_DIR = path.join(PUBLIC_DIR, "screenshots", FESTIVAL_SLUG);
const RELATIVE_ICONS_DIR = `/icons/${FESTIVAL_SLUG}`;
const RELATIVE_SCREENSHOTS_DIR = `/screenshots/${FESTIVAL_SLUG}`;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)" +
  " Chrome/130.0.0.0 Safari/537.36";

type Work = {
  id: string;
  festivalId: string;
  no: string;
  title: string;
  author: string;
  category?: string;
  engine?: string;
  streaming?: string;
  forum?: string;
  authorComment?: string;
  hostComment?: string;
  icon?: string;
  ss?: string[];
};

function detectHtmlEncoding(buffer: Buffer, contentType?: string | null): string {
  const ct = (contentType || "").toLowerCase();
  if (/shift[_-]?jis|x-sjis|sjis|windows-31j|ms932/.test(ct)) return "shift_jis";
  const head = buffer.slice(0, Math.min(8192, buffer.length)).toString("latin1");
  const m = head.match(/charset\s*=\s*([A-Za-z0-9_\-]+)/i);
  if (m) {
    const enc = m[1].toLowerCase();
    if (/shift[_-]?jis|x-sjis|sjis|windows-31j|ms932/.test(enc)) return "shift_jis";
    if (/utf-8|utf8/.test(enc)) return "utf8";
  }
  return "utf8";
}

async function ensureDir(dir: string) { await fs.mkdir(dir, { recursive: true }); }

async function fetchBuffer(url: string) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "*/*" }, cache: "no-store", redirect: "follow", referrerPolicy: "no-referrer" } as RequestInit);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const ab = await res.arrayBuffer();
  return { buffer: Buffer.from(ab), contentType: res.headers.get("content-type") };
}

async function fetchHtml(url: string) {
  const { buffer, contentType } = await fetchBuffer(url);
  const enc = detectHtmlEncoding(buffer, contentType);
  const html = enc === "utf8" ? buffer.toString("utf8") : iconv.decode(buffer, enc);
  return html;
}

async function fetchJson<T = any>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json,text/plain,*/*" }, cache: "no-store", redirect: "follow", referrerPolicy: "no-referrer" } as RequestInit);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

function buildFw(url: string, ts: string) { return `https://web.archive.org/web/${ts}fw_/${url}`; }
function buildIm(url: string, ts: string) { return `https://web.archive.org/web/${ts}im_/${url}`; }
function buildId(url: string, ts: string) { return `https://web.archive.org/web/${ts}id_/${url}`; }

function sanitizeMultilineHtmlToText(html?: string | null) {
  if (!html) return undefined;
  const $ = cheerio.load(`<div>${html}</div>`, { decodeEntities: false });
  $("br").replaceWith("\n");
  const text = $("div").text().replace(/\s+/g, " ").trim();
  return text || undefined;
}

function stripLeadingLabel(text: string | undefined, labels: string[]): string | undefined {
  if (!text) return undefined;
  const pattern = new RegExp(`^(?:【)?(?:${labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?:】)?[\\s　]*[：:]?[\\s　]*`);
  return text.replace(pattern, "").trim() || undefined;
}

async function copyImageTo(fileBase: string, imgUrl: string, ts?: string, subdir: "icons" | "screenshots") {
  const outDir = subdir === "icons" ? ICONS_DIR : SCREENSHOTS_DIR;
  await ensureDir(outDir);
  const tryUrls: string[] = [];
  if (ts) { tryUrls.push(buildIm(imgUrl, ts), buildId(imgUrl, ts)); }
  tryUrls.push(`https://web.archive.org/web/2/${imgUrl}`);

  for (const u of tryUrls) {
    try {
      const { buffer, contentType } = await fetchBuffer(u);
      const ct = (contentType || "").toLowerCase();
      if (!ct.startsWith("image/")) continue;
      const ext = (() => {
        const clean = imgUrl.split(/[?#]/)[0];
        const e = path.extname(clean).toLowerCase();
        if (e === ".jpeg") return ".jpg";
        return e || ".png";
      })();
      const file = `${fileBase}${ext}`;
      await fs.writeFile(path.join(outDir, file), buffer);
      return subdir === "icons" ? path.posix.join(RELATIVE_ICONS_DIR, file) : path.posix.join(RELATIVE_SCREENSHOTS_DIR, file);
    } catch {
      // try next
    }
  }
  return undefined;
}

async function main() {
  await ensureDir(CATCH_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);

  const raw = await fs.readFile(WORKS_PATH, "utf8");
  const works = JSON.parse(raw) as Work[];

  // Determine target indices: CLI args or missing set
  const cliNums = process.argv.slice(2).filter((s) => /^\d{1,3}$/.test(s)).map((s) => Number(s));
  const targetNos = ((): number[] => {
    if (cliNums.length > 0) return cliNums;
    const miss = new Set<number>();
    for (const w of works) {
      const n = Number(w.no);
      if (!w.authorComment || !w.hostComment || !w.icon || !w.ss || w.ss.length === 0) miss.add(n);
    }
    return Array.from(miss.values()).sort((a, b) => a - b);
  })();

  const entryUrlTemplates = (
    no: number,
  ) => [
    `https://vipkohaku.x.fc2.com/2016GW/entry${String(no).padStart(2, "0")}.html`,
    `http://vipkohaku.x.fc2.com/2016GW/entry${String(no).padStart(2, "0")}.html`,
    `http://www.geocities.jp/viprpg2016gw/entry${String(no).padStart(2, "0")}.html`,
    `http://www.geocities.jp:80/viprpg2016gw/entry${String(no).padStart(2, "0")}.html`,
    `https://www.geocities.jp/viprpg2016gw/entry${String(no).padStart(2, "0")}.html`,
  ];

  for (const no of targetNos) {
    const idx = works.findIndex((w) => Number(w.no) === no);
    if (idx < 0) continue;
    const w = works[idx];
    const entryUrls = entryUrlTemplates(no);

    let bestTs: string | undefined;
    let authorComment: string | undefined = w.authorComment;
    let hostComment: string | undefined = w.hostComment;
    let iconLocal: string | undefined = w.icon;
    const ssSet = new Set<string>(w.ss || []);

    for (const eurl of entryUrls) {
      try {
        const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(eurl)}&output=json&fl=timestamp,original,statuscode&filter=statuscode:200`;
        const arr = await fetchJson<any[]>(cdxUrl).catch(() => []);
        if (!arr || arr.length <= 1) continue;
        const rows = arr.slice(1) as Array<[string, string, string]>;
        // Prefer descending time to hit newer content first
        rows.sort((a, b) => b[0].localeCompare(a[0]));
        for (const [ts] of rows) {
          try {
            const fw = buildFw(eurl, ts);
            const html = await fetchHtml(fw);
            await fs.writeFile(path.join(CATCH_DIR, `entry${String(no).padStart(2, "0")}-${ts}.html`), html, "utf8");
            const $ = cheerio.load(html);
            // parse icon under mate/iNN.*
            if (!iconLocal) {
              const iconCand = $(`img[src*='mate/i${String(no).padStart(2, "0")}.'], img[src*='mate/i${no}.']`).first().attr("src")
                || $(`img[src*='mate/i${String(no).padStart(2, "0")}'`).first().attr("src");
              if (iconCand) {
                const abs = new URL(iconCand, fw).toString().replace(/\/(?:id|im|fw)_\//, "/");
                const original = abs.replace(/^https?:\/\/web\.archive\.org\/web\/\d{14}(?:[a-z]{2}_)?\//i, "");
                const saved = await copyImageTo(String(no).padStart(2, "0"), original, ts, "icons");
                if (saved) iconLocal = saved;
              }
            }
            // screenshots only mate/ss*
            const img = $("img").toArray();
            for (const el of img) {
              const $img = $(el);
              const src = $img.attr("src");
              if (!src) continue;
              const abs = new URL(src, fw).toString();
              const lower = abs.toLowerCase();
              if (!/\.(png|jpe?g|gif|bmp)(?:[?#].*)?$/i.test(lower)) continue;
              if (!/\/mate\/ss/i.test(lower)) continue;
              const original = abs.replace(/^https?:\/\/web\.archive\.org\/web\/\d{14}(?:[a-z]{2}_)?\//i, "");
              const fileBase = (ssSet.size === 0) ? String(no).padStart(2, "0") : `${String(no).padStart(2, "0")}-${String(ssSet.size + 1).padStart(2, "0")}`;
              const saved = await copyImageTo(fileBase, original, ts, "screenshots");
              if (saved) ssSet.add(saved);
              // also parse onmouseover/onmouseout for alternate image
              for (const attr of ["onmouseover", "onmouseout"]) {
                const val = $img.attr(attr);
                if (!val) continue;
                const m = val.match(/['\"]([^'\"]+\.(?:png|jpe?g|gif|bmp))(?:\?[^'\"]*)?['\"]/i);
                if (m) {
                  const altAbs = new URL(m[1], fw).toString();
                  const altLower = altAbs.toLowerCase();
                  if (/\/mate\/ss/i.test(altLower)) {
                    const altOriginal = altAbs.replace(/^https?:\/\/web\.archive\.org\/web\/\d{14}(?:[a-z]{2}_)?\//i, "");
                    const altBase = (ssSet.size === 0) ? String(no).padStart(2, "0") : `${String(no).padStart(2, "0")}-${String(ssSet.size + 1).padStart(2, "0")}`;
                    const savedAlt = await copyImageTo(altBase, altOriginal, ts, "screenshots");
                    if (savedAlt) ssSet.add(savedAlt);
                  }
                }
              }
            }
            // comments
            const cellText = (label: string) => {
              const cell = $(`td:contains(${label})`).filter((_, el) => $(el).text().includes(label)).first();
              if (!cell.length) return undefined;
              const raw = cell.html() || cell.text();
              return sanitizeMultilineHtmlToText(raw);
            };
            const aRaw = cellText("作者コメント") || cellText("作者から一言");
            const hRaw = cellText("管理人コメント") || cellText("主催コメント");
            if (!authorComment && aRaw) authorComment = stripLeadingLabel(aRaw, ["作者コメント", "作者から一言"]);
            if (!hostComment && hRaw) hostComment = stripLeadingLabel(hRaw, ["管理人コメント", "主催コメント"]);

            if ((authorComment && hostComment) || (authorComment && ssSet.size > 0) || (hostComment && ssSet.size > 0)) {
              bestTs = ts;
              // 不立即 break，尽量多拿截图；但可在截图>2 时适度退出
              if (ssSet.size >= 2 && authorComment && hostComment) break;
            }
          } catch {
            continue;
          }
        }
        if (authorComment || hostComment || iconLocal || ssSet.size > 0) break; // 已命中，不再尝试其他域
      } catch {
        continue;
      }
    }

    // Persist updates back to works
    const updated: Work = { ...w };
    if (authorComment) updated.authorComment = authorComment;
    if (hostComment) updated.hostComment = hostComment;
    if (iconLocal) updated.icon = iconLocal;
    if (ssSet.size > 0) updated.ss = Array.from(ssSet);
    works[idx] = updated;
  }

  await fs.writeFile(WORKS_PATH, JSON.stringify(works, null, 2), "utf8");
  console.log(`Updated works written to ${WORKS_PATH}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
