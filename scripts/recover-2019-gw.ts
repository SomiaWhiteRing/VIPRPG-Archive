import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { imageExtension, writeJson } from './recover-entry-table';
import type { Festival, WorkEntry, WorkDownload } from '../src/lib/types';

const id='2019-gw',root=`catch/${id}`,base='https://viprpg2019gw.xxxxxxxx.jp/';
type Capture={originalUrl:string;file:string;status:number;sha256:string;kind:string};
const read=async<T,>(p:string):Promise<T>=>JSON.parse(await fs.readFile(p,'utf8'));
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const norm=(s:string)=>s.normalize('NFKC').replace(/\s/g,'');
const abs=(u:string)=>new URL(u,base).href;

async function main(){
  const old=await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`),pages=await read<Record<string,Capture>>(`${root}/source/live/manifest.json`),assets=await read<Record<string,Capture>>(`${root}/source/resources/manifest.json`);
  const resources:Record<string,string>={},buffers=new Map<string,Buffer>(),replay:Record<string,unknown>={};
  for(const[dir,manifest]of [['live',pages],['resources',assets]]as const)for(const cap of Object.values(manifest)){
    const b=await fs.readFile(`${root}/source/${dir}/${cap.file}`);if(cap.status!==200||hash(b)!==cap.sha256)throw new Error('Unresolved source payload');
    const u=new URL(cap.originalUrl);let local=u.hostname===new URL(base).hostname?decodeURIComponent(u.pathname.slice(1))||'index.html':`vendor/${path.posix.basename(u.pathname)}`;
    if(cap.kind==='asset')local=local.replace(/\.[^/.]+$/,'.'+imageExtension(b));
    resources[cap.originalUrl]=local;buffers.set(cap.originalUrl,b);replay[cap.originalUrl]={...cap,file:`../${dir}/${cap.file}`};
  }
  const sanitize=(html:string)=>{const q=cheerio.load(`<div>${html}</div>`);q('script,style,noscript,iframe,form,object,embed,link,meta').remove();q('*').each((_,e)=>{for(const a of Object.keys(e.attribs))if(a.startsWith('on')||['id','style','align','bgcolor','color','face','size'].includes(a)||(['width','height'].includes(a)&&e.tagName!=='img'))q(e).removeAttr(a);});q('img[src]').each((_,e)=>{const u=abs(q(e).attr('src')!);if(!resources[u])throw new Error('Uncaptured inline image');q(e).attr('src',`/original-pages/${id}/${resources[u]}`);});q('a[href]').each((_,e)=>{const u=new URL(q(e).attr('href')!,base);if(!['http:','https:','mailto:'].includes(u.protocol))q(e).removeAttr('href');else q(e).attr('href',u.href);});return q('body>div').toString();};
  const escape=(s:string)=>{const q=cheerio.load('<span></span>');return q('span').text(s).html()!;};
  const lines=(html:string)=>{const q=cheerio.load(`<div>${html}</div>`);q('br').replaceWith('\n');return q('body>div').text().split('\n').map(x=>x.trim()).filter(Boolean);};
  const media=async(u:string,folder:string,name:string)=>{const b=buffers.get(u);if(!b)throw new Error('Missing image payload');const local=`/${folder}/${id}/${name}.${imageExtension(b)}`;await fs.mkdir(path.dirname('public'+local),{recursive:true});await fs.writeFile('public'+local,b);return{sourceUrl:u,local,sha256:hash(b)};};
  const q=cheerio.load(buffers.get(base)!),rows=q('table.table-condensed tr').filter((_,r)=>q(r).children().length===7&&/^\d+$/.test(q(r).children().first().text().trim())),works:WorkEntry[]=[],entries=[];
  for(const row of rows.toArray()){
    const cells=q(row).children(),no=cells.eq(0).text().trim().padStart(2,'0'),previous=old.find(w=>Number(w.no)===Number(no)),link=cells.eq(2).find('a[href]').first(),titleLines=lines(link.html()||''),title=titleLines[0],genreLines=lines(cells.eq(3).html()||''),url=abs(link.attr('href')!),cap=pages[url];if(!cap||!previous||norm(previous.title)!==norm(title))throw new Error(`Source identity mismatch: ${no}`);
    const d=cheerio.load(buffers.get(url)!),table=d('table.table-bordered'),trs=table.children('tbody,thead,tfoot').children('tr'),heading=trs.eq(0).children().eq(1).text().trim(),detailTitle=heading.replace(/^No\.\d+[\s　]*/,''),fields:Record<string,{text:string;html:string}>={};
    table.find('td').each((_,e)=>{const text=d(e).text().trim(),m=text.match(/^【(作者名|使用ツール|ジャンル|配信\/投稿|作者コメント|管理人コメント)】([\s\S]*)$/);if(m)fields[m[1]]={text:m[2].trim(),html:(d(e).html()||'').replace(new RegExp(`^\\s*【${m[1]}】\\s*(?:<br\\s*\\/?>)?`),'')};});
    const catalogue={author:titleLines.slice(1).join(' '),category:genreLines[0]||'',engine:genreLines.slice(1).join(' '),streaming:cells.eq(5).text().trim()},work:WorkEntry={id:previous.id,festivalId:id,no:previous.no,title:previous.title,author:catalogue.author||fields['作者名']?.text||'',source:{url,titleUrl:base}};
    if(detailTitle!==work.title)work.originalTitle=detailTitle;
    if(catalogue.category||fields['ジャンル']?.text)work.category=catalogue.category||fields['ジャンル'].text;
    if(catalogue.engine||fields['使用ツール']?.text)work.engine=catalogue.engine||fields['使用ツール'].text;
    if(catalogue.streaming||fields['配信/投稿']?.text)work.streaming=catalogue.streaming||fields['配信/投稿'].text;
    if(fields['作者コメント']?.text)work.authorComment=sanitize(fields['作者コメント'].html);if(fields['管理人コメント']?.text)work.hostComment=sanitize(fields['管理人コメント'].html);
    const iconUrl=abs(cells.eq(1).find('img').attr('src')!);work.icon=(await media(iconUrl,'icons',`${no}-source`)).local;
    const shotUrls=new Set<string>();trs.eq(1).find('img[src]').each((_,i)=>{shotUrls.add(abs(d(i).attr('src')!));for(const a of ['onmouseover','onmouseout'])for(const m of(d(i).attr(a)||'').matchAll(/this\.src\s*=\s*['"]([^'"]+)/g))shotUrls.add(abs(m[1]));});const shots=[];for(const u of shotUrls)shots.push(await media(u,'screenshots',`${no}-source-${shots.length+1}`));if(shots.length)work.ss=shots.map(s=>s.local);
    const dl:WorkDownload[]=[];cells.eq(4).find('a[href]').each((_,a)=>{const href=q(a).attr('href')!;if(!href)return;const u=abs(href);if(!dl.some(x=>x.url===u))dl.push({url:u,label:q(a).text().trim()});});trs.eq(8).find('a[href]').each((_,a)=>{const href=d(a).attr('href')!,label=d(a).text().trim();if(!href||!/^ダウンロード|^【DL/.test(label))return;const u=abs(href);if(!dl.some(x=>x.url===u))dl.push({url:u,label:'原紹介ページ：'+label});});if(dl.length){work.downloads=dl;work.download=dl[0];}const forum=cells.eq(6).find('a[href]').attr('href');if(forum)work.forum=abs(forum);
    const differences=[];for(const[label,value]of [['作者名',catalogue.author],['ジャンル',catalogue.category],['使用ツール',catalogue.engine],['配信/投稿',catalogue.streaming]])if(value&&norm(value)!==norm(fields[label]?.text||''))differences.push({label,catalogue:value,detail:fields[label]?.text||''});if(differences.length)work.sourceContent=sanitize(differences.map(x=>`<p><strong>原紹介ページの${escape(x.label)}</strong><br>${escape(x.detail||'未記載')}</p>`).join('\n'));
    works.push(work);entries.push({id:work.id,no,detailUrl:url,catalogue,detailTitle,sourceMetadata:Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v.text])),metadataDifferences:differences,iconSourceUrl:iconUrl,screenshotSources:shots,downloadLinks:dl,packagesDownloaded:false});
  }
  if(works.length!==38||new Set(works.map(w=>w.id)).size!==38)throw new Error('Source catalogue count changed');
  const banners=[];for(const u of ['banner/GW19.png','banner/GW19_2.png'])banners.push(await media(abs(u),'banners',`source-${banners.length+1}`));const festivals=await read<Festival[]>('src/data/festivals.json');festivals.find(f=>f.id===id)!.banners=banners.map(b=>b.local);
  await fs.mkdir(`${root}/source/replay`,{recursive:true});await writeJson(`${root}/source/replay/manifest.json`,replay);await writeJson(`src/data/works/${id}.json`,works);await writeJson('src/data/festivals.json',festivals);await writeJson(`${root}/recovery.json`,{festivalId:id,originalBase:base,liveSource:true,proxyRegion:'Japan',originalResources:resources,sourceManifests:['source/replay/manifest.json'],entries,bannerSources:banners,handling:'Official source address confirmed from captured 2021 GW historical link. Preserve all 38 source records including sakuhin sample, original screenshot roles and both comments. No topic or pixel screening; no game packages downloaded or executed.',desktopReview:'pending'});
  console.log({works:works.length,screenshots:works.reduce((s,w)=>s+(w.ss?.length||0),0),downloads:works.filter(w=>w.download).length,banners:banners.length});
}
main().catch(e=>{console.error(e);process.exitCode=1;});
