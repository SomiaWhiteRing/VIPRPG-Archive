"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import Link from "next/link";
import type { Festival, WorkEntry } from "@/lib/types";
import { useLanguage } from "@/components/language-context";

export default function WorkDetail({
  work,
  festival,
}: {
  work: WorkEntry;
  festival?: Festival;
}) {
  const { dictionary } = useLanguage();
  const downloadUrl = work.download?.url;
  const downloadLabel = work.download?.label ?? "DL";
  const forumUrl = work.forum;
  const screenshots = useMemo(() => work.ss ?? [], [work.ss]);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);

  const handleOpenViewer = useCallback(
    (index: number) => {
      if (screenshots.length === 0) {
        return;
      }
      if (!Number.isFinite(index)) {
        return;
      }
      setViewerIndex((previous) => {
        if (index < 0) {
          return 0;
        }
        if (index >= screenshots.length) {
          return screenshots.length > 0 ? screenshots.length - 1 : previous;
        }
        return index;
      });
      setViewerOpen(true);
    },
    [screenshots.length]
  );

  const handleCloseViewer = useCallback(() => setViewerOpen(false), []);

  const handleNextViewer = useCallback(() => {
    setViewerIndex((current) => {
      if (screenshots.length === 0) {
        return current;
      }
      return (current + 1) % screenshots.length;
    });
  }, [screenshots.length]);

  const handlePrevViewer = useCallback(() => {
    setViewerIndex((current) => {
      if (screenshots.length === 0) {
        return current;
      }
      return (current - 1 + screenshots.length) % screenshots.length;
    });
  }, [screenshots.length]);

  useEffect(() => {
    if (!viewerOpen) {
      return;
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleCloseViewer();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        handleNextViewer();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        handlePrevViewer();
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleCloseViewer, handleNextViewer, handlePrevViewer, viewerOpen]);

  useEffect(() => {
    setViewerOpen(false);
    setViewerIndex(0);
  }, [work.id]);

  useEffect(() => {
    if (viewerIndex >= screenshots.length && screenshots.length > 0) {
      setViewerIndex(screenshots.length - 1);
    }
  }, [screenshots.length, viewerIndex]);

  return (
    <article className="detail-card">
      <header className="detail-header">
        <h1 className="detail-title">{work.title}</h1>
        <p className="detail-author-line">{work.author}</p>
        {screenshots.length > 0 && (
          <div className="detail-ss">{renderScreenshots(screenshots, dictionary, handleOpenViewer)}</div>
        )}
      </header>

      <section className="detail-section">
        <table className="info-table">
          <tbody>
            <tr>
              <th>{dictionary.detailsEngine}</th>
              <td>{work.engine ?? "-"}</td>
            </tr>
            <tr>
              <th>{dictionary.tableType}</th>
              <td>{work.category ?? "-"}</td>
            </tr>
            <tr>
              <th>{dictionary.detailsStreaming}</th>
              <td>
                {work.streaming ?? "-"}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {work.authorComment && (
        <section className="detail-section">
          <h2 className="section-heading">{dictionary.detailsAuthorComment}</h2>
          <p className="section-text">{work.authorComment}</p>
        </section>
      )}

      {work.hostComment && (
        <section className="detail-section">
          <h2 className="section-heading">{dictionary.detailsHostComment}</h2>
          <p className="section-text">{work.hostComment}</p>
        </section>
      )}

      {(downloadUrl || forumUrl) && (
        <section className="detail-section">
          {downloadUrl && (
            <a className="download-button" href={downloadUrl} target="_blank" rel="noopener noreferrer">
              {downloadLabel}
            </a>
          )}
          {forumUrl && (
            <a className="forum-link" href={forumUrl} target="_blank" rel="noopener noreferrer">
              Forum
            </a>
          )}
        </section>
      )}

      <div className="detail-nav">
        <Link href="/" className="nav-link">
          ← {dictionary.detailsBackToList}
        </Link>
        {festival && (
          <a href={`/#${festival.slug}`} className="nav-link">
            {dictionary.detailsJumpToFestival}
          </a>
        )}
      </div>

      {viewerOpen && screenshots.length > 0 && (
        <ScreenshotViewer
          images={screenshots}
          index={Math.min(viewerIndex, screenshots.length - 1)}
          altPrefix={dictionary.screenshotAlt}
          onClose={handleCloseViewer}
          onNext={handleNextViewer}
          onPrev={handlePrevViewer}
        />
      )}
    </article>
  );
}

function renderScreenshots(
  images: string[],
  dictionary: Record<string, string>,
  onSelect: (index: number) => void
) {
  if (images.length === 0) {
    return null;
  }

  if (images.length === 1) {
    return (
      <div className="ss-frame single">
        <button type="button" className="ss-trigger" onClick={() => onSelect(0)}>
          <Image
            src={images[0]}
            alt={`${dictionary.screenshotAlt} 1`}
            width={640}
            height={360}
            className="ss-image"
            unoptimized
          />
        </button>
      </div>
    );
  }

  if (images.length === 2) {
    const [first, second] = images;
    return (
      <div className="ss-frame dual">
        <button type="button" className="ss-trigger" onClick={() => onSelect(0)}>
          <Image
            src={first}
            alt={`${dictionary.screenshotAlt} 1`}
            width={640}
            height={360}
            className="ss-image"
            unoptimized
          />
        </button>
        <button type="button" className="ss-trigger" onClick={() => onSelect(1)}>
          <Image
            src={second}
            alt={`${dictionary.screenshotAlt} 2`}
            width={640}
            height={360}
            className="ss-image secondary"
            unoptimized
          />
        </button>
      </div>
    );
  }

  return (
    <div className="ss-frame multi">
      {images.map((src, index) => (
        <button
          key={`${src}-${index}`}
          type="button"
          className="ss-trigger"
          onClick={() => onSelect(index)}
        >
          <Image
            src={src}
            alt={`${dictionary.screenshotAlt} ${index + 1}`}
            width={640}
            height={360}
            className="ss-image"
            unoptimized
          />
        </button>
      ))}
    </div>
  );
}

function ScreenshotViewer({
  images,
  index,
  altPrefix,
  onClose,
  onNext,
  onPrev,
}: {
  images: string[];
  index: number;
  altPrefix: string;
  onClose: () => void;
  onNext: () => void;
  onPrev: () => void;
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) {
      return;
    }
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [mounted]);

  if (!mounted || images.length === 0 || typeof document === "undefined") {
    return null;
  }

  const total = images.length;
  const currentIndex = Math.min(Math.max(index, 0), total - 1);
  const currentSrc = images[currentIndex];

  return createPortal(
    <div
      className="viewer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Screenshot viewer"
      onClick={onClose}
    >
      <div className="viewer-surface" onClick={(event) => event.stopPropagation()}>
        <div className="viewer-frame">
          <Image
            src={currentSrc}
            alt={`${altPrefix} ${currentIndex + 1}`}
            fill
            sizes="(max-width: 768px) 92vw, 75vw"
            className="viewer-image"
            unoptimized
            style={{ objectFit: "contain" }}
            priority
          />
          {total > 1 && (
            <button
              type="button"
              className="viewer-arrow viewer-arrow-prev"
              onClick={onPrev}
              aria-label="Previous screenshot"
            >
              ‹
            </button>
          )}
          {total > 1 && (
            <button
              type="button"
              className="viewer-arrow viewer-arrow-next"
              onClick={onNext}
              aria-label="Next screenshot"
            >
              ›
            </button>
          )}
          <button type="button" className="viewer-close" onClick={onClose} aria-label="Close viewer">
            ×
          </button>
        </div>
        {total > 1 && (
          <p className="viewer-meta">
            {currentIndex + 1} / {total}
          </p>
        )}
      </div>
    </div>,
    document.body
  );
}
