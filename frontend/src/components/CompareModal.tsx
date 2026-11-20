import React, { useEffect, useState } from 'react';
import { X, Check, Trash2, Sparkles } from 'lucide-react';
import { MediaFile } from '../types';
import { formatBytes } from '../api';
import { useDialogA11y } from '../hooks/useDialogA11y';

interface Props {
  files: MediaFile[];
  onClose: () => void;
  onDecision?: (fileId: number, decision: 'keep' | 'remove') => void;
}

export const CompareModal: React.FC<Props> = ({ files, onClose, onDecision }) => {
  const isOpen = files.length > 0;
  const dialogRef = useDialogA11y(isOpen, onClose);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    setActiveIndex(0);
  }, [files.length]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (files.length > 1) {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          setActiveIndex((prev) => (prev + 1) % files.length);
          return;
        }
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          setActiveIndex((prev) => (prev - 1 + files.length) % files.length);
          return;
        }
        const digit = Number(e.key);
        if (digit >= 1 && digit <= files.length) {
          e.preventDefault();
          setActiveIndex(digit - 1);
          return;
        }
      }
      if (!onDecision) return;
      const target = files[activeIndex] || files[0];
      if (!target) return;
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        onDecision(target.id, 'keep');
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        onDecision(target.id, 'remove');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, files, activeIndex, onDecision]);

  if (!isOpen) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="compare-modal-title"
      tabIndex={-1}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex flex-col bg-black/90 backdrop-blur-md focus:outline-none"
    >
      <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-3.5">
        <div className="flex items-center gap-3">
          <h2 id="compare-modal-title" className="text-sm font-semibold text-zinc-200">
            Side-by-Side Full Inspection ({files.length} {files.length === 1 ? 'item' : 'items'})
          </h2>
          {onDecision && (
            <span className="hidden sm:inline text-[11px] text-zinc-400">
              Shortcuts:{' '}
              {files.length > 1 && (
                <>
                  <kbd className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-zinc-200">←/→</kbd> or{' '}
                  <kbd className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-zinc-200">1-{files.length}</kbd> Select ·{' '}
                </>
              )}
              <kbd className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-zinc-200">K</kbd> Keep ·{' '}
              <kbd className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-zinc-200">R</kbd> Remove ·{' '}
              <kbd className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-zinc-200">Esc</kbd> Close
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          aria-label="Close inspection dialog"
          className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div
        className="flex-1 overflow-auto p-6"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          className={`grid gap-6 h-full ${
            files.length === 1 ? 'grid-cols-1 max-w-4xl mx-auto' : files.length === 2 ? 'grid-cols-2' : 'grid-cols-3'
          }`}
        >
          {files.map((f, idx) => {
            const isSelected = files.length > 1 && idx === activeIndex;
            return (
            <div
              key={f.id}
              onClick={() => setActiveIndex(idx)}
              className={`flex flex-col rounded-2xl border bg-zinc-900 overflow-hidden transition ${
                isSelected ? 'border-indigo-500 ring-2 ring-indigo-500/40' : 'border-zinc-800'
              }`}
            >
              <div className="relative flex-1 min-h-[300px] bg-zinc-950 flex items-center justify-center p-2">
                {f.media_type === 'video' ? (
                  <video src={`/api/media/${f.id}/raw`} controls className="max-h-[60vh] max-w-full rounded-lg" />
                ) : (
                  <img
                    src={`/api/media/${f.id}/raw`}
                    alt={f.filename}
                    className="max-h-[60vh] max-w-full object-contain rounded-lg"
                  />
                )}
                {f.ai_score != null && (
                  <div className="absolute top-3 right-3 inline-flex items-center gap-1 rounded-full bg-amber-500/20 border border-amber-400/40 px-2.5 py-1 text-xs font-semibold text-amber-300">
                    <Sparkles className="h-3.5 w-3.5" /> Gemini: {f.ai_score}/100
                  </div>
                )}
              </div>

              <div className="p-4 space-y-2 border-t border-zinc-800 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-sm text-zinc-100 truncate">{f.filename}</span>
                  <span className="rounded bg-zinc-800 px-2 py-0.5 font-mono text-zinc-300 uppercase">
                    {f.ext.replace('.', '')}
                  </span>
                </div>
                <div className="text-zinc-400 font-mono truncate" title={f.folder}>
                  {f.folder}
                </div>
                <div className="flex flex-wrap gap-3 text-zinc-300 pt-1">
                  <span>Size: <strong>{formatBytes(f.size)}</strong></span>
                  {f.width && f.height && (
                    <span>Res: <strong>{f.width}×{f.height}</strong></span>
                  )}
                  {f.exif_date && <span>EXIF: <strong>{f.exif_date}</strong></span>}
                </div>
                {f.ai_reason && (
                  <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-2 text-amber-200/90">
                    {f.ai_reason}
                  </div>
                )}

                {onDecision && (
                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={() => onDecision(f.id, 'keep')}
                      aria-pressed={f.decision === 'keep'}
                      className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl py-2 font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
                        f.decision === 'keep'
                          ? 'bg-emerald-600 text-white'
                          : 'bg-zinc-800 text-zinc-300 hover:bg-emerald-600/20 hover:text-emerald-300'
                      }`}
                    >
                      <Check className="h-4 w-4" /> Keep
                    </button>
                    <button
                      onClick={() => onDecision(f.id, 'remove')}
                      aria-pressed={f.decision === 'remove'}
                      className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl py-2 font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 ${
                        f.decision === 'remove'
                          ? 'bg-rose-600 text-white'
                          : 'bg-zinc-800 text-zinc-300 hover:bg-rose-600/20 hover:text-rose-300'
                      }`}
                    >
                      <Trash2 className="h-4 w-4" /> Remove
                    </button>
                  </div>
                )}
              </div>
            </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
