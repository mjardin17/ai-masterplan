import {
  AcceptanceCheckSpec,
  ApprovalActionType,
  ApprovalRequestDTO,
  ApprovalStatus,
  ArenaCategory,
  AuditChainVerification,
  AuditLogDTO,
  AuthStatusDTO,
  BenchmarkTaskDTO,
  CompetitionDetailDTO,
  CompetitionDTO,
  ContestantDTO,
  HealthSummary,
  LeaderboardRowDTO,
  LearningObservationDTO,
  PublicUser,
  UserRole,
} from '../shared/types';

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }

  if (!res.ok) {
    const msg =
      typeof parsed.error === 'string' && parsed.error
        ? parsed.error
        : `Request failed with status ${res.status}`;
    throw new ApiClientError(res.status, msg);
  }

  return parsed as unknown as T;
}

export const api = {
  getAuthStatus: () => requestJson<AuthStatusDTO>('/api/auth/status'),
  bootstrapAdmin: (body: { email: string; displayName: string; password: string }) =>
    requestJson<{ user: PublicUser; expiresAt: string }>('/api/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  login: (body: { email: string; password: string }) =>
    requestJson<{ user: PublicUser; expiresAt: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  logout: () => requestJson<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  getHealth: () => requestJson<HealthSummary>('/api/health'),

  listContestants: () => requestJson<{ contestants: ContestantDTO[] }>('/api/contestants'),
  runContestantHealthCheck: (id: string) =>
    requestJson<{ contestant: ContestantDTO }>(`/api/contestants/${encodeURIComponent(id)}/health-check`, {
      method: 'POST',
    }),
  toggleContestant: (id: string, isEnabled: boolean) =>
    requestJson<{ contestant: ContestantDTO }>(`/api/contestants/${encodeURIComponent(id)}/toggle`, {
      method: 'PATCH',
      body: JSON.stringify({ isEnabled }),
    }),

  listApprovals: (status?: ApprovalStatus) => {
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    return requestJson<{ approvals: ApprovalRequestDTO[] }>(`/api/approvals${q}`);
  },
  createApproval: (body: {
    actionType: ApprovalActionType;
    targetResource: string;
    summary: string;
    payload?: Record<string, unknown>;
  }) =>
    requestJson<{ approval: ApprovalRequestDTO }>('/api/approvals', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  decideApproval: (id: string, body: { decision: 'approved' | 'rejected'; decisionNote: string }) =>
    requestJson<{ approval: ApprovalRequestDTO }>(
      `/api/approvals/${encodeURIComponent(id)}/decide`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),

  listAuditLogs: (params?: { action?: string; resourceType?: string; limit?: number }) => {
    const sp = new URLSearchParams();
    if (params?.action) sp.set('action', params.action);
    if (params?.resourceType) sp.set('resourceType', params.resourceType);
    if (params?.limit) sp.set('limit', String(params.limit));
    const q = sp.toString() ? `?${sp.toString()}` : '';
    return requestJson<{
      entries: AuditLogDTO[];
      total: number;
      verification: AuditChainVerification;
    }>(`/api/audit-logs${q}`);
  },

  listUsers: () => requestJson<{ users: PublicUser[] }>('/api/users'),
  createUser: (body: { email: string; displayName: string; role: UserRole; password: string }) =>
    requestJson<{ user: PublicUser }>('/api/users', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateUserRole: (id: string, body: { role?: UserRole; isActive?: boolean }) =>
    requestJson<{ user: PublicUser }>(`/api/users/${encodeURIComponent(id)}/role`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  // Milestone 2 — Arena
  listArenaTasks: (category?: ArenaCategory) => {
    const q = category ? `?category=${encodeURIComponent(category)}` : '';
    return requestJson<{ tasks: BenchmarkTaskDTO[] }>(`/api/arena/tasks${q}`);
  },
  createArenaTask: (body: {
    title: string;
    category: ArenaCategory;
    description: string;
    instructions: string;
    startingFiles: Record<string, string>;
    acceptanceChecks: AcceptanceCheckSpec[];
    timeLimitMs: number;
    tokenBudget: number;
    costCapUsd: number;
  }) =>
    requestJson<{ task: BenchmarkTaskDTO }>('/api/arena/tasks', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listCompetitions: (category?: ArenaCategory) => {
    const q = category ? `?category=${encodeURIComponent(category)}` : '';
    return requestJson<{ competitions: CompetitionDTO[] }>(`/api/arena/competitions${q}`);
  },
  getCompetitionDetail: (id: string) =>
    requestJson<CompetitionDetailDTO>(`/api/arena/competitions/${encodeURIComponent(id)}`),
  stageCompetition: (body: {
    title: string;
    taskId: string;
    contestantIds: string[];
    requestApproval?: boolean;
  }) =>
    requestJson<CompetitionDetailDTO>('/api/arena/competitions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  launchCompetition: (id: string) =>
    requestJson<CompetitionDetailDTO>(`/api/arena/competitions/${encodeURIComponent(id)}/launch`, {
      method: 'POST',
    }),
  getLeaderboard: (category?: ArenaCategory) => {
    const q = category ? `?category=${encodeURIComponent(category)}` : '';
    return requestJson<{ leaderboard: LeaderboardRowDTO[] }>(`/api/arena/leaderboard${q}`);
  },
  listObservations: (params?: { competitionId?: string; contestantId?: string }) => {
    const sp = new URLSearchParams();
    if (params?.competitionId) sp.set('competitionId', params.competitionId);
    if (params?.contestantId) sp.set('contestantId', params.contestantId);
    const q = sp.toString() ? `?${sp.toString()}` : '';
    return requestJson<{ observations: LearningObservationDTO[] }>(`/api/arena/observations${q}`);
  },
};
