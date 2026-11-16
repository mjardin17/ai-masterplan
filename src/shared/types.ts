export type UserRole = 'admin' | 'operator' | 'reviewer' | 'viewer';

export type ContestantKind =
  | 'foundation_model'
  | 'coding_agent'
  | 'research_agent'
  | 'platform';

export type AdapterType = 'api' | 'cli' | 'platform';

export type ContestantStatus = 'connected' | 'unconfigured' | 'error' | 'disabled';

export type ApprovalActionType =
  | 'adapter_activation'
  | 'spend_cap_change'
  | 'permission_change'
  | 'external_write'
  | 'competition_budget';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export type AuditActorType = 'user' | 'system' | 'adapter';

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ContestantDTO {
  id: string;
  name: string;
  kind: ContestantKind;
  adapterType: AdapterType;
  provider: string;
  status: ContestantStatus;
  statusReason: string;
  capabilities: string[];
  isEnabled: boolean;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRequestDTO {
  id: string;
  actionType: ApprovalActionType;
  targetResource: string;
  summary: string;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  requestedByUserId: string;
  requestedByEmail?: string;
  decidedByUserId: string | null;
  decidedByEmail?: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string | null;
}

export interface AuditLogDTO {
  seq: number;
  id: string;
  actorType: AuditActorType;
  actorId: string;
  actorRole: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: Record<string, unknown>;
  prevHash: string;
  entryHash: string;
  createdAt: string;
}

export interface AuditChainVerification {
  valid: boolean;
  totalEntries: number;
  brokenAtSeq: number | null;
}

export interface HealthSummary {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  timestamp: string;
  database: {
    driver: 'sqlite' | 'postgres';
    connected: boolean;
    migrationVersion: string | null;
    pathLabel: string;
  };
  contestants: {
    total: number;
    connected: number;
    unconfigured: number;
    error: number;
    disabled: number;
  };
  approvals?: {
    pending: number;
  };
  audit?: AuditChainVerification;
}

export interface AuthStatusDTO {
  initialized: boolean;
  bootstrapAvailable: boolean;
  authenticated: boolean;
  user: PublicUser | null;
}

// ============================================================================
// Milestone 2 — Fair Competition Engine, Isolation, Verification & Scoring
// ============================================================================

export type ArenaCategory =
  | 'coding'
  | 'reasoning'
  | 'research'
  | 'debugging'
  | 'security'
  | 'recovery';

export type AcceptanceCheckType =
  | 'node_test'
  | 'file_exists'
  | 'text_contains'
  | 'text_not_contains'
  | 'security_scan';

export interface AcceptanceCheckSpec {
  id: string;
  label: string;
  type: AcceptanceCheckType;
  targetPath?: string;
  needle?: string;
}

export interface BenchmarkTaskDTO {
  id: string;
  title: string;
  category: ArenaCategory;
  description: string;
  instructions: string;
  startingFiles: Record<string, string>;
  acceptanceChecks: AcceptanceCheckSpec[];
  timeLimitMs: number;
  tokenBudget: number;
  costCapUsd: number;
  createdByUserId: string;
  createdByEmail?: string;
  createdAt: string;
  updatedAt: string;
}

export type CompetitionStatus =
  | 'draft'
  | 'awaiting_approval'
  | 'approved'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type CompetitionEntryStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'blocked';

export interface CompetitionDTO {
  id: string;
  title: string;
  taskId: string;
  taskTitle?: string;
  category: ArenaCategory;
  status: CompetitionStatus;
  approvalRequestId: string | null;
  approvalStatus?: ApprovalStatus | null;
  timeLimitMs: number;
  tokenBudget: number;
  costCapUsd: number;
  createdByUserId: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  entryCount?: number;
}

export interface FileDiffSummary {
  created: string[];
  modified: string[];
  deleted: string[];
  unchangedCount: number;
}

export interface CompetitionEntryDTO {
  id: string;
  competitionId: string;
  contestantId: string;
  contestantName?: string;
  contestantStatusSnapshot: ContestantStatus;
  workspacePath: string | null;
  status: CompetitionEntryStatus;
  isTestFixture: boolean;
  modifiedFiles: string[];
  executionTimeMs: number | null;
  tokensIn: number;
  tokensOut: number;
  estimatedCostUsd: number;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface CheckExecutionOutcome {
  checkId: string;
  label: string;
  type: AcceptanceCheckType;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  details: string;
}

export interface VerificationReportDTO {
  id: string;
  entryId: string;
  competitionId: string;
  contestantId: string;
  verifierId: string;
  passed: boolean;
  exitCode: number | null;
  testsPassed: number;
  testsFailed: number;
  testsTotal: number;
  checks: CheckExecutionOutcome[];
  stdoutExcerpt: string;
  stderrExcerpt: string;
  diffSummary: FileDiffSummary;
  evidenceHash: string;
  executionTimeMs: number;
  verifiedAt: string;
}

export interface CompetitionScoreDTO {
  id: string;
  entryId: string;
  competitionId: string;
  contestantId: string;
  category: ArenaCategory;
  verificationReportId: string;
  correctnessScore: number;
  reliabilityScore: number;
  speedScore: number;
  resourceScore: number;
  compositeScore: number;
  rawMetrics: Record<string, unknown>;
  scoringRuleVersion: string;
  isEligibleForLeaderboard: boolean;
  createdAt: string;
}

export type LearningObservationType =
  | 'success_pattern'
  | 'failure'
  | 'blocker'
  | 'correction';

export interface LearningObservationDTO {
  id: string;
  competitionId: string | null;
  entryId: string | null;
  contestantId: string;
  category: ArenaCategory;
  observationType: LearningObservationType;
  summary: string;
  details: Record<string, unknown>;
  evidenceReportId: string | null;
  promotionStatus: 'captured';
  createdAt: string;
}

export interface LeaderboardRowDTO {
  contestantId: string;
  contestantName: string;
  provider: string;
  status: ContestantStatus;
  runsCount: number;
  passedCount: number;
  passRate: number;
  avgCompositeScore: number;
  avgCorrectnessScore: number;
  avgReliabilityScore: number;
  avgSpeedScore: number;
  avgResourceScore: number;
  latestReportId: string;
  latestCompetitionId: string;
  lastVerifiedAt: string;
}

export interface CompetitionDetailDTO {
  competition: CompetitionDTO;
  task: BenchmarkTaskDTO;
  entries: CompetitionEntryDTO[];
  reports: VerificationReportDTO[];
  scores: CompetitionScoreDTO[];
  observations: LearningObservationDTO[];
}

