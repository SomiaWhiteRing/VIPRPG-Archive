import fs from "node:fs/promises";
import path from "node:path";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)" +
  " Chrome/130.0.0.0 Safari/537.36";

function unwrapWayback(url?: string | null): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.hostname !== "web.archive.org") return url;
    const m = u.pathname.match(/^\/web\/[0-9]+(?:[a-z]_)?\/(https?:\/\/.*)$/i);
    if (m && m[1]) return m[1];
    return url;
  } catch {
    return url;
  }
}

async function checkLive(url?: string): Promise<boolean> {
  if (!url) return false;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Connection: "close",
      },
      redirect: "follow",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    } as RequestInit);
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: tsx scripts/normalize-forum-links.ts <works.json>");
  const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  const raw = await fs.readFile(abs, "utf8");
  const arr = JSON.parse(raw) as any[];
  let changed = 0;
  for (const w of arr) {
    const input = w.forum as string | undefined;
    if (!input) continue;
    const live = unwrapWayback(input);
    if (!live) continue;
    try {
      const u = new URL(live);
      const isInternal = /vipkohaku\.x\.fc2\.com$/i.test(u.hostname);
      if (isInternal) continue;
    } catch { continue; }
    if (live !== input) {
      const ok = await checkLive(live);
      if (ok) {
        w.forum = live;
        changed += 1;
      }
    }
  }
  if (changed > 0) {
    await fs.writeFile(abs, JSON.stringify(arr, null, 2), "utf8");
    console.log(`Updated ${changed} forum link(s) to live URLs in ${file}`);
  } else {
    console.log("No changes needed");
  }
}

main().catch((err) => { console.error(err); process.exit(1); });

