import type { Festival, WorkEntry } from "@/lib/types";

export function hasWorkDetail(work: WorkEntry, festival?: Festival): boolean {
  if (work.contentRestricted) return true;
  if (festival?.hasDetail === false || work.detailDisabled === true) return false;
  return Boolean(
    work.authorComment?.trim() ||
    work.hostComment?.trim() ||
    work.ss?.length ||
    work.forum?.trim() ||
    work.download?.url ||
    work.downloads?.length ||
    work.streaming?.trim()
  );
}
