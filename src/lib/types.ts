export type FestivalColumnKey =
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
