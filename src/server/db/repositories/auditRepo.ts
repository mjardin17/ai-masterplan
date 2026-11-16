import crypto from 'node:crypto';
import {
  AuditActorType,
  AuditChainVerification,
  AuditLogDTO,
} from '../../../shared/types';
import { redactSensitiveData } from '../../config/env';
import { DatabaseClient, SqlParam } from '../client';

interface AuditRow {
  seq: number;
  id: string;
  actor_type: AuditActorType;
  actor_id: string;
  actor_role: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  metadata_json: string;
  prev_hash: string;
  entry_hash: string;
  created_at: string;
  [key: string]: unknown;
}

export function computeAuditEntryHash(input: {
  id: string;
  actorType: AuditActorType;
  actorId: string;
  actorRole: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  metadataJson: string;
  prevHash: string;
  createdAt: string;
}): string {
  const canonical = JSON.stringify([
    input.id,
    input.actorType,
    input.actorId,
    input.actorRole ?? '',
    input.action,
    input.resourceType,
    input.resourceId,
    input.metadataJson,
    input.prevHash,
    input.createdAt,
  ]);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function toAuditLogDTO(row: AuditRow): AuditLogDTO {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.metadata_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      metadata = parsed as Record<string, unknown>;
    }
  } catch {
    metadata = {};
  }
  return {
    seq: Number(row.seq),
    id: row.id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    metadata,
    prevHash: row.prev_hash,
    entryHash: row.entry_hash,
    createdAt: row.created_at,
  };
}

export class AuditRepository {
  constructor(private readonly db: DatabaseClient) {}

  async append(input: {
    actorType: AuditActorType;
    actorId: string;
    actorRole?: string | null;
    action: string;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  }): Promise<AuditLogDTO> {
    const sanitized = redactSensitiveData(input.metadata ?? {}) as Record<string, unknown>;
    const metadataJson = JSON.stringify(sanitized);
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const actorRole = input.actorRole ?? null;

    return this.db.transaction(async (tx) => {
      const last = await tx.queryOne<{ entry_hash: string }>(
        'SELECT entry_hash FROM audit_logs ORDER BY seq DESC LIMIT 1',
      );
      const prevHash = last?.entry_hash ?? 'GENESIS';
      const entryHash = computeAuditEntryHash({
        id,
        actorType: input.actorType,
        actorId: input.actorId,
        actorRole,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        metadataJson,
        prevHash,
        createdAt,
      });

      const res = await tx.execute(
        `INSERT INTO audit_logs (
          id, actor_type, actor_id, actor_role, action, resource_type,
          resource_id, metadata_json, prev_hash, entry_hash, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          input.actorType,
          input.actorId,
          actorRole,
          input.action,
          input.resourceType,
          input.resourceId,
          metadataJson,
          prevHash,
          entryHash,
          createdAt,
        ],
      );

      const inserted = await tx.queryOne<AuditRow>(
        `SELECT seq, id, actor_type, actor_id, actor_role, action, resource_type,
                resource_id, metadata_json, prev_hash, entry_hash, created_at
         FROM audit_logs WHERE seq = $1`,
        [Number(res.lastInsertRowid)],
      );
      if (!inserted) {
        throw new Error('Failed to load inserted audit log');
      }
      return toAuditLogDTO(inserted);
    });
  }

  async list(options?: {
    action?: string;
    resourceType?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ entries: AuditLogDTO[]; total: number }> {
    const where: string[] = [];
    const params: SqlParam[] = [];
    let idx = 1;

    if (options?.action) {
      where.push(`action LIKE $${idx++}`);
      params.push(`%${options.action.trim()}%`);
    }
    if (options?.resourceType) {
      where.push(`resource_type = $${idx++}`);
      params.push(options.resourceType.trim());
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const countRow = await this.db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM audit_logs ${whereSql}`,
      params,
    );
    const total = Number(countRow?.cnt ?? 0);

    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
    const offset = Math.max(options?.offset ?? 0, 0);

    const rows = await this.db.query<AuditRow>(
      `SELECT seq, id, actor_type, actor_id, actor_role, action, resource_type,
              resource_id, metadata_json, prev_hash, entry_hash, created_at
       FROM audit_logs ${whereSql}
       ORDER BY seq DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    );

    return {
      entries: rows.map(toAuditLogDTO),
      total,
    };
  }

  async verifyChain(): Promise<AuditChainVerification> {
    const rows = await this.db.query<AuditRow>(
      `SELECT seq, id, actor_type, actor_id, actor_role, action, resource_type,
              resource_id, metadata_json, prev_hash, entry_hash, created_at
       FROM audit_logs
       ORDER BY seq ASC`,
    );

    let expectedPrevHash = 'GENESIS';
    for (const row of rows) {
      if (row.prev_hash !== expectedPrevHash) {
        return {
          valid: false,
          totalEntries: rows.length,
          brokenAtSeq: Number(row.seq),
        };
      }
      const computed = computeAuditEntryHash({
        id: row.id,
        actorType: row.actor_type,
        actorId: row.actor_id,
        actorRole: row.actor_role,
        action: row.action,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        metadataJson: row.metadata_json,
        prevHash: row.prev_hash,
        createdAt: row.created_at,
      });
      if (computed !== row.entry_hash) {
        return {
          valid: false,
          totalEntries: rows.length,
          brokenAtSeq: Number(row.seq),
        };
      }
      expectedPrevHash = row.entry_hash;
    }

    return {
      valid: true,
      totalEntries: rows.length,
      brokenAtSeq: null,
    };
  }
}
