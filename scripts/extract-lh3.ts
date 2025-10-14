import fs from "node:fs/promises";
import path from "node:path";

async function main(){
  const dir = path.join(process.cwd(), 'catch', '2019-summer');
  const files = ['games-and-bbs.md','entries.md','game-list.md','list.md','index_rjina.html'];
  for(const f of files){
    try{
      const txt = await fs.readFile(path.join(dir, f), 'utf8');
      const m = txt.match(/https?:\/\/lh3\.googleusercontent\.com\/sitesv\/[A-Za-z0-9_\-][^\s\)\]\"]*/);
      if(m){
        console.log(m[0]);
        return;
      }
    }catch{}
  }
  console.log('');
}

main().catch(e=>{ console.error(e); process.exit(1); });

