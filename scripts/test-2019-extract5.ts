import fs from "node:fs/promises";

function decodeHexEscapes(s: string) {
  return s.replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function extractHtml(outer: string) {
  const m = outer.match(/goog\.script\.init\(("|')([\s\S]*?)\1\)/);
  if (!m) return undefined;
  const arg = decodeHexEscapes(m[2]!);
  const key = '"userHtml":"';
  const start = arg.indexOf(key);
  if (start < 0) return undefined;
  let i = start + key.length;
  let buf = "";
  for (; i < arg.length; i++) {
    const ch = arg[i]!;
    if (ch === '"') {
      let k = i - 1, bs = 0;
      while (k >= 0 && arg[k] === '\\') { bs += 1; k -= 1; }
      if (bs % 2 === 0) break;
    }
    buf += ch;
  }
  // Unescape JSON string
  return JSON.parse('"' + buf + '"');
}

async function run(){
  const outer = await fs.readFile('catch/2019-summer/game-39-outer.html','utf8');
  const html = extractHtml(outer);
  console.log('htmlLen', html?.length);
  if (html) await fs.writeFile('catch/2019-summer/_inner_scan_39.html', html, 'utf8');
}

run().catch(err => { console.error(err); process.exit(1); });
