"use client";

import FestivalViewLinks from "@/components/festival-view-links";
import { useLanguage } from "@/components/language-context";

export default function OriginalFestivalView({ slug, name, entry }: { slug: string; name: string; entry: string }) {
  const { dictionary } = useLanguage();
  return (
    <section className="original-festival-view">
      <header className="original-view-header">
        <h1>{name}</h1>
        <FestivalViewLinks slug={slug} active="original" />
      </header>
      <p className="note">{dictionary.originalViewNotice}</p>
      <iframe className="original-festival-frame" src={entry} title={`${name} — ${dictionary.originalView}`} sandbox="allow-scripts" referrerPolicy="no-referrer" />
    </section>
  );
}
