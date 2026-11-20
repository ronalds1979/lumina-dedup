const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'LuminaDedup',
      ...(options?.headers || {}),
    },
    ...options,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = body.detail || detail;
    } catch {
      // ignore
    }
    throw new Error(detail);
  }
  return res.json();
}

export const api = {
  getStats: () => request<import('./types').LibraryStats>('/stats'),
  getSettings: () => request<{ gemini_configured: boolean; gemini_key_masked: string }>('/settings'),
  saveSettings: (gemini_api_key: string) =>
    request<{ gemini_configured: boolean }>('/settings', {
      method: 'POST',
      body: JSON.stringify({ gemini_api_key }),
    }),

  getFolders: (sortBy = 'bytes', order = 'desc') =>
    request<import('./types').FolderItem[]>(`/folders?sort_by=${sortBy}&order=${order}&limit=500`),
  getExtensions: () => request<import('./types').ExtensionItem[]>('/extensions'),

  startScan: (paths: string[], extract_exif = true, reset_before_scan = false) =>
    request<{ started: boolean }>('/scan', {
      method: 'POST',
      body: JSON.stringify({ paths, extract_exif, reset_before_scan }),
    }),
  resetIndex: () =>
    request<{ cleared_files: number }>('/index/reset', { method: 'POST' }),
  getScanStatus: () => request<import('./types').TaskProgress>('/scan/status'),

  runDedup: (payload: {
    approach: string;
    max_distance?: number;
    burst_seconds?: number;
    folder_filter?: string;
    semantic_threshold?: number;
    semantic_limit?: number;
  }) =>
    request<{ started: boolean }>('/dedup/run', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getDedupStatus: () =>
    request<{
      local: import('./types').TaskProgress;
      semantic: import('./types').TaskProgress;
    }>('/dedup/status'),

  getGroups: (params: {
    approach: string;
    sort_by: string;
    order: string;
    folder?: string;
    ext?: string;
    search?: string;
    page: number;
    page_size: number;
  }) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== '') q.set(k, String(v));
    });
    return request<{ total: number; page: number; page_size: number; groups: import('./types').DuplicateGroup[] }>(
      `/groups?${q.toString()}`
    );
  },

  setDecision: (groupId: number, file_id: number, decision: 'keep' | 'remove' | 'undecided') =>
    request<{ ok: boolean }>(`/groups/${groupId}/decision`, {
      method: 'POST',
      body: JSON.stringify({ file_id, decision }),
    }),

  autoSelect: (rule: string, approach?: string, group_id?: number, reference_folder?: string) =>
    request<{ updated_members: number }>('/groups/auto-select', {
      method: 'POST',
      body: JSON.stringify({ rule, approach, group_id, reference_folder }),
    }),

  exportCsvUrl: (scope: 'groups' | 'quarantine', approach = 'all') =>
    `${BASE}/export/csv?scope=${scope}&approach=${encodeURIComponent(approach)}`,

  getFiles: (params: {
    sort_by: string;
    order: string;
    folder?: string;
    ext?: string;
    media_type?: string;
    status?: string;
    search?: string;
    page: number;
    page_size: number;
  }) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== '') q.set(k, String(v));
    });
    return request<{ total: number; page: number; page_size: number; files: import('./types').MediaFile[] }>(
      `/files?${q.toString()}`
    );
  },

  executeSafety: (payload: { file_ids?: number[]; use_marked_remove?: boolean; approach?: string; mode: 'quarantine' | 'trash' }) =>
    request<{ batch_id: string | null; moved_count: number; reclaimed_bytes: number; errors: Array<{ error: string }> }>(
      '/safety/execute',
      { method: 'POST', body: JSON.stringify(payload) }
    ),

  getQuarantine: () =>
    request<{
      quarantined_files: Array<{ id: number; path: string; quarantine_path: string; filename: string; ext: string; size: number; updated_at: number }>;
      batches: Array<{ batch_id: string; action: string; file_count: number; total_bytes: number; created_at: number }>;
    }>('/safety/quarantine'),

  restoreFiles: (payload: { file_ids?: number[]; batch_id?: string }) =>
    request<{ restored: number; restored_bytes: number }>('/safety/restore', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  analyzeGroupWithGemini: (groupId: number, model = 'gemini-3.8-flash', auto_apply = true) =>
    request<{
      group_id: number;
      best_file_id: number;
      confidence: string;
      summary: string;
    }>(`/ai/analyze-group/${groupId}`, {
      method: 'POST',
      body: JSON.stringify({ model, auto_apply }),
    }),

  batchAnalyzeWithGemini: (approach: string, limit = 5) =>
    request<{ analyzed: number; errors: Array<{ group_id: number; error: string }> }>(
      `/ai/batch-analyze?approach=${approach}&limit=${limit}`,
      { method: 'POST' }
    ),

  copilotChat: (message: string, previous_interaction_id?: string, model = 'gemini-4-argon') =>
    request<{ interaction_id: string; reply: string; model: string }>('/ai/copilot', {
      method: 'POST',
      body: JSON.stringify({ message, previous_interaction_id, model }),
    }),
};

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val >= 10 || idx === 0 ? val.toFixed(1) : val.toFixed(2)} ${units[idx]}`;
}
