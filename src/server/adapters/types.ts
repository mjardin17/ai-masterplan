import {
  AdapterType,
  ContestantKind,
  ContestantStatus,
} from '../../shared/types';

export interface AdapterHealthResult {
  status: Exclude<ContestantStatus, 'disabled'>;
  statusReason: string;
  checkedAt: string;
}

export interface ContestantAdapter {
  readonly id: string;
  readonly name: string;
  readonly kind: ContestantKind;
  readonly adapterType: AdapterType;
  readonly provider: string;
  readonly capabilities: string[];
  checkHealth(): Promise<AdapterHealthResult>;
}
