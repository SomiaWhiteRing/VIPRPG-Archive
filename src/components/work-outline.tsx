"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { Festival, WorkEntry } from "@/lib/types";

interface WorkOutlineProps {
  festival?: Festival;
  works: WorkEntry[];
  activeId?: string;
}

export default function WorkOutline({ festival, works, activeId }: WorkOutlineProps) {
  const sortedWorks = useMemo(
    () => [...works].sort((a, b) => a.title.localeCompare(b.title)),
    [works]
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
        {sortedWorks.map((work) => (
          <li key={work.id}>
            <Link
              href={`/works/${work.id}`}
              className={activeId === work.id ? "outline-link active" : "outline-link"}
            >
              {work.title}
            </Link>
          </li>
        ))}
      </ul>
    </aside>
  );
}
