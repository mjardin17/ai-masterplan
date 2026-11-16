import { ContestantDTO, PublicUser } from '../../shared/types';
import { AuditRepository } from '../db/repositories/auditRepo';
import { ContestantsRepository } from '../db/repositories/contestantsRepo';
import { GeminiAdapter } from './geminiAdapter';
import { ContestantAdapter } from './types';
import { createPlaceholderRosterAdapters } from './unconfiguredAdapters';

export class ContestantRegistry {
  private readonly adaptersById = new Map<string, ContestantAdapter>();

  constructor(
    private readonly contestantsRepo: ContestantsRepository,
    private readonly auditRepo: AuditRepository,
    adapters?: ContestantAdapter[],
  ) {
    const list = adapters ?? [new GeminiAdapter(), ...createPlaceholderRosterAdapters()];
    for (const adapter of list) {
      this.adaptersById.set(adapter.id, adapter);
    }
  }

  async syncAll(): Promise<ContestantDTO[]> {
    const results: ContestantDTO[] = [];
    for (const adapter of this.adaptersById.values()) {
      const health = await adapter.checkHealth();
      const row = await this.contestantsRepo.upsertDefinition({
        id: adapter.id,
        name: adapter.name,
        kind: adapter.kind,
        adapterType: adapter.adapterType,
        provider: adapter.provider,
        capabilities: adapter.capabilities,
        status: health.status,
        statusReason: health.statusReason,
        lastCheckedAt: health.checkedAt,
      });
      results.push(row);
    }
    return this.contestantsRepo.listAll();
  }

  async runHealthCheck(id: string, actor?: PublicUser): Promise<ContestantDTO | null> {
    const existing = await this.contestantsRepo.findById(id);
    if (!existing) return null;

    const adapter = this.adaptersById.get(id);
    if (!adapter) {
      return existing;
    }

    if (!existing.isEnabled) {
      return existing;
    }

    const health = await adapter.checkHealth();
    const updated = await this.contestantsRepo.updateHealth(
      id,
      health.status,
      health.statusReason,
      health.checkedAt,
    );

    if (actor && updated) {
      await this.auditRepo.append({
        actorType: 'user',
        actorId: actor.id,
        actorRole: actor.role,
        action: 'contestant.health_checked',
        resourceType: 'contestant',
        resourceId: id,
        metadata: {
          status: updated.status,
          statusReason: updated.statusReason,
        },
      });
    }

    return updated;
  }

  async setEnabled(
    id: string,
    isEnabled: boolean,
    actor: PublicUser,
  ): Promise<ContestantDTO | null> {
    const toggled = await this.contestantsRepo.setEnabled(id, isEnabled);
    if (!toggled) return null;

    let finalRow = toggled;
    if (isEnabled) {
      const adapter = this.adaptersById.get(id);
      if (adapter) {
        const health = await adapter.checkHealth();
        const checked = await this.contestantsRepo.updateHealth(
          id,
          health.status,
          health.statusReason,
          health.checkedAt,
        );
        if (checked) {
          finalRow = checked;
        }
      }
    }

    await this.auditRepo.append({
      actorType: 'user',
      actorId: actor.id,
      actorRole: actor.role,
      action: isEnabled ? 'contestant.enabled' : 'contestant.disabled',
      resourceType: 'contestant',
      resourceId: id,
      metadata: {
        isEnabled: finalRow.isEnabled,
        status: finalRow.status,
      },
    });

    return finalRow;
  }
}
