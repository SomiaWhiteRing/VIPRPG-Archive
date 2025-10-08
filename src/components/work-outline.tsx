"use client";

import Link from "next/link";
import { useCallback, type MouseEvent } from "react";
import type { Festival, WorkEntry } from "@/lib/types";

interface WorkOutlineProps {
  festival?: Festival;
  works: WorkEntry[];
  activeId?: string;
  onSelect?: (workId: string) => void;
}

export default function WorkOutline({ festival, works, activeId, onSelect }: WorkOutlineProps) {
  const handleLinkClick = useCallback(
    (workId: string) => (event: MouseEvent<HTMLAnchorElement>) => {
      if (!onSelect) {
        return;
      }

      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }

      event.preventDefault();
      onSelect(workId);
    },
    [onSelect]
  );

  if (!festival) {
    return null;
  }

  return (
    <aside className="detail-outline" aria-label="Festival works outline">
      <div className="detail-outline-header">
        <h2>{festival.name}</h2>
      </div>
      <ul className="detail-outline-list">
        {works.map((work) => (
          <li key={work.id}>
            {festival.hasDetail === false ? (
              <span className={activeId === work.id ? "outline-text active" : "outline-text"}>{work.title}</span>
            ) : (
              <Link
                href={`/works/${work.id}`}
                className={activeId === work.id ? "outline-link active" : "outline-link"}
                aria-current={activeId === work.id ? "true" : undefined}
                onClick={handleLinkClick(work.id)}
              >
                {work.title}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
