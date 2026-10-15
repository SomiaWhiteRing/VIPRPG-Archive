import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { worksByFestival } from "@/data/works";
import { getFestivalBySlug, getWorkById, getWorksForFestival } from "@/lib/data";
import { getDictionary } from "@/lib/i18n";
import WorkDetailView from "@/components/work-detail-view";
import { hasWorkDetail } from "@/lib/work-detail";

interface WorkPageProps {
  params: Promise<{ id: string }>;
}

export function generateStaticParams() {
  return Object.entries(worksByFestival)
    .flatMap(([festivalId, works]) =>
      works.filter((work) => hasWorkDetail(work, getFestivalBySlug(festivalId)))
    )
    .map((work) => ({ id: work.id }));
}

export async function generateMetadata({ params }: WorkPageProps): Promise<Metadata> {
  const { id } = await params;
  const work = getWorkById(id);
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

export default async function WorkPage({ params }: WorkPageProps) {
  const { id } = await params;
  const work = getWorkById(id);

  if (!work) {
    notFound();
  }

  const festival = getFestivalBySlug(work.festivalId);
  const works = festival ? getWorksForFestival(festival.id) : [];
  if (!hasWorkDetail(work, festival)) {
    notFound();
  }

  return <WorkDetailView festival={festival} works={works} activeId={work.id} />;
}
