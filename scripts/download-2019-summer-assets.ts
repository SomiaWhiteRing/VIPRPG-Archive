import fs from "node:fs/promises";
import path from "node:path";

const FESTIVAL_ID = "2019-summer";
const CATCH_DIR = path.join(process.cwd(), "catch", FESTIVAL_ID);
const OUTPUT_WORKS = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_ID}.json`);
const PUBLIC_DIR = path.join(process.cwd(), "public");
const ICONS_DIR = path.join(PUBLIC_DIR, "icons", FESTIVAL_ID);
const SCREENSHOTS_DIR = path.join(PUBLIC_DIR, "screenshots", FESTIVAL_ID);
const REL_ICONS = `/icons/${FESTIVAL_ID}`;
const REL_SS = `/screenshots/${FESTIVAL_ID}`;

const SMALL_LIMIT = 100;
const MAX_SS = 2; // 数据源只提供 ss1/ss2，保留两张
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36";

type Row = Record<string, string>;

async function ensureDir(dir: string){ await fs.mkdir(dir, { recursive: true }); }

function toDrive(s?: string){ if(!s) return undefined; if(/^https?:\/\//i.test(s)) return s; return `https://drive.google.com/uc?export=download&id=${s}`; }

function getImageExtension(input: string, fallback = ".png"){
  const base = input.split(/[?#]/)[0];
  const ext = path.extname(base).toLowerCase();
  if(ext === ".jpeg") return ".jpg";
  return ext || fallback;
}

function getImageDimensions(buffer: Buffer){
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 26 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1;
      if (offset + 1 >= buffer.length) break;
      const marker = buffer[offset + 1];
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (marker === 0xda) break;
      if (offset + 7 >= buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xcc) {
        if (offset + 5 >= buffer.length) break;
        const height = buffer.readUInt16BE(offset + 3);
        const width = buffer.readUInt16BE(offset + 5);
        return { width, height };
      }
      offset += length;
    }
  }
  if (buffer.length >= 10 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length >= 26 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    const width = buffer.readInt32LE(18);
    const height = Math.abs(buffer.readInt32LE(22));
    return { width, height };
  }
  return undefined;
}

async function fetchBinary(url: string){
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "image/*,*/*;q=0.8" }, cache: "no-store", redirect: "follow", referrerPolicy: "no-referrer" } as RequestInit);
  if(!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const ab = await res.arrayBuffer();
  return { buffer: Buffer.from(ab) };
}

async function readRowsFromLocal(): Promise<Row[]>{
  const html = await fs.readFile(path.join(CATCH_DIR, "game-39.html"), "utf8");
  const m = html.match(/globalDataes\s*=\s*JSON\.parse\((['"])([\s\S]*?)\1\)/);
  if(!m) throw new Error("no globalDataes");
  const quote = m[1];
  const body = m[2];
  const jsonText = (new Function(`return ${quote}${body}${quote};`))() as string;
  const cleaned = jsonText.replace(/\\(?!["\\\/bfnrtu])/g, "");
  return JSON.parse(cleaned) as Row[];
}

async function main(){
  await ensureDir(ICONS_DIR); await ensureDir(SCREENSHOTS_DIR);
  const rows = await readRowsFromLocal();

  // 读取现有 works，便于回填 icon/ss
  const works = JSON.parse(await fs.readFile(OUTPUT_WORKS, "utf8")) as Array<any>;

  for (let n = 1; n <= 80; n += 1){
    const el = rows.find(r => String(r.gameNo) === String(n));
    const idx = String(n).padStart(2, "0");
    if(!el) continue;
    const iconUrl = toDrive(el.icon);
    const ssUrls = [toDrive(el.ss1), toDrive(el.ss2)].filter(Boolean) as string[];
    let iconLocal: string | undefined = undefined;
    if(iconUrl){
      try{
        const { buffer } = await fetchBinary(iconUrl);
        // 图标允许小尺寸，直接保存
        const ext = getImageExtension(iconUrl, ".png");
        const file = `${idx}${ext}`;
        await fs.writeFile(path.join(ICONS_DIR, file), buffer);
        iconLocal = path.posix.join(REL_ICONS, file);
      }catch{}
    }
    const ssLocals: string[] = [];
    for (let i = 0; i < Math.min(ssUrls.length, MAX_SS); i++){
      const u = ssUrls[i]!;
      try{
        const { buffer } = await fetchBinary(u);
        const dim = getImageDimensions(buffer);
        if(dim && (dim.width < SMALL_LIMIT || dim.height < SMALL_LIMIT)) continue;
        const ext = getImageExtension(u, ".png");
        const file = `${idx}-${String(i+1).padStart(2,'0')}${ext}`;
        await fs.writeFile(path.join(SCREENSHOTS_DIR, file), buffer);
        ssLocals.push(path.posix.join(REL_SS, file));
      }catch{}
    }
    const w = works.find(x => x.no === idx);
    if(w){
      if(iconLocal) w.icon = iconLocal;
      if(ssLocals.length) w.ss = ssLocals;
    }
  }

  await fs.writeFile(OUTPUT_WORKS, JSON.stringify(works, null, 2), "utf8");
  console.log("Assets downloaded and works updated");
}

main().catch(e => { console.error(e); process.exit(1); });
