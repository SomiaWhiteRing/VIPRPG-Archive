import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { imageExtension, writeJson } from './recover-entry-table';
import type { Festival, WorkEntry, WorkDownload } from '../src/lib/types';

const id='2020-kouhaku',root=`catch/${id}`,base='https://viprpg2020kohaku.xxxxxxxx.jp/';
type Capture={originalUrl:string;actualUrl:string;status:number;file:string;sha256:string;kind:string;usable?:boolean};
const read=async<T,>(p:string):Promise<T>=>JSON.parse(await fs.readFile(p,'utf8'));
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const norm=(s:string)=>s.normalize('NFKC').replace(/\s/g,'');
const abs=(u:string)=>new URL(u,base).href;

async function main(){
  const old=await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`),pages=await read<Record<string,Capture>>(`${root}/source/live/manifest.json`),assets=await read<Record<string,Capture>>(`${root}/source/resources/manifest.json`);
  const resources:Record<string,string>={},buffers=new Map<string,Buffer>(),replay:Record<string,unknown>={};
  for(const[dir,manifest]of [['live',pages],['resources',assets]]as const)for(const c of Object.values(manifest)){
    const b=await fs.readFile(`${root}/source/${dir}/${c.file}`);if(c.status!==200||c.usable===false||hash(b)!==c.sha256)throw new Error('Source payload verification failed');
    let local=decodeURIComponent(new URL(c.originalUrl).pathname.slice(1))||'index.html';if(c.kind==='asset')local=local.replace(/\.[^/.]+$/,'.'+imageExtension(b));
    resources[c.originalUrl]=local;buffers.set(c.originalUrl,b);replay[c.originalUrl]={...c,file:`../${dir}/${c.file}`};
  }
  resources[base+'index.html']='index.html';
  const sanitize=(html:string)=>{const q=cheerio.load(`<div class="source-comment">${html}</div>`);q('script,style,noscript,iframe,form,object,embed,link,meta').remove();q('*').each((_,e)=>{for(const a of Object.keys(e.attribs))if(a.startsWith('on')||['id','style','align','bgcolor','color','face','size'].includes(a)||(['width','height'].includes(a)&&e.tagName!=='img'))q(e).removeAttr(a);});q('img[src]').each((_,e)=>{const raw=q(e).attr('src')!;if(raw.startsWith('data:'))return;const u=abs(raw);if(!resources[u])throw new Error('Uncaptured inline source image');q(e).attr('src',`/original-pages/${id}/${resources[u]}`);});q('a[href]').each((_,e)=>{const u=new URL(q(e).attr('href')!,base);if(!['http:','https:','mailto:'].includes(u.protocol))q(e).removeAttr('href');else q(e).attr('href',u.href);});return q('body>div').toString();};
  const escape=(s:string)=>{const q=cheerio.load('<span></span>');return q('span').text(s).html()!;};
  const media=async(u:string,folder:string,name:string)=>{const b=buffers.get(u);if(!b)throw new Error('Source image absent');const local=`/${folder}/${id}/${name}.${imageExtension(b)}`;await fs.mkdir(path.dirname('public'+local),{recursive:true});await fs.writeFile('public'+local,b);return{sourceUrl:u,local,sha256:hash(b)};};
  const $=cheerio.load(buffers.get(base)!),rows=$('.wrapUnder-contents-listItem-descriptionTitle').toArray(),works:WorkEntry[]=[],entries=[];
  const make=async(no:string,card?:cheerio.Cheerio<Element>)=>{
    const previous=old.find(w=>Number(w.no)===Number(no)),url=base+`entry${no}.html`,cap=pages[url];
    if(no==='26'){
      const work:WorkEntry={id:`${id}-work-26`,festivalId:id,no:'26',title:'原一覧の空欄（No.26）',author:'',source:{url:base,titleUrl:base},sourceDetailUnavailable:true,sourceContent:'<p><strong>［原一覧の空欄］</strong></p><p>原サイトは26番の番号と共通画像だけを掲載しています。題名・作者・紹介・配布リンクは記載されていません。内容を推測せず、この番号の資料枠を保持しています。</p>'};
      work.icon=(await media(abs('./img/icon/i00.png'),'icons','26-source')).local;works.push(work);entries.push({id:work.id,no,sourceUrl:base,sourceCatalogueEmptySlot:true,expectedDetailUrl:url,detailProbeStatus:404,archiveExactCaptures:0,evidence:'investigation/entry26-cdx.json'});return;
    }
    if(!cap)throw new Error('Source detail missing');const q=cheerio.load(buffers.get(url)!),entry=q('#entry'),trs=entry.children('thead,tbody,tfoot').children('tr'),heading=entry.find('th').first().text().trim(),detailTitle=heading.replace(/^No\.\d+\s*/,''),fields:Record<string,{text:string;html:string}>={};
    entry.find('td').each((_,e)=>{const text=q(e).text().trim(),m=text.match(/^(作者|ジャンル|ツール|使用ツール|配信\/投稿|作者コメント|管理人コメント)[:：]([\s\S]*)$/);if(!m)return;const label=m[1],html=(q(e).html()||'').replace(new RegExp(`^\\s*${label}[:：]\\s*(?:<br\\s*\\/?>)?`),'');fields[label]={text:m[2].trim(),html};});
    const titleNode=card?.find('.wrapUnder-contents-listItem-descriptionTitle'),catalogueTitle=titleNode?.find('a').first().text().trim().replace(/^No\.\d+\s*/,''),metadataHtml=card?.find('.wrapUnder-contents-listItem-descriptionText').html()||'',meta=cheerio.load('<div>'+metadataHtml+'</div>');meta('br').replaceWith('\n');const metadataText=meta('body>div').text(),catalogue:Record<string,string>={};for(const label of ['作者','使用ツール','ジャンル','配信/投稿']){const match=metadataText.match(new RegExp(`【${label.replace('/','\\/')}】([^\\n]*)`));if(match)catalogue[label]=match[1].trim();}
    const title=catalogueTitle||detailTitle;if(previous&&norm(previous.title)!==norm(title))throw new Error('Existing catalogue identity/title changed');
    const work:WorkEntry={id:previous?.id||`${id}-work-${no}`,festivalId:id,no:previous?.no||no,title:previous?.title||title,author:fields['作者']?.text||catalogue['作者']||'',source:{url,titleUrl:card?base:url}};
    if(detailTitle!==work.title)work.originalTitle=detailTitle;const category=catalogue['ジャンル']||fields['ジャンル']?.text,engine=catalogue['使用ツール']||fields['使用ツール']?.text||fields['ツール']?.text,streaming=catalogue['配信/投稿']||fields['配信/投稿']?.text;if(category)work.category=category;if(engine)work.engine=engine;if(streaming)work.streaming=streaming;
    if(fields['作者コメント']?.text)work.authorComment=sanitize(fields['作者コメント'].html);
    const authorRow=trs.filter((_,r)=>q(r).children('td').first().text().trim().startsWith('作者コメント')),pos=trs.toArray().indexOf(authorRow[0]),hostRows=trs.toArray().slice(pos+1,-2),hostHtml=hostRows.map(r=>q(r).children('td').map((_,c)=>q(c).html()||'').get().join('\n')).join('\n');if(hostHtml.trim())work.hostComment=sanitize(hostHtml);
    const iconUrl=abs(card?.find('.wrapUnder-contents-listItem-descriptionTitle img').attr('src')||entry.find('.entry_icon img').attr('src')!);work.icon=(await media(iconUrl,'icons',no+'-source')).local;
    const sourceShots=new Set<string>();trs.eq(1).find('img[src]').each((_,e)=>{sourceShots.add(abs(q(e).attr('src')!));for(const attr of ['onmouseover','onmouseout'])for(const m of(q(e).attr(attr)||'').matchAll(/this\.src\s*=\s*['"]([^'"]+)/g))sourceShots.add(abs(m[1]));});const shots=[];for(const u of sourceShots)shots.push(await media(u,'screenshots',`${no}-source-${shots.length+1}`));if(shots.length)work.ss=shots.map(s=>s.local);
    const dl:WorkDownload[]=[],aux=[];const addLink=(u:string,label:string)=>{const parsed=new URL(u,base);if(!['http:','https:'].includes(parsed.protocol))return;if(!dl.some(d=>d.url===parsed.href))dl.push({url:parsed.href,label:label||'DL'});};
    if(card)card.find('.wrapUnder-contents-listItem-description a[href]').each((_,e)=>{const label=$(e).text().trim(),u=$(e).attr('href')!;if(/^【DL/.test(label))addLink(u,label);if(/^【感想】/.test(label))work.forum=abs(u);});
    else trs.eq(trs.length-2).find('a[href]').each((_,e)=>{const label=q(e).text().trim(),u=q(e).attr('href')!;if(/ダウンロード|DL/.test(label))addLink(u,label);if(/感想/.test(label))work.forum=abs(u);});
    if(dl.length){work.downloads=dl;work.download=dl[0];}const differences=[];for(const[label,value]of [['作者',catalogue['作者']],['ジャンル',catalogue['ジャンル']],['ツール',catalogue['使用ツール']],['配信/投稿',catalogue['配信/投稿']]])if(value&&norm(value)!==norm(fields[label]?.text||''))differences.push({label,catalogue:value,detail:fields[label]?.text||''});
    for(const d of differences)aux.push(`<p><strong>原紹介ページの${escape(d.label)}</strong><br>${escape(d.detail||'未記載')}</p>`);if(no==='00')aux.push('<p>［保存庫補記］この原サンプルは正式一覧に含まれず、01番の前ページから参照されています。別テンプレート entry000.html も原リンクどおり保存しています。</p>');if(aux.length)work.sourceContent=sanitize(aux.join('\n'));
    if(no==='42'){
      const local='/screenshots/2020-kouhaku/42.png',b=await fs.readFile('public'+local),archived=await fs.readFile(`${root}/source/resources/ss42-historical.bin`);
      if(!b.equals(archived)||hash(b)!=='2c89344d19da3c23bc31f6b37f9e4abe697eeb853c70e09f163b17268fa97125')throw new Error('Historical screenshot verification failed');
      work.ss!.push(local);work.sourceContent=(work.sourceContent||'')+'<p>［保存庫補記］最後のスクリーンショットは2021-01-02の保存記録に対応する旧版です。現サイトの表示・切替画像と区別して保持しています。</p>';
      shots.push({sourceUrl:'https://web.archive.org/web/20210102205333id_/https://viprpg2020kohaku.xxxxxxxx.jp/img/ss/ss42.png',local,sha256:hash(b)});
    }
    works.push(work);entries.push({id:work.id,no,detailUrl:url,catalogueTitle,detailTitle,catalogueMetadata:catalogue,sourceMetadata:Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v.text])),metadataDifferences:differences,sourceSample:no==='00',iconSourceUrl:iconUrl,screenshotSources:shots,hostImageSources:hostRows.flatMap(r=>q(r).find('img[src]').map((_,e)=>abs(q(e).attr('src')!)).get()),downloadLinks:dl,packagesDownloaded:false});
  };
  await make('00');for(const node of rows){const n=$(node).text().match(/No\.(\d+)/)?.[1];if(!n)throw new Error('Catalogue number missing');await make(n.padStart(2,'0'),$(node).closest('.wrapUnder-contents-listItem,.wrapUnder-contents-listItem2'));}
  if(works.length!==56||new Set(works.map(w=>w.id)).size!==56)throw new Error('Catalogue cardinality changed');
  const bannerSources=[];for(const img of $('img[src^="data:image/"]').filter((_,e)=>!$(e).closest('a').length).slice(0,3).toArray()){const raw=$(img).attr('src')!,b=Buffer.from(raw.slice(raw.indexOf(',')+1),'base64'),local=`/banners/${id}-source-${bannerSources.length+1}.${imageExtension(b)}`;await fs.writeFile('public'+local,b);bannerSources.push({sourceKind:'source-inline-data-image',sourceHtml:'source/live/index.bin',local,sha256:hash(b)});}
  if(bannerSources.length!==3)throw new Error('Source banner count changed');const festivals=await read<Festival[]>('src/data/festivals.json');festivals.find(f=>f.id===id)!.banners=bannerSources.map(b=>b.local);
  await fs.mkdir(`${root}/source/replay/generated`,{recursive:true});const gapHtml=`<!doctype html><html lang="ja"><meta charset="utf-8"><title>No.26 原一覧の空欄</title><main data-archive-generated="empty-catalogue-slot"><h1>No.26 原一覧の空欄</h1><p>原一覧には番号と共通画像だけがあり、題名・作者・紹介・配布情報は記載されていません。</p><p>原紹介ページは現サイト404、確認した精確存档照会にも記録はありません。内容を推測せず、この番号の資料枠を保持しています。</p><a href="${base}">原一覧に戻る</a></main></html>`;await fs.writeFile(`${root}/source/replay/generated/entry26.html`,gapHtml);resources[base+'entry26.html']='entry26.html';replay[base+'entry26.html']={originalUrl:base+'entry26.html',file:'generated/entry26.html',sha256:hash(Buffer.from(gapHtml)),sourceKind:'labelled-empty-catalogue-slot'};
  await writeJson(`${root}/source/replay/manifest.json`,replay);await writeJson(`src/data/works/${id}.json`,works);await writeJson('src/data/festivals.json',festivals);await writeJson(`${root}/recovery.json`,{festivalId:id,originalBase:base,liveSource:true,proxyRegion:'Japan',sourceManifests:['source/replay/manifest.json'],originalResources:resources,entries,bannerSources,generatedSourceGapNotices:[{path:'entry26.html'}],handling:'Direct archival without topic or image-pixel screening. Preserve the official 55 directory slots, including the explicitly empty No.26, and separately restore the published No.00 sample reached from No.01. Keep entry000 as an unlisted source template, not another work. Preserve screenshot slots and all organizer inline images in their distinct source roles. No game packages downloaded.',desktopReview:'pending'});
  console.log({works:works.length,realIntroductions:55,emptySlots:1,screenshots:works.reduce((s,w)=>s+(w.ss?.length||0),0),hostImageRefs:entries.reduce((s,e)=>s+(e.hostImageSources?.length||0),0),downloadEntries:works.filter(w=>w.download).length});
}
main().catch(e=>{console.error(e);process.exitCode=1;});
