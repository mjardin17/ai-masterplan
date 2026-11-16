import crypto from 'node:crypto';
import {
  ApprovalActionType,
  ApprovalRequestDTO,
  ApprovalStatus,
} from '../../../shared/types';
import { redactSensitiveData } from '../../config/env';
import { DatabaseClient, SqlParam } from '../client';

interface ApprovalRow {
  id: string;
  action_type: ApprovalActionType;
  target_resource: string;
  summary: string;
  payload_json: string;
  status: ApprovalStatus;
  requested_by_user_id: string;
  requested_by_email: string | null;
  decided_by_user_id: string | null;
  decided_by_email: string | null;
  decision_note: string | null;
  created_at: string;
  decided_at: string | null;
  expires_at: string | null;
  [key: string]: unknown;
}

function toApprovalDTO(row: ApprovalRow): ApprovalRequestDTO {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    actionType: row.action_type,
    targetResource: row.target_resource,
    summary: row.summary,
    payload,
    status: row.status,
    requestedByUserId: row.requested_by_user_id,
    requestedByEmail: row.requested_by_email ?? undefined,
    decidedByUserId: row.decided_by_user_id,
    decidedByEmail: row.decided_by_email,
    decisionNote: row.decision_note,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    expiresAt: row.expires_at,
  };
}

export class ApprovalsRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: {
    actionType: ApprovalActionType;
    targetResource: string;
    summary: string;
    payload?: Record<string, unknown>;
    requestedByUserId: string;
    expiresAt?: string | null;
  }): Promise<ApprovalRequestDTO> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const sanitizedPayload = redactSensitiveData(input.payload ?? {}) as Record<string, unknown>;

    await this.db.execute(
      `INSERT INTO approval_requests (
        id, action_type, target_resource, summary, payload_json, status,
        requested_by_user_id, decided_by_user_id, decision_note,
        created_at, decided_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, 'pending', $6, NULL, NULL, $7, NULL, $8)`,
      [
        id,
        input.actionType,
        input.targetResource.trim(),
        input.summary.trim(),
        JSON.stringify(sanitizedPayload),
        input.requestedByUserId,
        now,
        input.expiresAt ?? null,
      ],
    );

    const created = await this.findById(id);
    if (!created) {
      throw new Error('Failed to load created approval request');
    }
    return created;
  }

  async findById(id: string): Promise<ApprovalRequestDTO | null> {
    const row = await this.db.queryOne<ApprovalRow>(
      `SELECT a.id, a.action_type, a.target_resource, a.summary, a.payload_json, a.status,
              a.requested_by_user_id, req_u.email AS requested_by_email,
              a.decided_by_user_id, dec_u.email AS decided_by_email,
              a.decision_note, a.created_at, a.decided_at, a.expires_at
       FROM approval_requests a
       LEFT JOIN users req_u ON req_u.id = a.requested_by_user_id
       LEFT JOIN users dec_u ON dec_u.id = a.decided_by_user_id
       WHERE a.id = $1`,
      [id],
    );
    return row ? toApprovalDTO(row) : null;
  }

  async list(options?: { status?: ApprovalStatus }): Promise<ApprovalRequestDTO[]> {
    const params: SqlParam[] = [];
    const whereSql = options?.status ? 'WHERE a.status = $1' : '';
    if (options?.status) {
      params.push(options.status);
    }

    const rows = await this.db.query<ApprovalRow>(
      `SELECT a.id, a.action_type, a.target_resource, a.summary, a.payload_json, a.status,
              a.requested_by_user_id, req_u.email AS requested_by_email,
              a.decided_by_user_id, dec_u.email AS decided_by_email,
              a.decision_note, a.created_at, a.decided_at, a.expires_at
       FROM approval_requests a
       LEFT JOIN users req_u ON req_u.id = a.requested_by_user_id
       LEFT JOIN users dec_u ON dec_u.id = a.decided_by_user_id
       ${whereSql}
       ORDER BY
         CASE WHEN a.status = 'pending' THEN 0 ELSE 1 END,
         a.created_at DESC`,
      params,
    );
    return rows.map(toApprovalDTO);
  }

  async countPending(): Promise<number> {
    const row = await this.db.queryOne<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM approval_requests WHERE status = 'pending'",
    );
    return Number(row?.cnt ?? 0);
  }

  async decide(input: {
    id: string;
    status: 'approved' | 'rejected' | 'expired';
    decidedByUserId: string;
    decisionNote: string;
  }): Promise<ApprovalRequestDTO | null> {
    const now = new Date().toISOString();
    const res = await this.db.execute(
      `UPDATE approval_requests
       SET status = $1, decided_by_user_id = $2, decision_note = $3, decided_at = $4
       WHERE id = $5 AND status = 'pending'`,
      [input.status, input.decidedByUserId, input.decisionNote.trim(), now, input.id],
    );
    if (Number(res.changes) === 0) {
      return null;
    }
    return this.findById(input.id);
  }
}
