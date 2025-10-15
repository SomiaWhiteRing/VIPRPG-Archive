import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const WORKS_PATH = path.join(process.cwd(), "src", "data", "works", "2018-summer.json");
const CATCH_DIR = path.join(process.cwd(), "catch", "2018-summer");

function sanitizeWhitespace(v?: string | null) {
  if (!v) return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t || undefined;
}

function sanitizeMultiline(html?: string | null) {
  if (!html) return undefined;
  const out = html
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .split(/\r?\n/)
    .map((l) => l.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return out || undefined;
}

async function parseIndexAuthors(indexPath: string) {
  const html = await fs.readFile(indexPath, "utf8");
  const $ = cheerio.load(html);
  const map = new Map<string, string>();
  $("#table2 tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 3) return;
    const no = sanitizeWhitespace(tds.eq(0).text());
    const workCell = tds.eq(2);
    const authorSpan = workCell.find("span.font75").first();
    const author = sanitizeWhitespace(authorSpan.text());
    if (no && author) map.set(no.padStart(2, "0"), author);
  });
  return map;
}

async function parseDetailComments(entryPath: string) {
  const out: { authorComment?: string; hostComment?: string } = {};
  try {
    const html = await fs.readFile(entryPath, "utf8");
    const $ = cheerio.load(html);
    const findRow = (label: string) => {
      const cell = $(`td:contains(${label})`).filter((_, el) => /作者コメント|管理人コメント|主催コメント|備考/.test($(el).text())).first();
      if (!cell || cell.length === 0) return undefined;
      const rawHtml = cell.html() || cell.text();
      const parts = rawHtml.split(/<br\s*\/?\s*>/i);
      if (parts.length > 1) return sanitizeMultiline(parts.slice(1).join("<br>"));
      return sanitizeMultiline(rawHtml.replace(/^[\s\S]*?：/, ""));
    };
    out.authorComment = findRow("作者コメント");
    out.hostComment = findRow("管理人コメント") || findRow("主催コメント");
  } catch {}
  return out;
}

async function main() {
  const worksRaw = await fs.readFile(WORKS_PATH, "utf8");
  const works = JSON.parse(worksRaw) as any[];
  const indexPath = path.join(CATCH_DIR, "index.html");
  const hasIndex = await fs.access(indexPath).then(() => true).catch(() => false);
  const authorMap = hasIndex ? await parseIndexAuthors(indexPath) : new Map<string, string>();
  let updAuthor = 0, updComments = 0, updDisable = 0;
  for (const w of works) {
    const idx = (w.no as string)?.padStart(2, "0");
    if ((!w.author || w.author.trim() === "") && idx && authorMap.has(idx)) {
      w.author = authorMap.get(idx);
      updAuthor += 1;
    }
    if (!w.authorComment || !w.hostComment) {
      const entryPath = path.join(CATCH_DIR, `entry${idx}.html`);
      const hasEntry = await fs.access(entryPath).then(() => true).catch(() => false);
      if (hasEntry) {
        const { authorComment, hostComment } = await parseDetailComments(entryPath);
        if (!w.authorComment && authorComment) { w.authorComment = authorComment; updComments += 1; }
        if (!w.hostComment && hostComment) { w.hostComment = hostComment; updComments += 1; }
      }
    }
    if ((!w.authorComment || w.authorComment.trim() === "") && (!w.hostComment || w.hostComment.trim() === "") && (!w.ss || w.ss.length === 0)) {
      if (!w.detailDisabled) { w.detailDisabled = true; updDisable += 1; }
    } else if (w.detailDisabled) {
      // if now we have data, remove the flag
      delete w.detailDisabled;
    }
  }
  await fs.writeFile(WORKS_PATH, JSON.stringify(works, null, 2), "utf8");
  console.log(`authors updated: ${updAuthor}, comments updated: ${updComments}, detailDisabled updated: ${updDisable}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

