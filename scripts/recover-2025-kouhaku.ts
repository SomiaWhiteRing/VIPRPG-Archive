import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { decodeSource, imageExtension, writeJson } from './recover-entry-table';
import type { Festival, WorkEntry } from '../src/lib/types';

const id = '2025-kouhaku', root = `catch/${id}`, base = 'https://vipkohaku2025.x.2nt.com/';
type Capture = { originalUrl: string; actualUrl: string; file: string; status: number; sha256: string; contentType: string };
const read = async <T,>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, 'utf8'));
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function main() {
  const captures = await read<Record<string, Capture>>(`${root}/source/live/manifest.json`);
  const live = Object.fromEntries(Object.entries(captures).filter(([, capture]) => capture.status === 200 && new URL(capture.actualUrl).hostname === new URL(base).hostname));
  const bytes = new Map<string, Buffer>();
  for (const [url, capture] of Object.entries(live)) {
    const buffer = await fs.readFile(`${root}/source/live/${capture.file}`);
    if (hash(buffer) !== capture.sha256) throw new Error('Source hash mismatch');
    bytes.set(url, buffer);
  }
  await writeJson(`${root}/source/live/replay-manifest.json`, live);
  const page = (url: string) => { const buffer = bytes.get(url); if (!buffer) throw new Error(`Missing source: ${url}`); return cheerio.load(decodeSource(buffer, 'shift_jis')); };
  const local = (raw: string, owner: string) => {
    const url = new URL(raw, owner);
    return url.origin === new URL(base).origin && bytes.has(new URL(url.pathname, base).href) ? `/original-pages/${id}${url.pathname}${url.search}${url.hash}` : url.href;
  };
  const sanitize = (html: string, owner: string) => {
    const $ = cheerio.load(`<div>${html}</div>`);
    $('script,style,noscript,iframe,form,object,embed,link,meta,textarea').remove();
    $('*').each((_, element) => { for (const a of Object.keys(element.attribs)) if (a.startsWith('on') || ['style','width','height','align','bgcolor','background','color','face','size'].includes(a)) $(element).removeAttr(a); });
    $('img[src]').each((_, element) => $(element).attr('src', local($(element).attr('src')!, owner)));
    $('a[href]').each((_, element) => { const raw = $(element).attr('href')!; if (raw.startsWith('#')) return; const url = new URL(raw, owner); if (!['http:','https:','mailto:'].includes(url.protocol)) $(element).removeAttr('href'); else $(element).attr('href', local(raw, owner)); });
    return $('body>div').html()?.trim() || '';
  };
  const saveImage = async (url: string, directory: string, name: string) => {
    const buffer = bytes.get(url); if (!buffer) throw new Error(`Missing image: ${url}`);
    const src = `/${directory}/${id}/${name}.${imageExtension(buffer)}`;
    await fs.mkdir(path.dirname(`public${src}`), { recursive: true }); await fs.writeFile(`public${src}`, buffer);
    return { originalUrl: url, local: src, sha256: hash(buffer) };
  };
  const overviewUrl = `${base}sakuhin.html`, overview = page(overviewUrl);
  const detailUrls = [...new Set(overview('a[href]').toArray().map(a => overview(a).attr('href')!.trim()).filter(h => /^\d{3}(?:a\d+)?\.html$/.test(h)))];
  const works: WorkEntry[] = [], entries = [];
  for (const href of detailUrls) {
    const url = new URL(href, base).href, no = href.slice(0, 3), $ = page(url);
    const table = $('table').first(), rows = table.find('tr').toArray(), first = $(rows[0]);
    const title = first.find('font[size="+1"]').first().text().trim();
    if (!title || Number(first.find('font').first().text().match(/No\.?\s*(\d+)/i)?.[1]) !== Number(no)) throw new Error('Detail identity mismatch');
    const work: WorkEntry = { id: `${id}-work-${no}`, festivalId: id, no, title, author: '', source: { url, titleUrl: overviewUrl } };
    const consumed = new Set<number>([0, 1, rows.length - 1]);
    for (let i = 2; i < rows.length - 1; i++) {
      const row = $(rows[i]), text = row.text().trim();
      if (/^作成ツクール\s*[:：]/.test(text)) { work.engine = text.replace(/^作成ツクール\s*[:：]\s*/, ''); consumed.add(i); }
      else if (/^ジャンル\s*[:：]/.test(text)) { work.category = text.replace(/^ジャンル\s*[:：]\s*/, ''); consumed.add(i); }
      else if (/^作者名\s*[:：]/.test(text)) { work.author = text.replace(/^作者名\s*[:：]\s*/, ''); consumed.add(i); }
      else if (row.find('pre').length) { work.authorComment = sanitize(row.find('td').first().html() || '', url); consumed.add(i); }
      else if (/^管理人/.test(text)) { work.hostComment = sanitize(row.find('td').first().html() || '', url); consumed.add(i); }
      else if (/配信/.test(text) && i < 7 && !row.find('a,img').length) { work.streaming = text; consumed.add(i); }
      const downloads = row.find('a[href]').toArray().map(a => ({ url: new URL($(a).attr('href')!.trim(), url).href, label: $(a).text().trim() || 'Source download' })).filter(link => {
        const target = new URL(link.url);
        return target.origin !== new URL(base).origin && target.hostname !== 'jbbs.shitaraba.net';
      });
      if (downloads.length && /^ダウンロード/.test(text)) { work.downloads = downloads; work.download = downloads[0]; }
    }
    const hostIndex = rows.findIndex(row => /^管理人/.test($(row).text().trim()));
    if (hostIndex > 1) {
      const authorIndex = hostIndex - 1;
      work.authorComment = sanitize($(rows[authorIndex]).find('td').first().html() || '', url);
      consumed.add(authorIndex);
      const downloadRow = $(rows[hostIndex + 1]);
      const downloads = downloadRow.find('a[href]').toArray().map(a => ({ url: new URL($(a).attr('href')!.trim(), url).href, label: $(a).text().trim() || 'Source download' })).filter(link => new URL(link.url).origin !== new URL(base).origin && new URL(link.url).hostname !== 'jbbs.shitaraba.net');
      if (downloads.length) { work.downloads = downloads; work.download = downloads[0]; }
    }
    if (!work.author) throw new Error('Source author field missing');
    const forums = table.find('a[href]').toArray().map(a => new URL($(a).attr('href')!.trim(), url).href).filter(h => new URL(h).hostname === 'jbbs.shitaraba.net');
    if (forums.length) work.forum = forums[0];
    const extras = rows.flatMap((row, i) => !consumed.has(i) && $(row).text().trim() ? [sanitize($(row).find('td').first().html() || '', url)] : []);
    if (extras.length) work.sourceContent = extras.join('\n<hr>\n');
    const screenshots = [...new Set($(rows[1]).find('img[src]').toArray().map(img => new URL($(img).attr('src')!, url).href))];
    const screenshotSources = []; for (const image of screenshots) screenshotSources.push(await saveImage(image, 'screenshots', `${no}-source-${screenshotSources.length + 1}`));
    work.ss = screenshotSources.map(image => image.local);
    const card = overview(`a[href="${href}"]`).filter((_, a) => overview(a).find('img').length > 0).first().closest('td');
    const preview = card.find('img[src]').first().attr('src');
    if (preview) work.icon = (await saveImage(new URL(preview, overviewUrl).href, 'icons', `${no}-source`)).local;
    works.push(work); entries.push({ no, detailUrl: url, sourceCapture: live[url], fields: { author: !!work.author, engine: !!work.engine, category: !!work.category, streaming: !!work.streaming, authorComment: !!work.authorComment, hostComment: !!work.hostComment }, screenshotSources, previewUrl: preview ? new URL(preview, overviewUrl).href : undefined, downloadEntries: work.downloads?.length || 0 });
  }
  if (works.length !== 49) throw new Error('Catalogue count changed');
  const bannerSources = []; for (const name of ['klogo01.png', 'banana.png']) bannerSources.push(await saveImage(new URL(name, base).href, 'banners', name.replace(/\.png$/, '-source')));
  const festivals = await read<Festival[]>('src/data/festivals.json');
  const festival: Festival = { id, slug: id, year: 2025, name: 'VIPRPG紅白2025', type: 'kouhaku', period: '2025/12/10–2026/1/31', banners: bannerSources.map(b => b.local), columns: ['no','icon','work','type','streaming','download','forum'], worksFile: `works/${id}.json` };
  const existing = festivals.findIndex(f => f.id === id); if (existing < 0) festivals.unshift(festival); else festivals[existing] = festival;
  await writeJson(`src/data/works/${id}.json`, works); await writeJson('src/data/festivals.json', festivals);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, liveSource: true, proxyRegion: 'Japan', entries, bannerSources, sourceManifests: ['source/live/replay-manifest.json'], sourceEvidence: [`${root}/festival-discovery.json`, `${root}/investigation/no016-cdx.json`], sourceGaps: [{ no: '016', status: 'not-linked-in-current-catalogue', liveCandidate: captures[`${base}016.html`], archiveEvidence: `${root}/investigation/no016-cdx.bin`, note: 'Current update log mentions this number, but the current catalogue has no row or detail link; direct numbered candidate redirects to the host 404 page (HTTP 200), and the exact Wayback CDX lookup is empty. Preserve this unresolved historical gap; do not invent its title or contents.' }], handling: 'Direct source archival without content screening. Catalogue previews, detail screenshots, author and organizer comments kept separately. No game packages downloaded. Current source numbering retained.', desktopReview: 'pending' });
  console.log(JSON.stringify({ works: works.length, icons: works.filter(w => w.icon).length, screenshots: works.reduce((n,w) => n + (w.ss?.length || 0), 0), authorComments: works.filter(w => w.authorComment).length, hostComments: works.filter(w => w.hostComment).length, downloads: works.filter(w => w.download).length }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
