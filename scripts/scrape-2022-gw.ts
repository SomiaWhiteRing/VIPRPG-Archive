import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { load as loadHtml } from 'cheerio';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

// Minimal fetch typings
interface SimpleResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}
declare function fetch(
  url: string,
  init?: { redirect?: 'follow' | 'manual' | 'error'; headers?: Record<string, string> }
): Promise<SimpleResponse>;

type Entry = {
  no: string; // e.g., "0", "1", ...
  title: string;
  author: string;
  engine?: string;
  category?: string;
  streaming?: string;
  forum?: string;
  downloadHref?: string;
  iconSrc?: string;
  entryHref?: string;
  authorComment?: string;
  hostComment?: string;
  detailScreenshots?: string[];
};

const SLUG = '2022-gw';
const BASE = 'http://viprpg2022gw.nobody.jp/';

const CACHE_DIR = path.join('catch', SLUG);
const BANNERS_DIR = path.join('public', 'banners');
const ICONS_DIR = path.join('public', 'icons', SLUG);
const SS_DIR = path.join('public', 'screenshots', SLUG);

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function readFile(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  return fs.readFileSync(file, 'utf8');
}

function saveFile(file: string, data: string | Buffer) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, data);
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

async function fetchText(url: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Connection: 'close',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.toString('utf8');
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  // curl fallback
  try {
    const args = [
      '-sSL',
      '--fail',
      '--http1.1',
      '-A',
      USER_AGENT,
      '-H',
      'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      url,
    ];
    const { stdout } = await execFileAsync('curl', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    return stdout;
  } catch (err2) {
    lastErr = err2;
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function fetchBinary(url: string): Promise<Buffer> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          Connection: 'close',
        },
        referrerPolicy: 'no-referrer',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return buf;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  // curl fallback
  try {
    const args = ['-sSL', '--fail', '--http1.1', '-A', USER_AGENT, url];
    const { stdout } = await execFileAsync('curl', args, { encoding: 'buffer', maxBuffer: 50 * 1024 * 1024 as any });
    // stdout is a Buffer due to encoding: 'buffer'
    // @ts-ignore
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } catch (err2) {
    lastErr = err2;
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function absol(url: string): string {
  return new URL(url, BASE).toString();
}

function cleanText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function decodeHtmlPreserveBreaks(html: string): string {
  const withBreaks = html.replace(/<br\s*\/?>(\s*)/gi, '\n');
  const $ = loadHtml(`<div>${withBreaks}</div>`);
  const t = $('div').text();
  return t.replace(/\r\n?/g, '\n');
}

function hashBuf(buf: Buffer) {
  return createHash('md5').update(buf).digest('hex');
}

function parseList(html: string): Entry[] {
  const $ = loadHtml(html);
  const entries: Entry[] = [];
  // Find the table whose header includes "No." and "作品一覧"
  const $table = $('section#link1 table').first().length ? $('section#link1 table').first() : $('table').first();
  $table.find('tbody > tr').each((_, tr) => {
    const $tds = $(tr).find('td');
    if ($tds.length < 7) return;
    const no = cleanText($tds.eq(0).text());
    // title + author
    const $titleCell = $tds.eq(2);
    const $a = $titleCell.find('a').first();
    const entryHref = $a.attr('href') || '';
    const title = cleanText($a.text());
    const author = cleanText($titleCell.find('span.s').first().text());
    // genre/tool cell
    const $gt = $tds.eq(3);
    const gtHtml = $gt.html() || '';
    const gtText = decodeHtmlPreserveBreaks(gtHtml).split('\n').map((s) => s.trim()).filter(Boolean);
    let category: string | undefined;
    let engine: string | undefined;
    if (gtText[0]) category = gtText[0];
    if (gtText[1]) engine = gtText[1];
    // DL cell (index 4): link to Google Drive
    let downloadHref: string | undefined;
    $tds.eq(4).find('a').each((__, a) => {
      const href = $(a).attr('href') || '';
      if (/drive\.google\.com\/uc\?id=/.test(href)) downloadHref = href;
    });
    // streaming cell (index 5): keep raw text
    const streaming = cleanText($tds.eq(5).text());
    // forum cell (index 6)
    const forum = $tds.eq(6).find('a').attr('href') || undefined;
    // icon src (index 1)
    const iconSrc = $tds.eq(1).find('img').attr('src') || undefined;

    entries.push({
      no,
      title,
      author,
      engine,
      category,
      streaming: streaming || undefined,
      forum,
      downloadHref,
      iconSrc,
      entryHref,
    });
  });
  // Sort numerically by no
  entries.sort((a, b) => parseInt(a.no, 10) - parseInt(b.no, 10));
  return entries;
}

function extractLabeledText($: cheerio.Root, label: string): string | undefined {
  // Find <h4>【ラベル】 followed by <p>
  let found: string | undefined;
  $('h4').each((_, h) => {
    const t = cleanText($(h).text());
    if (t.includes(label)) {
      const $p = $(h).nextAll('p').first();
      if ($p.length) {
        const html = $p.html() || '';
        const text = decodeHtmlPreserveBreaks(html)
          .split('\n')
          .map((s) => s.replace(/[\t ]+/g, ' ').trim())
          .filter(Boolean)
          .join('\n');
        found = text || undefined;
      }
    }
  });
  return found;
}

function collectDetailScreenshots($: cheerio.Root): string[] {
  const urls: string[] = [];
  // Primary screenshot with onmouseover/out
  $('img').each((_, img) => {
    const src = $(img).attr('src') || '';
    const w = parseInt($(img).attr('width') || '0', 10);
    const h = parseInt($(img).attr('height') || '0', 10);
    if (src && /ss\d+/i.test(src) && !/icon/i.test(src)) {
      if (w >= 100 && h >= 100) urls.push(src);
      else if (!w && !h) urls.push(src); // fallback when attrs missing
    }
    const over = $(img).attr('onmouseover') || '';
    const out = $(img).attr('onmouseout') || '';
    const rx = /'([^']*ss[^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(over)) !== null) urls.push(m[1]);
    rx.lastIndex = 0;
    while ((m = rx.exec(out)) !== null) urls.push(m[1]);
  });
  return Array.from(new Set(urls));
}

async function enrichFromDetail(e: Entry) {
  if (!e.entryHref) return e;
  const no = e.no;
  const file = path.join(CACHE_DIR, `entry${no}.html`);
  let html = readFile(file);
  if (!html) {
    const url = absol(e.entryHref);
    try {
      html = await fetchText(url);
      saveFile(file, html);
    } catch (err) {
      console.warn(`detail ${no} failed: ${(err as Error).message}`);
      return e;
    }
  }
  const $ = loadHtml(html);
  const authorComment = extractLabeledText($, '【作者コメント】');
  const hostComment = extractLabeledText($, '【管理人コメント】');
  // Fallback for No.0 combined label
  let combined: string | undefined;
  if (!authorComment && !hostComment) {
    combined = extractLabeledText($, '【作者・管理人コメント】') || extractLabeledText($, '【作者/管理人コメント】');
  }
  const detailScreenshots = collectDetailScreenshots($);
  e.authorComment = authorComment || combined;
  e.hostComment = hostComment;
  e.detailScreenshots = detailScreenshots;
  return e;
}

function looksLikeImageBuffer(buf: Buffer): boolean {
  if (!buf || buf.length < 8) return false;
  // PNG
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true;
  // JPG
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;
  // GIF
  if (buf.slice(0, 6).toString('ascii') === 'GIF89a' || buf.slice(0, 6).toString('ascii') === 'GIF87a') return true;
  // BMP
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true;
  // Else likely HTML
  return false;
}

async function saveAssets(entries: Entry[]) {
  ensureDir(ICONS_DIR);
  ensureDir(SS_DIR);
  const ssReport: Record<string, { saved: number; skipped: { source: string; reason: 'small' | 'duplicate' }[]; failures: string[] } > = {};
  for (const e of entries) {
    // Icon
    if (e.iconSrc) {
      try {
        const buf = await fetchBinary(absol(e.iconSrc));
        if (looksLikeImageBuffer(buf)) saveFile(path.join(ICONS_DIR, `${e.no}.png`), buf);
      } catch (err) {
        console.warn(`icon ${e.no} failed: ${(err as Error).message}`);
      }
    }
    // Screenshots: from detail only on this site
    const ssSources = Array.from(new Set(e.detailScreenshots || []));
    const seenHashes = new Set<string>();
    const skipped: { source: string; reason: 'small' | 'duplicate' }[] = [];
    const failures: string[] = [];
    let saved = 0;
    let idx = 0;
    for (const s of ssSources) {
      try {
        const buf = await fetchBinary(absol(s));
        if (!looksLikeImageBuffer(buf)) { failures.push(s); continue; }
        const h = hashBuf(buf);
        if (seenHashes.has(h)) { skipped.push({ source: s, reason: 'duplicate' }); continue; }
        seenHashes.add(h);
        const name = idx === 0 ? `${e.no}.png` : `${e.no}-${String(idx + 1).padStart(2, '0')}.png`;
        saveFile(path.join(SS_DIR, name), buf);
        saved++;
        idx++;
      } catch (err) {
        failures.push(s);
      }
    }
    ssReport[e.no] = { saved, skipped, failures };
  }
  return ssReport;
}

function buildScreenshotReportFromDisk(entries: Entry[]) {
  const report: Record<string, { saved: number; skipped: { source: string; reason: 'small' | 'duplicate' }[]; failures: string[] }> = {};
  for (const e of entries) {
    let saved = 0;
    const p1 = path.join(SS_DIR, `${e.no}.png`);
    if (fs.existsSync(p1)) saved++;
    for (let k = 2; k <= 12; k++) {
      const name = `${e.no}-${String(k).padStart(2, '0')}.png`;
      if (fs.existsSync(path.join(SS_DIR, name))) saved++;
    }
    report[e.no] = { saved, skipped: [], failures: [] };
  }
  return report;
}

function exportBannersFromIndex(indexHtml: string) {
  const $ = loadHtml(indexHtml);
  const imgs: string[] = [];
  $('nav img').each((_, img) => {
    const src = $(img).attr('src');
    if (src && /gw2022/i.test(src)) imgs.push(src);
  });
  let saved = 0;
  for (let i = 0; i < imgs.length; i++) {
    // Only save the first as canonical SLUG.png; others saved as -2, -3
    // downloading synchronously here
  }
  return { imgs };
}

async function downloadBanners(indexHtml: string) {
  const $ = loadHtml(indexHtml);
  const imgs: string[] = [];
  $('nav img').each((_, img) => {
    const src = $(img).attr('src');
    if (src && /gw2022/i.test(src)) imgs.push(src);
  });
  const sources: string[] = [];
  for (let i = 0; i < imgs.length; i++) {
    try {
      const url = absol(imgs[i]);
      const buf = await fetchBinary(url);
      const out = i === 0 ? path.join(BANNERS_DIR, `${SLUG}.png`) : path.join(BANNERS_DIR, `${SLUG}-${i + 1}.png`);
      if (looksLikeImageBuffer(buf)) saveFile(out, buf);
      sources.push(url);
    } catch (err) {
      // ignore
    }
  }
  return sources;
}

async function main() {
  ensureDir(CACHE_DIR);
  const indexPath = path.join(CACHE_DIR, 'index.html');
  let html = readFile(indexPath);
  if (!html) {
    html = await fetchText(BASE);
    saveFile(indexPath, html);
  }

  // Download banners
  const bannerSources = await downloadBanners(html!);

  const entries = parseList(html!);
  // Enrich
  for (let i = 0; i < entries.length; i++) {
    entries[i] = await enrichFromDetail(entries[i]);
  }
  // Save assets (skip network; use pre-downloaded disk images to report)
  const ssReport = buildScreenshotReportFromDisk(entries);

  // Build works JSON
  const works = entries.map((e) => {
    const work: {
      id: string;
      festivalId: string;
      title: string;
      author: string;
      category?: string;
      engine?: string;
      streaming?: string;
      forum?: string;
      icon?: string;
      ss?: string[];
      no: string;
      authorComment?: string;
      hostComment?: string;
    } = {
      id: `${SLUG}-work-${e.no}`,
      festivalId: SLUG,
      title: e.title,
      author: e.author,
      category: e.category,
      engine: e.engine,
      streaming: e.streaming,
      forum: e.forum,
      icon: path.posix.join('/icons', SLUG, `${e.no}.png`),
      no: e.no,
    };
    if (e.authorComment) work.authorComment = e.authorComment;
    if (e.hostComment) work.hostComment = e.hostComment;
    // Build ss array based on saved files
    const ssFiles: string[] = [];
    const p1 = path.join(SS_DIR, `${e.no}.png`);
    if (fs.existsSync(p1)) ssFiles.push(path.posix.join('/screenshots', SLUG, `${e.no}.png`));
    for (let k = 2; k <= 12; k++) {
      const name = `${e.no}-${String(k).padStart(2, '0')}.png`;
      const p = path.join(SS_DIR, name);
      if (fs.existsSync(p)) ssFiles.push(path.posix.join('/screenshots', SLUG, name));
    }
    if (ssFiles.length) work.ss = ssFiles;
    return work;
  });

  const worksPath = path.join('src', 'data', 'works', `${SLUG}.json`);
  saveFile(worksPath, JSON.stringify(works, null, 2));

  // Summary JSON
  const summary = {
    festivalId: SLUG,
    generatedAt: new Date().toISOString(),
    banners: bannerSources.map((s, i) => ({ index: i + 1, source: s })),
    stats: { captured: works.length, skipped: 0 },
    entries: entries.map((e) => ({
      index: e.no,
      status: 'ok',
      title: e.title,
      note: `ダウンロード: ${e.downloadHref ? 1 : 0}件`,
      downloadSource: e.downloadHref ? [e.downloadHref] : [],
      screenshotReport: ssReport[e.no] || { saved: 0 },
    })),
  };
  const summaryPath = path.join('catch', SLUG, `${SLUG}-scrape-summary.json`);
  saveFile(summaryPath, JSON.stringify(summary, null, 2));

  console.log(`Updated: ${worksPath}`);
  console.log(`Summary: ${summaryPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
