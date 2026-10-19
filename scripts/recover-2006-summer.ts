import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import sharp from 'sharp';
import { decodeSource, imageExtension, writeJson } from './recover-entry-table';
import type { WorkEntry, WorkDownload } from '../src/lib/types';

const id = '2006-summer', root = `catch/${id}`, base = 'http://www.geocities.jp/gavumu/';
type Capture = { originalUrl: string; requestedUrl: string; timestamp: string; file: string; sha256: string; cdxDigestVerified: boolean };
type Candidate = { no: number; title: string; titleSource: string; sourceUrl: string; snapshotUrl: string; titleUrl?: string; forum?: string; originalTitle?: string };
const read = async <T,>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, 'utf8'));
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s/g, '');
const canonicalTitle = (value: string) => normalize(value).replace(/[^\p{L}\p{N}]/gu, '');
const localPath = (url: string) => new URL(url).pathname.slice('/gavumu/'.length);

async function main() {
  const manifest = await read<Record<string, Capture>>(`${root}/source/original-archive/manifest.json`);
  const byPath = new Map(Object.values(manifest).map(capture => [localPath(capture.originalUrl), capture]));
  const documents = [];
  for (const capture of Object.values(manifest)) {
    const bytes = await fs.readFile(`${root}/source/original-archive/${capture.file}`);
    if (!capture.cdxDigestVerified || createHash('sha256').update(bytes).digest('hex') !== capture.sha256) throw new Error('Unverified source cache');
    if (/\.htm$/.test(capture.originalUrl)) {
      const text = decodeSource(bytes, 'shift_jis');
      if (text.includes('\uFFFD')) throw new Error(`Unresolved encoding: ${capture.originalUrl}`);
      documents.push({ sourcePath: localPath(capture.originalUrl), replacementCharacters: 0 });
    }
  }
  const document = async (capture: Capture) => cheerio.load(decodeSource(await fs.readFile(`${root}/source/original-archive/${capture.file}`), 'shift_jis'));
  const candidates = await read<Candidate[]>(`${root}/investigation/catalogue-candidate-rows.json`);
  if (candidates.length !== 33 || candidates.some((row, index) => row.no !== index + 1)) throw new Error('Incomplete numbered source inventory');
  const legacy = await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`);
  const forumCapture = Object.values(await read<Record<string, Capture>>(`${root}/source/forum-archive/manifest.json`))[0];
  const forumBytes = await fs.readFile(`${root}/source/forum-archive/${forumCapture.file}`);
  if (!forumCapture.cdxDigestVerified || createHash('sha256').update(forumBytes).digest('hex') !== forumCapture.sha256) throw new Error('Forum source not verified');
  const $forum = cheerio.load(decodeSource(forumBytes, 'shift_jis'));
  const subjects = $forum('a[href]').toArray().filter(a => /\/test\/read.cgi\/natu\//.test($forum(a).attr('href')!)).map(a => ({ title: $forum(a).text().trim(), url: new URL($forum(a).attr('href')!, forumCapture.originalUrl).href }));
  const index = await read<{ rows: string[][] }>(`${root}/investigation/original-scoped-cdx.json`);
  const mirrorManifest = await read<Record<string, Capture>>(`${root}/source/archive/manifest.json`);
  const works: WorkEntry[] = [], entries = [], imageGaps = [], packageSources = [], titleReview = [];
  for (const row of candidates) {
    const no = String(row.no).padStart(2, '0'), sourcePath = `ss${row.no}.htm`, capture = byPath.get(sourcePath);
    if (!capture || new URL(row.sourceUrl).href !== new URL(capture.originalUrl).href) throw new Error('Candidate source identity mismatch');
    const $ = await document(capture), body = $('body').clone();
    body.find('script,noscript,style').remove();
    body.find('br').replaceWith('\n');
    body.find('p,div,pre,td,tr,li').each((_, element) => { $(element).prepend('\n').append('\n'); });
    const text = body.text(), sourceText = normalize(text);
    const titleConfirmed = row.titleSource === 'official-discussion-subject' ? subjects.some(subject => {
      const numbers = [...subject.title.normalize('NFKC').matchAll(/No\s*[.．:]?\s*(\d{1,2})(?!\d)/gi)].map(match => Number(match[1]));
      return subject.url === row.forum && normalize(subject.title).includes(normalize(row.title)) && (numbers.length ? numbers.includes(row.no) : sourceText.includes(normalize(row.title)));
    }) : row.titleSource === 'original-detail-title-line' ? !!row.originalTitle && sourceText.includes(normalize(row.originalTitle)) && canonicalTitle(row.originalTitle) === canonicalTitle(row.title) : sourceText.includes(normalize(row.title));
    if (row.title && !titleConfirmed) throw new Error(`Title provenance not reproducible: ${no}`);
    if (!row.title && row.no !== 20) throw new Error(`Unresolved title: ${no}`);
    if (row.no === 30) {
      const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const start = lines.findIndex(line => line.includes('ゲームタイトル'));
      const end = lines.findIndex((line, index) => index > start && line.includes('ゲームの簡単な説明'));
      if (start < 0 || end <= start + 1 || normalize(lines.slice(start + 1, end).join('')) !== normalize(row.title)) throw new Error('No.30 title field is incomplete');
    }
    const old = legacy.find(work => Number(work.no) === row.no);
    const preserveLegacyTitle = !!old?.title && old.title === row.title;
    const work: WorkEntry = { id: `${id}-work-${no}`, festivalId: id, no, title: row.title || 'No.20（題名未確認）', author: old?.author ?? '', source: { url: capture.originalUrl, snapshotUrl: capture.requestedUrl, titleUrl: row.titleUrl ?? capture.requestedUrl } };
    if (row.forum) work.forum = `https://web.archive.org/web/${forumCapture.timestamp}/${row.forum}`;
    else if (old?.forum) work.forum = old.forum;
    if (row.originalTitle) work.originalTitle = row.originalTitle;
    const authorLabels = new Set(['ハンドルネーム','ハンドル','ペンネーム','hn','夏の陣参加希望したhn','作者名','作者','作者の名前','製作者名','製作者','制作者名','制作者','お名前','名前']);
    const sourceLines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const descriptionStart = sourceLines.findIndex(line => /ゲームの簡単な説明|ゲームの説明|^[^\p{L}\p{N}]*説明[\s：:]/u.test(line));
    const authorLimit = descriptionStart < 0 ? Math.min(5, sourceLines.length) : descriptionStart;
    let authorFound = false;
    for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex++) {
      const line = sourceLines[lineIndex], colon = line.search(/[：:]/);
      if (colon < 0) continue;
      const label = canonicalTitle(line.slice(0, colon));
      if (!authorLabels.has(label) || (['名前','お名前'].includes(label) && lineIndex >= authorLimit)) continue;
      const value = line.slice(colon + 1).trim();
      if (value) { work.author = value; authorFound = true; break; }
    }
    if (!authorFound) for (let lineIndex = 0; lineIndex < authorLimit; lineIndex++) {
      const line = sourceLines[lineIndex];
      const match = line.match(/^[^\p{L}\p{N}]*(?:ハンドルネーム|ハンドル|ペンネーム|[HＨhｈ][.．・･]?[NＮnｎ][.．]?|製作者名|製作者|制作者名|制作者|作者名|作者|お名前|名前)[\s：:=＝\]】)）>＞]*([^\s].*)?$/u);
      if (!match) continue;
      const next = sourceLines[lineIndex + 1] ?? '';
      const value = match[1]?.trim() || (!/ゲームタイトル|ゲーム名|タイトル|説明/.test(next) ? next : '');
      if (value) { work.author = value; break; }
    }
    if (work.author && !sourceText.includes(normalize(work.author))) throw new Error(`Author provenance not reproducible: ${no}`);
    const screenshots = [], screenshotSources = [];
    for (const img of $('img[src]').toArray()) {
      const url = new URL($(img).attr('src')!, capture.originalUrl);
      if (url.hostname !== new URL(base).hostname || !url.pathname.startsWith('/gavumu/')) continue;
      const resource = byPath.get(localPath(url.href));
      if (!resource) { imageGaps.push({ no, originalUrl: url.href }); continue; }
      const bytes = await fs.readFile(`${root}/source/original-archive/${resource.file}`), metadata = await sharp(bytes).metadata();
      if ((metadata.width ?? 0) < 200 || (metadata.height ?? 0) < 200) continue;
      const extension = imageExtension(bytes), local = `/screenshots/${id}/${no}-${screenshots.length + 1}.${extension}`;
      await fs.mkdir(path.dirname(`public${local}`), { recursive: true });
      await fs.writeFile(`public${local}`, bytes);
      screenshots.push(local);
      screenshotSources.push({ local, width: metadata.width, height: metadata.height, ...resource });
    }
    if (screenshots.length) work.ss = screenshots;
    const downloads: WorkDownload[] = [];
    $('a[href]').each((_, anchor) => {
      const url = new URL($(anchor).attr('href')!, capture.originalUrl);
      if (!/\.zip$/i.test(url.pathname)) return;
      const archive = index.rows.slice(1).find(row => new URL(row[0]).href === url.href);
      if (archive) {
        downloads.push({ url: `https://web.archive.org/web/${archive[1]}id_/${archive[0]}`, label: 'Wayback ZIP' });
        packageSources.push({ no, originalUrl: archive[0], timestamp: archive[1], digest: archive[4], bytesDownloaded: false });
      }
      downloads.push({ url: url.href, label: 'Source ZIP' });
    });
    const mirrorCapture = mirrorManifest[`https://vipkohaku.x.fc2.com/2006s/${sourcePath}`];
    if (mirrorCapture) {
      const mirror = cheerio.load(decodeSource(await fs.readFile(`${root}/source/archive/${mirrorCapture.file}`), 'shift_jis'));
      mirror('a[href]').each((_, anchor) => {
        const url = new URL(mirror(anchor).attr('href')!, mirrorCapture.originalUrl);
        if (/\.zip$/i.test(url.pathname) || /drive\.google\.com|box\.yahoo\.co\.jp/.test(url.hostname)) downloads.push({ url: url.href, label: /patch|sabun/i.test(url.pathname) ? 'patch' : 'Mirror download' });
      });
    }
    const uniqueDownloads = downloads.filter((download, index, all) => all.findIndex(other => other.url === download.url) === index);
    if (uniqueDownloads.length) { work.downloads = uniqueDownloads; work.download = uniqueDownloads.find(download => !download.label?.startsWith('patch')); }
    $('script,noscript,style,iframe,form,object,embed,img,link,meta').remove();
    $('*').each((_, element) => { for (const attr of Object.keys(element.attribs)) if (attr.startsWith('on') || ['background','bgcolor','color','face','size','align','nowrap','style','width','height'].includes(attr)) $(element).removeAttr(attr); });
    $('a[href]').each((_, anchor) => {
      const url = new URL($(anchor).attr('href')!, capture.originalUrl), detail = url.pathname.match(/^\/gavumu\/ss(\d+)\.htm$/);
      const sameSite = url.hostname === new URL(base).hostname && url.pathname.startsWith('/gavumu/');
      const archivedPage = sameSite && /\.htm$/i.test(url.pathname) && (byPath.has(localPath(url.href)) || localPath(url.href) === 'no6patti.htm');
      $(anchor).attr('href', sameSite && detail ? `/works/${id}-work-${String(Number(detail[1])).padStart(2,'0')}` : archivedPage ? `/original-pages/${id}/${localPath(url.href)}${url.search}${url.hash}` : url.href);
    });
    work.sourceContent = $('body').html()?.trim();
    works.push(work);
    entries.push({ no, sourcePath, capture, sourceCharacters: text.trim().length, screenshotSources, titleSource: row.titleSource, ...(row.no === 20 ? { metadataUnavailable: ['title','author'], sourceHasNoImageReference: true } : {}) });
    titleReview.push({ no, titleSource: row.titleSource, legacyTitlePreserved: preserveLegacyTitle, originalTitleRecorded: !!work.originalTitle, titleUnconfirmed: !row.title });
  }
  const banner = byPath.get('uenohou.jpg')!, bannerBytes = await fs.readFile(`${root}/source/original-archive/${banner.file}`), bannerExtension = imageExtension(bannerBytes), bannerLocal = `/banners/${id}-original.${bannerExtension}`, bannerMetadata = await sharp(bannerBytes).metadata();
  await fs.writeFile(`public${bannerLocal}`, bannerBytes);
  const festivals = await read<Array<{ id: string; banners: string[]; columns: string[] }>>('src/data/festivals.json');
  const festival = festivals.find(festival => festival.id === id)!;
  festival.banners = [bannerLocal];
  festival.columns = ['no','work','download','forum'];
  await writeJson('src/data/festivals.json', festivals);
  await writeJson(`src/data/works/${id}.json`, works);
  await writeJson(`${root}/investigation/verified-document-encodings.json`, documents);
  await writeJson(`${root}/investigation/title-provenance-review.json`, titleReview);
  await writeJson(`${root}/investigation/original-timemap.bin`, [['original','first','last'], ...Object.values(manifest).map(capture => [capture.originalUrl,capture.timestamp,capture.timestamp])]);
  const patchEvidence = await read<{ originalUrl: string; queryUrl: string; followedReplay: { status: number; requestedUrl: string } }>(`${root}/investigation/patch-page-source-evidence.json`);
  if (patchEvidence.followedReplay.status !== 404) throw new Error('Patch page evidence needs reconciliation');
  const unavailableSourcePages = [{ sourcePath: 'no6patti.htm', sourceUrl: patchEvidence.originalUrl, evidence: `${root}/investigation/patch-page-source-evidence.json` }];
  const failures = [{ sourceUrl: patchEvidence.originalUrl, requestedUrl: patchEvidence.followedReplay.requestedUrl, error: 'The checked exact CDX records and nearest replay return HTTP 404; no recovered patch page. This does not establish global absence.' }];
  const metadataGaps = works.filter(work => !work.author || work.no === '20').map(work => ({ no:work.no, fields:[...(work.no === '20' ? ['title'] : []), ...(!work.author ? ['author'] : [])], sourceUrl:work.source!.url, note:work.no === '20' ? 'The numbered source contains a short note, no title field and no image reference. Its title and author remain unconfirmed.' : 'A structured author value was not confirmed. Preserve the full original source text without guessing an attribution.' }));
  await writeJson(`${root}/recovery.json`, { festivalId: id, originalBase: base, numberedSourcePages: 33, namedEntries: 32, currentMenuLinks: 22, legacyEntries: 23, entries, imageGaps, sourceDetailGaps: [], unavailableSourcePages, failures, metadataGaps, packageSources, banner: { local:bannerLocal, sourcePath: 'uenohou.jpg', sourcePosition: { top:0, left:0 }, width:bannerMetadata.width, height:bannerMetadata.height, capture:banner }, sourceEvidence: [`${root}/investigation/original-origin-evidence.json`,`${root}/investigation/final-original-resource-verification.json`,`${root}/investigation/catalogue-reconciliation.json`,`${root}/investigation/title-provenance-review.json`,`${root}/investigation/forum-title-provenance.json`,`${root}/investigation/legacy-id-map.json`,`${root}/investigation/no30-title-reconstruction.json`,`${root}/investigation/forum-number-map.json`,`${root}/source/forum-archive/manifest.json`,`${root}/investigation/header-image-position-evidence.json`,`${root}/investigation/author-field-inventory.json`,`${root}/investigation/prior-missing-screenshot-recovery.json`], handling:'Reconcile all 33 archived numbered pages, including unlinked historical introductions. Archive original bytes and source content directly without screening. Preserve known legacy names where corroborated by source text; retain a labelled metadata gap for No.20. Historical ZIP bytes were not downloaded or validated.', desktopReview:'pending' });
  console.log(JSON.stringify({ entries:works.length, namedEntries:32, screenshots:entries.reduce((sum,entry)=>sum+entry.screenshotSources.length,0), imageGaps:imageGaps.length }));
}
main().catch(error => { console.error(error); process.exitCode=1; });
