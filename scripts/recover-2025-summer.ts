import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import * as cheerio from 'cheerio';
import { imageExtension, writeJson } from './recover-entry-table';
import type { Festival, WorkEntry } from '../src/lib/types';

const id = '2025-summer', root = `catch/${id}`, base = 'https://itch.io/jam/viprpgnatunozin2025';
type Capture = { originalUrl: string; actualUrl: string; status: number; file: string; sha256: string; no?: string; variant?: string; kind?: string; gameId?: number; sourceDirectory?: string; cdxDigest?: string; cdxDigestVerifiedOn?: string; wireSha256?: string };
type Row = { no: string; variant?: string; title: string; author: string; category: string; engine: string; streaming: string; iconUrl?: string; titleUrl?: string; downloadUrl?: string; downloadLinks?: Array<{ url: string; label: string }>; forumUrl?: string; gameUrl?: string; rateUrl?: string; gameId?: number; priorId: string; submissionMatchEvidence?: string };
const read = async <T,>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, 'utf8'));
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const normalize = (value: string) => value.normalize('NFKC').replace(/\s/g, '');
const pagePath = (capture: Capture) => `${root}/source/${capture.sourceDirectory || 'live'}/${capture.file}`;
const pageOwner = (capture: Capture) => capture.sourceDirectory === 'archive' ? capture.originalUrl : capture.actualUrl;
function pageGameIds($: cheerio.CheerioAPI) {
  const ids = $('[data-game_id]').toArray().map(element => Number($(element).attr('data-game_id')));
  $('script').each((_, element) => { for (const match of $(element).text().matchAll(/(?:game_id|"id"|\bid)\s*[":= ]+\s*(\d{5,})/g)) ids.push(Number(match[1])); });
  return [...new Set(ids)];
}
function sha1Base32(bytes: Buffer) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let accumulator = 0, bits = 0, output = '';
  for (const byte of createHash('sha1').update(bytes).digest()) { accumulator = (accumulator << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; output += alphabet[(accumulator >>> bits) & 31]; } }
  if (bits) output += alphabet[(accumulator << (5 - bits)) & 31];
  return output;
}

async function main() {
  const current = await read<Record<string, Capture>>(`${root}/source/live/manifest.json`);
  const archive = await read<Record<string, Capture>>(`${root}/source/archive/manifest.json`);
  const live: Record<string, Capture> = { ...current };
  for (const [url, capture] of Object.entries(archive)) {
    if (current[url]?.status !== 404 || capture.status !== 200 || !capture.cdxDigestVerifiedOn) throw new Error('Unexpected archive replacement');
    live[url] = { ...capture, sourceDirectory: 'archive' };
  }
  const styles = await read<Record<string, Capture>>(`${root}/source/styles/manifest.json`);
  const assets = await read<Record<string, Capture>>(`${root}/source/assets/manifest.json`);
  const plan = await read<Array<{ url: string }>>(`${root}/investigation/live-detail-plan.json`);
  for (const item of plan) if (live[item.url]?.status !== 200) throw new Error('Planned source page is not recovered');
  for (const [directory, manifest] of [['live', current], ['archive', archive], ['styles', styles], ['assets', assets]] as const) {
    for (const capture of Object.values(manifest)) {
      const bytes = await fs.readFile(`${root}/source/${directory}/${capture.file}`);
      if ((capture.status !== 200 && !(directory === 'live' && archive[capture.originalUrl])) || hash(bytes) !== capture.sha256) throw new Error('Unverified source payload');
      if (capture.cdxDigest) {
        if (!capture.cdxDigestVerifiedOn) throw new Error('Missing archived wire payload');
        const wire = await fs.readFile(`${root}/source/${directory}/${capture.cdxDigestVerifiedOn}`);
        if (hash(wire) !== capture.wireSha256 || sha1Base32(wire) !== capture.cdxDigest || !gunzipSync(wire).equals(bytes)) throw new Error('Archived payload verification failed');
      }
    }
  }
  const screenshotPages = await Promise.all(['screenshots-pagination.json', 'screenshots-pagination-end.json'].map(file => read<{ originalUrl: string; status: number; file: string; sha256: string; numItems: number }>(`${root}/investigation/${file}`)));
  for (const page of screenshotPages) {
    const bytes = await fs.readFile(`${root}/source/live/${page.file}`);
    if (page.status !== 200 || hash(bytes) !== page.sha256) throw new Error('Unverified screenshot pagination capture');
    const data: { num_items: number; content: string } = JSON.parse(bytes.toString('utf8'));
    if (data.num_items !== page.numItems || cheerio.load(data.content)('.game_screenshot_cell').length !== page.numItems) throw new Error('Screenshot pagination count mismatch');
  }
  if (screenshotPages[1].numItems !== 0) throw new Error('Screenshot pagination has not reached its end');
  const initialScreenshotPage = cheerio.load(await fs.readFile(`${root}/source/live/${live[`${base}/screenshots`].file}`, 'utf8'));
  const initialItems = initialScreenshotPage('.game_screenshot_cell').length;
  const screenshotOverview = { initialItems, additionalItems: screenshotPages[0].numItems, totalItems: initialItems + screenshotPages[0].numItems, appendSourceFile: `source/live/${screenshotPages[0].file}`, endEvidence: `${root}/investigation/screenshots-pagination-end.json` };
  const rows = await read<Row[]>(`${root}/investigation/live-catalogue-rows.json`);
  const legacy = await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`);
  const submissions = await read<{ jam_games: Array<{ game: { id: number; short_text?: string; user?: { name?: string } } }> }>(`${root}/investigation/live-entries-data.json`);
  if (rows.length !== 43 || legacy.length !== 43 || new Set(rows.map(row => row.priorId)).size !== 43) throw new Error('Catalogue identity mismatch');
  const resources: Record<string, string> = {};
  const formats = new Map<string, string>();
  const canonical = (url: string) => { const value = new URL(url, base); value.hash = ''; return value.href.replace(/\?$/, ''); };
  for (const capture of Object.values(assets)) {
    const bytes = await fs.readFile(`${root}/source/assets/${capture.file}`);
    const signature = bytes.subarray(0, 4).toString(), hex = bytes.subarray(0, 4).toString('hex');
    const extension = signature === 'wOF2' ? 'woff2' : signature === 'wOFF' ? 'woff'
      : hex === '00010000' ? 'ttf'
      : bytes.length > 36 && bytes.subarray(34, 36).toString('hex') === '4c50' ? 'eot'
      : hex === '00000200' ? 'cur'
      : /<svg[\s>]/i.test(bytes.subarray(0, 1000).toString()) ? 'svg' : imageExtension(bytes);
    const directory = /^(woff2?|ttf|eot)$/.test(extension) || (extension === 'svg' && bytes.toString('utf8').includes('<font')) ? 'fonts' : 'assets';
    const local = `${directory}/${hash(capture.originalUrl).slice(0, 24)}.${extension}`;
    resources[canonical(capture.originalUrl)] = local;
    resources[canonical(capture.actualUrl)] = local;
    formats.set(canonical(capture.originalUrl), extension);
  }
  for (const capture of Object.values(styles)) {
    const local = `styles/${hash(capture.originalUrl).slice(0, 24)}.css`;
    resources[capture.originalUrl] = local; resources[capture.actualUrl] = local;
  }
  for (const capture of Object.values(live)) {
    const local = capture.kind === 'rate' ? `rate/${new URL(capture.originalUrl).pathname.split('/').pop()}.html`
      : capture.kind === 'game' ? `game/${capture.no}${capture.variant || ''}.html`
      : capture.originalUrl === base ? 'index.html'
      : capture.originalUrl === `${base}/entries` ? 'entries.html'
      : capture.originalUrl === `${base}/screenshots` ? 'screenshots.html' : undefined;
    if (!local) throw new Error('Unexpected source page mapping');
    resources[capture.originalUrl] = local; resources[capture.actualUrl] = local;
    if (local === 'index.html') resources[`${base}/`] = local;
  }
  const alias = (raw: string, owner: string) => { try { const url = new URL(raw, owner); const local = resources[canonical(url.href)]; if (local) resources[url.href] = local; } catch { /* Non-URL source attribute. */ } };
  for (const capture of Object.values(live)) {
    const $ = cheerio.load(await fs.readFile(pagePath(capture), 'utf8'));
    $('[src],[href],[data-lazy_src],[data-background_image]').each((_, element) => { for (const name of ['src', 'href', 'data-lazy_src', 'data-background_image']) { const value = $(element).attr(name); if (value) alias(value, pageOwner(capture)); } });
  }
  for (const capture of Object.values(styles)) for (const match of (await fs.readFile(`${root}/source/styles/${capture.file}`, 'utf8')).matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) alias(match[1], capture.cdxDigest ? capture.originalUrl : capture.actualUrl);
  const asset = (url: string) => { const key = canonical(url), capture = assets[key]; if (!capture || !resources[key]) throw new Error('Missing source image'); return { key, capture, local: resources[key], extension: formats.get(key)! }; };
  const sanitize = (html: string, owner: string) => {
    const $ = cheerio.load(`<div>${html}</div>`);
    $('script,style,noscript,iframe,form,object,embed,link,meta').remove();
    $('img').each((_, image) => { const node = $(image), raw = node.attr('src') || node.attr('data-lazy_src') || node.attr('data-src'); if (!raw) { node.remove(); return; } const source = asset(new URL(raw, owner).href); node.attr('src', `/original-pages/${id}/${source.local}`).removeAttr('srcset data-lazy_src data-src'); });
    $('*').each((_, element) => { for (const attribute of Object.keys(element.attribs)) if (attribute.startsWith('on') || ['style', 'width', 'height', 'align', 'bgcolor', 'background', 'color', 'face', 'size'].includes(attribute)) $(element).removeAttr(attribute); });
    $('a[href]').each((_, element) => { const node = $(element), raw = node.attr('href')!; if (raw.startsWith('#')) return; const url = new URL(raw, owner); if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) { node.removeAttr('href'); return; } const local = resources[canonical(url.href)]; node.attr('href', local && assets[canonical(url.href)] ? `/original-pages/${id}/${local}${url.hash}` : url.href); });
    return $('body>div').html()?.trim() || '';
  };
  const overview = cheerio.load(await fs.readFile(`${root}/source/live/${live[base].file}`, 'utf8'));
  const hostUrls = overview('.jam_host_header a[href]').toArray().map(element => new URL(overview(element).attr('href')!, base));
  const hostProfiles = new Set(hostUrls.filter(url => url.hostname.endsWith('.itch.io')).map(url => `/profile/${url.hostname.slice(0, -'.itch.io'.length)}`));
  const works: WorkEntry[] = [], entries = [], titleChanges = [];
  for (const row of rows) {
    const previous = legacy.find(work => work.id === row.priorId)!;
    const submissionAuthor = submissions.jam_games.find(item => item.game.id === row.gameId)?.game.user?.name;
    const author = row.author || (submissionAuthor && normalize(previous.author) === normalize(submissionAuthor) ? previous.author : '');
    const work: WorkEntry = { id: previous.id, festivalId: id, no: row.no, title: row.title, author, category: row.category, engine: row.engine, streaming: row.streaming, source: { url: row.gameUrl || base, titleUrl: base, ...(!author ? { authorOmitted: true } : {}), ...(row.gameUrl && archive[row.gameUrl] ? { snapshotUrl: archive[row.gameUrl].actualUrl } : {}) } };
    if (normalize(previous.title) !== normalize(row.title)) titleChanges.push({ no: row.no, previousTitle: previous.title, currentTitle: row.title, sourceUrl: base, corroboration: `${root}/investigation/title-provenance-review.json` });
    if (row.forumUrl) work.forum = new URL(row.forumUrl, base).href;
    const stem = `${row.no}${row.variant || ''}`;
    let iconEvidence;
    if (row.iconUrl) {
      const icon = asset(row.iconUrl), iconPath = `/icons/${id}/${stem}-source.${icon.extension}`;
      await fs.mkdir(path.dirname(`public${iconPath}`), { recursive: true });
      await fs.copyFile(`${root}/source/assets/${icon.capture.file}`, `public${iconPath}`); work.icon = iconPath;
      iconEvidence = { sourceUrl: row.iconUrl, local: iconPath, sha256: icon.capture.sha256 };
    }
    const screenshots = [], screenshotSources = [], descriptions = [], officialPosts = [];
    let sourceGameId = row.gameId;
    if (row.gameUrl) {
      const capture = live[row.gameUrl], $ = cheerio.load(await fs.readFile(pagePath(capture), 'utf8'));
      const expectedGameId = row.gameId || capture.gameId, observedIds = pageGameIds($);
      if (expectedGameId && !observedIds.includes(expectedGameId)) throw new Error('Source game identity mismatch');
      sourceGameId ??= expectedGameId || Number($('[data-game_id]').first().attr('data-game_id')) || undefined;
      const projectTitle = $('h1.game_title').text().trim(); if (projectTitle && normalize(projectTitle) !== normalize(work.title)) work.originalTitle = projectTitle;
      for (const anchor of $('.screenshot_list a[href]').toArray()) {
        const sourceUrl = new URL($(anchor).attr('href')!, pageOwner(capture)).href, source = asset(sourceUrl);
        const local = `/screenshots/${id}/${stem}-source-${screenshots.length + 1}.${source.extension}`;
        await fs.mkdir(path.dirname(`public${local}`), { recursive: true }); await fs.copyFile(`${root}/source/assets/${source.capture.file}`, `public${local}`);
        screenshots.push(local); screenshotSources.push({ sourceUrl, local, sha256: source.capture.sha256 });
      }
      for (const element of $('.formatted_description').toArray().filter(element => !$(element).closest('.community_post').length)) { const html = sanitize($(element).html() || '', pageOwner(capture)); if (html) descriptions.push(html); }
      if (!descriptions.length) {
        const shortText = submissions.jam_games.find(item => item.game.id === row.gameId)?.game.short_text;
        if (shortText) { const $plain = cheerio.load('<p></p>'); $plain('p').text(shortText); descriptions.push($plain('p').toString()); }
      }
    } else work.sourceDetailUnavailable = true;
    if (row.rateUrl) {
      const capture = live[row.rateUrl], $ = cheerio.load(await fs.readFile(pagePath(capture), 'utf8'));
      if (row.gameId && !$('[data-game_id]').toArray().some(element => Number($(element).attr('data-game_id')) === row.gameId)) throw new Error('Source submission identity mismatch');
      for (const response of $('section.field_responses p').toArray()) {
        const clone = $(response).clone(), label = clone.find('strong').first().text().trim();
        if (label === '作者コメント') { clone.find('strong').first().remove(); work.authorComment = sanitize(clone.html() || '', capture.actualUrl).replace(/^(?:\s|<br\s*\/?>)+/i, '').trim(); }
        else descriptions.push(sanitize($(response).toString(), capture.actualUrl));
      }
      for (const post of $('.community_post').toArray()) {
        const author = $(post).find('.post_header .post_author a[href]').first().attr('href') || '';
        if (!hostProfiles.has(author) && !hostUrls.some(url => author.replace(/\/$/, '') === url.href.replace(/\/$/, ''))) continue;
        const html = sanitize($(post).find('.post_content .post_body').first().html() || '', capture.actualUrl);
        if (html) officialPosts.push({ id: $(post).attr('id') || $(post).attr('data-post_id'), html });
      }
    }
    if (screenshots.length) work.ss = screenshots;
    if (descriptions.length) work.sourceContent = descriptions.join('\n<hr>\n');
    if (officialPosts.length) work.hostComment = officialPosts.map(post => post.html).join('\n<hr>\n');
    const linkDiscrepancies = (row.downloadLinks || []).filter(link => { const url = new URL(link.url); return sourceGameId && url.origin === 'https://itch.io' && url.pathname.startsWith('/jam/viprpgnatunozin2025/rate/') && Number(url.pathname.split('/').pop()) !== sourceGameId; });
    const validCatalogueLinks = (row.downloadLinks || []).filter(link => !linkDiscrepancies.some(discrepancy => discrepancy.url === link.url));
    const primaryDownload = validCatalogueLinks.find(link => link.url === row.gameUrl || link.url === row.rateUrl)?.url || validCatalogueLinks[0]?.url || row.gameUrl;
    const downloads = [...new Set([primaryDownload, ...validCatalogueLinks.map(link => link.url), row.gameUrl].filter((url): url is string => !!url))].map(url => ({ url, label: row.downloadLinks?.find(link => link.url === url)?.label || 'Source download' }));
    if (downloads.length) { work.downloads = downloads; work.download = downloads[0]; }
    works.push(work); entries.push({ no: row.no, variant: row.variant, id: work.id, gameId: sourceGameId, sourceUrl: row.gameUrl || base, rateUrl: row.rateUrl, submissionMatchEvidence: row.submissionMatchEvidence, authorSourceUrl: row.author ? base : `${base}/entries`, catalogueAuthorOmitted: !row.author, retainedAuthorMatchesSubmission: !row.author && !!author, catalogueOnly: !row.gameUrl, icon: iconEvidence, iconMissingInSource: !row.iconUrl, screenshotSources, descriptionBlocks: descriptions.length, officialPosts: officialPosts.map(post => post.id), catalogueDownloadLinks: row.downloadLinks, linkDiscrepancies, packageBytesDownloaded: false });
  }
  const bannerUrl = overview('.jam_content img[src]').toArray().map(element => overview(element).attr('src')!).find(url => /img\.itch\.zone\/aW1n/i.test(url));
  if (!bannerUrl) throw new Error('Missing source banner');
  const banner = asset(bannerUrl), bannerPath = `/banners/${id}-source.${banner.extension}`;
  await fs.copyFile(`${root}/source/assets/${banner.capture.file}`, `public${bannerPath}`);
  const festivals = await read<Festival[]>('src/data/festivals.json'), festival = festivals.find(festival => festival.id === id)!;
  festival.banners = [bannerPath];
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: `${base}/`, liveSource: true, proxyRegion: 'Japan', capturedCatalogueRows: overview('table tr').filter((_, element) => overview(element).find('td').length === 7).length, uniqueCatalogueRows: new Set(rows.map(row => row.no)).size, works: works.length, submissions: submissions.jam_games.length, entries, screenshotOverview, originalResources: resources, titleChanges, sourceManifests: ['source/live/manifest.json', 'source/archive/manifest.json', 'source/styles/manifest.json', 'source/assets/manifest.json'], screenshotReferences: works.reduce((sum, work) => sum + (work.ss?.length || 0), 0), handling: 'Direct source archival without content screening. Collapse the two byte-identical repeated catalogue rows only in the formatted data; retain them in the source HTML. Keep the genuine two-work No.41 row and catalogue-only entries. Preserve all project gallery originals without the former six-image cap. Public download entry pages only; game packages were not downloaded.', desktopReview: 'pending' });
  await writeJson('src/data/festivals.json', festivals); await writeJson(`src/data/works/${id}.json`, works);
  console.log(JSON.stringify({ works: works.length, icons: works.filter(work => work.icon).length, screenshots: works.reduce((sum, work) => sum + (work.ss?.length || 0), 0), catalogueOnly: entries.filter(entry => entry.catalogueOnly).length, titleChanges: titleChanges.length }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
