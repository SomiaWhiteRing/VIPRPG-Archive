import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

const FESTIVAL_ID = "2020-gw";
const FESTIVAL_SLUG = "2020-gw";
const BASE_URL = "https://vipgw2020.tubakurame.com";
const TOP_URL = `${BASE_URL}/top.html`;
const DATA_H_URL = `${BASE_URL}/data_h_local.json`;
const DATA_S_URL = `${BASE_URL}/games.json`;

const OUTPUT_WORKS = path.join(process.cwd(), "src", "data", "works", `${FESTIVAL_SLUG}.json`);
const CATCH_DIR = path.join(process.cwd(), "catch", FESTIVAL_SLUG);
const SUMMARY_PATH = path.join(CATCH_DIR, `${FESTIVAL_SLUG}-scrape-summary.json`);

const PUBLIC_DIR = path.join(process.cwd(), "public");
const BANNERS_DIR = path.join(PUBLIC_DIR, "banners");
const ICONS_DIR = path.join(PUBLIC_DIR, "icons", FESTIVAL_SLUG);
const SCREENSHOTS_DIR = path.join(PUBLIC_DIR, "screenshots", FESTIVAL_SLUG);

const RELATIVE_ICONS_DIR = `/icons/${FESTIVAL_SLUG}`;
const RELATIVE_SCREENSHOTS_DIR = `/screenshots/${FESTIVAL_SLUG}`;

const MAX_SCREENSHOTS = 6;
const SMALL_IMAGE_LIMIT = 100;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)" +
  " Chrome/130.0.0.0 Safari/537.36";

type DataH = {
  lastUpdate: number | string;
  games: Array<{
    gameid: number;
    name_game: string;
    name_author: string;
    genre?: string;
    tool?: string;
    stream?: string;
    comment?: string;
    modified?: string;
    game_url: string[];
  }>;
};

type DataS = {
  games: Array<{
    icon?: string;
    ss?: string[];
    forum?: string;
    a_com?: string; // additional comment
  }>;
};

interface ScreenshotSkip { source: string; reason: "small" | "duplicate"; }

interface SnapshotRecord {
  index: string;
  status: "ok" | "error";
  title?: string;
  icon?: string;
  downloadSource?: string[];
  screenshotReport?: { saved: number; skipped?: ScreenshotSkip[]; failures?: string[] };
  error?: string;
}

interface WorkEntryOut {
  id: string;
  festivalId: string;
  no: string;
  title: string;
  author: string;
  category?: string;
  engine?: string;
  streaming?: string;
  forum?: string;
  authorComment?: string;
  hostComment?: string;
  icon?: string;
  ss?: string[];
}

function sanitizeWhitespace(v?: string | null) {
  if (!v) return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t || undefined;
}

function sanitizeMultiline(v?: string | null) {
  if (!v) return undefined;
  const lines = v
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const out = lines.join("\n").trim();
  return out || undefined;
}

async function ensureDir(dir: string) { await fs.mkdir(dir, { recursive: true }); }

async function fetchText(url: string) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/json" },
      cache: "no-store", redirect: "follow", referrerPolicy: "no-referrer"
    } as RequestInit);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } catch (e) {
    // curl fallback
    const args = [
      "-sSL",
      "--fail",
      "--http1.1",
      "-A",
      USER_AGENT,
      url,
    ];
    const { stdout } = await execFileAsync("curl", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    return stdout;
  }
}

async function fetchBinary(url: string) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
      cache: "no-store", redirect: "follow", referrerPolicy: "no-referrer"
    } as RequestInit);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const ab = await res.arrayBuffer();
    return { buffer: Buffer.from(ab), contentType: (res.headers.get("content-type") ?? "").toLowerCase() };
  } catch (e) {
    // curl fallback (binary)
    const args = [
      "-sSL",
      "--fail",
      "--http1.1",
      "-A",
      USER_AGENT,
      url,
    ];
    const { stdout } = await execFileAsync("curl", args, { encoding: "latin1", maxBuffer: 50 * 1024 * 1024 });
    const buf = Buffer.from(stdout, "binary");
    return { buffer: buf, contentType: "" };
  }
}

function getImageExtension(input: string, fallback = ".png") {
  const base = input.split(/[?#]/)[0];
  const ext = path.extname(base).toLowerCase();
  if (ext === ".jpeg") return ".jpg";
  return ext || fallback;
}

function getImageDimensions(buffer: Buffer) {
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 26 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1;
      if (offset + 1 >= buffer.length) break;
      const marker = buffer[offset + 1];
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (marker === 0xda) break;
      if (offset + 7 >= buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xcc) {
        if (offset + 5 >= buffer.length) break;
        const height = buffer.readUInt16BE(offset + 3);
        const width = buffer.readUInt16BE(offset + 5);
        return { width, height };
      }
      offset += length;
    }
  }
  if (buffer.length >= 10 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length >= 26 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    const width = buffer.readInt32LE(18);
    const height = Math.abs(buffer.readInt32LE(22));
    return { width, height };
  }
  return undefined;
}

function looksLikeImageBuffer(buffer: Buffer, contentType: string) {
  if (contentType && contentType.startsWith("image/")) return true;
  if (buffer.length >= 4) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true; // PNG
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return true; // JPEG
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return true; // GIF
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) return true; // BMP
  }
  return false;
}

async function resolveImageUnderImgDir(name: string): Promise<string | undefined> {
  // Try extensionless path first (server maps without extension)
  try {
    const urlNoExt = `${BASE_URL}/img/${name}`;
    const res = await fetch(urlNoExt, { method: 'GET', cache: 'no-store', redirect: 'follow' } as RequestInit);
    if (res.ok) return urlNoExt;
  } catch {}
  // Then fall back to common extensions
  const exts = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".PNG", ".JPG", ".GIF"];
  for (const ext of exts) {
    const url = `${BASE_URL}/img/${name}${ext}`;
    try {
      const res = await fetch(url, { method: 'GET', cache: 'no-store', redirect: 'follow' } as RequestInit);
      if (res.ok) return url;
    } catch {}
  }
  return undefined;
}

async function copyIcon(index: string, iconName?: string): Promise<string | undefined> {
  if (!iconName || iconName.trim() === "") iconName = "default_icon.png";
  const iconUrl = await resolveImageUnderImgDir(iconName);
  if (!iconUrl) return undefined;
  await ensureDir(ICONS_DIR);
  try {
    const { buffer, contentType } = await fetchBinary(iconUrl);
    if (!looksLikeImageBuffer(buffer, contentType)) return undefined;
    const ext = getImageExtension(iconUrl, ".png");
    const file = `${index}${ext}`;
    await fs.writeFile(path.join(ICONS_DIR, file), buffer);
    return path.posix.join(RELATIVE_ICONS_DIR, file);
  } catch {
    return undefined;
  }
}

async function copyScreenshots(index: string, names: (string | undefined)[]): Promise<{ paths: string[]; skipped: ScreenshotSkip[]; failures: string[] }> {
  await ensureDir(SCREENSHOTS_DIR);
  // Purge old
  try {
    const files = await fs.readdir(SCREENSHOTS_DIR);
    await Promise.all(files.filter(f => f.startsWith(index)).map(f => fs.unlink(path.join(SCREENSHOTS_DIR, f)).catch(() => undefined)));
  } catch {}
  const skipped: ScreenshotSkip[] = [];
  const failures: string[] = [];
  const saved: string[] = [];
  const hashSet = new Set<string>();
  let order = 1;
  const candidates = (names || []).filter((n): n is string => !!n && n.trim() !== "");
  if (candidates.length === 0) candidates.push("default_ss1.png");
  for (const nm of candidates) {
    if (!nm) continue;
    if (saved.length >= MAX_SCREENSHOTS) break;
    const url = await resolveImageUnderImgDir(nm);
    if (!url) continue;
    try {
      const { buffer, contentType } = await fetchBinary(url);
      if (!looksLikeImageBuffer(buffer, contentType)) { failures.push(url + ` (not image: ${contentType || "unknown"})`); continue; }
      const dim = getImageDimensions(buffer);
      if (dim && dim.width < SMALL_IMAGE_LIMIT && dim.height < SMALL_IMAGE_LIMIT) { skipped.push({ source: url, reason: "small" }); continue; }
      const md5 = createHash("md5").update(buffer).digest("hex");
      if (hashSet.has(md5)) { skipped.push({ source: url, reason: "duplicate" }); continue; }
      hashSet.add(md5);
      const ext = getImageExtension(url, ".png");
      const file = order === 1 ? `${index}${ext}` : `${index}-${String(order).padStart(2, "0")}${ext}`;
      await fs.writeFile(path.join(SCREENSHOTS_DIR, file), buffer);
      saved.push(path.posix.join(RELATIVE_SCREENSHOTS_DIR, file));
      order += 1;
    } catch (e) {
      failures.push(url + " => " + (e as Error).message);
    }
  }
  return { paths: saved, skipped, failures };
}

async function run() {
  await ensureDir(CATCH_DIR);
  await ensureDir(BANNERS_DIR);
  await ensureDir(ICONS_DIR);
  await ensureDir(SCREENSHOTS_DIR);

  // Cache top page for banner candidates
  try {
    const topHtml = await fetchText(TOP_URL);
    await fs.writeFile(path.join(CATCH_DIR, "top.html"), topHtml, "utf8");
    const $ = cheerio.load(topHtml);
    const banner = $("img#banner").attr("src") || "/img/gw2020_1.png";
    const bannerAbs = new URL(banner, TOP_URL).toString();
    try {
      const { buffer } = await fetchBinary(bannerAbs);
      const ext = getImageExtension(bannerAbs, ".png");
      await fs.writeFile(path.join(BANNERS_DIR, `${FESTIVAL_SLUG}${ext}`), buffer);
    } catch {}
  } catch {}

  // Load JSON data
  const hRaw = await fetchText(DATA_H_URL);
  const sRaw = await fetchText(DATA_S_URL);
  await fs.writeFile(path.join(CATCH_DIR, "data_h_local.json"), hRaw, "utf8");
  await fs.writeFile(path.join(CATCH_DIR, "games.json"), sRaw, "utf8");
  const dataH = JSON.parse(hRaw) as DataH;
  const dataS = JSON.parse(sRaw) as DataS;

  const works: WorkEntryOut[] = [];
  const summary: SnapshotRecord[] = [];

  // Add No.0 (sample) entry based on top.html template
  try {
    const sampleIcon = await copyIcon("00", "default_icon.png");
    const sampleSS = await copyScreenshots("00", ["default_ss1.png", "default_ss2.png"]);
    const sample: WorkEntryOut = {
      id: `${FESTIVAL_ID}-work-00`,
      festivalId: FESTIVAL_ID,
      no: "0",
      title: "サンプル",
      author: "管理人",
      category: "サンプルゲーム",
      engine: "Steam2003",
      streaming: "18歳以上は不可",
      forum: "https://jbbs.shitaraba.net/bbs/read.cgi/game/60946/1587008069/l1000",
      authorComment: "作品情報のサンプルです。\nアイコン・SSが未指定の場合はこのようになります。",
      icon: sampleIcon,
      ss: sampleSS.paths.length > 0 ? sampleSS.paths : undefined,
    };
    works.push(sample);
    summary.push({ index: "00", status: "ok", title: sample.title, icon: sampleIcon, screenshotReport: { saved: sampleSS.paths.length } });
  } catch {}

  // Games arrays align by index in JSON files
  for (let i = 0; i < dataH.games.length; i++) {
    const h = dataH.games[i];
    const s = dataS.games[i] || {};
    const noRaw = String(h.gameid);
    const index = noRaw.padStart(2, "0");

    const iconLocal = await copyIcon(index, s.icon);
    const shots = Array.isArray(s.ss) ? s.ss : [];
    const ssResult = await copyScreenshots(index, shots);

    const work: WorkEntryOut = {
      id: `${FESTIVAL_ID}-work-${index}`,
      festivalId: FESTIVAL_ID,
      no: noRaw,
      title: sanitizeWhitespace(h.name_game) ?? `Work ${index}`,
      author: sanitizeWhitespace(h.name_author) ?? "",
      category: sanitizeWhitespace(h.genre),
      engine: sanitizeWhitespace(h.tool),
      streaming: sanitizeWhitespace(h.stream),
      forum: s.forum,
      authorComment: sanitizeMultiline(h.comment),
      hostComment: sanitizeMultiline(s.a_com),
      icon: iconLocal,
      ss: ssResult.paths.length > 0 ? ssResult.paths : undefined,
    };
    works.push(work);

    summary.push({
      index,
      status: "ok",
      title: work.title,
      icon: iconLocal,
      downloadSource: h.game_url && h.game_url.length ? h.game_url.filter((u) => !!u) : undefined,
      screenshotReport: { saved: ssResult.paths.length, skipped: ssResult.skipped.length ? ssResult.skipped : undefined, failures: ssResult.failures.length ? ssResult.failures : undefined },
    });
  }

  await fs.writeFile(OUTPUT_WORKS, JSON.stringify(works, null, 2), "utf8");
  await fs.writeFile(SUMMARY_PATH, JSON.stringify(summary, null, 2), "utf8");
  console.log(`Saved works to ${OUTPUT_WORKS}`);
  console.log(`Summary written to ${SUMMARY_PATH}`);
}

run().catch((err) => { console.error(err); process.exit(1); });
