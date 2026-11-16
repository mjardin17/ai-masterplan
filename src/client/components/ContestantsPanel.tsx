import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { ContestantDTO, UserRole } from '../../shared/types';
import { api, ApiClientError } from '../api';
import { ContestantStatusText, formatUtcTimestamp } from './StatusText';

interface ContestantsPanelProps {
  contestants: ContestantDTO[];
  userRole: UserRole;
  onUpdated: () => Promise<void>;
}

export function ContestantsPanel({
  contestants,
  userRole,
  onUpdated,
}: ContestantsPanelProps) {
  const [selectedId, setSelectedId] = useState<string>(contestants[0]?.id ?? 'gemini');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canCheckHealth = userRole === 'admin' || userRole === 'operator';
  const canToggle = userRole === 'admin';
  const selected = contestants.find((c) => c.id === selectedId) ?? contestants[0] ?? null;

  async function handleHealthCheck(id: string) {
    setBusyId(id);
    setError(null);
    setFeedback(null);
    try {
      const res = await api.runContestantHealthCheck(id);
      await onUpdated();
      setFeedback(
        `Checked ${res.contestant.name}: status is "${res.contestant.status}".`,
      );
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Health check failed.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleToggle(c: ContestantDTO) {
    setBusyId(c.id);
    setError(null);
    setFeedback(null);
    try {
      const res = await api.toggleContestant(c.id, !c.isEnabled);
      await onUpdated();
      setFeedback(
        `${res.contestant.name} is now ${res.contestant.isEnabled ? 'enabled' : 'disabled'}.`,
      );
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Toggle failed.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-slate-900">Contestant Registry</h2>
        <p className="text-sm text-slate-600">
          Verified adapter states. Unconfigured providers remain explicitly disconnected until real credentials and integrations are present.
        </p>
      </div>

      {error && (
        <div role="alert" className="p-3 border border-red-200 bg-red-50 rounded-md text-sm text-red-800">
          {error}
        </div>
      )}
      {feedback && (
        <div role="status" className="p-3 border border-slate-200 bg-white rounded-md text-sm text-slate-800">
          {feedback}
        </div>
      )}

      <div className="space-y-6">
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                  <th className="py-3 px-4">Contestant</th>
                  <th className="py-3 px-4">Type</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Last Checked</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {contestants.map((c) => {
                  const isBusy = busyId === c.id;
                  const isSelected = selected?.id === c.id;
                  return (
                    <tr
                      key={c.id}
                      className={isSelected ? 'bg-slate-50' : 'hover:bg-slate-50/70'}
                    >
                      <td className="py-3 px-4 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => setSelectedId(c.id)}
                          className="text-left font-medium text-slate-900 hover:text-blue-700 focus:outline-none focus:underline"
                        >
                          {c.name}
                        </button>
                        <div className="text-xs text-slate-500">{c.provider}</div>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600 whitespace-nowrap">
                        {c.kind.replace('_', ' ')} · {c.adapterType}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <ContestantStatusText status={c.status} />
                      </td>
                      <td className="py-3 px-4 text-xs font-mono text-slate-500 whitespace-nowrap">
                        {formatUtcTimestamp(c.lastCheckedAt)}
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          {canCheckHealth && (
                            <button
                              type="button"
                              disabled={isBusy || !c.isEnabled}
                              onClick={() => handleHealthCheck(c.id)}
                              aria-label={`Run health check for ${c.name}`}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
                            >
                              <RefreshCw className={`w-3.5 h-3.5 ${isBusy ? 'animate-spin' : ''}`} aria-hidden="true" />
                              Check
                            </button>
                          )}
                          {canToggle && (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => handleToggle(c)}
                              aria-label={`${c.isEnabled ? 'Disable' : 'Enable'} ${c.name}`}
                              className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
                            >
                              {c.isEnabled ? 'Disable' : 'Enable'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {selected && (
          <aside className="bg-white border border-slate-200 rounded-lg p-5 grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <div className="text-xs font-medium text-slate-500">Adapter Profile</div>
              <h3 className="mt-1 text-base font-semibold text-slate-900">{selected.name}</h3>
              <div className="mt-1 text-xs text-slate-600">
                {selected.provider} · {selected.adapterType} · {selected.kind.replace('_', ' ')}
              </div>
              <div className="mt-4 pt-3 border-t border-slate-200 text-xs text-slate-500 space-y-1">
                <div className="flex justify-between gap-2">
                  <span>Adapter ID</span>
                  <span className="font-mono text-slate-700">{selected.id}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span>Last Checked</span>
                  <span className="font-mono text-slate-700">{formatUtcTimestamp(selected.lastCheckedAt)}</span>
                </div>
              </div>
            </div>

            <div>
              <div className="text-xs font-medium text-slate-500 mb-1.5">Current Verification State</div>
              <ContestantStatusText status={selected.status} />
              <p className="mt-2 text-sm text-slate-700 leading-relaxed">{selected.statusReason}</p>
            </div>

            <div>
              <div className="text-xs font-medium text-slate-500 mb-1.5">Declared Capabilities</div>
              <p className="text-sm text-slate-700 leading-relaxed">
                {selected.capabilities.join(' · ')}
              </p>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
