import React, { useEffect, useState } from 'react';
import { Download, RotateCcw, ShieldCheck, X } from 'lucide-react';
import { api, formatBytes } from '../api';
import { useDialogA11y } from '../hooks/useDialogA11y';

interface Props {
  open: boolean;
  onClose: () => void;
  onRestored: () => void;
}

export const QuarantineDrawer: React.FC<Props> = ({ open, onClose, onRestored }) => {
  const [files, setFiles] = useState<Array<{ id: number; path: string; filename: string; ext: string; size: number }>>([]);
  const [batches, setBatches] = useState<Array<{ batch_id: string; action: string; file_count: number; total_bytes: number; created_at: number }>>([]);
  const [loading, setLoading] = useState(false);
  const [restoringKey, setRestoringKey] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const dialogRef = useDialogA11y(open, onClose);

  const load = async () => {
    setLoading(true);
    setErrorMsg('');
    try {
      const data = await api.getQuarantine();
      setFiles(data.quarantined_files);
      setBatches(data.batches);
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : 'Failed to load quarantine items.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) load();
  }, [open]);

  if (!open) return null;

  const restoreBatch = async (batchId: string) => {
    if (restoringKey) return;
    setRestoringKey(`batch-${batchId}`);
    setErrorMsg('');
    try {
      await api.restoreFiles({ batch_id: batchId });
      await load();
      onRestored();
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : 'Failed to restore batch.');
    } finally {
      setRestoringKey(null);
    }
  };

  const restoreOne = async (fileId: number) => {
    if (restoringKey) return;
    setRestoringKey(`file-${fileId}`);
    setErrorMsg('');
    try {
      await api.restoreFiles({ file_ids: [fileId] });
      await load();
      onRestored();
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : 'Failed to restore file.');
    } finally {
      setRestoringKey(null);
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="quarantine-drawer-title"
      tabIndex={-1}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-xs focus:outline-none"
    >
      <div className="flex h-full w-full max-w-xl flex-col border-l border-zinc-800 bg-zinc-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="h-5 w-5 text-emerald-400" />
            <div>
              <h2 id="quarantine-drawer-title" className="text-base font-semibold text-zinc-100">Safe Quarantine & Undo</h2>
              <p className="text-xs text-zinc-400">Files moved here are 100% recoverable to their original folders</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={api.exportCsvUrl('quarantine')}
              download
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
            >
              <Download className="h-3.5 w-3.5" /> CSV
            </a>
            <button
              onClick={onClose}
              aria-label="Close quarantine drawer"
              className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {errorMsg && (
            <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-950/40 px-4 py-3 text-xs text-rose-200">
              {errorMsg}
            </div>
          )}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-3">Action Batches</h3>
            {batches.length === 0 ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4 text-sm text-zinc-500">
                No cleanup batches executed yet.
              </div>
            ) : (
              <div className="space-y-2">
                {batches.map((b) => (
                  <div
                    key={`${b.batch_id}-${b.action}`}
                    className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-3"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-zinc-300">{b.batch_id}</span>
                        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase text-zinc-300">
                          {b.action}
                        </span>
                      </div>
                      <div className="text-xs text-zinc-400 mt-0.5">
                        {b.file_count} files • {formatBytes(b.total_bytes)}
                      </div>
                    </div>
                    {b.action === 'quarantine' && (
                      <button
                        onClick={() => restoreBatch(b.batch_id)}
                        disabled={restoringKey !== null}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600/20 border border-emerald-500/30 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-600/30 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                      >
                        <RotateCcw className="h-3.5 w-3.5" /> {restoringKey === `batch-${b.batch_id}` ? 'Restoring...' : 'Restore Batch'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-3">
              Quarantined Files ({files.length})
            </h3>
            {loading ? (
              <div className="text-sm text-zinc-400">Loading...</div>
            ) : files.length === 0 ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4 text-sm text-zinc-500">
                Quarantine is empty.
              </div>
            ) : (
              <div className="space-y-2">
                {files.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/50 px-3.5 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-zinc-200 truncate">{f.filename}</div>
                      <div className="text-xs text-zinc-500 font-mono truncate">{f.path}</div>
                      <div className="text-xs text-zinc-400 mt-0.5">{formatBytes(f.size)}</div>
                    </div>
                    <button
                      onClick={() => restoreOne(f.id)}
                      disabled={restoringKey !== null}
                      className="shrink-0 inline-flex items-center gap-1 rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-emerald-600 hover:text-white disabled:opacity-50 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> {restoringKey === `file-${f.id}` ? 'Restoring...' : 'Restore'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
