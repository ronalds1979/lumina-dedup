import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Cpu, FolderPlus, Play, RotateCcw, X } from 'lucide-react';
import { api } from '../api';
import { TaskProgress } from '../types';
import { useDialogA11y } from '../hooks/useDialogA11y';

interface Props {
  open: boolean;
  onClose: () => void;
  onStarted: () => void;
  existingRoots: Array<{ path: string; file_count: number }>;
  scanStatus: TaskProgress | null;
}

export const ScanModal: React.FC<Props> = ({ open, onClose, onStarted, existingRoots, scanStatus }) => {
  const [pathsText, setPathsText] = useState(
    existingRoots.length > 0 ? existingRoots.map((r) => r.path).join('\n') : 'C:\\Users\\Public\\Pictures'
  );
  const [extractExif, setExtractExif] = useState(true);
  const [pendingMode, setPendingMode] = useState<'add' | 'reset' | null>(null);
  const [trackingScan, setTrackingScan] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useDialogA11y(open, onClose);
  const pathsRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (open) {
      setError('');
      setTrackingScan(Boolean(scanStatus?.running));
    } else {
      setTrackingScan(false);
    }
  }, [open]);

  if (!open) return null;

  const isRunning = Boolean(scanStatus?.running) || (trackingScan && (!scanStatus || scanStatus.phase === 'idle'));
  const isCompleted = trackingScan && !isRunning && scanStatus?.phase === 'completed';
  const isError = trackingScan && !isRunning && scanStatus?.phase === 'error';
  const showProgressView = trackingScan || isRunning;

  const handleStart = async (resetBeforeScan = false) => {
    if (pendingMode !== null) return;
    const paths = pathsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (paths.length === 0) {
      setError('Enter at least one folder path.');
      pathsRef.current?.focus();
      return;
    }
    setPendingMode(resetBeforeScan ? 'reset' : 'add');
    setError('');
    try {
      await api.startScan(paths, extractExif, resetBeforeScan);
      setTrackingScan(true);
      onStarted();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to start scan');
    } finally {
      setPendingMode(null);
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="scan-modal-title"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 focus:outline-none"
    >
      <div className="w-full max-w-xl rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <FolderPlus className="h-5 w-5 text-indigo-400" />
            <h2 id="scan-modal-title" className="text-lg font-semibold text-zinc-100">
              {showProgressView ? 'Scanning Media Folders' : 'Scan Media Folders'}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close scan folders dialog"
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {showProgressView ? (
          <div className="p-6 space-y-5" role="status" aria-live="polite">
            <div className="flex items-center gap-3">
              {isRunning ? (
                <Cpu className="h-6 w-6 text-indigo-400 animate-spin shrink-0" />
              ) : isError ? (
                <AlertCircle className="h-6 w-6 text-rose-400 shrink-0" />
              ) : (
                <CheckCircle2 className="h-6 w-6 text-emerald-400 shrink-0" />
              )}
              <div>
                <div className="text-sm font-semibold text-zinc-100">
                  {scanStatus?.message || 'Starting scan...'}
                </div>
                <div className="text-xs text-zinc-400 mt-0.5">
                  {isRunning
                    ? 'Indexing folders, file sizes, extensions, and EXIF metadata...'
                    : isCompleted
                    ? 'All selected folders have been indexed and are ready for duplicate detection.'
                    : scanStatus?.error || 'Scan stopped.'}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
                <div className="text-[11px] uppercase tracking-wider text-zinc-500">Files Scanned</div>
                <div className="mt-1 text-xl font-bold font-mono text-zinc-100">
                  {(scanStatus?.processed || 0).toLocaleString()}
                </div>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
                <div className="text-[11px] uppercase tracking-wider text-zinc-500">Speed</div>
                <div className="mt-1 text-xl font-bold font-mono text-indigo-300">
                  {scanStatus?.rate_per_sec ? `${scanStatus.rate_per_sec}/s` : '—'}
                </div>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
                <div className="text-[11px] uppercase tracking-wider text-zinc-500">Elapsed</div>
                <div className="mt-1 text-xl font-bold font-mono text-zinc-200">
                  {(scanStatus?.elapsed_seconds || 0).toFixed(1)}s
                </div>
              </div>
            </div>

            <div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                <div
                  className={`h-full transition-all duration-300 ${
                    isRunning
                      ? 'w-full bg-indigo-500/80 animate-pulse'
                      : isError
                      ? 'w-full bg-rose-500'
                      : 'w-full bg-emerald-500'
                  }`}
                />
              </div>
              {scanStatus?.current_path && (
                <div className="mt-2 truncate font-mono text-xs text-zinc-400" title={scanStatus.current_path}>
                  Current folder: {scanStatus.current_path}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="p-6 space-y-4">
            <div>
              <label htmlFor="scan-folder-paths" className="block text-sm font-medium text-zinc-300 mb-1.5">
                Folder Paths (one per line)
              </label>
              <textarea
                id="scan-folder-paths"
                ref={pathsRef}
                rows={4}
                value={pathsText}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'scan-paths-error' : undefined}
                onChange={(e) => {
                  setPathsText(e.target.value);
                  if (error) setError('');
                }}
                placeholder="D:\Photos&#10;E:\Backups\Camera Roll"
                className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3.5 py-2.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-600 focus-visible:border-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
              />
              <p className="mt-1.5 text-xs text-zinc-400">
                Built for 285,000+ photos & videos. Indexes folders, extensions, sizes, and metadata into a fast local SQLite catalog without modifying any files.
              </p>
            </div>

            <label className="flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-3.5 cursor-pointer">
              <input
                type="checkbox"
                checked={extractExif}
                onChange={(e) => setExtractExif(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-zinc-600 accent-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              />
              <div>
                <div className="text-sm font-medium text-zinc-200">Extract image dimensions & EXIF date/camera</div>
                <div className="text-xs text-zinc-400">
                  Recommended for comparing resolution & original capture dates. Slightly slower on 285k files; uncheck for ultra-fast size/path indexing first.
                </div>
              </div>
            </label>

            {error && (
              <div id="scan-paths-error" role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
                {error}
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-3 border-t border-zinc-800 bg-zinc-950/50 px-6 py-4">
          {showProgressView ? (
            isRunning ? (
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                Hide & Continue in Background
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setTrackingScan(false)}
                  className="rounded-xl px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  Scan Another Folder
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-xl bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                >
                  Done & View Library
                </button>
              </>
            )
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={pendingMode !== null}
                className="rounded-xl px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleStart(true)}
                disabled={pendingMode !== null}
                aria-busy={pendingMode === 'reset'}
                title="Clears previous indexed folders & duplicate groups, then indexes only the folders above (quarantined files are preserved)"
                className="inline-flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/15 px-4 py-2 text-sm font-semibold text-amber-200 hover:bg-amber-500/25 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
              >
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                {pendingMode === 'reset' ? 'Resetting...' : 'Reset Index & Scan'}
              </button>
              <button
                type="button"
                onClick={() => handleStart(false)}
                disabled={pendingMode !== null}
                aria-busy={pendingMode === 'add'}
                className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
              >
                <Play className="h-4 w-4" aria-hidden="true" />
                {pendingMode === 'add' ? 'Starting...' : 'Add / Scan'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
