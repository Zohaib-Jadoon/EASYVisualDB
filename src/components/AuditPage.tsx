import React, { useMemo, useState } from 'react';
import { Download, Search } from 'lucide-react';
import { AuditEvent } from '../shared/types';

interface AuditPageProps {
  events: AuditEvent[];
}

export function AuditPage({ events }: AuditPageProps) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'succeeded' | 'denied' | 'failed'>('all');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return events.filter((e) => {
      if (statusFilter !== 'all' && e.status !== statusFilter) return false;
      if (!q) return true;
      return (
        e.action.toLowerCase().includes(q) ||
        e.target.toLowerCase().includes(q) ||
        e.actorName.toLowerCase().includes(q) ||
        e.detail.toLowerCase().includes(q)
      );
    });
  }, [events, search, statusFilter]);

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-log.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#1B2340] dark:text-white">
            Audit & Activity History
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Append-only workspace audit log. Credentials and raw row contents are redacted automatically.
          </p>
        </div>
        <button
          type="button"
          onClick={handleExport}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] text-xs font-medium self-start sm:self-auto"
        >
          <Download className="h-3.5 w-3.5" />
          <span>Export JSON</span>
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="h-3.5 w-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Filter by actor, action, or target..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] pl-8 pr-3 py-1.5 text-xs"
          />
        </div>
        <div className="flex items-center gap-1 p-1 rounded-lg bg-[#F1F3F9] dark:bg-[#181F38] border border-[#E2E6F0] dark:border-[#232B45]">
          {(['all', 'succeeded', 'denied', 'failed'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium capitalize ${
                statusFilter === s
                  ? 'bg-white dark:bg-[#12172B] text-[#6D4AFF] shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#F7F8FC] dark:bg-[#181F38] border-b border-[#E2E6F0] dark:border-[#232B45] text-slate-500 dark:text-slate-400">
              <tr>
                <th className="px-3.5 py-2.5 font-medium">Timestamp</th>
                <th className="px-3.5 py-2.5 font-medium">Actor</th>
                <th className="px-3.5 py-2.5 font-medium">Action</th>
                <th className="px-3.5 py-2.5 font-medium">Target</th>
                <th className="px-3.5 py-2.5 font-medium">Status</th>
                <th className="px-3.5 py-2.5 font-medium">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E6F0] dark:divide-[#232B45]">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-slate-500">
                    No matching audit events.
                  </td>
                </tr>
              ) : (
                filtered.map((evt) => (
                  <tr key={evt.id} className="hover:bg-[#F7F8FC] dark:hover:bg-[#181F38]/50">
                    <td className="px-3.5 py-2.5 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                      {new Date(evt.timestamp).toLocaleString()}
                    </td>
                    <td className="px-3.5 py-2.5 whitespace-nowrap">
                      <span className="font-medium text-[#1B2340] dark:text-white">{evt.actorName}</span>{' '}
                      <span className="text-slate-400">({evt.actorRole})</span>
                    </td>
                    <td className="px-3.5 py-2.5 font-mono whitespace-nowrap">{evt.action}</td>
                    <td className="px-3.5 py-2.5 font-mono">{evt.target}</td>
                    <td
                      className={`px-3.5 py-2.5 font-medium capitalize ${
                        evt.status === 'succeeded'
                          ? 'text-[#16A66A]'
                          : evt.status === 'denied'
                          ? 'text-amber-600'
                          : 'text-[#E5484D]'
                      }`}
                    >
                      {evt.status}
                    </td>
                    <td className="px-3.5 py-2.5 text-slate-600 dark:text-slate-300 max-w-md">
                      {evt.detail}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
