import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { imageExtension, writeJson } from './recover-entry-table';
import type { Festival, WorkEntry } from '../src/lib/types';

const id = '2026-toppatsu-festival', root = `catch/${id}`, base = 'https://w.atwiki.jp/viprpgtoppatsu/';
type Capture = { originalUrl: string; actualUrl: string; file: string; status: number; sha256: string; kind: string; no?: number; contentType: string };
type ProjectCapture = Omit<Capture, 'kind' | 'no'> & { no: string };
const read = async <T,>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, 'utf8'));
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const canonical = (raw: string, owner = base) => { const url = new URL(raw, owner); url.hash = ''; return url.href; };

async function main() {
  const pages = await read<Record<string, Capture>>(`${root}/source/live/manifest.json`), assets = await read<Record<string, Capture>>(`${root}/source/assets/manifest.json`);
  const projects = await read<Record<string, ProjectCapture>>(`${root}/source/projects/manifest.json`);
  const buffers = new Map<string, Buffer>(), resources: Record<string, string> = {}, replay: Record<string, Capture> = {};
  for (const [directory, manifest] of [['live', pages], ['assets', assets]] as const) for (const [url, cap] of Object.entries(manifest)) {
    const bytes = await fs.readFile(`${root}/source/${directory}/${cap.file}`);
    if (cap.status !== 200 || hash(bytes) !== cap.sha256) throw new Error('Unverified source response');
    buffers.set(url, bytes);
    let local: string;
    if (directory === 'live') local = new URL(url).pathname.slice(new URL(base).pathname.length) || 'index.html';
    else {
      const extension = cap.kind === 'css' ? 'css' : /image\/svg\+xml/.test(cap.contentType) ? 'svg' : imageExtension(bytes);
      local = `resources/${hash(url).slice(0, 24)}.${extension}`;
    }
    resources[canonical(url)] = local; resources[canonical(cap.actualUrl)] = local;
    replay[url] = { ...cap, file: `../${directory}/${cap.file}` };
  }
  for (const [url, bytes] of buffers) {
    const text = bytes.toString('utf8'), $ = cheerio.load(text);
    const alias = (raw: string) => { try { const u = new URL(raw, url), local = resources[canonical(u.href)]; if (local) resources[u.href] = local; } catch { /* Non-URL source attribute. */ } };
    $('[src],[href],[background]').each((_, e) => { for (const attr of ['src','href','background']) { const raw = $(e).attr(attr); if (raw) alias(raw); } });
    for (const match of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) alias(match[1]);
  }
  const sanitize = (html: string, owner: string) => {
    const $ = cheerio.load(`<div class="source-comment">${html}</div>`);
    $('script,style,noscript,form,input,button,select,iframe,object,embed,link,meta').remove();
    $('*').each((_, e) => { for (const a of Object.keys(e.attribs)) if (a.startsWith('on') || ['style','width','height','align','bgcolor','background','color','face','size'].includes(a)) $(e).removeAttr(a); });
    $('img[src]').each((_, e) => { const url = canonical($(e).attr('src')!, owner), local = resources[url]; if (!local) throw new Error('Unarchived source image'); $(e).attr('src', `/original-pages/${id}/${local}`).removeAttr('srcset'); });
    $('a[href]').each((_, e) => { const raw = $(e).attr('href')!; if (raw.startsWith('#')) return; const u = new URL(raw, owner); if (!['http:','https:','mailto:'].includes(u.protocol)) $(e).removeAttr('href'); else $(e).attr('href', u.href); });
    return $('body>div').html()?.trim() || '';
  };
  const saveImage = async (url: string, folder: string, name: string) => {
    const bytes = buffers.get(canonical(url)); if (!bytes) throw new Error('Image capture missing');
    const local = `/${folder}/${id}/${name}.${imageExtension(bytes)}`;
    await fs.mkdir(path.dirname(`public${local}`), { recursive: true }); await fs.writeFile(`public${local}`, bytes);
    return { sourceUrl: url, local, sha256: hash(bytes) };
  };
  const overview = cheerio.load(buffers.get(base)!.toString('utf8'));
  const works: WorkEntry[] = [], entries = [];
  for (const cap of Object.values(pages).filter(cap => cap.no).sort((a,b) => a.no! - b.no!)) {
    if (cap.actualUrl !== cap.originalUrl) throw new Error('Unexpected Wiki detail redirect');
    const no = String(cap.no), $ = cheerio.load(buffers.get(cap.originalUrl)!.toString('utf8')), body = $('#wikibody');
    const title = overview('a[href]').filter((_, a) => canonical(overview(a).attr('href')!) === cap.originalUrl).first().text().trim();
    const posting = body.find('h2').filter((_, h) => $(h).text().trim() === '【投下時コメント】').first();
    const feedback = body.find('h2').filter((_, h) => $(h).text().trim() === '【感想レス】').first();
    if (!title || !posting.length || !feedback.length || !posting.next('div').length) throw new Error('Wiki entry structure changed');
    const work: WorkEntry = { id: `${id}-work-${no.padStart(2, '0')}`, festivalId: id, no, title, author: '', source: { url: cap.originalUrl, titleUrl: base, authorOmitted: true } };
    if (cap.no! >= 9) work.group = '追加参戦！';
    work.authorComment = sanitize(posting.next('div').html() || '', cap.originalUrl);
    const feedbackNodes = []; let node = feedback.next();
    while (node.length && !node.is('.atwiki-page-tags,#atwiki-liked-counter,.atwiki-page-keyword,.atwiki-lastmodify')) { feedbackNodes.push($.html(node)); node = node.next(); }
    const feedbackHtml = sanitize(`<h3>【感想レス】</h3>${feedbackNodes.join('\n')}`, cap.originalUrl);
    if (feedbackHtml) work.sourceContent = feedbackHtml;
    work.forum = `${cap.originalUrl}#${feedback.attr('id')}`;
    const intro = body.clone(), feedbackClone = intro.find('h2').filter((_, h) => $(h).text().trim() === '【感想レス】');
    feedbackClone.nextAll().remove(); feedbackClone.remove();
    const downloads = [...new Set(intro.find('a[href]').toArray().map(a => new URL($(a).attr('href')!, cap.originalUrl).href))].filter(url => /^https?:/.test(url));
    if (downloads.length) { work.downloads = downloads.map(url => ({ url, label: '原配布ページ' })); work.download = work.downloads[0]; }
    const screenshotSources = []; for (const image of body.find('img[src]').toArray()) screenshotSources.push(await saveImage(new URL($(image).attr('src')!, cap.originalUrl).href, 'screenshots', `${no}-source-${screenshotSources.length + 1}`));
    const project = Object.values(projects).find(p => p.no === no);
    let supplementaryDescription = false, projectGameId: string | undefined;
    if (project) {
      const bytes = await fs.readFile(`${root}/source/projects/${project.file}`);
      if (!downloads.includes(project.originalUrl) || project.status !== 200 || hash(bytes) !== project.sha256) throw new Error('Unverified linked project');
      const $project = cheerio.load(bytes.toString('utf8'));
      projectGameId = $project('[data-game_id]').first().attr('data-game_id');
      if (!projectGameId) throw new Error('Linked project identifier missing');
      const projectTitle = $project('h1.game_title').text().trim();
      if (projectTitle && projectTitle.normalize('NFKC').replace(/\s/g, '') !== title.normalize('NFKC').replace(/\s/g, '')) work.originalTitle = projectTitle;
      for (const a of $project('.screenshot_list a[href]').toArray()) screenshotSources.push(await saveImage(new URL($project(a).attr('href')!, project.originalUrl).href, 'screenshots', `${no}-source-${screenshotSources.length + 1}`));
      const descriptions = $project('.formatted_description').toArray().filter(e => !$project(e).closest('.community_post').length).map(e => sanitize($project(e).html() || '', project.originalUrl)).filter(Boolean);
      if (descriptions.length) {
        const label = cheerio.load('<div><h3>配布ページの紹介</h3><p><a></a></p></div>');
        label('a').attr('href', project.originalUrl).text('原作品ページ');
        work.sourceContent = `${label('body>div').html()}\n${descriptions.join('\n<hr>\n')}\n<hr>\n${work.sourceContent || ''}`;
        supplementaryDescription = true;
      }
    }
    if (screenshotSources.length) work.ss = screenshotSources.map(s => s.local);
    const modified = body.find('.atwiki-lastmodify').text().trim(); if (modified) work.updates = modified;
    works.push(work); entries.push({ no, sourceCapture: cap, group: work.group, postingBlock: true, feedbackBlocks: feedbackNodes.length, screenshotSources, downloads: downloads.length, separatelyLabelledAuthor: false, separatelyLabelledEngineOrGenre: false, linkedProject: project, projectGameId, supplementaryDescription });
  }
  if (works.length !== 11 || new Set(works.map(w => w.no)).size !== 11) throw new Error('Incomplete Wiki catalogue');
  const bannerUrl = new URL(overview('#wikibody img[src]').first().attr('src')!, base).href, banner = await saveImage(bannerUrl, 'banners', 'source');
  const festivals = await read<Festival[]>('src/data/festivals.json');
  const festival: Festival = { id, slug: id, year: 2026, name: 'VIPRPG 2026突発祭り', type: 'special', period: '2026/9/19–9/27', banners: [banner.local], worksFile: `works/${id}.json`, columns: ['no','work','group','download','forum'] };
  const existing = festivals.findIndex(f => f.id === id); if (existing < 0) festivals.unshift(festival); else festivals[existing] = festival;
  await fs.mkdir(`${root}/source/replay`, { recursive: true }); await writeJson(`${root}/source/replay/manifest.json`, replay);
  await writeJson(`src/data/works/${id}.json`, works); await writeJson('src/data/festivals.json', festivals);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, liveSource: true, sourceEncoding: 'utf-8', proxyRegion: 'Japan; browser country independently observed as JP', sourceManifests: ['source/replay/manifest.json'], supplementarySourceManifest: 'source/projects/manifest.json', entries, originalResources: resources, banner, primaryWikiScreenshots: 0, screenshotReferences: works.reduce((n,w) => n + (w.ss?.length || 0), 0), handling: 'Archive every current Wiki entry, posting quotation, reader response and distribution link directly without content screening. No independently labelled author, engine, genre or streaming fields exist; anonymous thread IDs stay in quotations. Additional-participation group is separate from genre. No game packages downloaded. Wiki detail pages contain no screenshot image tags; the formatted view supplements descriptions and gallery originals from the two officially linked, live itch.io project pages, whose raw responses and game identifiers are recorded separately. Original Wiki layout is preserved.', desktopReview: 'pending' });
  console.log(JSON.stringify({ works: works.length, sourcePages: Object.keys(pages).length, sourceResources: Object.keys(assets).length, sourceScreenshots: works.reduce((n,w) => n + (w.ss?.length || 0), 0), postingQuotes: works.filter(w => w.authorComment).length, feedbackSections: works.filter(w => w.sourceContent).length, additionalGroup: works.filter(w => w.group).length }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
