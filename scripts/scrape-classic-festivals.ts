import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";

type WorkDownload = {
  url: string;
  label?: string;
};

type WorkEntry = {
  id: string;
  festivalId: string;
  no?: string;
  title: string;
  author: string;
  category?: string;
  streaming?: string;
  download?: WorkDownload;
  forum?: string;
  detailDisabled?: boolean;
};

type SummaryEntry = {
  index: string;
  status: "ok" | "partial";
  title: string;
  author?: string;
  category?: string;
  downloadSource?: string[];
  notes?: string[];
};

type HtmlSource = {
  url: string;
  encoding: BufferEncoding | "shift_jis" | "euc-jp";
  filename: string;
};

type FestivalResult = {
  festivalId: string;
  banner?: string;
  bannerSourceUrl?: string;
  sources: Array<{ filename: string; url: string; content: string }>;
  works: WorkEntry[];
  entries: SummaryEntry[];
  notes?: string[];
};

const repoRoot = process.cwd();
const catchRoot = path.join(repoRoot, "catch");
const worksRoot = path.join(repoRoot, "src", "data", "works");
const bannerRoot = path.join(repoRoot, "public", "banners");
const localCacheByUrl = new Map<string, string>([
  [
    "https://web.archive.org/web/20200322075453if_/https://vipkohaku.x.fc2.com/2008/sakuhin_aka.html",
    path.join(repoRoot, "tmp_2008_aka.html"),
  ],
  [
    "https://web.archive.org/web/20200322075453if_/https://vipkohaku.x.fc2.com/2008/sakuhin_siro.html",
    path.join(repoRoot, "tmp_2008_siro.html"),
  ],
  [
    "https://web.archive.org/web/20190919090206if_/https://vipkohaku.x.fc2.com/2008/top1.html",
    path.join(repoRoot, "tmp_2008_top1.bin"),
  ],
  [
    "https://web.archive.org/web/20190330131509if_/https://vipkohaku.x.fc2.com/seiyoku.htm",
    path.join(repoRoot, "tmp_2008_seiyoku_exact.bin"),
  ],
  [
    "https://web.archive.org/web/20080819011109if_/http://www.geocities.jp/viprpg_natunozin08/",
    path.join(repoRoot, "tmp_2008_summer_root_exact.bin"),
  ],
  [
    "https://web.archive.org/web/20080819123132if_/http://www.geocities.jp/viprpg_natunozin08/Work_list.htm",
    path.join(repoRoot, "tmp_2008_summer_worklist.bin"),
  ],
  [
    "https://web.archive.org/web/20190518093108if_/https://vipkohaku.x.fc2.com/2007def/index.html",
    path.join(repoRoot, "tmp_2007def_index_exact.bin"),
  ],
  [
    "https://web.archive.org/web/20190518093107if_/https://vipkohaku.x.fc2.com/2007GW/index.html",
    path.join(repoRoot, "tmp_2007_gw_exact.bin"),
  ],
  [
    "https://web.archive.org/web/20200714070206if_/https://vipkohaku.x.fc2.com/2007s/ss.html",
    path.join(repoRoot, "tmp_2007s_ss_exact.bin"),
  ],
  [
    "https://web.archive.org/web/20230528073016if_/https://vipkohaku.x.fc2.com/2007s/top.html",
    path.join(repoRoot, "tmp_2007s_top_exact.bin"),
  ],
  [
    "https://web.archive.org/web/20221115151959if_/https://vipkohaku.x.fc2.com/2007s/2007p/",
    path.join(repoRoot, "tmp_2007s_patch_exact.bin"),
  ],
  [
    "https://web.archive.org/web/20230201130823if_/https://vipkohaku.x.fc2.com/2006GW/main.html",
    path.join(repoRoot, "tmp_inspect_2006_gw_main.bin"),
  ],
  [
    "https://web.archive.org/web/20230201130540if_/https://vipkohaku.x.fc2.com/2006/index_game.htm",
    path.join(repoRoot, "tmp_inspect_2006_kouhaku_index_game.bin"),
  ],
  [
    "https://web.archive.org/web/20190518093106if_/https://vipkohaku.x.fc2.com/2006s/top.htm",
    path.join(repoRoot, "tmp_2006s_top_exact.bin"),
  ],
  [
    "https://web.archive.org/web/20230723192402if_/https://vipkohaku.x.fc2.com/2006s/fure-m.htm",
    path.join(repoRoot, "tmp_2006s_fure_m.bin"),
  ],
  [
    "https://web.archive.org/web/20070402022134if_/http://yy41.60.kg/natu/",
    path.join(repoRoot, "tmp_2006s_forum_root.bin"),
  ],
  [
    "https://web.archive.org/web/20100107113105if_/http://vipkouhaku05.cs.land.to/",
    path.join(repoRoot, "tmp_inspect_2005_root.bin"),
  ],
  [
    "https://web.archive.org/web/timemap/json?url=http%3A%2F%2Fvipkouhaku05.cs.land.to%2F&matchType=prefix&collapse=urlkey&output=json&fl=original,timestamp,endtimestamp,mimetype,statuscode&filter=!statuscode:%5B45%5D..&limit=100",
    path.join(repoRoot, "tmp_2005_timemap.json"),
  ],
]);
const requestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  accept: "*/*",
} as const;

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readLocalCache(url: string) {
  const cachedPath = localCacheByUrl.get(url);
  if (cachedPath && fs.existsSync(cachedPath)) {
    return fs.readFileSync(cachedPath);
  }
  return undefined;
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const cached = readLocalCache(url);
  if (cached) {
    return cached;
  }
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: requestHeaders,
        redirect: "follow",
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      lastError =
        error instanceof Error ? error : new Error(String(error));
      if (attempt < 4) {
        await delay(attempt * 1000);
      }
    }
  }
  throw new Error(`Failed to fetch ${url}: ${lastError?.message ?? "unknown error"}`);
}

async function fetchHtml(source: HtmlSource) {
  const buffer = await fetchBuffer(source.url);
  const content = iconv.decode(buffer, source.encoding);
  return {
    ...source,
    buffer,
    content,
    $: cheerio.load(content),
  };
}

async function fetchBinaryToFile(url: string, destination: string) {
  ensureDir(path.dirname(destination));
  const cached = readLocalCache(url);
  if (!cached) {
    return false;
  }
  fs.writeFileSync(destination, cached);
  return true;
}

function cleanText(input: string | undefined | null) {
  return (input ?? "").replace(/\s+/g, " ").trim();
}

function numericNo(value: string) {
  const parsed = Number.parseInt(value.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function makeNoFormatter(maxNumber: number) {
  const width = maxNumber >= 100 ? 3 : 2;
  return (value: number | string) => {
    const parsed = typeof value === "number" ? value : numericNo(value);
    return String(parsed).padStart(width, "0");
  };
}

function buildWorkId(festivalId: string, no: string) {
  return `${festivalId}-work-${no}`;
}

function writeJson(filePath: string, data: unknown) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function writeSourceHtml(
  festivalId: string,
  filename: string,
  url: string,
  content: string
) {
  const festivalCatchDir = path.join(catchRoot, festivalId);
  ensureDir(festivalCatchDir);
  fs.writeFileSync(path.join(festivalCatchDir, filename), content, "utf8");
  return { filename, url, content };
}

function absoluteWaybackUrl(baseUrl: string, href: string | undefined) {
  if (!href) return undefined;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function summaryFromWorks(works: WorkEntry[], notesByNo?: Map<string, string[]>) {
  return works.map((work) => {
    const entry: SummaryEntry = {
      index: work.no ?? "",
      status: notesByNo?.has(work.no ?? "") ? "partial" : "ok",
      title: work.title,
    };
    if (work.author) entry.author = work.author;
    if (work.category) entry.category = work.category;
    if (work.download?.url) {
      entry.downloadSource = [work.download.url];
    }
    if (notesByNo?.has(work.no ?? "")) {
      entry.notes = notesByNo.get(work.no ?? "");
    }
    return entry;
  });
}

async function parse2008Kouhaku(): Promise<FestivalResult> {
  const festivalId = "2008-kouhaku";
  const red = await fetchHtml({
    url: "https://web.archive.org/web/20200322075453if_/https://vipkohaku.x.fc2.com/2008/sakuhin_aka.html",
    encoding: "shift_jis",
    filename: "sakuhin_aka.html",
  });
  const white = await fetchHtml({
    url: "https://web.archive.org/web/20200322075453if_/https://vipkohaku.x.fc2.com/2008/sakuhin_siro.html",
    encoding: "shift_jis",
    filename: "sakuhin_siro.html",
  });
  const top1 = await fetchHtml({
    url: "https://web.archive.org/web/20190919090206if_/https://vipkohaku.x.fc2.com/2008/top1.html",
    encoding: "shift_jis",
    filename: "top1.html",
  });

  const works: WorkEntry[] = [];
  const formatter = makeNoFormatter(125);
  const collect = (page: typeof red, category: string) => {
    page.$("a[href^='sakuhin_']").each((_, element) => {
      const href = page.$(element).attr("href") ?? "";
      const no = numericNo(href);
      if (!Number.isFinite(no)) return;
      works.push({
        id: buildWorkId(festivalId, formatter(no)),
        festivalId,
        no: formatter(no),
        title: cleanText(page.$(element).text()),
        author: "",
        category,
        detailDisabled: true,
      });
    });
  };
  collect(red, "紅組");
  collect(white, "白組");
  works.sort((a, b) => numericNo(a.no ?? "") - numericNo(b.no ?? ""));

  return {
    festivalId,
    banner: "/banners/2008-kouhaku.png",
    bannerSourceUrl:
      "https://web.archive.org/web/20190919090208im_/https://vipkohaku.x.fc2.com/2008/haikei_top1.gif",
    sources: [
      writeSourceHtml(festivalId, red.filename, red.url, red.content),
      writeSourceHtml(festivalId, white.filename, white.url, white.content),
      writeSourceHtml(festivalId, top1.filename, top1.url, top1.content),
    ],
    works,
    entries: summaryFromWorks(works),
    notes: ["Banner source is archived as GIF and converted separately to /public/banners/2008-kouhaku.png."],
  };
}

async function parse2008SeiyokuFestival(): Promise<FestivalResult> {
  const festivalId = "2008-seiyoku-festival";
  const page = await fetchHtml({
    url: "https://web.archive.org/web/20190330131509if_/https://vipkohaku.x.fc2.com/seiyoku.htm",
    encoding: "shift_jis",
    filename: "seiyoku.html",
  });
  const works: WorkEntry[] = [];
  page.$("a").each((_, element) => {
    const text = cleanText(page.$(element).text());
    const match = text.match(/^NO\.(\d+)\s+(.+)$/i);
    if (!match) return;
    const no = String(Number.parseInt(match[1], 10)).padStart(2, "0");
    works.push({
      id: buildWorkId(festivalId, no),
      festivalId,
      no,
      title: match[2].trim(),
      author: "",
      download: {
        url: absoluteWaybackUrl(page.url, page.$(element).attr("href")) ?? "",
        label: "DL",
      },
      detailDisabled: true,
    });
  });

  return {
    festivalId,
    banner: "/banners/2008-seiyoku-festival.png",
    sources: [writeSourceHtml(festivalId, page.filename, page.url, page.content)],
    works,
    entries: summaryFromWorks(works),
    notes: ["Original festival site was lost; only the archived supplemental page survives."],
  };
}

async function parse2008Summer(): Promise<FestivalResult> {
  const festivalId = "2008-summer";
  const root = await fetchHtml({
    url: "https://web.archive.org/web/20080819011109if_/http://www.geocities.jp/viprpg_natunozin08/",
    encoding: "shift_jis",
    filename: "index.html",
  });
  const workList = await fetchHtml({
    url: "https://web.archive.org/web/20080819123132if_/http://www.geocities.jp/viprpg_natunozin08/Work_list.htm",
    encoding: "shift_jis",
    filename: "Work_list.html",
  });

  await fetchBinaryToFile(
    "https://web.archive.org/web/20110507120045im_/http://www.geocities.jp/viprpg_natunozin08/natunozin_bana.png",
    path.join(bannerRoot, "2008-summer.png")
  );

  const works: WorkEntry[] = [];
  const anchors = workList.$("a[href^='SS_']");
  for (const element of anchors.toArray()) {
    const href = workList.$(element).attr("href") ?? "";
    const noNumber = numericNo(href);
    if (!Number.isFinite(noNumber)) continue;
    const no = String(noNumber).padStart(2, "0");
    works.push({
      id: buildWorkId(festivalId, no),
      festivalId,
      no,
      title: cleanText(workList.$(element).text()) || "不明",
      author: "",
      detailDisabled: true,
    });
  }

  works.sort((a, b) => numericNo(a.no ?? "") - numericNo(b.no ?? ""));

  return {
    festivalId,
    banner: "/banners/2008-summer.png",
    bannerSourceUrl:
      "https://web.archive.org/web/20110507120045im_/http://www.geocities.jp/viprpg_natunozin08/natunozin_bana.png",
    sources: [
      writeSourceHtml(festivalId, root.filename, root.url, root.content),
      writeSourceHtml(festivalId, workList.filename, workList.url, workList.content),
    ],
    works,
    entries: summaryFromWorks(works),
    notes: [
      "The archived work list survives and provides entry numbers plus titles.",
      "Most per-entry detail pages are no longer reliably reachable, so this capture keeps the minimal list view.",
    ],
  };
}

async function parse2007DefaultBattleFestival(): Promise<FestivalResult> {
  const festivalId = "2007-default-battle-festival";
  const page = await fetchHtml({
    url: "https://web.archive.org/web/20190518093108if_/https://vipkohaku.x.fc2.com/2007def/index.html",
    encoding: "shift_jis",
    filename: "index.html",
  });

  await fetchBinaryToFile(
    "https://web.archive.org/web/20221220063439im_/https://vipkohaku.x.fc2.com/2007def/top.png",
    path.join(bannerRoot, "2007-default-battle-festival.png")
  );

  const works: WorkEntry[] = [];
  page.$("a[href$='.html']").each((_, element) => {
    const href = page.$(element).attr("href") ?? "";
    const match = href.match(/^(\d{2})\.html$/);
    if (!match) return;
    const no = match[1];
    works.push({
      id: buildWorkId(festivalId, no),
      festivalId,
      no,
      title: cleanText(page.$(element).text()),
      author: "",
      detailDisabled: true,
    });
  });
  works.sort((a, b) => numericNo(a.no ?? "") - numericNo(b.no ?? ""));

  return {
    festivalId,
    banner: "/banners/2007-default-battle-festival.png",
    bannerSourceUrl:
      "https://web.archive.org/web/20221220063439im_/https://vipkohaku.x.fc2.com/2007def/top.png",
    sources: [writeSourceHtml(festivalId, page.filename, page.url, page.content)],
    works,
    entries: summaryFromWorks(works),
  };
}

async function parse2007Gw(): Promise<FestivalResult> {
  const festivalId = "2007-gw";
  const page = await fetchHtml({
    url: "https://web.archive.org/web/20190518093107if_/https://vipkohaku.x.fc2.com/2007GW/index.html",
    encoding: "shift_jis",
    filename: "index.html",
  });

  await fetchBinaryToFile(
    "https://web.archive.org/web/20190518093107im_/https://vipkohaku.x.fc2.com/2007GW/image/gw.png",
    path.join(bannerRoot, "2007-gw.png")
  );

  const works: WorkEntry[] = [];
  const anchors = page.$("a").toArray();
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index];
    const href = page.$(anchor).attr("href") ?? "";
    const match = href.match(/^entry\/(\d{3})\.html$/);
    if (!match) continue;
    const no = match[1];
    const title = cleanText(page.$(anchor).text());
    let download: WorkDownload | undefined;
    const nextAnchor = anchors[index + 1];
    if (nextAnchor) {
      const nextText = cleanText(page.$(nextAnchor).text());
      if (nextText === "ファイル") {
        download = {
          url: absoluteWaybackUrl(page.url, page.$(nextAnchor).attr("href")) ?? "",
          label: nextText,
        };
      }
    }
    works.push({
      id: buildWorkId(festivalId, String(Number.parseInt(no, 10)).padStart(2, "0")),
      festivalId,
      no: String(Number.parseInt(no, 10)).padStart(2, "0"),
      title: title.replace(/\s+\[XP\]$/, ""),
      author: "",
      download,
      detailDisabled: true,
    });
  }
  works.sort((a, b) => numericNo(a.no ?? "") - numericNo(b.no ?? ""));

  return {
    festivalId,
    banner: "/banners/2007-gw.png",
    bannerSourceUrl:
      "https://web.archive.org/web/20190518093107im_/https://vipkohaku.x.fc2.com/2007GW/image/gw.png",
    sources: [writeSourceHtml(festivalId, page.filename, page.url, page.content)],
    works,
    entries: summaryFromWorks(works),
  };
}

async function parse2007Summer(): Promise<FestivalResult> {
  const festivalId = "2007-summer";
  const page = await fetchHtml({
    url: "https://web.archive.org/web/20200714070206if_/https://vipkohaku.x.fc2.com/2007s/ss.html",
    encoding: "euc-jp",
    filename: "ss.html",
  });
  const top = await fetchHtml({
    url: "https://web.archive.org/web/20230528073016if_/https://vipkohaku.x.fc2.com/2007s/top.html",
    encoding: "shift_jis",
    filename: "top.html",
  });
  const patch = await fetchHtml({
    url: "https://web.archive.org/web/20221115151959if_/https://vipkohaku.x.fc2.com/2007s/2007p/",
    encoding: "shift_jis",
    filename: "2007p-index.html",
  });

  await fetchBinaryToFile(
    "https://web.archive.org/web/20230528073016im_/https://vipkohaku.x.fc2.com/2007s/natu1.png",
    path.join(bannerRoot, "2007-summer.png")
  );

  const works: WorkEntry[] = [];
  page.$("tr").slice(1).each((_, row) => {
    const cells = page
      .$(row)
      .find("td")
      .map((__, cell) => cleanText(page.$(cell).text()))
      .get();
    if (cells.length < 2) return;
    const noValue = numericNo(cells[0]);
    if (!Number.isFinite(noValue)) return;
    const no = String(noValue).padStart(2, "0");
    const links = page
      .$(row)
      .find("a")
      .toArray()
      .map((anchor) => ({
        href: absoluteWaybackUrl(page.url, page.$(anchor).attr("href")),
        text: cleanText(page.$(anchor).text()),
      }));
    const download = links.find((link) => link.text.includes("( ゜д゜ )"));
    works.push({
      id: buildWorkId(festivalId, no),
      festivalId,
      no,
      title: cells[1],
      author: "",
      download: download?.href
        ? {
            url: download.href,
            label: "DL",
          }
        : undefined,
      detailDisabled: true,
    });
  });

  return {
    festivalId,
    banner: "/banners/2007-summer.png",
    bannerSourceUrl:
      "https://web.archive.org/web/20230528073016im_/https://vipkohaku.x.fc2.com/2007s/natu1.png",
    sources: [
      writeSourceHtml(festivalId, page.filename, page.url, page.content),
      writeSourceHtml(festivalId, top.filename, top.url, top.content),
      writeSourceHtml(festivalId, patch.filename, patch.url, patch.content),
    ],
    works,
    entries: summaryFromWorks(works),
  };
}

async function parse2006Gw(): Promise<FestivalResult> {
  const festivalId = "2006-gw";
  const page = await fetchHtml({
    url: "https://web.archive.org/web/20230201130823if_/https://vipkohaku.x.fc2.com/2006GW/main.html",
    encoding: "euc-jp",
    filename: "main.html",
  });

  await fetchBinaryToFile(
    "https://web.archive.org/web/20230201130830im_/https://vipkohaku.x.fc2.com/2006GW/festa.png",
    path.join(bannerRoot, "2006-gw.png")
  );

  const bodyText = cleanText(page.$("body").text());
  const works: WorkEntry[] = [];
  const formatter = makeNoFormatter(31);
  let index = 1;
  for (const match of bodyText.matchAll(/・「\s*(.*?)\s*」\s*作・([^・]+?)(?=・「|更新履歴|$)/g)) {
    works.push({
      id: buildWorkId(festivalId, formatter(index)),
      festivalId,
      no: formatter(index),
      title: cleanText(match[1]),
      author: cleanText(match[2]),
      detailDisabled: true,
    });
    index += 1;
  }

  return {
    festivalId,
    banner: "/banners/2006-gw.png",
    bannerSourceUrl:
      "https://web.archive.org/web/20230201130830im_/https://vipkohaku.x.fc2.com/2006GW/festa.png",
    sources: [writeSourceHtml(festivalId, page.filename, page.url, page.content)],
    works,
    entries: summaryFromWorks(works),
  };
}

async function parse2006Kouhaku(): Promise<FestivalResult> {
  const festivalId = "2006-kouhaku";
  const page = await fetchHtml({
    url: "https://web.archive.org/web/20230201130540if_/https://vipkohaku.x.fc2.com/2006/index_game.htm",
    encoding: "shift_jis",
    filename: "index_game.htm",
  });

  await fetchBinaryToFile(
    "https://web.archive.org/web/20200222104311im_/https://vipkohaku.x.fc2.com/2006/vipkohaku_second.png",
    path.join(bannerRoot, "2006-kouhaku.png")
  );

  const works: WorkEntry[] = [];
  for (const match of page.content.matchAll(/\[No\.(\d+)\]\s*([^\r\n<]+)/g)) {
    const noValue = Number.parseInt(match[1], 10);
    const no = String(noValue).padStart(2, "0");
    works.push({
      id: buildWorkId(festivalId, no),
      festivalId,
      no,
      title: cleanText(match[2]),
      author: "",
      detailDisabled: true,
    });
  }

  return {
    festivalId,
    banner: "/banners/2006-kouhaku.png",
    bannerSourceUrl:
      "https://web.archive.org/web/20200222104311im_/https://vipkohaku.x.fc2.com/2006/vipkohaku_second.png",
    sources: [writeSourceHtml(festivalId, page.filename, page.url, page.content)],
    works,
    entries: summaryFromWorks(works),
  };
}

async function parse2006Summer(): Promise<FestivalResult> {
  const festivalId = "2006-summer";
  const top = await fetchHtml({
    url: "https://web.archive.org/web/20190518093106if_/https://vipkohaku.x.fc2.com/2006s/top.htm",
    encoding: "shift_jis",
    filename: "top.htm",
  });
  const menu = await fetchHtml({
    url: "https://web.archive.org/web/20230723192402if_/https://vipkohaku.x.fc2.com/2006s/fure-m.htm",
    encoding: "shift_jis",
    filename: "fure-m.htm",
  });
  const forum = await fetchHtml({
    url: "https://web.archive.org/web/20070402022134if_/http://yy41.60.kg/natu/",
    encoding: "shift_jis",
    filename: "forum-index.html",
  });

  await fetchBinaryToFile(
    "https://web.archive.org/web/20211008072048im_/https://vipkohaku.x.fc2.com/2006s/tope-sama-.PNG",
    path.join(bannerRoot, "2006-summer.png")
  );

  const works: WorkEntry[] = [];
  const notesByNo = new Map<string, string[]>();
  const manualEntries = [
    ["01", "もしもアワビファンタジー56+", "インスパイヤ大好きっ子さんから、いただきました"],
    ["02", "2003sorceress（そーされす）", ""],
    ["03", "Undying Love", ""],
    ["04", "Ｍ・Ｇ・Ｆ", ""],
    ["06", "もしも魔王城が財政難になったら", ""],
    ["07", "ダークネスⅢと愉快な取り巻き達あと短編集３個", ""],
    ["08", "終わらない夏２００６", ""],
    ["09", "愛と憎しみの忘却曲線", ""],
    ["12", "もしもアレックスがキレ者だったなら", ""],
    ["13", "Ｍｉｎｄ Ｗａｔｃｈｅｒ", ""],
    ["15", "コテハンクエストIII ～そして伝説へ", ""],
    ["17", "もしもダーエロの思惑通りに事が進んだら", "炭酸電池"],
    ["18", "もしもドラゴナスがょぅι゛ょになったら", "西野バラバリスト"],
    ["19", "ラナ×ケイン", "決意表明がいきなり終わってできなかった人"],
    ["21", "oldio", ""],
    ["22", "ホネホネ", ""],
    ["27", "檻夢（おりゆめ）", ""],
    ["28", "不明", ""],
    ["29", "もしもクエストモンスターズ ゴメスのワンダーランド", ""],
    ["30", "もしもドラゴナスが幼女になったらもしくは略してドよ", ""],
    ["31", "Untitled", ""],
    ["32", "アンタップアップキープドロー森セットラノワールの（略）", ""],
    ["33", "デスノート、弄るアレックス", ""],
  ] as const;

  for (const [no, title, author] of manualEntries) {
    works.push({
      id: buildWorkId(festivalId, no),
      festivalId,
      no,
      title,
      author,
      detailDisabled: true,
    });
  }

  notesByNo.set("04", [
    "Title inferred from forum evidence because the archived menu lost its caption text for this entry.",
  ]);
  notesByNo.set("28", [
    "Entry number survives in the archived menu, but no reliable title source was preserved.",
  ]);
  notesByNo.set("33", [
    "Title inferred from a duplicated No.32 forum thread; the original ss33.htm is no longer archived.",
  ]);

  return {
    festivalId,
    banner: "/banners/2006-summer.png",
    bannerSourceUrl:
      "https://web.archive.org/web/20211008072048im_/https://vipkohaku.x.fc2.com/2006s/tope-sama-.PNG",
    sources: [
      writeSourceHtml(festivalId, top.filename, top.url, top.content),
      writeSourceHtml(festivalId, menu.filename, menu.url, menu.content),
      writeSourceHtml(festivalId, forum.filename, forum.url, forum.content),
    ],
    works,
    entries: summaryFromWorks(works, notesByNo),
    notes: [
      "2006-summer is reconstructed from the surviving menu page, archived forum threads, and four remaining detail pages.",
      "The original FC2 site lost most per-entry pages, so several titles are best-effort reconstructions.",
    ],
  };
}

async function parse2005Kouhaku(): Promise<FestivalResult> {
  const festivalId = "2005-kouhaku";
  const page = await fetchHtml({
    url: "https://web.archive.org/web/20100107113105if_/http://vipkouhaku05.cs.land.to/",
    encoding: "shift_jis",
    filename: "index.html",
  });
  const timemapText = iconv.decode(
    await fetchBuffer(
      "https://web.archive.org/web/timemap/json?url=http%3A%2F%2Fvipkouhaku05.cs.land.to%2F&matchType=prefix&collapse=urlkey&output=json&fl=original,timestamp,endtimestamp,mimetype,statuscode&filter=!statuscode:%5B45%5D..&limit=100"
    ),
    "utf8"
  );
  const timemap = JSON.parse(timemapText) as string[][];
  const zipTimestampByOriginal = new Map<string, string>();
  for (const row of timemap.slice(1)) {
    const [original, timestamp, , mimetype] = row;
    if (mimetype === "application/zip") {
      zipTimestampByOriginal.set(original, timestamp);
    }
  }

  const cleaned = page.content
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  const section = cleaned
    .split("＊リンクをクリックするとDL開始します。")[1]
    .split("石川県金沢市住宅建築会社")[0];
  const noAndCategory = [...section.matchAll(/No\.(\d+)(紅組|白組)\s+(.+?)(?=No\.\d+(?:紅組|白組)|$)/g)].map(
    (match) => ({
      no: String(Number.parseInt(match[1], 10)).padStart(2, "0"),
      category: match[2],
    })
  );

  const workAnchors = page
    .$("a")
    .toArray()
    .filter((anchor) => {
      const href = page.$(anchor).attr("href") ?? "";
      return /\.zip$/i.test(href);
    })
    .slice(0, noAndCategory.length);

  const works: WorkEntry[] = workAnchors.map((anchor, index) => {
    const href = page.$(anchor).attr("href") ?? "";
    const title = cleanText(page.$(anchor).text());
    const resolvedOriginal = href.startsWith("http")
      ? href.replace(/^https:\/\/web\.archive\.org\/web\/\d+\//, "")
      : new URL(href, "http://vipkouhaku05.cs.land.to/").toString();
    const timestamp = zipTimestampByOriginal.get(resolvedOriginal);
    const downloadUrl = timestamp
      ? `https://web.archive.org/web/${timestamp}/${resolvedOriginal}`
      : absoluteWaybackUrl(page.url, href);
    return {
      id: buildWorkId(festivalId, noAndCategory[index].no),
      festivalId,
      no: noAndCategory[index].no,
      title,
      author: "",
      category: noAndCategory[index].category,
      download: downloadUrl
        ? {
            url: downloadUrl,
            label: "DL",
          }
        : undefined,
      detailDisabled: true,
    };
  });
  works.sort((a, b) => numericNo(a.no ?? "") - numericNo(b.no ?? ""));

  return {
    festivalId,
    banner: "/banners/2005-kouhaku.png",
    sources: [writeSourceHtml(festivalId, page.filename, page.url, page.content)],
    works,
    entries: summaryFromWorks(works),
    notes: ["No original 2005 banner image survives in the archive; a local placeholder PNG is generated separately."],
  };
}

async function main() {
  ensureDir(catchRoot);
  ensureDir(worksRoot);
  ensureDir(bannerRoot);

  const results = [
    await parse2008Kouhaku(),
    await parse2008SeiyokuFestival(),
    await parse2008Summer(),
    await parse2007DefaultBattleFestival(),
    await parse2007Gw(),
    await parse2007Summer(),
    await parse2006Gw(),
    await parse2006Kouhaku(),
    await parse2006Summer(),
    await parse2005Kouhaku(),
  ];

  for (const result of results) {
    writeJson(path.join(worksRoot, `${result.festivalId}.json`), result.works);
    writeJson(path.join(catchRoot, result.festivalId, `${result.festivalId}-scrape-summary.json`), {
      festivalId: result.festivalId,
      generatedAt: new Date().toISOString(),
      banner: result.banner,
      bannerSourceUrl: result.bannerSourceUrl,
      stats: {
        captured: result.works.length,
      },
      entries: result.entries,
      notes: result.notes ?? [],
    });
    console.log(`${result.festivalId}: ${result.works.length} works`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
