import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  AcceptanceCheckSpec,
  AcceptanceCheckType,
  ArenaCategory,
  BenchmarkTaskDTO,
  CompetitionDetailDTO,
  CompetitionDTO,
  ContestantDTO,
  LeaderboardRowDTO,
  LearningObservationDTO,
  UserRole,
} from '../../shared/types';
import { api, ApiClientError } from '../api';
import { ArenaCompetitionDetail } from './ArenaCompetitionDetail';
import { ApprovalStatusText, ContestantStatusText, formatUtcTimestamp } from './StatusText';

interface ArenaPanelProps {
  tasks: BenchmarkTaskDTO[];
  competitions: CompetitionDTO[];
  leaderboard: LeaderboardRowDTO[];
  observations: LearningObservationDTO[];
  contestants: ContestantDTO[];
  userRole: UserRole;
  onUpdated: () => Promise<void>;
}

type ArenaSubTab = 'competitions' | 'tasks' | 'leaderboard' | 'observations';

const CATEGORIES: ArenaCategory[] = [
  'coding',
  'reasoning',
  'research',
  'debugging',
  'security',
  'recovery',
];

const CHECK_TYPES: { value: AcceptanceCheckType; label: string }[] = [
  { value: 'node_test', label: 'Node Test Runner (node --test)' },
  { value: 'file_exists', label: 'File Exists' },
  { value: 'text_contains', label: 'Text Contains' },
  { value: 'text_not_contains', label: 'Text Not Contains' },
  { value: 'security_scan', label: 'Static Security Scan' },
];

const CATEGORY_WEIGHT_DISPLAY: Record<ArenaCategory, string> = {
  coding: '50% Correctness · 25% Reliability · 15% Speed · 10% Resource',
  reasoning: '60% Correctness · 20% Reliability · 10% Speed · 10% Resource',
  research: '55% Correctness · 25% Reliability · 10% Speed · 10% Resource',
  debugging: '50% Correctness · 30% Reliability · 15% Speed · 5% Resource',
  security: '60% Correctness · 30% Reliability · 5% Speed · 5% Resource',
  recovery: '45% Correctness · 35% Reliability · 10% Speed · 10% Resource',
};

const DEFAULT_STARTING_FILES_JSON = JSON.stringify(
  {
    'solution.mjs': 'export function solve(input) {\n  return input;\n}\n',
    'solution.test.mjs':
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { solve } from './solution.mjs';\n\ntest('returns normalized output', () => {\n  assert.equal(solve('ok'), 'ok');\n});\n",
  },
  null,
  2,
);

export function ArenaPanel({
  tasks,
  competitions,
  leaderboard,
  observations,
  contestants,
  userRole,
  onUpdated,
}: ArenaPanelProps) {
  const [subTab, setSubTab] = useState<ArenaSubTab>('competitions');
  const [selectedDetail, setSelectedDetail] = useState<CompetitionDetailDTO | null>(null);
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Stage competition state
  const [stageTitle, setStageTitle] = useState('');
  const [stageTaskId, setStageTaskId] = useState<string>(tasks[0]?.id ?? '');
  const [selectedContestants, setSelectedContestants] = useState<string[]>(() =>
    contestants.filter((c) => c.status === 'connected').map((c) => c.id),
  );
  const [staging, setStaging] = useState(false);

  // Create task state
  const [taskTitle, setTaskTitle] = useState('');
  const [taskCategory, setTaskCategory] = useState<ArenaCategory>('coding');
  const [taskDescription, setTaskDescription] = useState('');
  const [taskInstructions, setTaskInstructions] = useState('');
  const [startingFilesJson, setStartingFilesJson] = useState(DEFAULT_STARTING_FILES_JSON);
  const [checks, setChecks] = useState<AcceptanceCheckSpec[]>([
    {
      id: 'unit-tests',
      label: 'Run node unit tests',
      type: 'node_test',
      targetPath: 'solution.test.mjs',
    },
    {
      id: 'sec-scan',
      label: 'Security scan',
      type: 'security_scan',
      targetPath: 'solution.mjs',
    },
  ]);
  const [timeLimitMs, setTimeLimitMs] = useState(5000);
  const [tokenBudget, setTokenBudget] = useState(4000);
  const [costCapUsd, setCostCapUsd] = useState(0.5);
  const [creatingTask, setCreatingTask] = useState(false);

  // Category filters
  const [leaderboardCategory, setLeaderboardCategory] = useState<'all' | ArenaCategory>('all');
  const [filteredLeaderboard, setFilteredLeaderboard] = useState<LeaderboardRowDTO[] | null>(null);
  const [loadingLeaderboard, setLoadingLeaderboard] = useState(false);

  const canMutate = userRole === 'admin' || userRole === 'operator';
  const effectiveTaskId =
    tasks.some((t) => t.id === stageTaskId) ? stageTaskId : (tasks[0]?.id ?? '');
  const displayedLeaderboard =
    leaderboardCategory === 'all' ? leaderboard : (filteredLeaderboard ?? []);

  async function handleInspectCompetition(id: string) {
    setLoadingDetailId(id);
    setError(null);
    try {
      const detail = await api.getCompetitionDetail(id);
      setSelectedDetail(detail);
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : 'Failed to load competition details.',
      );
    } finally {
      setLoadingDetailId(null);
    }
  }

  async function handleRefreshSelectedDetail() {
    await onUpdated();
    if (selectedDetail) {
      const fresh = await api.getCompetitionDetail(selectedDetail.competition.id);
      setSelectedDetail(fresh);
    }
  }

  function toggleContestantSelection(id: string) {
    setSelectedContestants((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  }

  async function handleStageCompetition(e: React.FormEvent) {
    e.preventDefault();
    if (!effectiveTaskId) {
      setError('Create a benchmark task first before staging a competition.');
      return;
    }
    setStaging(true);
    setError(null);
    setFeedback(null);
    try {
      const detail = await api.stageCompetition({
        title: stageTitle,
        taskId: effectiveTaskId,
        contestantIds: selectedContestants,
        requestApproval: true,
      });
      setStageTitle('');
      await onUpdated();
      setSelectedDetail(detail);
      setFeedback(
        `Staged competition "${detail.competition.title}" and created linked approval request.`,
      );
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to stage competition.');
    } finally {
      setStaging(false);
    }
  }

  function handleAddCheck() {
    setChecks((prev) => [
      ...prev,
      {
        id: `check-${prev.length + 1}`,
        label: 'Verify artifact',
        type: 'file_exists',
        targetPath: 'solution.mjs',
      },
    ]);
  }

  function handleUpdateCheck(index: number, patch: Partial<AcceptanceCheckSpec>) {
    setChecks((prev) => prev.map((chk, idx) => (idx === index ? { ...chk, ...patch } : chk)));
  }

  function handleRemoveCheck(index: number) {
    setChecks((prev) => prev.filter((_, idx) => idx !== index));
  }

  async function handleCreateTask(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFeedback(null);

    let parsedStartingFiles: Record<string, string>;
    try {
      const raw = JSON.parse(startingFilesJson) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        setError('Starting files must be a JSON object mapping relative paths to string contents.');
        return;
      }
      const entries = Object.entries(raw as Record<string, unknown>);
      for (const [k, v] of entries) {
        if (typeof v !== 'string') {
          setError(`Starting file "${k}" value must be a JSON string.`);
          return;
        }
      }
      parsedStartingFiles = Object.fromEntries(entries as [string, string][]);
    } catch {
      setError('Starting files JSON is invalid.');
      return;
    }

    setCreatingTask(true);
    try {
      const res = await api.createArenaTask({
        title: taskTitle,
        category: taskCategory,
        description: taskDescription || taskTitle,
        instructions: taskInstructions,
        startingFiles: parsedStartingFiles,
        acceptanceChecks: checks,
        timeLimitMs,
        tokenBudget,
        costCapUsd,
      });
      setTaskTitle('');
      setTaskDescription('');
      setTaskInstructions('');
      await onUpdated();
      setStageTaskId(res.task.id);
      setFeedback(`Created benchmark task "${res.task.title}" (${res.task.category}).`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to create benchmark task.');
    } finally {
      setCreatingTask(false);
    }
  }

  async function handleLeaderboardCategoryChange(nextCat: 'all' | ArenaCategory) {
    setLeaderboardCategory(nextCat);
    if (nextCat === 'all') {
      setFilteredLeaderboard(null);
      return;
    }
    setLoadingLeaderboard(true);
    try {
      const res = await api.getLeaderboard(nextCat);
      setFilteredLeaderboard(res.leaderboard);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to load leaderboard.');
    } finally {
      setLoadingLeaderboard(false);
    }
  }

  if (selectedDetail) {
    return (
      <ArenaCompetitionDetail
        detail={selectedDetail}
        userRole={userRole}
        onBack={() => setSelectedDetail(null)}
        onUpdated={handleRefreshSelectedDetail}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Fair Competition Arena & Independent Verification
          </h2>
          <p className="text-sm text-slate-600">
            Standardized benchmark tasks, isolated per-entry workspaces, independent verification checks, and evidence-backed leaderboards.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-md max-w-full">
          {(
            [
              { id: 'competitions', label: 'Competitions' },
              { id: 'tasks', label: 'Benchmark Tasks' },
              { id: 'leaderboard', label: 'Leaderboard' },
              { id: 'observations', label: 'Observations' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSubTab(tab.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                subTab === tab.id
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
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

      {subTab === 'competitions' && (
        <div className="space-y-6">
          {canMutate && (
            <form
              onSubmit={handleStageCompetition}
              className="bg-white border border-slate-200 rounded-lg p-5 space-y-4"
            >
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Stage Competition</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Every eligible contestant receives identical benchmark instructions and resource caps. Staging creates a mandatory human approval request; paid live runs remain blocked by Milestone 2 policy.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="stage-comp-title"
                    className="block text-xs font-medium text-slate-700 mb-1.5"
                  >
                    Competition title
                  </label>
                  <input
                    id="stage-comp-title"
                    type="text"
                    required
                    minLength={3}
                    value={stageTitle}
                    onChange={(e) => setStageTitle(e.target.value)}
                    placeholder="e.g. Coding Baseline Evaluation #1"
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>

                <div>
                  <label
                    htmlFor="stage-comp-task"
                    className="block text-xs font-medium text-slate-700 mb-1.5"
                  >
                    Benchmark task
                  </label>
                  <select
                    id="stage-comp-task"
                    value={effectiveTaskId}
                    onChange={(e) => setStageTaskId(e.target.value)}
                    disabled={tasks.length === 0}
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700 disabled:bg-slate-50"
                  >
                    {tasks.length === 0 ? (
                      <option value="">No benchmark tasks created yet</option>
                    ) : (
                      tasks.map((t) => (
                        <option key={t.id} value={t.id}>
                          [{t.category}] {t.title} ({t.timeLimitMs}ms · ${t.costCapUsd.toFixed(2)})
                        </option>
                      ))
                    )}
                  </select>
                </div>
              </div>

              <div>
                <div className="text-xs font-medium text-slate-700 mb-2">
                  Select Connected Contestants
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                  {contestants.map((c) => {
                    const isEligible = c.status === 'connected';
                    const checked = selectedContestants.includes(c.id);
                    return (
                      <label
                        key={c.id}
                        className={`flex items-start gap-2.5 p-2.5 border rounded-md text-xs ${
                          isEligible
                            ? 'border-slate-300 bg-white cursor-pointer hover:bg-slate-50'
                            : 'border-slate-200 bg-slate-50 text-slate-500 cursor-not-allowed'
                        }`}
                      >
                        <input
                          type="checkbox"
                          disabled={!isEligible}
                          checked={isEligible && checked}
                          onChange={() => toggleContestantSelection(c.id)}
                          className="mt-0.5 rounded border-slate-300 text-blue-700 focus:ring-blue-700"
                        />
                        <div className="min-w-0">
                          <div className="font-medium text-slate-900 truncate">{c.name}</div>
                          <div className="mt-0.5">
                            <ContestantStatusText status={c.status} />
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center justify-between gap-4">
                {tasks.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => setSubTab('tasks')}
                    className="text-xs font-medium text-blue-700 hover:underline"
                  >
                    Create a benchmark task first
                  </button>
                ) : (
                  <span className="text-xs text-slate-500 tabular-nums">
                    {selectedContestants.length} eligible contestant(s) selected
                  </span>
                )}

                <button
                  type="submit"
                  disabled={staging || tasks.length === 0 || selectedContestants.length === 0}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-md hover:bg-blue-800 disabled:opacity-50 whitespace-nowrap"
                >
                  {staging ? 'Staging...' : 'Stage Competition'}
                </button>
              </div>
            </form>
          )}

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-4">
              <h3 className="text-sm font-semibold text-slate-900">
                Competition History ({competitions.length})
              </h3>
            </div>

            {competitions.length === 0 ? (
              <p className="text-sm text-slate-500 py-8 text-center px-4">
                No competitions staged yet. Create a benchmark task and stage a competition above.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                      <th className="py-3 px-4">Competition</th>
                      <th className="py-3 px-4">Category</th>
                      <th className="py-3 px-4 text-right">Entries</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4">Approval</th>
                      <th className="py-3 px-4">Created</th>
                      <th className="py-3 px-4 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 text-sm">
                    {competitions.map((comp) => (
                      <tr key={comp.id} className="hover:bg-slate-50/70">
                        <td className="py-3 px-4">
                          <div className="font-medium text-slate-900">{comp.title}</div>
                          <div className="text-xs text-slate-500">{comp.taskTitle ?? comp.taskId}</div>
                        </td>
                        <td className="py-3 px-4 font-mono text-xs text-slate-700 whitespace-nowrap">
                          {comp.category}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-xs tabular-nums text-slate-700">
                          {comp.entryCount ?? 0}
                        </td>
                        <td className="py-3 px-4 font-mono text-xs text-slate-800 whitespace-nowrap">
                          {comp.status}
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          {comp.approvalStatus ? (
                            <ApprovalStatusText status={comp.approvalStatus} />
                          ) : (
                            <span className="text-xs text-slate-500">None</span>
                          )}
                        </td>
                        <td className="py-3 px-4 font-mono text-xs text-slate-500 whitespace-nowrap">
                          {formatUtcTimestamp(comp.createdAt)}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <button
                            type="button"
                            disabled={loadingDetailId === comp.id}
                            onClick={() => handleInspectCompetition(comp.id)}
                            className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-50"
                          >
                            {loadingDetailId === comp.id ? 'Loading...' : 'Inspect'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {subTab === 'tasks' && (
        <div className="space-y-6">
          {canMutate && (
            <form
              onSubmit={handleCreateTask}
              className="bg-white border border-slate-200 rounded-lg p-5 space-y-4"
            >
              <h3 className="text-sm font-semibold text-slate-900">Create Benchmark Task</h3>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="md:col-span-2">
                  <label
                    htmlFor="task-title"
                    className="block text-xs font-medium text-slate-700 mb-1.5"
                  >
                    Task title
                  </label>
                  <input
                    id="task-title"
                    type="text"
                    required
                    minLength={3}
                    value={taskTitle}
                    onChange={(e) => setTaskTitle(e.target.value)}
                    placeholder="e.g. Deterministic Slug Sanitizer"
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>

                <div>
                  <label
                    htmlFor="task-category"
                    className="block text-xs font-medium text-slate-700 mb-1.5"
                  >
                    Category
                  </label>
                  <select
                    id="task-category"
                    value={taskCategory}
                    onChange={(e) => setTaskCategory(e.target.value as ArenaCategory)}
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700"
                  >
                    {CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label
                  htmlFor="task-description"
                  className="block text-xs font-medium text-slate-700 mb-1.5"
                >
                  Summary description
                </label>
                <input
                  id="task-description"
                  type="text"
                  value={taskDescription}
                  onChange={(e) => setTaskDescription(e.target.value)}
                  placeholder="Concise summary of problem and evaluation goal"
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700"
                />
              </div>

              <div>
                <label
                  htmlFor="task-instructions"
                  className="block text-xs font-medium text-slate-700 mb-1.5"
                >
                  Standardized Contestant Instructions
                </label>
                <textarea
                  id="task-instructions"
                  required
                  minLength={10}
                  rows={3}
                  value={taskInstructions}
                  onChange={(e) => setTaskInstructions(e.target.value)}
                  placeholder="Exact prompt delivered identically to every contestant workspace..."
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700"
                />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="task-starting-files"
                    className="block text-xs font-medium text-slate-700 mb-1.5"
                  >
                    Starting Workspace Files (JSON map)
                  </label>
                  <textarea
                    id="task-starting-files"
                    rows={7}
                    value={startingFilesJson}
                    onChange={(e) => setStartingFilesJson(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-slate-700">
                      Independent Acceptance Checks ({checks.length})
                    </span>
                    <button
                      type="button"
                      onClick={handleAddCheck}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-50"
                    >
                      <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                      Add Check
                    </button>
                  </div>

                  <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                    {checks.map((chk, idx) => (
                      <div
                        key={chk.id + idx}
                        className="p-2.5 border border-slate-200 rounded-md bg-slate-50 space-y-2"
                      >
                        <div className="flex items-center gap-2">
                          <select
                            aria-label={`Check ${idx + 1} type`}
                            value={chk.type}
                            onChange={(e) =>
                              handleUpdateCheck(idx, {
                                type: e.target.value as AcceptanceCheckType,
                              })
                            }
                            className="flex-1 px-2 py-1 text-xs bg-white border border-slate-300 rounded"
                          >
                            {CHECK_TYPES.map((ct) => (
                              <option key={ct.value} value={ct.value}>
                                {ct.label}
                              </option>
                            ))}
                          </select>
                          {checks.length > 1 && (
                            <button
                              type="button"
                              aria-label={`Remove check ${idx + 1}`}
                              onClick={() => handleRemoveCheck(idx)}
                              className="p-1 text-slate-500 hover:text-red-700"
                            >
                              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            type="text"
                            aria-label={`Check ${idx + 1} label`}
                            value={chk.label}
                            onChange={(e) => handleUpdateCheck(idx, { label: e.target.value })}
                            placeholder="Check label"
                            className="px-2 py-1 text-xs bg-white border border-slate-300 rounded"
                          />
                          <input
                            type="text"
                            aria-label={`Check ${idx + 1} target path`}
                            value={chk.targetPath ?? ''}
                            onChange={(e) => handleUpdateCheck(idx, { targetPath: e.target.value })}
                            placeholder="Target path (e.g. solution.test.mjs)"
                            className="px-2 py-1 text-xs font-mono bg-white border border-slate-300 rounded"
                          />
                        </div>
                        {(chk.type === 'text_contains' || chk.type === 'text_not_contains') && (
                          <input
                            type="text"
                            aria-label={`Check ${idx + 1} pattern`}
                            value={chk.needle ?? ''}
                            onChange={(e) => handleUpdateCheck(idx, { needle: e.target.value })}
                            placeholder="Required/forbidden substring"
                            className="w-full px-2 py-1 text-xs font-mono bg-white border border-slate-300 rounded"
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
                <div>
                  <label
                    htmlFor="task-timelimit"
                    className="block text-xs font-medium text-slate-700 mb-1.5"
                  >
                    Time limit (ms)
                  </label>
                  <input
                    id="task-timelimit"
                    type="number"
                    min={500}
                    max={120000}
                    value={timeLimitMs}
                    onChange={(e) => setTimeLimitMs(Number(e.target.value))}
                    className="w-full px-3 py-2 text-sm tabular-nums bg-white border border-slate-300 rounded-md"
                  />
                </div>
                <div>
                  <label
                    htmlFor="task-token-budget"
                    className="block text-xs font-medium text-slate-700 mb-1.5"
                  >
                    Token budget
                  </label>
                  <input
                    id="task-token-budget"
                    type="number"
                    min={100}
                    value={tokenBudget}
                    onChange={(e) => setTokenBudget(Number(e.target.value))}
                    className="w-full px-3 py-2 text-sm tabular-nums bg-white border border-slate-300 rounded-md"
                  />
                </div>
                <div>
                  <label
                    htmlFor="task-cost-cap"
                    className="block text-xs font-medium text-slate-700 mb-1.5"
                  >
                    Cost cap (USD)
                  </label>
                  <input
                    id="task-cost-cap"
                    type="number"
                    min={0}
                    step={0.05}
                    value={costCapUsd}
                    onChange={(e) => setCostCapUsd(Number(e.target.value))}
                    className="w-full px-3 py-2 text-sm tabular-nums bg-white border border-slate-300 rounded-md"
                  />
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={creatingTask}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-md hover:bg-blue-800 disabled:opacity-50 whitespace-nowrap"
                >
                  {creatingTask ? 'Saving task...' : 'Save Benchmark Task'}
                </button>
              </div>
            </form>
          )}

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200">
              <h3 className="text-sm font-semibold text-slate-900">
                Benchmark Task Library ({tasks.length})
              </h3>
            </div>
            {tasks.length === 0 ? (
              <p className="text-sm text-slate-500 py-8 text-center px-4">
                No benchmark tasks saved yet.
              </p>
            ) : (
              <div className="divide-y divide-slate-200">
                {tasks.map((task) => (
                  <div key={task.id} className="p-4 space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="font-medium text-sm text-slate-900">{task.title}</div>
                      <div className="text-xs font-mono text-slate-600 tabular-nums">
                        {task.category} · {task.acceptanceChecks.length} check(s) · {task.timeLimitMs} ms · ${task.costCapUsd.toFixed(2)}
                      </div>
                    </div>
                    <p className="text-xs text-slate-600">{task.description}</p>
                    <div className="text-xs font-mono text-slate-500">
                      Files: {Object.keys(task.startingFiles).join(', ') || 'None'} · Created {formatUtcTimestamp(task.createdAt)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {subTab === 'leaderboard' && (
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Verified Performance Leaderboard
                </h3>
                <p className="text-xs text-slate-600">
                  Only connected contestants evaluated on non-fixture verified competitions appear here. Unconfigured providers and test fixtures are excluded.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <label
                  htmlFor="leaderboard-category-filter"
                  className="text-xs font-medium text-slate-700"
                >
                  Category
                </label>
                <select
                  id="leaderboard-category-filter"
                  value={leaderboardCategory}
                  onChange={(e) =>
                    handleLeaderboardCategoryChange(e.target.value as 'all' | ArenaCategory)
                  }
                  className="px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-md text-slate-900"
                >
                  <option value="all">All Categories</option>
                  {CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {loadingLeaderboard ? (
              <p className="text-sm text-slate-500 py-8 text-center">Loading leaderboard...</p>
            ) : displayedLeaderboard.length === 0 ? (
              <div className="py-8 text-center border border-dashed border-slate-200 rounded-md px-4 space-y-1">
                <div className="text-sm font-medium text-slate-800">
                  No verified live rankings recorded yet
                </div>
                <p className="text-xs text-slate-500">
                  Rankings populate strictly from verified, non-fixture competition evidence. Unconfigured adapters and Milestone 2 policy-gated launches never generate synthetic scores.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                      <th className="py-2.5 px-3">Rank</th>
                      <th className="py-2.5 px-3">Contestant</th>
                      <th className="py-2.5 px-3 text-right">Runs</th>
                      <th className="py-2.5 px-3 text-right">Pass Rate</th>
                      <th className="py-2.5 px-3 text-right">Composite</th>
                      <th className="py-2.5 px-3 text-right">Correctness</th>
                      <th className="py-2.5 px-3 text-right">Reliability</th>
                      <th className="py-2.5 px-3 text-right">Speed</th>
                      <th className="py-2.5 px-3 text-right">Resource</th>
                      <th className="py-2.5 px-3">Latest Verified</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 text-xs tabular-nums">
                    {displayedLeaderboard.map((row, index) => (
                      <tr key={row.contestantId}>
                        <td className="py-3 px-3 font-mono font-semibold text-slate-900">
                          #{index + 1}
                        </td>
                        <td className="py-3 px-3">
                          <div className="font-medium text-slate-900">{row.contestantName}</div>
                          <div className="text-slate-500">{row.provider}</div>
                        </td>
                        <td className="py-3 px-3 text-right font-mono">{row.runsCount}</td>
                        <td className="py-3 px-3 text-right font-mono">{row.passRate.toFixed(1)}%</td>
                        <td className="py-3 px-3 text-right font-mono font-semibold text-blue-800">
                          {row.avgCompositeScore.toFixed(2)}
                        </td>
                        <td className="py-3 px-3 text-right font-mono">
                          {row.avgCorrectnessScore.toFixed(2)}
                        </td>
                        <td className="py-3 px-3 text-right font-mono">
                          {row.avgReliabilityScore.toFixed(2)}
                        </td>
                        <td className="py-3 px-3 text-right font-mono">
                          {row.avgSpeedScore.toFixed(2)}
                        </td>
                        <td className="py-3 px-3 text-right font-mono">
                          {row.avgResourceScore.toFixed(2)}
                        </td>
                        <td className="py-3 px-3 font-mono text-slate-500 whitespace-nowrap">
                          {formatUtcTimestamp(row.lastVerifiedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
            <h4 className="text-sm font-semibold text-slate-900">
              Transparent Category Scoring Weights (Rule m2.v1)
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              {CATEGORIES.map((cat) => (
                <div key={cat} className="p-3 border border-slate-200 rounded-md flex items-center justify-between gap-2">
                  <span className="font-mono font-semibold text-slate-900">{cat}</span>
                  <span className="text-slate-600 tabular-nums">{CATEGORY_WEIGHT_DISPLAY[cat]}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {subTab === 'observations' && (
        <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Learning Core Observations ({observations.length})
            </h3>
            <p className="text-xs text-slate-600">
              Verified competition outcomes captured as candidate observations. All entries remain in <span className="font-mono">captured</span> state until Milestone 3 verification and promotion.
            </p>
          </div>

          {observations.length === 0 ? (
            <p className="text-sm text-slate-500 py-8 text-center">
              No learning observations captured from verified competitions yet.
            </p>
          ) : (
            <div className="divide-y divide-slate-200">
              {observations.map((obs) => (
                <div key={obs.id} className="py-3 space-y-1 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-slate-900">
                      {obs.observationType} · {obs.contestantId} · {obs.category}
                    </span>
                    <span className="font-mono text-slate-500">
                      {obs.promotionStatus} · {formatUtcTimestamp(obs.createdAt)}
                    </span>
                  </div>
                  <div className="text-slate-700">{obs.summary}</div>
                  {obs.evidenceReportId && (
                    <div className="font-mono text-slate-500">
                      Evidence report: {obs.evidenceReportId}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
