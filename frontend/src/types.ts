export interface LibraryStats {
  library: {
    total_files: number;
    total_bytes: number;
    photo_count: number;
    video_count: number;
    folder_count: number;
  };
  quarantined: {
    cnt: number;
    bytes: number;
  };
  marked_for_removal: {
    cnt: number;
    bytes: number;
  };
  approaches: Record<
    string,
    {
      approach: string;
      group_count: number;
      member_count: number;
      reclaimable_bytes: number;
    }
  >;
  scan_roots: Array<{
    id: number;
    path: string;
    last_scanned_at: number;
    file_count: number;
    total_bytes: number;
  }>;
}

export interface FolderItem {
  folder: string;
  file_count: number;
  total_bytes: number;
  photos: number;
  videos: number;
}

export interface ExtensionItem {
  ext: string;
  media_type: string;
  file_count: number;
  total_bytes: number;
}

export interface MediaFile {
  id: number;
  path: string;
  folder: string;
  filename: string;
  ext: string;
  media_type: 'photo' | 'video';
  size: number;
  mtime: number;
  width: number | null;
  height: number | null;
  exif_date: string | null;
  camera_model: string | null;
  status: 'active' | 'quarantined' | 'trashed';
  quarantine_path?: string | null;
  similarity?: number;
  decision?: 'undecided' | 'keep' | 'remove';
  ai_score?: number | null;
  ai_reason?: string | null;
}

export interface DuplicateGroup {
  id: number;
  approach: 'exact' | 'visual' | 'burst' | 'semantic';
  signature: string;
  file_count: number;
  total_size: number;
  reclaimable_size: number;
  primary_folder: string;
  primary_ext: string;
  ai_analyzed: number;
  ai_best_file_id: number | null;
  ai_confidence: string | null;
  ai_summary: string | null;
  members: MediaFile[];
}

export interface TaskProgress {
  running: boolean;
  phase: string;
  message: string;
  processed: number;
  total: number;
  current_path: string;
  elapsed_seconds: number;
  rate_per_sec: number;
  error: string | null;
}

export type ApproachTab = 'exact' | 'visual' | 'burst' | 'semantic' | 'files';
export type GroupSortBy = 'reclaimable' | 'folder' | 'ext' | 'size' | 'file_count';
export type FileSortBy = 'size' | 'folder' | 'ext' | 'mtime' | 'filename';
