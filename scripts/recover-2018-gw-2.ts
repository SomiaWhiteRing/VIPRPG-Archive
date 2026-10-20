import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { decodeSource, imageExtension, writeJson } from './recover-entry-table';
import type { Festival, WorkEntry, WorkDownload } from '../src/lib/types';

const id='2018-gw-2',root=`catch/${id}`,base='https://vipkohaku.x.fc2.com/2018GW2/',geo='http://3rd.geocities.jp/viprpg2018/';
type Capture={originalUrl:string;snapshotUrl:string;file:string;status:number;sha256:string;cdxDigestMatches:boolean;wireFile?:string;wireSha256?:string};
type Asset=Capture&{localPath:string;aliases:string[]};
const read=async<T,>(p:string):Promise<T>=>JSON.parse(await fs.readFile(p,'utf8'));
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const norm=(s:string)=>s.normalize('NFKC').replace(/\s/g,'');
function relative(url:string){const u=new URL(url);if(u.hostname==='3rd.geocities.jp'&&u.pathname.startsWith('/viprpg2018/'))return u.pathname.slice(12)||'index.html';if(u.hostname==='vipkohaku.x.fc2.com'&&u.pathname.startsWith('/2018GW2/'))return u.pathname.slice(9)||'index.html';throw new Error('Unexpected source host');}

async function main(){
  const old=await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`),pages=await read<Record<string,Capture>>(`${root}/source/archive/manifest.json`),assets=await read<Record<string,Asset>>(`${root}/source/resources/manifest.json`);
  if(old.some(w=>w.contentRestricted))throw new Error('Restriction scope changed');
  const selected=new Map<string,{cap:Capture;html:string}>(),resources:Record<string,string>={},replay:Record<string,unknown>={},buffers=new Map<string,Buffer>();
  await fs.mkdir(`${root}/source/replay/generated/works`,{recursive:true});await fs.mkdir(`${root}/source/replay/generated/viprpg_files`,{recursive:true});
  for(const cap of Object.values(pages)){
    const b=await fs.readFile(`${root}/source/archive/${cap.file}`);if(cap.status!==200||!cap.cdxDigestMatches||hash(b)!==cap.sha256)throw new Error('Unverified HTML capture');
    if(cap.wireFile&&hash(await fs.readFile(`${root}/source/archive/${cap.wireFile}`))!==cap.wireSha256)throw new Error('Compressed source payload changed');
    const local=relative(cap.originalUrl),previous=selected.get(local);if(!previous||cap.originalUrl.startsWith(base))selected.set(local,{cap,html:decodeSource(b,'euc-jp')});
  }
  for(const cap of Object.values(assets)){
    const b=await fs.readFile(`${root}/source/resources/${cap.file}`);if(cap.status!==200||!cap.cdxDigestMatches||hash(b)!==cap.sha256)throw new Error('Unverified image capture');
    const local=cap.localPath.replace(/\.[^/.]+$/,'.'+imageExtension(b));buffers.set(cap.localPath,b);
    for(const u of cap.aliases)resources[new URL(u).href]=local;
    replay[cap.originalUrl]={...cap,file:`../resources/${cap.file}`};
  }
  const cat=selected.get('viprpg_files/gw.html')!,q=cheerio.load(cat.html),works:WorkEntry[]=[],records:Record<string,unknown>[]=[],gaps:Record<string,unknown>[]=[],imageGaps:Record<string,string>[]=[],generated:Record<string,string>[]=[];
  const plain=(s:string)=>cheerio.load(s)('body').text().trim();
  const alias=(local:string)=>{resources[base+local]=local;resources[geo+local]=local;};
  const media=async(ref:string,owner:string,folder:string,name:string)=>{const u=new URL(ref,owner).href,b=buffers.get(relative(u));if(!b)throw new Error('Missing source image');const local=`/${folder}/${id}/${name}.${imageExtension(b)}`;await fs.mkdir(path.dirname('public'+local),{recursive:true});await fs.writeFile('public'+local,b);return{local,sourceUrl:u,sha256:hash(b)};};
  const sanitize=(html:string,owner:string)=>{const d=cheerio.load(`<div>${html}</div>`);d('script,style,iframe,object,embed,form').remove();d('*').each((_,e)=>{for(const a of Object.keys(e.attribs))if(a.startsWith('on'))d(e).removeAttr(a);});d('a[href]').each((_,e)=>d(e).attr('href',new URL(d(e).attr('href')!,owner).href));d('img[src]').each((_,e)=>{const u=new URL(d(e).attr('src')!,owner).href;if(!resources[u])throw new Error('Uncaptured inline image');d(e).attr('src',`/original-pages/${id}/${resources[u]}`);});return d('body>div').toString();};
  const links=[...new Set(q('a[href]').map((_,e)=>q(e).attr('href')!).get().filter(u=>/^\.\.\/works\/\d+\.html$/.test(u)))];if(links.length!==32)throw new Error('Catalogue size changed');
  for(const href of links){
    const no=href.match(/(\d+)\.html$/)![1],previous=old.find(w=>Number(w.no)===Number(no)),a=q(`a[href="${href}"]`).first(),cells=a.closest('tr').children('td'),parts=(a.html()||'').split(/<br\s*\/?\s*>/i),title=plain(parts[0]),author=parts.length>1?plain(parts.slice(1).join('<br>')):cells.eq(2).clone().find('a').remove().end().text().trim();
    if(!previous||norm(title)!==norm(plain(previous.title)))throw new Error(`Catalogue identity changed ${no}`);
    const typeParts=(cells.eq(3).html()||'').split(/<br\s*\/?\s*>/i).map(plain).filter(Boolean),catalogue={title,author,category:typeParts.slice(0,-1).join('\n')||typeParts[0]||'',engine:typeParts.length>1?typeParts.at(-1)!:'',streaming:cells.eq(5).text().trim()},local=`works/${no}.html`,detail=selected.get(local),owner=detail?.cap.originalUrl||cat.cap.originalUrl;
    const work:WorkEntry={id:previous.id,festivalId:id,no:previous.no,title:previous.title===title?previous.title:title,author:catalogue.author,category:catalogue.category,engine:catalogue.engine,streaming:catalogue.streaming,source:{url:owner,snapshotUrl:(detail?.cap||cat.cap).snapshotUrl}};
    const icon=cells.eq(1).find('img').attr('src');if(icon)work.icon=(await media(icon,cat.cap.originalUrl,'icons',`${no}-source`)).local;
    const downloads:WorkDownload[]=[];cells.eq(4).find('a[href]').each((_,e)=>downloads.push({url:new URL(q(e).attr('href')!,cat.cap.originalUrl).href,label:q(e).text().trim()}));if(downloads.length){work.downloads=downloads;work.download=downloads[0];}const forum=cells.eq(6).find('a[href]').attr('href');if(forum)work.forum=new URL(forum,cat.cap.originalUrl).href;
    const shots:Awaited<ReturnType<typeof media>>[]=[],detailMetadata:Record<string,string>={},metadataDifferences:Array<{field:string;label:string;catalogueValue:string;detailValue:string}>=[];
    if(detail){
      const d=cheerio.load(detail.html),rows=d('table').first().children('tbody').children('tr');
      for(const [row,key,label]of [[2,'author','作者'],[3,'engine','使用ツール'],[4,'category','ジャンル'],[5,'streaming','配信/投稿']]as const){const value=rows.eq(row).text().trim().match(/^[^：:]+[：:]\s*([\s\S]*)$/)?.[1];if(value!==undefined){detailMetadata[key]=value.trim();if(norm(value)!==norm(catalogue[key]))metadataDifferences.push({field:key,label,catalogueValue:catalogue[key],detailValue:value.trim()});}}
      if(metadataDifferences.length)work.sourceContent=sanitize('<p>［保存庫補記］基本情報は保存された作品一覧を採用しています。原紹介ページの異なる記載を以下に残します。</p>'+metadataDifferences.map(m=>cheerio.load('<p>')('p').text(`原紹介ページの${m.label}：${m.detailValue}`).toString()).join(''),owner);
      const comment=rows.eq(6).children('td').html()||'';if(!rows.eq(6).text().trim().startsWith('作者コメント'))throw new Error('Author comment structure changed');work.authorComment=sanitize(comment.replace(/^[\s\S]*?作者コメント\s*[：:]\s*/u,''),owner);
      const refs=new Set<string>();rows.eq(1).find('img[src]').each((_,e)=>{refs.add(d(e).attr('src')!);for(const attr of ['onmouseover','onmouseout'])for(const m of(d(e).attr(attr)||'').matchAll(/this\.src\s*=\s*['"]([^'"]+)/g))refs.add(m[1]);});
      for(const ref of refs){const u=new URL(ref,owner).href;if(buffers.has(relative(u)))shots.push(await media(ref,owner,'screenshots',`${no}-source-${shots.length+1}`));else imageGaps.push({no,sourceUrl:u,role:'source-hover-image'});}
      if(shots.length)work.ss=shots.map(s=>s.local);
      if(imageGaps.some(g=>g.no===no))work.sourceContent=sanitize((work.sourceContent||'')+'<p>［保存庫補記］原ページのマウス切替画像の一部は未取得です。保存済みの通常画像を掲載しています。</p>',owner);
    }else{
      work.sourceDetailUnavailable=true;work.sourceContent=sanitize('<p>［保存庫補記］紹介ページの本文と画像は未取得です。番号・作品名・作者・分類・配信条件・配布先は保存済みの作品一覧に基づきます。原資料の本文・画像は引き続き調査中です。</p>',owner);
      gaps.push({no,sourcePath:local,originalUrl:base+local,alternateOriginalUrl:geo+local,reason:'No detail capture in the checked original and official-mirror CDX inventories; the public backup contains game packages rather than website files.'});
    }
    alias(local);works.push(work);records.push({id:work.id,no,sourcePath:local,catalogue,detailMetadata,metadataDifferences,sourceUrl:owner,snapshotUrl:work.source!.snapshotUrl,detailCaptured:!!detail,iconSourceUrl:icon?new URL(icon,cat.cap.originalUrl).href:null,screenshotSources:shots,downloadLinks:downloads,packagesDownloaded:false});
  }
  const strip=(d:cheerio.CheerioAPI)=>{d('script,noscript').remove();d('link[href$="bc-geocities.yahoo.co.jp/js/no.css"],img[src*="media.fc2.com/counter_img.php"]').remove();d('meta[http-equiv="Content-Type"]').attr('content','text/html; charset=utf-8');d('meta[charset]').attr('charset','utf-8');};
  const publish=async(local:string,html:string,source:Record<string,unknown>)=>{await fs.writeFile(`${root}/source/replay/generated/${local}`,html);alias(local);replay[base+local]={originalUrl:base+local,file:`generated/${local}`,status:200,sha256:hash(html),sourceKind:'derived-source-replay',...source};};
  for(const[local,entry]of selected){const d=cheerio.load(entry.html);strip(d);if(imageGaps.some(g=>g.no===local.match(/works\/(\d+)\.html$/)?.[1]))d('img[onmouseover]').each((_,e)=>{const code=d(e).attr('onmouseover')!;if(imageGaps.some(g=>code.includes(new URL(g.sourceUrl).pathname.split('/').at(-1)!))){d(e).removeAttr('onmouseover');d(e).after('<p data-archive-hover-gap>［保存庫補記］切替画像は未取得です。通常表示の保存済み画像を保持しています。</p>');}});if(local==='viprpg_files/index2.html')d('img').first().attr('style','max-width:100%;height:auto');if(!d('frameset').length&&local!=='viprpg_files/bbsmenu.html')d('body').prepend('<p data-archive-notice>保存資料：紹介本文を保存できたのは01・05です。他の番号には一覧情報に基づく未取得の案内を掲載しています。</p>');await publish(local,d.html(),{snapshotUrl:entry.cap.snapshotUrl,sourceRawFile:`../archive/${entry.cap.file}`,sourceRawSha256:entry.cap.sha256});}
  for(const gap of gaps){const no=gap.no as string,work=works.find(w=>Number(w.no)===Number(no))!,d=cheerio.load(selected.get('works/01.html')!.html),rows=d('table').first().children('tbody').children('tr');strip(d);d('title').text(`作品${no}（紹介本文未取得）`);rows.first().children('td').last().text(`No.${no}　${work.title}`);const icon=records.find(e=>e.no===no)!.iconSourceUrl as string|null;rows.first().children('td').first().html(icon?'<img width="32" height="32">':'—');if(icon)rows.first().find('img').attr('src',icon);rows.eq(1).children('td').html('<p data-archive-missing-image style="padding:2em;border:1px dashed #888">原資料の画像は未取得です。</p>');for(const[row,value]of [[2,`作者：${work.author}`],[3,`使用ツール：${work.engine}`],[4,`ジャンル：${work.category}`],[5,`配信/投稿：${work.streaming}`]]as const)rows.eq(row).children('td').text(value);rows.eq(6).children('td').html('<p data-archive-source-gap>［保存庫補記］紹介本文は未取得です。ここに掲載する基本情報は保存済みの作品一覧に基づきます。</p>');rows.eq(7).children('td').empty();for(const dl of work.downloads||[])rows.eq(7).children('td').append(d('<a>').attr('href',dl.url).text(dl.label||'配布先')).append('<br>');if(work.forum)rows.eq(7).children('td').append(d('<a>').attr('href',work.forum).text('原感想スレッド'));rows.last().children('td').html('<a>作品一覧へ戻る</a>').find('a').attr('href',base+'viprpg_files/gw.html');d('body').prepend('<p data-archive-notice>［保存庫補記］この紹介本文は未取得です。原資料の本文を再現したページではありません。</p>');await publish(gap.sourcePath as string,d.html(),{sourceKind:'generated-source-gap',catalogueSnapshotUrl:cat.cap.snapshotUrl});generated.push({path:gap.sourcePath as string,reason:gap.reason as string});}
  resources[base]='index.html';resources[geo]='index.html';
  const front=selected.get('viprpg_files/index2.html')!,frontPage=cheerio.load(front.html),bannerRef=frontPage('img').first().attr('src')!;
  const banners=[await media(bannerRef,front.cap.originalUrl,'banners','source')];
  const festivals=await read<Festival[]>('src/data/festivals.json');festivals.find(f=>f.id===id)!.banners=banners.map(b=>b.local);
  await writeJson(`${root}/source/replay/manifest.json`,replay);await writeJson(`src/data/works/${id}.json`,works);await writeJson('src/data/festivals.json',festivals);await writeJson(`${root}/recovery.json`,{festivalId:id,originalBase:base,liveSource:false,sourceManifests:['source/replay/manifest.json'],originalResources:resources,catalogueSource:{originalUrl:cat.cap.originalUrl,snapshotUrl:cat.cap.snapshotUrl,rawFile:'source/archive/'+cat.cap.file},entries:records,sourceDetailGaps:gaps,imageGaps,generatedSourceGapNotices:generated,bannerSources:banners,handling:'Direct preservation without topic or pixel screening. All32 catalogue entries retained; only01 and05 have captured introduction bodies. Thirty explicit source-gap pages preserve catalogue metadata in the original detail layout. The public Mega backup was checked by file-type metadata only; no game packages downloaded. EUC-JP and Shift_JIS decoded individually; raw files unchanged.',desktopReview:'pending'});
  console.log({works:works.length,sourceDetails:works.filter(w=>!w.sourceDetailUnavailable).length,sourceGapPages:gaps.length,icons:works.filter(w=>w.icon).length,screenshots:works.reduce((n,w)=>n+(w.ss?.length||0),0),downloads:works.filter(w=>w.download).length,downloadLinks:works.reduce((n,w)=>n+(w.downloads?.length||0),0),banners:banners.length});
}
main().catch(e=>{console.error(e);process.exitCode=1;});
