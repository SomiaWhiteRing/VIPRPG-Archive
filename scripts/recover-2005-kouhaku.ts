import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import sharp from 'sharp';
import { decodeSource, imageExtension, writeJson } from './recover-entry-table';
import type { WorkEntry, WorkDownload } from '../src/lib/types';

const id = '2005-kouhaku', root = `catch/${id}`, base = 'http://vipkouhaku05.cs.land.to/';
type Capture = { originalUrl:string; requestedUrl:string; timestamp:string; file:string; sha256:string; cdxDigestVerified:boolean };
const read = async <T,>(file:string):Promise<T> => JSON.parse(await fs.readFile(file,'utf8'));
const normalize = (value:string) => value.normalize('NFKC').replace(/\s/g,'');

async function main() {
  const manifest = await read<Record<string,Capture>>(`${root}/source/archive/manifest.json`);
  const resources = new Map(Object.values(manifest).map(capture => [new URL(capture.originalUrl).href,capture]));
  for (const capture of resources.values()) {
    const bytes = await fs.readFile(`${root}/source/archive/${capture.file}`);
    if (!capture.cdxDigestVerified || createHash('sha256').update(bytes).digest('hex') !== capture.sha256) throw new Error('Unverified source cache');
  }
  const catalogue = resources.get(base)!;
  const html = decodeSource(await fs.readFile(`${root}/source/archive/${catalogue.file}`),'shift_jis');
  if (html.includes('\uFFFD')) throw new Error('Unresolved source encoding');
  const $ = cheerio.load(html), anchors = $('a[href]').toArray().filter(a => /\.zip$/i.test($(a).attr('href')!));
  const index = await read<{rows:string[][]}>(`${root}/investigation/scoped-cdx.json`);
  const legacy = await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`);
  const works:WorkEntry[] = [], entries = [], imageGaps = [], packageSources = [];
  for (const anchor of anchors) {
    const tr = $(anchor).closest('tr'), text = tr.text(), label = normalize(text).match(/No\.(\d+)(紅組|白組)/);
    if (!label || tr.find('img[src]').length !== 1) throw new Error('Source row is not a unique numbered work');
    const no = String(Number(label[1])).padStart(2,'0'), title = $(anchor).text().trim().replace(/\s+/g,' '), old = legacy.find(work => work.no === no);
    const work:WorkEntry = { id:`${id}-work-${no}`,festivalId:id,no,title:old && normalize(old.title) === normalize(title) ? old.title : title,author:'',group:label[2],source:{url:base,snapshotUrl:catalogue.requestedUrl,titleUrl:catalogue.requestedUrl} };
    if (normalize(work.title) !== normalize(title)) work.originalTitle = title;
    const imageUrl = new URL(tr.find('img[src]').attr('src')!,base).href;
    if (Number(new URL(imageUrl).pathname.match(/kouhaku_(\d+)/)?.[1]) !== Number(no)) throw new Error('Screenshot number differs from source row');
    const image = resources.get(imageUrl), screenshotSources = [];
    if (!image) imageGaps.push({no,originalUrl:imageUrl});
    else {
      const bytes = await fs.readFile(`${root}/source/archive/${image.file}`), extension = imageExtension(bytes), size = await sharp(bytes).metadata(), local = `/screenshots/${id}/${no}-1.${extension}`;
      await fs.mkdir(path.dirname(`public${local}`),{recursive:true});
      await fs.writeFile(`public${local}`,bytes);
      work.ss = [local];
      screenshotSources.push({local,width:size.width,height:size.height,...image});
    }
    const originalZip = new URL($(anchor).attr('href')!,base).href;
    const indexed = index.rows.slice(1).find(row => new URL(row[0]).href === originalZip && row[3] === 'application/zip');
    const downloads:WorkDownload[] = [];
    if (indexed) {
      downloads.push({url:`https://web.archive.org/web/${indexed[1]}id_/${indexed[0]}`,label:'Wayback ZIP',filename:path.posix.basename(new URL(originalZip).pathname)});
      packageSources.push({no,originalUrl:originalZip,timestamp:indexed[1],digest:indexed[4],bytesDownloaded:false});
    }
    downloads.push({url:originalZip,label:'Source ZIP',filename:path.posix.basename(new URL(originalZip).pathname)});
    work.downloads = downloads;
    work.download = downloads[0];
    const textCell = $(anchor).closest('td');
    if (!normalize(textCell.text()).includes(normalize(title))) throw new Error('Work metadata cell mismatch');
    const content = cheerio.load(`<div>${textCell.html() ?? ''}</div>`);
    content('script,noscript,style,iframe,form,object,embed,img,link,meta').remove();
    content('*').each((_,element) => { for(const attribute of Object.keys(element.attribs)) if(attribute.startsWith('on') || ['style','width','height','align','bgcolor','background','color','face','size'].includes(attribute)) content(element).removeAttr(attribute); });
    content('a[href]').each((_,a) => { const url = new URL(content(a).attr('href')!,base).href; content(a).attr('href',url === originalZip ? downloads[0].url : url); });
    if (!normalize(content('body').text()).includes(normalize(title))) throw new Error('Source row text was lost during normalization');
    work.sourceContent = content('body').html()?.trim();
    works.push(work);
    entries.push({no,group:work.group,sourceRowTitleMatchesLegacy:!!old && normalize(old.title) === normalize(title),sourceUrl:base,snapshotUrl:catalogue.requestedUrl,sourceCharacters:text.trim().length,screenshotSources,originalDownloadUrl:originalZip});
  }
  if (works.length !== 26 || new Set(works.map(work=>work.no)).size !== 26 || packageSources.length !== 26) throw new Error('Catalogue or package-index coverage mismatch');
  const header = $('img[src]').first();
  if (header.parents('a').length) throw new Error('Header image is an external event link');
  const headerUrl = new URL(header.attr('src')!,base).href, capture = resources.get(headerUrl)!;
  const bytes = await fs.readFile(`${root}/source/archive/${capture.file}`), extension = imageExtension(bytes), size = await sharp(bytes).metadata(), local = `/banners/${id}-source.${extension}`;
  await fs.writeFile(`public${local}`,bytes);
  const promotions = $('img[src]').toArray().filter(img => $(img).parents('a').length).map(img => ({sourceUrl:new URL($(img).attr('src')!,base).href,target:$(img).parents('a').first().attr('href')}));
  await writeJson(`${root}/investigation/header-provenance.json`,{catalogue,siteTitle:$('title').text().trim(),headerSource:headerUrl,headerIsFirstImage:true,headerHasNoLink:true,width:size.width,height:size.height,promotions,note:'Use the actual header of the archived page titled VIPRPG紅白2005. Preserve the source filename even though it contains 2009; do not infer ownership solely from the filename.'});
  const festivals = await read<Array<{id:string;banners:string[];columns:string[]}>>('src/data/festivals.json');
  const festival = festivals.find(festival=>festival.id===id)!;
  festival.banners = [local];
  festival.columns = ['no','work','group','download'];
  await writeJson('src/data/festivals.json',festivals);
  await writeJson(`src/data/works/${id}.json`,works);
  await writeJson(`${root}/investigation/original-timemap.bin`,[['original','first','last'],...Object.values(manifest).map(capture=>[capture.originalUrl,capture.timestamp,capture.timestamp])]);
  await writeJson(`${root}/recovery.json`,{festivalId:id,originalBase:base,sourceLayout:'single-page download catalogue with inline screenshots',catalogueEntries:works.length,catalogueCapture:catalogue,entries,imageGaps,sourceDetailGaps:[],individualIntroductionLinksObserved:0,sourceFieldsUnconfirmed:['author','engine','streaming'],packageSources,banner:{local,sourceUrl:headerUrl,width:size.width,height:size.height,capture},sourceEvidence:[`${root}/investigation/live-index-probe.json`,`${root}/investigation/live-resource-probes.json`,`${root}/investigation/scoped-cdx.json`,`${root}/investigation/archive-retrieval.json`,`${root}/investigation/source-row-structure.json`,`${root}/investigation/header-provenance.json`],handling:'The original is one catalogue page, not 26 missing individual introductions. Reconstruct local detail views from each observed row and its screenshot. Preserve original numbering and explicit red/white groups; do not infer authors or genres. Archive original bytes without content screening. Historical ZIP records are present, but package bytes were not downloaded or validated.',desktopReview:'pending'});
  console.log(JSON.stringify({works:works.length,screenshots:entries.reduce((sum,e)=>sum+e.screenshotSources.length,0),imageGaps:imageGaps.length,indexedPackages:packageSources.length}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
