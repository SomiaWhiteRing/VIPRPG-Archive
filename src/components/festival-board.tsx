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
  no: "col-index",
  icon: "col-icon",
  work: "col-work",
  type: "col-type",
  streaming: "col-streaming",
  download: "col-download",
  forum: "col-forum",
};

const CONTENT_TOP_OFFSET = 166;
const CONTENT_BOTTOM_OFFSET = 24;
const OUTLINE_TOP_OFFSET = 44;
const OUTLINE_BOTTOM_OFFSET = 18;

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

function hasWorkDetail(work: WorkEntry) {
  if (work.detailDisabled === true) return false;
  if (work.authorComment && work.authorComment.trim().length) return true;
  if (work.hostComment && work.hostComment.trim().length) return true;
  if (Array.isArray(work.ss) && work.ss.length > 0) return true;
  if (work.forum && work.forum.trim().length) return true;
  if (work.download && work.download.url) return true;
  if (work.streaming && work.streaming.trim().length) return true;
  return false;
}

export default function FestivalBoard({ groups }: FestivalBoardProps) {
  const { dictionary } = useLanguage();
  const [searchTerm, setSearchTerm] = useState("");
  const outlineRef = useRef<HTMLDivElement | null>(null);
  const outlineLinksRef = useRef<Record<string, HTMLAnchorElement | null>>({});
  const panelRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const visibleFestivalsRef = useRef(new Set<string>());
  const activeFestivalRef = useRef<string>("");
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

  const festivalIdBySlug = useMemo(() => {
    const map = new Map<string, string>();
    for (const { slug, id } of festivalsFlat) {
      map.set(slug, id);
    }
    return map;
  }, [festivalsFlat]);

  const defaultExpanded = useMemo(
    () =>
      festivalsFlat.reduce<Record<string, boolean>>((acc, festival) => {
        acc[festival.id] = false;
        return acc;
      }, {}),
    [festivalsFlat]
  );

  const [activeFestival, setActiveFestival] = useState<string>(() => festivalsFlat[0]?.slug ?? "");

  useEffect(() => {
    activeFestivalRef.current = activeFestival;
  }, [activeFestival]);

  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => ({ ...defaultExpanded }));

  const expandFestivalBySlug = useCallback(
    (slug: string) => {
      const targetId = festivalIdBySlug.get(slug);
      if (!targetId) {
        return;
      }
      setExpanded((prev) => {
        if (prev[targetId]) {
          return prev;
        }
        return { ...prev, [targetId]: true };
      });
    },
    [festivalIdBySlug]
  );

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
      setExpanded({ ...defaultExpanded });
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

    activeFestivalRef.current = activeFestivalRef.current || (festivalsFlat[0]?.slug ?? "");
    const visibleSet = visibleFestivalsRef.current;
    visibleSet.clear();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.id;
          if (entry.isIntersecting) {
            visibleSet.add(id);
          } else {
            visibleSet.delete(id);
          }
        }

        const firstVisible = festivalsFlat.find((item) =>
          visibleSet.has(item.slug)
        );

        let nextActive = firstVisible?.slug;

        if (!nextActive) {
          let fallback = activeFestivalRef.current;
          const offsetTop = CONTENT_TOP_OFFSET + window.scrollY;

          for (const item of festivalsFlat) {
            const element = document.getElementById(item.slug);
            if (!element) {
              continue;
            }
            const top = element.getBoundingClientRect().top + window.scrollY;
            if (top <= offsetTop) {
              fallback = item.slug;
            } else if (fallback) {
              break;
            }
          }

          nextActive = fallback;
        }

        if (nextActive && nextActive !== activeFestivalRef.current) {
          activeFestivalRef.current = nextActive;
          setActiveFestival(nextActive);
        }
      },
      {
        rootMargin: `-${CONTENT_TOP_OFFSET}px 0px -${CONTENT_BOTTOM_OFFSET}px 0px`,
        threshold: [0, 0.25, 0.5, 0.75, 1],
      }
    );

    const elements = festivalsFlat
      .map((item) => document.getElementById(item.slug))
      .filter((el): el is HTMLElement => Boolean(el));

    elements.forEach((el) => observer.observe(el));

    return () => {
      visibleSet.clear();
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

    const linkTop = linkRect.top - containerRect.top + container.scrollTop;
    const linkBottom = linkRect.bottom - containerRect.top + container.scrollTop;
    const visibleTop = container.scrollTop + OUTLINE_TOP_OFFSET;
    const visibleBottom = container.scrollTop + container.clientHeight - OUTLINE_BOTTOM_OFFSET;

    if (linkTop < visibleTop) {
      const target = Math.max(linkTop - OUTLINE_TOP_OFFSET, 0);
      container.scrollTo({ top: target, behavior: "smooth" });
    } else if (linkBottom > visibleBottom) {
      const target = Math.max(linkBottom - container.clientHeight + OUTLINE_BOTTOM_OFFSET, 0);
      container.scrollTo({ top: target, behavior: "smooth" });
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

  const handleOutlineClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>, slug: string) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.altKey ||
        event.ctrlKey ||
        event.shiftKey
      ) {
        return;
      }

      event.preventDefault();
      expandFestivalBySlug(slug);

      if (typeof window === "undefined") {
        setActiveFestival(slug);
        return;
      }

      const element = document.getElementById(slug);
      if (!element) {
        setActiveFestival(slug);
        return;
      }

      const rect = element.getBoundingClientRect();
      const absoluteTop = window.scrollY + rect.top;
      const target = Math.max(absoluteTop - CONTENT_TOP_OFFSET, 0);

      window.scrollTo({ top: target, behavior: "smooth" });
      window.history.replaceState(null, "", `#${slug}`);
      setActiveFestival(slug);
    },
    [expandFestivalBySlug]
  );

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
                    onClick={(event) => handleOutlineClick(event, festival.slug)}
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
                                      festival,
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
    case "no":
      return { label: dictionary.tableIndex, className };
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
  festival,
  term,
  dictionary,
}: {
  column: FestivalColumnKey;
  work: WorkEntry;
  festival: Festival;
  term: string;
  dictionary: Record<string, string>;
}): { node: ReactNode; className: string } {
  const baseClass = columnClassMap[column] ?? "";
  switch (column) {
    case "no":
      return {
        node: <span className="mono small">{work.no ?? "-"}</span>,
        className: `${baseClass} cell-index`,
      };
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
            {festival.hasDetail === false || !hasWorkDetail(work) ? (
              <span className="text-strong">{highlight(work.title, term)}</span>
            ) : (
              <Link href={`/works/${work.id}`} className="link-strong">
                {highlight(work.title, term)}
              </Link>
            )}
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
    case "download": {
      const downloadUrl = work.download?.url;
      if (downloadUrl) {
        return {
          node: (
            <a className="button" href={downloadUrl} target="_blank" rel="noopener noreferrer">
              {work.download?.label ?? dictionary.downloadButton}
            </a>
          ),
          className: `${baseClass} cell-center`,
        };
      }
      return {
        node: <span className="muted">-</span>,
        className: `${baseClass} cell-center`,
      };
    }
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
