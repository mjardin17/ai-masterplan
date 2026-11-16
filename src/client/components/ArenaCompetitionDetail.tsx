import { useState } from 'react';
import { ArrowLeft, Play } from 'lucide-react';
import {
  CompetitionDetailDTO,
  UserRole,
} from '../../shared/types';
import { api, ApiClientError } from '../api';
import { ApprovalStatusText, formatUtcTimestamp } from './StatusText';

interface ArenaCompetitionDetailProps {
  detail: CompetitionDetailDTO;
  userRole: UserRole;
  onBack: () => void;
  onUpdated: () => Promise<void>;
}

export function ArenaCompetitionDetail({
  detail,
  userRole,
  onBack,
  onUpdated,
}: ArenaCompetitionDetailProps) {
  const [launching, setLaunching] = useState(false);
  const [launchMessage, setLaunchMessage] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const { competition, task, entries, reports, scores, observations } = detail;
  const canLaunch = userRole === 'admin' || userRole === 'operator';

  const reportByEntry = new Map(reports.map((r) => [r.entryId, r]));
  const scoreByEntry = new Map(scores.map((s) => [s.entryId, s]));

  async function handleLaunch() {
    setLaunching(true);
    setLaunchMessage(null);
    setLaunchError(null);
    try {
      await api.launchCompetition(competition.id);
      await onUpdated();
      setLaunchMessage('Competition launched.');
    } catch (err) {
      setLaunchError(
        err instanceof ApiClientError ? err.message : 'Unable to launch competition.',
      );
    } finally {
      setLaunching(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 hover:text-slate-900"
        >
          <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
          Back to competitions
        </button>

        {canLaunch && (
          <button
            type="button"
            disabled={launching}
            onClick={handleLaunch}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-md hover:bg-blue-800 disabled:opacity-50 whitespace-nowrap"
          >
            <Play className="w-3.5 h-3.5" aria-hidden="true" />
            {launching ? 'Checking policy...' : 'Launch Live Run'}
          </button>
        )}
      </div>

      {launchError && (
        <div
          role="alert"
          className="p-3 border border-amber-200 bg-amber-50 rounded-md text-sm text-amber-900"
        >
          {launchError}
        </div>
      )}
      {launchMessage && (
        <div
          role="status"
          className="p-3 border border-slate-200 bg-white rounded-md text-sm text-slate-800"
        >
          {launchMessage}
        </div>
      )}

      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-base font-semibold text-slate-900">{competition.title}</h3>
            <p className="text-xs text-slate-600">
              Task: <span className="font-medium text-slate-800">{task.title}</span> · Category:{' '}
              <span className="font-mono">{competition.category}</span> · Status:{' '}
              <span className="font-mono font-medium text-slate-900">{competition.status}</span>
            </p>
          </div>

          <div className="text-right space-y-1">
            <div className="text-xs text-slate-500">Approval Gate</div>
            {competition.approvalStatus ? (
              <ApprovalStatusText status={competition.approvalStatus} />
            ) : (
              <span className="text-xs text-slate-600">No approval linked</span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-3 border-t border-slate-200 text-xs">
          <div>
            <div className="text-slate-500">Time Limit</div>
            <div className="mt-0.5 font-mono font-medium text-slate-900 tabular-nums">
              {competition.timeLimitMs} ms
            </div>
          </div>
          <div>
            <div className="text-slate-500">Token Budget</div>
            <div className="mt-0.5 font-mono font-medium text-slate-900 tabular-nums">
              {competition.tokenBudget}
            </div>
          </div>
          <div>
            <div className="text-slate-500">Cost Cap</div>
            <div className="mt-0.5 font-mono font-medium text-slate-900 tabular-nums">
              ${competition.costCapUsd.toFixed(2)}
            </div>
          </div>
          <div>
            <div className="text-slate-500">Created</div>
            <div className="mt-0.5 font-mono text-slate-700">
              {formatUtcTimestamp(competition.createdAt)}
            </div>
          </div>
        </div>

        <div className="pt-3 border-t border-slate-200 space-y-2">
          <div className="text-xs font-medium text-slate-700">
            Identical Task Instructions Delivered to Every Contestant
          </div>
          <pre className="p-3 bg-slate-50 border border-slate-200 rounded-md text-xs text-slate-800 whitespace-pre-wrap font-mono">
            {task.instructions}
          </pre>
        </div>
      </section>

      <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-200">
          <h4 className="text-sm font-semibold text-slate-900">
            Contestant Entries ({entries.length})
          </h4>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                <th className="py-2.5 px-4">Contestant</th>
                <th className="py-2.5 px-4">Entry Status</th>
                <th className="py-2.5 px-4">Verified</th>
                <th className="py-2.5 px-4 text-right">Composite</th>
                <th className="py-2.5 px-4 text-right">Duration</th>
                <th className="py-2.5 px-4 text-right">Tokens</th>
                <th className="py-2.5 px-4">Workspace</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {entries.map((entry) => {
                const report = reportByEntry.get(entry.id);
                const score = scoreByEntry.get(entry.id);
                return (
                  <tr key={entry.id}>
                    <td className="py-3 px-4 whitespace-nowrap">
                      <div className="font-medium text-slate-900">
                        {entry.contestantName ?? entry.contestantId}
                      </div>
                      <div className="text-xs text-slate-500">
                        Snapshot: {entry.contestantStatusSnapshot}
                        {entry.isTestFixture ? ' · test fixture' : ''}
                      </div>
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-700 whitespace-nowrap">
                      {entry.status}
                    </td>
                    <td className="py-3 px-4 text-xs whitespace-nowrap">
                      {report ? (
                        <span className={report.passed ? 'text-emerald-700 font-medium' : 'text-red-700 font-medium'}>
                          {report.passed ? 'Passed' : 'Failed'} ({report.testsPassed}/{report.testsTotal})
                        </span>
                      ) : (
                        <span className="text-slate-500">Not executed</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-xs tabular-nums text-slate-900">
                      {score ? score.compositeScore.toFixed(2) : '—'}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-xs tabular-nums text-slate-600">
                      {entry.executionTimeMs !== null ? `${entry.executionTimeMs} ms` : '—'}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-xs tabular-nums text-slate-600">
                      {entry.tokensIn + entry.tokensOut}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-500 max-w-[240px] truncate">
                      {entry.workspacePath ?? 'Allocated on launch'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {reports.length > 0 && (
        <section className="space-y-4">
          <h4 className="text-sm font-semibold text-slate-900">
            Independent Verification Evidence ({reports.length})
          </h4>
          {reports.map((report) => {
            const score = scoreByEntry.get(report.entryId);
            return (
              <div
                key={report.id}
                className="bg-white border border-slate-200 rounded-lg p-5 space-y-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">
                      Contestant: {report.contestantId} · Verifier:{' '}
                      <span className="font-mono text-xs">{report.verifierId}</span>
                    </div>
                    <div className="text-xs font-mono text-slate-500">
                      Evidence SHA-256: {report.evidenceHash}
                    </div>
                  </div>
                  <div className="text-xs font-mono tabular-nums text-slate-700">
                    exit={report.exitCode ?? 'null'} · {report.executionTimeMs} ms
                  </div>
                </div>

                {score && (
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 p-3 bg-slate-50 border border-slate-200 rounded-md text-xs tabular-nums">
                    <div>
                      <span className="text-slate-500">Correctness</span>
                      <div className="font-semibold text-slate-900">{score.correctnessScore}</div>
                    </div>
                    <div>
                      <span className="text-slate-500">Reliability</span>
                      <div className="font-semibold text-slate-900">{score.reliabilityScore}</div>
                    </div>
                    <div>
                      <span className="text-slate-500">Speed</span>
                      <div className="font-semibold text-slate-900">{score.speedScore}</div>
                    </div>
                    <div>
                      <span className="text-slate-500">Resource</span>
                      <div className="font-semibold text-slate-900">{score.resourceScore}</div>
                    </div>
                    <div>
                      <span className="text-slate-500">Composite</span>
                      <div className="font-semibold text-blue-800">{score.compositeScore}</div>
                    </div>
                  </div>
                )}

                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-slate-700">Checks</div>
                  <div className="divide-y divide-slate-200 border border-slate-200 rounded-md">
                    {report.checks.map((chk) => (
                      <div
                        key={chk.checkId}
                        className="px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs"
                      >
                        <div>
                          <span className="font-medium text-slate-900">{chk.label}</span>{' '}
                          <span className="font-mono text-slate-500">({chk.type})</span>
                          <div className="text-slate-600">{chk.details}</div>
                        </div>
                        <span className={chk.passed ? 'text-emerald-700 font-medium' : 'text-red-700 font-medium'}>
                          {chk.passed ? 'PASS' : 'FAIL'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                  <div>
                    <div className="font-medium text-slate-700 mb-1">File Diff Summary</div>
                    <pre className="p-2.5 bg-slate-50 border border-slate-200 rounded font-mono text-slate-700 overflow-x-auto">
                      {JSON.stringify(report.diffSummary, null, 2)}
                    </pre>
                  </div>
                  <div>
                    <div className="font-medium text-slate-700 mb-1">Verifier Output Excerpt</div>
                    <pre className="p-2.5 bg-slate-50 border border-slate-200 rounded font-mono text-slate-700 overflow-x-auto max-h-40">
                      {[report.stdoutExcerpt, report.stderrExcerpt].filter(Boolean).join('\n') || 'No output captured.'}
                    </pre>
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      )}

      {observations.length > 0 && (
        <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
          <h4 className="text-sm font-semibold text-slate-900">
            Captured Learning Observations ({observations.length})
          </h4>
          <div className="divide-y divide-slate-200">
            {observations.map((obs) => (
              <div key={obs.id} className="py-2.5 text-xs space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-slate-900">
                    {obs.observationType} · {obs.contestantId}
                  </span>
                  <span className="font-mono text-slate-500">status: {obs.promotionStatus}</span>
                </div>
                <div className="text-slate-700">{obs.summary}</div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
