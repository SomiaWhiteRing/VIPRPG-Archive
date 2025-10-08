import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { worksByFestival } from "@/data/works";
import festivalsJson from "@/data/festivals.json";
import { getFestivalBySlug, getWorkById, getWorksForFestival } from "@/lib/data";
import { getDictionary } from "@/lib/i18n";
import WorkDetailView from "@/components/work-detail-view";

interface WorkPageProps {
  params: { id: string };
}

export function generateStaticParams() {
  const festivals = festivalsJson as Array<{ id: string; hasDetail?: boolean }>;
  const disabled = new Set(
    festivals.filter((f) => f.hasDetail === false).map((f) => f.id)
  );
  return Object.entries(worksByFestival)
    .filter(([festivalId]) => !disabled.has(festivalId))
    .map(([, works]) => works)
    .flat()
    .map((work) => ({ id: work.id }));
}

export function generateMetadata({ params }: WorkPageProps): Metadata {
  const work = getWorkById(params.id);
  if (!work) {
    return { title: "作品未找到" };
  }
  const dict = getDictionary("ja");
  const title = `${work.title} | ${dict.siteTitle}`;
  const description = work.authorComment ?? work.hostComment ?? dict.siteSubtitle;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "article",
    },
  };
}

export default function WorkPage({ params }: WorkPageProps) {
  const work = getWorkById(params.id);

  if (!work) {
    notFound();
  }

  const festival = getFestivalBySlug(work.festivalId);
  const works = festival ? getWorksForFestival(festival.id) : [];
  if (festival && festival.hasDetail === false) {
    notFound();
  }

  return <WorkDetailView festival={festival} works={works} activeId={work.id} />;
}
