import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { imageExtension, writeJson } from './recover-entry-table';
import type { Festival, WorkEntry, WorkDownload } from '../src/lib/types';

const id = '2023-kouhaku', root = `catch/${id}`, base = 'https://viprpg23k.web.fc2.com/';
type BackupFile = { relativePath: string; zipMember: string; size: number; crc32: number; sha256: string };
type Dependency = { originalUrl: string; actualUrl: string; status: number; file: string; sha256: string; kind: string };
type Row = { no: string; id: string; title: string; author: string; category?: string; engine?: string; streaming: string; iconUrl?: string; screenshotUrls: string[]; downloads: WorkDownload[]; unavailableDownloadButtons: Array<{ rawHref?: string; label: string }>; forumUrl?: string; detailUrl: string };
const read = async <T,>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, 'utf8'));
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const norm = (value: string) => value.normalize('NFKC').replace(/\s/g, '');
function native(bytes: Buffer) {
  const magic = bytes.subarray(0, 4).toString();
  if (magic === 'wOF2') return 'woff2'; if (magic === 'wOFF') return 'woff';
  if (bytes.subarray(0, 4).toString('hex') === '00010000') return 'ttf';
  if (/<svg[\s>]/i.test(bytes.subarray(0, 1000).toString())) return 'svg';
  return imageExtension(bytes);
}
async function main() {
  const backup = await read<{ publicPage: string; files: BackupFile[] }>(`${root}/source/website-backup/manifest.json`), dependencies = await read<Record<string, Dependency>>(`${root}/source/dependencies/manifest.json`);
  const archive = await read<{ status: number; sha256: string; file: string; decodedFile: string; rawDigestMatches: boolean; requestedUrl: string }>(`${root}/source/archive/manifest.json`);
  const rows = await read<Row[]>(`${root}/investigation/catalogue-rows.json`), old = await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`), buffers = new Map<string, Buffer>(), resources: Record<string, string> = {}, replay: Record<string, unknown> = {};
  for (const file of backup.files) {
    const bytes = await fs.readFile(`${root}/source/website-backup/files/${file.relativePath}`);
    if (bytes.length !== file.size || hash(bytes) !== file.sha256) throw new Error('Backup payload verification failed');
    if (['index.html', 'index[1].html'].includes(file.relativePath)) continue;
    const url = new URL(file.relativePath, base).href, extension = path.posix.extname(file.relativePath).slice(1).toLowerCase();
    const local = /^(png|jpe?g|gif|bmp|webp|avif|ico|svg)$/.test(extension) ? file.relativePath.replace(/\.[^.]+$/, `.${native(bytes)}`) : file.relativePath;
    buffers.set(url, bytes); resources[url] = local;
    replay[url] = { originalUrl: url, file: `../website-backup/files/${file.relativePath}`, sha256: file.sha256, sourceKind: 'public-website-backup', zipMember: file.zipMember, crc32: file.crc32 };
  }
  const raw = await fs.readFile(`${root}/source/archive/${archive.file}`), indexBytes = await fs.readFile(`${root}/source/archive/${archive.decodedFile}`);
  if (archive.status !== 200 || hash(raw) !== archive.sha256 || !archive.rawDigestMatches) throw new Error('Official archived index is not verified');
  buffers.set(base, indexBytes); resources[base] = 'index.html'; resources[`${base}index.html`] = 'index.html';
  replay[base] = { originalUrl: base, file: `../archive/${archive.decodedFile}`, sha256: hash(indexBytes), sourceKind: 'official-archived-index', requestedUrl: archive.requestedUrl };
  for (const capture of Object.values(dependencies)) {
    const bytes = await fs.readFile(`${root}/source/dependencies/${capture.file}`);
    if (capture.status !== 200 || hash(bytes) !== capture.sha256) throw new Error('External dependency is unverified');
    const extension = capture.kind === 'css' ? 'css' : capture.kind === 'js' ? 'js' : native(bytes), folder = ['woff2','woff','ttf'].includes(extension) ? 'fonts' : capture.kind === 'css' ? 'css' : capture.kind === 'js' ? 'js' : 'assets';
    const local = `${folder}/${createHash('sha256').update(capture.originalUrl).digest('hex').slice(0, 24)}.${extension}`;
    resources[capture.originalUrl] = local; resources[capture.actualUrl] = local; buffers.set(capture.originalUrl, bytes);
    replay[capture.originalUrl] = { ...capture, file: `../dependencies/${capture.file}`, sourceKind: 'live-dependency' };
  }
  const sanitize = (html: string, owner: string) => {
    const $ = cheerio.load(`<div class="source-comment">${html}</div>`); $('script,noscript,iframe,form,style,link,meta,object,embed').remove();
    $('*').each((_, element) => { for (const attr of Object.keys(element.attribs)) if (attr.startsWith('on') || ['style','id','width','height','align','bgcolor','background','color','face','size'].includes(attr)) $(element).removeAttr(attr); });
    $('img[src]').each((_, element) => { const url = new URL($(element).attr('src')!, owner).href, local = resources[url]; if (!local) throw new Error('Comment media absent from backup'); $(element).attr('src', `/original-pages/${id}/${local}`); });
    $('a[href]').each((_, element) => { const url = new URL($(element).attr('href')!, owner), key = new URL(url); key.hash = ''; if (!['http:','https:','mailto:'].includes(url.protocol)) $(element).removeAttr('href'); else $(element).attr('href', resources[key.href] ? `/original-pages/${id}/${resources[key.href]}${url.hash}` : url.href); });
    return $('body>div').toString();
  };
  const save = async (url: string, folder: string, stem: string) => { const bytes = buffers.get(url); if (!bytes) throw new Error('Source image missing'); const local = `/${folder}/${id}/${stem}.${native(bytes)}`; await fs.mkdir(path.dirname(`public${local}`), { recursive: true }); await fs.writeFile(`public${local}`, bytes); return { sourceUrl: url, local, sha256: hash(bytes) }; };
  const works: WorkEntry[] = [], entries = [];
  for (const row of rows) {
    const previous = old.find(work => work.id === row.id); if (!previous || norm(previous.title) !== norm(row.title)) throw new Error('Existing identity or title changed');
    const $ = cheerio.load(buffers.get(row.detailUrl)!), work: WorkEntry = { id: previous.id, festivalId: id, no: row.no, title: previous.title, author: row.author, ...(row.category ? { category: row.category } : {}), ...(row.engine ? { engine: row.engine } : {}), ...(row.streaming ? { streaming: row.streaming } : {}), source: { url: row.detailUrl, titleUrl: base } };
    const detail = $('div.detail').first(); if (detail.length) work.authorComment = sanitize(detail.html() || '', row.detailUrl);
    const header = $('h4').filter((_, element) => $(element).text().includes('管理人')).first();
    if (header.length) { let html = '', node = header[0].nextSibling; while (node) { if (node.type === 'tag' && (node.tagName === 'h4' || node.tagName === 'hr' || $(node).hasClass('e_btn'))) break; html += $.html(node); node = node.nextSibling; } if (cheerio.load(html).text().trim()) work.hostComment = sanitize(html, row.detailUrl); }
    if (row.iconUrl) work.icon = (await save(row.iconUrl, 'icons', `${row.no}-source`)).local;
    const screenshotSources = []; for (const url of [...new Set(row.screenshotUrls)]) screenshotSources.push(await save(url, 'screenshots', `${row.no}-source-${screenshotSources.length + 1}`));
    if (screenshotSources.length) work.ss = screenshotSources.map(source => source.local);
    if (row.downloads.length) { work.downloads = row.downloads; work.download = row.downloads[0]; }
    if (row.forumUrl) work.forum = row.forumUrl;
    if (row.unavailableDownloadButtons.length) { const q = cheerio.load('<div></div>'); for (const label of [...new Set(row.unavailableDownloadButtons.map(button => button.label))]) q('div').append(q('<p>').text(label)); work.sourceContent = sanitize(q('div').html() || '', row.detailUrl); }
    works.push(work); entries.push({ id: work.id, no: row.no, detailUrl: row.detailUrl, sourceFile: `source/website-backup/files/entry/${row.no}.html`, screenshotSources, iconSourceUrl: row.iconUrl, downloadLinks: row.downloads, unavailableDownloadButtons: row.unavailableDownloadButtons, authorCommentPresent: !!work.authorComment, hostCommentPresent: !!work.hostComment, packagesDownloaded: false });
  }
  if (works.length !== 44 || new Set(works.map(work => work.id)).size !== 44) throw new Error('Catalogue completeness changed');
  const banners = [], bannerSources = []; for (const stem of ['banner23_01','banner23_02','banner23_03','banner23_ryuken']) { const url = `${base}img/${stem}.png`, bytes = buffers.get(url); if (!bytes) throw new Error('Published banner missing'); const local = `/banners/${id}-source-${banners.length + 1}.${native(bytes)}`; await fs.writeFile(`public${local}`, bytes); banners.push(local); bannerSources.push({ sourceUrl: url, local, sha256: hash(bytes) }); }
  const festivals = await read<Festival[]>('src/data/festivals.json'); festivals.find(festival => festival.id === id)!.banners = banners;
  await fs.mkdir(`${root}/source/replay`, { recursive: true }); await writeJson(`${root}/source/replay/manifest.json`, replay);
  await writeJson(`src/data/works/${id}.json`, works); await writeJson('src/data/festivals.json', festivals);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, sourceMode: 'verified-public-website-backup-with-later-official-archived-index', publicBackupPage: backup.publicPage, officialIndexSnapshot: archive.requestedUrl, sourceManifests: ['source/replay/manifest.json'], originalResources: resources, entries, bannerSources, sourceGaps: [{ sourceUrl: `${base}entry/img/SS09_1.gif`, role: 'ranking-thumbnail-variant', backupMemberPresent: false, archiveInventory: 'investigation/missing-resources-cdx.json', display: 'Captured same-number PNG with an explicit archive note; no GIF fabricated.' }, { sourceUrl: `${base}entry/csv/21.csv`, role: 'ranking-csv', backupMemberPresent: false, archiveInventory: 'investigation/missing-resources-cdx.json', display: 'Inactive source CSV caption with a missing-source notice; no ranking data fabricated.' }], handling: 'Direct archival without content or keyword/image screening. Verified CRC/SHA-256 website-backup members retain original byte payloads; the later official archived index provides catalogue download labels and project links. Preserve complete carousel images without a six-image or size filter. Retain unavailable source download labels instead of turning empty/directory URLs into game downloads. Archive ranking CSVs and all source dependencies; no game packages downloaded.', desktopReview: 'pending' });
  console.log(JSON.stringify({ works: works.length, screenshots: works.reduce((sum,work)=>sum+(work.ss?.length||0),0), icons: works.filter(work=>work.icon).length, downloadEntries: works.filter(work=>work.download).length, downloadLinks: works.reduce((sum,work)=>sum+(work.downloads?.length||0),0), banners: banners.length, replayResources: Object.keys(replay).length }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
