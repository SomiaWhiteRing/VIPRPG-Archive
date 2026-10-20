import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { decodeSource, imageExtension, writeJson } from './recover-entry-table';
import type { Festival, WorkEntry, WorkDownload } from '../src/lib/types';

const id='2019-kouhaku',root=`catch/${id}`,base='https://kohakuviprpg2019.x.2nt.com/',list=base+'list/';
type Capture={originalUrl:string;file:string;status:number;sha256:string;kind:string;expectedBytes?:number};
const read=async<T,>(p:string):Promise<T>=>JSON.parse(await fs.readFile(p,'utf8'));
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const norm=(s:string)=>s.normalize('NFKC').replace(/\s/g,'');

async function main(){
  const old=await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`),pages=await read<Record<string,Capture>>(`${root}/source/live/manifest.json`),assets=await read<Record<string,Capture>>(`${root}/source/resources/manifest.json`);
  const resources:Record<string,string>={},buffers=new Map<string,Buffer>(),replay:Record<string,unknown>={};
  for(const[dir,manifest]of [['live',pages],['resources',assets]]as const)for(const cap of Object.values(manifest)){
    const b=await fs.readFile(`${root}/source/${dir}/${cap.file}`);if((cap.status!==200&&!(cap.status===206&&b.length===cap.expectedBytes))||hash(b)!==cap.sha256)throw new Error('Unresolved source payload');
    let local=decodeURIComponent(new URL(cap.originalUrl).pathname.slice(1))||'index.html';if(local.endsWith('/'))local+='index.html';if(cap.kind==='asset')local=local.replace(/\.[^/.]+$/,'.'+imageExtension(b));
    resources[cap.originalUrl]=local;buffers.set(cap.originalUrl,b);replay[cap.originalUrl]={...cap,file:`../${dir}/${cap.file}`};
  }
  const sanitize=(html:string,owner:string)=>{const q=cheerio.load(`<div>${html}</div>`);q('script,style,noscript,iframe,form,object,embed,link,meta').remove();q('*').each((_,e)=>{for(const a of Object.keys(e.attribs))if(a.startsWith('on')||['id','style','align','bgcolor','color','face','size'].includes(a)||(['width','height'].includes(a)&&!['img','video','audio'].includes(e.tagName)))q(e).removeAttr(a);});q('img[src],video[src],audio[src],source[src]').each((_,e)=>{const u=new URL(q(e).attr('src')!,owner).href;if(!resources[u])throw new Error('Uncaptured inline source image');q(e).attr('src',`/original-pages/${id}/${resources[u]}`);});q('a[href]').each((_,e)=>{const u=new URL(q(e).attr('href')!,owner);if(!['http:','https:','mailto:'].includes(u.protocol))q(e).removeAttr('href');else q(e).attr('href',resources[u.href]?`/original-pages/${id}/${resources[u.href]}`:u.href);});return q('body>div').toString();};
  const media=async(u:string,folder:string,name:string)=>{const b=buffers.get(u);if(!b)throw new Error('Missing image payload');const local=`/${folder}/${id}/${name}.${imageExtension(b)}`;await fs.mkdir(path.dirname('public'+local),{recursive:true});await fs.writeFile('public'+local,b);return{sourceUrl:u,local,sha256:hash(b)};};
  const q=cheerio.load(decodeSource(buffers.get(list)!,'shift_jis')),works:WorkEntry[]=[],entries=[];
  const make=async(url:string,no:string,variant?:string,card?:cheerio.Cheerio<Element>)=>{
    const d=cheerio.load(decodeSource(buffers.get(url)!,'shift_jis')),previous=variant?undefined:old.find(w=>Number(w.no)===Number(no)),key=variant?`sample-${variant}`:no;
    const title=variant?q(`a[href="no_0${variant==='2'?'_2':''}.html"]`).text().trim():card!.find('.name b a').text().trim();if(previous&&norm(previous.title)!==norm(title))throw new Error(`Catalogue title mismatch ${no}`);
    const metadata=d('.ran').first(),metadataText=metadata.text().trim(),fields:Record<string,string>={};for(const m of metadataText.matchAll(/【([^】]+)】([\s\S]*?)(?=【|$)/g))fields[m[1]]=m[2].trim();
    const work:WorkEntry={id:previous?.id||`${id}-work-00-sample-${variant}`,festivalId:id,no:previous?.no||'0',title:previous?.title||title,author:card?.find('.author p').text().trim()||fields['名前']||'',source:{url,titleUrl:list}},detailTitle=d('.title').first().text().trim().replace(/^No\.\s*\d+\s*-\s*/, '');if(detailTitle!==work.title)work.originalTitle=detailTitle;
    const genre=card?.find('.genre').text().trim()||fields['ジャンル'],engine=card?.find('.tkool').text().trim()||fields['ツクール'];if(genre)work.category=genre;if(engine)work.engine=engine;
    const groupSrc=card?.find('.kumiwake img').attr('src');if(groupSrc){const filename=path.posix.basename(groupSrc);if(filename==='akagumi.png')work.group='紅組';else if(filename==='sirogumi.png')work.group='白組';else throw new Error('Unknown explicit source group icon');}
    const streamingLabel=Object.keys(fields).find(k=>k.includes('配信'));if(streamingLabel)work.streaming=`${streamingLabel}：${fields[streamingLabel]}`;
    const author=d('.ran').filter((_,e)=>d(e).text().trim().startsWith('【コメント】')),host=d('.ran').filter((_,e)=>d(e).text().trim().startsWith('【管理人コメント】'));if(author.length!==1||host.length!==1)throw new Error('Ambiguous comment structure');
    work.authorComment=sanitize((author.html()||'').replace('【コメント】',''),url);work.hostComment=sanitize((host.html()||'').replace('【管理人コメント】',''),url);work.sourceContent=sanitize('<p><strong>原紹介ページの基本情報</strong></p>'+(metadata.html()||''),url);
    const mediaLinks=new Set<string>();d('video[src],audio[src],source[src]').each((_,e)=>mediaLinks.add(new URL(d(e).attr('src')!,url).href));if(mediaLinks.size)work.sourceContent+=sanitize([...mediaLinks].map(u=>'<p><a href="'+u+'">原紹介ページの動画・音声資料</a></p>').join(''),url);
    const iconUrl=new URL(card?.find('.icon img').attr('src')||d('.title img').first().attr('src')!,card?list:url).href;work.icon=(await media(iconUrl,'icons',key+'-source')).local;
    const shotUrls=new Set<string>();d('div.tyuuou img[src]').filter((_,i)=>!d(i).closest('.title,.ran,.link').length&&!/^(?:time_|downlord_)/.test(path.posix.basename(d(i).attr('src')!))).each((_,i)=>{shotUrls.add(new URL(d(i).attr('src')!,url).href);for(const attr of ['onmouseover','onmouseout'])for(const m of(d(i).attr(attr)||'').matchAll(/this\.src\s*=\s*['"]([^'"]+)/g))shotUrls.add(new URL(m[1],url).href);});const shots=[];for(const u of shotUrls)shots.push(await media(u,'screenshots',`${key}-source-${shots.length+1}`));if(shots.length)work.ss=shots.map(x=>x.local);
    d('div.tyuuou a[href]').filter((_,a)=>!d(a).closest('.title,.link').length).each((_,a)=>{const u=new URL(d(a).attr('href')!,url);if(/\.(png|jpe?g|gif|bmp)$/i.test(u.pathname)&&!shotUrls.has(u.href))shotUrls.add(u.href);});
    for(const u of [...shotUrls].slice(shots.length))shots.push(await media(u,'screenshots',`${key}-source-${shots.length+1}`));if(shots.length)work.ss=shots.map(x=>x.local);
    const downloads:WorkDownload[]=[];if(card)card.find('.downlord a[href]').each((_,a)=>{const href=q(a).attr('href')!,label=q(a).text().trim();if(!href||href.startsWith('#'))return;const u=new URL(href,list);if(u.hostname==='jbbs.shitaraba.net')work.forum=u.href;else if(!downloads.some(x=>x.url===u.href))downloads.push({url:u.href,label:label||'原一覧の配布リンク'});});if(downloads.length){work.downloads=downloads;work.download=downloads[0];}
    works.push(work);entries.push({id:work.id,no:work.no,sampleVariant:variant,detailUrl:url,sourceNumber:d('title').text(),sourceMetadata:fields,sourceGroupIcon:groupSrc?new URL(groupSrc,list).href:undefined,iconSourceUrl:iconUrl,screenshotSources:shots,authorTextLength:author.text().trim().replace(/^【コメント】/,'').length,hostTextLength:host.text().trim().replace(/^【管理人コメント】/,'').length,downloadLinks:downloads,packagesDownloaded:false});
  };
  await make(list+'no_0.html','0','1');await make(list+'no_0_2.html','0','2');for(const card of q('.tyuuou2,.tyuuou3').toArray()){const no=q(card).find('.number').text().match(/\d+/)?.[0];if(!no)throw new Error('Source number absent');await make(new URL(q(card).find('.name b a').attr('href')!,list).href,no.padStart(2,'0'),undefined,q(card));}
  if(works.length!==57||new Set(works.map(w=>w.id)).size!==57)throw new Error('Catalogue cardinality changed');
  const banners=[];for(const u of ['img/2019banner1.png','img/2019banner2.png'])banners.push(await media(base+u,'banners',`source-${banners.length+1}`));
  const festivals=await read<Festival[]>('src/data/festivals.json'),festival=festivals.find(f=>f.id===id)!;festival.banners=banners.map(b=>b.local);if(!festival.columns.includes('group'))festival.columns.splice(festival.columns.indexOf('type')+1,0,'group');if(!festival.columns.includes('streaming'))festival.columns.splice(festival.columns.indexOf('group')+1,0,'streaming');
  await fs.mkdir(`${root}/source/replay`,{recursive:true});await writeJson(`${root}/source/replay/manifest.json`,replay);await writeJson(`src/data/works/${id}.json`,works);await writeJson('src/data/festivals.json',festivals);await writeJson(`${root}/recovery.json`,{festivalId:id,originalBase:base,liveSource:true,proxyRegion:'Japan',sourceEncoding:'shift_jis',originalResources:resources,sourceManifests:['source/replay/manifest.json'],entries,bannerSources:banners,handling:'Direct archival without topic or pixel screening. Preserve all55 original catalogue identities and both explicitly linked sample variants; both samples retain their original No.0 and distinct source-link titles. Genre and red/white group are separate fields. Retain full comments, source metadata, inline illustrations and declared screenshot roles. No game packages downloaded or executed.',desktopReview:'pending'});
  console.log({works:works.length,formal:55,samples:2,screenshots:works.reduce((s,w)=>s+(w.ss?.length||0),0),downloads:works.filter(w=>w.download).length});
}
main().catch(e=>{console.error(e);process.exitCode=1;});
