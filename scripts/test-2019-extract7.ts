import fs from "node:fs/promises";

function decodeHexEscapes(s: string) {
  return s.replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

async function run(){
  const outer = await fs.readFile('catch/2019-summer/game-39-outer.html','utf8');
  const m = outer.match(/goog\.script\.init\(("|')([\s\S]*?)\1\)/);
  if(!m){ console.log('no match'); return; }
  const arg = decodeHexEscapes(m[2]!);
  const key = '"userHtml":"';
  const start = arg.indexOf(key);
  console.log('start', start);
  let i = start + key.length;
  let buf = '';
  for (; i < arg.length; i++) {
    const ch = arg[i]!;
    if (ch === '"') {
      let k = i - 1, bs = 0;
      while (k >= 0 && arg[k] === '\\') { bs += 1; k -= 1; }
      if (bs === 0) break;
    }
    buf += ch;
  }
  console.log('end at', i, 'bufLen', buf.length);
  const html = JSON.parse('"'+buf+'"');
  console.log('html len', html.length);
}

run().catch(err => { console.error(err); process.exit(1); });
