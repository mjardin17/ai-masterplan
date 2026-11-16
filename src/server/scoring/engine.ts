import {
  ArenaCategory,
  CompetitionEntryStatus,
  ContestantStatus,
  VerificationReportDTO,
} from '../../shared/types';

export const SCORING_RULE_VERSION = 'm2.v1';

export interface CategoryWeights {
  correctness: number;
  reliability: number;
  speed: number;
  resource: number;
}

export const CATEGORY_WEIGHTS: Record<ArenaCategory, CategoryWeights> = {
  coding: { correctness: 0.5, reliability: 0.25, speed: 0.15, resource: 0.1 },
  reasoning: { correctness: 0.6, reliability: 0.2, speed: 0.1, resource: 0.1 },
  research: { correctness: 0.55, reliability: 0.25, speed: 0.1, resource: 0.1 },
  debugging: { correctness: 0.5, reliability: 0.3, speed: 0.15, resource: 0.05 },
  security: { correctness: 0.6, reliability: 0.3, speed: 0.05, resource: 0.05 },
  recovery: { correctness: 0.45, reliability: 0.35, speed: 0.1, resource: 0.1 },
};

export interface ScoreComputationResult {
  correctnessScore: number;
  reliabilityScore: number;
  speedScore: number;
  resourceScore: number;
  compositeScore: number;
  rawMetrics: Record<string, unknown>;
  scoringRuleVersion: string;
  isEligibleForLeaderboard: boolean;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp100(n: number): number {
  return Math.min(100, Math.max(0, n));
}

export function calculateEntryScore(input: {
  category: ArenaCategory;
  entryStatus: CompetitionEntryStatus;
  contestantStatus: ContestantStatus;
  isTestFixture: boolean;
  executionTimeMs: number;
  timeLimitMs: number;
  tokensUsed: number;
  tokenBudget: number;
  estimatedCostUsd: number;
  costCapUsd: number;
  report: Pick<
    VerificationReportDTO,
    'passed' | 'exitCode' | 'testsPassed' | 'testsTotal' | 'checks'
  >;
}): ScoreComputationResult {
  const weights = CATEGORY_WEIGHTS[input.category];

  // 1. Correctness: derived strictly from independent verification checks & test pass rate
  let correctnessScore = 0;
  if (input.entryStatus === 'completed') {
    const totalChecks = input.report.checks.length;
    const passedChecks = input.report.checks.filter((c) => c.passed).length;
    const checkRatio = totalChecks > 0 ? passedChecks / totalChecks : 0;

    if (input.report.testsTotal > 0) {
      const testRatio = input.report.testsPassed / input.report.testsTotal;
      correctnessScore = clamp100(((testRatio * 0.7) + (checkRatio * 0.3)) * 100);
      if (input.report.passed) {
        correctnessScore = 100;
      }
    } else {
      correctnessScore = clamp100(checkRatio * 100);
    }
  }

  // 2. Reliability: completed cleanly + verification pass / exit code
  let reliabilityScore = 0;
  if (input.entryStatus === 'completed') {
    if (input.report.passed && input.report.exitCode === 0) {
      reliabilityScore = 100;
    } else if (input.report.checks.some((c) => c.passed)) {
      reliabilityScore = 40;
    } else {
      reliabilityScore = 10;
    }
  }

  // 3. Speed: 100 if <= 25% of time limit; linear decay to 0 at >= timeLimitMs (0 if not completed)
  let speedScore = 0;
  if (input.entryStatus === 'completed' && input.timeLimitMs > 0) {
    const ratio = input.executionTimeMs / input.timeLimitMs;
    if (ratio <= 0.25) {
      speedScore = 100;
    } else if (ratio >= 1) {
      speedScore = 0;
    } else {
      speedScore = clamp100(((1 - ratio) / 0.75) * 100);
    }
  }

  // 4. Resource consumption: evaluates token & cost efficiency against budget
  let resourceScore = 0;
  if (input.entryStatus === 'completed') {
    const tokenRatio =
      input.tokenBudget > 0 ? input.tokensUsed / input.tokenBudget : 0;
    const costRatio =
      input.costCapUsd > 0 ? input.estimatedCostUsd / input.costCapUsd : 0;
    const worstRatio = Math.max(tokenRatio, costRatio);
    if (worstRatio <= 0.25) {
      resourceScore = 100;
    } else if (worstRatio >= 1) {
      resourceScore = 0;
    } else {
      resourceScore = clamp100(((1 - worstRatio) / 0.75) * 100);
    }
  }

  const composite =
    correctnessScore * weights.correctness +
    reliabilityScore * weights.reliability +
    speedScore * weights.speed +
    resourceScore * weights.resource;

  const isEligibleForLeaderboard =
    input.contestantStatus === 'connected' && !input.isTestFixture;

  return {
    correctnessScore: round2(correctnessScore),
    reliabilityScore: round2(reliabilityScore),
    speedScore: round2(speedScore),
    resourceScore: round2(resourceScore),
    compositeScore: round2(composite),
    rawMetrics: {
      entryStatus: input.entryStatus,
      executionTimeMs: input.executionTimeMs,
      timeLimitMs: input.timeLimitMs,
      tokensUsed: input.tokensUsed,
      tokenBudget: input.tokenBudget,
      estimatedCostUsd: input.estimatedCostUsd,
      costCapUsd: input.costCapUsd,
      testsPassed: input.report.testsPassed,
      testsTotal: input.report.testsTotal,
      exitCode: input.report.exitCode,
      weights,
    },
    scoringRuleVersion: SCORING_RULE_VERSION,
    isEligibleForLeaderboard,
  };
}
