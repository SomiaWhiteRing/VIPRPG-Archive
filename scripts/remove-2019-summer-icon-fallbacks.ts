import fs from "node:fs/promises";
import path from "node:path";

const FESTIVAL_ID = "2019-summer";
const OUTPUT_WORKS = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_ID}.json`);
const ICONS_DIR = path.join(process.cwd(), "public", "icons", FESTIVAL_ID);

async function main(){
  const works = JSON.parse(await fs.readFile(OUTPUT_WORKS, 'utf8')) as Array<any>;
  let changed = false;
  for(const w of works){
    const icon: string | undefined = w.icon;
    if(icon && /\/icons\/2019-summer\/.+\-fromss\.[a-z0-9]+$/i.test(icon)){
      const rel = icon.replace(/^\//,'');
      const file = path.join(process.cwd(), 'public', path.sep === '/' ? rel : rel.replace(/\//g, path.sep));
      try{ await fs.unlink(file); } catch {}
      delete w.icon;
      changed = true;
    }
  }
  // 额外：删除目录下所有 *-fromss.* 文件
  try{
    const files = await fs.readdir(ICONS_DIR);
    await Promise.all(files.filter(f => /\-fromss\.[a-z0-9]+$/i.test(f)).map(f => fs.unlink(path.join(ICONS_DIR, f)).catch(()=>undefined)));
  }catch{}
  if(changed){
    await fs.writeFile(OUTPUT_WORKS, JSON.stringify(works, null, 2), 'utf8');
    console.log('Removed fallback icons and updated works');
  }else{
    console.log('No fallback icons in works; cleaned files if any');
  }
}

main().catch(e=>{ console.error(e); process.exit(1); });
