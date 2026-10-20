import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { imageExtension, writeJson } from './recover-entry-table';
import type { Festival, WorkEntry } from '../src/lib/types';

const id = '2023-winter', root = `catch/${id}`, base = 'https://itch.io/jam/viprmwinterjam2023-anno-draconis';
type Capture = { originalUrl: string; actualUrl: string; status: number; file: string; sha256: string; kind: string; no?: string; usable?: boolean; sourceDirectory?: string; requestedUrl?: string; rawFile?: string; rawSha256?: string; rawDigestMatches?: boolean };
type Row = { no: string; id: string; title: string; author: string; gameId: number; rateUrl: string; gameUrl: string; iconUrl: string; forumUrl?: string; catalogueNotesHtml?: string; rateSourceDirectory: string; rateSourceFile: string; rateSnapshotUrl?: string; projectSourceDirectory: string; projectSourceFile: string; projectSnapshotUrl?: string };
type EntryProps = { total_entries_count: number; jam_games: Array<{ game: { id: number; url: string; cover: string; short_text?: string } }> };
const read = async <T,>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, 'utf8'));
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const norm = (s: string) => s.normalize('NFKC').replace(/\s/g, '');
const key = (s: string, owner = base) => { const u = new URL(s, owner); u.hash = ''; return u.href.replace(/\?$/, ''); };
function native(b: Buffer) {
  const magic = b.subarray(0, 4).toString(), hex = b.subarray(0, 4).toString('hex');
  if (magic === 'wOF2') return 'woff2'; if (magic === 'wOFF') return 'woff';
  if (hex === '00010000') return 'ttf'; if (magic === 'OTTO') return 'otf';
  if (b.length > 36 && b.readUInt32LE(0) === b.length && b.subarray(34, 36).toString('hex') === '4c50') return 'eot';
  if (hex === '00000200') return 'cur';
  if (/<svg[\s>]/i.test(b.subarray(0, 1000).toString())) return 'svg';
  return imageExtension(b);
}

async function main() {
  const pages = await read<Capture[]>(`${root}/investigation/selected-html-sources.json`), rows = await read<Row[]>(`${root}/investigation/project-plan.json`), previous = await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`);
  const styles = await read<Record<string, Capture>>(`${root}/source/styles/manifest.json`), currentAssets = await read<Record<string, Capture>>(`${root}/source/assets/manifest.json`), archivedAssets = await read<Record<string, Capture>>(`${root}/source/archive-assets/manifest.json`);
  const resources: Record<string, string> = {}, buffers = new Map<string, Buffer>(), formats = new Map<string, string>(), replay: Record<string, unknown> = {};
  const load = async (directory: string, cap: Capture) => {
    const b = await fs.readFile(`${root}/source/${directory}/${cap.file}`);
    if (cap.status !== 200 || hash(b) !== cap.sha256) throw new Error(`Unverified source payload: ${cap.originalUrl}`);
    if (directory.startsWith('archive') && (!cap.rawDigestMatches || (cap.rawFile && hash(await fs.readFile(`${root}/source/${directory}/${cap.rawFile}`)) !== cap.rawSha256))) throw new Error('Archived source digest evidence is invalid');
    return b;
  };
  const register = (cap: Capture, directory: string, local: string, bytes: Buffer) => {
    const url = key(cap.originalUrl); resources[url] = local; resources[key(cap.actualUrl)] = local; buffers.set(url, bytes);
    replay[url] = { ...cap, originalUrl: url, file: `../${directory}/${cap.file}`, sourceKind: directory };
  };
  for (const cap of pages) {
    let local: string;
    if (cap.kind === 'jam') local = 'index.html';
    else if (cap.kind === 'entries') local = 'entries.html';
    else if (cap.kind === 'screenshots') local = 'screenshots.html';
    else if (cap.kind === 'rate') local = `rate/${cap.originalUrl.split('/').pop()}.html`;
    else if (cap.kind === 'project' && cap.no !== undefined) local = `game/${cap.no.padStart(2, '0')}.html`;
    else throw new Error('Unknown source page role');
    register(cap, cap.sourceDirectory!, local, await load(cap.sourceDirectory!, cap));
  }
  resources[`${base}/`] = 'index.html';
  const entriesUrl = `${base}/entries`, entriesDom = cheerio.load(buffers.get(entriesUrl)!);
  const initializer = 'R.Jam.BrowseEntries(', script = entriesDom('script:not([src])').toArray().map(e => entriesDom(e).html() || '').find(s => s.includes(initializer));
  if (!script) throw new Error('Official embedded submission data absent');
  const start = script.indexOf(initializer) + initializer.length, end = script.lastIndexOf('), document.getElementById(');
  if (end <= start) throw new Error('Embedded submission wrapper changed');
  const entryProps: EntryProps = JSON.parse(script.slice(start, end));
  if (entryProps.jam_games.length !== entryProps.total_entries_count || entryProps.jam_games.some(e => !rows.some(r => r.gameId === e.game.id))) throw new Error('Embedded submission identity mismatch');
  await writeJson(`${root}/investigation/embedded-entry-props.json`, entryProps);
  for (const cap of Object.values(styles)) register(cap, 'styles', `css/${createHash('sha256').update(cap.originalUrl).digest('hex').slice(0, 24)}.css`, await load('styles', cap));
  for (const cap of Object.values({ ...currentAssets, ...archivedAssets })) {
    if (!cap.usable) throw new Error(`Source asset still unavailable: ${cap.originalUrl}`);
    const directory = archivedAssets[cap.originalUrl] ? 'archive-assets' : 'assets', b = await load(directory, cap), format = native(b);
    formats.set(key(cap.originalUrl), format);
    register(cap, directory, `assets/${createHash('sha256').update(cap.originalUrl).digest('hex').slice(0, 24)}.${format}`, b);
  }
  const entriesByUrl = new Map(entryProps.jam_games.map(e => [key(e.game.url), e.game])); let materializedCovers = 0;
  entriesDom('.game_cell .game_thumb[href]').each((_, e) => {
    const node = entriesDom(e), game = entriesByUrl.get(key(node.attr('href')!));
    if (!game || !buffers.has(key(game.cover)) || node.children().length) throw new Error('Submission cover/source fallback mismatch');
    node.append(entriesDom('<img>').attr({ src: game.cover, alt: '', class: 'lazy_loaded', 'data-archive-source': 'embedded-submission-props' })); materializedCovers++;
  });
  if (materializedCovers !== entryProps.jam_games.length) throw new Error('Submission covers incomplete');
  entriesDom('.index_game_grid_widget.preview_grid').css('opacity', '1');
  const derivedEntries = Buffer.from(entriesDom.html()), entriesCapture = pages.find(p => p.kind === 'entries')!;
  buffers.set(entriesUrl, derivedEntries);
  await fs.mkdir(`${root}/source/replay`, { recursive: true }); await fs.writeFile(`${root}/source/replay/entries-derived.html`, derivedEntries);
  replay[entriesUrl] = { originalUrl: entriesUrl, file: 'entries-derived.html', sha256: hash(derivedEntries), sourceKind: 'derived-from-official-embedded-entry-props', rawSourceFile: `source/${entriesCapture.sourceDirectory}/${entriesCapture.file}`, rawSourceSha256: entriesCapture.sha256, materializedCovers };
  await writeJson(`${root}/investigation/embedded-entry-extraction.json`, { sourceFile: `source/${entriesCapture.sourceDirectory}/${entriesCapture.file}`, sourceSha256: entriesCapture.sha256, initializer: 'R.Jam.BrowseEntries', parsedAs: 'JSON without executing source scripts', gameIds: entryProps.jam_games.map(e => e.game.id), materializedCovers, rawSourceUnchanged: true });
  const alias = (raw: string, owner: string) => {
    if (!raw || /^(?:data:|#|javascript:|mailto:)/i.test(raw)) return;
    const full = new URL(raw, owner).href, local = resources[key(full)]; if (local) resources[full] = local;
  };
  for (const cap of pages) {
    const q = cheerio.load(buffers.get(key(cap.originalUrl))!);
    q('[src],[href],[background],[data-lazy_src],[data-background_image]').each((_, e) => { for (const a of ['src','href','background','data-lazy_src','data-background_image']) { const v = q(e).attr(a); if (v) alias(v, cap.originalUrl); } });
    q('style,[style]').each((_, e) => { for (const m of (q(e).attr('style') || q(e).html() || '').matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) alias(m[1], cap.originalUrl); });
  }
  for (const cap of Object.values(styles)) for (const m of buffers.get(key(cap.originalUrl))!.toString().matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) alias(m[1], cap.originalUrl);
  const sanitize = (html: string, owner: string) => {
    const q = cheerio.load(`<div class="source-comment">${html}</div>`); q('script,style,noscript,iframe,form,object,embed,link,meta').remove();
    q('img').each((_, e) => {
      const n = q(e), raw = n.attr('src') || n.attr('data-lazy_src') || n.attr('data-src');
      if (!raw) { n.remove(); return; }
      const local = resources[key(raw, owner)]; if (!local) throw new Error('Description/comment image is not archived');
      n.attr('src', `/original-pages/${id}/${local}`).removeAttr('srcset data-lazy_src data-src');
    });
    q('*').each((_, e) => { for (const a of Object.keys(e.attribs)) if (a.startsWith('on') || ['style','width','height','align','bgcolor','background','color','face','size'].includes(a)) q(e).removeAttr(a); });
    q('a[href]').each((_, e) => { const raw = q(e).attr('href')!; if (raw.startsWith('#')) return; const u = new URL(raw, owner); if (!['http:','https:','mailto:'].includes(u.protocol)) q(e).removeAttr('href'); else { const local = resources[key(u.href)]; q(e).attr('href', local ? `/original-pages/${id}/${local}${u.hash}` : u.href); } });
    return q('body>div').toString();
  };
  const media = async (url: string, folder: string, name: string) => {
    const k = key(url), bytes = buffers.get(k), format = formats.get(k); if (!bytes || !format) throw new Error('Source media missing');
    const local = `/${folder}/${id}/${name}.${format}`; await fs.mkdir(path.dirname(`public${local}`), { recursive: true }); await fs.writeFile(`public${local}`, bytes);
    return { sourceUrl: url, local, sha256: hash(bytes) };
  };
  const jam = cheerio.load(buffers.get(base)!), hosts = jam('.jam_host_header a[href]').map((_, e) => new URL(jam(e).attr('href')!, base).hostname.replace(/\.itch\.io$/, '')).get();
  if (!hosts.length) throw new Error('Official host profile unavailable');
  const works: WorkEntry[] = [], evidence = [];
  for (const row of rows) {
    const old = previous.find(w => w.id === row.id); if (!old || old.title !== row.title || old.no !== row.no) throw new Error('Existing identity changed');
    const rate = cheerio.load(buffers.get(key(row.rateUrl))!), game = cheerio.load(buffers.get(key(row.gameUrl))!);
    if (game('meta[name="itch:path"]').attr('content') !== `games/${row.gameId}`) throw new Error('Project identity mismatch');
    const fields: Record<string, { text: string; html: string }> = {};
    rate('section.field_responses p').each((_, e) => { const n = rate(e).clone(), label = n.find('strong').first().text().trim(); n.find('strong').first().remove(); fields[label] = { text: n.text().trim(), html: n.html() || '' }; });
    const work: WorkEntry = { id: old.id, festivalId: id, no: old.no, title: old.title, author: fields['作者']?.text || row.author, source: { url: row.gameUrl, titleUrl: base, ...(row.projectSnapshotUrl ? { snapshotUrl: row.projectSnapshotUrl } : {}) }, forum: row.forumUrl };
    if (fields['ジャンル']?.text) work.category = fields['ジャンル'].text;
    if (fields['使用ツール']?.text) work.engine = fields['使用ツール'].text;
    if (fields['配信・動画化の可否']?.text) work.streaming = fields['配信・動画化の可否'].text;
    if (fields['作者コメント']?.text || /<img\b/i.test(fields['作者コメント']?.html || '')) work.authorComment = sanitize(fields['作者コメント'].html.replace(/^(?:\s|<br\s*\/?>)+/i, ''), row.rateUrl);
    const gameTitle = game('h1.game_title').text().trim(); if (gameTitle && norm(gameTitle) !== norm(work.title)) work.originalTitle = gameTitle;
    const descriptions = game('.formatted_description').toArray().filter(e => !game(e).closest('.community_post').length).map(e => sanitize(game(e).html() || '', row.gameUrl));
    const submissionSummary = entryProps.jam_games.find(e => e.game.id === row.gameId)?.game.short_text;
    const usedSubmissionSummary = !descriptions.length && !!submissionSummary;
    if (usedSubmissionSummary) { const q = cheerio.load('<p><strong>投稿一覧の短文</strong><br></p>'); q('p').append(q('<span>').text(submissionSummary!)); descriptions.push(sanitize(q('p').toString(), row.gameUrl)); }
    const externalVideoUrls = [...new Set(game('.video_embed_widget iframe[src]').map((_, e) => new URL(game(e).attr('src')!, row.gameUrl).href).get())];
    for (const url of externalVideoUrls) {
      const q = cheerio.load('<p></p>'); q('p').append(q('<a>').attr({ href: url, target: '_blank', rel: 'noreferrer' }).text('外部動画（原ページのリンク）'));
      descriptions.push(sanitize(q('p').toString(), row.gameUrl));
    }
    if (row.catalogueNotesHtml) descriptions.push(sanitize('<p><strong>会場一覧の補記</strong></p>' + row.catalogueNotesHtml, base));
    if (row.author && norm(row.author) !== norm(work.author)) { const q = cheerio.load('<p><strong>会場一覧の作者表記</strong><br></p>'); q('p').append(q('<span>').text(row.author)); descriptions.push(sanitize(q('p').toString(), base)); }
    if (fields['感想・バグ報告先']?.html) descriptions.push(sanitize('<p><strong>感想・バグ報告先</strong></p>' + fields['感想・バグ報告先'].html, row.rateUrl));
    if (descriptions.length) work.sourceContent = descriptions.join('\n<hr>\n');
    const hostPosts: Array<{ id?: string; html: string }> = [];
    for (const post of rate('.community_post').toArray()) {
      const author = rate(post).find('.post_header .post_author a').first().attr('href'); if (!author) continue;
      const u = new URL(author, row.rateUrl), handle = u.pathname.startsWith('/profile/') ? u.pathname.split('/')[2] : u.hostname.replace(/\.itch\.io$/, '');
      if (!hosts.includes(handle)) continue;
      const html = rate(post).find('.post_content .post_body').first().html(); if (html) hostPosts.push({ id: rate(post).attr('id') || rate(post).attr('data-post_id'), html: sanitize(html, row.rateUrl) });
    }
    if (hostPosts.length) work.hostComment = hostPosts.map(p => p.html).join('\n<hr>\n');
    work.icon = (await media(row.iconUrl, 'icons', `${row.no.padStart(2, '0')}-source`)).local;
    const screenshots: Array<{ sourceUrl: string; local: string; sha256: string }> = [];
    for (const a of game('.screenshot_list a[href]').toArray()) { const url = new URL(game(a).attr('href')!, row.gameUrl).href; if (!screenshots.some(s => s.sourceUrl === url)) screenshots.push(await media(url, 'screenshots', `${row.no.padStart(2, '0')}-source-${screenshots.length + 1}`)); }
    if (screenshots.length) work.ss = screenshots.map(s => s.local);
    work.download = { url: row.projectSnapshotUrl || row.gameUrl, label: row.projectSnapshotUrl ? '原配布ページ（Wayback）' : '原配布ページ' }; work.downloads = [work.download];
    works.push(work); evidence.push({ id: work.id, no: work.no, gameId: row.gameId, rateUrl: row.rateUrl, projectUrl: row.gameUrl, rateSourceDirectory: row.rateSourceDirectory, projectSourceDirectory: row.projectSourceDirectory, rateSnapshotUrl: row.rateSnapshotUrl, projectSnapshotUrl: row.projectSnapshotUrl, catalogueAuthor: row.author, metadataAuthor: fields['作者']?.text, originalProjectTitle: gameTitle, sourceFields: Object.fromEntries(Object.entries(fields).map(([k,v]) => [k,v.text])), iconSourceUrl: row.iconUrl, iconLocal: work.icon, screenshotSources: screenshots, externalVideoUrls, usedSubmissionSummary, descriptionBlocks: descriptions.length, authorCommentPresent: !!work.authorComment, officialHostPostIds: hostPosts.map(p => p.id), downloadEntry: work.download, packagesDownloaded: false });
  }
  if (works.length !== 33 || new Set(works.map(w => w.id)).size !== 33) throw new Error('Catalogue cardinality changed');
  const bannerSources = [], banners = [];
  for (const e of jam('.jam_content').children('figure').first().find('img[src]').toArray()) {
    const url = jam(e).attr('src')!, bytes = buffers.get(key(url)), format = formats.get(key(url)); if (!bytes || !format) throw new Error('Source banner absent');
    const local = `/banners/${id}-source-${banners.length + 1}.${format}`; await fs.writeFile(`public${local}`, bytes); banners.push(local); bannerSources.push({ sourceUrl: url, local, sha256: hash(bytes) });
  }
  const pagination = await read<Array<{ file: string; sha256: string; numItems: number; page: number }>>(`${root}/investigation/screenshots-pagination.json`); let extra = '', additionalItems = 0;
  for (const p of pagination) { const bytes = await fs.readFile(`${root}/source/live/${p.file}`); if (hash(bytes) !== p.sha256) throw new Error('Unverified screenshot pagination'); const json = JSON.parse(bytes.toString()); extra += json.content; additionalItems += json.num_items; }
  if (pagination.at(-1)?.numItems !== 0) throw new Error('Screenshot pagination end not verified');
  await writeJson(`${root}/investigation/screenshots-additional-derived.json`, { content: extra, num_items: additionalItems, derivedFrom: pagination.map(p => p.file) });
  const festivals = await read<Festival[]>('src/data/festivals.json'); festivals.find(f => f.id === id)!.banners = banners;
  await fs.mkdir(`${root}/source/replay`, { recursive: true }); await writeJson(`${root}/source/replay/manifest.json`, replay);
  await writeJson('src/data/festivals.json', festivals); await writeJson(`src/data/works/${id}.json`, works);
  await writeJson(`${root}/investigation/original-timemap.bin`, []);
  const screenshotOverview = { initialItems: 40, additionalItems, totalItems: 40 + additionalItems, appendSourceFile: 'investigation/screenshots-additional-derived.json', rawSources: pagination.map(p => `source/live/${p.file}`), endEvidence: 'investigation/screenshots-pagination.json' };
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: `${base}/`, liveSource: true, proxyRegion: 'Japan', sourceManifests: ['source/replay/manifest.json'], originalResources: resources, entries: evidence, bannerSources, screenshotOverview, embeddedSubmissions: { games: entryProps.jam_games.length, materializedCovers, evidence: 'investigation/embedded-entry-extraction.json' }, officialHostProfiles: hosts, archivedRows: rows.filter(r => r.projectSnapshotUrl).map(r => r.no), recoveredLegacyDisabledRows: previous.filter(w => w.detailDisabled).map(w => w.no), handling: 'Direct source archival without content, keyword or image-pixel screening. Keep all original gallery links without a six-image or natural-size filter. Preserve separately the 82-cell source screenshot overview and project galleries. Materialize the 30 exact covers from official embedded JSON into the existing source fallback grid without executing platform scripts. Current official catalogue titles/IDs/numbers remain primary; changed project titles and catalogue annotations retain their own fields. Download actions point to public distribution pages; three removed projects use verified historical project pages. No game package downloaded.', desktopReview: 'pending' });
  console.log(JSON.stringify({ works: works.length, screenshots: works.reduce((s,w) => s + (w.ss?.length || 0), 0), icons: works.filter(w => w.icon).length, banners: banners.length, archiveRows: rows.filter(r => r.projectSnapshotUrl).map(r => r.no), originalResources: Object.keys(replay).length, screenshotOverview: screenshotOverview.totalItems }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
