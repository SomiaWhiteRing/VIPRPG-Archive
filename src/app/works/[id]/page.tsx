import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { worksByFestival } from "@/data/works";
import { getFestivalBySlug, getWorkById, getWorksForFestival } from "@/lib/data";
import { getDictionary } from "@/lib/i18n";
import WorkDetail from "@/components/work-detail";
import WorkOutline from "@/components/work-outline";

interface WorkPageProps {
  params: { id: string };
}

export function generateStaticParams() {
  return Object.values(worksByFestival)
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

  return (
    <div className="detail-layout">
      <WorkOutline festival={festival} works={works} activeId={work.id} />
      <WorkDetail work={work} festival={festival} />
    </div>
  );
}
