import WorkOutline from "@/components/work-outline";
import WorkDetail from "@/components/work-detail";
import type { Festival, WorkEntry } from "@/lib/types";
import { hasWorkDetail } from "@/lib/work-detail";

interface WorkDetailViewProps {
  festival?: Festival;
  works: WorkEntry[];
  activeId: string;
}

export default function WorkDetailView({ festival, works, activeId }: WorkDetailViewProps) {
  const work = works.find((entry) => entry.id === activeId);
  if (!work) return null;

  return (
    <div className="detail-layout">
      <WorkOutline festival={festival} works={works.map((entry) => ({ id: entry.id, title: entry.title, hasDetail: hasWorkDetail(entry, festival) }))} activeId={activeId} />
      <WorkDetail work={work} festival={festival} />
    </div>
  );
}
