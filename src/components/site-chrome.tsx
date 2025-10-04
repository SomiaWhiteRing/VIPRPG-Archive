"use client";

import { useLanguage } from "@/components/language-context";

export default function SiteChrome({ children }: { children: React.ReactNode }) {
  const { dictionary, locales, locale, setLocale } = useLanguage();

  return (
    <div className="site-shell" data-locale={locale}>
      <header className="site-header">
        <div className="site-headline">
          <h1 className="site-title">{dictionary.siteTitle}</h1>
          <p className="site-subtitle">{dictionary.siteSubtitle}</p>
        </div>
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
      </header>
      <main className="site-main">{children}</main>
      <footer className="site-footer">© VIPRPG Archive Prototype</footer>
    </div>
  );
}
