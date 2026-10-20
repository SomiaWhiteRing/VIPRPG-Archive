import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { imageExtension, writeJson } from './recover-entry-table';
import type { Festival, WorkEntry, WorkDownload } from '../src/lib/types';

const id = '2023-gw', root = `catch/${id}`, base = 'https://viprpg2023gw.neocities.org/';
type Capture = { originalUrl: string; actualUrl: string; status: number; file: string; sha256: string; kind?: string };
type Row = { id: string; no: string; title: string; author: string; engine: string; category: string; streaming: string; detailUrl: string; iconUrl: string; previewUrl: string; downloads: WorkDownload[]; forumUrl?: string };
type Detail = { no: string; screenshotUrls: string[] };
const read = async <T,>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, 'utf8'));
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const norm = (value: string) => value.normalize('NFKC').replace(/\s/g, '');
function native(bytes: Buffer) { if (/<svg[\s>]/i.test(bytes.subarray(0, 1000).toString())) return 'svg'; return imageExtension(bytes); }
async function main() {
  const rows = await read<Row[]>(`${root}/investigation/catalogue-rows.json`), details = await read<Detail[]>(`${root}/investigation/detail-structure.json`), old = await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`);
  const live = await read<Record<string, Capture>>(`${root}/source/live/manifest.json`), assets = await read<Record<string, Capture>>(`${root}/source/resources/manifest.json`), buffers = new Map<string, Buffer>(), resources: Record<string, string> = {}, destinations = new Map<string, string>();
  for (const [directory, manifest] of [['live', live], ['resources', assets]] as const) for (const cap of Object.values(manifest)) {
    const bytes = await fs.readFile(`${root}/source/${directory}/${cap.file}`);
    if (cap.status !== 200 || hash(bytes) !== cap.sha256) throw new Error('Source capture verification failed');
    buffers.set(cap.originalUrl, bytes);
    let local = new URL(cap.originalUrl).pathname.slice(1) || 'index.html';
    if (directory === 'resources' && cap.kind === 'asset') local = local.replace(/\.[^.\/]+$/, `.${native(bytes)}`);
    if (destinations.has(local) && destinations.get(local) !== hash(bytes)) throw new Error('Source resource collision');
    destinations.set(local, hash(bytes)); resources[cap.originalUrl] = local; resources[cap.actualUrl] = local;
  }
  const sanitize = (html: string, owner: string) => {
    const $ = cheerio.load(`<div class="source-comment">${html}</div>`);
    $('script,noscript,iframe,form,style,link,meta,object,embed').remove();
    $('*').each((_, element) => { for (const attr of Object.keys(element.attribs)) if (attr.startsWith('on') || ['style','id','width','height','align','bgcolor','background','color','face','size'].includes(attr)) $(element).removeAttr(attr); });
    $('a[href]').each((_, element) => { const url = new URL($(element).attr('href')!, owner); const key = new URL(url); key.hash = ''; if (!['http:','https:','mailto:'].includes(url.protocol)) $(element).removeAttr('href'); else $(element).attr('href', resources[key.href] ? `/original-pages/${id}/${resources[key.href]}${url.hash}` : url.href); });
    $('img[src]').each((_, element) => { const url = new URL($(element).attr('src')!, owner).href; if (url.startsWith('data:')) return; const local = resources[url]; if (!local) throw new Error('Comment media missing'); $(element).attr('src', `/original-pages/${id}/${local}`); });
    return $('body>div').toString();
  };
  const save = async (url: string, folder: string, stem: string) => { const bytes = buffers.get(url); if (!bytes) throw new Error('Image capture missing'); const local = `/${folder}/${id}/${stem}.${native(bytes)}`; await fs.mkdir(path.dirname(`public${local}`), { recursive: true }); await fs.writeFile(`public${local}`, bytes); return { sourceUrl: url, local, sha256: hash(bytes) }; };
  const works: WorkEntry[] = [], entries = [];
  for (const row of rows) {
    const previous = old.find(work => work.id === row.id); if (!previous || norm(previous.title) !== norm(row.title)) throw new Error('Existing title or identity changed');
    const $ = cheerio.load(buffers.get(row.detailUrl)!), fields: Record<string, string> = {}, metadata: Record<string, string> = {};
    $('#entry td').each((_, element) => {
      const cell = $(element), label = cell.text().trim().match(/^(作者|ジャンル|ツール|配信\/投稿|作者コメント|管理人コメント)：/)?.[1]; if (!label) return;
      const clone = cell.clone(), first = clone.contents().first()[0]; if (!first || first.type !== 'text' || !first.data.trim().startsWith(`${label}：`)) throw new Error('Source field label structure changed');
      first.data = first.data.replace(new RegExp(`^\\s*${label}：\\s*`), '');
      if (!first.data.trim()) clone.contents().first().remove();
      if (clone.contents().first().is('br')) clone.contents().first().remove();
      fields[label] = clone.html() || ''; metadata[label] = clone.text().trim();
    });
    if (!('作者コメント' in fields) || !('管理人コメント' in fields)) throw new Error('Missing source comment fields');
    const work: WorkEntry = { id: previous.id, festivalId: id, no: row.no, title: previous.title, author: row.author, category: row.category, engine: row.engine, streaming: row.streaming, source: { url: row.detailUrl, titleUrl: base, ...(!row.author && !metadata['作者'] ? { authorOmitted: true } : {}) }, authorComment: sanitize(fields['作者コメント'], row.detailUrl), hostComment: sanitize(fields['管理人コメント'], row.detailUrl) };
    const metadataDifferences = [], supplements: string[] = [];
    for (const [label, catalogueValue] of [['作者', row.author], ['ジャンル', row.category], ['ツール', row.engine], ['配信/投稿', row.streaming]]) {
      if (norm(catalogueValue || '') === norm(metadata[label] || '')) continue;
      metadataDifferences.push({ label, catalogueValue, detailValue: metadata[label] });
      supplements.push(`<p><strong>${label}（詳細ページ）</strong><br>${fields[label] || ''}</p>`);
    }
    if (supplements.length) work.sourceContent = sanitize(supplements.join('\n'), row.detailUrl);
    if (row.forumUrl) work.forum = row.forumUrl;
    if (row.downloads.length) { work.downloads = row.downloads; work.download = row.downloads[0]; }
    work.icon = (await save(row.iconUrl, 'icons', `${row.no}-source`)).local;
    const detail = details.find(detail => detail.no === row.no); if (!detail?.screenshotUrls.length) throw new Error('Source screenshot role missing');
    const screenshotSources = []; for (const url of detail.screenshotUrls) screenshotSources.push(await save(url, 'screenshots', `${row.no}-source-${screenshotSources.length + 1}`));
    work.ss = screenshotSources.map(source => source.local);
    works.push(work); entries.push({ id: work.id, no: row.no, detailUrl: row.detailUrl, sourceCapture: live[row.detailUrl], iconSourceUrl: row.iconUrl, previewSourceUrl: row.previewUrl, screenshotSources, sourceMetadata: metadata, catalogueMetadata: { author: row.author, category: row.category, engine: row.engine, streaming: row.streaming }, metadataDifferences, authorOmittedInBothSources: !!work.source?.authorOmitted, packageBytesDownloaded: false });
  }
  if (works.length !== 37 || new Set(works.map(work => work.id)).size !== 37) throw new Error('Catalogue completeness changed');
  const index = cheerio.load(buffers.get(base)!), bannerSources = [], banners: string[] = [];
  for (const [ordinal, element] of index('body>p>img[src^="data:image/"]').toArray().entries()) {
    const source = index(element).attr('src')!, encoded = source.match(/^data:image\/([^;,]+);base64,([\s\S]+)$/); if (!encoded) throw new Error('Unknown embedded banner format');
    const bytes = Buffer.from(encoded[2], 'base64'), local = `/banners/${id}-source-${ordinal + 1}.${native(bytes)}`;
    await fs.writeFile(`public${local}`, bytes); banners.push(local); bannerSources.push({ sourceHtml: 'source/live/index.bin', selector: 'body>p>img[src^="data:image/"]', ordinal, mime: encoded[1], local, sha256: hash(bytes) });
  }
  if (banners.length !== 2) throw new Error('Current festival banner structure changed');
  const festivals = await read<Festival[]>('src/data/festivals.json'); festivals.find(festival => festival.id === id)!.banners = banners;
  await writeJson(`src/data/works/${id}.json`, works); await writeJson('src/data/festivals.json', festivals);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, liveSource: true, proxyRegion: 'Japan', sourceManifests: ['source/live/manifest.json', 'source/resources/manifest.json'], originalResources: resources, entries, bannerSources, handling: 'Direct source archival without content screening or image-pixel inspection. Preserve all displayed and hover screenshot URLs, including JPEG hover images omitted by the historical PNG-only extraction. Separate catalogue previews, source-provided engine icons and sample media from assumptions about missing content. Preserve HTML comments and original quote markers. Top-level embedded festival banners are distinct from embedded past-festival banners. No game packages downloaded.', desktopReview: 'pending' });
  console.log(JSON.stringify({ works: works.length, screenshots: works.reduce((sum,work)=>sum+(work.ss?.length||0),0), downloadEntries: works.filter(work=>work.download).length, authorOmitted: works.filter(work=>work.source?.authorOmitted).map(work=>work.no), banners: banners.length }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
