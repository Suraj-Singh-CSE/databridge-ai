import type { StatusTone } from '@/components/StatusPill';
import { CONFIDENCE_TONES, confidenceText } from '@/features/mapping/mapping-labels';
import { ApiError } from '@/lib/api';
import type {
  CandidateRecord,
  ClusterFlag,
  ClusterStatus,
  LinkKind,
  ScoreBand,
  ScoreSummary,
  Source,
  SurvivorshipRule,
} from '@/lib/api-types';

export type StepState = 'done' | 'outdated' | 'not_run';

export const STEP_STATES: Record<StepState, { label: string; tone: StatusTone }> = {
  done: { label: 'Done', tone: 'high' },
  outdated: { label: 'Out of date', tone: 'review' },
  not_run: { label: 'Not run', tone: 'neutral' },
};

export function stepState(view: { outdated: boolean } | null): StepState {
  if (!view) return 'not_run';
  return view.outdated ? 'outdated' : 'done';
}

/** A source's cleaning: re-profiling after a clean puts it back to `profiled` (outdated). */
export function cleanState(source: Source): StepState {
  if (source.status === 'standardised') return 'done';
  return source.standardisation ? 'outdated' : 'not_run';
}

export function canClean(source: Source): boolean {
  return source.status === 'profiled' || source.status === 'standardised';
}

export function bandCount(summary: ScoreSummary, band: ScoreBand): number {
  return summary.bandCounts.find((b) => b.band === band)?.count ?? 0;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function plural(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

export const STATUS_LABELS: Record<ClusterStatus, string> = {
  proposed: 'Proposed',
  approved: 'Approved',
  rejected: 'Rejected',
};

export const FLAG_LABELS: Record<ClusterFlag, string> = {
  needs_review: 'Needs review',
  different_people: 'May be different people',
  conflicting_evidence: 'Conflicting evidence',
  too_large: 'Too large',
};

export const LINK_KIND_LABELS: Record<LinkKind, string> = {
  match: 'Match by score',
  ai_suggested: 'AI suggested',
  human: 'Decided by a person',
};

export const RULE_LABELS: Record<SurvivorshipRule, string> = {
  only_value: 'only value',
  most_frequent: 'most frequent',
  most_complete: 'most complete',
  most_typical: 'most typical',
  source_trust: 'most trusted source',
  most_recent: 'most recent',
  row_order: 'first uploaded',
};

/** "High · 97%", or "Single record" when there is nothing to be confident about. */
export function clusterConfidence(cluster: {
  size: number;
  confidence: number | null;
  label: 'High' | 'Medium' | 'Low' | null;
}): { text: string; tone: StatusTone } {
  if (cluster.size < 2 || cluster.confidence === null || cluster.label === null) {
    return { text: 'Single record', tone: 'neutral' };
  }
  return {
    text: confidenceText(cluster.label, cluster.confidence),
    tone: CONFIDENCE_TONES[cluster.label],
  };
}

/** "CRM row 12": where a member record comes from. */
export function recordLabel(record: CandidateRecord): string {
  return `${record.sourceName} row ${record.rowNumber}`;
}

/** Customer ids are `C` + 12-20 upper-case hex characters (apps/api cluster.schemas.ts). */
export const CUSTOMER_ID_PATTERN = /^C[0-9A-F]{12,20}$/;

/** What to do about a 409 from POST /jobs, as `details.reason` says (apps/api job.service.ts). */
export type BlockedLink = 'mapping' | 'sources' | null;

export interface JobErrorText {
  text: string;
  link: BlockedLink;
}

const REASON_TEXT: Record<string, JobErrorText> = {
  MAPPING_NOT_RUN: {
    text: 'This file has no reviewed mapping yet. Run and review its mapping first.',
    link: 'mapping',
  },
  MAPPING_NOT_APPROVED: {
    text: 'Some columns of this file still need a mapping decision. Finish the mapping first.',
    link: 'mapping',
  },
  DECISION_OUTDATED: {
    text: 'The mapping changed after it was reviewed. Review the changed columns again.',
    link: 'mapping',
  },
  SOURCE_NOT_PROFILED: { text: 'Profile this file first.', link: 'sources' },
  NO_STANDARDISED_SOURCES: {
    text: 'Clean at least one file first (step 1).',
    link: null,
  },
  CANDIDATES_NOT_RUN: { text: 'Find possible duplicates first (step 2).', link: null },
  CANDIDATES_OUTDATED: {
    text: 'The possible duplicates are out of date. Re-run step 2 first.',
    link: null,
  },
  SCORES_NOT_RUN: { text: 'Score the pairs first (step 3).', link: null },
  SCORES_OUTDATED: {
    text: 'The scores are out of date. Re-run step 3 first.',
    link: null,
  },
  NO_MAYBE_PAIRS: {
    text: 'There are no unclear pairs to review: every pair was decided by its score.',
    link: null,
  },
};

function reasonOf(details: unknown): string | null {
  if (typeof details !== 'object' || details === null || !('reason' in details)) return null;
  return typeof details.reason === 'string' ? details.reason : null;
}

/** Plain-language text for a failed start or cancel; the api's own message when no better one. */
export function jobErrorText(error: unknown): JobErrorText {
  if (!(error instanceof ApiError)) {
    return { text: 'Something went wrong. Please try again.', link: null };
  }
  if (error.status === 403) {
    return { text: 'You do not have permission to do this in this project.', link: null };
  }
  const reason = reasonOf(error.details);
  const known = reason ? REASON_TEXT[reason] : undefined;
  if (known) return known;
  // STANDARDISATION_OUTDATED names the files; *_RUNNING says what to wait for.
  return { text: error.message, link: null };
}

/** The review state of a customer: approved, proposed, or proposed after its approval broke. */
export function reviewStatus(cluster: { status: ClusterStatus; membershipChanged: boolean }): {
  text: string;
  tone: StatusTone;
} {
  if (cluster.status === 'approved') return { text: 'Approved', tone: 'high' };
  if (cluster.membershipChanged) return { text: 'Membership changed', tone: 'review' };
  return { text: STATUS_LABELS[cluster.status], tone: 'neutral' };
}

export const BAND_LABELS: Record<ScoreBand, string> = {
  match: 'Match',
  maybe: 'Maybe',
  non_match: 'Not a match',
};

export const AI_DECISION_LABELS: Record<'same' | 'different' | 'unsure', string> = {
  same: 'AI says same person',
  different: 'AI says different people',
  unsure: 'AI is unsure',
};

/** "Approved 3 groups. 1 was already approved." */
export function approveHighSummary({
  approved,
  alreadyApproved,
}: {
  approved: number;
  alreadyApproved: number;
}): string {
  const parts = [`Approved ${plural(approved, 'group', 'groups')}.`];
  if (alreadyApproved > 0) {
    parts.push(
      `${formatCount(alreadyApproved)} ${alreadyApproved === 1 ? 'was' : 'were'} already approved.`,
    );
  }
  return parts.join(' ');
}
