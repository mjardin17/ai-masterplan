import { AdapterType, ContestantKind } from '../../shared/types';
import { AdapterHealthResult, ContestantAdapter } from './types';

export class UnconfiguredContestantAdapter implements ContestantAdapter {
  public readonly id: string;
  public readonly name: string;
  public readonly kind: ContestantKind;
  public readonly adapterType: AdapterType;
  public readonly provider: string;
  public readonly capabilities: string[];
  private readonly missingRequirement: string;

  constructor(spec: {
    id: string;
    name: string;
    kind: ContestantKind;
    adapterType: AdapterType;
    provider: string;
    capabilities: string[];
    missingRequirement: string;
  }) {
    this.id = spec.id;
    this.name = spec.name;
    this.kind = spec.kind;
    this.adapterType = spec.adapterType;
    this.provider = spec.provider;
    this.capabilities = spec.capabilities;
    this.missingRequirement = spec.missingRequirement;
  }

  async checkHealth(): Promise<AdapterHealthResult> {
    return {
      status: 'unconfigured',
      statusReason: this.missingRequirement,
      checkedAt: new Date().toISOString(),
    };
  }
}

export function createPlaceholderRosterAdapters(): ContestantAdapter[] {
  return [
    new UnconfiguredContestantAdapter({
      id: 'claude',
      name: 'Claude',
      kind: 'foundation_model',
      adapterType: 'api',
      provider: 'Anthropic',
      capabilities: ['coding', 'reasoning', 'security_review', 'long_context'],
      missingRequirement:
        'ANTHROPIC_API_KEY and Anthropic adapter integration are not configured yet (planned for Milestone 4).',
    }),
    new UnconfiguredContestantAdapter({
      id: 'openai-codex',
      name: 'ChatGPT / OpenAI Codex',
      kind: 'coding_agent',
      adapterType: 'api',
      provider: 'OpenAI',
      capabilities: ['coding', 'reasoning', 'debugging', 'tool_execution'],
      missingRequirement:
        'OPENAI_API_KEY and OpenAI/Codex adapter integration are not configured yet (planned for Milestone 4).',
    }),
    new UnconfiguredContestantAdapter({
      id: 'grok',
      name: 'Grok',
      kind: 'foundation_model',
      adapterType: 'api',
      provider: 'xAI',
      capabilities: ['reasoning', 'coding', 'real_time_analysis'],
      missingRequirement:
        'XAI_API_KEY and Grok adapter integration are not configured yet (planned for Milestone 4).',
    }),
    new UnconfiguredContestantAdapter({
      id: 'deepseek',
      name: 'DeepSeek',
      kind: 'foundation_model',
      adapterType: 'api',
      provider: 'DeepSeek',
      capabilities: ['coding', 'math_reasoning', 'debugging'],
      missingRequirement:
        'DEEPSEEK_API_KEY and DeepSeek adapter integration are not configured yet (planned for Milestone 4).',
    }),
    new UnconfiguredContestantAdapter({
      id: 'perplexity',
      name: 'Perplexity',
      kind: 'research_agent',
      adapterType: 'api',
      provider: 'Perplexity',
      capabilities: ['web_research', 'citation_discovery', 'source_verification'],
      missingRequirement:
        'PERPLEXITY_API_KEY and Perplexity adapter integration are not configured yet (planned for Milestone 4).',
    }),
    new UnconfiguredContestantAdapter({
      id: 'replit-agent',
      name: 'Replit Agent',
      kind: 'platform',
      adapterType: 'platform',
      provider: 'Replit',
      capabilities: ['full_stack_build', 'environment_provisioning', 'deployment'],
      missingRequirement:
        'Authorized Replit platform connector is not configured yet (planned for Milestone 4).',
    }),
    new UnconfiguredContestantAdapter({
      id: 'emergent',
      name: 'Emergent',
      kind: 'platform',
      adapterType: 'platform',
      provider: 'Emergent',
      capabilities: ['autonomous_app_build', 'multi_step_execution'],
      missingRequirement:
        'Authorized Emergent platform connector is not configured yet (planned for Milestone 4).',
    }),
  ];
}
