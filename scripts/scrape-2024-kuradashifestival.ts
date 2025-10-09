import fs from 'node:fs';
import path from 'node:path';
import { load as loadHtml } from 'cheerio';

// Minimal fetch typings to avoid using 'any'
interface SimpleResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}
declare function fetch(
  url: string,
  init?: { redirect?: 'follow' | 'manual' | 'error'; headers?: Record<string, string> }
): Promise<SimpleResponse>;

type ListingRow = {
  no: string;
  category: string;
  engine: string;
  date?: string;
  title: string;
  downloadHref?: string;
  hasPickup?: boolean;
};

type PickupInfo = {
  hostComment?: string;
  imageUrl?: string;
};

const SLUG = '2024-kuradashifestival';
const FESTIVAL_ID = SLUG;

function readFileOrThrow(file: string): string {
  if (!fs.existsSync(file)) {
    throw new Error(`Missing file: ${file}`);
  }
  return fs.readFileSync(file, 'utf8');
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function toText($el: cheerio.Cheerio<cheerio.Element>): string {
  return $el.text().trim().replace(/\s+/g, ' ');
}

function parseListing(listingHtml: string): ListingRow[] {
  const $ = loadHtml(listingHtml);
  const rows: ListingRow[] = [];
  $('table tbody tr').each((_, tr) => {
    const $tr = $(tr);
    const tds = $tr.find('td');
    if (tds.length < 5) return;
    const no = toText($(tds.get(0)));
    const category = toText($(tds.get(1)));
    const engine = toText($(tds.get(2)));
    const date = toText($(tds.get(3)));
    const $titleTd = $(tds.get(4));
    const $a = $titleTd.find('a').first();
    const title = toText($a);
    const downloadHref = $a.attr('href') || undefined;
    const $pickupTd = $(tds.get(5));
    const hasPickup = $pickupTd.find('a[href*="pickup_exf1.html"]').length > 0;
    if (!no || !title) return;
    rows.push({ no, category, engine, date, title, downloadHref, hasPickup });
  });
  return rows;
}

function parsePickup(pickupHtml: string): Record<string, PickupInfo> {
  const $ = loadHtml(pickupHtml);
  const baseHref = $('base').attr('href') || 'https://tkoolviprpg2421014.web.fc2.com/hokan14top.html';
  const map: Record<string, PickupInfo> = {};
  // Each section id like #pickup_f1-1 contains an <img> and a host comment row with leading '★'
  $('section[id^="pickup_"]').each((_, sec) => {
    const $sec = $(sec);
    const id = $sec.attr('id') || '';
    const match = id.match(/pickup_(.+)$/i);
    if (!match) return;
    const key = match[1].toUpperCase(); // e.g. F1-1
    // Find first image within this section
    const $img = $sec.find('img').first();
    let imageUrl: string | undefined;
    if ($img.length) {
      const src = $img.attr('src');
      if (src) {
        imageUrl = new URL(src, baseHref).toString();
      }
    }
    // Find the first comment row containing '★'
    let hostComment: string | undefined;
    $sec.find('td').each((__, td) => {
      const text = toText($(td));
      if (!hostComment && text.includes('★')) {
        hostComment = text.replace(/^.*?★\s*/, '★').replace(/^★\s*/, '');
      }
    });
    map[key] = { hostComment, imageUrl };
  });
  return map;
}

async function fetchBinary(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    // Avoid Referer for safety (though FC2 typically doesn’t require it)
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; VIPRPG-Archive/1.0)'
    }
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

async function savePickupAssets(rows: ListingRow[], pickup: Record<string, PickupInfo>) {
  const ssDir = path.join('public', 'screenshots', SLUG);
  ensureDir(ssDir);
  const saved: Record<string, { saved: number }> = {};
  for (const row of rows) {
    const key = row.no.toUpperCase();
    const info = pickup[key];
    if (!info || !info.imageUrl) continue;
    const outName = `${key}.png`;
    const outPath = path.join(ssDir, outName);
    try {
      const buf = await fetchBinary(info.imageUrl);
      fs.writeFileSync(outPath, buf);
      saved[key] = { saved: 1 };
    } catch (e) {
      // swallow but continue
      console.warn(`Failed to save screenshot for ${key}: ${(e as Error).message}`);
    }
  }
  return saved;
}

async function main() {
  const baseDir = path.join('catch', SLUG);
  const listingPath = fs.existsSync(path.join(baseDir, 'archive_exf1.html'))
    ? path.join(baseDir, 'archive_exf1.html')
    : path.join('catch', `${SLUG}-archive_exf1.html`);
  const pickupPath = fs.existsSync(path.join(baseDir, 'pickup_exf1.html'))
    ? path.join(baseDir, 'pickup_exf1.html')
    : path.join('catch', `${SLUG}-pickup_exf1.html`);

  const listingHtml = readFileOrThrow(listingPath);
  const pickupHtml = readFileOrThrow(pickupPath);

  const rows = parseListing(listingHtml);
  const pickup = parsePickup(pickupHtml);

  // Save pickup screenshots
  const savedMap = await savePickupAssets(rows, pickup);

  // Build works JSON
  const works = rows.map((r) => {
    const key = r.no.toUpperCase();
    const info = pickup[key];
    type OutWorkEntry = {
      id: string;
      festivalId: string;
      no: string;
      title: string;
      author: string;
      category?: string;
      engine?: string;
      hostComment?: string;
      ss?: string[];
    };
    const entry: OutWorkEntry = {
      id: `${FESTIVAL_ID}-work-${r.no}`,
      festivalId: FESTIVAL_ID,
      no: r.no,
      title: r.title,
      author: '',
      category: r.category,
      engine: r.engine,
    };
    if (info?.hostComment) {
      entry.hostComment = info.hostComment;
    }
    if (savedMap[key]?.saved) {
      entry.ss = [path.posix.join('/screenshots', SLUG, `${key}.png`)];
    }
    return entry;
  });

  // Write works JSON (stable order as they appear)
  const worksFile = path.join('src', 'data', 'works', `${SLUG}.json`);
  ensureDir(path.dirname(worksFile));
  fs.writeFileSync(worksFile, JSON.stringify(works, null, 2), 'utf8');

  // Write summary at catch root for consistency
  const summary = {
    festivalId: FESTIVAL_ID,
    generatedAt: new Date().toISOString(),
    banner: `/banners/${SLUG}.png`,
    stats: { captured: works.length, skipped: 0 },
    entries: rows.map((r) => ({
      index: r.no,
      status: 'ok',
      title: r.title,
      note: `ダウンロード: ${r.downloadHref ? 1 : 0}件`,
      downloadSource: r.downloadHref ? [r.downloadHref] : [],
      screenshotReport: { saved: savedMap[r.no.toUpperCase()]?.saved || 0 },
    })),
  };
  const summaryFile = path.join('catch', `${SLUG}-scrape-summary.json`);
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), 'utf8');

  console.log(`Updated: ${worksFile}`);
  console.log(`Summary: ${summaryFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
