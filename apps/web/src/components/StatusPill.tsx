import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type StatusTone = 'high' | 'review' | 'low';

/**
 * Confidence/status pill. The only non-token colours in the app (CLAUDE.md rule 10), always with
 * a text label so colour is never the only signal.
 */
const TONES: Record<StatusTone, string> = {
  high: 'bg-[#DCFCE7] text-[#15803D]',
  review: 'bg-[#FEF3C7] text-[#B45309]',
  low: 'bg-[#FEE2E2] text-[#B91C1C]',
};

export function StatusPill({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}
