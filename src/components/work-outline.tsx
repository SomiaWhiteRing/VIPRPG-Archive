"use client";

import Link from "next/link";
import type { Festival, WorkOutlineEntry } from "@/lib/types";

interface WorkOutlineProps {
  festival?: Festival;
  works: WorkOutlineEntry[];
  activeId?: string;
}

export default function WorkOutline({ festival, works, activeId }: WorkOutlineProps) {
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
            {!work.hasDetail ? (
              <span className={activeId === work.id ? "outline-text active" : "outline-text"}>{work.title}</span>
            ) : (
              <Link
                href={`/works/${work.id}`}
                prefetch={false}
                className={activeId === work.id ? "outline-link active" : "outline-link"}
                aria-current={activeId === work.id ? "true" : undefined}
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
