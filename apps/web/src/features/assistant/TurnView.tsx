import { Info } from 'lucide-react';
import { Link } from 'react-router';

import { StatusPill } from '@/components/StatusPill';
import type { AssistantCitation, AssistantTurn } from '@/lib/api-types';

import {
  CONFIDENCE,
  KIND_LABELS,
  citationTarget,
  refusalText,
  splitAnswer,
} from './assistant-labels';

function CitationItem({
  projectId,
  citation,
  anchor,
}: {
  projectId: string;
  citation: AssistantCitation;
  anchor: string;
}) {
  const target = citationTarget(projectId, citation);
  const section = citation.link.page === 'docs' ? citation.link.params.section : undefined;
  return (
    <li id={anchor} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
      <span className="font-medium tabular-nums">[{citation.n}]</span>
      <StatusPill tone="neutral">{KIND_LABELS[citation.kind]}</StatusPill>
      <span>{citation.title}</span>
      {section && <span className="text-muted-foreground">· section {section}</span>}
      {target && (
        <Link
          to={target.to}
          className="rounded-sm text-primary underline underline-offset-4 hover:no-underline"
          aria-label={`Open source ${citation.n} in ${target.label}`}
        >
          Open in {target.label}
        </Link>
      )}
    </li>
  );
}

/** The answer text with each `[n]` marker as a link to its source below (no HTML injected). */
function AnswerText({ turn, anchorOf }: { turn: AssistantTurn; anchorOf: (n: number) => string }) {
  const known = new Set(turn.citations.map((c) => c.n));
  return (
    <p className="leading-relaxed whitespace-pre-line">
      {splitAnswer(turn.answer, known).map((part, i) =>
        part.kind === 'text' ? (
          <span key={i}>{part.text}</span>
        ) : (
          <a
            key={i}
            href={`#${anchorOf(part.n)}`}
            aria-label={`Source ${part.n}`}
            className="mx-0.5 rounded-sm align-super text-xs font-medium text-primary underline underline-offset-2"
          >
            [{part.n}]
          </a>
        ),
      )}
    </p>
  );
}

/** One question and its answer, refusal or sources. */
export function TurnView({
  projectId,
  turn,
  id,
}: {
  projectId: string;
  turn: AssistantTurn;
  /** Unique per turn on the page; prefixes the citation anchors. */
  id: string;
}) {
  const refusal = refusalText(turn);
  const anchorOf = (n: number) => `${id}-source-${n}`;
  return (
    <article aria-label="Question and answer" className="space-y-3">
      <div className="ml-auto w-fit max-w-[85%] rounded-xl bg-muted px-4 py-2 text-sm">
        <span className="sr-only">You asked: </span>
        {turn.question ?? (
          <span className="italic">Question hidden (it held customer details)</span>
        )}
      </div>
      {refusal ? (
        <div className="flex gap-2 rounded-xl border border-dashed px-4 py-3 text-sm">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="space-y-1">
            <p className="font-medium">Couldn&apos;t answer this one</p>
            <p>{refusal}</p>
          </div>
        </div>
      ) : (
        <div className="space-y-3 rounded-xl border px-4 py-3">
          <AnswerText turn={turn} anchorOf={anchorOf} />
          <StatusPill tone={CONFIDENCE[turn.confidence].tone}>
            {CONFIDENCE[turn.confidence].label}
          </StatusPill>
          {turn.citations.length > 0 && (
            <div className="space-y-1.5 border-t pt-3">
              <h3 className="text-xs font-medium text-muted-foreground">Sources</h3>
              <ol aria-label="Sources" className="space-y-1.5">
                {turn.citations.map((citation) => (
                  <CitationItem
                    key={citation.n}
                    projectId={projectId}
                    citation={citation}
                    anchor={anchorOf(citation.n)}
                  />
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
