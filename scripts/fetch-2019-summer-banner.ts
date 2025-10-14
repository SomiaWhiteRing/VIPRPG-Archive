import fs from "node:fs/promises";
import path from "node:path";

const CATCH_DIR = path.join(process.cwd(), "catch", "2019-summer");
const OUT_DIR = path.join(process.cwd(), "public", "banners");
const OUT_BASE = "2019-summer";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36";

async function ensureDir(dir: string){ await fs.mkdir(dir, { recursive: true }); }

function pickBannerSource(text: string): string | undefined {
  const rx = /https?:\/\/lh3\.googleusercontent\.com\/sitesv\/[A-Za-z0-9_\-]+[^\s\)"']+/g;
  const m = text.match(rx);
  return m?.[0];
}

async function fetchBinary(url: string){
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "image/*" }, cache: "no-store", redirect: "follow", referrerPolicy: "no-referrer" } as RequestInit);
  if(!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const ab = await res.arrayBuffer();
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  return { buffer: Buffer.from(ab), contentType: ct };
}

function extFromContentType(ct: string){
  if(ct.includes("jpeg")) return ".jpg";
  if(ct.includes("png")) return ".png";
  if(ct.includes("webp")) return ".webp";
  return ".jpg";
}

async function main(){
  const files = ["entries.md", "game-list.md", "games-and-bbs.md", "index_rjina.html"]; 
  let url: string | undefined;
  for(const f of files){
    try{
      const text = await fs.readFile(path.join(CATCH_DIR, f), 'utf8');
      url = pickBannerSource(text);
      if(url) break;
    }catch{}
  }
  if(!url) throw new Error("未在缓存中找到 Google Sites 图像链接，无法生成 banner");
  const { buffer, contentType } = await fetchBinary(url);
  await ensureDir(OUT_DIR);
  const ext = extFromContentType(contentType);
  const file = path.join(OUT_DIR, `${OUT_BASE}${ext}`);
  await fs.writeFile(file, buffer);
  console.log("Saved banner:", file);
}

main().catch(e=>{ console.error(e); process.exit(1); });

