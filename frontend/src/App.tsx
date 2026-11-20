import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDownUp,
  Bot,
  CheckCircle2,
  Cpu,
  Download,
  FileImage,
  Folder,
  FolderPlus,
  HardDrive,
  Layers,
  Play,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { api, formatBytes } from './api';
import {
  ApproachTab,
  DuplicateGroup,
  ExtensionItem,
  FileSortBy,
  FolderItem,
  GroupSortBy,
  LibraryStats,
  MediaFile,
  TaskProgress,
} from './types';
import { ScanModal } from './components/ScanModal';
import { SettingsModal } from './components/SettingsModal';
import { QuarantineDrawer } from './components/QuarantineDrawer';
import { CopilotDrawer } from './components/CopilotDrawer';
import { CompareModal } from './components/CompareModal';
import { DuplicateGroupCard } from './components/DuplicateGroupCard';
import { FileExplorerTable } from './components/FileExplorerTable';

export default function App() {
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [extensions, setExtensions] = useState<ExtensionItem[]>([]);
  const [geminiReady, setGeminiReady] = useState(false);

  const [tab, setTab] = useState<ApproachTab>('exact');
  const [selectedFolder, setSelectedFolder] = useState<string>('');
  const [selectedExt, setSelectedExt] = useState<string>('');
  const [search, setSearch] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');
  const [mediaType, setMediaType] = useState<string>('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const toastTimerRef = useRef<number | null>(null);

  // Ordering
  const [groupSortBy, setGroupSortBy] = useState<GroupSortBy>('reclaimable');
  const [groupOrder, setGroupOrder] = useState<'asc' | 'desc'>('desc');
  const [fileSortBy, setFileSortBy] = useState<FileSortBy>('size');
  const [fileOrder, setFileOrder] = useState<'asc' | 'desc'>('desc');

  // Data
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [groupTotal, setGroupTotal] = useState(0);
  const [groupPage, setGroupPage] = useState(1);

  const [files, setFiles] = useState<MediaFile[]>([]);
  const [fileTotal, setFileTotal] = useState(0);
  const [filePage, setFilePage] = useState(1);

  // Background tasks
  const [scanStatus, setScanStatus] = useState<TaskProgress | null>(null);
  const [dedupStatus, setDedupStatus] = useState<TaskProgress | null>(null);
  const [semanticStatus, setSemanticStatus] = useState<TaskProgress | null>(null);

  // Modals & Drawers
  const [scanOpen, setScanOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quarantineOpen, setQuarantineOpen] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [compareFiles, setCompareFiles] = useState<MediaFile[]>([]);
  const [compareGroupId, setCompareGroupId] = useState<number | undefined>(undefined);
  const [toast, setToast] = useState<{ message: string; tone: 'info' | 'success' | 'error' } | null>(null);
  const [batchAiLoading, setBatchAiLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [bannerTask, setBannerTask] = useState<TaskProgress | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [refFolderOpen, setRefFolderOpen] = useState(false);
  const [refFolderInput, setRefFolderInput] = useState('');
  const mainPanelRef = useRef<HTMLDivElement | null>(null);
  const wasRunningRef = useRef({ scan: false, dedup: false, semantic: false });

  const dismissToast = useCallback(() => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToast(null);
  }, []);

  const showToast = useCallback((msg: string, tone: 'info' | 'success' | 'error' = 'info') => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToast({ message: msg, tone });
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 4500);
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedSearch(search), 250);
    return () => window.clearTimeout(id);
  }, [search]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditable = Boolean(
        target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.tagName === 'SELECT' ||
            target.isContentEditable)
      );
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === '/' && !isEditable && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  const refreshSidebar = useCallback(async () => {
    const [st, fl, ex, cfg] = await Promise.all([
      api.getStats(),
      api.getFolders('bytes', 'desc'),
      api.getExtensions(),
      api.getSettings(),
    ]);
    setStats(st);
    setFolders(fl);
    setExtensions(ex);
    setGeminiReady(cfg.gemini_configured);
  }, []);

  const refreshMainList = useCallback(async () => {
    setListLoading(true);
    setListError('');
    try {
      if (tab === 'files') {
        const res = await api.getFiles({
          sort_by: fileSortBy,
          order: fileOrder,
          folder: selectedFolder || undefined,
          ext: selectedExt || undefined,
          media_type: mediaType || undefined,
          search: debouncedSearch || undefined,
          page: filePage,
          page_size: 50,
        });
        setFiles(res.files);
        setFileTotal(res.total);
      } else {
        const res = await api.getGroups({
          approach: tab,
          sort_by: groupSortBy,
          order: groupOrder,
          folder: selectedFolder || undefined,
          ext: selectedExt || undefined,
          search: debouncedSearch || undefined,
          page: groupPage,
          page_size: 50,
        });
        setGroups(res.groups);
        setGroupTotal(res.total);
      }
    } catch (e: unknown) {
      setListError(e instanceof Error ? e.message : 'Failed to load library items');
    } finally {
      setListLoading(false);
    }
  }, [tab, fileSortBy, fileOrder, groupSortBy, groupOrder, selectedFolder, selectedExt, mediaType, debouncedSearch, filePage, groupPage]);

  useEffect(() => {
    refreshSidebar();
  }, [refreshSidebar]);

  useEffect(() => {
    refreshMainList();
  }, [refreshMainList]);

  // Poll background tasks & detect completion transitions
  const pollTasks = useCallback(async () => {
    try {
      const [sc, dd] = await Promise.all([api.getScanStatus(), api.getDedupStatus()]);
      setScanStatus(sc);
      setDedupStatus(dd.local);
      setSemanticStatus(dd.semantic);

      const prev = wasRunningRef.current;
      const scanDone = prev.scan && !sc.running;
      const dedupDone = prev.dedup && !dd.local.running;
      const semDone = prev.semantic && !dd.semantic.running;

      wasRunningRef.current = {
        scan: sc.running,
        dedup: dd.local.running,
        semantic: dd.semantic.running,
      };

      const runningTask = sc.running ? sc : dd.local.running ? dd.local : dd.semantic.running ? dd.semantic : null;
      if (runningTask) {
        setBannerTask(runningTask);
        setBannerDismissed(false);
        refreshSidebar();
      } else if (scanDone || dedupDone || semDone) {
        const finished = scanDone ? sc : dedupDone ? dd.local : dd.semantic;
        setBannerTask(finished);
        setBannerDismissed(false);
        showToast(finished.message);
        await Promise.all([refreshSidebar(), refreshMainList()]);
      }
    } catch {
      // ignore transient poll error
    }
  }, [refreshSidebar, refreshMainList]);

  useEffect(() => {
    const interval = setInterval(pollTasks, 750);
    return () => clearInterval(interval);
  }, [pollTasks]);

  const handleRunDetection = async () => {
    if (tab === 'files') return;
    try {
      await api.runDedup({
        approach: tab,
        max_distance: 5,
        burst_seconds: 3.0,
        folder_filter: selectedFolder || undefined,
        semantic_threshold: 0.92,
        semantic_limit: 200,
      });
      showToast(`Started ${tab} duplicate detection...`);
      pollTasks();
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Failed to start detection', 'error');
    }
  };

  const handleAutoSelect = async (rule: string, referenceFolder?: string) => {
    if (tab === 'files') return;
    if (rule === 'keep_in_folder' && !referenceFolder) {
      setRefFolderInput(selectedFolder || '');
      setRefFolderOpen(true);
      return;
    }
    try {
      const res = await api.autoSelect(rule, tab, undefined, referenceFolder);
      setRefFolderOpen(false);
      showToast(`Applied "${rule.replace(/_/g, ' ')}" to ${res.updated_members} files.`, 'success');
      await Promise.all([refreshSidebar(), refreshMainList()]);
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Auto-select failed', 'error');
    }
  };

  const handleBatchGemini = async () => {
    if (tab === 'files') return;
    setBatchAiLoading(true);
    try {
      const res = await api.batchAnalyzeWithGemini(tab, 5);
      showToast(`Gemini judged ${res.analyzed} groups and marked best keepers.`, 'success');
      await Promise.all([refreshSidebar(), refreshMainList()]);
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Gemini batch analysis failed', 'error');
    } finally {
      setBatchAiLoading(false);
    }
  };

  const handleExecuteCleanup = async (mode: 'quarantine' | 'trash') => {
    const count = stats?.marked_for_removal.cnt || 0;
    if (count === 0) return;
    try {
      const res = await api.executeSafety({
        use_marked_remove: true,
        approach: tab === 'files' ? 'all' : tab,
        mode,
      });
      setConfirmTrash(false);
      showToast(
        `Safely moved ${res.moved_count} files (${formatBytes(res.reclaimed_bytes)}) to ${
          mode === 'quarantine' ? 'Quarantine' : 'Recycle Bin'
        }.`,
        'success'
      );
      await Promise.all([refreshSidebar(), refreshMainList()]);
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Cleanup action failed', 'error');
    }
  };

  const handleCompareDecision = async (fileId: number, target: 'keep' | 'remove') => {
    if (compareGroupId == null) return;
    const current = compareFiles.find((f) => f.id === fileId)?.decision;
    const next = current === target ? 'undecided' : target;
    try {
      await api.setDecision(compareGroupId, fileId, next);
      setCompareFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, decision: next } : f)));
      await Promise.all([refreshSidebar(), refreshMainList()]);
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Failed to update decision', 'error');
    }
  };

  const approachTabs: Array<{ id: ApproachTab; label: string; desc: string }> = [
    { id: 'exact', label: 'Exact Duplicates', desc: 'SHA-256 byte-identical' },
    { id: 'visual', label: 'Visual Similar', desc: 'pHash / dHash perceptual' },
    { id: 'burst', label: 'Burst & Patterns', desc: 'Time & copy-name clusters' },
    { id: 'semantic', label: 'Gemini Semantic', desc: 'gemini-embedding-2 AI' },
    { id: 'files', label: 'All Files Explorer', desc: 'Inspect & sort 285k+ files' },
  ];

  const markedCount = stats?.marked_for_removal.cnt || 0;
  const markedBytes = stats?.marked_for_removal.bytes || 0;

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100 overflow-hidden">
      {/* Top Studio Header */}
      <header className="flex items-center justify-between border-b border-zinc-800/80 bg-zinc-950/90 px-5 py-3 shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-amber-500 shadow-lg shadow-indigo-500/20">
            <Layers className="h-5 w-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold tracking-tight text-zinc-100">LuminaDedup Studio</h1>
              <span className="rounded-full bg-indigo-500/15 border border-indigo-500/30 px-2 py-0.5 text-[10px] font-semibold text-indigo-300">
                285K+ SCALE
              </span>
            </div>
            <p className="text-xs text-zinc-400">Safe Multi-Approach Photo & Video Deduplication + Gemini AI</p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={() => setScanOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-500 transition shadow-sm"
          >
            <FolderPlus className="h-4 w-4" /> Scan Folders
          </button>

          <button
            onClick={() => setQuarantineOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3.5 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-800 transition"
          >
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
            Quarantine ({stats?.quarantined.cnt || 0})
          </button>

          <button
            onClick={() => setCopilotOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-500/20 transition"
          >
            <Bot className="h-4 w-4 text-amber-400" /> Gemini Copilot
          </button>

          <button
            onClick={() => setSettingsOpen(true)}
            aria-label={`Gemini API & Settings (${geminiReady ? 'configured' : 'not configured'})`}
            className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900 p-2 text-zinc-300 hover:bg-zinc-800 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            title="Gemini API & Settings"
          >
            <Settings className="h-4 w-4" aria-hidden="true" />
            <span className={`h-2 w-2 rounded-full ${geminiReady ? 'bg-emerald-400' : 'bg-zinc-600'}`} aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* Live & Completed Progress Banner */}
      {bannerTask && !bannerDismissed && (
        <div
          role="status"
          aria-live="polite"
          className={`border-b px-5 py-2.5 text-xs ${
            bannerTask.running
              ? 'border-indigo-500/30 bg-indigo-950/35'
              : bannerTask.phase === 'error'
              ? 'border-rose-500/30 bg-rose-950/35'
              : 'border-emerald-500/30 bg-emerald-950/30'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              {bannerTask.running ? (
                <Cpu className="h-4 w-4 text-indigo-400 animate-spin shrink-0" />
              ) : bannerTask.phase === 'error' ? (
                <AlertCircle className="h-4 w-4 text-rose-400 shrink-0" />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
              )}
              <span
                className={`font-semibold ${
                  bannerTask.running
                    ? 'text-indigo-200'
                    : bannerTask.phase === 'error'
                    ? 'text-rose-200'
                    : 'text-emerald-200'
                }`}
              >
                {bannerTask.message}
              </span>
              <span className="rounded-md bg-zinc-900/80 border border-zinc-800 px-2 py-0.5 font-mono text-zinc-200">
                {bannerTask.total > 0
                  ? `${bannerTask.processed.toLocaleString()} / ${bannerTask.total.toLocaleString()} (${Math.min(100, Math.round((bannerTask.processed / bannerTask.total) * 100))}%)`
                  : `${bannerTask.processed.toLocaleString()} files`}
              </span>
              {bannerTask.rate_per_sec > 0 && (
                <span className="text-zinc-400">{bannerTask.rate_per_sec} files/s</span>
              )}
              {bannerTask.elapsed_seconds > 0 && (
                <span className="text-zinc-400">{bannerTask.elapsed_seconds.toFixed(1)}s</span>
              )}
            </div>

            <div className="flex items-center gap-3">
              {bannerTask.running && bannerTask.current_path && (
                <span className="font-mono text-zinc-400 truncate max-w-md" title={bannerTask.current_path}>
                  {bannerTask.current_path}
                </span>
              )}
              {!bannerTask.running && (
                <button
                  onClick={() => setBannerDismissed(true)}
                  className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                  aria-label="Dismiss status banner"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800/80">
            <div
              className={`h-full transition-all duration-300 ${
                bannerTask.running
                  ? bannerTask.total > 0
                    ? 'bg-indigo-500'
                    : 'bg-indigo-500/80 animate-pulse w-full'
                  : bannerTask.phase === 'error'
                  ? 'bg-rose-500 w-full'
                  : 'bg-emerald-500 w-full'
              }`}
              style={
                bannerTask.running && bannerTask.total > 0
                  ? { width: `${Math.min(100, Math.round((bannerTask.processed / bannerTask.total) * 100))}%` }
                  : undefined
              }
            />
          </div>
        </div>
      )}

      {/* Body Layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar: Library KPIs, Folders, Extensions */}
        <aside className="w-72 shrink-0 border-r border-zinc-800/80 bg-zinc-950 flex flex-col overflow-y-auto p-4 space-y-6">
          {/* Library Summary Card */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4 space-y-3">
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span className="font-semibold uppercase tracking-wider">Indexed Library</span>
              <HardDrive className="h-4 w-4 text-indigo-400" />
            </div>
            <div className="text-2xl font-bold text-zinc-100">
              {(stats?.library.total_files || 0).toLocaleString()}
              <span className="text-xs font-normal text-zinc-400 ml-1.5">files</span>
            </div>
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span>{formatBytes(stats?.library.total_bytes || 0)}</span>
              <span>{stats?.library.folder_count || 0} folders</span>
            </div>
            <div className="grid grid-cols-2 gap-2 pt-1 text-xs">
              <div className="rounded-lg bg-zinc-950/70 px-2.5 py-1.5">
                <div className="text-zinc-500">Photos</div>
                <div className="font-semibold text-zinc-200">{(stats?.library.photo_count || 0).toLocaleString()}</div>
              </div>
              <div className="rounded-lg bg-zinc-950/70 px-2.5 py-1.5">
                <div className="text-zinc-500">Videos</div>
                <div className="font-semibold text-zinc-200">{(stats?.library.video_count || 0).toLocaleString()}</div>
              </div>
            </div>
          </div>

          {/* Extensions Filter */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">By Extension</span>
              {selectedExt && (
                <button onClick={() => setSelectedExt('')} className="text-[11px] text-indigo-400 hover:underline">
                  Clear
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {extensions.slice(0, 14).map((e) => (
                <button
                  key={`${e.ext}-${e.media_type}`}
                  aria-pressed={selectedExt === e.ext}
                  onClick={() => {
                    setSelectedExt(selectedExt === e.ext ? '' : e.ext);
                    setGroupPage(1);
                    setFilePage(1);
                  }}
                  className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-mono transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                    selectedExt === e.ext
                      ? 'border-indigo-500 bg-indigo-500/20 text-indigo-200'
                      : 'border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-700'
                  }`}
                >
                  <span>{e.ext}</span>
                  <span className="text-zinc-400">{e.file_count.toLocaleString()}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Folders Explorer */}
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Folders (Top Space)</span>
              {selectedFolder && (
                <button onClick={() => setSelectedFolder('')} className="text-[11px] text-indigo-400 hover:underline">
                  All Folders
                </button>
              )}
            </div>
            <div className="space-y-1 overflow-y-auto pr-1">
              {folders.map((f) => {
                const active = selectedFolder === f.folder;
                const shortName = f.folder.split('\\').slice(-2).join('\\') || f.folder;
                return (
                  <button
                    key={f.folder}
                    aria-pressed={active}
                    onClick={() => {
                      setSelectedFolder(active ? '' : f.folder);
                      setGroupPage(1);
                      setFilePage(1);
                    }}
                    title={f.folder}
                    className={`w-full text-left rounded-xl px-2.5 py-2 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                      active ? 'bg-indigo-600/20 border border-indigo-500/40 text-indigo-200' : 'hover:bg-zinc-900 text-zinc-300'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 font-medium truncate">
                      <Folder className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                      <span className="truncate">{shortName}</span>
                    </div>
                    <div className="flex justify-between text-[11px] text-zinc-500 mt-0.5 pl-5">
                      <span>{f.file_count.toLocaleString()} files</span>
                      <span>{formatBytes(f.total_bytes)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        {/* Main Content Workspace */}
        <main className="flex-1 flex flex-col overflow-hidden bg-zinc-950/60">
          {/* Approach Tabs */}
          <div
            role="tablist"
            aria-label="Deduplication approaches"
            className="flex items-center gap-1.5 border-b border-zinc-800/80 px-5 pt-3 overflow-x-auto shrink-0"
          >
            {approachTabs.map((t, idx) => {
              const apStats = stats?.approaches[t.id];
              const isActive = tab === t.id;
              return (
                <button
                  key={t.id}
                  id={`tab-${t.id}`}
                  ref={(el) => {
                    tabRefs.current[t.id] = el;
                  }}
                  role="tab"
                  aria-selected={isActive}
                  aria-controls="main-workspace-panel"
                  tabIndex={isActive ? 0 : -1}
                  onKeyDown={(e) => {
                    let nextIdx: number | null = null;
                    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % approachTabs.length;
                    else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + approachTabs.length) % approachTabs.length;
                    else if (e.key === 'Home') nextIdx = 0;
                    else if (e.key === 'End') nextIdx = approachTabs.length - 1;
                    if (nextIdx !== null) {
                      e.preventDefault();
                      const nextTab = approachTabs[nextIdx];
                      setTab(nextTab.id);
                      setGroupPage(1);
                      setFilePage(1);
                      tabRefs.current[nextTab.id]?.focus();
                    }
                  }}
                  onClick={() => {
                    setTab(t.id);
                    setGroupPage(1);
                    setFilePage(1);
                  }}
                  className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-semibold transition whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded-t-lg ${
                    isActive
                      ? 'border-indigo-500 text-indigo-300'
                      : 'border-transparent text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {t.id === 'semantic' && <Sparkles className="h-3.5 w-3.5 text-amber-400" />}
                  {t.id === 'files' && <FileImage className="h-3.5 w-3.5" />}
                  <span>{t.label}</span>
                  {apStats && (
                    <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-300">
                      {apStats.group_count.toLocaleString()}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Ordering, Filtering & Action Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800/80 bg-zinc-900/40 px-5 py-3 shrink-0">
            <div className="flex flex-wrap items-center gap-2.5">
              {/* Search */}
              <div className="relative">
                <Search className="h-3.5 w-3.5 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
                <input
                  ref={searchInputRef}
                  aria-label="Filter filename or folder"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setGroupPage(1);
                    setFilePage(1);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && search) {
                      e.preventDefault();
                      setSearch('');
                      setDebouncedSearch('');
                      setGroupPage(1);
                      setFilePage(1);
                    }
                  }}
                  placeholder="Filter filename or folder... (/ or Ctrl+K)"
                  className="rounded-xl border border-zinc-800 bg-zinc-950 pl-8 pr-8 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500 focus-visible:border-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 w-64"
                />
                {search && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => {
                      setSearch('');
                      setDebouncedSearch('');
                      setGroupPage(1);
                      setFilePage(1);
                      searchInputRef.current?.focus();
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {/* Order By (Explicit user requirement: order by folder, extension, size) */}
              <div className="flex items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-950 px-2.5 py-1 text-xs">
                <ArrowDownUp className="h-3.5 w-3.5 text-indigo-400" aria-hidden="true" />
                <span className="text-zinc-400">Order:</span>
                {tab === 'files' ? (
                  <select
                    aria-label="Sort files by"
                    value={fileSortBy}
                    onChange={(e) => setFileSortBy(e.target.value as FileSortBy)}
                    className="bg-transparent text-zinc-200 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
                  >
                    <option value="size" className="bg-zinc-900">File Size</option>
                    <option value="folder" className="bg-zinc-900">Folder Path</option>
                    <option value="ext" className="bg-zinc-900">File Extension</option>
                    <option value="filename" className="bg-zinc-900">Filename</option>
                    <option value="mtime" className="bg-zinc-900">Date Modified</option>
                  </select>
                ) : (
                  <select
                    aria-label="Sort duplicate groups by"
                    value={groupSortBy}
                    onChange={(e) => setGroupSortBy(e.target.value as GroupSortBy)}
                    className="bg-transparent text-zinc-200 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
                  >
                    <option value="reclaimable" className="bg-zinc-900">Reclaimable Space</option>
                    <option value="folder" className="bg-zinc-900">Folder Path</option>
                    <option value="ext" className="bg-zinc-900">File Extension</option>
                    <option value="size" className="bg-zinc-900">Total Group Size</option>
                    <option value="file_count" className="bg-zinc-900">Duplicate Count</option>
                  </select>
                )}
                <button
                  onClick={() =>
                    tab === 'files'
                      ? setFileOrder((o) => (o === 'asc' ? 'desc' : 'asc'))
                      : setGroupOrder((o) => (o === 'asc' ? 'desc' : 'asc'))
                  }
                  aria-label={`Sort direction: ${(tab === 'files' ? fileOrder : groupOrder) === 'asc' ? 'ascending' : 'descending'}. Click to toggle.`}
                  className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase text-zinc-300 hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  {tab === 'files' ? fileOrder : groupOrder}
                </button>
              </div>

              {tab === 'files' && (
                <select
                  aria-label="Filter by media type"
                  value={mediaType}
                  onChange={(e) => setMediaType(e.target.value)}
                  className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  <option value="">All Media</option>
                  <option value="photo">Photos Only</option>
                  <option value="video">Videos Only</option>
                </select>
              )}
            </div>

            {/* Right Actions */}
            {tab !== 'files' && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={handleRunDetection}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600/20 border border-indigo-500/40 px-3 py-1.5 text-xs font-semibold text-indigo-200 hover:bg-indigo-600/30 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  <Play className="h-3.5 w-3.5" /> Run {tab} Scan
                </button>

                <select
                  aria-label="Apply auto-select rule"
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) {
                      handleAutoSelect(e.target.value);
                      e.target.value = '';
                    }
                  }}
                  className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  <option value="" disabled>
                    Auto-Select Rule...
                  </option>
                  <option value="keep_largest">Keep Largest File</option>
                  <option value="keep_highest_res">Keep Highest Resolution</option>
                  <option value="keep_oldest">Keep Oldest (Original)</option>
                  <option value="keep_cleanest_path">Keep Cleanest Folder/Name</option>
                  <option value="keep_in_folder">Keep Reference Folder...</option>
                </select>

                <a
                  href={api.exportCsvUrl('groups', tab)}
                  download
                  className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 transition"
                  title="Download CSV audit report of duplicate groups"
                >
                  <Download className="h-3.5 w-3.5 text-zinc-400" /> Export CSV
                </a>

                <button
                  onClick={handleBatchGemini}
                  disabled={batchAiLoading}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500/15 border border-amber-400/30 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/25 disabled:opacity-50 transition"
                >
                  <Wand2 className="h-3.5 w-3.5 text-amber-400" />
                  {batchAiLoading ? 'Gemini Analyzing...' : 'Gemini Batch Judge (Top 5)'}
                </button>
              </div>
            )}
          </div>

          {/* Reference Folder Auto-Select Bar */}
          {refFolderOpen && tab !== 'files' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (refFolderInput.trim()) handleAutoSelect('keep_in_folder', refFolderInput.trim());
              }}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-indigo-500/30 bg-indigo-950/25 px-5 py-2.5 text-xs shrink-0"
            >
              <div className="flex flex-1 items-center gap-2.5 min-w-[260px]">
                <Folder className="h-4 w-4 text-indigo-400 shrink-0" />
                <span className="font-medium text-indigo-200 whitespace-nowrap">Authoritative Reference Folder:</span>
                <input
                  value={refFolderInput}
                  onChange={(e) => setRefFolderInput(e.target.value)}
                  placeholder="e.g. D:\Original (copies outside this folder will be marked Remove)"
                  className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:outline-none"
                />
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={!refFolderInput.trim()}
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  Apply Reference Rule
                </button>
                <button
                  type="button"
                  onClick={() => setRefFolderOpen(false)}
                  className="rounded-lg px-2.5 py-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {/* Safe Execute Action Bar when files are marked REMOVE */}
          {markedCount > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rose-500/30 bg-rose-950/25 px-5 py-2.5 text-xs shrink-0">
              <div className="flex items-center gap-2 text-rose-200">
                <CheckCircle2 className="h-4 w-4 text-rose-400" />
                <span>
                  <strong>{markedCount.toLocaleString()}</strong> duplicate files marked for removal —{' '}
                  <strong className="text-emerald-300">{formatBytes(markedBytes)}</strong> ready to reclaim safely
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleExecuteCleanup('quarantine')}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-1.5 font-semibold text-white hover:bg-emerald-500 transition"
                >
                  <ShieldCheck className="h-3.5 w-3.5" /> Move to Safe Quarantine
                </button>
                {confirmTrash ? (
                  <div className="inline-flex items-center gap-1.5 rounded-xl border border-rose-500/60 bg-rose-950/60 px-2.5 py-1">
                    <span className="text-rose-200">Move {markedCount} to Recycle Bin?</span>
                    <button
                      onClick={() => handleExecuteCleanup('trash')}
                      className="rounded-lg bg-rose-600 px-2.5 py-1 font-semibold text-white hover:bg-rose-500 transition"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setConfirmTrash(false)}
                      className="rounded-lg bg-zinc-800 px-2.5 py-1 font-medium text-zinc-200 hover:bg-zinc-700 transition"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmTrash(true)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-rose-500/40 bg-rose-600/20 px-3.5 py-1.5 font-semibold text-rose-200 hover:bg-rose-600/30 transition"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Send to Recycle Bin
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Active Filter Chips */}
          {(selectedFolder || selectedExt || search || (tab === 'files' && mediaType)) && (
            <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800/80 bg-zinc-950/60 px-5 py-2 text-xs shrink-0">
              <span className="text-zinc-400 font-medium">Active filters:</span>
              {selectedFolder && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedFolder('');
                    setGroupPage(1);
                    setFilePage(1);
                  }}
                  className="inline-flex items-center gap-1 rounded-full border border-indigo-500/40 bg-indigo-500/15 px-2.5 py-0.5 text-indigo-200 hover:bg-indigo-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  <Folder className="h-3 w-3" />
                  <span className="max-w-xs truncate">{selectedFolder.split('\\').slice(-2).join('\\') || selectedFolder}</span>
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              )}
              {selectedExt && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedExt('');
                    setGroupPage(1);
                    setFilePage(1);
                  }}
                  className="inline-flex items-center gap-1 rounded-full border border-indigo-500/40 bg-indigo-500/15 px-2.5 py-0.5 font-mono text-indigo-200 hover:bg-indigo-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  <span>{selectedExt}</span>
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              )}
              {tab === 'files' && mediaType && (
                <button
                  type="button"
                  onClick={() => {
                    setMediaType('');
                    setFilePage(1);
                  }}
                  className="inline-flex items-center gap-1 rounded-full border border-indigo-500/40 bg-indigo-500/15 px-2.5 py-0.5 capitalize text-indigo-200 hover:bg-indigo-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  <span>{mediaType}s</span>
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              )}
              {search && (
                <button
                  type="button"
                  onClick={() => {
                    setSearch('');
                    setDebouncedSearch('');
                    setGroupPage(1);
                    setFilePage(1);
                  }}
                  className="inline-flex items-center gap-1 rounded-full border border-indigo-500/40 bg-indigo-500/15 px-2.5 py-0.5 text-indigo-200 hover:bg-indigo-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  <span>“{search}”</span>
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  setDebouncedSearch('');
                  setSelectedFolder('');
                  setSelectedExt('');
                  setMediaType('');
                  setGroupPage(1);
                  setFilePage(1);
                }}
                className="ml-auto text-[11px] font-medium text-zinc-400 hover:text-zinc-100 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded px-1"
              >
                Clear all
              </button>
            </div>
          )}

          {/* Main Scrollable View */}
          <div
            id="main-workspace-panel"
            ref={mainPanelRef}
            role="tabpanel"
            aria-labelledby={`tab-${tab}`}
            className="flex-1 overflow-y-auto p-5 space-y-4"
          >
            {listError ? (
              <div
                role="alert"
                className="flex items-center justify-between rounded-2xl border border-rose-500/30 bg-rose-950/30 px-5 py-4 text-xs text-rose-200"
              >
                <span>{listError}</span>
                <button
                  onClick={refreshMainList}
                  className="rounded-lg bg-rose-600/30 px-3 py-1.5 font-semibold text-rose-100 hover:bg-rose-600/50 transition"
                >
                  Retry
                </button>
              </div>
            ) : listLoading && groups.length === 0 && files.length === 0 ? (
              <div className="space-y-4" role="status" aria-live="polite" aria-label="Loading library items">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-44 rounded-2xl border border-zinc-800 bg-zinc-900/50 animate-pulse" />
                ))}
              </div>
            ) : tab === 'files' ? (
              <FileExplorerTable
                files={files}
                total={fileTotal}
                page={filePage}
                pageSize={50}
                sortBy={fileSortBy}
                order={fileOrder}
                hasFilters={Boolean(search || selectedFolder || selectedExt || mediaType)}
                onClearFilters={() => {
                  setSearch('');
                  setDebouncedSearch('');
                  setSelectedFolder('');
                  setSelectedExt('');
                  setMediaType('');
                  setFilePage(1);
                }}
                onScanOpen={() => setScanOpen(true)}
                onSortChange={(col) => {
                  if (fileSortBy === col) setFileOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
                  else {
                    setFileSortBy(col);
                    setFileOrder('desc');
                  }
                }}
                onPageChange={setFilePage}
                onPreview={(f) => {
                  setCompareGroupId(undefined);
                  setCompareFiles([f]);
                }}
              />
            ) : groups.length === 0 ? (
              (() => {
                const hasFilters = Boolean(search || selectedFolder || selectedExt);
                const noIndexed = (stats?.library.total_files || 0) === 0;
                return (
                  <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/30 py-20 text-center px-6">
                    <Sparkles className="h-10 w-10 text-indigo-400 mb-3" />
                    <h3 className="text-base font-semibold text-zinc-200">
                      {noIndexed
                        ? 'No media indexed yet'
                        : hasFilters
                        ? 'No duplicate groups match your filters'
                        : `No ${tab} duplicate groups found yet`}
                    </h3>
                    <p className="mt-1.5 max-w-md text-xs text-zinc-400">
                      {noIndexed
                        ? 'Click "Scan Folders" in the top bar to index your photo & video folders into the fast local catalog.'
                        : hasFilters
                        ? 'Try clearing your search query, folder selection, or extension filter to see all groups.'
                        : `Click "Run ${tab} Scan" above to analyze your indexed library using this approach.`}
                    </p>
                    <div className="mt-5 flex gap-3">
                      {noIndexed ? (
                        <button
                          onClick={() => setScanOpen(true)}
                          className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
                        >
                          <FolderPlus className="h-4 w-4" /> Scan Folders
                        </button>
                      ) : hasFilters ? (
                        <button
                          onClick={() => {
                            setSearch('');
                            setSelectedFolder('');
                            setSelectedExt('');
                            setGroupPage(1);
                          }}
                          className="inline-flex items-center gap-2 rounded-xl bg-zinc-800 px-4 py-2 text-xs font-semibold text-zinc-100 hover:bg-zinc-700"
                        >
                          Clear active filters
                        </button>
                      ) : (
                        <button
                          onClick={handleRunDetection}
                          className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
                        >
                          <Play className="h-4 w-4" /> Run {tab} Scan
                        </button>
                      )}
                    </div>
                  </div>
                );
              })()
            ) : (
              <>
                <div className="space-y-4">
                  {groups.map((g) => (
                    <DuplicateGroupCard
                      key={g.id}
                      group={g}
                      onUpdated={() => {
                        refreshSidebar();
                        refreshMainList();
                      }}
                      onCompare={(fl, gId) => {
                        setCompareGroupId(gId);
                        setCompareFiles(fl);
                      }}
                    />
                  ))}
                </div>

                {/* Pagination */}
                <div className="flex items-center justify-between pt-2 text-xs text-zinc-400">
                  <span>
                    Showing {groups.length} of {groupTotal.toLocaleString()} groups (Page {groupPage} of {Math.max(1, Math.ceil(groupTotal / 50))})
                  </span>
                  <div className="flex gap-2">
                    <button
                      disabled={groupPage <= 1}
                      onClick={() => {
                        setGroupPage((p) => p - 1);
                        mainPanelRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                      className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
                    >
                      Previous
                    </button>
                    <button
                      disabled={groupPage * 50 >= groupTotal}
                      onClick={() => {
                        setGroupPage((p) => p + 1);
                        mainPanelRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                      className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
                    >
                      Next
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </main>
      </div>

      {/* Toast Notification */}
      {toast && (
        <div
          role={toast.tone === 'error' ? 'alert' : 'status'}
          aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
          className={`fixed bottom-5 right-5 z-50 flex items-center gap-3 rounded-xl border px-4 py-3 text-xs font-medium shadow-2xl ${
            toast.tone === 'error'
              ? 'border-rose-500/40 bg-rose-950/95 text-rose-100'
              : toast.tone === 'success'
              ? 'border-emerald-500/40 bg-emerald-950/95 text-emerald-100'
              : 'border-indigo-500/40 bg-zinc-900 text-zinc-100'
          }`}
        >
          <span>{toast.message}</span>
          <button
            type="button"
            onClick={dismissToast}
            aria-label="Dismiss notification"
            className="rounded-md p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Modals & Drawers */}
      <ScanModal
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        onStarted={() => {
          showToast('Folder scan started...');
          pollTasks();
          refreshSidebar();
        }}
        existingRoots={stats?.scan_roots || []}
        scanStatus={scanStatus}
      />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => {
          refreshSidebar();
          showToast('Gemini API key saved.');
        }}
      />
      <QuarantineDrawer
        open={quarantineOpen}
        onClose={() => setQuarantineOpen(false)}
        onRestored={() => {
          refreshSidebar();
          refreshMainList();
          showToast('Files restored to original locations.');
        }}
      />
      <CopilotDrawer open={copilotOpen} onClose={() => setCopilotOpen(false)} />
      <CompareModal
        files={compareFiles}
        onClose={() => {
          setCompareFiles([]);
          setCompareGroupId(undefined);
        }}
        onDecision={compareGroupId != null ? handleCompareDecision : undefined}
      />
    </div>
  );
}
