import fs from "node:fs/promises";

function decodeUserHtmlString(s: string) {
  let out = s.replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  out = out.replace(/\\n/g, "\n").replace(/\\r/g, "").replace(/\\t/g, "\t");
  out = out.replace(/\\\//g, "/");
  out = out.replace(/\\"/g, '"');
  out = out.replace(/\\'/g, "'");
  out = out.replace(/\\\\/g, "\\");
  return out;
}

async function run() {
  const outer = await fs.readFile('catch/2019-summer/game-39-outer.html', 'utf8');
  const m = outer.match(/goog\.script\.init\(("|')([\s\S]*?)\1\)/);
  console.log('m?', !!m);
  if (!m) return;
  const jsonText = decodeUserHtmlString(m[2]);
  console.log('json head:', jsonText.slice(0, 200));
  const obj = JSON.parse(jsonText);
  console.log('userHtml len:', (obj?.userHtml as string)?.length);
}

run().catch(e => { console.error(e); process.exit(1); });

