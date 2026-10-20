import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { imageExtension, writeJson } from './recover-entry-table';
import type { Festival, WorkEntry, WorkDownload } from '../src/lib/types';

const id = '2024-summer', root = `catch/${id}`, base = 'https://vipsummer2024.x.2nt.com/';
type Capture = { originalUrl: string; actualUrl: string; status: number; file: string; sha256: string; kind?: string };
type Row = { no: string; id: string; title: string; author: string; category: string; engine: string; streaming: string; detailUrl: string; iconUrl: string; previewUrl: string; forumUrl?: string; downloads: WorkDownload[]; downloadCellHtml: string };
type Detail = { no: string; detailUrl: string; screenshotUrls: string[] };
const read = async <T,>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, 'utf8'));
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const norm = (text: string) => text.normalize('NFKC').replace(/\s/g, '');
const canonical = (url: string) => { const value = new URL(url); value.hash = ''; return value.href; };
function native(bytes: Buffer) { if (/<svg[\s>]/i.test(bytes.subarray(0, 1000).toString())) return 'svg'; return imageExtension(bytes); }
async function main() {
  const rows = await read<Row[]>(`${root}/investigation/catalogue-rows.json`), details = await read<Detail[]>(`${root}/investigation/detail-structure.json`), old = await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`);
  const live = await read<Record<string, Capture>>(`${root}/source/live/manifest.json`), assets = await read<Record<string, Capture>>(`${root}/source/resources/manifest.json`), buffers = new Map<string, Buffer>(), resources: Record<string, string> = {}, destinations = new Map<string, string>();
  for (const [directory, manifest] of [['live', live], ['resources', assets]] as const) for (const cap of Object.values(manifest)) {
    const bytes = await fs.readFile(`${root}/source/${directory}/${cap.file}`);
    if (cap.status !== 200 || hash(bytes) !== cap.sha256) throw new Error('Unverified source response');
    buffers.set(canonical(cap.originalUrl), bytes);
    const url = new URL(cap.originalUrl); let local = url.pathname.slice(1);
    if (directory === 'resources' && !['css', 'js'].includes(cap.kind || '')) local = local.replace(/\.[^.\/]+$/, `.${native(bytes)}`);
    if (destinations.has(local) && destinations.get(local) !== hash(bytes)) throw new Error('Source path collision');
    destinations.set(local, hash(bytes)); resources[canonical(cap.originalUrl)] = local; resources[canonical(cap.actualUrl)] = local;
  }
  resources[base] = 'index.html';
  const sanitize = (html: string, owner: string) => {
    const $ = cheerio.load(`<div class="source-comment">${html}</div>`);
    $('script,noscript,iframe,form,style,link,meta,object,embed').remove(); $('blank').replaceWith('<br>');
    $('*').each((_, element) => { for (const attribute of Object.keys(element.attribs)) if (attribute.startsWith('on') || ['style','id','width','height','align','bgcolor','background','color','face','size'].includes(attribute)) $(element).removeAttr(attribute); });
    $('a[href]').each((_, element) => { const value = $(element).attr('href')!, url = new URL(value, owner); if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) $(element).removeAttr('href'); else $(element).attr('href', resources[canonical(url.href)] ? `/original-pages/${id}/${resources[canonical(url.href)]}${url.hash}` : url.href); });
    $('img[src]').each((_, element) => { const url = new URL($(element).attr('src')!, owner).href, local = resources[canonical(url)]; if (!local) throw new Error('Comment image missing'); $(element).attr('src', `/original-pages/${id}/${local}`); });
    return $('body>div').toString();
  };
  const save = async (url: string, folder: string, stem: string) => { const bytes = buffers.get(canonical(url)); if (!bytes) throw new Error('Image source missing'); const local = `/${folder}/${id}/${stem}.${native(bytes)}`; await fs.mkdir(path.dirname(`public${local}`), { recursive: true }); await fs.writeFile(`public${local}`, bytes); return { sourceUrl: url, local, sha256: hash(bytes) }; };
  const works: WorkEntry[] = [], entries = [];
  for (const row of rows) {
    const previous = old.find(work => work.id === row.id); if (!previous || norm(previous.title) !== norm(row.title)) throw new Error('Catalogue identity changed');
    const $ = cheerio.load(buffers.get(row.detailUrl)!), comments: Record<string, string> = {}; let section = '';
    $('table').first().find('tr').eq(2).children('td').contents().each((_, element) => {
      if (element.type === 'tag' && element.tagName === 'h2') { section = $(element).text().trim(); comments[section] = ''; return; }
      if (section) comments[section] += $.html(element);
    });
    if (!('作者のコメント' in comments) || !('主催のコメント' in comments)) throw new Error('Comment structure changed');
    const work: WorkEntry = { id: previous.id, festivalId: id, no: row.no, title: previous.title, author: row.author, category: row.category, engine: row.engine, streaming: row.streaming, source: { url: row.detailUrl, titleUrl: `${base}entries.html` } };
    const script = $('script:not([src])').first().html() || '', quotedTitle = script.match(/var\s+pageName\s*=\s*("(?:\\.|[^"\\])*")/)?.[1], detailTitle = quotedTitle ? JSON.parse(quotedTitle) as string : undefined;
    if (detailTitle && norm(detailTitle) !== norm(work.title)) work.originalTitle = detailTitle;
    work.authorComment = sanitize(comments['作者のコメント'], row.detailUrl); work.hostComment = sanitize(comments['主催のコメント'], row.detailUrl);
    if (row.forumUrl && new URL(row.forumUrl).hostname !== 'example.com') work.forum = row.forumUrl;
    const downloads = row.downloads.filter(download => new URL(download.url).hostname !== 'example.com');
    if (downloads.length) { work.downloads = downloads; work.download = downloads[0]; }
    if (!downloads.length || row.downloads.length !== downloads.length) work.sourceContent = sanitize(row.downloadCellHtml, `${base}entries.html`);
    work.icon = (await save(row.iconUrl, 'icons', `${row.no}-source`)).local;
    const detail = details.find(detail => detail.no === row.no); if (!detail || !detail.screenshotUrls.length) throw new Error('Missing displayed screenshot role');
    const screenshotSources = []; for (const url of detail.screenshotUrls) screenshotSources.push(await save(url, 'screenshots', `${row.no}-source-${screenshotSources.length + 1}`));
    work.ss = screenshotSources.map(source => source.local);
    works.push(work); entries.push({ id: work.id, no: row.no, detailUrl: row.detailUrl, sourceCapture: live[row.detailUrl], previewSourceUrl: row.previewUrl, iconSourceUrl: row.iconUrl, screenshotSources, sourceTitleMatchesCatalogue: !work.originalTitle, detailTitleRecorded: !!work.originalTitle, authorCommentPresent: !!work.authorComment, hostCommentPresent: !!work.hostComment, sourceDownloadLinks: row.downloads, normalizedDownloadLinks: downloads, sourceExampleLinksRetainedOnlyAsSource: row.downloads.filter(download => new URL(download.url).hostname === 'example.com'), packageBytesDownloaded: false });
  }
  if (works.length !== 46 || new Set(works.map(work => work.id)).size !== 46) throw new Error('Incomplete catalogue');
  const banners = [], bannerSources = []; for (const no of [1,2,3]) { const url = `${base}img/bunner${no}.png`, bytes = buffers.get(url); if (!bytes) throw new Error('Banner missing'); const local = `/banners/${id}-source-${no}.${native(bytes)}`; await fs.writeFile(`public${local}`, bytes); banners.push(local); bannerSources.push({ sourceUrl: url, local, sha256: hash(bytes) }); }
  const festivals = await read<Festival[]>('src/data/festivals.json'); festivals.find(festival => festival.id === id)!.banners = banners;
  await writeJson(`src/data/works/${id}.json`, works); await writeJson('src/data/festivals.json', festivals);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, liveSource: true, proxyRegion: 'Japan', sourceManifests: ['source/live/manifest.json', 'source/resources/manifest.json'], originalResources: resources, entries, bannerSources, handling: 'Direct source archival without content review, keyword/image screening, screenshot size filters or six-image limits. Preserve actual displayed and hover screenshots separately from catalogue thumbnails. Comment extraction includes direct text nodes between h2 headings. Original source-supplied dummy media and sample example.com links remain documented without inventing real package links. No game packages downloaded.', desktopReview: 'pending' });
  console.log(JSON.stringify({ works: works.length, screenshots: works.reduce((sum,work)=>sum+(work.ss?.length||0),0), downloadEntries: works.filter(work=>work.download).length, downloadLinks: works.reduce((sum,work)=>sum+(work.downloads?.length||0),0), titleDifferences: works.filter(work=>work.originalTitle).map(work=>work.no) }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
