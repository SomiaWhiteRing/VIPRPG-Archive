import type { Metadata } from "next";
import { notFound } from "next/navigation";
import OriginalFestivalView from "@/components/original-festival-view";
import FestivalSidebar from "@/components/festival-sidebar";
import { getFestivalBySlug, getFestivalsByYear } from "@/lib/data";
import originalViews from "@/data/original-views.json";
import originalSources from "@/data/original-page-sources.json";

const views = originalViews as Record<string, { entry: string; status: string }>;

export function generateStaticParams() {
  return Object.keys(views).map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const festival = getFestivalBySlug(slug);
  return { title: festival ? `${festival.name} | 原貌版` : "VIPRPG祭典保存库" };
}

export default async function OriginalPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const festival = getFestivalBySlug(slug);
  const original = views[slug];
  if (!festival || !original) notFound();
  const groups = Object.entries(getFestivalsByYear())
    .sort(([a], [b]) => Number(b) - Number(a))
    .map(([year, festivals]) => ({ year: Number(year), festivals: festivals.map(({ id, slug, name }) => ({ id, slug, name })) }));
  const sources = (originalSources as Record<string, Record<string, string>>)[slug];
  return (
    <div className="board-layout">
      <FestivalSidebar groups={groups} activeFestival={slug} view="original" />
      <OriginalFestivalView key={slug} slug={slug} name={festival.name} entry={original.entry} sources={sources} />
    </div>
  );
}
