"use client";

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

  return (
    <article className="detail-card">
      <header className="detail-header">
        <h1 className="detail-title">{work.title}</h1>
        <p className="detail-author-line">{work.author}</p>
        {work.ss && work.ss.length > 0 && (
          <div className="detail-ss">{renderScreenshots(work.ss)}</div>
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

      <section className="detail-section">
        <a className="download-button" href={work.download.url} target="_blank" rel="noopener noreferrer">
          {work.download.label ?? "DL"}
        </a>
        {work.forum && (
          <a className="forum-link" href={work.forum} target="_blank" rel="noopener noreferrer">
            Forum
          </a>
        )}
      </section>

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
    </article>
  );
}

function renderScreenshots(images: string[]) {
  if (images.length === 1) {
    return (
      <div className="ss-frame single">
        <Image src={images[0]} alt="Screenshot" width={640} height={360} className="ss-image" unoptimized />
      </div>
    );
  }

  const [first, second] = images;
  return (
    <div className="ss-frame dual">
      <Image src={first} alt="Screenshot" width={640} height={360} className="ss-image" unoptimized />
      <Image src={second} alt="Screenshot" width={640} height={360} className="ss-image secondary" unoptimized />
    </div>
  );
}
