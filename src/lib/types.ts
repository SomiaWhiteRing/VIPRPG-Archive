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
  materialTerms?: string;
  worksFile: string;
  columns: FestivalColumnKey[];
}

export interface WorkDownload {
  url: string;
  label?: string;
  detail?: string;
  filename?: string;
  previewUrl?: string;
}

export interface WorkEntry {
  id: string;
  festivalId: string;
  // Original entry number on the festival site (e.g. "00", "01", ...)
  no?: string;
  title: string;
  originalTitle?: string;
  icon?: string;
  category?: string;
  engine?: string;
  author: string;
  streaming?: string;
  streamingPolicy?: "allow" | "restricted" | "forbid";
  download?: WorkDownload;
  downloads?: WorkDownload[];
  materialInfo?: {
    archivePermission?: string;
    externalUsePermission?: string;
    notes?: string;
  };
  forum?: string;
  authorComment?: string;
  hostComment?: string;
  sourceContent?: string;
  updates?: string;
  contentRestricted?: boolean;
  source?: {
    url: string;
    snapshotUrl?: string;
    titleUrl?: string;
    authorOmitted?: boolean;
  };
  sourceDetailUnavailable?: boolean;
  // If true, force-disable detail page/link even if other fields are present
  detailDisabled?: boolean;
  ss?: string[];
}
