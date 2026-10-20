import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { imageExtension, writeJson } from './recover-entry-table';
import type { Festival, WorkEntry } from '../src/lib/types';

const id = '2024-kouhaku', root = `catch/${id}`, base = 'https://vipkouhaku2024.x.2nt.com/';
type Capture = { originalUrl: string; actualUrl: string; file: string; status: number; sha256: string; kind?: string; no?: string };
type Row = { no: string; id: string; title: string; author: string; genre: string; engine: string; liveStreaming: string; videoPosting: string; note: string; detailUrl: string; forumUrl?: string; downloadUrl?: string; downloadLabel?: string; iconUrl: string; screenshotUrl: string };
const read = async <T,>(p: string): Promise<T> => JSON.parse(await fs.readFile(p, 'utf8'));
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const canonical = (u: string) => { const url = new URL(u); url.hash = ''; return url.href.replace(/\?$/, ''); };
const norm = (s: string) => s.normalize('NFKC').replace(/\s/g, '');
function native(b: Buffer) {
  const text = b.subarray(0, 4).toString(), hex = b.subarray(0, 4).toString('hex');
  if (text === 'wOF2') return 'woff2'; if (text === 'wOFF') return 'woff'; if (hex === '00010000') return 'ttf'; if (text === 'OTTO') return 'otf';
  if (b.length > 36 && b.readUInt32LE(0) === b.length && b.subarray(34, 36).toString('hex') === '4c50') return 'eot';
  if (hex === '00000200') return 'cur'; if (/<svg[\s>]/i.test(b.subarray(0, 1000).toString())) return 'svg';
  return imageExtension(b);
}
async function main() {
  const live = await read<Record<string, Capture>>(`${root}/source/live/manifest.json`), assets = await read<Record<string, Capture>>(`${root}/source/resources/manifest.json`);
  const rows = await read<Row[]>(`${root}/investigation/catalogue-rows.json`), old = await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`);
  const badIcon = `${base}entry/icons/icon08.jpg`, correctIcon = rows.find(r => r.no === '08')!.iconUrl;
  const unavailableBanner = `${base}assets/images/banner_viprpg_kouhaku_2009.png`;
  const unavailableScript = `${base}entry/main.js`;
  await writeJson(`${root}/source/resources/replay-manifest.json`, Object.fromEntries(Object.entries(assets).filter(([, cap]) => ![badIcon, unavailableBanner, unavailableScript].includes(cap.originalUrl))));
  const buffers = new Map<string, Buffer>(), resources: Record<string, string> = {};
  for (const [directory, manifest] of [['live', live], ['resources', assets]] as const) for (const cap of Object.values(manifest)) {
    const bytes = await fs.readFile(`${root}/source/${directory}/${cap.file}`);
    if (cap.status !== 200 || hash(bytes) !== cap.sha256) throw new Error('Unverified source capture');
    if (directory === 'resources' && [badIcon, unavailableBanner, unavailableScript].includes(cap.originalUrl)) continue;
    buffers.set(canonical(cap.originalUrl), bytes);
    let local: string;
    if (directory === 'live') local = new URL(cap.originalUrl).pathname.slice(1);
    else {
      const ext = cap.kind === 'css' ? 'css' : cap.kind === 'js' ? 'js' : native(bytes);
      const font = /^(woff2?|ttf|otf|eot)$/.test(ext) || (ext === 'svg' && /<font[\s>]/.test(bytes.toString()));
      local = `${font ? 'fonts' : ext === 'css' ? 'css' : ext === 'js' ? 'js' : 'assets'}/${createHash('sha256').update(cap.originalUrl).digest('hex').slice(0, 24)}.${ext}`;
    }
    resources[canonical(cap.originalUrl)] = local; resources[canonical(cap.actualUrl)] = local;
  }
  resources[base] = 'index.html';
  resources[badIcon] = resources[correctIcon];
  const alias = (raw: string, owner: string) => { try { const u = new URL(raw, owner); if (resources[canonical(u.href)]) resources[u.href] = resources[canonical(u.href)]; } catch { /* Non-URL data. */ } };
  for (const cap of Object.values(live)) {
    const $ = cheerio.load(buffers.get(canonical(cap.originalUrl))!.toString());
    $('[src],[href]').each((_, el) => { for (const attr of ['src', 'href']) { const value = $(el).attr(attr); if (value) alias(value, cap.originalUrl); } });
  }
  for (const cap of Object.values(assets).filter(c => c.kind === 'css')) for (const match of buffers.get(canonical(cap.originalUrl))!.toString().matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) alias(match[1], cap.originalUrl);
  const sanitize = (html: string, owner: string) => {
    const $ = cheerio.load(`<div>${html}</div>`); $('script,style,noscript,iframe,form,object,embed,link,meta').remove();
    $('*').each((_, el) => { for (const a of Object.keys(el.attribs)) if (a.startsWith('on') || ['style','width','height','align','bgcolor','background','color','face','size'].includes(a)) $(el).removeAttr(a); });
    $('img[src]').each((_, el) => { const url = new URL($(el).attr('src')!, owner).href, local = resources[canonical(url)]; if (!local) throw new Error('Comment image unavailable'); $(el).attr('src', `/original-pages/${id}/${local}`); });
    $('a[href]').each((_, el) => { const raw = $(el).attr('href')!; if (raw.startsWith('#')) return; const u = new URL(raw, owner); if (!['http:','https:','mailto:'].includes(u.protocol)) $(el).removeAttr('href'); else $(el).attr('href', resources[canonical(u.href)] ? `/original-pages/${id}/${resources[canonical(u.href)]}${u.hash}` : u.href); });
    return $('body>div').html()?.trim() || '';
  };
  const save = async (url: string, folder: string, stem: string) => { const bytes = buffers.get(canonical(url)); if (!bytes) throw new Error('Image cache missing'); const local = `/${folder}/${id}/${stem}.${native(bytes)}`; await fs.mkdir(path.dirname(`public${local}`), { recursive: true }); await fs.writeFile(`public${local}`, bytes); return { sourceUrl: url, local, sha256: hash(bytes) }; };
  const works: WorkEntry[] = [], entries = [];
  for (const row of rows) {
    const previous = old.find(w => w.id === row.id); if (!previous || norm(previous.title) !== norm(row.title)) throw new Error('Catalogue identity or title changed');
    const $ = cheerio.load(buffers.get(canonical(row.detailUrl))!.toString()), trs = $('table.entrypage tr').toArray(), fields: Record<string, string> = {}, fieldText: Record<string, string> = {};
    for (let i = 0; i + 1 < trs.length; i++) { const label = $(trs[i]).text().replace(/\s/g, ''); if (!['ジャンル','コメント','主催コメント'].includes(label)) continue; const cell = $(trs[i + 1]).find('td').first(); fields[label] = cell.html() || ''; fieldText[label] = cell.text().trim(); i++; }
    const work: WorkEntry = { id: previous.id, festivalId: id, no: row.no, title: previous.title, author: row.author, category: fieldText['ジャンル'] || row.genre, engine: row.engine, streaming: `配信: ${row.liveStreaming} / 動画: ${row.videoPosting}`, source: { url: row.detailUrl, titleUrl: `${base}index.html` } };
    if (row.forumUrl) work.forum = row.forumUrl;
    if (fields['コメント'] && fieldText['コメント']) work.authorComment = sanitize(fields['コメント'], row.detailUrl);
    if (fields['主催コメント'] && fieldText['主催コメント']) work.hostComment = sanitize(fields['主催コメント'], row.detailUrl);
    if (row.note) { const note = cheerio.load('<p><strong>備考</strong><br></p>'); note('p').append(note('<span>').text(row.note)); work.sourceContent = note('p').toString(); }
    work.icon = (await save(row.iconUrl, 'icons', `${row.no}-source`)).local;
    const sources = $(trs[0]).find('img[src]').toArray().map(el => new URL($(el).attr('src')!, row.detailUrl).href);
    const screenshotSources = []; for (const url of [...new Set(sources.length ? sources : [row.screenshotUrl])]) screenshotSources.push(await save(url, 'screenshots', `${row.no}-source-${screenshotSources.length + 1}`));
    if (screenshotSources.length) work.ss = screenshotSources.map(s => s.local);
    if (row.downloadUrl && /^https?:/.test(row.downloadUrl)) { work.download = { url: row.downloadUrl, label: row.downloadLabel || 'Source download' }; work.downloads = [work.download]; }
    works.push(work); entries.push({ no: row.no, id: work.id, detailUrl: row.detailUrl, sourceCapture: live[row.detailUrl], catalogueGenre: row.genre, detailedGenre: fieldText['ジャンル'], fieldsFound: Object.keys(fields), authorCommentPresent: !!work.authorComment, hostCommentPresent: !!work.hostComment, screenshotSources, previewSourceUrl: row.screenshotUrl, packageBytesDownloaded: false });
  }
  if (works.length !== 47) throw new Error('Incomplete catalogue');
  const bannerUrl = `${base}assets/images/main-visual_viprpg_kouhaku_2024.png`, banner = buffers.get(canonical(bannerUrl)); if (!banner) throw new Error('Banner source missing');
  const bannerPath = `/banners/${id}-source.${native(banner)}`; await fs.writeFile(`public${bannerPath}`, banner);
  const festivals = await read<Festival[]>('src/data/festivals.json'); festivals.find(f => f.id === id)!.banners = [bannerPath];
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, liveSource: true, proxyRegion: 'Japan', entries, originalResources: resources, sourceManifests: ['source/live/manifest.json', 'source/resources/replay-manifest.json'], unavailableSourceImages: [{ url: unavailableBanner, page: 'info.html', label: 'VIPRPG紅白2009バナー', reason: 'Current response is an HTML error page despite HTTP 200; the exact CDX query returned no captures. Retain the source festival link with an explicit missing-image label.' }], sourceImageAliases: [{ originalUrl: badIcon, replacementSourceUrl: correctIcon, reason: 'Detail-page icon uses .jpg; the same entry in the current official catalogue supplies the valid .png icon.' }], handling: 'Direct source archival without content screening. Source author and organizer comments remain separate. No six-image/size/content filter; catalogue previews and detail media retain their own source evidence. Download fields are public source links; packages were not downloaded.', desktopReview: 'pending' });
  await writeJson(`src/data/works/${id}.json`, works); await writeJson('src/data/festivals.json', festivals);
  console.log(JSON.stringify({ works: works.length, screenshots: works.reduce((s,w)=>s+(w.ss?.length||0),0), authorComments:works.filter(w=>w.authorComment).length, organizerComments:works.filter(w=>w.hostComment).length, downloadEntries:works.filter(w=>w.download).length }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
