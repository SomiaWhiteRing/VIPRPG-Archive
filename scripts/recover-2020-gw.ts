import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { imageExtension, writeJson } from './recover-entry-table';
import type { Festival, WorkEntry, WorkDownload } from '../src/lib/types';

const id = '2020-gw', root = `catch/${id}`, base = 'https://vipgw2020.tubakurame.com/';
type H = { gameid: number; name_game: string; name_author: string; genre: string; tool: string; stream: string; comment: string; modified: number; game_url: string[] };
type S = { icon: string; ss: string[]; forum: string; a_com: string };
type Capture = { originalUrl: string; actualUrl: string; status: number; file: string; sha256: string; kind: string; usable?: boolean };
const read = async <T,>(p: string): Promise<T> => JSON.parse(await fs.readFile(p, 'utf8'));
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const norm = (s: string) => s.normalize('NFKC').replace(/\s/g, '');

async function main() {
  const pages = await read<Record<string, Capture>>(`${root}/source/live/manifest.json`), deps = await read<Record<string, Capture>>(`${root}/source/dependencies/manifest.json`), assets = await read<Record<string, Capture>>(`${root}/source/resources/manifest.json`);
  const old = await read<WorkEntry[]>(`${root}/investigation/pre-recovery-baseline.json`), samples = await read<Record<'top' | 'entries', { h: H; s: S }>>(`${root}/investigation/source-samples.json`);
  const h = await read<{ lastUpdate: number; games: H[] }>(`${root}/source/live/page-3.bin`), s = await read<{ games: S[] }>(`${root}/source/live/page-4.bin`);
  if (h.games.length !== 39 || s.games.length !== 39 || h.games.some((g, i) => Number(g.gameid) !== i + 1)) throw new Error('Source array identity/order changed');
  const resources: Record<string, string> = {}, buffers = new Map<string, Buffer>(), replay: Record<string, unknown> = {};
  for (const [dir, manifest] of [['live', pages], ['dependencies', deps], ['resources', assets]] as const) for (const c of Object.values(manifest)) {
    const b = await fs.readFile(`${root}/source/${dir}/${c.file}`); if (c.status !== 200 || c.usable === false || hash(b) !== c.sha256) throw new Error('Source payload verification failed');
    let local = new URL(c.originalUrl).pathname.slice(1) || 'index.html';
    if (c.kind === 'asset') {
      const ext = imageExtension(b), name = path.posix.basename(local), fixed = /^(default_(icon|ss1|ss2)|gw2020_[123])\.png$/.test(name);
      if (fixed && ext !== 'png') throw new Error('Source fixed image format changed');
      local = fixed ? 'img/' + name : `img/${hash(Buffer.from(c.originalUrl)).slice(0,24)}.${ext}`;
    } else if (c.originalUrl.includes('ajax.aspnetcdn.com')) local = 'dependencies/jquery-1.9.0.min.js';
    resources[c.originalUrl] = local; buffers.set(c.originalUrl, b); replay[c.originalUrl] = { ...c, file: `../${dir}/${c.file}` };
  }
  resources[base + 'index.html'] = 'index.html';
  const sourceImage = (name: string) => new URL('img/' + name, base).href;
  const sanitize = (html: string) => {
    const q = cheerio.load(`<div class="source-comment">${html}</div>`); q('script,style,iframe,noscript,object,embed,form').remove();
    q('*').each((_, e) => { for (const a of Object.keys(e.attribs)) if (a.startsWith('on') || ['id','style','width','height','align','bgcolor','face','color','size'].includes(a)) q(e).removeAttr(a); });
    q('img[src]').each((_, e) => { const u = new URL(q(e).attr('src')!, base).href; if (!resources[u]) throw new Error('Uncaptured organizer image'); q(e).attr('src', `/original-pages/${id}/${resources[u]}`); });
    q('a[href]').each((_, e) => { const u = new URL(q(e).attr('href')!, base); if (!['http:','https:','mailto:'].includes(u.protocol)) q(e).removeAttr('href'); else q(e).attr('href', u.href); });
    return q('body>div').toString();
  };
  const plain = (text: string) => { const q = cheerio.load('<p></p>'); q('p').text(text); return q('p').html()!.replace(/\r?\n/g,'<br>'); };
  const media = async (u: string, folder: string, name: string) => { const b = buffers.get(u); if (!b) throw new Error('Source image absent'); const local = `/${folder}/${id}/${name}.${imageExtension(b)}`; await fs.mkdir(path.dirname(`public${local}`),{recursive:true}); await fs.writeFile(`public${local}`,b); return {sourceUrl:u,local,sha256:hash(b)}; };
  const works: WorkEntry[] = [], entries = [], defaultRows = [], blankSlotRows = [];
  const pairs = [{h:samples.top.h,s:samples.top.s},...h.games.map((g,i)=>({h:g,s:s.games[i]}))];
  for (const pair of pairs) {
    const n = Number(pair.h.gameid), no = String(n), previous = old.find(w=>Number(w.no)===n); if (!previous || norm(previous.title)!==norm(pair.h.name_game)) throw new Error('Existing identity/title not corroborated');
    const iconName = pair.s.icon || 'default_icon.png', rawSs = pair.s.ss.filter(Boolean), screenshots = rawSs.length ? rawSs : ['default_ss1.png'];
    if (!rawSs.length || !pair.s.icon) defaultRows.push({no,defaultIcon:!pair.s.icon,defaultScreenshot:!rawSs.length});
    if (pair.s.ss.some(v=>!v)) blankSlotRows.push(no);
    const work: WorkEntry = {id:previous.id,festivalId:id,no:previous.no,title:previous.title,author:pair.h.name_author||'',source:{url:base+'entries.html?id='+no,titleUrl:base+'top.html'}};
    if (pair.h.genre) work.category=pair.h.genre; if (pair.h.tool) work.engine=pair.h.tool; if (pair.h.stream) work.streaming=pair.h.stream;
    if (pair.h.comment) work.authorComment=plain(pair.h.comment); if (pair.s.a_com) work.hostComment=sanitize(pair.s.a_com); if (pair.s.forum) work.forum=pair.s.forum;
    const links: WorkDownload[]=[]; for(const u of pair.h.game_url||[])if(u&&u!=='posted'){const parsed=new URL(u,base);if(['http:','https:'].includes(parsed.protocol)&&!links.some(d=>d.url===parsed.href))links.push({url:parsed.href,label:`DL${links.length+1}`});}
    if(links.length){work.downloads=links;work.download=links[0];}
    const supplements=[]; if(pair.h.game_url?.[0]==='posted')supplements.push('<p>［原配布状態］原データは「posted」です。ファイルURLは記載されていません。</p>');
    if(n===0){if(samples.entries.h.comment!==pair.h.comment)supplements.push('<h4>【原紹介ページ側のサンプルコメント】</h4>'+plain(samples.entries.h.comment));if(samples.entries.s.a_com!==pair.s.a_com)supplements.push('<h4>【原紹介ページ側の主催コメント】</h4>'+samples.entries.s.a_com);}
    if(supplements.length)work.sourceContent=sanitize(supplements.join('\n'));
    work.icon=(await media(sourceImage(iconName),'icons',no.padStart(2,'0')+'-source')).local;
    const shots=[];for(const name of [...new Set(screenshots)])shots.push(await media(sourceImage(name),'screenshots',`${no.padStart(2,'0')}-source-${shots.length+1}`));work.ss=shots.map(s=>s.local);
    works.push(work);entries.push({id:work.id,no,sourceMetadata:pair.h,sourceSupplement:pair.s,sourceIconUrl:sourceImage(iconName),screenshotSources:shots,sourceDefaultIcon:!pair.s.icon,sourceDefaultScreenshot:!rawSs.length,downloadLinks:links,packagesDownloaded:false});
  }
  const preparedS={games:s.games.map(g=>({...g,icon:path.posix.basename(resources[sourceImage(g.icon||'default_icon.png')]),ss:(g.ss.filter(Boolean).length?g.ss.filter(Boolean):['default_ss1.png']).map(f=>path.posix.basename(resources[sourceImage(f)])),a_com:sanitize(g.a_com)}))};
  const banners=[];for(const n of [1,2,3])banners.push(await media(base+`img/gw2020_${n}.png`,'banners',`current-source-${n}`));
  const festivals=await read<Festival[]>('src/data/festivals.json');festivals.find(f=>f.id===id)!.banners=banners.map(b=>b.local);
  await fs.mkdir(`${root}/source/replay/generated`,{recursive:true});
  const notices: Record<string,string> = {
    'archive-closed.html':'<!doctype html><html lang="ja"><meta charset="utf-8"><title>保存版の投稿機能</title><h1>保存庫による補記</h1><p>この静的保存版には投稿機能は含まれていません。保存済みの作品一覧・紹介・資料を確認できます。</p></html>',
    'archive-external.html':'<!doctype html><html lang="ja"><meta charset="utf-8"><title>外部ページの参照先</title><h1>保存庫による補記</h1><p>外部の掲示板・配布ページ本文はこの保存版には含まれません。整理版のDL・感想リンクから元ページを確認できます。</p><p>原URL：</p><code id="source-url" style="overflow-wrap:anywhere"></code><script>document.getElementById("source-url").textContent=new URLSearchParams(location.search).get("url")||"";</script></html>'
  };
  for(const[name,html]of Object.entries(notices)){const file='generated/'+name;await fs.writeFile(`${root}/source/replay/${file}`,html);resources[base+name]=name;replay[base+name]={originalUrl:base+name,file,sha256:hash(Buffer.from(html)),kind:'html',sourceKind:'labelled-static-archive-control-notice'};}
  await writeJson(`${root}/source/replay/manifest.json`,replay);await writeJson(`${root}/source/replay/snapshots.json`,{h,s:preparedS});
  await writeJson(`src/data/works/${id}.json`,works);await writeJson('src/data/festivals.json',festivals);
  await writeJson(`${root}/recovery.json`,{festivalId:id,originalBase:base,liveSource:true,proxyRegion:'Japan',sourceManifests:['source/replay/manifest.json'],originalResources:resources,entries,bannerSources:banners,sourceDefaultRows:defaultRows,blankScreenshotSlotRows:blankSlotRows,sourceSampleVariants:samples,sourceApi:{url:'https://viprpg-gw2020.herokuapp.com/entries',status:404,evidence:'investigation/heroku-entries.bin',publisherFallback:'data_h_local.json'},handling:'Direct source archival without topic or pixel screening. Use the publisher JSON fallback and literal sample objects; preserve all 40 existing identities. Empty source screenshot slots are omitted before replay to avoid the original loop overwriting valid first images. All-empty entries keep the source default image. All game package URLs are recorded without downloading packages.',desktopReview:'pending'});
  console.log({works:works.length,screenshots:works.reduce((a,w)=>a+(w.ss?.length||0),0),downloadEntries:works.filter(w=>w.download).length,defaultRows:defaultRows.length,blankSlotRows:blankSlotRows.length});
}
main().catch(e=>{console.error(e);process.exitCode=1;});
