import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { imageExtension, writeJson } from './recover-entry-table';
import { materializeAtWikiRegions } from './source-atwiki-regions';
import type { Festival, WorkEntry, WorkDownload } from '../src/lib/types';

const id = '2021-kouhaku', root = `catch/${id}`, base = 'https://w.atwiki.jp/vipkohaku2021/';
const landingBase = 'https://vipkohaku2021.web.fc2.com/';
type Capture = { originalUrl: string; actualUrl: string; status: number; file: string; sha256: string; kind: string; usable?: boolean };
const read = async <T,>(p: string): Promise<T> => JSON.parse(await fs.readFile(p, 'utf8'));
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const norm = (s: string) => s.normalize('NFKC').replace(/\s/g, '');
const absolute = (s: string, owner = base) => new URL(s, owner).href;
const key = (s: string, owner = base) => { const u = new URL(s, owner); u.hash = ''; return u.href; };
const native = (b: Buffer) => /<svg[\s>]/i.test(b.subarray(0, 1000).toString()) ? 'svg' : imageExtension(b);
const controls = 'script,style,noscript,iframe,form,object,embed,.plugin_contents,.table_zebra_data,.plugin_vote3,#atwiki-page-tags,#atwiki-liked-counter,.atwiki-page-keyword,.atwiki-lastmodify';

async function main() {
  const old = await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`);
  const pages = await read<Record<string, Capture>>(`${root}/source/live/manifest.json`), styles = await read<Record<string, Capture>>(`${root}/source/styles/manifest.json`), assets = await read<Record<string, Capture>>(`${root}/source/resources/manifest.json`);
  const landing = await read<Record<string, Capture>>(`${root}/source/landing/manifest.json`);
  const resources: Record<string, string> = {}, buffers = new Map<string, Buffer>(), replay: Record<string, unknown> = {};
  for (const [dir, manifest] of [['live', pages], ['styles', styles], ['resources', assets], ['landing', landing]] as const) for (const c of Object.values(manifest)) {
    const b = await fs.readFile(`${root}/source/${dir}/${c.file}`);
    if (c.status !== 200 || c.usable === false || hash(b) !== c.sha256) throw new Error('Source payload verification failed');
    const url = key(c.originalUrl), local = c.kind === 'html' ? (dir === 'landing' ? 'index.html' : url === base ? 'wiki/index.html' : 'wiki/' + new URL(url).pathname.slice('/vipkohaku2021/'.length)) : `${c.kind === 'css' ? 'styles' : 'assets'}/${hash(Buffer.from(url)).slice(0, 24)}.${c.kind === 'css' ? 'css' : native(b)}`;
    resources[url] = local; buffers.set(url, b); replay[url] = { ...c, file: `../${dir}/${c.file}` };
  }
  resources[landingBase] = 'index.html';
  const sanitize = (html: string, owner: string) => {
    const q = cheerio.load(`<div class="source-comment">${html}</div>`);
    q(controls).remove(); q('a[href]').filter((_, e) => /\/(?:pedit|edit|cmd|backup)\//.test(q(e).attr('href') || '')).remove();
    q('*').each((_, e) => { for (const a of Object.keys(e.attribs)) if (a.startsWith('on') || ['id', 'style', 'align', 'bgcolor', 'color', 'face', 'size'].includes(a) || (['width', 'height'].includes(a) && e.tagName !== 'img')) q(e).removeAttr(a); });
    q('source').remove(); q('[srcset]').removeAttr('srcset');
    q('img[src]').each((_, e) => { const u = key(q(e).attr('src')!, owner); if (!resources[u]) throw new Error('Uncaptured comment image'); q(e).attr('src', `/original-pages/${id}/${resources[u]}`); });
    q('a[href]').each((_, e) => { const u = new URL(q(e).attr('href')!, owner); if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) q(e).removeAttr('href'); else q(e).attr('href', resources[key(u.href)] ? `/original-pages/${id}/${resources[key(u.href)]}${u.hash}` : u.href); });
    q('blockquote,div').toArray().reverse().forEach(e => { if (!q(e).text().trim() && !q(e).find('img,details,a[href]').length && !q(e).hasClass('source-comment')) q(e).remove(); });
    q('details').toArray().reverse().forEach(e => { const b = q(e).children('.source-region-body'); if (!b.text().trim() && !b.find('img,a[href]').length) q(e).remove(); });
    return q('body>div').toString();
  };
  const media = async (url: string, folder: string, name: string) => {
    const b = buffers.get(key(url)); if (!b) throw new Error('Source image absent');
    const local = `/${folder}/${id}/${name}.${native(b)}`; await fs.mkdir(path.dirname(`public${local}`), { recursive: true }); await fs.writeFile(`public${local}`, b);
    return { sourceUrl: url, local, sha256: hash(b) };
  };
  const lines = (html: string) => { const q = cheerio.load(`<div>${html}</div>`); q('br').replaceWith('\n'); return q('body>div').text().split('\n').map(s => s.trim()).filter(Boolean); };
  const $ = cheerio.load(buffers.get(base + 'pages/113.html')!), works: WorkEntry[] = [], entries = [];
  const rows = $('#wikibody tr').filter((_, e) => /^\d+$/.test($(e).children().first().text().trim()));
  for (const row of rows.toArray()) {
    const cells = $(row).children('th,td'), no = cells.eq(0).text().trim().padStart(2, '0'), titleLines = lines(cells.eq(2).html() || ''), classLines = lines(cells.eq(3).html() || '');
    const previous = old.find(w => Number(w.no) === Number(no)), title = titleLines[0], detailLink = cells.eq(2).find('a').first().attr('href')!, detailUrl = key(detailLink);
    if (previous && norm(previous.title) !== norm(title)) throw new Error('Existing catalogue title changed');
    if (!previous && no !== '33') throw new Error('Unexpected new catalogue identity');
    const q = cheerio.load(buffers.get(detailUrl)!), body = q('#wikibody'); materializeAtWikiRegions(q); body.find(controls).remove();
    const fields: Record<string, { text: string; html: string }> = {}, known = new Set(['タイトル', '作品名', '作者', '作者名', 'ジャンル', '使用ツール', 'ツール', '配信', '配信/投稿', '配信・投稿', 'プレイ時間']);
    body.find('tr').each((_, e) => { const c = q(e).children('td,th'), label = c.first().text().trim().replace(/[:：]$/, ''); if (c.length === 2 && known.has(label)) fields[label] = { text: c.eq(1).text().trim(), html: c.eq(1).html() || '' }; });
    body.find('strong').each((_, e) => {
      const match = q(e).text().trim().match(/^(ジャンル|使用ツール|ツール|配信\/投稿|配信・投稿|配信)[:：]\s*([\s\S]*)$/); if (!match) return;
      let html = '', text = match[2];
      if (!text) for (let n = e.nextSibling; n && !(n.type === 'tag' && ['br', 'strong'].includes(n.name)); n = n.nextSibling) { html += q.html(n); text += q(n).text(); }
      if (text.trim()) fields[match[1]] = { text: text.trim(), html: html || q(e).html() || '' };
    });
    const work: WorkEntry = { id: previous?.id || `${id}-work-${no}`, festivalId: id, no: previous?.no || no, title: previous?.title || title, author: fields['作者']?.text || fields['作者名']?.text || titleLines.slice(1).join('\n'), source: { url: absolute(detailLink), titleUrl: base + 'pages/113.html' } };
    const originalTitle = fields['タイトル']?.text || fields['作品名']?.text; if (originalTitle && originalTitle !== work.title) work.originalTitle = originalTitle;
    const category = fields['ジャンル']?.text || classLines[0], engine = fields['使用ツール']?.text || fields['ツール']?.text || classLines.slice(1).join('\n');
    if (category) work.category = category; if (engine) work.engine = engine;
    const stream = fields['配信/投稿']?.text || fields['配信・投稿']?.text || fields['配信']?.text;
    const legacyStreamingConfirmed = !!previous?.streaming && body.text().includes(previous.streaming);
    if (stream) work.streaming = stream; else if (legacyStreamingConfirmed) work.streaming = previous!.streaming;
    const host = cells.eq(3).attr('title'); if (host) { const h = cheerio.load('<p></p>'); h('p').text(host); work.hostComment = h('p').toString(); }
    const iconUrl = absolute(cells.eq(1).find('img').attr('src')!); work.icon = (await media(iconUrl, 'icons', `${no}-source`)).local;
    const gallery = new Set<string>(), inlineImages = [];
    body.find('img[src]').each((_, e) => {
      const w = q(e).attr('width'), h = q(e).attr('height'), style = q(e).attr('style') || '', u = key(q(e).attr('src')!, detailUrl);
      const cell = q(e).closest('td'), rowCells = cell.closest('tr').children('td');
      const metadataSlot = no === '20' && w === '40' && h === '40' && rowCells.length === 2 && rowCells.first()[0] === cell[0] && !cell.text().trim();
      const icon = metadataSlot || (w === '32' && h === '32') || (/width:\s*32px/.test(style) && /height:\s*32px/.test(style));
      const illustration = (no === '18' && w === '38' && h === '32') || (no === '33' && w === '48' && h === '48');
      if (icon || illustration) inlineImages.push({ sourceUrl: u, role: icon ? 'source-metadata-icon' : 'inline-source-illustration', renderedWidth: w, renderedHeight: h, preservedInSourceCommentAndOriginalView: true }); else gallery.add(u);
    });
    const historicalScreenshot = no === '13' ? 'https://img.atwiki.jp/vipkohaku2021/attach/64/33/%EF%BC%B3%EF%BC%B3%EF%BC%92.png' : undefined;
    if (historicalScreenshot) {
      const legacy = cheerio.load(await fs.readFile(`${root}/64.html#id_e6a743a6`, 'utf8'));
      if (!legacy('#wikibody img[src]').toArray().some(e => key(legacy(e).attr('src')!, detailUrl) === historicalScreenshot)) throw new Error('Legacy screenshot not present in cached source page');
      gallery.add(historicalScreenshot);
    }
    const shots = []; for (const u of gallery) shots.push(await media(u, 'screenshots', `${no}-source-${shots.length + 1}`)); if (shots.length) work.ss = shots.map(s => s.local);
    const comment = body.clone(); comment.find(controls).remove();
    comment.find('tr').each((_, e) => { const c = q(e).children('td,th'), label = c.first().text().trim().replace(/[:：]$/, ''); if (c.length === 2 && known.has(label)) q(e).remove(); });
    comment.find('img[src]').each((_, e) => {
      const u = key(q(e).attr('src')!, detailUrl), inline = inlineImages.some(i => i.sourceUrl === u && i.renderedWidth === q(e).attr('width') && i.renderedHeight === q(e).attr('height'));
      if (gallery.has(u) && !inline) q(e).remove();
    });
    comment.find('h2').filter((_, e) => /^エントリー\s*N(?:o)?\s*\d+/i.test(q(e).text().trim())).remove();
    work.authorComment = sanitize(comment.html() || '', detailUrl);
    for (const image of inlineImages) image.preservedInSourceCommentAndOriginalView = work.authorComment.includes(`/original-pages/${id}/${resources[image.sourceUrl]}`);
    const forum = cells.eq(4).find('a').attr('href'); if (forum) work.forum = absolute(forum);
    const rawDl = cells.eq(5).find('a').first().attr('href'), dlUrl = rawDl ? key(rawDl) : undefined, supplements = [], links: WorkDownload[] = [], auxiliaryLinks: string[] = [];
    if (dlUrl && pages[dlUrl]) {
      const z = cheerio.load(buffers.get(dlUrl)!); materializeAtWikiRegions(z); const dlBody = z('#wikibody'); dlBody.find(controls).remove();
      const candidates = new Set(dlBody.find('a[href]').map((_, e) => absolute(z(e).attr('href')!, dlUrl)).get());
      for (const u of candidates) { const parsed = new URL(u), host = parsed.hostname; if (['ux.getuploader.com', 'dl.easyuploader.cloud', 'mega.nz', 'game.nicovideo.jp', 'drive.google.com', 'siasky.net', 'tokyohuskarl.itch.io'].includes(host) || /\.(zip|7z|rar|lzh|exe)$/i.test(parsed.pathname)) links.push({ url: u, label: '原配布ページのリンク' }); else if (host !== 'w.atwiki.jp' && host !== 'jbbs.shitaraba.net') auxiliaryLinks.push(u); }
      if (!links.length) links.push({ url: dlUrl, label: '原DLページ（ファイル未確認）' });
      supplements.push('<h4>【原DLページ】</h4>' + (dlBody.html() || ''));
    }
    if (links.length) { work.downloads = links; work.download = links[0]; }
    if (fields['プレイ時間']) supplements.unshift('<h4>【プレイ時間】</h4>' + fields['プレイ時間'].html);
    if (historicalScreenshot) supplements.unshift('<p>［保存庫補記］現在の紹介ページにない画像1点を、旧保存ページに表示されていた原CDN画像として保持しています。旧ページの取得日は未確認です。</p>');
    if (supplements.length) work.sourceContent = sanitize(supplements.join('\n'), dlUrl || detailUrl);
    works.push(work); entries.push({ id: work.id, no, detailUrl: absolute(detailLink), sourceFile: pages[detailUrl].file, newlyRestored: !previous, catalogueTitle: title, catalogueAuthor: titleLines.slice(1).join('\n'), catalogueClassification: classLines, sourceMetadata: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.text])), legacyStreamingConfirmed, iconSourceUrl: iconUrl, screenshotSources: shots, historicalScreenshotEvidence: historicalScreenshot ? { url: historicalScreenshot, cachedPage: '64.html#id_e6a743a6', captureDateUnknown: true, currentlyDisplayed: false } : undefined, inlineImageSources: inlineImages, hostCommentSource: host ? 'Official catalogue classification-cell title attribute' : undefined, dlPageUrl: dlUrl, downloadLinks: links, auxiliaryExternalLinks: auxiliaryLinks, packagesDownloaded: false });
  }
  if (works.length !== 39 || new Set(works.map(w => w.id)).size !== 39) throw new Error('Catalogue cardinality changed');
  const bannerSources = []; for (const name of ['21.png', '21b.png']) bannerSources.push(await media(landingBase + 'img/' + name, 'banners', `current-source-${bannerSources.length + 1}`));
  const festivals = await read<Festival[]>('src/data/festivals.json'); festivals.find(f => f.id === id)!.banners = bannerSources.map(b => b.local);
  await fs.mkdir(`${root}/source/replay`, { recursive: true }); await writeJson(`${root}/source/replay/manifest.json`, replay);
  await writeJson(`src/data/works/${id}.json`, works); await writeJson('src/data/festivals.json', festivals);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: landingBase, wikiBase: base, sourceEncodings: { landing: 'shift_jis', wiki: 'utf-8' }, liveSource: true, proxyRegion: 'Japan', sourceManifests: ['source/replay/manifest.json'], originalResources: resources, entries, bannerSources, handling: 'Direct archival without work-content or pixel screening. Preserve the official FC2 portal, its two banners and its navigation into the Wiki. Restore missing No.33, preserve existing IDs and all official catalogue identities, metadata and prose. Preserve inline illustrations in source comments and replay; gallery roles follow explicit source markup rather than natural-image dimensions. No six-image cap. Native nested details replace platform script-dependent regions. Distribution URLs and unconfirmed source DL pages remain distinct; no game packages downloaded.', desktopReview: 'pending' });
  console.log({ works: works.length, screenshots: works.reduce((s, w) => s + (w.ss?.length || 0), 0), downloadEntries: works.filter(w => w.download).length, inlineImages: entries.reduce((s, e) => s + e.inlineImageSources.length, 0), restoredNumbers: entries.filter(e => e.newlyRestored).map(e => e.no) });
}
main().catch(e => { console.error(e); process.exitCode = 1; });
