import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { decodeSource, imageExtension, writeJson } from './recover-entry-table';
import type { Festival, WorkEntry } from '../src/lib/types';

type Capture = { originalUrl: string; actualUrl: string; status: number; file: string; sha256: string; kind: string; no?: string; gameId?: number; directory?: string };
type Row = { no: string; title: string; author: string; category: string; engine: string; streaming: string; iconUrl?: string; rateUrl?: string; gameUrl?: string; gameId?: number; forumUrl?: string; catalogueLinks: string[]; gameUrlEvidence?: string };
const read = async <T,>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, 'utf8'));
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const canonical = (raw: string, owner: string) => { const u = new URL(raw, owner); u.hash = ''; return u.href.replace(/\?$/, ''); };
function extension(bytes: Buffer) {
  const magic = bytes.subarray(0, 4).toString(), hex = bytes.subarray(0, 4).toString('hex');
  if (magic === 'wOF2') return 'woff2'; if (magic === 'wOFF') return 'woff';
  if (hex === '00010000') return 'ttf'; if (magic === 'OTTO') return 'otf';
  if (bytes.length > 36 && bytes.subarray(34, 36).toString('hex') === '4c50') return 'eot';
  if (hex === '00000200') return 'cur';
  if (/<svg[\s>]/i.test(bytes.subarray(0, 1000).toString())) return 'svg';
  return imageExtension(bytes);
}

// Rebuild only from saved responses. Fetch batches and region changes stay explicit.
export async function recoverItchJam(config: { id: string; base: string; expectedRows: number; name: string; type: string; period: string }) {
  const { id, base } = config, root = `catch/${id}`;
  const current = await read<Record<string, Capture>>(`${root}/source/live/manifest.json`);
  const archived = await read<Record<string, Capture>>(`${root}/source/archive/manifest.json`).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return {}; throw error; });
  const rows = await read<Row[]>(`${root}/investigation/catalogue-rows.json`);
  const selected: Record<string, Capture> = {}, buffers = new Map<string, Buffer>(), resources: Record<string, string> = {}, replay: Record<string, Capture> = {};
  const formats = new Map<string, string>(), replacements = [];
  for (const [directory, manifest] of [['live', current], ['archive', archived]] as const) for (const [url, capture] of Object.entries(manifest)) {
    if (capture.status !== 200 || !capture.file) continue;
    const bytes = await fs.readFile(`${root}/source/${directory}/${capture.file}`);
    if (hash(bytes) !== capture.sha256) throw new Error('Source hash mismatch');
    if (capture.kind === 'pagination' || capture.kind === 'forum-evidence') continue;
    if (capture.kind === 'rate' && directory === 'live' && canonical(capture.actualUrl, base) !== canonical(url, base)) continue;
    if (directory === 'archive' && selected[url]) continue;
    selected[url] = { ...capture, directory }; buffers.set(url, bytes);
    if (directory === 'archive') replacements.push({ url, snapshotUrl: capture.actualUrl, liveStatus: current[url]?.status, liveActualUrl: current[url]?.actualUrl });
  }
  for (const [url, capture] of Object.entries(selected)) {
    const bytes = buffers.get(url)!; let local: string;
    if (capture.kind === 'jam') local = 'index.html';
    else if (capture.kind === 'entries') local = 'entries.html';
    else if (capture.kind === 'screenshots') local = 'screenshots.html';
    else if (capture.kind === 'rate') local = `rate/${capture.gameId}.html`;
    else if (capture.kind === 'game') local = `game/${capture.gameId}.html`;
    else if (capture.kind === 'css') local = `styles/${hash(url).slice(0, 24)}.css`;
    else {
      const ext = extension(bytes); formats.set(url, ext);
      const font = /^(woff2?|ttf|otf|eot)$/.test(ext) || (ext === 'svg' && /<font[\s>]/.test(bytes.toString()));
      local = `${font ? 'fonts' : 'assets'}/${hash(url).slice(0, 24)}.${ext}`;
    }
    resources[canonical(url, base)] = local;
    if (capture.directory === 'live') resources[canonical(capture.actualUrl, base)] = local;
    replay[url] = { ...capture, file: `../${capture.directory}/${capture.file}` };
  }
  resources[`${base}/`] = 'index.html';
  const gaps = rows.filter(row => !row.rateUrl || !selected[row.rateUrl]).map(row => ({ no: row.no, sourcePath: `rate/${row.gameId}.html`, originalUrl: row.rateUrl, sourceStatus: row.rateUrl ? current[row.rateUrl]?.status : undefined, currentProjectStatus: row.gameUrl ? current[row.gameUrl]?.status : undefined, forumEvidence: row.gameUrlEvidence }));
  for (const gap of gaps) if (gap.originalUrl) resources[gap.originalUrl] = gap.sourcePath;
  const alias = (raw: string, owner: string) => { try { const u = new URL(raw, owner), local = resources[canonical(u.href, base)]; if (local) resources[u.href] = local; } catch { /* Source fragments and non-URL attributes. */ } };
  for (const [url, capture] of Object.entries(selected)) {
    if (capture.kind === 'asset') continue;
    const text = buffers.get(url)!.toString('utf8');
    if (capture.kind !== 'css') {
      const $ = cheerio.load(text);
      $('[src],[href],[data-lazy_src],[data-src],[data-background_image]').each((_, element) => { for (const attr of ['src','href','data-lazy_src','data-src','data-background_image']) { const raw = $(element).attr(attr); if (raw) alias(raw, url); } });
    }
    for (const match of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) alias(match[1], url);
  }
  const sanitize = (html: string, owner: string) => {
    const $ = cheerio.load(`<div class="source-comment">${html}</div>`); $('script,style,noscript,iframe,form,object,embed,link,meta').remove();
    $('img').each((_, image) => {
      const node = $(image), raw = node.attr('src') || node.attr('data-lazy_src') || node.attr('data-src');
      if (!raw) { node.remove(); return; }
      const local = resources[canonical(raw, owner)]; if (!local) throw new Error('Unarchived comment/description image');
      node.attr('src', `/original-pages/${id}/${local}`).removeAttr('srcset data-lazy_src data-src');
    });
    $('*').each((_, element) => { for (const attr of Object.keys(element.attribs)) if (attr.startsWith('on') || ['style','width','height','align','bgcolor','background','color','face','size'].includes(attr)) $(element).removeAttr(attr); });
    $('a[href]').each((_, a) => { const raw = $(a).attr('href')!; if (raw.startsWith('#')) return; const u = new URL(raw, owner); if (!['http:','https:','mailto:'].includes(u.protocol)) $(a).removeAttr('href'); else $(a).attr('href', resources[canonical(u.href, base)] ? `/original-pages/${id}/${resources[canonical(u.href, base)]}${u.hash}` : u.href); });
    return $('body>div').html()?.trim() || '';
  };
  const page = (url: string) => cheerio.load(buffers.get(url)!.toString('utf8'));
  const overview = page(base), catalogue = overview('table').first().find('tr').slice(1);
  if (rows.length !== config.expectedRows || catalogue.length !== rows.length) throw new Error('Catalogue row count changed');
  const hosts = overview('.jam_host_header a[href]').toArray().map(a => new URL(overview(a).attr('href')!, base));
  const hostProfiles = new Set(hosts.filter(u => u.hostname.endsWith('.itch.io')).map(u => `/profile/${u.hostname.slice(0, -8)}`));
  const saveImage = async (raw: string, owner: string, folder: string, stem: string) => {
    const url = canonical(raw, owner), bytes = buffers.get(url), ext = formats.get(url);
    if (!bytes || !ext) throw new Error(`Source image missing: ${url}`);
    const local = `/${folder}/${id}/${stem}.${ext}`; await fs.mkdir(path.dirname(`public${local}`), { recursive: true }); await fs.writeFile(`public${local}`, bytes);
    return { sourceUrl: url, local, sha256: hash(bytes) };
  };
  const works: WorkEntry[] = [], entries = [];
  for (const [index, row] of rows.entries()) {
    const cells = overview(catalogue[index]).children('td');
    if (cells.eq(0).text().trim() !== row.no || cells.eq(3).text().trim() !== row.title) throw new Error('Catalogue identity mismatch');
    const game = row.gameUrl ? selected[row.gameUrl] : undefined, rate = row.rateUrl ? selected[row.rateUrl] : undefined, stem = /^\d+$/.test(row.no) ? row.no.padStart(2, '0') : row.no.toLowerCase();
    const source = game || rate;
    const work: WorkEntry = { id: `${id}-work-${stem}`, festivalId: id, no: row.no, title: row.title, author: row.author, category: row.category, engine: row.engine, streaming: row.streaming, source: { url: source?.originalUrl || base, titleUrl: base, ...(!row.author ? { authorOmitted: true } : {}), ...(source?.directory === 'archive' ? { snapshotUrl: source.actualUrl } : {}) } };
    if (row.forumUrl) work.forum = new URL(row.forumUrl, base).href;
    if (row.iconUrl) work.icon = (await saveImage(row.iconUrl, base, 'icons', `${stem}-source`)).local;
    const descriptions: string[] = [], screenshots = [], officialPosts = [];
    if (game) {
      const $ = page(game.originalUrl), ids = [...buffers.get(game.originalUrl)!.toString().matchAll(/(?:game_id|"id"|\bid)\s*[":= ]+\s*(\d{5,})/g)].map(m => Number(m[1]));
      if (row.gameId && !ids.includes(row.gameId)) throw new Error('Project game identifier mismatch');
      const title = $('h1.game_title').text().trim(); if (title && title.normalize('NFKC').replace(/\s/g, '') !== row.title.normalize('NFKC').replace(/\s/g, '')) work.originalTitle = title;
      for (const href of [...new Set($('.screenshot_list a[href]').toArray().map(a => new URL($(a).attr('href')!, game.originalUrl).href))]) screenshots.push(await saveImage(href, game.originalUrl, 'screenshots', `${stem}-source-${screenshots.length + 1}`));
      for (const element of $('.formatted_description').toArray().filter(e => !$(e).closest('.community_post').length)) { const content = sanitize($(element).html() || '', game.originalUrl); if (content) descriptions.push(content); }
    } else work.sourceDetailUnavailable = true;
    if (rate) {
      const $ = page(rate.originalUrl);
      for (const response of $('section.field_responses p').toArray()) {
        const clone = $(response).clone(), label = clone.find('strong').first().text().trim();
        if (label === '作者コメント') { clone.find('strong').first().remove(); work.authorComment = sanitize(clone.html() || '', rate.originalUrl).replace(/^(?:\s|<br\s*\/?>)+/i, '').trim(); }
        else descriptions.push(sanitize($(response).toString(), rate.originalUrl));
      }
      for (const post of $('.community_post').toArray()) {
        const author = $(post).find('.post_header .post_author a[href]').first().attr('href') || '';
        if (!hostProfiles.has(author) && !hosts.some(u => author.replace(/\/$/, '') === u.href.replace(/\/$/, ''))) continue;
        const content = sanitize($(post).find('.post_content .post_body').first().html() || '', rate.originalUrl); if (content) officialPosts.push({ id: $(post).attr('id') || $(post).attr('data-post_id'), html: content });
      }
    }
    if (!source && row.forumUrl) {
      const cap = current[row.forumUrl];
      if (cap?.status === 200 && cap.file) { const $ = cheerio.load(decodeSource(await fs.readFile(`${root}/source/live/${cap.file}`), 'shift_jis')); const first = $('dd').first().html(); if (first) descriptions.push(sanitize(`<p>公式感想掲示板の先頭投稿</p>${first}`, row.forumUrl)); }
    }
    if (screenshots.length) work.ss = screenshots.map(s => s.local);
    if (descriptions.length) work.sourceContent = descriptions.join('\n<hr>\n');
    if (officialPosts.length) work.hostComment = officialPosts.map(p => p.html).join('\n<hr>\n');
    const urls = [...new Set([row.gameUrl, ...row.catalogueLinks].filter((u): u is string => !!u))];
    if (urls.length) { work.downloads = urls.map(url => ({ url, label: '原配布・投稿ページ' })); work.download = work.downloads[0]; }
    works.push(work); entries.push({ no: row.no, gameId: row.gameId, gameSource: game, rateSource: rate, sourceDetailUnavailable: !!work.sourceDetailUnavailable, screenshotSources: screenshots, authorComment: !!work.authorComment, officialPosts: officialPosts.map(p => p.id), descriptionBlocks: descriptions.length, gameUrlEvidence: row.gameUrlEvidence });
  }
  const bannerUrl = overview('.jam_content img[src]').toArray().map(e => overview(e).attr('src')!).find(u => /img\.itch\.zone\/aW1n/i.test(u));
  if (!bannerUrl) throw new Error('Source banner missing');
  const banner = await saveImage(bannerUrl, base, 'banners', 'source');
  const festivals = await read<Festival[]>('src/data/festivals.json');
  const festival: Festival = { id, slug: id, year: Number(id.slice(0, 4)), name: config.name, type: config.type, period: config.period, banners: [banner.local], worksFile: `works/${id}.json`, columns: ['no','icon','work','type','streaming','download','forum'] };
  const existing = festivals.findIndex(f => f.id === id); if (existing < 0) festivals.unshift(festival); else festivals[existing] = festival;
  const append = await read<{ num_items: number; derivedFrom: Array<{ numItems: number; sha256: string }> }>(`${root}/source/derived/screenshots-append.json`);
  if (append.derivedFrom.at(-1)?.numItems !== 0) throw new Error('Screenshot pagination end not captured');
  const initialItems = page(`${base}/screenshots`)('.game_screenshot_cell').length;
  await fs.mkdir(`${root}/source/replay`, { recursive: true });
  await writeJson(`${root}/source/replay/manifest.json`, replay);
  await writeJson(`src/data/works/${id}.json`, works); await writeJson('src/data/festivals.json', festivals);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: `${base}/`, liveSource: true, proxyRegion: 'Japan; explicit archived replacements fetched through Hong Kong', entries, sourceManifests: ['source/replay/manifest.json'], originalResources: resources, archiveReplacements: replacements, sourceDetailGaps: gaps, screenshotOverview: { initialItems, additionalItems: append.num_items, totalItems: initialItems + append.num_items, appendSourceFile: 'source/derived/screenshots-append.json' }, banner, handling: 'Direct source archival without content screening. Keep every catalogue row, including sample, ED and unavailable project entries. Preserve all gallery originals, catalogue metadata, rate responses and organizer posts separately; no game packages downloaded.', desktopReview: 'pending' });
  console.log(JSON.stringify({ festival: id, works: works.length, screenshots: works.reduce((n,w) => n + (w.ss?.length || 0), 0), comments: works.filter(w => w.authorComment).length, catalogueOnly: works.filter(w => w.sourceDetailUnavailable).length, archiveReplacements: replacements.length, sourceGaps: gaps.length }));
}
