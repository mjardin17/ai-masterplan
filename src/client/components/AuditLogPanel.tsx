import React, { useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { AuditChainVerification, AuditLogDTO } from '../../shared/types';
import { formatUtcTimestamp } from './StatusText';

interface AuditLogPanelProps {
  entries: AuditLogDTO[];
  total: number;
  verification: AuditChainVerification | null;
  onFilter: (filters: { action?: string; resourceType?: string }) => Promise<void>;
}

export function AuditLogPanel({
  entries,
  total,
  verification,
  onFilter,
}: AuditLogPanelProps) {
  const [actionFilter, setActionFilter] = useState('');
  const [resourceFilter, setResourceFilter] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await onFilter({
        action: actionFilter.trim() || undefined,
        resourceType: resourceFilter.trim() || undefined,
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Immutable Audit Log</h2>
          <p className="text-sm text-slate-600">
            Append-only SQLite ledger protected by database triggers and SHA-256 hash chaining.
          </p>
        </div>

        {verification && (
          <div className="bg-white border border-slate-200 rounded-md px-3.5 py-2 text-xs flex items-center gap-2">
            {verification.valid ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" aria-hidden="true" />
            ) : (
              <XCircle className="w-4 h-4 text-red-700 shrink-0" aria-hidden="true" />
            )}
            <span className="font-medium text-slate-900">
              {verification.valid
                ? `Hash chain valid (${verification.totalEntries} entries)`
                : `Chain mismatch at seq ${verification.brokenAtSeq}`}
            </span>
          </div>
        )}
      </div>

      <form
        onSubmit={handleSearch}
        className="bg-white border border-slate-200 rounded-lg p-4 flex flex-col sm:flex-row sm:items-end gap-3"
      >
        <div className="flex-1">
          <label htmlFor="audit-action-filter" className="block text-xs font-medium text-slate-700 mb-1">
            Action filter
          </label>
          <input
            id="audit-action-filter"
            type="text"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            placeholder="e.g. approval. or auth."
            className="w-full px-3 py-1.5 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700"
          />
        </div>
        <div className="sm:w-52">
          <label htmlFor="audit-resource-filter" className="block text-xs font-medium text-slate-700 mb-1">
            Resource type
          </label>
          <select
            id="audit-resource-filter"
            value={resourceFilter}
            onChange={(e) => setResourceFilter(e.target.value)}
            className="w-full px-3 py-1.5 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700"
          >
            <option value="">All resources</option>
            <option value="user">user</option>
            <option value="session">session</option>
            <option value="contestant">contestant</option>
            <option value="approval_request">approval_request</option>
            <option value="benchmark_task">benchmark_task</option>
            <option value="competition">competition</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-1.5 text-sm font-medium text-white bg-blue-700 rounded-md hover:bg-blue-800 disabled:opacity-60 whitespace-nowrap"
        >
          {loading ? 'Filtering...' : 'Filter'}
        </button>
      </form>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between text-xs text-slate-600">
          <span className="tabular-nums">Showing {entries.length} of {total} events</span>
        </div>
        {entries.length === 0 ? (
          <p className="p-6 text-sm text-slate-500 text-center">No matching audit entries found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                  <th className="py-2.5 px-4">Seq</th>
                  <th className="py-2.5 px-4">Timestamp</th>
                  <th className="py-2.5 px-4">Action</th>
                  <th className="py-2.5 px-4">Actor</th>
                  <th className="py-2.5 px-4">Resource</th>
                  <th className="py-2.5 px-4">Entry Hash</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs">
                {entries.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-4 font-mono text-slate-600 tabular-nums">#{row.seq}</td>
                    <td className="py-2.5 px-4 font-mono text-slate-600 whitespace-nowrap">
                      {formatUtcTimestamp(row.createdAt)}
                    </td>
                    <td className="py-2.5 px-4 font-mono font-medium text-slate-900 whitespace-nowrap">
                      {row.action}
                    </td>
                    <td className="py-2.5 px-4 text-slate-700 whitespace-nowrap">
                      {row.actorType} · {row.actorRole ?? 'system'}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-slate-600 whitespace-nowrap">
                      {row.resourceType}/{row.resourceId.slice(0, 12)}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-slate-500 whitespace-nowrap">
                      {row.entryHash.slice(0, 16)}...
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
