export type FestivalColumnKey =
  | "no"
  | "icon"
  | "work"
  | "type"
  | "streaming"
  | "download"
  | "forum";

export interface Festival {
  id: string;
  year: number;
  name: string;
  slug: string;
  type: string;
  banners: string[];
  hasDetail?: boolean;
  period?: string;
  worksFile: string;
  columns: FestivalColumnKey[];
}

export interface WorkDownload {
  url: string;
  label?: string;
}

export interface WorkEntry {
  id: string;
  festivalId: string;
  // Original entry number on the festival site (e.g. "00", "01", ...)
  no?: string;
  title: string;
  icon?: string;
  category?: string;
  engine?: string;
  author: string;
  streaming?: string;
  streamingPolicy?: "allow" | "restricted" | "forbid";
  download?: WorkDownload;
  forum?: string;
  authorComment?: string;
  hostComment?: string;
  ss?: string[];
}
