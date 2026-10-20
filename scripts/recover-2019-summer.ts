import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { imageExtension, writeJson } from './recover-entry-table';
import { decodeSummer2019Wrapper, readSummer2019Data, createSummer2019Replay } from './source-2019-summer-view';
import type { Festival, WorkEntry, WorkDownload } from '../src/lib/types';

const id='2019-summer',root=`catch/${id}`,site='https://sites.google.com/view/viprpg2019summer/';
const app='https://script.google.com/macros/s/AKfycbxUhsUdhTG6F844hBnioDdGacKRTip815r48sgbP-pPUhoXuPsK/exec';
const sheet='https://docs.google.com/spreadsheets/d/1c7LeV1beJeaPQlkZfNx3kkdbXTXYiQ5laT9TY123qPA/';
type Capture={originalUrl:string;file:string;status:number;sha256:string;kind:string;contentType?:string;id?:string};
const read=async<T,>(p:string):Promise<T>=>JSON.parse(await fs.readFile(p,'utf8'));
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const norm=(s:string)=>s.normalize('NFKC').replace(/\s/g,'');

async function main(){
  await fs.mkdir(`${root}/source/replay/generated`,{recursive:true});
  const baseline=`${root}/investigation/pre-recovery-baseline.json`;
  if(!await fs.access(baseline).then(()=>true,()=>false))await fs.copyFile(`src/data/works/${id}.json`,baseline);
  const old=await read<WorkEntry[]>(baseline),archive=await read<{app:{cdxDigestMatches:boolean;decodedFile:string;decodedSha256:string;snapshotUrl:string;timestamp:string;originalUrl:string}}>(`${root}/source/archive/manifest.json`);
  const outer=await fs.readFile(`${root}/source/archive/${archive.app.decodedFile}`);
  if(!archive.app.cdxDigestMatches||hash(outer)!==archive.app.decodedSha256)throw new Error('Dated archive payload is not verified');
  const html=decodeSummer2019Wrapper(outer.toString('utf8')),{entries,board}=readSummer2019Data(html);
  const images=await read<Record<string,Capture>>(`${root}/source/images/manifest.json`),deps=await read<Record<string,Capture>>(`${root}/source/dependencies/manifest.json`);
  const resources:Record<string,string>={},buffers=new Map<string,Buffer>(),replay:Record<string,unknown>={},imageMap:Record<string,string>={};
  for(const cap of Object.values(images)){
    const b=await fs.readFile(`${root}/source/images/${cap.file}`);if(cap.status!==200||hash(b)!==cap.sha256||!cap.id)throw new Error('Image source is incomplete');
    const local=`images/${cap.id}.${imageExtension(b)}`;resources[cap.originalUrl]=local;buffers.set(cap.id,b);imageMap[cap.id]=`/original-pages/${id}/${local}`;replay[cap.originalUrl]={...cap,file:`../images/${cap.file}`};
  }
  for(const cap of Object.values(deps)){
    if(cap.status!==200)continue;const b=await fs.readFile(`${root}/source/dependencies/${cap.file}`);if(hash(b)!==cap.sha256)throw new Error('Dependency payload changed');
    let ext:string;
    if(cap.kind==='css')ext='css';else if(cap.kind==='script')ext='js';else if(cap.contentType?.includes('svg'))ext='svg';else if(cap.kind==='image'||cap.contentType?.startsWith('image/'))ext=imageExtension(b);else if(b.subarray(0,4).toString()==='wOF2')ext='woff2';else if(b.subarray(0,4).toString()==='wOFF')ext='woff';else {ext=path.extname(new URL(cap.originalUrl).pathname).slice(1);if(!['ttf','woff','woff2','eot','png','svg'].includes(ext))throw new Error('Unknown stylesheet resource type');}
    resources[cap.originalUrl]=`assets/${hash(cap.originalUrl).slice(0,20)}.${ext}`;replay[cap.originalUrl]={...cap,file:`../dependencies/${cap.file}`};
  }
  const sourceSite=cheerio.load(await fs.readFile(`${root}/source/live/index.bin`,'utf8')),currentLogo=sourceSite('img').first().attr('src')!,oldLogo=(await read<{originalUrl:string}>(`${root}/investigation/historical-banner-source.json`)).originalUrl;
  const banner=await fs.readFile(`public/banners/${id}.png`),bannerExt=imageExtension(banner),bannerPath=`/banners/${id}-source.${bannerExt}`;
  await fs.writeFile('public'+bannerPath,banner);await fs.writeFile(`${root}/source/replay/generated/site-logo.${bannerExt}`,banner);
  resources[currentLogo]=`site-logo.${bannerExt}`;replay[currentLogo]={originalUrl:currentLogo,file:`generated/site-logo.${bannerExt}`,sha256:hash(banner),sourceKind:'labelled-historical-festival-banner',liveSourceStatus:403,legacySourceUrl:oldLogo,legacySourceFile:`${root}/entries.md`,legacyBytesFile:`public/banners/${id}.png`,captureDateConfirmed:false};
  const derived=async(url:string,local:string,file:string,text:string,origin:Record<string,unknown>)=>{await fs.writeFile(`${root}/source/replay/generated/${file}`,text);resources[url]=local;replay[url]={originalUrl:url,file:`generated/${file}`,sha256:hash(text),sourceKind:'derived-source-replay',...origin};};
  resources[site]='index.html';resources[site+'Home']='index.html';resources[site+'home']='index.html';resources[app]='app/index.html';for(const e of entries)resources[app+'?game='+e.gameNo]='app/index.html';resources[app+'?game=0&list=true']='app/index.html';
  const updates=sheet+'gviz/tq?tqx=out:html';resources[sheet+'htmlembed']='updates.html';
  const table=cheerio.load(await fs.readFile(`${root}/source/live/updates-table.bin`,'utf8'));table('script').remove();table('head').append('<style>table{width:100%;table-layout:fixed;border-collapse:collapse}td,th{overflow-wrap:anywhere;padding:4px}body{margin:8px;font:14px sans-serif}</style>');
  await derived(updates,'updates.html','updates.html',table.html(),{liveSourceUrl:updates,rawFile:'source/live/updates-table.bin',rows:table('tr').length-1});
  sourceSite('script,noscript,base,link[rel=preload],link[rel=preconnect],link[rel=dns-prefetch],link[rel=icon]').remove();
  sourceSite('iframe[data-src]').each((_,e)=>{const raw=sourceSite(e).attr('data-src')!;if(raw!==sheet+'htmlembed')throw new Error('Unknown source embed');sourceSite(e).attr('src',updates).removeAttr('data-src loading');});
  sourceSite('body').prepend('<p data-archive-notice style="padding:8px;background:#f1f5f8;border:1px solid #aab7c4">保存資料：作品一覧は2025-10-11の公開応答から再生します。現在403の頁頭画像には、同祭典の旧保存横幅を代替表示しています。</p>');
  await derived(site,'index.html','site.html',sourceSite.html(),{liveSourceUrl:site,rawFile:'source/live/index.bin',historicalLogoFallback:true});
  await derived(app+'?game=0&list=true','app/index.html','app.html',createSummer2019Replay(html,imageMap),{snapshotUrl:archive.app.snapshotUrl,snapshotOriginalUrl:archive.app.originalUrl,snapshotTimestamp:archive.app.timestamp,rawFile:`source/archive/${archive.app.decodedFile}`});
  const media=async(key:string,folder:string,name:string)=>{const b=buffers.get(key);if(!b)throw new Error('Missing publisher image');const local=`/${folder}/${id}/${name}.${imageExtension(b)}`;await fs.mkdir(path.dirname('public'+local),{recursive:true});await fs.writeFile('public'+local,b);return local;};
  const sanitize=(value:string)=>{const q=cheerio.load(`<div>${value}</div>`);q('script,iframe,object,embed,form,style').remove();q('*').each((_,e)=>{for(const a of Object.keys(e.attribs))if(a.startsWith('on'))q(e).removeAttr(a);});q('img[src]').each((_,e)=>{const u=q(e).attr('src')!;if(!resources[u])throw new Error('Uncaptured author inline image');q(e).attr('src',`/original-pages/${id}/${resources[u]}`);});return q('body>div').toString();};
  const works:WorkEntry[]=[],records=[];for(const e of entries){const previous=old.find(w=>Number(w.no)===Number(e.gameNo));if(!previous||norm(previous.title)!==norm(e.title))throw new Error(`Publisher title mismatch ${e.gameNo}`);
    const work:WorkEntry={id:previous.id,festivalId:id,no:previous.no,title:previous.title,author:e.author,category:e.genre,engine:e.tkool==='other'?e.tkool_other:e.tkool,streaming:e.video==='other'?e.video_other:e.video,source:{url:app+'?game='+e.gameNo,snapshotUrl:archive.app.snapshotUrl},forum:`/original-pages/${id}/app/index.html?game=${e.gameNo}#pageMiddle`,authorComment:sanitize(e.comment_author),icon:await media(e.icon||'1D_4Xt0GvJkq9aEr6tSgLtHlFnr-uljC3','icons',e.gameNo+'-source')};
    const screenshots=[];for(const key of [e.ss1,e.ss2].filter(Boolean))screenshots.push(await media(key,'screenshots',`${e.gameNo}-source-${screenshots.length+1}`));if(screenshots.length)work.ss=screenshots;
    const downloads:WorkDownload[]=[];for(const[key,label]of [['game','本体'],['patch','多目的ファイル']])if(e[key]&&e[key]!=='false'){if(!/^[A-Za-z0-9_-]+$/.test(e[key]))throw new Error('Unexpected package identifier');downloads.push({url:`https://drive.google.com/file/d/${e[key]}/view?usp=drivesdk`,label});}if(downloads.length){work.downloads=downloads;work.download=downloads[0];}
    work.sourceContent=sanitize(`<p>［保存庫補記］原サービスはRhino実行基盤の廃止で停止しています。作品・掲示板は2025-10-11の公開応答を保存した資料です。</p><p><a href="/original-pages/${id}/app/index.html?game=${e.gameNo}#pageMiddle">保存された掲示板を読む</a></p>`);works.push(work);records.push({id:work.id,no:e.gameNo,submissionRow:e.entryNo,sourceUrl:work.source!.url,screenshotImageIds:[e.ss1,e.ss2].filter(Boolean),iconImageId:e.icon||'1D_4Xt0GvJkq9aEr6tSgLtHlFnr-uljC3',downloads,packagesDownloaded:false});
  }
  const festivals=await read<Festival[]>('src/data/festivals.json');festivals.find(f=>f.id===id)!.banners=[bannerPath];
  await writeJson(`${root}/source/replay/manifest.json`,replay);await writeJson(`src/data/works/${id}.json`,works);await writeJson('src/data/festivals.json',festivals);
  await writeJson(`${root}/recovery.json`,{festivalId:id,originalBase:site,liveSource:true,sourceManifests:['source/replay/manifest.json'],originalResources:resources,entries:records,sourceSnapshot:archive.app,boardRows:board.length,visibleBoardRows:board.filter(p=>!p.del).length,sourceGaps:[{kind:'omitted-platform-favicon',message:'Not retrieved after the temporary Japan route exited; source availability is not determined.'},{kind:'live-app-runtime',message:'Current public Apps Script fails because Rhino was discontinued; dated public dataset and board retained.'},{kind:'current-site-logo',status:403,legacySourceUrl:oldLogo,local:bannerPath,captureDateConfirmed:false}],bannerSources:[{local:bannerPath,sourceKind:'historical-local-festival-banner',sourceUrl:oldLogo,sha256:hash(banner)}],handling:'Preserve all52 published records, including two boards and one sample, and all780 source board rows. Original script controls visibility using original del/author/admin flags. No topic or pixel screening; no game packages downloaded. Posting and remote counters are disabled.',desktopReview:'pending'});
  console.log({works:works.length,screenshots:works.reduce((n,w)=>n+(w.ss?.length||0),0),downloadEntries:works.filter(w=>w.download).length,downloadReferences:works.reduce((n,w)=>n+(w.downloads?.length||0),0),sourceBoardRows:board.length,replaySources:Object.keys(replay).length});
}
main().catch(e=>{console.error(e);process.exitCode=1;});
