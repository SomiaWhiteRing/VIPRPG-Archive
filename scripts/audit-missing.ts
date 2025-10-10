import fs from 'node:fs/promises';
import path from 'node:path';

type Work = {
  no?: string;
  title?: string;
  author?: string;
  category?: string;
  engine?: string;
  streaming?: string;
  forum?: string;
  authorComment?: string;
  hostComment?: string;
  icon?: string;
  ss?: string[];
};

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('用法: npx tsx scripts/audit-missing.ts <festival-id|works-json-path>');
    process.exit(1);
  }
  const cwd = process.cwd();
  const publicDir = path.join(cwd, 'public');
  const worksPath = arg.endsWith('.json')
    ? path.resolve(cwd, arg)
    : path.join(cwd, 'src', 'data', 'works', `${arg}.json`);

  const raw = await fs.readFile(worksPath, 'utf8');
  const works: Work[] = JSON.parse(raw);

  const counts: Record<string, number> = {
    title: 0,
    author: 0,
    category: 0,
    engine: 0,
    streaming: 0,
    forum: 0,
    authorComment: 0,
    hostComment: 0,
    icon: 0,
    ss: 0,
  };

  type Row = { no: string; title: string; missing: string[] };
  const rows: Row[] = [];

  const fileExists = async (p: string) => {
    try {
      const st = await fs.stat(p);
      return st.isFile();
    } catch {
      return false;
    }
  };

  for (const w of works) {
    const miss: string[] = [];
    const no = (w.no ?? '').padStart(2, '0');
    const title = w.title ?? '';

    if (!w.title?.trim()) { counts.title++; miss.push('title'); }
    if (!w.author?.trim()) { counts.author++; miss.push('author'); }
    if (!w.category?.trim()) { counts.category++; miss.push('category'); }
    if (!w.engine?.trim()) { counts.engine++; miss.push('engine'); }
    if (!w.streaming?.trim()) { counts.streaming++; miss.push('streaming'); }
    if (!w.forum?.trim()) { counts.forum++; miss.push('forum'); }
    if (!w.authorComment?.trim()) { counts.authorComment++; miss.push('authorComment'); }
    if (!w.hostComment?.trim()) { counts.hostComment++; miss.push('hostComment'); }

    let iconMissing = false;
    if (!w.icon?.trim()) iconMissing = true;
    else {
      const iconRel = w.icon.replace(/^\//, '');
      const iconPath = path.join(publicDir, iconRel);
      if (!(await fileExists(iconPath))) iconMissing = true;
    }
    if (iconMissing) { counts.icon++; miss.push('icon'); }

    let ssMissing = false;
    if (!w.ss || w.ss.length === 0) ssMissing = true;
    else {
      let any = false;
      for (const s of w.ss) {
        const rel = s.replace(/^\//, '');
        const p = path.join(publicDir, rel);
        if (await fileExists(p)) { any = true; break; }
      }
      if (!any) ssMissing = true;
    }
    if (ssMissing) { counts.ss++; miss.push('ss'); }

    if (miss.length) rows.push({ no, title, missing: miss });
  }

  console.log(`TOTAL=${works.length}`);
  console.log('COUNTS=' + Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(','));
  console.log('ROWS_START');
  for (const r of rows.sort((a, b) => a.no.localeCompare(b.no))) {
    console.log(`${r.no}\t${r.title}\t${r.missing.join('|')}`);
  }
  console.log('ROWS_END');
}

main().catch((e) => { console.error(e); process.exit(1); });

