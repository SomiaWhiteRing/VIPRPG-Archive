import FestivalBoard, { type FestivalGroup } from "@/components/festival-board";
import { getFestivalsByYear, getWorksForFestival } from "@/lib/data";
import { hasWorkDetail } from "@/lib/work-detail";
import { getWorkDownloads } from "@/lib/work-downloads";

export default function HomePage() {
  const grouped = getFestivalsByYear();
  const groups: FestivalGroup[] = Object.entries(grouped)
    .sort(([a], [b]) => Number(b) - Number(a))
    .map(([year, festivals]) => ({
      year: Number(year),
      festivals: festivals.map((festival) => ({
        ...festival,
        works: getWorksForFestival(festival.id).map((work) => ({
          id: work.id,
          no: work.no,
          title: work.title,
          originalTitle: work.originalTitle,
          author: work.author,
          icon: work.icon,
          category: work.category,
          group: work.group,
          engine: work.engine,
          streaming: work.streaming,
          forum: work.forum,
          contentRestricted: work.contentRestricted,
          authorOmitted: work.source?.authorOmitted ?? false,
          hasMaterials: Boolean(work.materialInfo),
          hasDetail: hasWorkDetail(work, festival),
          downloads: getWorkDownloads(work).map(({ url, label, filename }) => ({ url, label, filename })),
        })),
      })),
    }));

  return <FestivalBoard groups={groups} />;
}
