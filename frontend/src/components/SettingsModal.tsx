import React, { useEffect, useState } from 'react';
import { Eye, EyeOff, KeyRound, Sparkles, X, CheckCircle2 } from 'lucide-react';
import { api } from '../api';
import { useDialogA11y } from '../hooks/useDialogA11y';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export const SettingsModal: React.FC<Props> = ({ open, onClose, onSaved }) => {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [masked, setMasked] = useState('');
  const [configured, setConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useDialogA11y(open, onClose);

  useEffect(() => {
    if (open) {
      setApiKey('');
      setShowKey(false);
      setError('');
      api.getSettings().then((s) => {
        setConfigured(s.gemini_configured);
        setMasked(s.gemini_key_masked);
      }).catch(() => {
        setError('Could not load current Gemini settings.');
      });
    }
  }, [open]);

  if (!open) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || !apiKey.trim()) return;
    setSaving(true);
    setError('');
    try {
      await api.saveSettings(apiKey.trim());
      onSaved();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save API key.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
      tabIndex={-1}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 focus:outline-none"
    >
      <form
        onSubmit={handleSave}
        className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <Sparkles className="h-5 w-5 text-amber-400" />
            <h2 id="settings-modal-title" className="text-lg font-semibold text-zinc-100">Gemini AI & Studio Settings</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings dialog"
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 space-y-2 text-xs text-zinc-400">
            <div className="font-semibold text-zinc-200 text-sm">Powered by Google Gemini Models</div>
            <p>• <span className="text-indigo-300 font-mono">gemini-3.8-flash</span> — Multimodal side-by-side Best Shot & sharpness judge</p>
            <p>• <span className="text-indigo-300 font-mono">gemini-embedding-2</span> — Multimodal semantic embeddings for cropped/edited duplicates</p>
            <p>• <span className="text-indigo-300 font-mono">gemini-4-argon</span> — Stateful AI Cleanup Copilot for library-wide strategy</p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="gemini-api-key" className="text-sm font-medium text-zinc-300 flex items-center gap-1.5">
                <KeyRound className="h-4 w-4 text-zinc-400" />
                Gemini API Key
              </label>
              {configured && (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Configured ({masked})
                </span>
              )}
            </div>
            <div className="relative">
              <input
                id="gemini-api-key"
                type={showKey ? 'text' : 'password'}
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="AIzaSy... (stored locally in .env)"
                className="w-full rounded-xl border border-zinc-700 bg-zinc-950 pl-3.5 pr-10 py-2.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-600 focus-visible:border-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
              />
              <button
                type="button"
                onClick={() => setShowKey((prev) => !prev)}
                aria-label={showKey ? 'Hide API key' : 'Show API key'}
                aria-pressed={showKey}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="mt-1.5 text-xs text-zinc-500">
              All local scanning, hashing, perceptual dedup, sorting, and safe quarantine work 100% offline even without an API key.
            </p>
          </div>

          {error && (
            <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-zinc-800 bg-zinc-950/50 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            Close
          </button>
          <button
            type="submit"
            disabled={saving || !apiKey.trim()}
            className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
          >
            {saving ? 'Saving...' : 'Save Key'}
          </button>
        </div>
      </form>
    </div>
  );
};
