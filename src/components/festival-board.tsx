"use client";

import {
  JSX,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import Link from "next/link";
import Image from "next/image";
import type { Festival, FestivalColumnKey, WorkEntry } from "@/lib/types";
import { useLanguage } from "@/components/language-context";

export interface FestivalWithWorks extends Festival {
  works: WorkEntry[];
}

export interface FestivalGroup {
  year: number;
  festivals: FestivalWithWorks[];
}

interface FestivalBoardProps {
  groups: FestivalGroup[];
}

const columnClassMap: Record<FestivalColumnKey, string> = {
  icon: "col-icon",
  work: "col-work",
  type: "col-type",
  streaming: "col-streaming",
  download: "col-download",
  forum: "col-forum",
};

function normalize(text?: string): string {
  return text?.toLocaleLowerCase() ?? "";
}

function highlight(text: string, term: string): ReactNode {
  if (!term) return text;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escaped, "gi");
  const pieces: Array<string | JSX.Element> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const fragment = match[0];
    const start = match.index;
    if (start > lastIndex) {
      pieces.push(text.slice(lastIndex, start));
    }
    pieces.push(
      <span key={`${start}-${fragment}`} className="highlight">
        {fragment}
      </span>
    );
    lastIndex = start + fragment.length;
  }

  if (lastIndex < text.length) {
    pieces.push(text.slice(lastIndex));
  }

  return pieces.length ? pieces : text;
}

function matchWork(work: WorkEntry, term: string) {
  if (!term) return true;
  const haystack = [work.title, work.author, work.category, work.engine]
    .filter(Boolean)
    .map((value) => normalize(String(value)));
  return haystack.some((value) => value.includes(term));
}

export default function FestivalBoard({ groups }: FestivalBoardProps) {
  const { dictionary } = useLanguage();
  const [searchTerm, setSearchTerm] = useState("");
  const outlineRef = useRef<HTMLDivElement | null>(null);
  const outlineLinksRef = useRef<Record<string, HTMLAnchorElement | null>>({});
  const panelRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [panelHeights, setPanelHeights] = useState<Record<string, number>>({});

  const updatePanelHeights = useCallback(() => {
    setPanelHeights((prev) => {
      let changed = false;
      let next = prev;

      for (const [id, element] of Object.entries(panelRefs.current)) {
        if (!element) {
          continue;
        }
        const inner = element.firstElementChild as HTMLElement | null;
        const measured = inner?.scrollHeight ?? element.scrollHeight;
        const rounded = Math.ceil(measured);
        if (!rounded || prev[id] === rounded) {
          continue;
        }
        if (!changed) {
          next = { ...prev };
          changed = true;
        }
        next[id] = rounded;
      }

      return changed ? next : prev;
    });
  }, []);


  const festivalsFlat = useMemo(
    () =>
      groups.flatMap((group) =>
        group.festivals.map((festival) => ({
          slug: festival.slug,
          id: festival.id,
          title: festival.name,
          year: group.year,
        }))
      ),
    [groups]
  );

  const [activeFestival, setActiveFestival] = useState<string>(() => festivalsFlat[0]?.slug ?? "");

  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const latest = groups.at(0)?.festivals ?? [];
    return latest.reduce<Record<string, boolean>>((acc, fest) => {
      acc[fest.id] = true;
      return acc;
    }, {});
  });

  const defaultExpanded = useMemo(() => {
    const latest = groups.at(0)?.festivals ?? [];
    return latest.reduce<Record<string, boolean>>((acc, fest) => {
      acc[fest.id] = true;
      return acc;
    }, {});
  }, [groups]);

  const views = useMemo(() => {
    const term = normalize(searchTerm);
    return groups.map((group) => ({
      year: group.year,
      festivals: group.festivals.map((festival) => {
        const filteredWorks = festival.works.filter((work) => matchWork(work, term));
        return {
          festival,
          filteredWorks,
        };
      }),
    }));
  }, [groups, searchTerm]);

  useEffect(() => {
    if (!searchTerm) {
      setExpanded(defaultExpanded);
      return;
    }
    const next: Record<string, boolean> = {};
    for (const group of views) {
      for (const { festival, filteredWorks } of group.festivals) {
        next[festival.id] = filteredWorks.length > 0;
      }
    }
    setExpanded(next);
  }, [defaultExpanded, searchTerm, views]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveFestival(entry.target.id);
          }
        }
      },
      {
        rootMargin: "-45% 0px -45% 0px",
        threshold: 0,
      }
    );

    const elements = festivalsFlat
      .map((item) => document.getElementById(item.slug))
      .filter((el): el is HTMLElement => Boolean(el));

    elements.forEach((el) => observer.observe(el));

    return () => {
      elements.forEach((el) => observer.unobserve(el));
      observer.disconnect();
    };
  }, [festivalsFlat]);

  useEffect(() => {
    const container = outlineRef.current;
    const activeLink = outlineLinksRef.current[activeFestival];

    if (!container || !activeLink) {
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const linkRect = activeLink.getBoundingClientRect();

    if (linkRect.top < containerRect.top || linkRect.bottom > containerRect.bottom) {
      activeLink.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeFestival]);

  useLayoutEffect(() => {
    updatePanelHeights();
  }, [updatePanelHeights, views]);

  useEffect(() => {
    const handleResize = () => updatePanelHeights();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [updatePanelHeights]);

  const noResults = views.every((group) =>
    group.festivals.every(({ filteredWorks }) => filteredWorks.length === 0)
  );

  return (
    <div className="board-layout">
      <aside ref={outlineRef} className="board-outline" aria-label="Festivals outline">
        {groups.map((group) => (
          <div key={group.year} className="outline-year">
            <p className="outline-year-label">{group.year}</p>
            <ul className="outline-festival-list">
              {group.festivals.map((festival) => (
                <li key={festival.id}>
                  <a
                    href={`#${festival.slug}`}
                    className={
                      activeFestival === festival.slug
                        ? "outline-link active"
                        : "outline-link"
                    }
                    ref={(element) => {
                      if (!element) {
                        delete outlineLinksRef.current[festival.slug];
                        return;
                      }
                      outlineLinksRef.current[festival.slug] = element;
                    }}
                    onClick={() => setActiveFestival(festival.slug)}
                  >
                    {festival.name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </aside>

      <div className="board-content">
        
        <div className="board-search-spacer">
          <div className="board-search">
            <label className="label" htmlFor="festival-search">
              {dictionary.searchLabel}
            </label>
            <input
              id="festival-search"
              className="input"
              placeholder={dictionary.searchPlaceholder}
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
            {noResults && <p className="note">{dictionary.searchEmpty}</p>}
          </div>
        </div>

        <div className="board-views">
          {views.map((group) => (
            <section key={group.year} className="board-year">
              <header className="year-header">
                <h2>{group.year}</h2>
                {/* <span>
                  {group.festivals.length} {dictionary.festivalsCount}
                </span> */}
              </header>
              {group.festivals.map(({ festival, filteredWorks }) => {
                const isExpanded = expanded[festival.id] ?? false;
                const displayWorks = searchTerm ? filteredWorks : festival.works;
                const measuredHeight = panelHeights[festival.id] ?? 0;
                const panelMaxHeightValue = measuredHeight > 0 ? `${measuredHeight}px` : isExpanded ? "1px" : "0px";

                return (
                  <article key={festival.id} id={festival.slug} className="festival-card">
                    <header className="festival-header">
                      <div className="festival-title">
                        <h3>{festival.name}</h3>
                        {festival.period && <span className="period">{festival.period}</span>}
                      </div>
                      <div className="festival-banners">
                        {festival.banners.map((src) => (
                          <Image
                            key={src}
                            src={src}
                            alt={`${festival.name} banner`}
                            width={160}
                            height={40}
                            className="banner-image"
                            unoptimized
                          />
                        ))}
                      </div>
                      <button
                        type="button"
                        className="toggle"
                        onClick={() =>
                          setExpanded((prev) => ({
                            ...prev,
                            [festival.id]: !isExpanded,
                          }))
                        }
                        aria-expanded={isExpanded}
                        aria-controls={`${festival.id}-panel`}
                      >
                        {isExpanded ? dictionary.collapse : dictionary.expand}
                      </button>
                    </header>

                    <div
                      id={`${festival.id}-panel`}
                      ref={(element) => {
                        if (!element) {
                          delete panelRefs.current[festival.id];
                          return;
                        }
                        panelRefs.current[festival.id] = element;
                      }}
                      className={isExpanded ? "festival-body expanded" : "festival-body collapsed"}
                      aria-hidden={!isExpanded}
                      style={{ "--festival-panel-max": panelMaxHeightValue } as CSSProperties}
                    >
                      <div className="festival-body-inner">
                        <div className="festival-scroll">
                          <table className="festival-table">
                            <colgroup>
                              {festival.columns.map((column) => (
                                <col key={column} className={columnClassMap[column]} />
                              ))}
                            </colgroup>
                            <thead>
                              <tr>
                                {festival.columns.map((column) => {
                                  const header = renderHeader(column, dictionary);
                                  return (
                                    <th key={column} className={header.className}>
                                      {header.label}
                                    </th>
                                  );
                                })}
                              </tr>
                            </thead>
                            <tbody>
                              {displayWorks.map((work) => (
                                <tr key={work.id}>
                                  {festival.columns.map((column) => {
                                    const cell = renderCell({
                                      column,
                                      work,
                                      term: normalize(searchTerm),
                                      dictionary,
                                    });
                                    return (
                                      <td key={`${work.id}-${column}`} className={cell.className}>
                                        {cell.node}
                                      </td>
                                    );
                                  })}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {displayWorks.length === 0 && <p className="note">{dictionary.searchEmpty}</p>}
                      </div>
                    </div>
                  </article>
                );
              })}
            </section>
          ))}
        </div>

      </div>
    </div>
  );
}

function renderHeader(
  column: FestivalColumnKey,
  dictionary: Record<string, string>
): { label: string; className: string } {
  const className = columnClassMap[column] ?? "";
  switch (column) {
    case "icon":
      return { label: dictionary.icon, className };
    case "work":
      return { label: dictionary.tableWork, className };
    case "type":
      return { label: dictionary.tableType, className };
    case "streaming":
      return { label: dictionary.tableStreaming, className };
    case "download":
      return { label: dictionary.tableDownload, className };
    case "forum":
      return { label: dictionary.tableForum, className };
  }
}

function renderCell({
  column,
  work,
  term,
  dictionary,
}: {
  column: FestivalColumnKey;
  work: WorkEntry;
  term: string;
  dictionary: Record<string, string>;
}): { node: ReactNode; className: string } {
  const baseClass = columnClassMap[column] ?? "";
  switch (column) {
    case "icon":
      return {
        node: work.icon ? (
          <div className="icon-cell">
            <Image
              src={work.icon}
              alt={work.title}
              width={48}
              height={48}
              unoptimized
              style={{ width: "100%", height: "100%", objectFit: "contain" }}
            />
          </div>
        ) : (
          <span className="muted">-</span>
        ),
        className: `${baseClass} cell-icon`,
      };
    case "work":
      return {
        node: (
          <div className="cell-stack">
            <Link href={`/works/${work.id}`} className="link-strong">
              {highlight(work.title, term)}
            </Link>
            <span className="muted small">{highlight(work.author, term)}</span>
          </div>
        ),
        className: `${baseClass} cell-work`,
      };
    case "type":
      return {
        node: (
          <div className="cell-stack">
            <span>{work.category ? highlight(work.category, term) : "-"}</span>
            {work.engine && <span className="muted small">{highlight(work.engine, term)}</span>}
          </div>
        ),
        className: `${baseClass} cell-type`,
      };
    case "streaming":
      return {
        node: (
          <div className="cell-stack">
            <span>{work.streaming ?? "-"}</span>
          </div>
        ),
        className: `${baseClass} cell-streaming`,
      };
    case "download":
      return {
        node: (
          <a className="button" href={work.download.url} target="_blank" rel="noopener noreferrer">
            {work.download.label ?? dictionary.downloadButton}
          </a>
        ),
        className: `${baseClass} cell-center`,
      };
    case "forum":
      return {
        node: work.forum ? (
          <a className="link" href={work.forum} target="_blank" rel="noopener noreferrer">
            {dictionary.forumLink}
          </a>
        ) : (
          <span className="muted">-</span>
        ),
        className: `${baseClass} cell-center`,
      };
    default:
      return { node: <span>-</span>, className: baseClass };
  }
}
