import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { imageExtension, writeJson } from './recover-entry-table';
import type { Festival, WorkEntry, WorkDownload } from '../src/lib/types';

const id = '2022-summer', root = `catch/${id}`, base = 'https://viprpg2022s.suppa.jp/';
type Capture = { originalUrl: string; actualUrl: string; status: number; file: string; sha256: string; kind: string; usable?: boolean };
const read = async <T,>(p: string): Promise<T> => JSON.parse(await fs.readFile(p, 'utf8'));
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const norm = (s: string) => s.normalize('NFKC').replace(/\s/g, '');

async function main() {
  const old = await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`);
  const pages = await read<Record<string, Capture>>(`${root}/source/live/manifest.json`);
  const assets = await read<Record<string, Capture>>(`${root}/source/resources/manifest.json`);
  const resources: Record<string, string> = {}, buffers = new Map<string, Buffer>(), replay: Record<string, unknown> = {};
  for (const [dir, manifest] of [['live', pages], ['resources', assets]] as const) {
    for (const cap of Object.values(manifest)) {
      if (cap.usable === false) continue;
      const b = await fs.readFile(`${root}/source/${dir}/${cap.file}`);
      if (cap.status !== 200 || cap.usable === false || hash(b) !== cap.sha256) throw new Error('Source capture failed verification');
      let local = new URL(cap.originalUrl).pathname.slice(1);
      if (cap.kind === 'asset') local = local.replace(/\.[^/.]+$/, `.${imageExtension(b)}`);
      resources[cap.originalUrl] = local;
      buffers.set(cap.originalUrl, b);
      replay[cap.originalUrl] = { ...cap, file: `../${dir}/${cap.file}` };
    }
  }
  resources[base] = 'index.html';
  resources[base.replace('https:', 'http:')] = 'index.html';
  const sanitize = (html: string) => {
    const q = cheerio.load(`<div class="source-comment">${html}</div>`);
    q('script,style,noscript,iframe,form,object,embed,link,meta').remove();
    q('*').each((_, e) => { for (const a of Object.keys(e.attribs)) if (a.startsWith('on') || ['id', 'style', 'width', 'height', 'align', 'bgcolor', 'color', 'face', 'size'].includes(a)) q(e).removeAttr(a); });
    q('img[src]').each((_, e) => { const url = new URL(q(e).attr('src')!, base).href, local = resources[url]; if (!local) throw new Error('Comment image absent'); q(e).attr('src', `/original-pages/${id}/${local}`); });
    q('a[href]').each((_, e) => { const u = new URL(q(e).attr('href')!, base), k = new URL(u); k.hash = ''; if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) q(e).removeAttr('href'); else q(e).attr('href', resources[k.href] ? `/original-pages/${id}/${resources[k.href]}${u.hash}` : u.href); });
    return q('body>div').toString();
  };
  const $ = cheerio.load(buffers.get(base + 'index.html')!), q = cheerio.load(buffers.get(base + 'entry.html')!);
  const works: WorkEntry[] = [], entries = [], titleDifferences = [], formatChanges = [];
  const media = async (url: string, folder: string, name: string) => {
    const b = buffers.get(url); if (!b) throw new Error('Source image absent');
    const ext = imageExtension(b), local = `/${folder}/${id}/${name}.${ext}`;
    if (path.extname(new URL(url).pathname).toLowerCase() !== `.${ext}`) formatChanges.push({ sourceUrl: url, actualExtension: ext });
    await fs.mkdir(path.dirname(`public${local}`), { recursive: true }); await fs.writeFile(`public${local}`, b);
    return { sourceUrl: url, local, sha256: hash(b) };
  };
  for (const article of q('article[id]').toArray()) {
    const no = q(article).attr('id')!.replace(/^id/, ''), previous = old.find(w => Number(w.no) === Number(no));
    if (!previous) throw new Error('Unknown source identity');
    const heading = q(article).find('h2').first().text().trim().replace(/^No\.\d+\s*/, '');
    const titleCell = $(`td.ti a[href="entry.html#id${no}"]`), catalogueTitle = titleCell.text().trim().replace(/^No\.\d+\s*/, '');
    if (titleCell.length !== 1 || norm(catalogueTitle) !== norm(previous.title) || norm(heading) !== norm(previous.title)) throw new Error('Source title not corroborated');
    const fields: Record<string, { text: string; html: string }> = {};
    q(article).find('h4').each((_, h) => {
      const label = q(h).text().trim().replace(/^【|】$/g, ''); let text = '', html = '';
      for (let n = h.nextSibling; n && !(n.type === 'tag' && ['h4', 'nav'].includes(n.name)); n = n.nextSibling) { text += q(n).text(); html += q.html(n); }
      fields[label] = { text: text.trim(), html };
    });
    const work: WorkEntry = { id: previous.id, festivalId: id, no: previous.no, title: previous.title, author: fields['作者名']?.text || '', source: { url: `${base}entry.html#id${no}`, titleUrl: `${base}index.html#link3` } };
    if (heading !== previous.title) { work.originalTitle = heading; titleDifferences.push({ no: work.no, title: work.title, originalTitle: heading, catalogueTitle, normalizedEquivalent: true }); }
    for (const [label, field] of [['ジャンル', 'category'], ['ツール', 'engine'], ['配信/投稿', 'streaming']] as const) if (fields[label]?.text) work[field] = fields[label].text;
    if (fields['作者コメント']?.text) work.authorComment = sanitize(fields['作者コメント'].html);
    if (fields['管理人コメント']?.text) work.hostComment = sanitize(fields['管理人コメント'].html);
    const row = titleCell.closest('tr'), catalogueGroup = row.add(row.next()).add(row.next().next());
    const downloadLinks: WorkDownload[] = [];
    for (const a of catalogueGroup.find('a[href]').toArray()) { const url = new URL($(a).attr('href')!, base).href; if (/drive\.google\.com\/uc\?|ux\.getuploader\.com\/viprpg2022s\/download\//.test(url) && !downloadLinks.some(d => d.url === url)) downloadLinks.push({ url, label: $(a).text().trim() }); if (url.includes('jbbs.shitaraba.net/bbs/read.cgi/')) work.forum = url; }
    if (downloadLinks.length) { work.downloads = downloadLinks; work.download = downloadLinks[0]; }
    const urls = new Set<string>();
    q(article).find('img[src]').each((_, e) => { urls.add(new URL(q(e).attr('src')!, base).href); for (const name of ['onmouseover', 'onmouseout']) for (const m of (q(e).attr(name) || '').matchAll(/(?:this\.)?src\s*=\s*['"]([^'"]+)/g)) urls.add(new URL(m[1], base).href); });
    const missingImages = [...urls].filter(url => !buffers.has(url));
    if (missingImages.length) work.sourceContent = '<p>［保存庫補記］原ページのマウスオーバー画像は未取得です。通常表示の保存済み画像を表示しています。</p>';
    const shots = []; for (const url of urls) if (buffers.has(url)) shots.push(await media(url, 'screenshots', `${work.no}-source-${shots.length + 1}`));
    if (shots.length) work.ss = shots.map(s => s.local);
    works.push(work); entries.push({ id: work.id, no: work.no, detailUrl: work.source!.url, sourceMetadata: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.text])), screenshotSources: shots, missingImageUrls: missingImages, cataloguePreviewUrl: new URL(row.find('img').attr('src')!, base).href, originalDownloadLinks: downloadLinks, sourceIconAbsent: true, packagesDownloaded: false });
  }
  if (works.length !== 23 || new Set(works.map(w => w.id)).size !== 23) throw new Error('Catalogue cardinality changed');
  const banner = await media(base + 's2022.png', 'banners', 'current-source');
  const festivals = await read<Festival[]>('src/data/festivals.json'); festivals.find(f => f.id === id)!.banners = [banner.local];
  await fs.mkdir(`${root}/source/replay`, { recursive: true }); await writeJson(`${root}/source/replay/manifest.json`, replay);
  await writeJson(`src/data/works/${id}.json`, works); await writeJson('src/data/festivals.json', festivals);
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, liveSource: true, proxyRegion: 'Japan', sourceManifests: ['source/replay/manifest.json'], originalResources: resources, entries, bannerSources: [banner], titleDifferences, formatChanges, handling: 'Direct source archival without work-content or image-pixel screening. Preserve all 23 identities including No.00; full source metadata, comments, actual displayed/hover images and source download URLs. Catalogue thumbnails are screenshots, not separate invented icons. Original empty TOP links are explicitly repaired in replay only. Game packages not downloaded.', desktopReview: 'pending' });
  console.log({ works: works.length, screenshots: works.reduce((s, w) => s + (w.ss?.length || 0), 0), downloadEntries: works.filter(w => w.download).length, titleDifferenceNumbers: titleDifferences.map(t => t.no), formatChanges });
}
main().catch(e => { console.error(e); process.exitCode = 1; });
