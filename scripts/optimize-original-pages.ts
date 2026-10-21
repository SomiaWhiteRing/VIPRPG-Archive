import fs from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";

// Only change exported reading copies; the recovered public/ and catch/ files stay intact.
const root = path.resolve("out/original-pages");
const assetRoot = path.resolve("out");
const imageSizes = new Map<string, number>();
let pages = 0;
let deferred = 0;
let asyncImages = 0;
let deferredBackgrounds = 0;

const backgroundLoader = `<script data-archive-image-loading>
(function(){
  var nodes=document.querySelectorAll('[data-archive-background]');
  function load(node){node.style.backgroundImage=node.getAttribute('data-archive-background');node.removeAttribute('data-archive-background')}
  if(!('IntersectionObserver' in window)){nodes.forEach(load);return}
  var observer=new IntersectionObserver(function(entries){entries.forEach(function(entry){if(entry.isIntersecting){load(entry.target);observer.unobserve(entry.target)}})},{rootMargin:'300px'});
  nodes.forEach(function(node){observer.observe(node)});
})();
</script>`;

function attribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

async function imageSize(src: string, owner: string): Promise<number> {
  try {
    const base = new URL(path.relative(assetRoot, owner).split(path.sep).join("/"), "https://archive.invalid/");
    const url = new URL(src, base);
    if (url.origin !== base.origin) return 0;
    const file = path.join(assetRoot, decodeURIComponent(url.pathname));
    if (!imageSizes.has(file)) imageSizes.set(file, (await fs.stat(file)).size);
    return imageSizes.get(file)!;
  } catch (error) {
    if (error instanceof URIError || error instanceof TypeError ||
        ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return 0;
    throw error;
  }
}

async function optimize(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await optimize(file);
      continue;
    }
    if (!/\.html?$/i.test(entry.name)) continue;
    const html = await fs.readFile(file, "utf8");
    const $ = load(html, { sourceCodeLocationInfo: true });
    const additions: { offset: number; length?: number; attributes: string }[] = [];
    let networkImages = 0;
    for (const image of $("img[src]").toArray()) {
      const node = $(image);
      const src = node.attr("src")?.trim();
      if (!src || /^(?:data:|blob:)/i.test(src)) continue;
      networkImages++;
      let attributes = "";
      // Keep the first two network images eager for headers and the first preview.
      // Small icons remain eager so unspecified intrinsic sizes don't collapse.
      // Explicit source priorities, image maps and loading behavior take precedence.
      if (networkImages > 2 && node.attr("loading") === undefined &&
          node.attr("fetchpriority") !== "high" && node.attr("usemap") === undefined &&
          await imageSize(src, file) >= 16 * 1024) {
        attributes += ' loading="lazy"';
        deferred++;
      }
      if (node.attr("decoding") === undefined) {
        attributes += ' decoding="async"';
        asyncImages++;
      }
      if (!attributes) continue;
      const start = image.startIndex;
      if (start == null || !/^<img\b/i.test(html.slice(start, start + 5))) {
        throw new Error(`Missing image source location: ${file}`);
      }
      additions.push({ offset: start + 4, attributes });
    }
    // The recovered card catalogue uses CSS backgrounds rather than <img>.
    // Defer only these fixed-size cards; leave page backgrounds and headers alone.
    const cards = $(".entry-card[style]").toArray();
    const fallback: string[] = [];
    if (cards.length >= 8) for (const [index, card] of cards.entries()) {
      if (index < 2) continue;
      const style = $(card).attr("style")!;
      const match = /background-image\s*:\s*(url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\))\s*;?/i.exec(style);
      if (!match) continue;
      const src = match[1].replace(/^url\(\s*["']?|["']?\s*\)$/gi, "");
      if (await imageSize(src, file) < 16 * 1024) continue;
      const location = (card as typeof card & {
        sourceCodeLocation?: { attrs?: { style?: { startOffset: number; endOffset: number } } };
      }).sourceCodeLocation?.attrs?.style;
      if (!location) throw new Error(`Missing background source location: ${file}`);
      const remainder = style.slice(0, match.index) + style.slice(match.index + match[0].length);
      additions.push({
        offset: location.startOffset,
        length: location.endOffset - location.startOffset,
        attributes: `style="${attribute(remainder)}" data-archive-background="${attribute(match[1])}" data-archive-background-id="${index}"`,
      });
      fallback.push(`[data-archive-background-id="${index}"]{background-image:${match[1].replaceAll("<", "\\3c ")}!important}`);
      deferredBackgrounds++;
    }
    if (fallback.length) {
      const bodyEnd = /<\/body\s*>/i.exec(html)?.index ?? html.length;
      additions.push({ offset: bodyEnd, attributes: `${backgroundLoader}<noscript><style>${fallback.join("\n")}</style></noscript>` });
    }
    if (!additions.length) continue;
    let optimized = html;
    for (const { offset, length = 0, attributes } of additions.sort((a, b) => b.offset - a.offset)) {
      optimized = optimized.slice(0, offset) + attributes + optimized.slice(offset + length);
    }
    await fs.writeFile(file, optimized);
    pages++;
  }
}

optimize(root).then(() => {
  console.log(JSON.stringify({ originalPagesOptimized: pages, deferredImages: deferred, asyncImages, deferredBackgrounds }));
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
