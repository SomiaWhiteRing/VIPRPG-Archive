import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { imageExtension, writeJson } from './recover-entry-table';
import type { Festival, WorkEntry, WorkDownload } from '../src/lib/types';

const id = '2021-summer', root = `catch/${id}`, base = 'https://viprpg2021s.kenkenpa.net/';
type Capture = { originalUrl: string; actualUrl: string; status: number; file: string; sha256: string; kind: string; usable?: boolean };
const read = async <T,>(p: string): Promise<T> => JSON.parse(await fs.readFile(p, 'utf8'));
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const norm = (s: string) => s.normalize('NFKC').replace(/\s/g, '');

async function main() {
  const old = await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`);
  const pages = await read<Record<string, Capture>>(`${root}/source/live/manifest.json`), assets = await read<Record<string, Capture>>(`${root}/source/resources/manifest.json`);
  const resources: Record<string, string> = {}, buffers = new Map<string, Buffer>(), replay: Record<string, unknown> = {};
  for (const [dir, manifest] of [['live', pages], ['resources', assets]] as const) for (const cap of Object.values(manifest)) {
    if (cap.status !== 200 || cap.usable === false) throw new Error('Unresolved source capture');
    const b = await fs.readFile(`${root}/source/${dir}/${cap.file}`); if (hash(b) !== cap.sha256) throw new Error('Source payload hash mismatch');
    let local = new URL(cap.originalUrl).pathname.slice(1); if (cap.kind === 'asset') local = local.replace(/\.[^/.]+$/, `.${imageExtension(b)}`);
    resources[cap.originalUrl] = local; buffers.set(cap.originalUrl, b); replay[cap.originalUrl] = { ...cap, file: `../${dir}/${cap.file}` };
  }
  resources[base + 'no9.html'] = 'no09.html'; resources[base] = 'index.html'; resources[base.replace('https:', 'http:')] = 'index.html';
  const sanitize = (html: string) => {
    const q = cheerio.load(`<div class="source-comment">${html}</div>`);
    q('script,style,noscript,iframe,form,object,embed,link,meta').remove();
    q('*').each((_, e) => { for (const a of Object.keys(e.attribs)) if (a.startsWith('on') || ['id', 'style', 'width', 'height', 'align', 'bgcolor', 'color', 'face', 'size'].includes(a)) q(e).removeAttr(a); });
    q('img[src]').each((_, e) => { const u = new URL(q(e).attr('src')!, base).href; if (!resources[u]) throw new Error('Comment image not captured'); q(e).attr('src', `/original-pages/${id}/${resources[u]}`); });
    q('a[href]').each((_, e) => { const u = new URL(q(e).attr('href')!, base), k = new URL(u); k.hash = ''; if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) q(e).removeAttr('href'); else q(e).attr('href', resources[k.href] ? `/original-pages/${id}/${resources[k.href]}${u.hash}` : u.href); });
    return q('body>div').toString();
  };
  const formatChanges: Array<{ sourceUrl: string; actualExtension: string }> = [];
  const media = async (url: string, folder: string, name: string) => {
    const b = buffers.get(url); if (!b) throw new Error('Source image not captured');
    const ext = imageExtension(b), local = `/${folder}/${id}/${name}.${ext}`;
    if (path.extname(new URL(url).pathname).toLowerCase() !== `.${ext}`) formatChanges.push({ sourceUrl: url, actualExtension: ext });
    await fs.mkdir(path.dirname(`public${local}`), { recursive: true }); await fs.writeFile(`public${local}`, b);
    return { sourceUrl: url, local, sha256: hash(b) };
  };
  const $ = cheerio.load(buffers.get(base + 'index.html')!), works: WorkEntry[] = [], entries = [];
  const rows = $('tr').filter((_, e) => $(e).children('td').length === 7 && $(e).find('a[href]').toArray().some(a => /^no\d+\.html$/.test($(a).attr('href')!)));
  for (const row of rows.toArray()) {
    const cells = $(row).children('td'), no = cells.eq(0).text().trim(), previous = old.find(w => Number(w.no) === Number(no));
    const link = cells.eq(2).find('a[href]').first(), title = link.text().trim(), detailUrl = new URL(link.attr('href')!, base).href;
    if (!previous || norm(previous.title) !== norm(title)) throw new Error('Catalogue identity changed');
    const q = cheerio.load(buffers.get(detailUrl)!), sourceMetadata: Record<string, string> = {}, comments: Record<string, string> = {};
    q('td[colspan="2"]').each((_, e) => {
      const text = q(e).text().trim(), m = text.match(/^(作者|ジャンル|ツール|配信\/投稿)[:：]([\s\S]*)$/);
      if (m) sourceMetadata[m[1]] = m[2].trim();
      const html = q(e).html() || '', c = html.match(/^\s*(作者コメント|管理人コメント|主催コメント)\s*[:：]\s*(?:<br\s*\/?>)?/);
      if (c) { comments[c[1]] = html.slice(c[0].length); sourceMetadata[c[1]] = q(e).text().trim().replace(new RegExp(`^${c[1]}[:：]\\s*`), ''); }
    });
    const rawHeading = q('th').first().text().trim(), heading = rawHeading.replace(/^(?:No\.)?\d+\s*/, '');
    if (no !== '00' && Number(rawHeading.match(/^(?:No\.)?(\d+)/)?.[1]) !== Number(no)) throw new Error('Detail number does not match official catalogue link');
    const author = cells.eq(2).find('span').text().trim(), categoryCell = cells.eq(3).clone(); categoryCell.find('span').remove();
    const catalogueMetadata = { author, category: categoryCell.text().trim(), engine: cells.eq(3).find('span').text().trim(), streaming: cells.eq(5).text().trim() };
    const work: WorkEntry = { id: previous.id, festivalId: id, no: previous.no, title: previous.title, author: sourceMetadata['作者'] || author, source: { url: detailUrl, titleUrl: base + 'index.html#table2' } };
    if (no !== '00' && heading && heading !== previous.title) work.originalTitle = heading;
    for (const [label, field] of [['ジャンル', 'category'], ['ツール', 'engine'], ['配信/投稿', 'streaming']] as const) if (sourceMetadata[label] || catalogueMetadata[field]) work[field] = sourceMetadata[label] || catalogueMetadata[field];
    if (catalogueMetadata.streaming) work.streaming = catalogueMetadata.streaming;
    if (comments['作者コメント'] && sourceMetadata['作者コメント']) work.authorComment = sanitize(comments['作者コメント']);
    const host = comments['管理人コメント'] || comments['主催コメント']; if (host) work.hostComment = sanitize(host);
    const differences = []; for (const [label, field] of [['作者', 'author'], ['ジャンル', 'category'], ['ツール', 'engine'], ['配信/投稿', 'streaming']] as const) if (norm(sourceMetadata[label] || '') !== norm(catalogueMetadata[field])) differences.push({ label, catalogue: catalogueMetadata[field], detail: sourceMetadata[label] });
    const supplements = ['<h4>【公式一覧 DL/更新状態】</h4>' + (cells.eq(4).html() || '')]; if (no === '00') supplements.push('<p>［保存庫補記］00番は原サイトの記入見本です。サービス入口を指す雛形の配布・掲示板リンクは実ファイルのリンクとして扱っていません。</p>');
    if (differences.length) { const t = cheerio.load('<div></div>'); for (const d of differences) supplements.push(d.label === '配信/投稿' ? `<p><strong>原紹介ページの${d.label}</strong><br>${t('div').text(d.detail || '未記載').html()}</p>` : `<p><strong>公式一覧の${d.label}</strong><br>${t('div').text(d.catalogue).html()}</p>`); }
    work.sourceContent = sanitize(supplements.join('\n'));
    const downloads: WorkDownload[] = []; cells.eq(4).find('a[href]').each((_, a) => { const url = new URL($(a).attr('href')!, base).href; if (/^https?:/.test(url) && !(no === '00' && new URL(url).pathname === '/') && !downloads.some(d => d.url === url)) downloads.push({ url, label: $(a).text().trim() || 'DL' }); });
    if (downloads.length) { work.download = downloads[0]; work.downloads = downloads; }
    const forum = cells.eq(6).find('a[href]').attr('href'); if (forum && !(no === '00' && new URL(forum, base).pathname === '/')) work.forum = new URL(forum, base).href;
    const iconUrl = new URL(cells.eq(1).find('img').attr('src')!, base).href; work.icon = (await media(iconUrl, 'icons', `${work.no}-source`)).local;
    const urls = new Set<string>(); q('.entry_icon').first().closest('table').find('tr').eq(1).find('img[src]').each((_, e) => { urls.add(new URL(q(e).attr('src')!, base).href); for (const a of ['onmouseover', 'onmouseout']) for (const m of (q(e).attr(a) || '').matchAll(/this\.src\s*=\s*['"]([^'"]+)/g)) urls.add(new URL(m[1], base).href); });
    const missingImages = [...urls].filter(url => !buffers.has(url));
    if (missingImages.length) work.sourceContent += '<p>［保存庫補記］原ページのマウスオーバー切替画像は未取得です。通常表示の保存済み画像を保持しています。</p>';
    const shots = []; for (const url of urls) if (buffers.has(url)) shots.push(await media(url, 'screenshots', `${work.no}-source-${shots.length + 1}`)); if (shots.length) work.ss = shots.map(s => s.local);
    works.push(work); entries.push({ id: work.id, no: work.no, detailUrl, catalogueTitle: title, detailTitle: heading, sourceTemplate: no === '00', sourceMetadata, catalogueMetadata, metadataDifferences: differences, iconSourceUrl: iconUrl, screenshotSources: shots, missingImageUrls: missingImages, downloadLinks: downloads, packagesDownloaded: false });
  }
  if (works.length !== 46 || new Set(works.map(w => w.id)).size !== 46) throw new Error('Catalogue cardinality changed');
  const banner = await media(base + 'image/banner1.png', 'banners', 'current-source');
  const festivals = await read<Festival[]>('src/data/festivals.json'); festivals.find(f => f.id === id)!.banners = [banner.local];
  await fs.mkdir(`${root}/source/replay`, { recursive: true }); await writeJson(`${root}/source/replay/manifest.json`, replay);
  await writeJson(`src/data/works/${id}.json`, works); await writeJson('src/data/festivals.json', festivals);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, liveSource: true, proxyRegion: 'Japan', sourceManifests: ['source/replay/manifest.json'], originalResources: resources, entries, bannerSources: [banner], formatChanges, handling: 'Direct current source archival without work-content or image-pixel screening. Preserve all 46 identities including No.00, full labels/comments, every displayed/hover image and actual source download URLs. Sample service-root placeholders are retained as source text, not actual downloads. Correct the source no9.html typo to the official no09.html; disable the documented missing final no46.html destination. No game packages downloaded.', desktopReview: 'pending' });
  console.log({ works: works.length, screenshots: works.reduce((s, w) => s + (w.ss?.length || 0), 0), downloadEntries: works.filter(w => w.download).length, metadataDifferenceNumbers: entries.filter(e => e.metadataDifferences.length).map(e => e.no), formatChanges });
}
main().catch(e => { console.error(e); process.exitCode = 1; });
