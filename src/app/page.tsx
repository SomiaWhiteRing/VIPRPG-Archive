import FestivalBoard, { type FestivalGroup } from "@/components/festival-board";
import { getFestivalsByYear, getWorksForFestival } from "@/lib/data";

export const revalidate = 60;

export default function HomePage() {
  const grouped = getFestivalsByYear();
  const groups: FestivalGroup[] = Object.entries(grouped)
    .sort(([a], [b]) => Number(b) - Number(a))
    .map(([year, festivals]) => ({
      year: Number(year),
      festivals: festivals.map((festival) => ({
        ...festival,
        works: getWorksForFestival(festival.id),
      })),
    }));

  return <FestivalBoard groups={groups} />;
}
