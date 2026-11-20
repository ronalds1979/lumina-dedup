import React, { useEffect, useRef, useState } from 'react';
import { Send, Sparkles, X } from 'lucide-react';
import { api } from '../api';
import { useDialogA11y } from '../hooks/useDialogA11y';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface ChatMsg {
  role: 'user' | 'assistant';
  text: string;
}

const QUICK_PROMPTS = [
  'Where is my biggest wasted space across folders?',
  'Give me a safe 3-step cleanup plan for my 285k library',
  'Which file extensions are taking up the most storage?',
  'How should I safely handle burst photos vs exact duplicates?',
];

export const CopilotDrawer: React.FC<Props> = ({ open, onClose }) => {
  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      role: 'assistant',
      text: 'Hi! I am Lumina Copilot powered by gemini-4-argon. I can see your live indexed folder stats, extensions, and duplicate groups. Ask me how to prioritize and safely shrink your library!',
    },
  ]);
  const [input, setInput] = useState('');
  const [interactionId, setInteractionId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const dialogRef = useDialogA11y(open, onClose);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [open, messages, loading]);

  if (!open) return null;

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || loading) return;
    setMessages((prev) => [...prev, { role: 'user', text: q }]);
    setInput('');
    setLoading(true);
    try {
      const res = await api.copilotChat(q, interactionId, 'gemini-4-argon');
      setInteractionId(res.interaction_id);
      setMessages((prev) => [...prev, { role: 'assistant', text: res.reply }]);
    } catch (e: unknown) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: `Error: ${e instanceof Error ? e.message : 'Could not reach Gemini. Check your API key in Settings.'}`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="copilot-drawer-title"
      tabIndex={-1}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-xs focus:outline-none"
    >
      <div className="flex h-full w-full max-w-lg flex-col border-l border-zinc-800 bg-zinc-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-amber-500/20 text-amber-400">
              <Sparkles className="h-4 w-4" />
            </div>
            <div>
              <h2 id="copilot-drawer-title" className="text-base font-semibold text-zinc-100">Gemini Cleanup Copilot</h2>
              <p className="text-xs text-zinc-400">Powered by gemini-4-argon • Live Library Context</p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close copilot drawer"
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {messages.map((m, idx) => (
            <div key={idx} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                  m.role === 'user'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-zinc-950 border border-zinc-800 text-zinc-200'
                }`}
              >
                {m.text}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start" role="status" aria-live="polite">
              <div className="rounded-2xl bg-zinc-950 border border-zinc-800 px-4 py-3 text-sm text-zinc-400 animate-pulse">
                Gemini is analyzing your library...
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="border-t border-zinc-800 p-4 space-y-3 bg-zinc-950/60">
          <div className="flex flex-wrap gap-1.5">
            {QUICK_PROMPTS.map((qp) => (
              <button
                key={qp}
                onClick={() => send(qp)}
                className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-300 hover:border-indigo-500/50 hover:text-indigo-300 transition"
              >
                {qp}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex gap-2"
          >
            <input
              aria-label="Ask Gemini Copilot"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask Gemini about your duplicates, folders, or safety..."
              className="flex-1 rounded-xl border border-zinc-700 bg-zinc-900 px-3.5 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus-visible:border-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
            />
            <button
              type="submit"
              aria-label="Send message"
              disabled={loading || !input.trim()}
              className="rounded-xl bg-indigo-600 px-4 py-2.5 text-white hover:bg-indigo-500 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
