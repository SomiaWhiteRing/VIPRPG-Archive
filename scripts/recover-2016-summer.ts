import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { decodeSource, imageExtension, writeJson } from './recover-entry-table';
import type { Festival, WorkEntry } from '../src/lib/types';

const id='2016-summer',root=`catch/${id}`,base='http://www.geocities.jp/viprpgsun2016/',mainUrl=base+'viptop.html';
type Capture={originalUrl:string;snapshotUrl:string;file:string;status:number;sha256:string;cdxDigestMatches:boolean;cdxDigest:string};
const read=async<T,>(p:string):Promise<T>=>JSON.parse(await fs.readFile(p,'utf8'));
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const norm=(s:string)=>s.normalize('NFKC').replace(/\s/g,'');
const inline=(s:string)=>s.replace(/[\u00a0\u200b]/g,' ').replace(/\s+/g,' ').trim();
const markers=['作者：','作者名：','ジャンル：','ジャンル；','《ジャンル》：','配信：','公開：','公開；','配信＆公開：','《作品の配信許可／動画公開許可》','ツクール：','感想はコチラ'];
const firstMarker=(s:string)=>Math.min(s.length,...markers.map(m=>s.indexOf(m)).filter(n=>n>=0));
const field=(s:string,labels:string[])=>{const label=labels.find(l=>s.includes(l));if(!label)return '';const rest=s.slice(s.indexOf(label)+label.length);return inline(rest.slice(0,firstMarker(rest)));};
const canon=(s:string,owner=mainUrl)=>{const u=new URL(s,owner);if(['geocities.jp','www.geocities.jp'].includes(u.hostname)&&u.pathname.startsWith('/viprpgsun2016/')){u.hostname='www.geocities.jp';u.protocol='http:';u.port='';}return u.href;};

async function main(){
  const old=await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`),pages=await read<Record<string,Capture>>(`${root}/source/archive/manifest.json`),assets=await read<Record<string,Capture>>(`${root}/source/resources/manifest.json`),documents=new Map<string,string>(),buffers=new Map<string,Buffer>(),resources:Record<string,string>={},replay:Record<string,unknown>={};
  if(old.length!==50||old.some(w=>w.contentRestricted))throw new Error('Identity/restriction scope changed');
  await fs.mkdir(`${root}/source/replay/generated`,{recursive:true});
  for(const[dir,captures]of [['archive',pages],['resources',assets]]as const)for(const c of Object.values(captures)){
    const b=await fs.readFile(`${root}/source/${dir}/${c.file}`);if(c.status!==200||!c.cdxDigestMatches||hash(b)!==c.sha256)throw new Error('Unverified source capture');
    const local=dir==='archive'?(new URL(c.originalUrl).pathname.slice(new URL(base).pathname.length)||'index.html'):`assets/${c.file.replace(/\.bin$/,'.'+imageExtension(b))}`;resources[c.originalUrl]=local;
    if(dir==='archive')documents.set(c.originalUrl,decodeSource(b,'utf-8'));else{buffers.set(c.originalUrl,b);replay[c.originalUrl]={...c,file:`../resources/${c.file}`};}
  }
  const sanitize=(s:string)=>{const q=cheerio.load(`<div>${s}</div>`);q('script,style,form,iframe,object,embed').remove();q('*').each((_,e)=>{for(const a of Object.keys(e.attribs))if(a.startsWith('on'))q(e).removeAttr(a);});q('img[src]').each((_,e)=>{const u=canon(q(e).attr('src')!);if(!resources[u])throw new Error('Inline source image unavailable');q(e).attr('src',`/original-pages/${id}/${resources[u]}`);});q('a[href]').each((_,e)=>{const value=q(e).attr('href')!;if(!value.startsWith('#'))q(e).attr('href',canon(value));});return q('body>div').html()?.trim()||'';};
  const media=async(u:string,name:string)=>{const url=canon(u),b=buffers.get(url);if(!b)throw new Error('Image source not captured '+name);const local=`/screenshots/${id}/${name}.${imageExtension(b)}`;await fs.mkdir(path.dirname('public'+local),{recursive:true});await fs.writeFile('public'+local,b);return{local,sourceUrl:url,sha256:hash(b)};};
  const d=cheerio.load(documents.get(mainUrl)!),tables=d('body>table').toArray(),works:WorkEntry[]=[],entries=[];if(tables.length!==50)throw new Error('Source catalogue count');
  for(const t of tables){
    const cells=d(t).children('tbody').children('tr').first().children('td'),rows=cells.eq(1).find('table').first().find('tr'),metaCell=rows.first().find('td').first(),meta=inline(metaCell.text()),prefix=meta.match(/^エントリー\s*NO\s*([^：:]+)[:：]\s*/i);if(!prefix)throw new Error('Source number prefix missing');
    const sourceNo=prefix[1].trim(),number=sourceNo.normalize('NFKC'),no=number==='EX'?'EX':number==='XI'?'11':number.padStart(2,'0'),previous=old.find(w=>w.no===no);if(!previous)throw new Error('Unknown source identity '+no);const rest=meta.slice(prefix[0].length),title=inline(rest.slice(0,firstMarker(rest)));if(norm(title)!==norm(previous.title))throw new Error('Unresolved source title '+no);
    const work:WorkEntry={id:previous.id,festivalId:id,no:previous.no,title:previous.title,author:field(meta,['作者：','作者名：']),category:field(meta,['ジャンル：','ジャンル；','《ジャンル》：']),engine:field(meta,['ツクール：']),source:{url:mainUrl,snapshotUrl:pages[mainUrl].snapshotUrl}},combined=field(meta,['配信＆公開：','《作品の配信許可／動画公開許可》']);work.streaming=combined||[field(meta,['配信：']),field(meta,['公開：','公開；'])].filter(Boolean).join('／');
    const comments:Record<string,string>={};rows.slice(1).each((_,r)=>{const cell=d(r).find('td').first(),text=cell.text().trim(),label=text.match(/^(作者によるコメント|管理人による一言|管理人によるコメント)/)?.[1];if(!label)throw new Error('Unrecognized comment label '+no);const value=sanitize((cell.html()||'').replace(new RegExp(label+'((?:\\s*<[^>]+>)*\\s*)[：:；]?'),'$1'));if(label==='作者によるコメント'){work.authorComment=value;comments.author=value;}else{work.hostComment=value;comments.host=value;}});
    if(no==='39')for(const key of ['authorComment','hostComment']as const){if(!work[key])continue;const q=cheerio.load(work[key]!);q('pre').wrap('<div data-source-pre-scroll style="max-width:100%;overflow-x:auto"></div>');work[key]=q('body').html()||'';}
    const primary=cells.eq(0).find('img[src]').first().attr('src');if(!primary)throw new Error('Missing primary preview '+no);const sourceImages=[canon(primary)],gallery=cells.eq(2).find('a[href]').first().attr('href');let gallerySource:string|undefined;
    if(gallery){const u=new URL(canon(gallery));gallerySource=u.origin+u.pathname;const html=documents.get(gallerySource);if(!html)throw new Error('Screenshot page missing '+no);const g=cheerio.load(html),fragment=decodeURIComponent(u.hash.slice(1)),a=g('a[name]').filter((_,e)=>g(e).attr('name')===fragment);if(a.length!==1)throw new Error('Screenshot anchor mismatch '+no);a.closest('table').find('img[src]').each((_,img)=>sourceImages.push(canon(g(img).attr('src')!,gallerySource)));}
    cells.eq(2).find('img[src]').each((_,img)=>sourceImages.push(canon(d(img).attr('src')!)));const shots=[],seen=new Set<string>(),aliases=[];for(const u of [...new Set(sourceImages)]){const b=buffers.get(u);if(!b)throw new Error('Source screenshot missing '+no);const sha=hash(b);if(seen.has(sha)){aliases.push({sourceUrl:u,sha256:sha});continue;}seen.add(sha);shots.push(await media(u,`${no}-source-${shots.length+1}`));}work.ss=shots.map(s=>s.local);
    // The source uses a clickable320x240 download preview, not a separate game icon.
    work.icon=shots[0].local;
    const downloads=[...new Set(cells.eq(0).find('a[href]').map((_,e)=>canon(d(e).attr('href')!)).get())].map(url=>({url,label:'原サイトの配布先'}));if(downloads.length){work.downloads=downloads;work.download=downloads[0];}const forum=metaCell.find('a[href*="jbbs.shitaraba.net"]').first().attr('href');if(forum)work.forum=forum;
    works.push(work);entries.push({id:work.id,no,sourceNo,sourceUrl:mainUrl,snapshotUrl:pages[mainUrl].snapshotUrl,sourceMetadataHtml:metaCell.html(),commentFields:Object.keys(comments),primaryPreviewSource:canon(primary),directoryThumbnailRole:'Source download preview, also preserved as a screenshot; no separate source game icon.',gallerySource,screenshotSources:shots,byteIdenticalImageAliases:aliases,downloadLinks:downloads,packagesDownloaded:false});
  }
  for(const c of Object.values(pages)){
    const q=cheerio.load(documents.get(c.originalUrl)!);q('script,noscript,base').remove();q('meta[charset]').attr('charset','utf-8');q('meta[http-equiv]').each((_,e)=>{if(q(e).attr('http-equiv')?.toLowerCase()==='content-type')q(e).attr('content','text/html; charset=utf-8');});q('form').each((_,e)=>q(e).replaceWith(q(e).contents()));q('input,textarea,select').attr('disabled','disabled');
    q('[src],[href],[background]').each((_,e)=>{for(const a of ['src','href','background']){const u=q(e).attr(a);if(u&&!/^(data:|javascript:|#|mailto:)/i.test(u))q(e).attr(a,canon(u,c.originalUrl));}});
    if(c.originalUrl===mainUrl)q('body>table').each((i,t)=>q(t).attr('id','archive-entry-'+entries[i].no));
    const local=resources[c.originalUrl],file='generated/'+local;await fs.writeFile(`${root}/source/replay/${file}`,q.html());replay[c.originalUrl]={...c,file,sourceRawFile:`../archive/${c.file}`,sourceRawSha256:c.sha256,sha256:hash(q.html()),sourceKind:'derived-static-replay'};
  }
  const banners=[];for(const[name,u]of [['source-1','vipsun2016b.png'],['source-2','vipsun2016b2.png']]){const url=base+u,b=buffers.get(url);if(!b)throw new Error('Banner missing');const local=`/banners/${id}/${name}.${imageExtension(b)}`;await fs.mkdir(path.dirname('public'+local),{recursive:true});await fs.writeFile('public'+local,b);banners.push({local,sourceUrl:url,sha256:hash(b)});}const festivals=await read<Festival[]>('src/data/festivals.json');festivals.find(f=>f.id===id)!.banners=banners.map(b=>b.local);
  await writeJson(`${root}/source/replay/manifest.json`,replay);await writeJson(`src/data/works/${id}.json`,works);await writeJson('src/data/festivals.json',festivals);await writeJson(`${root}/recovery.json`,{festivalId:id,originalBase:base,entryPage:'index.html',liveSource:false,originalResources:resources,entries,bannerSources:banners,sourceManifests:['source/replay/manifest.json'],handling:'Archive source bytes directly without topic or pixel review. Preserve EX and01-49 identities, original Roman XI for11 in provenance, source preview/gallery roles, and every available comment. Source download previews double as directory thumbnails; no separate game icon invented. Game packages are not downloaded or executed.',desktopReview:'pending'});
  console.log({works:works.length,screenshots:works.reduce((n,w)=>n+(w.ss?.length||0),0),sourceImages:buffers.size,authorComments:works.filter(w=>w.authorComment).length,hostComments:works.filter(w=>w.hostComment).length});
}
main().catch(e=>{console.error(e);process.exitCode=1;});
