import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';

const WORKS = path.join(process.cwd(), 'src', 'data', 'works', '2022-kouhaku.json');
const SUBJECT_URL = 'https://jbbs.shitaraba.net/bbs/subject.cgi/otaku/18266/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

type Work = {
  id: string;
  festivalId: string;
  no: string;
  title: string;
  forum?: string;
};

async function fetchText(url: string) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8' } as any, redirect: 'follow' } as any);
  if (!(res as any).ok) throw new Error(`HTTP ${(res as any).status} for ${url}`);
  return await (res as any).text();
}

function parseSubject(html: string) {
  const $ = cheerio.load(html);
  const map = new Map<string, string>(); // no -> url
  $('ul.thread-list a[href*="/bbs/read.cgi/otaku/18266/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const text = $(a).text().trim();
    const m = text.match(/No\.\s*(\d+)\s*:/);
    if (m) {
      const no = m[1];
      // normalize to https absolute URL
      const url = href.startsWith('http') ? href : new URL(href, SUBJECT_URL).toString();
      if (!map.has(no)) map.set(no, url);
    }
  });
  return map;
}

async function main() {
  const html = await fetchText(SUBJECT_URL);
  const map = parseSubject(html);
  const raw = await fs.readFile(WORKS, 'utf8');
  const works: Work[] = JSON.parse(raw);
  let patched = 0;
  for (const w of works) {
    const url = map.get(w.no);
    if (url && w.forum !== url) {
      w.forum = url;
      patched++;
    }
  }
  await fs.writeFile(WORKS, JSON.stringify(works, null, 2), 'utf8');
  console.log(`Updated forum links for ${patched} works.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

