import type { Metadata } from "next";
import { notFound } from "next/navigation";
import OriginalFestivalView from "@/components/original-festival-view";
import { getFestivalBySlug } from "@/lib/data";
import originalViews from "@/data/original-views.json";

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
  return <OriginalFestivalView slug={slug} name={festival.name} entry={original.entry} />;
}
