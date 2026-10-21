"use client";

import Link from "next/link";
import views from "@/data/original-views.json";
import { useLanguage } from "@/components/language-context";

export default function FestivalViewLinks({ slug, active = "formatted" }: { slug: string; active?: "formatted" | "original" }) {
  const { dictionary } = useLanguage();
  const available = Object.hasOwn(views, slug);
  return (
    <nav className="festival-view-links" aria-label={dictionary.festivalViews}>
      {active === "formatted" ? <span aria-current="page">{dictionary.formattedView}</span> : <Link href={`/#${slug}`} prefetch={false}>{dictionary.formattedView}</Link>}
      {available ? active === "original" ? <span aria-current="page">{dictionary.originalView}</span> : <Link href={`/original/${slug}`} prefetch={false}>{dictionary.originalView}</Link> : <span className="muted" aria-disabled="true">{dictionary.originalViewPending}</span>}
    </nav>
  );
}
