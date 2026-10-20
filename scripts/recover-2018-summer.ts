import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { decodeSource, imageExtension, writeJson } from './recover-entry-table';
import type { Festival, WorkEntry, WorkDownload } from '../src/lib/types';

const id='2018-summer',root=`catch/${id}`,base='http://www.geocities.jp/tkoolvip2018summer/';
type Capture={originalUrl:string;snapshotUrl:string;file:string;status:number;sha256:string;cdxDigest:string;cdxDigestMatches:boolean};
const read=async<T,>(p:string):Promise<T>=>JSON.parse(await fs.readFile(p,'utf8'));
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const norm=(s:string)=>s.normalize('NFKC').replace(/\s/g,'');
const absolute=(u:string)=>new URL(u,base).href;

async function main(){
  const old=await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`),pages=await read<Record<string,Capture>>(`${root}/source/archive/manifest.json`),assets=await read<Record<string,Capture>>(`${root}/source/resources/manifest.json`);
  const resources:Record<string,string>={},replay:Record<string,unknown>={},buffers=new Map<string,Buffer>(),documents=new Map<string,string>();
  await fs.mkdir(`${root}/source/replay/generated`,{recursive:true});
  for(const[dir,captures]of [['archive',pages],['resources',assets]]as const)for(const cap of Object.values(captures)){
    const b=await fs.readFile(`${root}/source/${dir}/${cap.file}`);if(cap.status!==200||!cap.cdxDigestMatches||hash(b)!==cap.sha256)throw new Error('Source capture is not verified');
    let local=new URL(cap.originalUrl).pathname.slice(new URL(base).pathname.length);
    if(dir==='resources'){
      if(!local.endsWith('.css')){local=local.replace(/(\.[^/.]+)?$/,'.'+imageExtension(b));buffers.set(cap.originalUrl,b);}replay[cap.originalUrl]={...cap,file:`../${dir}/${cap.file}`};
    }else{
      const html=decodeSource(b,'utf-8'),q=cheerio.load(html);documents.set(cap.originalUrl,html);
      // These static Geocities documents only use hosting/analytics scripts; image swaps are HTML attributes.
      q('script,noscript').remove();
      q('body').prepend(`<p data-archive-notice style="padding:8px;border:1px solid #aab7c4;background:#f1f5f8;text-align:left">保存資料：${cap.snapshotUrl.match(/\/web\/(\d{4})(\d{2})(\d{2})/)?.slice(1).join('-')}の公開ページを再生しています。原HTMLと画像の載荷は保存済みです。</p>`);
      await fs.writeFile(`${root}/source/replay/generated/${local}`,q.html());
      replay[cap.originalUrl]={originalUrl:cap.originalUrl,file:`generated/${local}`,status:200,kind:'html',sha256:hash(q.html()),sourceKind:'derived-static-replay',snapshotUrl:cap.snapshotUrl,sourceRawFile:`../archive/${cap.file}`,sourceRawSha256:cap.sha256,sourceCdxDigest:cap.cdxDigest,rawCdxDigestVerified:true};
    }
    resources[cap.originalUrl]=local;
  }
  const topUrl=absolute('index.html'),top=cheerio.load(documents.get(topUrl)!),works:WorkEntry[]=[],entries=[];
  const media=async(url:string,folder:string,name:string)=>{const b=buffers.get(url);if(!b)throw new Error('Uncaptured source image');const local=`/${folder}/${id}/${name}.${imageExtension(b)}`;await fs.mkdir(path.dirname('public'+local),{recursive:true});await fs.writeFile('public'+local,b);return{local,sourceUrl:url,sha256:hash(b)};};
  const sanitize=(html:string)=>{const q=cheerio.load(`<div>${html}</div>`);q('script,style,iframe,object,embed,form').remove();q('*').each((_,e)=>{for(const a of Object.keys(e.attribs))if(a.startsWith('on'))q(e).removeAttr(a);});q('img[src]').each((_,e)=>{const u=absolute(q(e).attr('src')!);if(!resources[u])throw new Error('Uncaptured inline image');q(e).attr('src',`/original-pages/${id}/${resources[u]}`);});q('a[href]').each((_,e)=>q(e).attr('href',absolute(q(e).attr('href')!)));return q('body>div').toString();};
  const links=[...new Set(top('a[href]').map((_,a)=>top(a).attr('href')!).get().filter(u=>/^entry\d+\.html$/.test(u)))];if(links.length!==45||old.some(w=>w.contentRestricted))throw new Error('Catalogue or restriction scope changed');
  for(const href of links){
    const no=href.match(/entry(\d+)\.html$/)![1],previous=old.find(w=>Number(w.no)===Number(no));if(!previous)throw new Error(`Unknown source identity ${no}`);
    const url=absolute(href),cap=pages[url],d=cheerio.load(documents.get(url)!),rows=d('table').first().children('thead,tbody').children('tr'),heading=rows.first().text().trim(),identity=heading.match(/^No[.．]\s*(\d+)[\s　]+([\s\S]+)$/i),a=top(`a[href="${href}"]`).first(),cells=a.closest('tr').children('td');
    const linkParts=(a.html()||'').split(/<br\s*\/?\s*>/i),catalogueTitle=cheerio.load(linkParts[0])('body').text().trim(),catalogueAuthor=cheerio.load((cells.eq(2).html()||'').split(/<br\s*\/?\s*>/i).slice(1).join('<br>'))('body').text().trim();
    const title=norm(catalogueTitle)===norm(previous.title)?previous.title:cheerio.load(previous.title)('body').text().trim();
    if(!identity||Number(identity[1])!==Number(no)||norm(catalogueTitle)!==norm(title))throw new Error(`Source title mismatch ${no}`);
    const metadata:Array<{label:string;value:string;html:string}>=[],comments:Record<string,string>={};
    rows.slice(2,-2).each((_,r)=>{const cell=d(r).children('td').first(),text=cell.text().trim(),label=text.replace(/^[\s【\[［（(]+/,'').match(/^(作者コメント|管理人コメント)/)?.[1];if(label){const parts=(cell.html()||'').split(/<br\s*\/?\s*>/i),head=cheerio.load(parts[0])('body').text().replace(/[\s【】［］\[\]（）()：:]/g,'');if(head!==label)throw new Error(`Comment heading changed ${no}`);comments[label]=parts.slice(1).join('<br>');}else{const match=text.match(/^([^：:]+)[：:]\s*([\s\S]*)$/);if(!match)throw new Error(`Metadata structure changed ${no}`);metadata.push({label:match[1].trim(),value:match[2].trim(),html:cell.html()||''});}});
    const value=(label:string)=>metadata.filter(m=>m.label===label).map(m=>m.value).join(' / '),work:WorkEntry={id:previous.id,festivalId:id,no:previous.no,title,author:value('作者'),engine:value('ツール'),category:value('ジャンル'),streaming:value('配信/投稿'),source:{url,snapshotUrl:cap.snapshotUrl},authorComment:sanitize(comments['作者コメント']),hostComment:sanitize(comments['管理人コメント'])};
    if(norm(identity[2])!==norm(title))work.originalTitle=identity[2];
    const iconSrc=cells.eq(1).find('img').attr('src')||rows.first().find('img').attr('src');if(iconSrc)work.icon=(await media(absolute(iconSrc),'icons',`${no}-source`)).local;
    const shotUrls=new Set<string>();rows.eq(1).find('img[src]').each((_,img)=>{shotUrls.add(absolute(d(img).attr('src')!));for(const attr of ['onmouseover','onmouseout'])for(const m of(d(img).attr(attr)||'').matchAll(/this\.src\s*=\s*['"]([^'"]+)/g))if(buffers.has(absolute(m[1])))shotUrls.add(absolute(m[1]));});const shots=[];for(const u of shotUrls){if(!shots.some(s=>s.sha256===hash(buffers.get(u)!)))shots.push(await media(u,'screenshots',`${no}-source-${shots.length+1}`));}if(shots.length)work.ss=shots.map(s=>s.local);
    const downloads:WorkDownload[]=[];const add=(u:string,label:string)=>{if(!downloads.some(x=>x.url===u))downloads.push({url:u,label});};cells.eq(4).find('a[href]').each((_,e)=>add(absolute(top(e).attr('href')!),top(e).text().trim()));const forum=cells.eq(6).find('a[href]').attr('href');if(forum)work.forum=absolute(forum);rows.eq(-2).find('a[href]').each((_,e)=>{const u=absolute(d(e).attr('href')!);if(!new URL(u).hostname.includes('shitaraba.net'))add(u,'原紹介ページ：'+d(e).text().trim());});if(downloads.length){work.downloads=downloads;work.download=downloads[0];}
    const sourceMetadata={author:catalogueAuthor,type:cells.eq(3).text().trim(),typeHtml:cells.eq(3).html(),streaming:cells.eq(5).text().trim()};
    if(metadata.filter(m=>m.label==='ジャンル').length>1)work.sourceContent=sanitize(metadata.map(m=>`<p>${m.html}</p>`).join(''));
    works.push(work);entries.push({id:work.id,no,sourceUrl:url,snapshotUrl:cap.snapshotUrl,...(title!==previous.title?{titleEncodingCorrection:{before:previous.title,after:title,evidence:topUrl}}:{}),sourceMetadata:metadata,catalogueMetadata:sourceMetadata,iconSourceUrl:iconSrc?absolute(iconSrc):null,screenshotSources:shots,downloadLinks:downloads,commentRows:Object.keys(comments),packagesDownloaded:false});
  }
  const banners=[];for(const [n,u]of ['summer_2018a.png','summer_2018b.png'].entries())banners.push(await media(absolute(u),'banners',`source-${n+1}`));const festivals=await read<Festival[]>('src/data/festivals.json');festivals.find(f=>f.id===id)!.banners=banners.map(b=>b.local);
  await writeJson(`${root}/source/replay/manifest.json`,replay);await writeJson(`src/data/works/${id}.json`,works);await writeJson('src/data/festivals.json',festivals);
  await writeJson(`${root}/recovery.json`,{festivalId:id,originalBase:base,entryPage:'index.html',liveSource:false,originalResources:resources,sourceManifests:['source/replay/manifest.json'],entries,bannerSources:banners,liveSourceEvidence:'source/live/manifest.json',sourceSnapshotEvidence:'source/archive/manifest.json',handling:'Direct archival without topic or pixel screening. Preserve all45 source identities, both complete comments, original hover roles and duplicated metadata labels. All source icons are preserved. No.02 hover alias was retrieved directly and its payload matches the indexed extensionless screenshot. No game packages downloaded or executed.',desktopReview:'pending'});
  console.log({works:works.length,icons:works.filter(w=>w.icon).length,screenshots:works.reduce((n,w)=>n+(w.ss?.length||0),0),downloadEntries:works.filter(w=>w.download).length,downloadLinks:works.reduce((n,w)=>n+(w.downloads?.length||0),0),sourceImages:buffers.size});
}
main().catch(e=>{console.error(e);process.exitCode=1;});
