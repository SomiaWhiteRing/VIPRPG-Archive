export interface OriginalBrowserSnapshot {
  pages: Record<string, string>;
  address: string;
}

export function normalizeOriginalLocation(value: string, origin: string, root: string, sources: Record<string, string>): string | undefined {
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || !url.pathname.startsWith(root)) return;
    const path = decodeURIComponent(url.pathname.slice(root.length));
    // Cloudflare's static host removes .html and serves index.html at directories.
    const candidates = [path, ...(path.endsWith("/") || !path ? [`${path}index.html`] : [`${path}.html`, `${path}.htm`])];
    const page = candidates.find((candidate) => Object.hasOwn(sources, candidate));
    if (!page) return;
    return root + page.split("/").map(encodeURIComponent).join("/") + url.search + url.hash;
  } catch { return; }
}

export function updateOriginalSnapshot(snapshot: OriginalBrowserSnapshot, key: string, url: string, newDocument: boolean) {
  const previous = snapshot.pages[key];
  const navigated = previous !== undefined && previous !== url;
  const pages = { ...snapshot.pages };
  if (newDocument || navigated) {
    for (const child of Object.keys(pages)) {
      if (child !== key && (!key || child.startsWith(`${key}.`))) delete pages[child];
    }
  }
  pages[key] = url;
  const address = navigated || !Object.values(pages).includes(snapshot.address) ? url : snapshot.address;
  return { snapshot: { pages, address }, navigated };
}

export function originalSourceAddress(local: string, root: string, sources: Record<string, string>) {
  const url = new URL(local, "https://archive.invalid");
  const source = sources[decodeURIComponent(url.pathname.slice(root.length))];
  if (!source) return "";
  const original = new URL(source);
  if (/\/archive-(closed|external)\.html$/.test(url.pathname)) {
    const target = url.searchParams.get("url");
    if (target && /^https?:\/\//i.test(target)) {
      try { return new URL(target).href; } catch { /* Keep the site's known address. */ }
    }
    return original.href;
  }
  url.searchParams.forEach((value, key) => original.searchParams.set(key, value));
  if (url.hash) original.hash = url.hash;
  return original.href;
}
