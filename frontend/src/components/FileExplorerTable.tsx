import React from 'react';
import { ArrowDown, ArrowUp, Expand } from 'lucide-react';
import { FileSortBy, MediaFile } from '../types';
import { formatBytes } from '../api';

interface Props {
  files: MediaFile[];
  total: number;
  page: number;
  pageSize: number;
  sortBy: FileSortBy;
  order: 'asc' | 'desc';
  hasFilters?: boolean;
  onClearFilters?: () => void;
  onScanOpen?: () => void;
  onSortChange: (col: FileSortBy) => void;
  onPageChange: (p: number) => void;
  onPreview: (file: MediaFile) => void;
}

export const FileExplorerTable: React.FC<Props> = ({
  files,
  total,
  page,
  pageSize,
  sortBy,
  order,
  hasFilters,
  onClearFilters,
  onScanOpen,
  onSortChange,
  onPageChange,
  onPreview,
}) => {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const SortHeader: React.FC<{ col: FileSortBy; label: string; align?: string }> = ({ col, label, align }) => {
    const isSorted = sortBy === col;
    return (
      <th
        aria-sort={isSorted ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={`px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400 ${align || 'text-left'}`}
      >
        <button
          type="button"
          onClick={() => onSortChange(col)}
          className="inline-flex items-center gap-1 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
        >
          {label}
          {isSorted && (order === 'asc' ? <ArrowUp className="h-3.5 w-3.5 text-indigo-400" /> : <ArrowDown className="h-3.5 w-3.5 text-indigo-400" />)}
        </button>
      </th>
    );
  };

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead className="border-b border-zinc-800 bg-zinc-950/70">
            <tr>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400 w-16">Preview</th>
              <SortHeader col="filename" label="Filename" />
              <SortHeader col="folder" label="Folder" />
              <SortHeader col="ext" label="Extension" />
              <SortHeader col="size" label="Size" align="text-right" />
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">Dimensions</th>
              <SortHeader col="mtime" label="Modified" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60 text-sm">
            {files.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-6 py-16 text-center">
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-zinc-200">
                      {hasFilters ? 'No files match your active filters' : 'No media files indexed yet'}
                    </p>
                    <p className="text-xs text-zinc-400">
                      {hasFilters
                        ? 'Try clearing your search query, folder, extension, or media type filter.'
                        : 'Click "Scan Folders" to index your photo and video library.'}
                    </p>
                    <div className="pt-2">
                      {hasFilters && onClearFilters ? (
                        <button
                          type="button"
                          onClick={onClearFilters}
                          className="rounded-xl bg-zinc-800 px-3.5 py-1.5 text-xs font-semibold text-zinc-100 hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                        >
                          Clear active filters
                        </button>
                      ) : !hasFilters && onScanOpen ? (
                        <button
                          type="button"
                          onClick={onScanOpen}
                          className="rounded-xl bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                        >
                          Scan Folders
                        </button>
                      ) : null}
                    </div>
                  </div>
                </td>
              </tr>
            ) : (
              files.map((f) => (
              <tr key={f.id} className="hover:bg-zinc-800/40 transition">
                <td className="px-4 py-2">
                  <button
                    onClick={() => onPreview(f)}
                    aria-label={`Inspect ${f.filename}`}
                    className="relative h-10 w-12 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                  >
                    <img src={`/api/media/${f.id}/thumb`} alt={f.filename} loading="lazy" className="h-full w-full object-cover" />
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition">
                      <Expand className="h-3.5 w-3.5 text-white" />
                    </div>
                  </button>
                </td>
                <td className="px-4 py-2 font-medium text-zinc-100 max-w-[220px] truncate" title={f.filename}>
                  {f.filename}
                </td>
                <td className="px-4 py-2 font-mono text-xs text-zinc-400 max-w-[320px] truncate" title={f.folder}>
                  {f.folder}
                </td>
                <td className="px-4 py-2">
                  <span className="rounded-md bg-zinc-800 px-2 py-0.5 text-xs font-mono uppercase text-zinc-300">
                    {f.ext}
                  </span>
                </td>
                <td className="px-4 py-2 text-right font-mono text-xs text-zinc-200">{formatBytes(f.size)}</td>
                <td className="px-4 py-2 text-xs text-zinc-400">
                  {f.width && f.height ? `${f.width}×${f.height}` : f.media_type}
                </td>
                <td className="px-4 py-2 text-xs text-zinc-400">
                  {new Date(f.mtime * 1000).toLocaleDateString()}
                </td>
              </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t border-zinc-800 bg-zinc-950/60 px-4 py-3 text-xs text-zinc-400">
        <span>
          Showing {files.length} of {total.toLocaleString()} files (Page {page} of {totalPages})
        </span>
        <div className="flex gap-2">
          <button
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
            className="rounded-lg border border-zinc-700 px-3 py-1 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
          >
            Previous
          </button>
          <button
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
            className="rounded-lg border border-zinc-700 px-3 py-1 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
};
