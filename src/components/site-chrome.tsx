"use client";

import Link from "next/link";
import { useLanguage } from "@/components/language-context";

export default function SiteChrome({ children }: { children: React.ReactNode }) {
  const { dictionary, locales, locale, setLocale } = useLanguage();

  return (
    <div className="site-shell" data-locale={locale}>
      <header className="site-header">
        <div className="site-headline">
          <h1 className="site-title">
            <Link href="/" className="site-title-link">
              {dictionary.siteTitle}
            </Link>
          </h1>
          <p className="site-subtitle">{dictionary.siteSubtitle}</p>
        </div>
      </header>
      <main className="site-main">{children}</main>
      <footer className="site-footer">
        <nav className="site-lang-switch" aria-label="Language selector">
          {locales.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setLocale(item)}
              className={item === locale ? "lang-link active" : "lang-link"}
              aria-pressed={item === locale}
            >
              {item.toUpperCase()}
            </button>
          ))}
        </nav>
        <p className="site-footer-copy">© VIPRPG Archive Prototype</p>
      </footer>
    </div>
  );
}
