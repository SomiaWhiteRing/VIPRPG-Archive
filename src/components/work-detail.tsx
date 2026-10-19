"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import Link from "next/link";
import type { Festival, WorkEntry } from "@/lib/types";
import { useLanguage } from "@/components/language-context";
import { getWorkDownloads } from "@/lib/work-downloads";

export default function WorkDetail({
  work,
  festival,
}: {
  work: WorkEntry;
  festival?: Festival;
}) {
  const { dictionary } = useLanguage();
  const restricted = work.contentRestricted === true;
  const downloads = restricted ? [] : getWorkDownloads(work);
  const forumUrl = restricted ? undefined : work.forum;
  const screenshots = useMemo(() => restricted ? [] : work.ss ?? [], [restricted, work.ss]);
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
        {restricted && <p className="note">{work.no ? `No.${work.no} · ` : ""}{dictionary.restrictedContent}</p>}
        <h1 className="detail-title">{work.title}</h1>
        {(work.author.trim() || work.source?.authorOmitted) && (
          <p className="detail-author-line">{work.source?.authorOmitted ? dictionary.authorOmitted : work.author}</p>
        )}
        {!restricted && work.sourceDetailUnavailable && <p className="note">{dictionary.sourceDetailUnavailable}</p>}
        {work.originalTitle && <p className="note">{dictionary.detailsOriginalTitle}: {work.originalTitle}<br />{dictionary.detailsTitleVersionNotice}</p>}
        {restricted && (
          <div className="restricted-media">
            <strong>{dictionary.restrictedContent}</strong>
            <p>{dictionary.restrictedContentText}</p>
          </div>
        )}
        {screenshots.length > 0 && (
          <div id="detail-screenshots" className="detail-ss">{renderScreenshots(screenshots, dictionary, handleOpenViewer)}</div>
        )}
      </header>

      <section className="detail-section">
        <table className="info-table">
          <tbody>
            <tr>
              <th>{work.materialInfo ? dictionary.materialCompatibility : dictionary.detailsEngine}</th>
              <td>{work.engine ?? "-"}</td>
            </tr>
            <tr>
              <th>{dictionary.tableType}</th>
              <td>{work.category ?? "-"}</td>
            </tr>
            {work.group && <tr>
              <th>{dictionary.tableGroup}</th>
              <td>{work.group}</td>
            </tr>}
            {!work.materialInfo && <tr>
              <th>{dictionary.detailsStreaming}</th>
              <td>
                {restricted ? dictionary.restrictedContent : work.streaming ?? "-"}
              </td>
            </tr>}
          </tbody>
        </table>
      </section>

      {work.materialInfo && <section className="detail-section">
        <table className="info-table"><tbody>
          <tr><th>{dictionary.materialArchivePermission}</th><td>{work.materialInfo.archivePermission || "-"}</td></tr>
          <tr><th>{dictionary.materialExternalPermission}</th><td>{work.materialInfo.externalUsePermission || "-"}</td></tr>
        </tbody></table>
        {work.materialInfo.notes && <p className="section-text">{work.materialInfo.notes}</p>}
        {festival?.materialTerms && <details className="material-terms"><summary>{dictionary.materialGeneralTerms}</summary><p className="section-text">{festival.materialTerms}</p></details>}
      </section>}

      {(restricted || work.authorComment) && (
        <section className="detail-section">
          <h2 className="section-heading">{dictionary.detailsAuthorComment}</h2>
          {restricted ? <p className="section-text">{dictionary.restrictedContentText}</p> : <div
            className="section-text"
            dangerouslySetInnerHTML={{ __html: renderHostCommentHTML(work.authorComment ?? "") }}
          />}
        </section>
      )}

      {(restricted || work.hostComment) && (
        <section className="detail-section">
          <h2 className="section-heading">{dictionary.detailsHostComment}</h2>
          {restricted ? <p className="section-text">{dictionary.restrictedContentText}</p> : <div
            className="section-text"
            dangerouslySetInnerHTML={{ __html: renderHostCommentHTML(work.hostComment ?? "") }}
          />}
        </section>
      )}

      {!restricted && work.sourceContent && (
        <section className="detail-section">
          <h2 className="section-heading">{dictionary.detailsSourceContent}</h2>
          <div className="section-text" dangerouslySetInnerHTML={{ __html: renderHostCommentHTML(work.sourceContent) }} />
        </section>
      )}

      {(restricted || work.updates) && (
        <section className="detail-section">
          <h2 className="section-heading">{dictionary.detailsUpdates}</h2>
          <p className="section-text">{restricted ? dictionary.restrictedContentText : work.updates}</p>
        </section>
      )}

      {(restricted || downloads.length > 0 || forumUrl) && (
        <section className="detail-section">
          {restricted && <p className="note">{dictionary.restrictedContentText}</p>}
          {downloads.some((file) => file.previewUrl) && <p className="note">{dictionary.audioPreviewNotice}</p>}
          {downloads.length > 0 && (!work.materialInfo && downloads.length === 1 ? <a className="download-button" href={downloads[0].url} target="_blank" rel="noopener noreferrer">{downloads[0].label ?? "DL"}</a> : <div className="detail-files">{downloads.map((file) => <div className="detail-file" key={file.url}>
            <a className="download-button" href={file.url} target="_blank" rel="noopener noreferrer" download={file.url.startsWith("/") ? file.filename || true : undefined}>{file.label ?? "DL"}</a>
            {file.detail && <p className="note">{file.detail}</p>}
            {/\.(mp3|wav|ogg)$/i.test(file.previewUrl ?? file.url) && <audio controls preload="metadata" src={file.previewUrl ?? file.url} aria-label={file.label ?? dictionary.filesLabel} />}
            {/\.mid$/i.test(file.url) && <p className="note">{dictionary.midiDownloadNotice}</p>}
          </div>)}</div>)}
          {forumUrl && (
            <a className="forum-link" href={forumUrl} target="_blank" rel="noopener noreferrer">
              Forum
            </a>
          )}
        </section>
      )}

      <div className="detail-nav">
        {!restricted && work.source && (
          <>
            <a className="nav-link" href={work.source.url} target="_blank" rel="noopener noreferrer">
              {dictionary.sourcePage}
            </a>
            {work.source.snapshotUrl && (
              <a className="nav-link" href={work.source.snapshotUrl} target="_blank" rel="noopener noreferrer">
                {dictionary.archivedPage}
              </a>
            )}
          </>
        )}
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

function renderHostCommentHTML(source: string) {
  const raw = source ?? "";
  // If it already contains HTML tags, trust the markup; otherwise, convert newlines to <br> for readability.
  const looksLikeHtml = /<\/?[a-z][\s\S]*>/i.test(raw);
  return looksLikeHtml ? raw : raw.replace(/\n/g, "<br>");
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
