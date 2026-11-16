import {
  AdapterType,
  ContestantDTO,
  ContestantKind,
  ContestantStatus,
} from '../../../shared/types';
import { DatabaseClient } from '../client';

interface ContestantRow {
  id: string;
  name: string;
  kind: ContestantKind;
  adapter_type: AdapterType;
  provider: string;
  status: ContestantStatus;
  status_reason: string;
  capabilities_json: string;
  is_enabled: number;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

function toContestantDTO(row: ContestantRow): ContestantDTO {
  let capabilities: string[] = [];
  try {
    const parsed = JSON.parse(row.capabilities_json);
    if (Array.isArray(parsed)) {
      capabilities = parsed.map((c) => String(c));
    }
  } catch {
    capabilities = [];
  }
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    adapterType: row.adapter_type,
    provider: row.provider,
    status: row.status,
    statusReason: row.status_reason,
    capabilities,
    isEnabled: row.is_enabled === 1,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ContestantsRepository {
  constructor(private readonly db: DatabaseClient) {}

  async listAll(): Promise<ContestantDTO[]> {
    const rows = await this.db.query<ContestantRow>(
      `SELECT id, name, kind, adapter_type, provider, status, status_reason,
              capabilities_json, is_enabled, last_checked_at, created_at, updated_at
       FROM contestants
       ORDER BY
         CASE id
           WHEN 'gemini' THEN 1
           WHEN 'claude' THEN 2
           WHEN 'openai-codex' THEN 3
           WHEN 'grok' THEN 4
           WHEN 'deepseek' THEN 5
           WHEN 'perplexity' THEN 6
           WHEN 'replit-agent' THEN 7
           WHEN 'emergent' THEN 8
           ELSE 99
         END, name ASC`,
    );
    return rows.map(toContestantDTO);
  }

  async findById(id: string): Promise<ContestantDTO | null> {
    const row = await this.db.queryOne<ContestantRow>(
      `SELECT id, name, kind, adapter_type, provider, status, status_reason,
              capabilities_json, is_enabled, last_checked_at, created_at, updated_at
       FROM contestants WHERE id = $1`,
      [id],
    );
    return row ? toContestantDTO(row) : null;
  }

  async upsertDefinition(input: {
    id: string;
    name: string;
    kind: ContestantKind;
    adapterType: AdapterType;
    provider: string;
    capabilities: string[];
    status: ContestantStatus;
    statusReason: string;
    lastCheckedAt: string | null;
  }): Promise<ContestantDTO> {
    const existing = await this.findById(input.id);
    const now = new Date().toISOString();

    if (!existing) {
      await this.db.execute(
        `INSERT INTO contestants (
          id, name, kind, adapter_type, provider, status, status_reason,
          capabilities_json, is_enabled, last_checked_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $11)`,
        [
          input.id,
          input.name,
          input.kind,
          input.adapterType,
          input.provider,
          input.status,
          input.statusReason,
          JSON.stringify(input.capabilities),
          input.lastCheckedAt,
          now,
          now,
        ],
      );
    } else {
      const nextStatus: ContestantStatus = existing.isEnabled ? input.status : 'disabled';
      const nextReason = existing.isEnabled
        ? input.statusReason
        : 'Manually disabled by administrator.';
      await this.db.execute(
        `UPDATE contestants
         SET name = $1, kind = $2, adapter_type = $3, provider = $4,
             capabilities_json = $5, status = $6, status_reason = $7,
             last_checked_at = $8, updated_at = $9
         WHERE id = $10`,
        [
          input.name,
          input.kind,
          input.adapterType,
          input.provider,
          JSON.stringify(input.capabilities),
          nextStatus,
          nextReason,
          input.lastCheckedAt,
          now,
          input.id,
        ],
      );
    }

    const updated = await this.findById(input.id);
    if (!updated) {
      throw new Error(`Failed to persist contestant ${input.id}`);
    }
    return updated;
  }

  async updateHealth(
    id: string,
    status: ContestantStatus,
    statusReason: string,
    checkedAt: string,
  ): Promise<ContestantDTO | null> {
    const existing = await this.findById(id);
    if (!existing) return null;

    const effectiveStatus: ContestantStatus = existing.isEnabled ? status : 'disabled';
    const effectiveReason = existing.isEnabled
      ? statusReason
      : 'Manually disabled by administrator.';

    await this.db.execute(
      `UPDATE contestants
       SET status = $1, status_reason = $2, last_checked_at = $3, updated_at = $4
       WHERE id = $5`,
      [effectiveStatus, effectiveReason, checkedAt, new Date().toISOString(), id],
    );
    return this.findById(id);
  }

  async setEnabled(
    id: string,
    isEnabled: boolean,
    reasonIfDisabled = 'Manually disabled by administrator.',
  ): Promise<ContestantDTO | null> {
    const existing = await this.findById(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const nextStatus: ContestantStatus = isEnabled ? 'unconfigured' : 'disabled';
    const nextReason = isEnabled
      ? 'Re-enabled; run health check to verify adapter connection.'
      : reasonIfDisabled;

    await this.db.execute(
      `UPDATE contestants
       SET is_enabled = $1, status = $2, status_reason = $3, updated_at = $4
       WHERE id = $5`,
      [isEnabled ? 1 : 0, nextStatus, nextReason, now, id],
    );
    return this.findById(id);
  }
}
