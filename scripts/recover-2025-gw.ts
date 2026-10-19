import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { writeJson } from './recover-entry-table';
import type { WorkEntry } from '../src/lib/types';

const id='2025-gw',root=`catch/${id}`,overviewUrl='https://itch.io/jam/vip-gw2025';
type Capture={originalUrl:string;actualUrl:string;status:number;file:string;sha256:string;retrievedAt:string;no?:string;kind?:string};
type Row={no:string;title:string;author:string;category:string;engine:string;streaming:string;iconUrl:string;rateUrl:string;downloadUrl?:string;forumUrl?:string;gameUrl:string;gameId:number};
type Asset={originalUrl:string;local:string;sha256:string;roles:string[];format:string;width?:number;height?:number};
const read=async<T,>(file:string):Promise<T>=>JSON.parse(await fs.readFile(file,'utf8'));
const normalize=(value:string)=>value.normalize('NFKC').replace(/\s/g,'');

async function main(){
  const live=await read<Record<string,Capture>>(`${root}/source/live/manifest.json`);
  const styles=await read<Record<string,Capture>>(`${root}/source/styles/manifest.json`);
  const assets=await read<Record<string,Capture>>(`${root}/source/assets/manifest.json`);
  for(const [directory,manifest]of [['live',live],['styles',styles],['assets',assets]] as const)for(const capture of Object.values(manifest)){
    const bytes=await fs.readFile(`${root}/source/${directory}/${capture.file}`);
    if(capture.status!==200||createHash('sha256').update(bytes).digest('hex')!==capture.sha256)throw new Error('Source cache not verified');
  }
  const replay=await read<{originalResources:Record<string,string>;assets:Asset[]}>(`${root}/investigation/original-resource-map.json`);
  const rows=await read<Row[]>(`${root}/investigation/live-catalogue-rows.json`);
  const legacy=await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`);
  const entriesData=await read<{jam_games:Array<{game:{id:number;short_text?:string}}> }>(`${root}/investigation/live-entries-data.json`);
  const byUrl=new Map(replay.assets.map(asset=>[asset.originalUrl,asset]));
  const resource=(url:string)=>{const u=new URL(url);u.hash='';return byUrl.get(u.href.replace(/\?$/,''));};
  const sanitize=(html:string,owner:string)=>{
    const $=cheerio.load(`<div>${html}</div>`);
    $('script,style,noscript,iframe,form,object,embed,link,meta').remove();
    $('img').each((_,img)=>{const source=$(img).attr('src')||$(img).attr('data-lazy_src')||$(img).attr('data-src');if(!source){$(img).remove();return;}const url=new URL(source,owner).href,asset=resource(url);$(img).attr('src',asset?`/original-pages/${id}/${asset.local}`:url).removeAttr('srcset').removeAttr('data-lazy_src').removeAttr('data-src');});
    $('*').each((_,element)=>{for(const attribute of Object.keys(element.attribs))if(attribute.startsWith('on')||['style','width','height','align','bgcolor','background','color','face','size'].includes(attribute))$(element).removeAttr(attribute);});
    $('a[href]').each((_,a)=>{const raw=$(a).attr('href')!;if(raw.startsWith('#'))return;const url=new URL(raw,owner);if(!['http:','https:','mailto:'].includes(url.protocol)){$(a).removeAttr('href');return;}const asset=url.protocol==='mailto:'?undefined:resource(url.href);$(a).attr('href',asset?`/original-pages/${id}/${asset.local}${url.hash}`:url.href);});
    return $('body>div').html()?.trim()||'';
  };
  const works:WorkEntry[]=[],entries=[],titleVariants=[];
  for(const row of rows){
    const no=String(Number(row.no)).padStart(2,'0'),gameCapture=live[row.gameUrl],rateCapture=live[row.rateUrl];
    if(!gameCapture||!rateCapture)throw new Error('Missing live page');
    const $game=cheerio.load(await fs.readFile(`${root}/source/live/${gameCapture.file}`,'utf8')),$rate=cheerio.load(await fs.readFile(`${root}/source/live/${rateCapture.file}`,'utf8'));
    for(const $ of [$game,$rate])if(!$('[data-game_id]').toArray().some(element=>Number($(element).attr('data-game_id'))===row.gameId))throw new Error('Game identifier mismatch');
    const prior=legacy.find(work=>Number(work.no)===Number(row.no));
    if(!prior||normalize(prior.title)!==normalize(row.title))throw new Error('Overview title requires reconciliation');
    if(!normalize($rate('body').text()).includes(normalize(prior.title)))throw new Error('Official rate page does not corroborate retained title');
    const work:WorkEntry={id:prior.id,festivalId:id,no:row.no,title:prior.title,author:row.author,category:row.category,engine:row.engine,streaming:row.streaming,source:{url:gameCapture.actualUrl,titleUrl:row.rateUrl},forum:new URL(row.forumUrl||row.rateUrl,overviewUrl).href};
    const gameTitle=$game('h1.game_title').text().trim();
    if(gameTitle&&normalize(gameTitle)!==normalize(work.title)){work.originalTitle=gameTitle;titleVariants.push({no:row.no,primarySource:row.rateUrl,originalTitleSource:gameCapture.actualUrl});}
    const icon=resource(new URL(row.iconUrl,overviewUrl).href);
    if(!icon)throw new Error('Missing table icon');
    const iconLocal=`/icons/${id}/${no}-source.${icon.format==='jpeg'?'jpg':icon.format}`;
    await fs.mkdir(path.dirname(`public${iconLocal}`),{recursive:true});
    await fs.copyFile(`${root}/source/assets/${assets[icon.originalUrl].file}`,`public${iconLocal}`);
    work.icon=iconLocal;
    const screenshots=[],screenshotSources=[];
    for(const anchor of $game('.screenshot_list a[href]').toArray()){
      const url=new URL($game(anchor).attr('href')!,gameCapture.actualUrl).href,asset=resource(url);
      if(!asset)throw new Error('Missing gallery original');
      const local=`/screenshots/${id}/${no}-source-${screenshots.length+1}.${asset.format==='jpeg'?'jpg':asset.format}`;
      await fs.mkdir(path.dirname(`public${local}`),{recursive:true});
      await fs.copyFile(`${root}/source/assets/${assets[asset.originalUrl].file}`,`public${local}`);
      screenshots.push(local);screenshotSources.push({originalUrl:url,local,width:asset.width,height:asset.height,sha256:asset.sha256});
    }
    if(screenshots.length)work.ss=screenshots;
    let authorComment:string|undefined;
    $rate('section.field_responses p').each((_,p)=>{if($rate(p).find('strong').first().text().trim()!=='作者コメント')return;const clone=$rate(p).clone();clone.find('strong').first().remove();const html=sanitize(clone.html()||'',rateCapture.actualUrl).replace(/^(?:\s|<br\s*\/?>)+/i,'').trim();if(html)authorComment=html;});
    if(authorComment)work.authorComment=authorComment;
    const descriptionBlocks=$game('.formatted_description').toArray().filter(element=>!$game(element).closest('.community_post').length).map(element=>sanitize($game(element).html()||'',gameCapture.actualUrl)).filter(Boolean);
    if(!descriptionBlocks.length){const shortText=entriesData.jam_games.find(entry=>entry.game.id===row.gameId)?.game.short_text;if(shortText){const $plain=cheerio.load('<p></p>');$plain('p').text(shortText);descriptionBlocks.push($plain('p').toString());}}
    const extraResponses=$rate('section.field_responses p').toArray().filter(p=>!['ジャンル','使用ツール','配信・動画化の可否','作者コメント','感想・バグ報告先'].includes($rate(p).find('strong').first().text().trim())).map(p=>sanitize($rate(p).toString(),rateCapture.actualUrl));
    if(descriptionBlocks.length||extraResponses.length)work.sourceContent=[...descriptionBlocks,...extraResponses].join('\n<hr>\n');
    const officialPosts=[];
    for(const post of $rate('.community_post').toArray()){
      const author=$rate(post).find('.post_header .post_author a').first().attr('href')||'';
      if(author!=='/profile/vipgw2025'&&!author.startsWith('https://vipgw2025.itch.io'))continue;
      const content=$rate(post).find('.post_content .post_body').first().html()||'';
      if(content)officialPosts.push({id:$rate(post).attr('id')||$rate(post).attr('data-post_id'),html:sanitize(content,rateCapture.actualUrl)});
    }
    if(officialPosts.length)work.hostComment=officialPosts.map(post=>post.html).join('\n<hr>\n');
    const download=new URL(row.downloadUrl||row.gameUrl,overviewUrl).href;
    work.download={url:download,label:'Source download'};
    work.downloads=[work.download,...(download!==row.gameUrl?[{url:row.gameUrl,label:'itch.io project'}]:[])];
    works.push(work);entries.push({no:row.no,gameId:row.gameId,gameCapture,rateCapture,overviewSource:overviewUrl,icon:{sourceUrl:row.iconUrl,local:iconLocal,sha256:icon.sha256},screenshotSources,descriptionBlocks:descriptionBlocks.length,authorCommentPresent:!!authorComment,officialPosts:officialPosts.map(post=>post.id),downloadEntry:download,packageBytesDownloaded:false});
  }
  if(works.length!==30||entries.reduce((sum,entry)=>sum+entry.screenshotSources.length,0)!==60)throw new Error('Incomplete source catalogue or gallery');
  const overview=cheerio.load(await fs.readFile(`${root}/source/live/${live[overviewUrl].file}`,'utf8'));
  const bannerUrl=overview('.jam_content img[src]').toArray().map(img=>overview(img).attr('src')!).find(src=>/img\.itch\.zone\/aW1n/i.test(src));
  if(!bannerUrl)throw new Error('Source banner missing');
  const banner=resource(bannerUrl);if(!banner)throw new Error('Banner payload missing');
  const bannerLocal=`/banners/${id}-source.${banner.format==='jpeg'?'jpg':banner.format}`;
  await fs.copyFile(`${root}/source/assets/${assets[banner.originalUrl].file}`,`public${bannerLocal}`);
  const festivals=await read<Array<{id:string;banners:string[]}>>('src/data/festivals.json');
  festivals.find(festival=>festival.id===id)!.banners=[bannerLocal];
  await writeJson('src/data/festivals.json',festivals);await writeJson(`src/data/works/${id}.json`,works);
  await writeJson(`${root}/investigation/title-provenance-review.json`,{allRetainedNamesCorroboratedByOfficialRatePages:true,variants:titleVariants});
  await writeJson(`${root}/investigation/original-timemap.bin`,[]);
  const screenshotPage2 = await read<{status:number;file:string;sha256:string;numItems:number}>(`${root}/investigation/screenshots-pagination.json`);
  const screenshotPage3 = await read<{status:number;file:string;sha256:string;numItems:number}>(`${root}/investigation/screenshots-pagination-end.json`);
  for (const page of [screenshotPage2,screenshotPage3]) if(page.status!==200||createHash('sha256').update(await fs.readFile(`${root}/source/live/${page.file}`)).digest('hex')!==page.sha256)throw new Error('Screenshot pagination source not verified');
  if(screenshotPage2.numItems!==4||screenshotPage3.numItems!==0)throw new Error('Screenshot overview boundaries changed');
  const screenshotOverview={initialItems:40,additionalItems:4,totalItems:44,appendSourceFile:`source/live/${screenshotPage2.file}`,endEvidence:`${root}/investigation/screenshots-pagination-end.json`};
  await writeJson(`${root}/recovery.json`,{festivalId:id,originalBase:'https://itch.io/jam/vip-gw2025/',liveSource:true,proxyRegion:'Japan',entries,screenshotOverview,screenshotReferences:60,legacyScreenshotReferences:53,additionalGalleryRows:[{no:'5',before:6,after:9},{no:'10',before:6,after:10}],titleVariants,originalResources:replay.originalResources,banner:{sourceUrl:bannerUrl,local:bannerLocal,width:banner.width,height:banner.height,sha256:banner.sha256},sourceManifests:['source/live/manifest.json','source/styles/manifest.json','source/assets/manifest.json'],sourceEvidence:[`${root}/investigation/live-page-verification.json`,`${root}/investigation/gallery-resource-verification.json`,`${root}/investigation/title-provenance-review.json`,`${root}/investigation/pre-recovery-local-assets.json`],handling:'Archive current public source data directly without content screening. Keep names corroborated by official jam/rate pages, record the current project-title variation separately, and include every linked gallery original without the former six-image cap. Preserve existing source snapshots and assets. Download entries are canonical public pages, not expiring generated URLs; no game package was downloaded.',desktopReview:'pending'});
  console.log(JSON.stringify({works:works.length,screenshots:60,icons:works.filter(work=>work.icon).length,authorComments:works.filter(work=>work.authorComment).length,hostComments:works.filter(work=>work.hostComment).length,sourceContent:works.filter(work=>work.sourceContent).length,downloadEntries:works.filter(work=>work.download).length,titleVariants:titleVariants.length}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
