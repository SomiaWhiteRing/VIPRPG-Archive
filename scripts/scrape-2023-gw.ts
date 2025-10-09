import fs from 'node:fs';
import path from 'node:path';
import { load as loadHtml } from 'cheerio';

// Minimal fetch typings
interface SimpleResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}
declare function fetch(
  url: string,
  init?: { redirect?: 'follow' | 'manual' | 'error'; headers?: Record<string, string> }
): Promise<SimpleResponse>;

type Entry = {
  no: string; // e.g., "01"
  title: string;
  author: string;
  engine?: string;
  category?: string;
  streaming?: string;
  forum?: string;
  downloadHref?: string;
  iconSrc?: string;
  screenshotSrc?: string;
  entryHref?: string;
  authorComment?: string;
  hostComment?: string;
  detailScreenshots?: string[];
};

const SLUG = '2023-gw';
const BASE = 'https://viprpg2023gw.neocities.org/';

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

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VIPRPG-Archive/1.0)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('utf8');
}

async function fetchBinary(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VIPRPG-Archive/1.0)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function absol(url: string): string {
  return new URL(url, BASE).toString();
}

function cleanText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function compressSpacesKeepNewlines(s: string): string {
  return s.replace(/[ \t]+/g, ' ').replace(/\u00A0/g, ' ').trim();
}

function decodeEntitiesPlain(text: string): string {
  // Decode HTML entities in a plain string via Cheerio
  const $ = loadHtml(`<div>${text}</div>`);
  return $('div').text();
}

function decodeHtmlPreserveBreaks(html: string): string {
  // Replace <br> with newlines, strip tags, decode entities; keep line breaks
  const withBreaks = html.replace(/<br\s*\/?>(\s*)/gi, '\n');
  const $ = loadHtml(`<div>${withBreaks}</div>`);
  // Cheerio .text() decodes entities
  const t = $('div').text();
  return t.replace(/\r\n?/g, '\n');
}

function parseList(html: string): Entry[] {
  const $ = loadHtml(html);
  const entries: Entry[] = [];
  $('.wrapUnder-contents-listItem').each((_, el) => {
    const $item = $(el);
    const $titleA = $item.find('.wrapUnder-contents-listItem-descriptionTitle a').first();
    if (!$titleA.length) return;
    const entryHref = $titleA.attr('href') || '';
    // Extract number from href like ./entry01.html
    const noMatch = entryHref.match(/entry(\d+)\.html/i);
    if (!noMatch) return;
    const no = noMatch[1];
    // include 00 (sample page) per requirement

    const titleFull = cleanText($titleA.text()); // e.g., 'No.01 Title'
    const title = titleFull.replace(/^No\.\d+\s*/, '');

    // Icon img near title
    const $iconImg = $item.find('.wrapUnder-contents-listItem-descriptionTitle img[src*="/img/icon/"]').first();
    const iconSrc = $iconImg.attr('src') || undefined;

    // Main screenshot within picture/img
    const $ssImg = $item.find('.wrapUnder-contents-listItem-img img').first();
    const screenshotSrc = $ssImg.attr('src') || undefined;

    // Parse description lines
    const $desc = $item.find('.wrapUnder-contents-listItem-descriptionText').first();
    let author = '';
    let engine: string | undefined;
    let category: string | undefined;
    let streaming: string | undefined;
    let forum: string | undefined;
    let downloadHref: string | undefined;

    // Extract anchors for forum/download
    $desc.find('a').each((__, a) => {
      const href = $(a).attr('href') || '';
      const text = cleanText($(a).text());
      if (!forum && /感想掲示板|運営掲示板/.test(text)) {
        forum = href;
      }
      if (!downloadHref && /DL\(/.test(text)) {
        downloadHref = href || undefined;
      }
    });

    // Extract text chunks and decode entities
    const raw = $desc.html() || '';
    const textWithNewlines = decodeHtmlPreserveBreaks(raw);
    for (const line of textWithNewlines.split(/\n+/)) {
      const l = compressSpacesKeepNewlines(line);
      if (!l) continue;
      const mAuthor = l.match(/【作者】(.+)/);
      if (mAuthor) author = compressSpacesKeepNewlines(decodeEntitiesPlain(mAuthor[1]));
      const mEngine = l.match(/【使用ツール】(.+)/);
      if (mEngine) engine = compressSpacesKeepNewlines(decodeEntitiesPlain(mEngine[1]));
      const mGenre = l.match(/【ジャンル】(.+)/);
      if (mGenre) category = compressSpacesKeepNewlines(decodeEntitiesPlain(mGenre[1]));
      const mStream = l.match(/【配信\/投稿】(.+)/);
      if (mStream) streaming = compressSpacesKeepNewlines(decodeEntitiesPlain(mStream[1]));
    }

    entries.push({
      no,
      title,
      author,
      engine,
      category,
      streaming,
      forum,
      downloadHref,
      iconSrc,
      screenshotSrc,
      entryHref,
    });
  });
  // Sort by numeric no
  entries.sort((a, b) => parseInt(a.no, 10) - parseInt(b.no, 10));
  return entries;
}

function decodeDataUriToBuffer(dataUri: string): Buffer | undefined {
  const m = dataUri.match(/^data:image\/(png|jpeg);base64,(.+)$/i);
  if (!m) return undefined;
  return Buffer.from(m[2], 'base64');
}

function exportBannersFromIndex(indexHtml: string) {
  const $ = loadHtml(indexHtml);
  const dataImgs: string[] = [];
  $('img').each((_, img) => {
    const src = $(img).attr('src');
    if (src && src.startsWith('data:image/')) dataImgs.push(src);
  });
  const bannersDir = path.join('public', 'banners');
  ensureDir(bannersDir);
  let saved = 0;
  dataImgs.forEach((src, i) => {
    const buf = decodeDataUriToBuffer(src);
    if (!buf) return;
    const out = path.join(bannersDir, `${SLUG}-${i + 1}.png`);
    fs.writeFileSync(out, buf);
    saved++;
  });
  return saved;
}

function extractTextFromLabeledCell($: cheerio.Root, label: string): string | undefined {
  let found: string | undefined;
  const labelEsc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startRe = new RegExp('^\n?\s*' + labelEsc + '\s*(?:<br\s*\/?\s*|:|：)?', 'i');
  $('#entry td').each((_, td) => {
    const $td = $(td);
    const html = $td.html() || '';
    const fullText = decodeHtmlPreserveBreaks(html);
    if (!fullText.includes(label)) return; // only capture labeled cells
    const strippedHtml = html.replace(startRe, '');
    const text = decodeHtmlPreserveBreaks(strippedHtml);
    const normalized = text
      .split('\n')
      .map((line) => compressSpacesKeepNewlines(line))
      .join('\n')
      .trim();
    if (!found && normalized.length > 0) {
      // Some cells may render a stray leading '>' in text; strip it once
      found = normalized.replace(/^\s*[>＞]\s?/, '');
    }
  });
  return found;
}

async function enrichFromDetail(e: Entry, cacheDir: string) {
  if (!e.entryHref) return e;
  const no = e.no;
  const file = path.join(cacheDir, `entry${no}.html`);
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
  const $ = loadHtml(html!);
  // Comments
  const authorComment = extractTextFromLabeledCell($, '作者コメント：');
  const hostComment = extractTextFromLabeledCell($, '管理人コメント：');
  // Detail screenshots: imgs under #entry that are not icon
  const ss: string[] = [];
  $('#entry img').each((_, img) => {
    const src = $(img).attr('src') || '';
    if (src.includes('/img/ss/')) ss.push(src);
    const over = $(img).attr('onmouseover') || '';
    const out = $(img).attr('onmouseout') || '';
    const rx = /'([^']+\/img\/ss\/[A-Za-z0-9_\-]+\.png)'/g;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(over)) !== null) {
      ss.push(m[1]);
    }
    rx.lastIndex = 0;
    while ((m = rx.exec(out)) !== null) {
      ss.push(m[1]);
    }
  });
  e.authorComment = authorComment;
  e.hostComment = hostComment;
  e.detailScreenshots = Array.from(new Set(ss));
  return e;
}

async function saveAssets(entries: Entry[]) {
  const iconDir = path.join('public', 'icons', SLUG);
  const ssDir = path.join('public', 'screenshots', SLUG);
  ensureDir(iconDir);
  ensureDir(ssDir);

  for (const e of entries) {
    // Icon
    if (e.iconSrc) {
      try {
        const buf = await fetchBinary(absol(e.iconSrc));
        saveFile(path.join(iconDir, `${e.no}.png`), buf);
      } catch (err) {
        console.warn(`icon ${e.no} failed: ${(err as Error).message}`);
      }
    }
    // Screenshots: list screenshot as primary; details as extras
    const ssSources: string[] = [];
    if (e.screenshotSrc) ssSources.push(e.screenshotSrc);
    if (e.detailScreenshots && e.detailScreenshots.length) {
      for (const s of e.detailScreenshots) {
        if (!ssSources.includes(s)) ssSources.push(s);
      }
    }
    for (let i = 0; i < ssSources.length; i++) {
      const s = ssSources[i];
      const filename = i === 0 ? `${e.no}.png` : `${e.no}-${String(i + 0).padStart(2, '0')}.png`;
      // Above produced 00 for second; adjust to -02
    }
    // Correct naming: first is NN.png, second NN-02.png, third NN-03.png
    let idx = 0;
    for (const s of ssSources) {
      const name = idx === 0 ? `${e.no}.png` : `${e.no}-${String(idx + 1).padStart(2, '0')}.png`;
      try {
        const buf = await fetchBinary(absol(s));
        saveFile(path.join(ssDir, name), buf);
      } catch (err) {
        console.warn(`screenshot ${e.no} #${idx + 1} failed: ${(err as Error).message}`);
      }
      idx++;
    }
  }
}

async function main() {
  const cacheDir = path.join('catch', SLUG);
  ensureDir(cacheDir);
  const indexPath = path.join(cacheDir, 'index.html');
  let html = readFile(indexPath);
  if (!html) {
    html = await fetchText(BASE);
    saveFile(indexPath, html);
  }
  // Export banners from data URIs (if present)
  exportBannersFromIndex(html!);
  const entries = parseList(html!);
  // Enrich from detail pages
  for (let i = 0; i < entries.length; i++) {
    entries[i] = await enrichFromDetail(entries[i], cacheDir);
  }

  // Save assets
  await saveAssets(entries);

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
      ss: undefined,
      no: e.no,
    };
    if (e.authorComment) work.authorComment = e.authorComment;
    if (e.hostComment) work.hostComment = e.hostComment;
    // Build ss array based on saved files list
    const ssFiles: string[] = [];
    const ssDir = path.join('public', 'screenshots', SLUG);
    const p1 = path.join(ssDir, `${e.no}.png`);
    if (fs.existsSync(p1)) ssFiles.push(path.posix.join('/screenshots', SLUG, `${e.no}.png`));
    for (let k = 2; k <= 6; k++) {
      const name = `${e.no}-${String(k).padStart(2, '0')}.png`;
      const p = path.join(ssDir, name);
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
    banner: `/banners/${SLUG}.png`,
    stats: { captured: works.length, skipped: 0 },
    entries: entries.map((e) => ({
      index: e.no,
      status: 'ok',
      title: e.title,
      note: `ダウンロード: ${e.downloadHref ? 1 : 0}件`,
      downloadSource: e.downloadHref ? [e.downloadHref] : [],
      screenshotReport: { saved: 1 },
    })),
  };
  const summaryPath = path.join('catch', `${SLUG}-scrape-summary.json`);
  saveFile(summaryPath, JSON.stringify(summary, null, 2));

  console.log(`Updated: ${worksPath}`);
  console.log(`Summary: ${summaryPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
