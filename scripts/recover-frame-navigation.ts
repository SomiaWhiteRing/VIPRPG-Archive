import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'cheerio';

// Shared by fresh recovery and the offline upgrade of existing reading copies.
export function repairFrameNavigation(id: string, files: Map<string, Buffer>): string[] {
  // This festival already translates JavaScript navigation and dynamic queries.
  if (id === '2020-gw') return [];
  const pages = [...files.keys()].filter(name => /\.html?$/i.test(name));
  if (!pages.some(name => /<frame\s/i.test(files.get(name)!.toString('utf8')))) return [];
  const scriptName = 'archive-frame-navigation.js';
  const changed: string[] = [];
  for (const name of pages) {
    const html = files.get(name)!.toString('utf8');
    const $ = load(html);
    if (!$('frame,a[target][href],area[target][href],base[target]').length) continue;
    if ($('script[data-archive-frame-navigation]').length) continue;
    const src = path.posix.relative(path.posix.dirname(name), scriptName);
    const tag = `<script data-archive-frame-navigation src="${src}"></script>`;
    // Preserve source formatting and insert before any original event handlers.
    const updated = html.replace(/<head\b[^>]*>/i, match => match + tag);
    if (updated === html) throw new Error(`Missing head: ${id}/${name}`);
    files.set(name, Buffer.from(updated));
    changed.push(name);
  }
  const script = `(function(){
  'use strict';
  var root='/original-pages/'+${JSON.stringify(id)}+'/';
  var pages=new Set(${JSON.stringify(pages)});
  var kind='archive-local-frame-v1';
  function valid(data){
    if(!data||data.type!==kind||typeof data.target!=='string'||typeof data.url!=='string')return false;
    try{var u=new URL(data.url);return u.origin===location.origin&&u.pathname.startsWith(root)&&pages.has(decodeURIComponent(u.pathname.slice(root.length)))}catch(e){return false}
  }
  function children(){return Array.from(document.querySelectorAll('frame,iframe'))}
  function isRoot(){return parent===window||parent===top}
  function descend(data){
    var nodes=children(),found=nodes.find(function(f){return f.name===data.target});
    if(found){found.src=data.url;return}
    nodes.forEach(function(f){f.contentWindow.postMessage(Object.assign({},data,{down:true}),'*')});
  }
  function route(data){
    if(data.target==='_parent'){location.href=data.url;return}
    if(data.target!=='_top'){
      var found=children().find(function(f){return f.name===data.target});
      if(found){found.src=data.url;return}
    }
    if(!isRoot()){parent.postMessage(data,'*');return}
    if(data.target==='_top'){location.href=data.url;return}
    descend(data);
  }
  addEventListener('message',function(e){
    if(!valid(e.data))return;
    if(e.data.down){if(!isRoot()&&e.source===parent)descend(e.data);return}
    if(children().some(function(f){return f.contentWindow===e.source}))route(e.data);
  });
  addEventListener('click',function(e){
    if(e.defaultPrevented||e.button!==0||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;
    var a=e.target.closest&&e.target.closest('a[href],area[href]');if(!a||a.hasAttribute('download'))return;
    var base=document.querySelector('base[target]');
    var target=a.getAttribute('target')||(base&&base.getAttribute('target'))||'_self';
    if(target==='_self'||target==='_blank'||target===window.name)return;
    var data={type:kind,target:target,url:a.href};if(!valid(data))return;
    e.preventDefault();e.stopImmediatePropagation();
    if(isRoot())route(data);else parent.postMessage(data,'*');
  },true);
})();
`;
  const bytes = Buffer.from(script);
  if (!files.get(scriptName)?.equals(bytes)) { files.set(scriptName, bytes); changed.push(scriptName); }
  return changed;
}

async function main() {
  const views = JSON.parse(await fs.readFile('src/data/original-views.json', 'utf8'));
  const report: Record<string, string[]> = {};
  for (const id of Object.keys(views)) {
    const directory = path.join('public/original-pages', id);
    const files = new Map<string, Buffer>();
    async function read(dir: string) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await read(file);
        else if (/\.html?$|^archive-frame-navigation\.js$/i.test(entry.name)) files.set(path.relative(directory, file).split(path.sep).join('/'), await fs.readFile(file));
      }
    }
    await read(directory);
    const changed = repairFrameNavigation(id, files);
    if (files.has('archive-frame-navigation.js')) {
      const metadataPath = path.join('catch', id, 'original-view.json');
      const original = await fs.readFile(metadataPath, 'utf8');
      const metadata = JSON.parse(original);
      if (!metadata.files.includes('archive-frame-navigation.js')) {
        metadata.files.push('archive-frame-navigation.js');
        (metadata.compatibilityFixes ??= []).push({ page: '*.html', change: 'Route captured named-frame and ancestor navigation through owned frames; preserve the sandbox and source layout. Desktop review pending.' });
        metadata.desktopReview = 'pending';
        await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
      }
    }
    if (!changed.length) continue;
    for (const name of changed) await fs.writeFile(path.join(directory, name), files.get(name)!);
    report[id] = changed;
  }
  if (Object.keys(report).length) {
    const reportPath = 'catch/frame-navigation-repair.json';
    const previous = await fs.readFile(reportPath, 'utf8').then(text => JSON.parse(text).changes).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return {};
    });
    for (const [id, names] of Object.entries(report)) previous[id] = [...new Set([...(previous[id] ?? []), ...names])];
    await fs.writeFile(reportPath, JSON.stringify({ desktopReview: 'pending', changes: previous }, null, 2) + '\n');
  }
  console.log(JSON.stringify(Object.fromEntries(Object.entries(report).map(([id, pages]) => [id, pages.length])), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error); process.exitCode = 1; });
