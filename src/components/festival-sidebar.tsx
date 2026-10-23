"use client";

import Link from "next/link";
import { useEffect, useRef, type MouseEvent } from "react";
import FestivalViewLinks from "@/components/festival-view-links";
import { useLanguage } from "@/components/language-context";
import originalViews from "@/data/original-views.json";
import type { Festival } from "@/lib/types";

export interface FestivalSidebarGroup {
  year: number;
  festivals: Pick<Festival, "id" | "slug" | "name">[];
}

export default function FestivalSidebar({ groups, activeFestival, view = "formatted", onNavigate }: {
  groups: FestivalSidebarGroup[];
  activeFestival: string;
  view?: "formatted" | "original";
  onNavigate?: (event: MouseEvent<HTMLAnchorElement>, slug: string) => void;
}) {
  const { dictionary } = useLanguage();
  const outlineRef = useRef<HTMLElement>(null);
  const activeLinkRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    const container = outlineRef.current;
    const link = activeLinkRef.current;
    if (!container || !link) return;
    const header = container.querySelector(".festival-sidebar-header");
    const top = container.getBoundingClientRect().top + (header?.getBoundingClientRect().height ?? 0) + 18;
    const bottom = Math.min(container.getBoundingClientRect().bottom, window.innerHeight - 24) - 18;
    const rect = link.getBoundingClientRect();
    if (rect.top < top) container.scrollTop += rect.top - top;
    else if (rect.bottom > bottom) container.scrollTop += rect.bottom - bottom;
  }, [activeFestival]);

  return (
    <aside ref={outlineRef} className="board-outline" aria-label={dictionary.festivalDirectory}>
      <div className="festival-sidebar-header">
        <h2>{dictionary.festivalDirectory}</h2>
        <FestivalViewLinks slug={activeFestival} active={view} />
      </div>
      {groups.map((group) => (
        <div key={group.year} className="outline-year">
          <p className="outline-year-label">{group.year}</p>
          <ul className="outline-festival-list">
            {group.festivals.map((festival) => {
              const original = view === "original" && Object.hasOwn(originalViews, festival.slug);
              const active = activeFestival === festival.slug;
              return (
                <li key={festival.id}>
                  <Link
                    href={original ? `/original/${festival.slug}` : `/#${festival.slug}`}
                    prefetch={false}
                    className={active ? "outline-link active" : "outline-link"}
                    aria-current={active ? "true" : undefined}
                    ref={active ? activeLinkRef : undefined}
                    onClick={onNavigate ? (event) => onNavigate(event, festival.slug) : undefined}
                  >
                    {festival.name}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </aside>
  );
}
