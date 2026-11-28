import React, { useState } from 'react';
import { Check, Expand, Folder, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { DuplicateGroup, MediaFile } from '../types';
import { api, formatBytes } from '../api';

interface Props {
  group: DuplicateGroup;
  onUpdated: () => void;
  onCompare: (files: MediaFile[], groupId: number) => void;
}

// ⚡ Bolt: Memoize DuplicateGroupCard so background task polling and toolbar state updates skip re-rendering 50 groups (200+ media cards)
export const DuplicateGroupCard: React.FC<Props> = React.memo(({ group, onUpdated, onCompare }) => {
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const handleDecision = async (fileId: number, current: string | undefined, target: 'keep' | 'remove') => {
    const key = `file-${fileId}`;
    if (pendingAction) return;
    setPendingAction(key);
    setAiError('');
    try {
      const next = current === target ? 'undecided' : target;
      await api.setDecision(group.id, fileId, next);
      onUpdated();
    } catch (e: unknown) {
      setAiError(e instanceof Error ? e.message : 'Failed to update decision');
    } finally {
      setPendingAction(null);
    }
  };

  const handleAskGemini = async () => {
    setAiLoading(true);
    setAiError('');
    try {
      await api.analyzeGroupWithGemini(group.id, 'gemini-3.8-flash', true);
      onUpdated();
    } catch (e: unknown) {
      setAiError(e instanceof Error ? e.message : 'Gemini analysis failed');
    } finally {
      setAiLoading(false);
    }
  };

  const handleQuickRule = async (rule: string) => {
    if (pendingAction) return;
    setPendingAction(`rule-${rule}`);
    setAiError('');
    try {
      await api.autoSelect(rule, undefined, group.id);
      onUpdated();
    } catch (e: unknown) {
      setAiError(e instanceof Error ? e.message : 'Failed to apply quick rule');
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div className="rounded-2xl border border-zinc-800/90 bg-zinc-900/70 overflow-hidden shadow-lg">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800/80 bg-zinc-950/50 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2.5 min-w-0">
          <span className="rounded-lg bg-indigo-500/15 border border-indigo-500/30 px-2.5 py-0.5 text-xs font-semibold uppercase text-indigo-300">
            {group.approach}
          </span>
          <span className="text-sm font-semibold text-zinc-100">
            {group.file_count} files • <span className="text-emerald-400">Save {formatBytes(group.reclaimable_size)}</span>
          </span>
          <span className="inline-flex items-center gap-1 rounded-md bg-zinc-800/80 px-2 py-0.5 text-xs font-mono text-zinc-300 uppercase">
            {group.primary_ext}
          </span>
          <span className="inline-flex items-center gap-1 text-xs text-zinc-400 font-mono truncate max-w-md" title={group.primary_folder}>
            <Folder className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
            {group.primary_folder}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => handleQuickRule('keep_largest')}
            disabled={pendingAction !== null}
            className="inline-flex items-center gap-1 rounded-lg border border-zinc-700/80 bg-zinc-800/70 px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            title="Keep largest file, mark others for removal"
          >
            <Wand2 className="h-3.5 w-3.5 text-zinc-400" /> {pendingAction === 'rule-keep_largest' ? 'Applying...' : 'Keep Largest'}
          </button>
          <button
            onClick={() => onCompare(group.members.slice(0, 3), group.id)}
            className="inline-flex items-center gap-1 rounded-lg border border-zinc-700/80 bg-zinc-800/70 px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 transition"
          >
            <Expand className="h-3.5 w-3.5 text-zinc-400" /> Compare
          </button>
          <button
            onClick={handleAskGemini}
            disabled={aiLoading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-amber-500/20 to-indigo-500/20 border border-amber-400/30 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:from-amber-500/30 hover:to-indigo-500/30 disabled:opacity-50 transition"
          >
            <Sparkles className="h-3.5 w-3.5 text-amber-300" />
            {aiLoading ? 'Gemini Judging...' : 'Gemini: Pick Best'}
          </button>
        </div>
      </div>

      {/* Gemini Summary Banner */}
      {group.ai_analyzed === 1 && group.ai_summary && (
        <div className="flex items-start gap-2.5 border-b border-amber-500/20 bg-amber-500/5 px-4 py-2.5 text-xs text-amber-200/90">
          <Sparkles className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
          <div>
            <span className="font-semibold uppercase tracking-wide text-amber-300 mr-2">
              Gemini ({group.ai_confidence} confidence):
            </span>
            {group.ai_summary}
          </div>
        </div>
      )}

      {aiError && (
        <div role="alert" className="border-b border-red-500/20 bg-red-500/10 px-4 py-2 text-xs text-red-300">{aiError}</div>
      )}

      {/* Members Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 p-4">
        {group.members.map((m) => {
          const isKeep = m.decision === 'keep';
          const isRemove = m.decision === 'remove';
          return (
            <div
              key={m.id}
              className={`group flex flex-col rounded-xl border transition overflow-hidden ${
                isKeep
                  ? 'border-emerald-500/60 bg-emerald-950/15'
                  : isRemove
                  ? 'border-rose-500/60 bg-rose-950/15 opacity-80'
                  : 'border-zinc-800 bg-zinc-950/60 hover:border-zinc-700'
              }`}
            >
              <button
                type="button"
                onClick={() => onCompare([m], group.id)}
                aria-label={`Inspect ${m.filename} full size`}
                className="relative w-full aspect-[4/3] bg-zinc-950 overflow-hidden cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                <img
                  src={`/api/media/${m.id}/thumb`}
                  alt={m.filename}
                  loading="lazy"
                  className="h-full w-full object-cover group-hover:scale-[1.02] transition duration-200"
                />
                <div className="absolute top-2 left-2 flex gap-1.5">
                  <span className="rounded-md bg-black/70 backdrop-blur-xs px-2 py-0.5 text-[10px] font-mono uppercase text-zinc-200">
                    {m.ext.replace('.', '')}
                  </span>
                  {m.similarity !== undefined && m.similarity < 1 && (
                    <span className="rounded-md bg-indigo-600/80 px-2 py-0.5 text-[10px] font-semibold text-white">
                      {Math.round(m.similarity * 100)}%
                    </span>
                  )}
                </div>
                {m.ai_score != null && (
                  <div className="absolute top-2 right-2 rounded-md bg-amber-500/90 px-2 py-0.5 text-[10px] font-bold text-zinc-950">
                    AI {m.ai_score}
                  </div>
                )}
              </button>

              <div className="flex-1 p-3 space-y-1.5 text-xs">
                <div className="font-medium text-zinc-100 truncate" title={m.filename}>
                  {m.filename}
                </div>
                <div className="text-[11px] font-mono text-zinc-400 truncate" title={m.folder}>
                  {m.folder}
                </div>
                <div className="flex items-center justify-between text-zinc-400 pt-0.5">
                  <span>{formatBytes(m.size)}</span>
                  <span>{m.width && m.height ? `${m.width}×${m.height}` : m.media_type}</span>
                </div>
                {m.ai_reason && (
                  <div className="text-[11px] text-amber-300/90 line-clamp-2 pt-0.5" title={m.ai_reason}>
                    {m.ai_reason}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-1.5 border-t border-zinc-800/80 p-2 bg-zinc-950/40">
                <button
                  onClick={() => handleDecision(m.id, m.decision, 'keep')}
                  disabled={pendingAction !== null}
                  aria-pressed={isKeep}
                  className={`inline-flex items-center justify-center gap-1 rounded-lg py-1.5 text-xs font-medium transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
                    isKeep
                      ? 'bg-emerald-600 text-white'
                      : 'bg-zinc-800/80 text-zinc-300 hover:bg-emerald-600/25 hover:text-emerald-300'
                  }`}
                >
                  <Check className="h-3.5 w-3.5" /> Keep
                </button>
                <button
                  onClick={() => handleDecision(m.id, m.decision, 'remove')}
                  disabled={pendingAction !== null}
                  aria-pressed={isRemove}
                  className={`inline-flex items-center justify-center gap-1 rounded-lg py-1.5 text-xs font-medium transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 ${
                    isRemove
                      ? 'bg-rose-600 text-white'
                      : 'bg-zinc-800/80 text-zinc-300 hover:bg-rose-600/25 hover:text-rose-300'
                  }`}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Remove
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});

DuplicateGroupCard.displayName = 'DuplicateGroupCard';
