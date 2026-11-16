import {
  ArenaCategory,
  CompetitionEntryDTO,
  LearningObservationDTO,
  LearningObservationType,
  VerificationReportDTO,
} from '../../shared/types';
import { ArenaRepository } from '../db/repositories/arenaRepo';

export function classifyObservation(input: {
  entry: CompetitionEntryDTO;
  report: VerificationReportDTO;
}): {
  observationType: LearningObservationType;
  summary: string;
  details: Record<string, unknown>;
} {
  if (input.entry.status === 'timed_out' || input.entry.status === 'blocked') {
    return {
      observationType: 'blocker',
      summary: `Contestant ${input.entry.contestantId} encountered ${input.entry.status}: ${input.entry.errorMessage ?? 'execution blocked'}`,
      details: {
        entryStatus: input.entry.status,
        errorMessage: input.entry.errorMessage,
        executionTimeMs: input.entry.executionTimeMs,
        evidenceHash: input.report.evidenceHash,
      },
    };
  }

  if (input.entry.status === 'failed' || !input.report.passed) {
    const failedChecks = input.report.checks
      .filter((c) => !c.passed)
      .map((c) => `${c.label}: ${c.details}`);
    return {
      observationType: 'failure',
      summary: `Verification failed for ${input.entry.contestantId} (${failedChecks.length} failing checks, exit=${input.report.exitCode ?? 'null'})`,
      details: {
        entryStatus: input.entry.status,
        exitCode: input.report.exitCode,
        testsPassed: input.report.testsPassed,
        testsFailed: input.report.testsFailed,
        failedChecks,
        evidenceHash: input.report.evidenceHash,
      },
    };
  }

  return {
    observationType: 'success_pattern',
    summary: `Verified solution by ${input.entry.contestantId} passed all ${input.report.checks.length} checks (${input.report.testsPassed}/${input.report.testsTotal} tests)`,
    details: {
      modifiedFiles: input.report.diffSummary.modified,
      createdFiles: input.report.diffSummary.created,
      executionTimeMs: input.entry.executionTimeMs,
      evidenceHash: input.report.evidenceHash,
    },
  };
}

export class LearningObservationRecorder {
  constructor(private readonly arenaRepo: ArenaRepository) {}

  async recordFromVerification(input: {
    competitionId: string;
    category: ArenaCategory;
    entry: CompetitionEntryDTO;
    report: VerificationReportDTO;
  }): Promise<LearningObservationDTO> {
    const classified = classifyObservation({
      entry: input.entry,
      report: input.report,
    });
    return this.arenaRepo.createObservation({
      competitionId: input.competitionId,
      entryId: input.entry.id,
      contestantId: input.entry.contestantId,
      category: input.category,
      observationType: classified.observationType,
      summary: classified.summary,
      details: classified.details,
      evidenceReportId: input.report.id,
    });
  }
}
