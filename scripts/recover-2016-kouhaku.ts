import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { decodeSource, imageExtension, writeJson } from './recover-entry-table';
import type { Festival, WorkEntry, WorkDownload } from '../src/lib/types';

const id='2016-kouhaku',root=`catch/${id}`,base='https://viprpgkohaku2016.wixsite.com/kohaku2016';
type Capture={originalUrl:string;actualUrl:string;file:string;status:number;sha256:string;contentType?:string;seo?:string;snapshotUrl?:string};
type Props={uri?:string;url?:string;slidesProps?:Array<{id:string}>;fillLayers?:{image?:{uri?:string}}};
type Feature={structure:{components:Record<string,{componentType:string;pageId:string}>};props:{render:{compProps:Record<string,Props>}}};
const read=async<T,>(p:string):Promise<T>=>JSON.parse(await fs.readFile(p,'utf8'));
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const norm=(s:string)=>s.normalize('NFKC').replace(/\s/g,'');
const canon=(s:string,owner=base)=>new URL(s,owner).href.replace(/^http:\/\/(static\.wixstatic\.com|viprpgkohaku2016\.wixsite\.com)/,'https://$1').replace(/^(https:\/\/static\.wixstatic\.com\/media\/[^/]+)\/v1\/[\s\S]*$/,'$1');
const mediaUrl=(uri:string)=>canon(/^https?:/.test(uri)?uri:uri.startsWith('wix:image://')?`https://static.wixstatic.com/media/${uri.split('/')[3]}`:`https://static.wixstatic.com/media/${uri}`);

async function main(){
  const old=await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`),live=await read<Record<string,Capture>>(`${root}/source/live/manifest.json`),assets=await read<Record<string,Capture>>(`${root}/source/resources/manifest.json`),features=await read<Record<string,Capture>>(`${root}/source/features/manifest.json`),catalogue=await read<Array<{no:string;title:string;detailUrl:string;iconUrl:string;preview:string;catalogueEmbed:string}>>(`${root}/investigation/current-catalogue.json`);
  if(catalogue.length!==71||old.some(w=>w.contentRestricted))throw new Error('Catalogue/restriction scope changed');
  const resources:Record<string,string>={},replay:Record<string,unknown>={},buffers=new Map<string,Buffer>(),documents=new Map<string,string>(),featureBySeo=new Map<string,Feature>(),featureById=new Map<string,Feature>();
  await fs.mkdir(`${root}/source/replay/generated`,{recursive:true});
  for(const c of Object.values(features)){const b=await fs.readFile(`${root}/source/features/${c.file}`);if(hash(b)!==c.sha256)throw new Error('Feature checksum');const f=JSON.parse(b.toString());featureBySeo.set(c.seo||'master',f);featureById.set(c.file.replace(/\.json$/,''),f);}
  for(const c of Object.values(assets)){
    const b=await fs.readFile(`${root}/source/resources/${c.file}`);if(c.status!==200||hash(b)!==c.sha256)throw new Error('Asset checksum');buffers.set(c.originalUrl,b);
    const type=c.contentType||'',suffix=path.posix.extname(new URL(c.originalUrl).pathname).slice(1),ext=type.includes('text/css')?'css':/^(woff2?|ttf|eot|otf|svg)$/.test(suffix)?suffix:type.includes('svg')?'svg':imageExtension(b),local=`assets/${c.file.replace(/\.bin$/,'.'+ext)}`;
    resources[c.originalUrl]=local;replay[c.originalUrl]={...c,file:`../resources/${c.file}`};
  }
  for(const c of Object.values(live)){
    if(c.status!==200)throw new Error('Unresolved HTML response');const b=await fs.readFile(`${root}/source/live/${c.file}`);if(hash(b)!==c.sha256)throw new Error('HTML checksum');documents.set(c.originalUrl,decodeSource(b,'utf-8'));
    const local=c.originalUrl===base?'index.html':new URL(c.originalUrl).hostname==='viprpgkohaku2016.wixsite.com'?`pages/${new URL(c.originalUrl).pathname.split('/').pop()}.html`:`embedded/${c.file.replace(/\.bin$/,'.html')}`;
    resources[c.originalUrl]=local;if(c.originalUrl.startsWith(base))resources[c.originalUrl.replace('https:','http:')]=local;
  }
  resources[base+'/']='index.html';resources[base.replace('https:','http:')+'/']='index.html';
  const rewriteAttributes=(q:cheerio.CheerioAPI,owner:string)=>{
    q('[src],[href],[background]').each((_,e)=>{for(const a of ['src','href','background']){const value=q(e).attr(a);if(value&&!/^(data:|#|javascript:|mailto:)/i.test(value))q(e).attr(a,canon(value,owner));}});
    q('img').removeAttr('srcset loading');q('style,[style]').each((_,e)=>{const attr=e.tagName==='style'?undefined:'style',s=attr?q(e).attr(attr)||'':q(e).text(),value=s.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/g,(_,u)=>u.startsWith('data:')?`url(${u})`:`url("${canon(u,owner)}")`);if(attr)q(e).attr(attr,value);else q(e).text(value);});
  };
  const slideshowScript=`document.querySelectorAll('[data-archive-slides]').forEach(function(box){var images=JSON.parse(box.getAttribute('data-archive-slides')),image=box.querySelector('[data-testid="slidesWrapper"] img'),index=0,dots=Array.from(box.querySelectorAll('nav li a')),active=Array.from(dots[0]?.classList||[]).filter(function(c){return !dots[1]?.classList.contains(c)});function show(n){index=(n+images.length)%images.length;image.src=images[index];dots.forEach(function(d,i){d.parentElement.setAttribute('aria-current',String(i===index));active.forEach(function(c){d.classList.toggle(c,i===index)});});}var prev=box.querySelector('[data-testid="prevButton"]'),next=box.querySelector('[data-testid="nextButton"]');if(prev)prev.onclick=function(){show(index-1)};if(next)next.onclick=function(){show(index+1)};dots.forEach(function(d,i){d.onclick=function(e){e.preventDefault();show(i)}});show(0);});`;
  const sourceSlides:Array<{page:string;container:string;images:string[]}>=[],externalFrames:Array<{page:string;url:string}>=[];
  for(const c of Object.values(live)){
    const q=cheerio.load(documents.get(c.originalUrl)!),outer=new URL(c.originalUrl).hostname==='viprpgkohaku2016.wixsite.com',pageId=q('style[id^="css_"]').map((_,e)=>q(e).attr('id')!.slice(4)).get().find(k=>featureById.has(k)&&k!=='masterPage'),feature=pageId?featureById.get(pageId):undefined;
    q('script,noscript,base,link[rel="preload"],link[rel="prefetch"],link[rel="preconnect"]').remove();q('meta[charset]').attr('charset','utf-8');q('meta[http-equiv]').each((_,e)=>{if(q(e).attr('http-equiv')?.toLowerCase()==='content-type')q(e).attr('content','text/html; charset=utf-8');});
    q('form').each((_,e)=>q(e).replaceWith(q(e).contents()));q('input,textarea,select').attr('disabled','disabled');q('[onclick],[onload],[onsubmit]').removeAttr('onclick onload onsubmit');
    if(outer){
      for(const f of [featureBySeo.get('master'),feature].filter((f):f is Feature=>!!f))for(const[compId,v]of Object.entries(f.structure.components)){
        const props=f.props.render.compProps[compId]||{},node=q('#'+compId);if(!node.length)continue;
        if(v.componentType==='HtmlComponent'&&props.url){if(!resources[props.url])throw new Error('Missing HTML component '+compId);node.html('<iframe data-archive-component title="保存された原資料" style="width:100%;height:100%;border:0;display:block"></iframe>');node.find('iframe').attr('src',props.url);}
        if(v.componentType==='SlideShowContainer'&&props.slidesProps){const images=props.slidesProps.map(p=>f.props.render.compProps[p.id]?.fillLayers?.image?.uri).filter((u):u is string=>!!u).map(mediaUrl);if(images.length){node.attr('data-archive-slides',JSON.stringify(images.map(u=>`/original-pages/${id}/${resources[u]}`)));node.find('[data-testid="slidesWrapper"] img').first().attr('src',images[0]);sourceSlides.push({page:resources[c.originalUrl],container:compId,images});}}
      }
      q('#comp-ivknmte0').text('原文：日本語');q('#comp-ivv4baae').text('保存資料');
      if(q('[data-archive-slides]').length)q('body').append(`<script data-archive-slide-controls>${slideshowScript}</script>`);
    }
    q('iframe[src]').each((_,e)=>{const u=canon(q(e).attr('src')!,c.originalUrl);if(!resources[u]){externalFrames.push({page:resources[c.originalUrl],url:u});const p=q('<p data-archive-external-frame>［外部資料］</p>');p.append(q('<a target="_blank" rel="noopener noreferrer">原ページを開く</a>').attr('href',u));q(e).replaceWith(p);}});
    rewriteAttributes(q,c.originalUrl);if(!outer)q('a[href]').each((_,e)=>{const u=q(e).attr('href')!,local=resources[u];if(local&&(local==='index.html'||local.startsWith('pages/')))q(e).attr({'data-archive-source-nav':'',target:'_parent'});});const local=resources[c.originalUrl],file=`generated/${local}`;await fs.mkdir(path.dirname(`${root}/source/replay/${file}`),{recursive:true});await fs.writeFile(`${root}/source/replay/${file}`,q.html());replay[c.originalUrl]={...c,file,sourceRawFile:`../live/${c.file}`,sourceRawSha256:c.sha256,sha256:hash(q.html()),sourceKind:'derived-source-layout'};
  }
  const media=async(u:string,folder:string,name:string)=>{const url=canon(u),b=buffers.get(url);if(!b)throw new Error('Missing media '+name);const local=`/${folder}/${id}/${name}.${imageExtension(b)}`;await fs.mkdir(path.dirname('public'+local),{recursive:true});await fs.writeFile('public'+local,b);return{local,sourceUrl:url,sha256:hash(b)};};
  const sanitize=(s:string,owner:string)=>{const q=cheerio.load(`<div>${s}</div>`);q('script,style,iframe,object,embed,form,link').remove();q('*').each((_,e)=>{for(const a of Object.keys(e.attribs))if(a.startsWith('on'))q(e).removeAttr(a);});rewriteAttributes(q,owner);q('img[src]').each((_,e)=>{const u=q(e).attr('src')!;if(!resources[u])throw new Error('Inline image missing');q(e).attr('src',`/original-pages/${id}/${resources[u]}`);});return q('body>div').html()?.trim()||'';};
  const works:WorkEntry[]=[],entries=[];
  for(const entry of catalogue){
    const previous=old.find(w=>w.no===entry.no);if(!previous||norm(previous.title)!==norm(entry.title))throw new Error('Unresolved title identity '+entry.no);const url=canon(entry.detailUrl),seo=new URL(url).pathname.split('/').pop()!,f=featureBySeo.get(seo);if(!f)throw new Error('Missing detail feature '+entry.no);
    const htmlComponents=Object.entries(f.structure.components).filter(([,v])=>v.componentType==='HtmlComponent').map(([k])=>f.props.render.compProps[k]?.url).filter((u):u is string=>!!u),detailUrl=htmlComponents.find(u=>new URL(u).hostname.endsWith('filesusr.com'));if(!detailUrl)throw new Error('Missing detail embed '+entry.no);const d=cheerio.load(documents.get(detailUrl)!),cells=d('td').toArray(),cell=(label:string)=>cells.find(e=>d(e).text().trim().startsWith(`【${label}】`)),value=(label:string)=>{const e=cell(label);return e?d(e).text().trim().slice(label.length+2).trim():'';},comment=(label:string)=>{const e=cell(label);if(!e)throw new Error('Missing comment '+entry.no+'/'+label);return sanitize((d(e).html()||'').replace(`【${label}】`,''),detailUrl);};
    const work:WorkEntry={id:previous.id,festivalId:id,no:previous.no,title:previous.title,author:value('作者名'),engine:value('使用ツール'),category:value('ジャンル'),streaming:value('作品配信許可／動画公開許可'),source:{url,titleUrl:entry.catalogueEmbed},authorComment:comment('作者コメント'),hostComment:comment('管理人コメント')};
    if(entry.title!==previous.title)work.originalTitle=entry.title;work.icon=(await media(entry.iconUrl,'icons',entry.no+'-source')).local;
    const shotUrls=[...new Set(Object.entries(f.structure.components).filter(([,v])=>v.componentType==='SlideShowContainer').flatMap(([k])=>(f.props.render.compProps[k]?.slidesProps||[]).map(p=>f.props.render.compProps[p.id]?.fillLayers?.image?.uri)).filter((u):u is string=>!!u).map(mediaUrl))],shots=[];for(const u of shotUrls)shots.push(await media(u,'screenshots',`${entry.no}-source-${shots.length+1}`));work.ss=shots.map(s=>s.local);
    const list=cheerio.load(documents.get(entry.catalogueEmbed)!),table=list('table').filter((_,e)=>list(e).find('a[href*="/no-"]').first().text().trim().startsWith('No.'+Number(entry.no)+'　')||list(e).find('a[href*="/no-"]').first().text().trim().match(/^No\.(\d+)/)?.[1]===String(Number(entry.no))).last(),downloads:WorkDownload[]=[];
    for(const[doc,scope]of [[list,table],[d,d.root()]]as const)scope.find('a[href]').each((_,e)=>{const raw=doc(e).attr('href')!,u=canon(raw,detailUrl);if(/getuploader|mediafire|drive\.google|\.zip(?:$|\?)/i.test(u)&&!downloads.some(x=>x.url===u))downloads.push({url:u,label:doc(e).text().trim()||'原資料の配布先'});});if(downloads.length){work.downloads=downloads;work.download=downloads[0];}
    const forum=table.find('a[href*="jbbs.shitaraba.net"]').first().attr('href')||d('iframe[src*="jbbs.shitaraba.net"]').first().attr('src')||d('a[href*="jbbs.shitaraba.net"]').first().attr('href');if(forum)work.forum=forum;
    works.push(work);entries.push({id:work.id,no:entry.no,sourceUrl:url,detailSource:detailUrl,catalogueSource:entry.catalogueEmbed,iconSource:canon(entry.iconUrl),screenshotSources:shots,slideshowSlots:shotUrls.length,downloadLinks:downloads,packagesDownloaded:false});
  }
  const master=featureBySeo.get('master')!,bannerProps=Object.entries(master.structure.components).filter(([,v])=>v.componentType==='WPhoto').map(([k])=>master.props.render.compProps[k]).filter(p=>p.uri),banners=[];for(const p of bannerProps)banners.push(await media(mediaUrl(p.uri!),'banners',`source-${banners.length+1}`));const festivals=await read<Festival[]>('src/data/festivals.json');festivals.find(f=>f.id===id)!.banners=banners.map(b=>b.local);
  await writeJson(`${root}/source/replay/manifest.json`,replay);await writeJson(`src/data/works/${id}.json`,works);await writeJson('src/data/festivals.json',festivals);await writeJson(`${root}/recovery.json`,{festivalId:id,originalBase:base+'/',entryPage:'index.html',liveSource:true,originalResources:resources,entries,bannerSources:banners,sourceSlides,externalFrames,sourceManifests:['source/replay/manifest.json'],handling:'Direct source archival without topic or pixel screening. Original Wix SSR layout/CSS and native slideshow controls retained; frozen HTML components materialized from the source component JSON. Full-resolution source media replace Wix pre-hydration blurred thumbnails. Original raw bytes remain unchanged. No screenshot cap, no added restrictions, no game packages downloaded or executed.',desktopReview:'pending'});
  console.log({works:works.length,icons:works.filter(w=>w.icon).length,screenshots:works.reduce((n,w)=>n+(w.ss?.length||0),0),banners:banners.length,sourcePages:documents.size,resources:Object.keys(assets).length});
}
main().catch(e=>{console.error(e);process.exitCode=1;});
