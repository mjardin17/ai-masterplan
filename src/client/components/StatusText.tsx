import { AlertCircle, CheckCircle2, Clock, MinusCircle, XCircle } from 'lucide-react';
import { ApprovalStatus, ContestantStatus } from '../../shared/types';

export function ContestantStatusText({ status }: { status: ContestantStatus }) {
  switch (status) {
    case 'connected':
      return (
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 whitespace-nowrap">
          <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
          Connected
        </span>
      );
    case 'unconfigured':
      return (
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-700 whitespace-nowrap">
          <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          Unconfigured
        </span>
      );
    case 'error':
      return (
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-red-700 whitespace-nowrap">
          <XCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          Error
        </span>
      );
    case 'disabled':
      return (
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 whitespace-nowrap">
          <MinusCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          Disabled
        </span>
      );
  }
}

export function ApprovalStatusText({ status }: { status: ApprovalStatus }) {
  switch (status) {
    case 'approved':
      return (
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 whitespace-nowrap">
          <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
          Approved
        </span>
      );
    case 'pending':
      return (
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-700 whitespace-nowrap">
          <Clock className="w-4 h-4 shrink-0" aria-hidden="true" />
          Pending
        </span>
      );
    case 'rejected':
      return (
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-red-700 whitespace-nowrap">
          <XCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          Rejected
        </span>
      );
    case 'expired':
      return (
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 whitespace-nowrap">
          <MinusCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          Expired
        </span>
      );
  }
}

export function formatUtcTimestamp(iso: string | null): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}
