import type { StatusTone } from '@/components/StatusPill';
import { ApiError } from '@/lib/api';
import type {
  AssistantCitation,
  AssistantConfidence,
  AssistantRefusalReason,
  AssistantTurn,
  ChunkKind,
} from '@/lib/api-types';

export const MAX_QUESTION_CHARS = 500;

export const PRIVACY_NOTE = "Don't type customer details — use a customer ID instead.";

export const KIND_LABELS: Record<ChunkKind, string> = {
  customer: 'Customer',
  decision: 'Decision',
  mapping: 'Mapping',
  quality: 'Quality',
  sql: 'SQL',
  docs: 'Design doc',
};

export const MODE_LABELS: Record<'hybrid' | 'keyword', string> = {
  hybrid: 'Smart search',
  keyword: 'Keyword search',
};

export const CONFIDENCE: Record<AssistantConfidence, { tone: StatusTone; label: string }> = {
  high: { tone: 'high', label: 'High confidence' },
  medium: { tone: 'review', label: 'Medium confidence' },
  low: { tone: 'low', label: 'Low confidence' },
};

/** Friendly words for each refusal reason (ADR 0025); none of them is an error. */
export const REFUSAL_TEXT: Record<AssistantRefusalReason, string> = {
  personal_data: "I can't use customer details. Ask with a customer ID instead.",
  weak_retrieval:
    "I couldn't find enough in the project knowledge to answer that. Try naming a step, rule, column or customer ID.",
  not_answerable:
    "The project knowledge doesn't hold the answer to that. Try asking it a different way.",
  no_citation:
    "I couldn't back an answer with a project source, so I'm not showing one. Try a more specific question.",
};

export function refusalText(turn: AssistantTurn): string | null {
  if (turn.answerable && turn.refusalReason === null) return null;
  return turn.refusalReason ? REFUSAL_TEXT[turn.refusalReason] : REFUSAL_TEXT.not_answerable;
}

/** Example questions; the last names a real customer id when an earlier answer cited one. */
export function exampleQuestions(customerId: string | null): string[] {
  return [
    'Why did PIN completeness fail?',
    'How are duplicates found?',
    'Who approved the SQL?',
    customerId
      ? `Why were these records merged into ${customerId}?`
      : 'Why were these records merged into one customer?',
  ];
}

/** The first customer id cited by any turn (from a `matching` link), or null. */
export function citedCustomerId(turns: AssistantTurn[]): string | null {
  for (const turn of turns) {
    for (const citation of turn.citations) {
      const id = citation.link.params.customerId;
      if (citation.link.page === 'matching' && id) return id;
    }
  }
  return null;
}

const PAGE_LABELS: Record<string, string> = {
  matching: 'Matching',
  mapping: 'Mapping',
  pipeline: 'Pipeline',
  quality: 'Data quality',
  dashboard: 'Dashboard',
};

/**
 * Where a citation's "Open" link goes inside the app, or null for text only (design docs and
 * pages the app does not know). Only parameters a page reads are passed on.
 */
export function citationTarget(
  projectId: string,
  citation: AssistantCitation,
): { to: string; label: string } | null {
  const { page, params } = citation.link;
  const label = PAGE_LABELS[page];
  if (!label) return null;
  let to = `/projects/${encodeURIComponent(projectId)}/${page}`;
  if (page === 'mapping' && params.sourceId) {
    to += `?${new URLSearchParams({ source: params.sourceId }).toString()}`;
  }
  return { to, label };
}

export type AnswerPart = { kind: 'text'; text: string } | { kind: 'cite'; n: number };

const MARKER = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

/**
 * Splits an answer into text and citation markers (`[1]`, `[1, 2]`) so markers can become links
 * without injecting HTML. Numbers that name no citation stay as plain text.
 */
export function splitAnswer(text: string, known: ReadonlySet<number>): AnswerPart[] {
  const parts: AnswerPart[] = [];
  let last = 0;
  const pushText = (value: string) => {
    if (!value) return;
    const prev = parts.at(-1);
    if (prev?.kind === 'text') prev.text += value;
    else parts.push({ kind: 'text', text: value });
  };
  for (const match of text.matchAll(MARKER)) {
    const numbers = (match[1] ?? '').split(',').map((n) => Number(n.trim()));
    if (!numbers.every((n) => known.has(n))) continue;
    pushText(text.slice(last, match.index));
    for (const n of numbers) parts.push({ kind: 'cite', n });
    last = match.index + match[0].length;
  }
  pushText(text.slice(last));
  return parts;
}

/** Plain words for a failed question. */
export function askErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Please try again.';
  if (error.status === 0)
    return 'We could not reach the server. Check your connection and try again.';
  if (error.code === 'KNOWLEDGE_NOT_BUILT')
    return 'The project knowledge has not been built yet, so there is nothing to search.';
  if (error.status === 429) return 'Too many questions — wait a minute, then ask again.';
  if (error.status === 503)
    return 'The assistant is not available right now. Please try again in a few minutes.';
  if (error.status === 404) return 'This conversation no longer exists. Start a new one.';
  return error.message;
}
