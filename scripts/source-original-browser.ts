import fs from "node:fs/promises";
import path from "node:path";
import { isUtf8 } from "node:buffer";
import { load } from "cheerio";

// Static asset hosts may serve text/html without a charset. Keep the declaration
// within the browser's first 1024 bytes, independently of HTTP headers or locale.
export function normalizeOriginalHtmlEncoding(html: string): string {
  const $ = load(html, { sourceCodeLocationInfo: true });
  const declarations = $("meta").toArray().filter((node) =>
    $(node).attr("charset") !== undefined || $(node).attr("http-equiv")?.toLowerCase() === "content-type"
  );
  const allUtf8 = declarations.every((node) => /^utf-?8$/i.test(
    $(node).attr("charset") ?? $(node).attr("content")?.match(/charset\s*=\s*([^;\s]+)/i)?.[1] ?? ""
  ));
  if (allUtf8 && declarations.some((node) => node.endIndex != null && Buffer.byteLength(html.slice(0, node.endIndex + 1)) <= 1024)) return html;
  for (const node of declarations.reverse()) {
    if (node.startIndex == null || node.endIndex == null) throw new Error("Missing charset declaration source location");
    html = html.slice(0, node.startIndex) + html.slice(node.endIndex + 1);
  }
  const tag = '<meta charset="UTF-8">';
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (head) => head + tag);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (root) => root + tag);
  if (/<!doctype\b[^>]*>/i.test(html)) return html.replace(/<!doctype\b[^>]*>/i, (doctype) => doctype + tag);
  return tag + html;
}

interface SourceConfig {
  base: string;
  seedUrls?: Record<string, string>;
  cgiProfile?: boolean;
}

// Only reading copies and their URL index change; no source cache is rewritten.
export async function prepareOriginalBrowser(id: string, config: SourceConfig) {
  const directory = path.join("public/original-pages", id);
  const recovery = JSON.parse(await fs.readFile(`catch/${id}/recovery.json`, "utf8"));
  const mapped: Record<string, string> = {};
  for (const [url, local] of Object.entries(recovery.originalResources ?? {}) as [string, string][]) {
    if (!mapped[local]) mapped[local] = url;
  }
  const sources: Record<string, string> = {};
  let pagesUpdated = 0;
  const encodingRepairs: string[] = [];
  async function visit(folder: string) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) { await visit(file); continue; }
      if (!/\.html?$/i.test(entry.name)) continue;
      const local = path.relative(directory, file).split(path.sep).join("/");
      let source = config.seedUrls?.[local] ?? mapped[local];
      if (!source && config.cgiProfile) {
        const detail = /^db\/entry(\d{3})\.html$/.exec(local);
        const template = ({ "db/index.html": "view", "db/thumbnails.html": "view3", "db/interim.html": "view4", "db2/index.html": "view", "db2/summary.html": "view2" } as Record<string, string>)[local];
        if (detail) source = new URL(`db/profile.cgi?_v=${detail[1]}&tpl=view2`, config.base).href;
        else if (template) source = new URL(`${local.split("/")[0]}/profile.cgi?tpl=${template}`, config.base).href;
        else if (/^sc\d{2}\/index.html$/.test(local)) source = new URL(`${local.split("/")[0]}/profile.cgi`, config.base).href;
      }
      // These two notices are archive UI, not pages that existed at the source.
      sources[local] = id === "2020-gw" && /^archive-(closed|external)\.html$/.test(local)
        ? config.base : source ?? new URL(local, config.base).href;
      const bytes = await fs.readFile(file);
      if (!isUtf8(bytes)) throw new Error(`Reading copy is not valid UTF-8: ${file}`);
      const html = bytes.toString("utf8");
      const tag = '<script data-archive-browser src="/archive-browser.js"></script>';
      let updated = html;
      if (!/\bdata-archive-browser\b/.test(html)) {
        const insertion = /<head\b[^>]*>/i.exec(html) ?? /<html\b[^>]*>/i.exec(html) ?? /<!doctype\b[^>]*>/i.exec(html);
        const offset = insertion ? insertion.index + insertion[0].length : 0;
        updated = html.slice(0, offset) + tag + html.slice(offset);
      }
      const normalized = normalizeOriginalHtmlEncoding(updated);
      if (normalized !== updated) encodingRepairs.push(local);
      updated = normalized;
      if (updated === html) continue;
      await fs.writeFile(file, updated);
      pagesUpdated++;
    }
  }
  await visit(directory);
  return { sources, pagesUpdated, encodingRepairs };
}

export async function saveOriginalBrowserSources(updates: Record<string, Record<string, string>>) {
  const file = "src/data/original-page-sources.json";
  const previous = await fs.readFile(file, "utf8").then(JSON.parse).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return {};
  });
  await fs.writeFile(file, JSON.stringify({ ...previous, ...updates }, null, 2) + "\n");
}
