import {
  ApprovalRequestDTO,
  AuditLogDTO,
  CompetitionDTO,
  ContestantDTO,
  HealthSummary,
} from '../../shared/types';
import { ApprovalStatusText, ContestantStatusText, formatUtcTimestamp } from './StatusText';

interface OverviewPanelProps {
  health: HealthSummary | null;
  contestants: ContestantDTO[];
  approvals: ApprovalRequestDTO[];
  recentAudits: AuditLogDTO[];
  arenaTasksCount: number;
  competitions: CompetitionDTO[];
  onNavigate: (tab: 'arena' | 'contestants' | 'approvals' | 'audit') => void;
}

export function OverviewPanel({
  health,
  contestants,
  approvals,
  recentAudits,
  arenaTasksCount,
  competitions,
  onNavigate,
}: OverviewPanelProps) {
  const pendingCount = approvals.filter((a) => a.status === 'pending').length;

  return (
    <div className="space-y-8">
      <section aria-labelledby="overview-metrics-heading">
        <div className="mb-4">
          <h2 id="overview-metrics-heading" className="text-base font-semibold text-slate-900">
            System Control Summary
          </h2>
          <p className="text-sm text-slate-600">
            Live state persisted in SQLite and verified against active contestant adapters.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white border border-slate-200 rounded-lg p-5">
            <div className="text-xs font-medium text-slate-500">Registered Contestants</div>
            <div className="mt-2 text-2xl font-semibold text-slate-900 tabular-nums">
              {health?.contestants.total ?? contestants.length}
            </div>
            <div className="mt-2 text-xs text-slate-600 tabular-nums">
              {health?.contestants.connected ?? 0} connected · {health?.contestants.unconfigured ?? 0} unconfigured
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg p-5">
            <div className="text-xs font-medium text-slate-500">Pending Human Approvals</div>
            <div className="mt-2 text-2xl font-semibold text-slate-900 tabular-nums">
              {health?.approvals?.pending ?? pendingCount}
            </div>
            <div className="mt-2 text-xs text-slate-600 tabular-nums">
              {approvals.length} total recorded requests
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg p-5">
            <div className="text-xs font-medium text-slate-500">Persistence Layer</div>
            <div className="mt-2 text-2xl font-semibold text-slate-900">
              {health?.database.connected ? 'SQLite Online' : 'Degraded'}
            </div>
            <div className="mt-2 text-xs text-slate-600 font-mono">
              {health?.database.migrationVersion ?? 'unknown'}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg p-5">
            <div className="text-xs font-medium text-slate-500">Audit Chain Integrity</div>
            <div className="mt-2 text-2xl font-semibold text-slate-900">
              {health?.audit?.valid ? 'Verified' : health?.audit ? 'Broken' : 'Pending'}
            </div>
            <div className="mt-2 text-xs text-slate-600 tabular-nums">
              {(() => {
                const count = health?.audit?.totalEntries ?? recentAudits.length;
                return `${count} immutable ${count === 1 ? 'entry' : 'entries'}`;
              })()}
            </div>
          </div>
        </div>
      </section>

      <section className="bg-white border border-slate-200 rounded-lg p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Competition Arena Engine</h3>
          <p className="text-xs text-slate-600 tabular-nums mt-0.5">
            {arenaTasksCount} benchmark {arenaTasksCount === 1 ? 'task' : 'tasks'} · {competitions.length} recorded {competitions.length === 1 ? 'competition' : 'competitions'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onNavigate('arena')}
          className="px-3 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-md hover:bg-blue-800 whitespace-nowrap"
        >
          Open Arena
        </button>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="flex items-center justify-between gap-4 mb-4">
            <h3 className="text-sm font-semibold text-slate-900">Contestant Readiness</h3>
            <button
              type="button"
              onClick={() => onNavigate('contestants')}
              className="text-xs font-medium text-blue-700 hover:underline whitespace-nowrap shrink-0"
            >
              Manage registry
            </button>
          </div>
          <div className="divide-y divide-slate-200">
            {contestants.map((c) => (
              <div key={c.id} className="py-2.5 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-900 truncate">{c.name}</div>
                  <div className="text-xs text-slate-500 truncate">
                    {c.provider} · {c.adapterType}
                  </div>
                </div>
                <ContestantStatusText status={c.status} />
              </div>
            ))}
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-6">
          <div>
            <div className="flex items-center justify-between gap-4 mb-3">
              <h3 className="text-sm font-semibold text-slate-900">Recent Approval Queue</h3>
              <button
                type="button"
                onClick={() => onNavigate('approvals')}
                className="text-xs font-medium text-blue-700 hover:underline whitespace-nowrap shrink-0"
              >
                Open approvals
              </button>
            </div>
            {approvals.length === 0 ? (
              <p className="text-sm text-slate-500 py-3">
                No human approval requests recorded yet.
              </p>
            ) : (
              <div className="divide-y divide-slate-200">
                {approvals.slice(0, 4).map((item) => (
                  <div key={item.id} className="py-2.5 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">
                        {item.summary}
                      </div>
                      <div className="text-xs text-slate-500 truncate">
                        {item.actionType} · {item.targetResource}
                      </div>
                    </div>
                    <ApprovalStatusText status={item.status} />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="pt-4 border-t border-slate-200">
            <div className="flex items-center justify-between gap-4 mb-3">
              <h3 className="text-sm font-semibold text-slate-900">Latest Audit Events</h3>
              <button
                type="button"
                onClick={() => onNavigate('audit')}
                className="text-xs font-medium text-blue-700 hover:underline whitespace-nowrap shrink-0"
              >
                View full ledger
              </button>
            </div>
            <div className="divide-y divide-slate-200">
              {recentAudits.slice(0, 5).map((entry) => (
                <div key={entry.id} className="py-2 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-xs font-mono text-slate-800 truncate">{entry.action}</div>
                    <div className="text-xs text-slate-500 truncate">
                      {entry.resourceType} / {entry.resourceId}
                    </div>
                  </div>
                  <span className="text-xs font-mono text-slate-500 whitespace-nowrap shrink-0">
                    {formatUtcTimestamp(entry.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
