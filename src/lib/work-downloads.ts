import type { WorkDownload, WorkEntry } from "@/lib/types";

export function getWorkDownloads(work: WorkEntry): WorkDownload[] {
  return work.downloads ?? (work.download ? [work.download] : []);
}
