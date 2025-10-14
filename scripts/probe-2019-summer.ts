import fs from "node:fs/promises";
function decodeHexEscapes(s: string){ return s.replace(/\\x([0-9A-Fa-f]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16))); }
(async () => {
  const outer = await fs.readFile('catch/2019-summer/game-39-outer.html','utf8');
  const m = outer.match(/goog\.script\.init\(("|')([\s\S]*?)\1\)/)!;
  const arg = decodeHexEscapes(m[2]!);
  const key='"userHtml":"'; let i=arg.indexOf(key)+key.length, buf='';
  for(;i<arg.length;i++){ const ch=arg[i]!; if(ch==='"'){ let k=i-1, bs=0; while(k>=0 && arg[k]==='\\'){bs++;k--;} if(bs===0) break; } buf+=ch; }
  const mm = buf.match(/globalDataes\s*=\s*JSON\.parse\((['"])([\s\S]*?)\1\)/);
  if(!mm){ console.log('no globalDataes'); return; }
  const arr = (new Function(`return JSON.parse(${JSON.stringify(mm[2])});`))() as Array<Record<string,string>>;
  console.log('ok', arr.length, arr[3]?.title);
})();