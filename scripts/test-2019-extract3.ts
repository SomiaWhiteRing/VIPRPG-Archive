import fs from "node:fs/promises";

function decodeHexEscapes(s: string) {
  return s.replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

async function run() {
  const outer = await fs.readFile('catch/2019-summer/game-39-outer.html','utf8');
  const m = outer.match(/goog\.script\.init\(("|')([\s\S]*?)\1\)/);
  if(!m){ console.log('no match for init'); return; }
  const arg = m[2];
  const dec = decodeHexEscapes(arg);
  console.log('dec len', dec.length);
  console.log('userHtml index', dec.indexOf('"userHtml":"'));
  // Also dump a short slice around it
  const idx = dec.indexOf('userHtml');
  if (idx >= 0) {
    console.log(dec.slice(Math.max(0, idx-20), Math.min(dec.length, idx+80)));
  }
}

run().catch(e => { console.error(e); process.exit(1); });
