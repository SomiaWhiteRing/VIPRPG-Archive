import fs from "node:fs/promises";

function decodeHexEscapes(s: string) {
  return s.replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

async function run(){
  const outer = await fs.readFile('catch/2019-summer/game-39-outer.html','utf8');
  const m = outer.match(/goog\.script\.init\(("|')([\s\S]*?)\1\)/);
  if(!m){ console.log('no init'); return; }
  const argHex = decodeHexEscapes(m[2]!);
  console.log('argHex head', argHex.slice(0,200));
  const esc = argHex.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const dequoted = JSON.parse('"'+esc+'"');
  console.log('dequoted head', dequoted.slice(0,200));
  const obj = JSON.parse(dequoted);
  console.log('keys', Object.keys(obj));
  console.log('userHtml head', (obj.userHtml as string).slice(0,60));
}

run().catch(e=>{ console.error(e); process.exit(1);});

