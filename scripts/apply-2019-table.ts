import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const FESTIVAL_ID = "2019-summer";
const APPS_EXEC_BASE = "https://script.google.com/macros/s/AKfycbxUhsUdhTG6F844hBnioDdGacKRTip815r48sgbP-pPUhoXuPsK/exec";

const ROOT = process.cwd();
const TABLE_PATH = path.join(ROOT, "tmp_2019table.html");
const WORKS_PATH = path.join(ROOT, "src", "data", "works", `${FESTIVAL_ID}.json`);
const ICONS_DIR = path.join(ROOT, "public", "icons", FESTIVAL_ID);
const REL_ICONS = `/icons/${FESTIVAL_ID}`;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36";

type Work = {
  id: string;
  festivalId: string;
  no: string; // '00'..'80'
  title: string;
  author: string;
  category?: string;
  engine?: string;
  streaming?: string;
  forum?: string;
  authorComment?: string;
  hostComment?: string;
  icon?: string;
  ss?: string[];
};

async function ensureDir(dir: string){ await fs.mkdir(dir, { recursive: true }); }

function toDownload(url: string){
  // drive view -> drive download
  const u = new URL(url);
  if(u.hostname === 'drive.google.com'){
    const id = u.searchParams.get('id') || '';
    if(id) return `https://drive.google.com/uc?export=download&id=${id}`;
  }
  return url;
}

function imageExtFromUrl(url: string){
  const base = url.split(/[?#]/)[0].toLowerCase();
  const ext = path.extname(base);
  if(ext) return ext === '.jpeg' ? '.jpg' : ext;
  return '.png';
}

async function fetchBinary(url: string){
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8' }, cache: 'no-store', redirect: 'follow', referrerPolicy: 'no-referrer' } as RequestInit);
  if(!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function parseTable(){
  const html = await fs.readFile(TABLE_PATH, 'utf8');
  const $ = cheerio.load(html);
  const out: Array<{ no: number; title?: string; author?: string; genre?: string; tool?: string; streaming?: string; iconSrc?: string }>=[];
  $('#gamelist tbody tr').each((_, tr) => {
    const $tr = $(tr);
    const noText = $tr.find('td.no a.text-danger').first().text().trim();
    const no = noText ? parseInt(noText, 10) : NaN;
    if(!Number.isFinite(no)) return;
    const authorCell = $tr.find('td.author').first().html() || '';
    const [author, streaming] = (authorCell.split('<br>') as string[]).map(s=> cheerio.load(`<a>${s}</a>`)('a').text().trim());
    const titleCell = $tr.find('td.title').first();
    const title = titleCell.find('a.text-success').first().text().trim();
    const genre = (titleCell.html()||'').split('<br>').slice(1).join('<br>');
    const genreText = cheerio.load(`<a>${genre}</a>`)('a').text().trim();
    const tool = ($tr.find('td.no').first().html()||'').split('<br>')[1] || '';
    const toolText = cheerio.load(`<a>${tool}</a>`)('a').text().trim();
    const iconSrc = $tr.find('td.icon img').attr('src') || undefined;
    out.push({ no, title, author, genre: genreText || undefined, tool: toolText || undefined, streaming: streaming || undefined, iconSrc });
  });
  return out;
}

async function main(){
  const table = await parseTable();
  const prev: Work[] = JSON.parse(await fs.readFile(WORKS_PATH, 'utf8')) as Work[];
  const prevMap = new Map<number, Work>();
  for(const w of prev){
    const n = parseInt(w.no, 10);
    if(Number.isFinite(n)) prevMap.set(n, w);
  }

  // 构建新的作品数组（不补零），包含 00
  const newWorks: Work[] = [];

  await ensureDir(ICONS_DIR);

  for(const row of table){
    const n = row.no;
    const no = String(n); // 不补零
    const old = prevMap.get(n);
    const w: Work = {
      id: `${FESTIVAL_ID}-${no}`,
      festivalId: FESTIVAL_ID,
      no,
      title: (old?.title || row.title || `Work ${no}`),
      author: (old?.author || row.author || ''),
      category: (old?.category || row.genre),
      engine: (old?.engine || row.tool),
      streaming: (old?.streaming || row.streaming),
      authorComment: old?.authorComment,
      hostComment: old?.hostComment,
      ss: old?.ss,
      forum: `${APPS_EXEC_BASE}?game=${n}`,
      icon: old?.icon,
    };
    // 下载或更新图标（按不补零命名）
    if(row.iconSrc){
      try{
        const url = toDownload(row.iconSrc);
        const buf = await fetchBinary(url);
        const ext = imageExtFromUrl(url);
        const file = `${no}${ext}`;
        await fs.writeFile(path.join(ICONS_DIR, file), buf);
        w.icon = path.posix.join(REL_ICONS, file);
      }catch{
        // ignore fetch issues
      }
    }
    newWorks.push(w);
  }

  // 排序与写回
  newWorks.sort((a,b)=> parseInt(a.no,10) - parseInt(b.no,10));
  await fs.writeFile(WORKS_PATH, JSON.stringify(newWorks, null, 2), 'utf8');
  console.log('Applied table, updated works:', WORKS_PATH);
}

main().catch((e)=>{ console.error(e); process.exit(1); });
