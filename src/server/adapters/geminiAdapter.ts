import { GoogleGenAI } from '@google/genai';
import { sanitizeErrorMessage } from '../config/env';
import { AdapterHealthResult, ContestantAdapter } from './types';

export interface GeminiModelsProbe {
  listModels: () => Promise<unknown>;
}

export class GeminiAdapter implements ContestantAdapter {
  public readonly id = 'gemini';
  public readonly name = 'Google Gemini';
  public readonly kind = 'foundation_model' as const;
  public readonly adapterType = 'api' as const;
  public readonly provider = 'Google';
  public readonly capabilities = [
    'reasoning',
    'coding',
    'structured_json',
    'multimodal',
    'search_grounding',
  ];

  private readonly getApiKey: () => string | null;
  private readonly probeFactory: (apiKey: string) => GeminiModelsProbe;

  constructor(options?: {
    getApiKey?: () => string | null;
    probeFactory?: (apiKey: string) => GeminiModelsProbe;
  }) {
    this.getApiKey =
      options?.getApiKey ?? (() => process.env.GEMINI_API_KEY?.trim() || null);
    this.probeFactory =
      options?.probeFactory ??
      ((apiKey: string) => {
        const ai = new GoogleGenAI({
          apiKey,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build',
            },
          },
        });
        return {
          listModels: () => ai.models.list({ config: { pageSize: 1 } }),
        };
      });
  }

  async checkHealth(): Promise<AdapterHealthResult> {
    const checkedAt = new Date().toISOString();
    const apiKey = this.getApiKey();

    if (!apiKey) {
      return {
        status: 'unconfigured',
        statusReason: 'GEMINI_API_KEY is not configured in server secrets.',
        checkedAt,
      };
    }

    try {
      const probe = this.probeFactory(apiKey);
      await Promise.race([
        probe.listModels(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Gemini API health probe timed out after 6000ms.')), 6000),
        ),
      ]);
      return {
        status: 'connected',
        statusReason:
          'Verified live Gemini API access via server-side metadata check (no paid generation executed).',
        checkedAt,
      };
    } catch (err) {
      return {
        status: 'error',
        statusReason: `Gemini API check failed: ${sanitizeErrorMessage(err)}`,
        checkedAt,
      };
    }
  }
}
