import {
  ApprovalActionType,
  ApprovalRequestDTO,
  ApprovalStatus,
  PublicUser,
} from '../../shared/types';
import { ApprovalsRepository } from '../db/repositories/approvalsRepo';
import { AuditRepository } from '../db/repositories/auditRepo';
import { UsersRepository } from '../db/repositories/usersRepo';

export class ApprovalServiceError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const VALID_ACTION_TYPES: ApprovalActionType[] = [
  'adapter_activation',
  'spend_cap_change',
  'permission_change',
  'external_write',
  'competition_budget',
];

export class ApprovalsService {
  constructor(
    private readonly approvalsRepo: ApprovalsRepository,
    private readonly usersRepo: UsersRepository,
    private readonly auditRepo: AuditRepository,
  ) {}

  async list(status?: ApprovalStatus): Promise<ApprovalRequestDTO[]> {
    return this.approvalsRepo.list(status ? { status } : undefined);
  }

  async createRequest(
    actor: PublicUser,
    input: {
      actionType: ApprovalActionType;
      targetResource: string;
      summary: string;
      payload?: Record<string, unknown>;
      expiresAt?: string | null;
    },
  ): Promise<ApprovalRequestDTO> {
    if (!VALID_ACTION_TYPES.includes(input.actionType)) {
      throw new ApprovalServiceError(400, `Unsupported approval actionType: ${input.actionType}`);
    }
    if (!input.targetResource || input.targetResource.trim().length < 2) {
      throw new ApprovalServiceError(400, 'targetResource is required.');
    }
    if (!input.summary || input.summary.trim().length < 5) {
      throw new ApprovalServiceError(400, 'summary must be at least 5 characters.');
    }

    const created = await this.approvalsRepo.create({
      actionType: input.actionType,
      targetResource: input.targetResource,
      summary: input.summary,
      payload: input.payload,
      requestedByUserId: actor.id,
      expiresAt: input.expiresAt,
    });

    await this.auditRepo.append({
      actorType: 'user',
      actorId: actor.id,
      actorRole: actor.role,
      action: 'approval.requested',
      resourceType: 'approval_request',
      resourceId: created.id,
      metadata: {
        actionType: created.actionType,
        targetResource: created.targetResource,
        summary: created.summary,
      },
    });

    return created;
  }

  async decideRequest(
    actor: PublicUser,
    input: {
      id: string;
      decision: 'approved' | 'rejected';
      decisionNote: string;
    },
  ): Promise<ApprovalRequestDTO> {
    if (actor.role !== 'admin' && actor.role !== 'reviewer') {
      throw new ApprovalServiceError(403, 'Only admin or reviewer roles can decide approvals.');
    }
    if (input.decision !== 'approved' && input.decision !== 'rejected') {
      throw new ApprovalServiceError(400, 'decision must be approved or rejected.');
    }
    if (!input.decisionNote || input.decisionNote.trim().length < 3) {
      throw new ApprovalServiceError(400, 'decisionNote must be at least 3 characters.');
    }

    const existing = await this.approvalsRepo.findById(input.id);
    if (!existing) {
      throw new ApprovalServiceError(404, 'Approval request not found.');
    }
    if (existing.status !== 'pending') {
      throw new ApprovalServiceError(
        409,
        `Approval request is already ${existing.status} and cannot be modified.`,
      );
    }

    let singleAdminBootstrapOverride = false;
    if (existing.requestedByUserId === actor.id) {
      const reviewerCount = await this.usersRepo.countActiveByRoles(['admin', 'reviewer']);
      if (reviewerCount > 1 || actor.role !== 'admin') {
        throw new ApprovalServiceError(
          403,
          'Segregation of duties violation: requester cannot decide their own approval request.',
        );
      }
      singleAdminBootstrapOverride = true;
    }

    const decided = await this.approvalsRepo.decide({
      id: input.id,
      status: input.decision,
      decidedByUserId: actor.id,
      decisionNote: input.decisionNote,
    });
    if (!decided) {
      throw new ApprovalServiceError(409, 'Approval request was already decided.');
    }

    await this.auditRepo.append({
      actorType: 'user',
      actorId: actor.id,
      actorRole: actor.role,
      action: input.decision === 'approved' ? 'approval.approved' : 'approval.rejected',
      resourceType: 'approval_request',
      resourceId: decided.id,
      metadata: {
        actionType: decided.actionType,
        targetResource: decided.targetResource,
        decisionNote: decided.decisionNote,
        singleAdminBootstrapOverride,
      },
    });

    return decided;
  }
}
