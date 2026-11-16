import React, { useState } from 'react';
import {
  ApprovalActionType,
  ApprovalRequestDTO,
  ApprovalStatus,
  UserRole,
} from '../../shared/types';
import { api, ApiClientError } from '../api';
import { ApprovalStatusText, formatUtcTimestamp } from './StatusText';

interface ApprovalsPanelProps {
  approvals: ApprovalRequestDTO[];
  userRole: UserRole;
  onUpdated: () => Promise<void>;
}

const ACTION_TYPES: { value: ApprovalActionType; label: string }[] = [
  { value: 'adapter_activation', label: 'Adapter Activation' },
  { value: 'spend_cap_change', label: 'Spend Cap Change' },
  { value: 'permission_change', label: 'Permission Change' },
  { value: 'external_write', label: 'External Write / Commit' },
  { value: 'competition_budget', label: 'Competition Budget' },
];

export function ApprovalsPanel({
  approvals,
  userRole,
  onUpdated,
}: ApprovalsPanelProps) {
  const [filter, setFilter] = useState<'all' | ApprovalStatus>('all');
  const [actionType, setActionType] = useState<ApprovalActionType>('adapter_activation');
  const [targetResource, setTargetResource] = useState('gemini');
  const [summary, setSummary] = useState('');
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const canRequest = userRole === 'admin' || userRole === 'operator';
  const canDecide = userRole === 'admin' || userRole === 'reviewer';

  const visibleApprovals =
    filter === 'all' ? approvals : approvals.filter((a) => a.status === filter);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setFeedback(null);
    try {
      const res = await api.createApproval({
        actionType,
        targetResource,
        summary,
      });
      setSummary('');
      await onUpdated();
      setFeedback(`Submitted approval request ${res.approval.id.slice(0, 8)}.`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to create approval request.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDecision(id: string, decision: 'approved' | 'rejected') {
    const note = (decisionNotes[id] ?? '').trim();
    if (note.length < 3) {
      setError('Please enter a decision rationale (minimum 3 characters).');
      return;
    }
    setBusyId(id);
    setError(null);
    setFeedback(null);
    try {
      await api.decideApproval(id, { decision, decisionNote: note });
      await onUpdated();
      setFeedback(`Approval request marked as ${decision}.`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to record decision.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-slate-900">Human Approval Workflow</h2>
        <p className="text-sm text-slate-600">
          Sensitive operations require explicit operator request and reviewer/admin sign-off before execution.
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

      {canRequest && (
        <form
          onSubmit={handleCreate}
          className="bg-white border border-slate-200 rounded-lg p-5 space-y-4"
        >
          <h3 className="text-sm font-semibold text-slate-900">Submit Approval Request</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label
                htmlFor="approval-action-type"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                Action type
              </label>
              <select
                id="approval-action-type"
                value={actionType}
                onChange={(e) => setActionType(e.target.value as ApprovalActionType)}
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700"
              >
                {ACTION_TYPES.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="approval-target"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                Target resource
              </label>
              <input
                id="approval-target"
                type="text"
                required
                minLength={2}
                value={targetResource}
                onChange={(e) => setTargetResource(e.target.value)}
                placeholder="e.g. gemini"
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </div>

            <div>
              <label
                htmlFor="approval-summary"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                Justification summary
              </label>
              <input
                id="approval-summary"
                type="text"
                required
                minLength={5}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="Describe requested authorization"
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-md hover:bg-blue-800 disabled:opacity-60 whitespace-nowrap"
            >
              {submitting ? 'Submitting...' : 'Submit Request'}
            </button>
          </div>
        </form>
      )}

      <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-slate-900">Approval Queue</h3>
          <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            {(['all', 'pending', 'approved', 'rejected'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setFilter(tab)}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                  filter === tab
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {visibleApprovals.length === 0 ? (
          <p className="text-sm text-slate-500 py-6 text-center">
            No approval requests match the selected filter.
          </p>
        ) : (
          <div className="divide-y divide-slate-200">
            {visibleApprovals.map((item) => {
              const isBusy = busyId === item.id;
              return (
                <div key={item.id} className="py-4 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="space-y-1 min-w-0">
                      <div className="text-sm font-semibold text-slate-900">{item.summary}</div>
                      <div className="text-xs text-slate-500">
                        {item.actionType} · Target: <span className="font-mono text-slate-700">{item.targetResource}</span> · Requested by {item.requestedByEmail ?? item.requestedByUserId} ·{' '}
                        <span className="font-mono">{formatUtcTimestamp(item.createdAt)}</span>
                      </div>
                    </div>
                    <ApprovalStatusText status={item.status} />
                  </div>

                  {item.status === 'pending' && canDecide && (
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2 pt-1">
                      <label htmlFor={`note-${item.id}`} className="sr-only">
                        Decision rationale for {item.summary}
                      </label>
                      <input
                        id={`note-${item.id}`}
                        type="text"
                        value={decisionNotes[item.id] ?? ''}
                        onChange={(e) =>
                          setDecisionNotes((prev) => ({ ...prev, [item.id]: e.target.value }))
                        }
                        placeholder="Decision rationale (required, min 3 chars)"
                        className="flex-1 px-3 py-1.5 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700"
                      />
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => handleDecision(item.id, 'approved')}
                          className="px-3 py-1.5 text-xs font-medium text-white bg-emerald-700 rounded-md hover:bg-emerald-800 disabled:opacity-50 whitespace-nowrap"
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => handleDecision(item.id, 'rejected')}
                          className="px-3 py-1.5 text-xs font-medium text-white bg-red-700 rounded-md hover:bg-red-800 disabled:opacity-50 whitespace-nowrap"
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  )}

                  {item.status !== 'pending' && item.decisionNote && (
                    <div className="text-xs text-slate-600">
                      Decision by {item.decidedByEmail ?? item.decidedByUserId} ({formatUtcTimestamp(item.decidedAt)}): &ldquo;{item.decisionNote}&rdquo;
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
