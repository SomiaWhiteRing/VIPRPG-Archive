import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { imageExtension, writeJson } from './recover-entry-table';
import type { Festival, WorkEntry, WorkDownload } from '../src/lib/types';

const id = '2023-summer', root = `catch/${id}`, base = 'https://w.atwiki.jp/viprpg23s/', cdn = 'https://img.atwiki.jp/viprpg23s/';
type Member = { relativePath: string; zipMember: string; size: number; sha256: string; crc32: number };
type Capture = { originalUrl: string; actualUrl: string; status: number; file: string; sha256: string; kind: string };
const read = async <T,>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, 'utf8'));
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const norm = (s: string) => s.normalize('NFKC').replace(/\s/g, '');
const absolute = (s: string, owner = base) => new URL(s, owner).href;
const native = (bytes: Buffer) => /<svg[\s>]/i.test(bytes.subarray(0, 1000).toString()) ? 'svg' : imageExtension(bytes);

async function main() {
  const backup = await read<{ publicPage: string; files: Member[] }>(`${root}/source/website-backup/manifest.json`), deps = await read<Record<string, Capture>>(`${root}/source/dependencies/manifest.json`);
  const old = await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`), buffers = new Map<string, Buffer>(), resources: Record<string, string> = {}, replay: Record<string, unknown> = {};
  const archivedIndex = await read<{ requestedUrl: string; rawDigestMatches: boolean }>(`${root}/source/archive/manifest.json`), archivedDetails = await read<Record<string, { requestedUrl: string; rawDigestMatches: boolean }>>(`${root}/source/archive/entries/manifest.json`);
  if (!archivedIndex.rawDigestMatches || Object.values(archivedDetails).some(cap => !cap.rawDigestMatches)) throw new Error('Official archive digest verification missing');
  for (const member of backup.files) {
    const bytes = await fs.readFile(`${root}/source/website-backup/files/${member.relativePath}`);
    if (bytes.length !== member.size || hash(bytes) !== member.sha256) throw new Error('Backup member verification failed');
    const p = member.relativePath;
    if (!(/^pages\/\d+\.html$/.test(p) || p === 'index.html' || p.startsWith('attach/') || p.startsWith('css/') || ['favicon.ico', 'apple-touch-icon.png'].includes(p))) continue;
    const url = p === 'index.html' ? base : absolute(p, /^(attach|css)\//.test(p) ? cdn : base);
    const local = /\.(png|gif|ico)$/i.test(p) ? p.replace(/\.[^.]+$/, `.${native(bytes)}`) : p;
    buffers.set(url, bytes); resources[url] = local;
    replay[url] = { originalUrl: url, file: `../website-backup/files/${p}`, sha256: member.sha256, sourceKind: 'verified-public-website-backup', zipMember: member.zipMember, crc32: member.crc32 };
  }
  resources[`${base}index.html`] = 'index.html';
  for (const cap of Object.values(deps)) {
    const bytes = await fs.readFile(`${root}/source/dependencies/${cap.file}`);
    if (cap.status !== 200 || hash(bytes) !== cap.sha256) throw new Error('Source dependency verification failed');
    const local = `${cap.kind === 'css' ? 'css' : 'assets'}/${createHash('sha256').update(cap.originalUrl).digest('hex').slice(0, 24)}.${cap.kind === 'css' ? 'css' : native(bytes)}`;
    buffers.set(cap.originalUrl, bytes); resources[cap.originalUrl] = local; resources[cap.actualUrl] = local;
    replay[cap.originalUrl] = { ...cap, file: `../dependencies/${cap.file}`, sourceKind: 'current-shared-theme-dependency' };
  }
  const sanitize = (html: string, owner: string) => {
    const $ = cheerio.load(`<div class="source-comment">${html}</div>`);
    $('script,noscript,iframe,form,style,link,meta,object,embed,img').remove();
    $('pre').each((_, e) => { $(e).replaceWith($('<div>').html($(e).html() || '')); });
    $('*').each((_, e) => { for (const a of Object.keys(e.attribs)) if (a.startsWith('on') || ['style','id','class','width','height','align','bgcolor','background','color','face','size'].includes(a)) $(e).removeAttr(a); });
    $('a[href]').each((_, e) => { const url = new URL($(e).attr('href')!, owner), key = new URL(url); key.hash = ''; if (!['http:','https:','mailto:'].includes(url.protocol)) $(e).removeAttr('href'); else $(e).attr('href', resources[key.href] ? `/original-pages/${id}/${resources[key.href]}${url.hash}` : url.href); });
    $('a').filter((_, e) => !$(e).text().trim() && !$(e).children().length).remove();
    return $('body>div').html()?.trim() || '';
  };
  const save = async (url: string, folder: string, stem: string) => {
    const bytes = buffers.get(url); if (!bytes) throw new Error(`Captured image missing: ${url}`);
    const local = `/${folder}/${id}/${stem}.${native(bytes)}`;
    await fs.mkdir(path.dirname(`public${local}`), { recursive: true }); await fs.writeFile(`public${local}`, bytes);
    return { sourceUrl: url, local, sha256: hash(bytes) };
  };
  const $ = cheerio.load(buffers.get(base)!), works: WorkEntry[] = [], entries = [];
  for (const tr of $('#atwiki_table_sample table').first().find('tr').slice(1).toArray()) {
    const cells = $(tr).children(), no = cells.eq(0).text().trim().padStart(2, '0'), previous = old.find(w => w.no === no);
    const detailUrl = absolute(cells.eq(3).find('a[href]').first().attr('href')!), bytes = buffers.get(detailUrl);
    if (!previous || !bytes) throw new Error('Existing catalogue identity or source detail absent');
    const q = cheerio.load(bytes), body = q('#wikibody'), heading = body.find('h2').first().text().trim();
    const title = heading.replace(/^No\.\s*\d+\s*/, '').replace(/\s*【.+?】$/, '').trim();
    if (norm(title) !== norm(previous.title)) throw new Error(`Title needs source reconciliation: ${no}`);
    const metadata = body.find('h4').filter((_, e) => /^(作者|ジャンル|使用ツール)\s*[：:]/.test(q(e).text().trim())).map((_, e) => q(e).text().trim()).get().join(' / '), fields: Record<string, string> = {};
    for (const match of metadata.matchAll(/(?:^|[/／]\s*)(作者|ジャンル|使用ツール)\s*[：:]\s*([\s\S]*?)(?=[/／]\s*(?:作者|ジャンル|使用ツール)\s*[：:]|$)/g)) fields[match[1]] = match[2].trim();
    const find = (s: string) => body.find('h4').filter((_, e) => q(e).text().trim().startsWith(s)).first();
    const streaming = find('配信/動画'), download = find('DL'), forum = find('感想');
    const work: WorkEntry = { id: previous.id, festivalId: id, no, title: previous.title, author: fields['作者'] || '', source: { url: detailUrl, ...(archivedDetails[detailUrl] ? { snapshotUrl: archivedDetails[detailUrl].requestedUrl } : {}), titleUrl: base, ...(!fields['作者'] ? { authorOmitted: true } : {}) } };
    if (fields['ジャンル']) work.category = fields['ジャンル'];
    const headingTool = heading.match(/【(.+?)】$/)?.[1].trim();
    if (fields['使用ツール'] || headingTool) work.engine = fields['使用ツール'] || headingTool;
    const catalogueTitle = cells.eq(3).clone(); catalogueTitle.find('br').replaceWith('\n');
    const titleLines = catalogueTitle.text().split('\n').map(s => s.trim()).filter(Boolean), catalogueAuthor = titleLines.length > 1 ? titleLines.at(-1)! : '';
    const catalogueClass = cells.eq(4), sourceDifferences: string[] = [];
    const classLines = catalogueClass.clone(); classLines.find('br').replaceWith('\n');
    const catalogueCategory = classLines.text().split('\n').map(s => s.trim()).filter(s => s && norm(s) !== norm(work.engine || '')).join('\n');
    if (!work.category && catalogueCategory) work.category = catalogueCategory;
    if (catalogueAuthor && norm(catalogueAuthor) !== norm(work.author)) { const fragment = cheerio.load('<p><strong>作品一覧の作者表記</strong><br></p>'); fragment('p').append(fragment('<span>').text(catalogueAuthor)); sourceDifferences.push(fragment('body').html()!); }
    if (norm(catalogueClass.text()) !== norm((work.category || '') + (work.engine || ''))) sourceDifferences.push('<p><strong>作品一覧の分類表記</strong></p>' + (catalogueClass.html() || ''));
    if (sourceDifferences.length) work.sourceContent = sanitize(sourceDifferences.join('\n'), base);
    const streamText = streaming.text().split(/[：:]/).slice(1).join('：').trim(); if (streamText) work.streaming = streamText;
    const start = streaming.length ? streaming : body.find('h4').first(), authorNodes = start.nextUntil(download);
    work.authorComment = sanitize(authorNodes.map((_, e) => q.html(e)).get().join('\n'), detailUrl);
    const links: WorkDownload[] = []; download.add(download.nextUntil('h4')).find('a[href]').each((_, e) => { const url = absolute(q(e).attr('href')!, detailUrl); if (/^https?:/.test(url) && !links.some(x => x.url === url)) links.push({ url, label: q(e).text().trim() || 'DL' }); });
    if (links.length) { work.downloads = links; work.download = links[0]; }
    const forumHref = forum.find('a[href]').first().attr('href'); if (forumHref) work.forum = absolute(forumHref, detailUrl);
    const iconHref = cells.eq(1).find('img[src]').first().attr('src'); if (iconHref) work.icon = (await save(absolute(iconHref), 'icons', `${no}-source`)).local;
    const screenshotSources = [], inlineIconSources = [], displayed = new Map<string, string>();
    const iconDigest = work.icon ? hash(await fs.readFile(`public${work.icon}`)) : undefined;
    for (const url of [...new Set(body.find('img[src]').map((_, e) => absolute(q(e).attr('src')!, detailUrl)).get())]) {
      const image = buffers.get(url); if (!image) throw new Error('Source screenshot absent');
      const digest = hash(image);
      const sourceImage = body.find('img[src]').filter((_, e) => absolute(q(e).attr('src')!, detailUrl) === url).first();
      const iconSlot = sourceImage.attr('width') === '32' && sourceImage.attr('height') === '32';
      if (digest === iconDigest && iconSlot) { inlineIconSources.push({ sourceUrl: url, local: work.icon, sha256: digest, roleEvidence: 'Same bytes as catalogue icon, displayed in the original 32x32 icon slot.' }); continue; }
      let local = displayed.get(digest);
      if (!local) { local = (await save(url, 'screenshots', `${no}-source-${displayed.size + 1}`)).local; displayed.set(digest, local); }
      screenshotSources.push({ sourceUrl: url, local, sha256: digest });
    }
    if (displayed.size) work.ss = [...displayed.values()];
    works.push(work); entries.push({ id: work.id, no, detailUrl, snapshotUrl: work.source?.snapshotUrl, sourceHeading: heading, sourceFile: `source/website-backup/files/${resources[detailUrl]}`, sourceMetadata: fields, categoryFromCatalogue: !fields['ジャンル'] && !!catalogueCategory, sourceCatalogueAuthor: catalogueAuthor, sourceCatalogueClassification: catalogueClass.html(), catalogueMetadataDifference: sourceDifferences.length > 0, authorOmitted: !fields['作者'], screenshotSources, inlineIconSources, iconSourceUrl: iconHref ? absolute(iconHref) : undefined, downloadLinks: links, authorCommentPresent: !!work.authorComment, packagesDownloaded: false });
  }
  if (works.length !== 50 || new Set(works.map(w => w.id)).size !== 50) throw new Error('Catalogue cardinality changed');
  const banners: string[] = [], bannerSources = [];
  for (const img of $('#wikibody img').filter((_, e) => !$(e).closest('#atwiki_table_sample').length).toArray()) {
    const url = absolute($(img).attr('src')!), bytes = buffers.get(url); if (!bytes) throw new Error('Published banner missing');
    const local = `/banners/${id}-source-${banners.length + 1}.${native(bytes)}`; await fs.writeFile(`public${local}`, bytes); banners.push(local); bannerSources.push({ sourceUrl: url, local, sha256: hash(bytes) });
  }
  const festivals = await read<Festival[]>('src/data/festivals.json'); festivals.find(f => f.id === id)!.banners = banners;
  await fs.mkdir(`${root}/source/replay`, { recursive: true }); await writeJson(`${root}/source/replay/manifest.json`, replay);
  await writeJson(`src/data/works/${id}.json`, works); await writeJson('src/data/festivals.json', festivals);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, officialIndexSnapshot: archivedIndex.requestedUrl, officialCrossCheckManifests: ['source/archive/manifest.json', 'source/archive/entries/manifest.json'], publicBackupPage: backup.publicPage, sourceMode: 'verified-public-website-backup-cross-checked-against-official-archives', sourceManifests: ['source/replay/manifest.json'], originalResources: resources, entries, bannerSources, handling: 'Direct archival without work-content or image screening. Archive all displayed source images without a size or six-image cap. Images whose bytes match the catalogue icon and whose original markup explicitly uses its 32x32 icon slot retain their inline-icon role. Screenshot-slot images remain in the gallery even when the catalogue also reuses them as icons. No natural-dimension filter is applied. Existing IDs and catalogue titles retained. No game package downloaded. Preserve 50 listed works and the original unnumbered auxiliary pages separately.', desktopReview: 'pending' });
  console.log(JSON.stringify({ works: works.length, screenshots: works.reduce((s,w) => s + (w.ss?.length || 0), 0), icons: works.filter(w => w.icon).length, downloadEntries: works.filter(w => w.download).length, downloadLinks: works.reduce((s,w) => s + (w.downloads?.length || 0), 0), authorOmitted: works.filter(w => w.source?.authorOmitted).map(w => w.no), banners: banners.length, replayResources: Object.keys(replay).length }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
