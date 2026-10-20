import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { imageExtension, writeJson } from './recover-entry-table';
import type { Festival, WorkEntry, WorkDownload } from '../src/lib/types';

const id='2018-kouhaku',root=`catch/${id}`,base='https://viprpgmsmkohaku2018.web.fc2.com/';
type Capture={originalUrl:string;file:string;status:number;sha256:string;kind:string;contentType?:string};
const read=async<T,>(p:string):Promise<T>=>JSON.parse(await fs.readFile(p,'utf8'));
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const norm=(s:string)=>s.normalize('NFKC').replace(/\s/g,'');
const absolute=(ref:string,owner=base)=>new URL(ref,owner).href;

async function main(){
  const old=await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`),pages=await read<Record<string,Capture>>(`${root}/source/live/manifest.json`),assets=await read<Record<string,Capture>>(`${root}/source/resources/manifest.json`);
  if(old.some(w=>w.contentRestricted))throw new Error('Restriction scope changed');
  const resources:Record<string,string>={},replay:Record<string,unknown>={},buffers=new Map<string,Buffer>(),documents=new Map<string,string>();
  await fs.mkdir(`${root}/source/replay/generated`,{recursive:true});
  for(const[dir,manifest]of [['live',pages],['resources',assets]]as const)for(const cap of Object.values(manifest)){
    const b=await fs.readFile(`${root}/source/${dir}/${cap.file}`);if(cap.status!==200||hash(b)!==cap.sha256)throw new Error('Source capture changed or failed');
    let local=new URL(cap.originalUrl).pathname.slice(1)||'index.html';
    if(dir==='resources'){
      if(cap.kind==='image')local=local.replace(/\.[^/.]+$/,'.'+imageExtension(b));
      buffers.set(cap.originalUrl,b);replay[cap.originalUrl]={...cap,file:`../${dir}/${cap.file}`};
      if(local==='js/common.js'){
        const code=b.toString('utf8'),needle="$($.browser.safari ? 'body' : 'html')";
        if(!code.includes(needle))throw new Error('Source scrolling script structure changed');
        const fixed=code.replace(needle,'$(document.scrollingElement)');
        await fs.writeFile(`${root}/source/replay/generated/common.js`,fixed);
        replay[cap.originalUrl]={originalUrl:cap.originalUrl,file:'generated/common.js',status:200,kind:'script',sha256:hash(fixed),sourceKind:'derived-script-compatibility',sourceRawFile:`../resources/${cap.file}`,sourceRawSha256:cap.sha256,change:'Use the actual DOM scrolling element instead of the legacy Safari user-agent flag.'};
      }
    }else{
      const html=b.toString('utf8'),d=cheerio.load(html);documents.set(cap.originalUrl,html);
      d('script:not([src]),noscript,img[src*="media.fc2.com/counter_img.php"]').remove();
      d('script[src]').each((_,e)=>{if(new URL(d(e).attr('src')!,cap.originalUrl).hostname!==new URL(base).hostname)d(e).remove();});
      if(local==='resultall.html')d('a[href="entry.html"]').attr('href',base+'index.html#gamelist');
      await fs.writeFile(`${root}/source/replay/generated/${local}`,d.html());
      replay[cap.originalUrl]={originalUrl:cap.originalUrl,file:`generated/${local}`,status:200,sha256:hash(d.html()),sourceKind:'derived-static-replay',sourceRawFile:`../live/${cap.file}`,sourceRawSha256:cap.sha256};
    }
    resources[cap.originalUrl]=local;
  }
  resources[base+'index.html']='index.html';
  const top=cheerio.load(documents.get(base)!),catalogue=top('a[href="entry01.html"]').first().closest('table'),works:WorkEntry[]=[],entries=[];
  const plain=(html:string)=>cheerio.load(html)('body').text().trim();
  const media=async(url:string,folder:string,name:string)=>{const b=buffers.get(url);if(!b)throw new Error('Uncaptured source image');const local=`/${folder}/${id}/${name}.${imageExtension(b)}`;await fs.mkdir(path.dirname('public'+local),{recursive:true});await fs.writeFile('public'+local,b);return{local,sourceUrl:url,sha256:hash(b)};};
  const sanitize=(html:string,owner:string)=>{const d=cheerio.load(`<div>${html}</div>`);d('script,style,iframe,form,object,embed').remove();d('*').each((_,e)=>{for(const key of Object.keys(e.attribs))if(key.startsWith('on'))d(e).removeAttr(key);});d('[src],[href]').each((_,e)=>{for(const attr of ['src','href']){const ref=d(e).attr(attr);if(!ref||ref.startsWith('#'))continue;const u=absolute(ref,owner);if(attr==='src'&&!resources[u])throw new Error('Uncaptured inline image');d(e).attr(attr,resources[u]?`/original-pages/${id}/${resources[u]}`:u);}});return d('body>div').toString();};
  const hrefs=[...new Set(catalogue.find('a[href]').map((_,e)=>top(e).attr('href')!).get().filter(u=>/^entry\d+\.html$/.test(u)))];if(hrefs.length!==61)throw new Error('Catalogue size changed');
  for(const href of hrefs){
    const no=href.match(/entry(\d+)\.html$/)![1],previous=old.find(w=>Number(w.no)===Number(no));if(!previous)throw new Error(`Unknown source identity ${no}`);
    const url=absolute(href),d=cheerio.load(documents.get(url)!),rows=d('table').first().children('tbody').children('tr'),a=catalogue.find(`a[href="${href}"]`).first(),cells=a.closest('tr').children('td'),parts=(a.html()||'').split(/<br\s*\/?\s*>/i),catalogueTitle=plain(parts[0]),catalogueAuthor=parts.length>1?plain(parts.slice(1).join('<br>')):cells.eq(2).clone().find('a').remove().end().text().trim(),typeParts=(cells.eq(3).html()||'').split(/<br\s*\/?\s*>/i).map(plain).filter(Boolean),heading=rows.first().children('td').last().text().trim(),identity=heading.match(/^No[.．]\s*(\d+)[\s　]+([\s\S]+)$/i);
    if(!identity||Number(identity[1])!==Number(no))throw new Error(`Detail identity changed ${no}`);
    if(norm(catalogueTitle)!==norm(plain(previous.title))&&norm(identity[2])!==norm(plain(previous.title)))throw new Error(`Source title needs evidence ${no}`);
    const catalogueInfo={title:catalogueTitle,author:catalogueAuthor,category:typeParts.slice(0,-1).join('\n')||typeParts[0]||'',engine:typeParts.length>1?typeParts.at(-1)!:'',streaming:cells.eq(5).text().trim()},work:WorkEntry={id:previous.id,festivalId:id,no:previous.no,title:previous.title,author:catalogueInfo.author,category:catalogueInfo.category,engine:catalogueInfo.engine,streaming:catalogueInfo.streaming,source:{url}};
    if(norm(identity[2])!==norm(work.title))work.originalTitle=identity[2];
    const extra:string[]=[],metadata:Record<string,string>={},comments:Record<string,string>={};
    rows.slice(2,-2).each((_,r)=>{const cell=d(r).children('td').first(),text=cell.text().trim(),comment=text.match(/^(作者コメント|管理人コメント)/)?.[1];if(comment){const html=(cell.html()||'').replace(new RegExp(`^[\\s\\S]*?${comment}\\s*[:：]?\\s*(?:<br\\s*\\/?\\s*>\\s*)?`,'u'),'');comments[comment]=html;return;}const m=text.match(/^([^：:]{1,24})[：:]\s*([\s\S]*)$/);if(m){metadata[m[1].trim()]=m[2].trim();if(!['作者','作者名','ツクール','使用ツール','ジャンル','配信/投稿'].includes(m[1].trim()))extra.push(cell.html()||'');}});
    for(const[label,key]of [['作者コメント','authorComment'],['管理人コメント','hostComment']]as const){if(comments[label]===undefined)throw new Error(`Missing source comment field ${no}`);if(plain(comments[label]))work[key]=sanitize(comments[label],url);}
    const differences=[];for(const[label,key]of [['作者','author'],['ツクール','engine'],['ジャンル','category'],['配信/投稿','streaming']]as const)if(metadata[label]!==undefined&&norm(metadata[label])!==norm(work[key]||'')){differences.push({label,catalogue:work[key]||'',detail:metadata[label]});extra.push(cheerio.load('<p>')('p').text(`原紹介ページの${label}：${metadata[label]}`).toString());}
    if(extra.length)work.sourceContent=sanitize(extra.join('\n'),url);
    const icon=cells.eq(1).find('img').attr('src')||rows.first().find('img').attr('src');if(icon)work.icon=(await media(absolute(icon),'icons',`${no}-source`)).local;
    const refs=new Set<string>();rows.eq(1).find('img[src]').each((_,e)=>{refs.add(absolute(d(e).attr('src')!,url));for(const attr of ['onmouseover','onmouseout'])for(const m of(d(e).attr(attr)||'').matchAll(/this\.src\s*=\s*['"]([^'"]+)/g))refs.add(absolute(m[1],url));});const shots=[];for(const ref of refs)shots.push(await media(ref,'screenshots',`${no}-source-${shots.length+1}`));if(shots.length)work.ss=shots.map(s=>s.local);
    const downloads:WorkDownload[]=[],samplePlaceholderLinks=[];const add=(u:string,label:string)=>{if(!downloads.some(d=>d.url===u))downloads.push({url:u,label});};cells.eq(4).find('a[href]').each((_,e)=>{const ref=top(e).attr('href')!;if(ref&&!ref.startsWith('#'))add(absolute(ref),top(e).text().trim());});rows.eq(-2).find('a[href]').each((_,e)=>{const ref=d(e).attr('href')!,label=d(e).text().trim();if(!ref||ref.startsWith('#')||!/ダウンロード|\bDL\b/i.test(label))return;const u=absolute(ref,url);if(Number(no)===0&&resources[u]==='index.html'){samplePlaceholderLinks.push(u);return;}add(u,'原紹介ページ：'+label);});if(downloads.length){work.downloads=downloads;work.download=downloads[0];}const forum=cells.eq(6).find('a[href]').attr('href');if(forum)work.forum=absolute(forum);
    works.push(work);entries.push({id:work.id,no,sourceUrl:url,catalogue:catalogueInfo,detailTitle:identity[2],sourceMetadata:metadata,metadataDifferences:differences,commentFields:Object.keys(comments),extraSourceRows:extra.length,iconSourceUrl:icon?absolute(icon):null,screenshotSources:shots,downloadLinks:downloads,samplePlaceholderLinks,packagesDownloaded:false});
  }
  const banner=await media(absolute('banner/kohaku2018.png'),'banners','source'),festivals=await read<Festival[]>('src/data/festivals.json');festivals.find(f=>f.id===id)!.banners=[banner.local];
  await writeJson(`${root}/source/replay/manifest.json`,replay);await writeJson(`src/data/works/${id}.json`,works);await writeJson('src/data/festivals.json',festivals);await writeJson(`${root}/recovery.json`,{festivalId:id,originalBase:base,liveSource:true,proxyRegion:'Japan',sourceManifests:['source/replay/manifest.json'],originalResources:resources,entries,bannerSources:[banner],groupEvidence:'The source has a single61-entry catalogue, no group column or group dividers, and no detail group field. Do not infer red/white membership from the festival name.',resultPages:['result01.html','resultall.html'],handling:'Direct source preservation without topic or pixel screening. Keep all61 existing identities, both complete comment fields, original screenshot/hover roles, keyword/voting source rows and metadata differences. Publisher keyword values are preserved as data, never used for screening. Local source jQuery/common scripts are retained; hosting counters removed. No game packages downloaded or executed.',desktopReview:'pending'});
  console.log({works:works.length,icons:works.filter(w=>w.icon).length,screenshots:works.reduce((n,w)=>n+(w.ss?.length||0),0),downloadEntries:works.filter(w=>w.download).length,downloadLinks:works.reduce((n,w)=>n+(w.downloads?.length||0),0),metadataDifferenceEntries:entries.filter(e=>e.metadataDifferences.length).length});
}
main().catch(e=>{console.error(e);process.exitCode=1;});
