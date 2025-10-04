import festivalsJson from "@/data/festivals.json";
import { worksByFestival, worksById } from "@/data/works";
import type { Festival, WorkEntry } from "@/lib/types";

export const festivals = (festivalsJson as Festival[]).sort(
  (a, b) => b.year - a.year || a.slug.localeCompare(b.slug)
);

export function getFestivalsByYear(): Record<number, Festival[]> {
  return festivals.reduce<Record<number, Festival[]>>((acc, fest) => {
    if (!acc[fest.year]) {
      acc[fest.year] = [];
    }
    acc[fest.year].push(fest);
    return acc;
  }, {});
}

export function getFestivalBySlug(slug: string): Festival | undefined {
  return festivals.find((fest) => fest.slug === slug);
}

export function getWorksForFestival(festivalId: string): WorkEntry[] {
  return worksByFestival[festivalId] ?? [];
}

export function getWorkById(workId: string): WorkEntry | undefined {
  return worksById[workId];
}
