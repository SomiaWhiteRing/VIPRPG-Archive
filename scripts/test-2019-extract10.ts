import fs from "node:fs/promises";
function decodeHexEscapes(s:string){ return s.replace(/\\x([0-9A-Fa-f]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16))); }
async function run(){
  const outer = await fs.readFile('catch/2019-summer/game-39-outer.html','utf8');
  const m = outer.match(/goog\.script\.init\(("|')([\s\S]*?)\1\)/)!;
  const arg = decodeHexEscapes(m[2]!);
  const key='"userHtml":"'; const start=arg.indexOf(key); let i=start+key.length, buf='';
  for(;i<arg.length;i++){ const ch=arg[i]!; if(ch==='"'){ let k=i-1,bs=0; while(k>=0&&arg[k]==='\\'){bs++;k--;} if(bs===0) break; } buf+=ch; }
  const obj = JSON.parse('{"x":"'+ buf.replace(/\\/g,'\\\\').replace(/"/g,'\\"') +'"}') as {x:string};
  const html = JSON.parse('"'+ obj.x.replace(/\\/g,'\\\\').replace(/"/g,'\\"') +'"');
  console.log('html head', html.slice(0,80));
}
run().catch(e=>{ console.error(e); process.exit(1);});
