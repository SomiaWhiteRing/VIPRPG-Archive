"use client";

import { useEffect, useRef, useState } from "react";
import { useLanguage } from "@/components/language-context";
import { normalizeOriginalLocation, originalSourceAddress, updateOriginalSnapshot, type OriginalBrowserSnapshot } from "@/lib/original-browser";

export default function OriginalFestivalView({ slug, name, entry, sources }: {
  slug: string;
  name: string;
  entry: string;
  sources: Record<string, string>;
}) {
  const { dictionary } = useLanguage();
  const root = `/original-pages/${slug}/`;
  const initial: OriginalBrowserSnapshot = { pages: { "": entry }, address: entry };
  const frameRef = useRef<HTMLIFrameElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef([initial]);
  const indexRef = useRef(0);
  const documentsRef = useRef<Record<string, string>>({});
  const restoringRef = useRef<OriginalBrowserSnapshot | null>(null);
  const restoredPagesRef = useRef<Record<string, string>>({});
  const pendingNavigationRef = useRef(false);
  const [navigation, setNavigation] = useState({ index: 0, length: 1, address: entry });
  const [frame, setFrame] = useState({ key: 0, src: entry });
  const [loading, setLoading] = useState(true);
  const [copyStatus, setCopyStatus] = useState<"" | "copied" | "manual">("");

  useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data;
      if (!data || !["archive-browser-state", "archive-browser-activity"].includes(data.type) ||
          !Array.isArray(data.path) || data.path.length > 16 ||
          !data.path.every((part: unknown) => Number.isInteger(part) && Number(part) >= 0 && Number(part) < 1000) ||
          typeof data.url !== "string" || typeof data.documentId !== "string") return;
      const local = normalizeOriginalLocation(data.url, window.location.origin, root, sources);
      if (!local) return;
      const key = data.path.join(".");
      if (data.type === "archive-browser-activity") {
        restoringRef.current = null;
        pendingNavigationRef.current = true;
        return;
      }

      const newDocument = documentsRef.current[key] !== undefined && documentsRef.current[key] !== data.documentId;
      if (newDocument) for (const child of Object.keys(documentsRef.current)) {
        if (child !== key && (!key || child.startsWith(`${key}.`))) {
          delete documentsRef.current[child];
          delete restoredPagesRef.current[child];
        }
      }
      documentsRef.current[key] = data.documentId;
      const restoring = restoringRef.current;
      if (restoring) {
        // Ignore a departing document's children until its replacement is ready.
        for (let depth = 0; depth < data.path.length; depth++) {
          const ancestor = data.path.slice(0, depth).join(".");
          if (restoring.pages[ancestor] !== restoredPagesRef.current[ancestor]) return;
        }
        restoredPagesRef.current[key] = local;
        const expected = restoring.pages[key];
        if (expected && expected !== local) {
          setLoading(true);
          frameRef.current?.contentWindow?.postMessage({
            type: "archive-browser-restore", path: data.path, url: new URL(expected, window.location.origin).href,
          }, "*");
          return;
        }
        if (!expected) restoring.pages[key] = local;
        if (Object.entries(restoring.pages).every(([path, target]) => restoredPagesRef.current[path] === target)) setLoading(false);
        // Keep restoration armed through legacy onload handlers, until user input.
        return;
      }

      if (!key && data.loaded) setLoading(false);
      if (!newDocument && historyRef.current[indexRef.current].pages[key] === local) return;
      const result = updateOriginalSnapshot(historyRef.current[indexRef.current], key, local, newDocument);
      // A source action may redirect several frames while initializing a view.
      // Keep those updates in one entry, rather than exposing transient pages.
      if (result.navigated && !data.replace && pendingNavigationRef.current) {
        historyRef.current = historyRef.current.slice(0, indexRef.current + 1);
        historyRef.current.push(result.snapshot);
        indexRef.current++;
        pendingNavigationRef.current = false;
      } else historyRef.current[indexRef.current] = result.snapshot;
      setNavigation({ index: indexRef.current, length: historyRef.current.length, address: result.snapshot.address });
      setCopyStatus("");
    }
    window.addEventListener("message", receive);
    frameRef.current?.contentWindow?.postMessage({ type: "archive-browser-query" }, "*");
    return () => window.removeEventListener("message", receive);
  }, [root, sources]);

  function restore(index: number) {
    const snapshot = historyRef.current[index];
    if (!snapshot) return;
    indexRef.current = index;
    restoringRef.current = snapshot;
    restoredPagesRef.current = {};
    documentsRef.current = {};
    pendingNavigationRef.current = false;
    setLoading(true);
    setCopyStatus("");
    setNavigation({ index, length: historyRef.current.length, address: snapshot.address });
    // A fresh iframe isolates these controls from the outer page's browser history.
    setFrame((previous) => ({ key: previous.key + 1, src: snapshot.pages[""] }));
  }

  function home() {
    historyRef.current = historyRef.current.slice(0, indexRef.current + 1);
    historyRef.current.push({ pages: { "": entry }, address: entry });
    restore(indexRef.current + 1);
  }

  const address = originalSourceAddress(navigation.address, root, sources);
  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(address);
      setCopyStatus("copied");
    } catch {
      addressRef.current?.focus();
      addressRef.current?.select();
      setCopyStatus("manual");
    }
  }

  return (
    <section className="original-festival-view" aria-label={`${name} — ${dictionary.originalView}`}>
      <div className="original-browser">
        <div className="original-browser-titlebar">
          <span className="original-browser-logo" aria-hidden="true">e</span>
          <span>{name}</span>
          <span className="original-browser-edition">{dictionary.originalView}</span>
        </div>
        <nav className="original-browser-toolbar" aria-label={dictionary.originalBrowserNavigation}>
          <button type="button" disabled={loading || navigation.index === 0} onClick={() => restore(navigation.index - 1)}>
            <span className="browser-tool-icon browser-tool-back" aria-hidden="true">➜</span>{dictionary.browserBack}
          </button>
          <button type="button" disabled={loading || navigation.index >= navigation.length - 1} onClick={() => restore(navigation.index + 1)}>
            <span className="browser-tool-icon" aria-hidden="true">➜</span>{dictionary.browserForward}
          </button>
          <span className="browser-tool-separator" aria-hidden="true" />
          <button type="button" onClick={() => restore(indexRef.current)}>
            <span className="browser-tool-icon browser-tool-refresh" aria-hidden="true">⟳</span>{dictionary.browserRefresh}
          </button>
          <button type="button" onClick={home}>
            <span className="browser-tool-icon browser-tool-home" aria-hidden="true">⌂</span>{dictionary.browserHome}
          </button>
        </nav>
        <div className="original-browser-addressbar">
          <label htmlFor="original-browser-address">{dictionary.browserAddress}</label>
          <div className="original-browser-address-field">
            <span className="original-browser-address-icon" aria-hidden="true">e</span>
            <input id="original-browser-address" ref={addressRef} value={address} readOnly onFocus={(event) => event.currentTarget.select()} spellCheck={false} />
          </div>
          <button type="button" onClick={copyAddress}>{dictionary.browserCopyAddress}</button>
        </div>
        <div className="original-browser-viewport">
          <iframe key={frame.key} ref={frameRef} className="original-festival-frame" src={frame.src}
            onLoad={() => {
              frameRef.current?.contentWindow?.postMessage({ type: "archive-browser-query" }, "*");
              if (!restoringRef.current) setLoading(false);
            }}
            title={`${name} — ${dictionary.originalView}`} sandbox="allow-scripts" referrerPolicy="no-referrer" />
        </div>
        <div className="original-browser-statusbar" role="status" aria-live="polite">
          <span>{copyStatus === "copied" ? dictionary.browserAddressCopied : copyStatus === "manual" ? dictionary.browserCopyManually : loading ? dictionary.browserLoading : dictionary.browserReady}</span>
          <span>{dictionary.browserArchivedCopy}</span>
        </div>
      </div>
    </section>
  );
}
