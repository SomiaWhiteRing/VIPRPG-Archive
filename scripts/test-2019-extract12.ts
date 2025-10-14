import fs from "node:fs/promises";
function decodeHexEscapes(s:string){ return s.replace(/\\x([0-9A-Fa-f]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16))); }
(async () => {
  const idx=39;
  const outer = await fs.readFile(`catch/2019-summer/game-${String(idx).padStart(2,'0')}-outer.html`,'utf8');
  const userHtmlMatch = outer.match(/goog\.script\.init\(("|')([\s\S]*?)\1\)/)!;
  const arg = decodeHexEscapes(userHtmlMatch[2]!);
  const uh = (() => { const k='"userHtml":"'; let i=arg.indexOf(k)+k.length, b=''; for(;i<arg.length;i++){ const ch=arg[i]!; if(ch==='"'){ let k2=i-1, bs=0; while(k2>=0 && arg[k2]==='\\'){bs++;k2--;} if(bs===0) break;} b+=ch;} return b; })();
  const m = uh.match(/globalDataes\s*=\s*JSON\.parse\((['"])([\s\S]*?)\1\)/);
  const mm = (m? m: (uh.match(/JSON\.parse\((['"])([\s\S]*?)\1\)/)) );
  if(!mm){ console.log('no globalDataes'); return; }
  let jsonSrc = mm[2]!;
  jsonSrc = jsonSrc.replace(/\\\"/g,'"').replace(/\\\//g,'/').replace(/\\n/g,'\n').replace(/\\r/g,'').replace(/\\t/g,'\t').replace(/\\\\/g,'\\');
  const arr = JSON.parse(jsonSrc) as Array<Record<string,string>>;
  const el = arr.find(e=> String(e.gameNo) === String(idx));
  console.log('found', !!el, el?.icon, el?.ss1, el?.ss2);
})();
