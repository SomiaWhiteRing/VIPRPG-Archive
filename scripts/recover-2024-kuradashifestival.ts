import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { imageExtension, writeJson } from './recover-entry-table';
import type { Festival, WorkEntry } from '../src/lib/types';

const id = '2024-kuradashifestival', root = `catch/${id}`, base = 'https://tkoolviprpg2421014.web.fc2.com/';
type Capture = { originalUrl: string; actualUrl: string; status: number; file: string; sha256: string; kind?: string };
type Row = { no: string; id: string; title: string; category: string; engine: string; date: string; downloadUrl: string; pickupUrl?: string };
type WikiEntry = { url: string; pageId: string; no?: string; id: string; title: string; originalTitle?: string; downloadUrl: string; images: string[]; matchBy: string };
const read = async <T,>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, 'utf8'));
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const norm = (text: string) => text.normalize('NFKC').replace(/\s/g, '');
const canonical = (url: string) => { const value = new URL(url); value.hash = ''; return value.href; };
function extension(bytes: Buffer) {
  if (/<svg[\s>]/i.test(bytes.subarray(0, 1000).toString())) return 'svg';
  const magic = bytes.subarray(0, 4).toString();
  if (magic === 'wOF2') return 'woff2'; if (magic === 'wOFF') return 'woff';
  return imageExtension(bytes);
}
async function main() {
  const live = await read<Record<string, Capture>>(`${root}/source/live/manifest.json`), assets = await read<Record<string, Capture>>(`${root}/source/resources/manifest.json`);
  const rows = await read<Row[]>(`${root}/investigation/catalogue-rows.json`), wiki = await read<WikiEntry[]>(`${root}/investigation/wiki-entry-mapping.json`), old = await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`);
  const buffers = new Map<string, Buffer>(), resources: Record<string, string> = {};
  for (const [directory, manifest] of [['live', live], ['resources', assets]] as const) for (const cap of Object.values(manifest)) {
    const bytes = await fs.readFile(`${root}/source/${directory}/${cap.file}`);
    if (cap.status !== 200 || hash(bytes) !== cap.sha256) throw new Error('Source capture verification failed');
    buffers.set(canonical(cap.originalUrl), bytes);
    const url = new URL(cap.originalUrl);
    const local = directory === 'live' ? (url.hostname === 'w.atwiki.jp' ? `wiki/${url.pathname.split('/viprpgkuradashi2024/')[1] || 'index.html'}` : url.pathname.slice(1)) : `${cap.kind === 'css' ? 'css' : 'assets'}/${createHash('sha256').update(cap.originalUrl).digest('hex').slice(0, 24)}.${cap.kind === 'css' ? 'css' : extension(bytes)}`;
    resources[canonical(cap.originalUrl)] = local; resources[canonical(cap.actualUrl)] = local;
  }
  const sanitize = (html: string, owner: string) => {
    const $ = cheerio.load(`<div>${html}</div>`);
    $('script,noscript,iframe,form,style,link,meta,object,embed,img').remove();
    $('pre').each((_, element) => { $(element).replaceWith($('<div>').html($(element).html() || '')); });
    $('*').each((_, element) => { for (const attribute of Object.keys(element.attribs)) if (attribute.startsWith('on') || ['style', 'id', 'class', 'width', 'height', 'align', 'bgcolor', 'background', 'color', 'face', 'size'].includes(attribute)) $(element).removeAttr(attribute); });
    $('a[href]').each((_, element) => { const url = new URL($(element).attr('href')!, owner); if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) $(element).removeAttr('href'); else $(element).attr('href', resources[canonical(url.href)] ? `/original-pages/${id}/${resources[canonical(url.href)]}${url.hash}` : url.href); });
    return $('body>div').html()?.trim() || '';
  };
  const pickupUrl = `${base}pickup_exf1.html`, pick = cheerio.load(buffers.get(pickupUrl)!);
  const works: WorkEntry[] = [], entries = [];
  for (const item of [...rows.map(row => ({ row, page: wiki.find(page => page.no === row.no) })), ...wiki.filter(page => !page.no).map(page => ({ row: undefined, page }))]) {
    const { row, page } = item, previous = row && old.find(work => work.id === row.id);
    if (row && (!previous || norm(previous.title) !== norm(row.title))) throw new Error('Existing catalogue identity changed');
    const work: WorkEntry = { id: row?.id || page!.id, festivalId: id, ...(row ? { no: row.no, category: row.category, engine: row.engine } : {}), title: previous?.title || page!.title, author: '', source: { url: page?.url || `${base}archive_exf1.html`, titleUrl: row ? `${base}archive_exf1.html` : page!.url, authorOmitted: true } };
    const fragments: string[] = [], imageUrls: string[] = [];
    if (row?.date) fragments.push(`<p><strong>投下日</strong><br>${row.date}</p>`);
    if (page) {
      if (page.originalTitle) work.originalTitle = page.originalTitle;
      const $ = cheerio.load(buffers.get(page.url)!); let section = 'other'; const author: string[] = [], other: string[] = [];
      $('#wikibody').children().each((_, element) => {
        const node = $(element);
        if (node.hasClass('atwiki-page-keyword') || node.hasClass('atwiki-lastmodify')) return;
        if (/^h[1-6]$/.test(element.tagName)) { section = node.text().trim() === '投下時コメント' ? 'author' : 'other'; if (section === 'author') return; }
        (section === 'author' ? author : other).push($.html(element));
      });
      work.authorComment = sanitize(author.join(''), page.url);
      fragments.push(sanitize(other.join(''), page.url));
      imageUrls.push(...page.images);
    } else work.sourceDetailUnavailable = true;
    if (row?.pickupUrl) {
      const sectionId = new URL(row.pickupUrl, base).hash.slice(1), section = pick(`[id="${sectionId}"]`), table = section.find('table').filter((_, element) => pick(element).closest('section[id]')[0] === section[0]).first(), trs = table.children('tbody').children('tr');
      if (trs.length !== 6) throw new Error('Pickup structure changed');
      work.hostComment = sanitize(trs.eq(5).children('td').html() || '', pickupUrl);
      fragments.push(sanitize(`<p><strong>${trs.eq(2).text()}</strong><br>${trs.eq(3).children('td').html()}</p>`, pickupUrl));
      table.find('img[src]').each((_, element) => { imageUrls.push(new URL(pick(element).attr('src')!, pickupUrl).href); });
    }
    work.sourceContent = fragments.join('\n');
    const primaryDownload = row?.downloadUrl || page!.downloadUrl;
    work.download = { url: primaryDownload, label: row ? '保存站下载' : '祭典 Wiki 下载' }; work.downloads = [work.download];
    const screenshotSources = [], displayedHashes = new Map<string, string>();
    for (const url of [...new Set(imageUrls)]) {
      const bytes = buffers.get(canonical(url)); if (!bytes) throw new Error('Screenshot capture missing');
      const digest = hash(bytes); let local = displayedHashes.get(digest);
      if (!local) { local = `/screenshots/${id}/${row?.no || `wiki-${page!.pageId}`}-source-${displayedHashes.size + 1}.${extension(bytes)}`; await fs.mkdir(path.dirname(`public${local}`), { recursive: true }); await fs.writeFile(`public${local}`, bytes); displayedHashes.set(digest, local); }
      screenshotSources.push({ sourceUrl: url, local, sha256: digest });
    }
    if (displayedHashes.size) work.ss = [...displayedHashes.values()];
    works.push(work); entries.push({ id: work.id, no: work.no, wikiUrl: page?.url, catalogueUrl: row ? `${base}archive_exf1.html` : undefined, pickupUrl: row?.pickupUrl ? new URL(row.pickupUrl, base).href : undefined, identityMatch: page?.matchBy, authorCommentPresent: !!work.authorComment, hostCommentPresent: !!work.hostComment, screenshotSources, catalogueOnly: !page, primaryDownloadUrl: primaryDownload, ...(page && row && row.downloadUrl !== page.downloadUrl ? { sourceDownloadDifference: { catalogueUrl: row.downloadUrl, wikiUrl: page.downloadUrl, handling: 'Keep the catalogue as the download action; retain the differing Wiki link inside its original source information and replay without treating it as a verified alternate package.' } } : {}) });
  }
  if (works.length !== 41 || rows.length !== 37 || wiki.length !== 27 || new Set(works.map(work => work.id)).size !== works.length) throw new Error('Catalogue union changed');
  const bannerSources = [`${base}img/kuradasi_banner24.png`, 'https://img.atwiki.jp/viprpgkuradashi2024/attach/1/8/kuradasi_banner.png'], banners: string[] = [];
  const bannerHashes = new Set<string>();
  for (const [index, url] of bannerSources.entries()) { const bytes = buffers.get(url); if (!bytes) throw new Error('Source banner missing'); const digest = hash(bytes); if (bannerHashes.has(digest)) continue; bannerHashes.add(digest); const local = `/banners/${id}-source-${index + 1}.${extension(bytes)}`; await fs.writeFile(`public${local}`, bytes); banners.push(local); }
  const festivals = await read<Festival[]>('src/data/festivals.json'), festival = festivals.find(value => value.id === id)!; festival.hasDetail = true; festival.banners = banners;
  await writeJson(`src/data/works/${id}.json`, works); await writeJson('src/data/festivals.json', festivals);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, liveSource: true, sourceManifests: ['source/live/manifest.json', 'source/resources/manifest.json'], originalResources: resources, catalogueRows: rows.length, wikiWorks: wiki.length, overlap: wiki.filter(page => page.no).length, additionalUnnumberedWorks: wiki.filter(page => !page.no).map(page => page.id), entries, bannerSources, handling: 'Direct archival without content screening. All 37 existing catalogue IDs and numbers retained; 4 additional official Wiki works remain unnumbered. Wiki submission comments, Wiki replies and archival-site curator comments remain distinct. Byte-identical images across sources share one displayed image; all source URLs and bytes remain documented. No package bytes downloaded.', desktopReview: 'pending' });
  console.log(JSON.stringify({ works: works.length, screenshots: works.reduce((sum, work) => sum + (work.ss?.length || 0), 0), authorComments: works.filter(work => work.authorComment).length, curatorComments: works.filter(work => work.hostComment).length, catalogueOnly: works.filter(work => work.sourceDetailUnavailable).length }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
