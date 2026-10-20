import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { imageExtension, writeJson } from './recover-entry-table';
import type { Festival, WorkEntry, WorkDownload } from '../src/lib/types';

const id = '2022-gw', root = `catch/${id}`, base = 'http://viprpg2022gw.nobody.jp/';
type Capture = { originalUrl: string; actualUrl: string; status: number; file: string; sha256: string; kind: string; usable?: boolean };
type Row = { no: string; id: string; title: string; author: string; category: string; engine: string; streaming: string; detailUrl: string; iconUrl: string; downloads: WorkDownload[]; forumUrl: string; downloadStatusHtml?: string };
const read = async <T,>(p: string): Promise<T> => JSON.parse(await fs.readFile(p, 'utf8'));
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const norm = (s: string) => s.normalize('NFKC').replace(/\s/g, '');
const native = (b: Buffer) => /<svg[\s>]/i.test(b.subarray(0, 1000).toString()) ? 'svg' : imageExtension(b);

async function main() {
  const rows = await read<Row[]>(`${root}/investigation/catalogue-rows.json`), old = await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`), details = await read<Array<{ no: string; screenshotUrls: string[] }>>(`${root}/investigation/detail-structure.json`);
  const live = await read<Record<string, Capture>>(`${root}/source/live/manifest.json`), assets = await read<Record<string, Capture>>(`${root}/source/resources/manifest.json`), buffers = new Map<string, Buffer>(), resources: Record<string, string> = {}, replay: Record<string, unknown> = {}, formatChanges = [];
  for (const [directory, captures] of [['live',live],['resources',assets]] as const) for (const cap of Object.values(captures)) {
    const b = await fs.readFile(`${root}/source/${directory}/${cap.file}`); if (cap.status !== 200 || cap.usable === false || hash(b) !== cap.sha256) throw new Error('Unverified source capture');
    let local = new URL(cap.originalUrl).pathname.slice(1) || 'index.html';
    if (cap.kind === 'asset') { const actual = native(b), original = path.posix.extname(local).slice(1).toLowerCase(); if (actual !== original && !(actual === 'jpg' && original === 'jpeg')) formatChanges.push({ sourceUrl: cap.originalUrl, original, actual }); local = local.replace(/\.[^.]+$/, `.${actual}`); }
    buffers.set(cap.originalUrl,b); resources[cap.originalUrl]=local; resources[cap.actualUrl]=local;
    replay[cap.originalUrl]={...cap,file:`../${directory}/${cap.file}`,sourceKind:directory};
  }
  resources[`${base}index.html`]='index.html';
  const sanitize=(html:string,owner:string)=>{
    const q=cheerio.load(`<div class="source-comment">${html}</div>`);q('script,style,noscript,iframe,form,object,embed,link,meta').remove();
    q('*').each((_,e)=>{for(const a of Object.keys(e.attribs))if(a.startsWith('on')||['id','style','width','height','align','bgcolor','background','color','face','size'].includes(a))q(e).removeAttr(a);});
    q('img[src]').each((_,e)=>{const url=new URL(q(e).attr('src')!,owner).href,local=resources[url];if(!local)throw new Error('Comment image not captured');q(e).attr('src',`/original-pages/${id}/${local}`);});
    q('a[href]').each((_,e)=>{const u=new URL(q(e).attr('href')!,owner),k=new URL(u);k.hash='';if(!['http:','https:','mailto:'].includes(u.protocol))q(e).removeAttr('href');else q(e).attr('href',resources[k.href]?`/original-pages/${id}/${resources[k.href]}${u.hash}`:u.href);});
    return q('body>div').toString();
  };
  const media=async(url:string,folder:string,name:string)=>{const b=buffers.get(url);if(!b)throw new Error('Source media absent');const local=`/${folder}/${id}/${name}.${native(b)}`;await fs.mkdir(path.dirname(`public${local}`),{recursive:true});await fs.writeFile(`public${local}`,b);return{sourceUrl:url,local,sha256:hash(b)};};
  const works:WorkEntry[]=[],entries=[];
  for(const row of rows){
    const previous=old.find(w=>w.id===row.id);if(!previous||previous.title!==row.title||previous.no!==row.no)throw new Error('Existing identity changed');
    const q=cheerio.load(buffers.get(row.detailUrl)!),fields:Record<string,string>={},metadata:Record<string,string>={};
    q('h4').each((_,e)=>{const label=q(e).text().trim().replace(/^【|】$/g,''),nodes=q(e).nextUntil('h4');fields[label]=nodes.map((_,n)=>q.html(n)).get().join('\n');metadata[label]=nodes.text().trim();});
    if(!norm(q('h2').first().text()).includes(norm(row.title)))throw new Error('Detail heading does not corroborate catalogue');
    const work:WorkEntry={id:previous.id,festivalId:id,no:previous.no,title:previous.title,author:row.author,category:row.category,engine:row.engine,streaming:row.streaming,forum:row.forumUrl,source:{url:row.detailUrl,titleUrl:base}};
    if(metadata['作者コメント'])work.authorComment=sanitize(fields['作者コメント'],row.detailUrl);
    if(metadata['管理人コメント'])work.hostComment=sanitize(fields['管理人コメント'],row.detailUrl);
    const supplements=[],differences=[];
    if(fields['作者・管理人コメント'])supplements.push('<h4>【作者・管理人コメント】</h4>'+fields['作者・管理人コメント']);
    for(const[label,value]of [['作者名',row.author],['ジャンル',row.category],['ツール',row.engine],['配信/投稿',row.streaming]])if(norm(value||'')!==norm(metadata[label]||'')){differences.push({label,catalogue:value,detail:metadata[label]});supplements.push(`<h4>【${label}（詳細ページ）】</h4>${fields[label]||''}`);}
    if(row.downloadStatusHtml)supplements.push('<h4>【DL/更新日】</h4>'+row.downloadStatusHtml);
    if(supplements.length)work.sourceContent=sanitize(supplements.join('\n'),row.detailUrl);
    work.icon=(await media(row.iconUrl,'icons',`${row.no.padStart(2,'0')}-source`)).local;
    const sources=[];for(const url of details.find(d=>d.no===row.no)!.screenshotUrls)sources.push(await media(url,'screenshots',`${row.no.padStart(2,'0')}-source-${sources.length+1}`));
    if(sources.length)work.ss=sources.map(s=>s.local);
    if(row.downloads.length){work.downloads=row.downloads;work.download=row.downloads[0];}
    works.push(work);entries.push({id:work.id,no:row.no,detailUrl:row.detailUrl,sourceMetadata:metadata,catalogueMetadata:{author:row.author,category:row.category,engine:row.engine,streaming:row.streaming},metadataDifferences:differences,combinedCommentPreserved:!!fields['作者・管理人コメント'],iconSourceUrl:row.iconUrl,screenshotSources:sources,downloadLinks:row.downloads,packagesDownloaded:false});
  }
  if(works.length!==34||new Set(works.map(w=>w.id)).size!==34)throw new Error('Catalogue cardinality changed');
  const banners=[],bannerSources=[];for(const name of ['gw2022a.png','gw2022b.png']){const url=new URL(name,base).href,b=buffers.get(url)!;const local=`/banners/${id}-source-${banners.length+1}.${native(b)}`;await fs.writeFile(`public${local}`,b);banners.push(local);bannerSources.push({sourceUrl:url,local,sha256:hash(b)});}
  const festivals=await read<Festival[]>('src/data/festivals.json');festivals.find(f=>f.id===id)!.banners=banners;
  await fs.mkdir(`${root}/source/replay`,{recursive:true});await writeJson(`${root}/source/replay/manifest.json`,replay);
  await writeJson(`src/data/works/${id}.json`,works);await writeJson('src/data/festivals.json',festivals);
  await writeJson(`${root}/recovery.json`,{festivalId:id,originalBase:base,liveSource:true,proxyRegion:'Japan',sourceManifests:['source/replay/manifest.json'],originalResources:resources,entries,bannerSources,formatChanges,handling:'Direct source archival without content, keyword or image-pixel screening. Preserve the source 0-33 catalogue and every displayed/hover screenshot URL without natural-size filtering. Keep No.0 combined author/organizer comment under its actual combined label. Catalogue/detail metadata differences and source DL/update status remain explicit. Download URLs are copied from source; no game packages downloaded.',desktopReview:'pending'});
  console.log(JSON.stringify({works:works.length,screenshots:works.reduce((s,w)=>s+(w.ss?.length||0),0),downloadEntries:works.filter(w=>w.download).length,metadataDifferenceRows:entries.filter(e=>e.metadataDifferences.length).map(e=>e.no),formatChanges}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
