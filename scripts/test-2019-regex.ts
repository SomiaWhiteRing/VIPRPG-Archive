import fs from "node:fs/promises";
(async ()=>{
  const html = await fs.readFile('catch/2019-summer/game-39.html','utf8');
  const m = html.match(/globalDataes\s*=\s*JSON\.parse\((['"])([\s\S]*?)\1\)/);
  console.log('mm?', !!m);
  if(m){ console.log('caplen', m[2].length); }
})();
