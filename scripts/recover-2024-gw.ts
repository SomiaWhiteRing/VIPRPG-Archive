import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import * as cheerio from 'cheerio';
import { imageExtension, writeJson } from './recover-entry-table';
import type { Festival, WorkEntry } from '../src/lib/types';

const id = '2024-gw', root = `catch/${id}`, base = 'https://viprpg24gw.x.2nt.com/', jam = 'https://itch.io/jam/viprpg-gw24';
const backupPage = 'https://ux.getuploader.com/kahitoyou/download/14';
type Capture = { file: string; sha256: string; originalUrl?: string; actualUrl?: string; status?: number; kind?: string; crc32?: number; size?: number; archiveEntry?: string; role?: string; declaredOriginalUrl?: string; sourceSelector?: string };
type Row = { no: string; priorId: string; title: string; author: string; engine: string; category: string; submission: string; streaming: string; sourceUrl: string; sourceKind: string; iconUrl?: string; tableScreens: string[]; downloads: Array<{ url: string; label: string }>; forum?: string };
const read = async <T,>(p: string): Promise<T> => JSON.parse(await fs.readFile(p, 'utf8'));
const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const key = (raw: string, owner = base) => { const u = new URL(raw, owner); u.hash = ''; return u.href.replace(/\?$/, ''); };
const norm = (s: string) => s.normalize('NFKC').replace(/\s/g, '');
function extension(b: Buffer) {
  const s = b.subarray(0, 4).toString(), h = b.subarray(0, 4).toString('hex');
  if (s === 'wOF2') return 'woff2'; if (s === 'wOFF') return 'woff'; if (h === '00010000') return 'ttf'; if (s === 'OTTO') return 'otf';
  if (b.length > 36 && b.readUInt32LE(0) === b.length && b.subarray(34, 36).toString('hex') === '4c50') return 'eot';
  if (h === '00000200') return 'cur'; if (/<svg[\s>]/i.test(b.subarray(0, 1000).toString())) return 'svg';
  return imageExtension(b);
}

async function main() {
  const primary = await read<Record<string, Capture>>(`${root}/source/website-backup/manifest.json`);
  const live = await read<Record<string, Capture>>(`${root}/source/live/manifest.json`);
  const savedPages = await read<Record<string, Capture>>(`${root}/source/itch-backup/manifest.json`);
  const savedAssets = await read<Record<string, Capture>>(`${root}/source/saved-itch-assets/manifest.json`);
  const external = await read<Record<string, Capture>>(`${root}/source/external/manifest.json`);
  const recoveredImages = await read<{ pairs: Array<{ originalUrl: string; archiveEntry: string; sourceAssetFile: string; sha256: string; cdxDigestVerified?: boolean; currentHttpStatus?: number }> }>(`${root}/investigation/recovered-publisher-image-urls.json`);
  const rows = await read<Row[]>(`${root}/investigation/catalogue-rows.json`);
  const prior = await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`);
  const identities = await read<{ results: Array<{ no: string; oldGameIds: string[]; submissionUrls: string[] }> }>(`${root}/investigation/project-identity-crosscheck.json`);
  if (rows.length !== 30 || prior.length !== 30) throw new Error('Unexpected primary catalogue size');
  const resources: Record<string, string> = {}, buffers = new Map<string, Buffer>(), replay: Record<string, { originalUrl: string; file: string; sha256: string; sourceFile: string; sourceKind: string }> = {};
  const output = `${root}/source/replay`; await fs.mkdir(output, { recursive: true });
  const load = async (directory: string, cap: Capture) => {
    const b = await fs.readFile(`${root}/source/${directory}/${cap.file}`);
    if (hash(b) !== cap.sha256 || (cap.crc32 !== undefined && crc32(b) !== cap.crc32)) throw new Error(`Unverified source: ${directory}`);
    return b;
  };
  const register = async (url: string, local: string, bytes: Buffer, sourceFile: string, sourceKind: string) => {
    const file = `${hash(url).slice(0, 24)}.bin`; await fs.writeFile(`${output}/${file}`, bytes);
    resources[key(url)] = local; buffers.set(key(url), bytes);
    replay[url] = { originalUrl: url, file, sha256: hash(bytes), sourceFile, sourceKind };
  };
  for (const cap of Object.values(primary)) {
    const url = cap.originalUrl!, local = new URL(url).pathname.slice(1) === 'index[1].html' ? 'index.html' : decodeURIComponent(new URL(url).pathname.slice(1));
    await register(url, local, await load('website-backup', cap), `source/website-backup/${cap.file}`, 'public-website-backup');
    resources[url.replace(/^https:/, 'http:')] = local;
  }
  const savedUrls = new Map<string, string>();
  for (const [name, cap] of Object.entries(savedAssets)) {
    const b = await load('saved-itch-assets', cap), css = cap.kind === 'css' || /\.css$/i.test(name), ext = css ? 'css' : extension(b);
    const virtual = `https://replay.invalid/${id}/${hash(name)}`;
    savedUrls.set(name, virtual);
    const font = /^(woff2?|ttf|otf|eot)$/.test(ext) || (ext === 'svg' && /<font[\s>]/.test(b.toString()));
    await register(virtual, `${font ? 'fonts' : css ? 'itch/styles' : 'itch/assets'}/${hash(b).slice(0, 24)}.${ext}`, b, `source/saved-itch-assets/${cap.file}`, 'saved-page-local-resource; publisher URL not preserved');
  }
  for (const cap of Object.values(external)) {
    if (cap.status !== 200) {
      if (!recoveredImages.pairs.some(p => p.originalUrl === cap.originalUrl && p.cdxDigestVerified) && cap.sourceSelector !== 'meta[property=og:image]') throw new Error('External resource is not recovered');
      continue;
    }
    const b = await load('external', cap), ext = cap.kind === 'css' ? 'css' : cap.kind === 'js' ? 'js' : extension(b);
    const font = /^(woff2?|ttf|otf|eot)$/.test(ext) || (ext === 'svg' && /<font[\s>]/.test(b.toString()));
    const local = `${font ? 'fonts' : ext === 'css' ? 'css' : ext === 'js' ? 'js' : 'assets'}/${hash(cap.originalUrl!).slice(0, 24)}.${ext}`;
    await register(cap.originalUrl!, local, b, `source/external/${cap.file}`, 'direct-source-or-verified-shared-cache');
    if (cap.actualUrl) resources[key(cap.actualUrl)] = local;
  }
  for (const pair of recoveredImages.pairs.filter(p => p.currentHttpStatus && p.currentHttpStatus !== 200)) {
    if (!pair.cdxDigestVerified) throw new Error('Recovered publisher image lacks CDX verification');
    const virtual = savedUrls.get(pair.archiveEntry)!;
    const bytes = await fs.readFile(`${root}/${pair.sourceAssetFile}`);
    if (hash(bytes) !== pair.sha256) throw new Error('Recovered publisher image changed');
    await register(pair.originalUrl, resources[key(virtual)], bytes, pair.sourceAssetFile, 'saved img src/data-lazy_src pair; exact bytes independently match publisher image CDX digest');
  }
  const reference = (raw: string, owner: string, savedName?: string) => {
    if (!raw || /^(data:|#|javascript:|mailto:)/i.test(raw)) return raw;
    let url: string;
    if (savedName && !/^(?:https?:)?\/\//i.test(raw) && !raw.startsWith('/')) {
      const name = path.posix.normalize(path.posix.join(path.posix.dirname(savedName), decodeURIComponent(raw.split(/[?#]/)[0])));
      url = savedUrls.get(name) || new URL(raw, owner).href;
    } else url = new URL(raw, owner).href;
    if (resources[key(url)]) resources[url] = resources[key(url)];
    return url;
  };
  const cssReferences = (s: string, owner: string) => s.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/g, (_, value: string) => `url("${reference(value, owner)}")`);
  for (const [name, cap] of Object.entries(savedAssets)) if (cap.kind === 'css' || /\.css$/i.test(name)) {
    const url = savedUrls.get(name)!, b = await load('saved-itch-assets', cap), owner = `https://static.itch.io/${path.posix.basename(name)}`;
    await register(url, resources[key(url)], Buffer.from(cssReferences(b.toString('utf8'), owner)), `source/saved-itch-assets/${cap.file}`, 'derived CSS; relative paths resolved against known platform stylesheet directory; original query unknown');
  }
  const normalizeSaved = async (cap: Capture, owner: string) => {
    const $ = cheerio.load((await load('itch-backup', cap)).toString('utf8'));
    $('script,noscript,iframe,form,object,embed,link[rel="manifest"],.adsbygoogle,[id^="aswift_"]').remove();
    $('img').each((_, img) => { const node = $(img), src = node.attr('src') || node.attr('data-lazy_src') || node.attr('data-src'); if (src) node.attr('src', reference(src, owner, cap.archiveEntry)); else node.remove(); node.removeAttr('srcset data-lazy_src data-src'); });
    $('[href],[background]').each((_, el) => { for (const attr of ['href', 'background']) { const value = $(el).attr(attr); if (value) $(el).attr(attr, reference(value, owner, cap.archiveEntry)); } });
    $('style').each((_, el) => { $(el).text(cssReferences($(el).text(), owner)); });
    $('[style]').each((_, el) => { $(el).attr('style', cssReferences($(el).attr('style')!, owner)); });
    return $.html();
  };
  const jamCapture = Object.values(savedPages).find(c => c.role === 'jam')!;
  await register(jam, 'itch/index.html', Buffer.from(await normalizeSaved(jamCapture, jam)), `source/itch-backup/${jamCapture.file}`, 'derived from saved venue HTML');
  const missingEntriesUrl = `${jam}/entries`;
  const entriesNotice = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>投稿一覧の原ページは未収録</title><style>body{font-family:sans-serif;max-width:48em;margin:2em auto;padding:0 1em;line-height:1.7}code{overflow-wrap:anywhere}</style></head><body><main data-archive-generated="source-gap-notice"><h1>投稿一覧の原ページは未収録</h1><p>現行の原URLは404を返し、参照した公開バックアップとCDX検索からもこの一覧ページは取得できませんでした。</p><p>保存された会場トップには13件の投稿一覧があります。</p><p><a href="${jam}">保存会場トップの一覧を開く</a></p><p>原URL：<code>${missingEntriesUrl}</code></p><p>これは保存庫の案内ページであり、原ページの複製ではありません。</p></main></body></html>`;
  await register(missingEntriesUrl, 'itch/entries.html', Buffer.from(entriesNotice), 'investigation/itch-entries-cdx.json; source/live/itch-entries.bin', 'generated source-gap notice; not original content');
  const rateById = new Map<string, Capture>();
  for (const cap of Object.values(savedPages).filter(c => c.role === 'submission')) {
    const url = cap.declaredOriginalUrl!, gid = new URL(url).pathname.split('/').pop()!; rateById.set(gid, cap);
    await register(url, `itch/rate/${gid}.html`, Buffer.from(await normalizeSaved(cap, url)), `source/itch-backup/${cap.file}`, 'derived from saved official submission HTML');
  }
  for (const row of rows.filter(r => r.sourceKind === 'itch')) {
    const cap = live[row.sourceUrl]; if (cap?.status !== 200) throw new Error(`Project page missing: ${row.no}`);
    await register(row.sourceUrl, `itch/game/${row.no}.html`, await load('live', cap), `source/live/${cap.file}`, 'current public project');
    if (cap.actualUrl) resources[key(cap.actualUrl)] = `itch/game/${row.no}.html`;
  }
  const sampleUrl = 'https://viprpg24gw.itch.io/sample', sample = Object.values(savedPages).find(c => c.role === 'project' && c.declaredOriginalUrl === sampleUrl)!;
  await register(sampleUrl, 'itch/game/sample.html', Buffer.from(await normalizeSaved(sample, sampleUrl)), `source/itch-backup/${sample.file}`, 'archived official unnumbered example; live page returns 404');
  resources[base] = 'index.html'; resources[`${jam}/`] = 'itch/index.html';
  resources[`${base}entry/favicon.ico`] = resources[`${base}img/favicon.ico`];
  resources[`${base}entry/img/apple-touch-icon.png`] = resources[`${base}img/apple-touch-icon.png`];
  // Include source fragment/query aliases without assigning new publisher URLs to saved local assets.
  for (const cap of Object.values(replay)) {
    const local = resources[key(cap.originalUrl)], b = await fs.readFile(`${output}/${cap.file}`);
    if (local.endsWith('.css')) cssReferences(b.toString(), cap.originalUrl);
    if (local.endsWith('.html')) { const $ = cheerio.load(b.toString()); $('[src],[href]').each((_, el) => { for (const a of ['src', 'href']) { const raw = $(el).attr(a); if (raw) reference(raw, cap.originalUrl); } }); }
  }
  const sanitize = (html: string, owner: string, savedName?: string) => {
    const $ = cheerio.load(`<div>${html}</div>`); $('script,style,noscript,iframe,form,object,embed,link,meta').remove();
    $('img').each((_, img) => { const node = $(img), raw = node.attr('src') || node.attr('data-lazy_src'); if (!raw) { node.remove(); return; } const url = reference(raw, owner, savedName), local = resources[key(url)]; if (!local) throw new Error('Description image is not archived'); node.attr('src', `/original-pages/${id}/${local}`).removeAttr('srcset data-lazy_src'); });
    $('*').each((_, el) => { for (const a of Object.keys(el.attribs)) if (a.startsWith('on') || ['style','width','height','align','bgcolor','background','color','face','size'].includes(a)) $(el).removeAttr(a); });
    $('a[href]').each((_, el) => { const raw = $(el).attr('href')!; if (raw.startsWith('#')) return; const url = reference(raw, owner, savedName); if (!/^(https?:|mailto:)/.test(url)) $(el).removeAttr('href'); else { const local = resources[key(url)]; $(el).attr('href', local ? `/original-pages/${id}/${local}` : url); } });
    return $('body>div').html()?.trim() || '';
  };
  const answers = async (cap?: Capture) => { const fields: Record<string, string> = {}; if (!cap) return fields; const $ = cheerio.load((await load('itch-backup', cap)).toString()); $('section.field_responses p').each((_, el) => { const copy = $(el).clone(), label = copy.find('strong').first().text().trim(); copy.find('strong').first().remove(); fields[label] = copy.text().trim(); }); return fields; };
  const works: WorkEntry[] = [], evidence = [];
  const media = async (url: string, name: string, folder: string) => { const b = buffers.get(key(url)); if (!b) throw new Error(`Source image missing: ${name}`); const local = `/${folder}/${id}/${name}.${extension(b)}`; await fs.mkdir(path.dirname(`public${local}`), { recursive: true }); await fs.writeFile(`public${local}`, b); return { local, sha256: hash(b), sourceUrl: url }; };
  for (const row of rows) {
    const previous = prior.find(w => w.id === row.priorId)!, gid = identities.results.find(r => r.no === row.no)?.oldGameIds[0], rate = gid ? rateById.get(gid) : undefined, fields = await answers(rate);
    const work: WorkEntry = { id: previous.id, festivalId: id, no: row.no, title: previous.title, author: fields['作者名'] || row.author, category: fields['ジャンル'] || row.category, engine: fields['ツール'] || row.engine, streaming: [fields['プレイ配信可否'] || row.streaming, fields['プレイ動画投稿可否'] || row.submission].filter(Boolean).join('/'), source: { url: row.sourceUrl, titleUrl: rate?.declaredOriginalUrl || (row.sourceKind === 'primary' ? row.sourceUrl : row.sourceUrl), ...(row.sourceKind === 'primary' || rate ? { snapshotUrl: backupPage } : {}) } };
    if (row.forum) work.forum = row.forum;
    if (row.iconUrl) work.icon = (await media(row.iconUrl, `${row.no}-source`, 'icons')).local;
    const raw = buffers.get(key(row.sourceUrl))!, $ = cheerio.load(raw.toString()), screenshots: string[] = [];
    let description: string;
    if (row.sourceKind === 'primary') { const intro = $('#entry').clone(); intro.find('h2,h3,.carousel_entry,.e_btn,.e_btn_dl,script,style').remove(); description = intro.html() || ''; $('#entry .carousel_entry img[src]').each((_, el) => screenshots.push(new URL($(el).attr('src')!, row.sourceUrl).href)); }
    else { description = $('.formatted_description').toArray().filter(el => !$(el).closest('.community_post').length).map(el => $(el).html() || '').join('\n<hr>\n'); $('.screenshot_list a[href]').each((_, el) => screenshots.push(new URL($(el).attr('href')!, row.sourceUrl).href)); const title = $('h1.game_title').text().trim(); if (title && norm(title) !== norm(work.title)) work.originalTitle = title; }
    if (!work.originalTitle && norm(row.title) !== norm(work.title)) work.originalTitle = row.title;
    work.sourceContent = sanitize(description, row.sourceUrl);
    const unique = [...new Set(row.sourceKind === 'primary' ? [...screenshots, ...row.tableScreens] : screenshots.length ? screenshots : row.tableScreens)], screenshotSources = [];
    for (const url of unique) screenshotSources.push(await media(url, `${row.no}-source-${screenshotSources.length + 1}`, 'screenshots'));
    if (screenshotSources.length) work.ss = screenshotSources.map(s => s.local);
    const urls = [...new Set([...row.downloads.map(d => d.url), ...(row.sourceKind === 'itch' ? [row.sourceUrl] : [])])];
    if (urls.length) { work.downloads = urls.map(url => ({ url, label: row.downloads.find(d => d.url === url)?.label || 'Source download' })); work.download = work.downloads[0]; }
    works.push(work); evidence.push({ no: row.no, id: work.id, sourceKind: row.sourceKind, sourceUrl: row.sourceUrl, officialSubmissionUrl: rate?.declaredOriginalUrl, fields, catalogueAuthor: row.author, legacyAuthor: previous.author, catalogueTitle: row.title, screenshotSources });
  }
  const sampleRate = rateById.get('2619079')!, fields = await answers(sampleRate), $sample = cheerio.load((await load('itch-backup', sample)).toString());
  const sampleWork: WorkEntry = { id: `${id}-work-itch-2619079`, festivalId: id, title: $sample('h1.game_title').text().trim(), author: fields['作者名'] || '', category: fields['ジャンル'], engine: fields['ツール'], streaming: [fields['プレイ配信可否'], fields['プレイ動画投稿可否']].filter(Boolean).join('/'), source: { url: sampleUrl, titleUrl: sampleRate.declaredOriginalUrl, snapshotUrl: backupPage }, sourceContent: sanitize($sample('.formatted_description').html() || '', sampleUrl, sample.archiveEntry) };
  const samplePictures = []; for (const a of $sample('.screenshot_list a[href]').toArray()) samplePictures.push(await media(new URL($sample(a).attr('href')!, sampleUrl).href, `sample-source-${samplePictures.length + 1}`, 'screenshots'));
  sampleWork.ss = samplePictures.map(s => s.local); if (!sampleWork.author) sampleWork.source!.authorOmitted = true;
  works.push(sampleWork); evidence.push({ id: sampleWork.id, sourceKind: 'archived-unnumbered-official-sample', sourceUrl: sampleUrl, officialSubmissionUrl: sampleRate.declaredOriginalUrl, fields, originalNumber: null, screenshotSources: samplePictures });
  if (works.length !== 31 || new Set(works.map(w => w.id)).size !== 31) throw new Error('Merged catalogue identity mismatch');
  const banner = buffers.get(key(`${base}img/banner24gw_01.png`)); if (!banner) throw new Error('Source banner missing');
  const bannerPath = `/banners/${id}-source.${extension(banner)}`; await fs.writeFile(`public${bannerPath}`, banner);
  const festivals = await read<Festival[]>('src/data/festivals.json'); festivals.find(f => f.id === id)!.banners = [bannerPath];
  await writeJson(`${output}/manifest.json`, replay);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, sourceMode: 'community website backup plus current publisher projects', entries: evidence, originalResources: resources, sourceManifests: ['source/replay/manifest.json'], unavailableSourceScripts: [`${base}js/header.js`], generatedSourceGapNotices: [{ path: 'itch/entries.html', originalUrl: missingEntriesUrl, reason: 'Original endpoint returns 404; public backup contains the venue overview but not this separate list, and the CDX prefix query returned no captures. The generated notice links to the saved 13-entry overview.' }], handling: 'Direct archival without content screening. Preserve supported existing titles, record aliases, retain unnumbered venue sample without inventing a number. Raw ZIP captures remain unchanged; replay.invalid is an explicit internal namespace for saved local resources whose publisher URL was not preserved. Packages were not downloaded.', desktopReview: 'pending' });
  await writeJson(`src/data/works/${id}.json`, works); await writeJson('src/data/festivals.json', festivals);
  console.log(JSON.stringify({ works: works.length, screenshots: works.reduce((s,w)=>s+(w.ss?.length||0),0), replayResources: Object.keys(replay).length, sampleNumber: sampleWork.no ?? null }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
