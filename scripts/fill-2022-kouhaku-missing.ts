import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

const FESTIVAL_SLUG = "2022-kouhaku";
const BASE_URL = "https://viprpg2022kohaku.x.2nt.com";

const WORKS_PATH = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const CATCH_DIR = path.join(process.cwd(), "catch", FESTIVAL_SLUG);
const ICONS_DIR = path.join(process.cwd(), "public", "icons", FESTIVAL_SLUG);
const SS_DIR = path.join(process.cwd(), "public", "screenshots", FESTIVAL_SLUG);
const REL_ICONS = `/icons/${FESTIVAL_SLUG}`;
const REL_SS = `/screenshots/${FESTIVAL_SLUG}`;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

type Work = {
  id: string;
  festivalId: string;
  no: string;
  title: string;
  author?: string;
  category?: string;
  engine?: string;
  streaming?: string;
  forum?: string;
  authorComment?: string;
  hostComment?: string;
  icon?: string;
  ss?: string[];
};

async function ensureDir(dir: string) { await fs.mkdir(dir, { recursive: true }); }

async function fetchText(url: string): Promise<string> {
  let last: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", Connection: "close" }, redirect: "follow", cache: "no-store" } as any);
      if (!(res as any).ok) throw new Error(`HTTP ${(res as any).status} for ${url}`);
      return await (res as any).text();
    } catch (err) { last = err; await new Promise(r => setTimeout(r, 400 * attempt)); }
  }
  try {
    const { stdout } = await execFileAsync("curl", ["-sSL","--fail","--http1.1","-A",USER_AGENT,url], { encoding: "utf8", maxBuffer: 20*1024*1024 });
    return stdout;
  } catch (err2) { last = err2; }
  throw last instanceof Error ? last : new Error(String(last));
}

async function fetchBinary(url: string): Promise<Buffer> {
  let last: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8", Connection: "close" }, redirect: "follow", cache: "no-store" } as any);
      if (!(res as any).ok) throw new Error(`HTTP ${(res as any).status} for ${url}`);
      const ab = await (res as any).arrayBuffer();
      return Buffer.from(ab);
    } catch (err) { last = err; await new Promise(r => setTimeout(r, 400 * attempt)); }
  }
  try {
    const { stdout } = await execFileAsync("curl", ["-sSL","--fail","--http1.1","-A",USER_AGENT,url], { encoding: "buffer", maxBuffer: 100*1024*1024 as any });
    // @ts-expect-error buffer
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } catch (err2) { last = err2; }
  throw last instanceof Error ? last : new Error(String(last));
}

function toAbsWb(url: string) { return new URL(url, `https://web.archive.org/`).toString(); }
function toAbs(base: string, rel?: string) { if (!rel) return undefined; try { return new URL(rel, base).toString(); } catch { return undefined; } }

function extractDD($: cheerio.CheerioAPI, label: string): string | undefined {
  let out: string | undefined;
  $("dl.entry-info dt").each((_, dt) => {
    const $dt = $(dt);
    if ($dt.text().trim() === label) {
      const $dd = $dt.next("dd");
      if ($dd.length) {
        const html = $dd.html() || "";
        const text = cheerio.load(`<div>${html.replace(/<br\s*\/?>/gi, "\n")}</div>`)('div').text();
        out = text.split(/\r?\n/).map(s=>s.replace(/\s+/g,' ').trim()).filter(Boolean).join('\n') || undefined;
      }
    }
  });
  return out;
}

function collectScreenshots($: cheerio.CheerioAPI, no: string): string[] {
  const urls = new Set<string>();
  $("img").each((_, img) => {
    const src = ($(img).attr("src") || "").trim();
    if (/\/entries\/${no}\/screenshots\//.test(src)) urls.add(src);
  });
  return [...urls];
}

async function loadDetailFromCDX(no: string): Promise<{ html: string; wbUrl: string } | null> {
  const candidates = [
    `${BASE_URL}/entries/${no}/`,
    `${BASE_URL}/entries/${no}/index.html`,
    `${BASE_URL.replace('https://','http://')}/entries/${no}/`,
    `${BASE_URL.replace('https://','http://')}/entries/${no}/index.html`,
  ];
  for (const target of candidates) {
    const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(target)}&output=json&filter=statuscode:200&fl=timestamp,original&limit=50`;
    try {
      const json = await fetchText(cdxUrl);
      const rows = JSON.parse(json) as string[][];
      const list = rows.slice(1);
      for (let i = list.length - 1; i >= 0; i--) {
        const ts = list[i][0];
        for (const mode of ["/web/", "/web/" /* plain */]) {
          const wb = `https://web.archive.org${mode}${ts}/` + target.replace(/^https?:\/\//, 'https://');
          try {
            const html = await fetchText(wb);
            if (html && html.includes('<dl class="entry-info">')) {
              return { html, wbUrl: wb };
            }
          } catch { /* try next */ }
        }
      }
    } catch { /* try next candidate */ }
  }
  return null;
}

async function saveImage(url: string, out: string) {
  await ensureDir(path.dirname(out));
  if (fss.existsSync(out)) return;
  const buf = await fetchBinary(url);
  await fs.writeFile(out, buf);
}

async function main() {
  await ensureDir(CATCH_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SS_DIR);

  const raw = await fs.readFile(WORKS_PATH, "utf8");
  const works: Work[] = JSON.parse(raw);
  // Load index for icon fallback
  let indexHtml: string | null = null;
  try {
    indexHtml = await fs.readFile(path.join(CATCH_DIR, 'index.html'), 'utf8');
  } catch { indexHtml = null; }
  let $index: cheerio.CheerioAPI | null = null;
  if (indexHtml) $index = cheerio.load(indexHtml);
  const needs = works.filter(w => !w.author || !w.engine || !w.category || !w.streaming || !w.authorComment);
  console.log(`Missing details count: ${needs.length}`);
  for (const w of needs) {
    const no = w.no;
    console.log(`Filling #${no} ${w.title}`);
    const cached = path.join(CATCH_DIR, `entry-${no}.html`);
    let html: string | null = null;
    if (fss.existsSync(cached)) {
      html = await fs.readFile(cached, "utf8");
    } else {
      const hit = await loadDetailFromCDX(no);
      if (hit) {
        html = hit.html;
        await fs.writeFile(cached, html, "utf8");
      }
    }
    if (!html) { console.warn(`  still missing detail page`); continue; }
    const $ = cheerio.load(html);
    // parse details
    const author = extractDD($, "作者") || w.author;
    const category = extractDD($, "ジャンル") || w.category;
    let engine = extractDD($, "ツクール") || w.engine;
    if (engine) engine = engine.replace(/^\s*\S+\s*/, (m) => m.includes("RPG") ? m : "").trim() || engine;
    const streaming = extractDD($, "配信/投稿") || w.streaming;
    const authorComment = extractDD($, "コメント") || w.authorComment;
    const hostComment = extractDD($, "管理人から一言") || w.hostComment;
    w.author = author || w.author;
    w.category = category || w.category;
    w.engine = engine || w.engine;
    w.streaming = streaming || w.streaming;
    w.authorComment = authorComment || w.authorComment;
    w.hostComment = hostComment || w.hostComment;
    // icon
    let iconFilled = false;
    const iconRel = $(`h3.entry-title img[src*="/entries/${no}/icon."]`).attr("src") || undefined;
    if (iconRel) {
      const abs = toAbs(`https://web.archive.org/`, iconRel)!;
      const ext = path.extname(new URL(abs).pathname).toLowerCase() || ".png";
      const iconOut = path.join(ICONS_DIR, `${no}${ext}`);
      try { await saveImage(abs, iconOut); w.icon = path.posix.join(REL_ICONS, `${no}${ext}`); iconFilled = true; } catch {}
    }
    // Fallback: icon from index list
    if (!iconFilled && $index) {
      const img = $index(`ol.entries h3.entry-title#${no} img`).attr('src');
      if (img) {
        const abs = toAbs(`https://web.archive.org/`, img)!;
        const ext = path.extname(new URL(abs).pathname).toLowerCase() || ".png";
        const iconOut = path.join(ICONS_DIR, `${no}${ext}`);
        try { await saveImage(abs, iconOut); w.icon = path.posix.join(REL_ICONS, `${no}${ext}`); } catch {}
      }
    }
    // screenshots
    const ss = collectScreenshots($, no).map(s => toAbs(`https://web.archive.org/`, s)!).filter(Boolean) as string[];
    const ssRel: string[] = [];
    let idx = 0;
    for (const s of ss) {
      const ext = path.extname(new URL(s).pathname).toLowerCase() || ".png";
      const name = idx === 0 ? `${no}${ext}` : `${no}-${String(idx + 1).padStart(2, '0')}${ext}`;
      const out = path.join(SS_DIR, name);
      try { await saveImage(s, out); ssRel.push(path.posix.join(REL_SS, name)); idx++; } catch {}
    }
    if (ssRel.length) w.ss = ssRel;
  }
  await fs.writeFile(WORKS_PATH, JSON.stringify(works, null, 2), "utf8");
  console.log("Updated works with filled details.");

  // Second pass: ensure icons for any work still missing icon
  if ($index) {
    let patched = 0;
    for (const w of works) {
      const no = w.no;
      let need = false;
      if (!w.icon) need = true;
      else {
        const p = path.join('public', w.icon.replace(/^\//, ''));
        if (!fss.existsSync(p)) need = true;
      }
      if (!need) continue;
      const img = $index(`ol.entries h3.entry-title#${no} img`).attr('src');
      if (!img) continue;
      try {
        const abs = new URL(img, 'https://web.archive.org/').toString();
        const ext = path.extname(new URL(abs).pathname).toLowerCase() || '.png';
        const iconOut = path.join(ICONS_DIR, `${no}${ext}`);
        await saveImage(abs, iconOut);
        w.icon = path.posix.join(REL_ICONS, `${no}${ext}`);
        patched++;
      } catch {}
    }
    await fs.writeFile(WORKS_PATH, JSON.stringify(works, null, 2), 'utf8');
    console.log(`Icon pass patched ${patched} works.`);
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
