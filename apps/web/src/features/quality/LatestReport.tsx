import { useId, useState } from 'react';

import { StatusPill } from '@/components/StatusPill';
import { TimeAgo } from '@/components/TimeAgo';
import { Button } from '@/components/ui/button';
import { formatCount } from '@/features/matching/matching-labels';
import type { QualityResult, QualityRun, QualityStatus } from '@/lib/api-types';

import {
  formatDuration,
  formatMetric,
  groupByKind,
  QUALITY_STATUS,
  thresholdText,
} from './quality-labels';

const COUNTED: QualityStatus[] = ['pass', 'warn', 'fail', 'skipped'];
const COUNT_LABELS: Record<QualityStatus, string> = {
  pass: 'Passed',
  warn: 'Warnings',
  fail: 'Failed',
  skipped: 'Skipped',
};

function ExampleIds({ result }: { result: QualityResult }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (result.exampleIds.length === 0) return <span className="text-muted-foreground">None</span>;
  return (
    <div className="space-y-1">
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`${open ? 'Hide' : 'Show'} example customer ids for ${result.label}${result.field ? ` (${result.field})` : ''}`}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {open ? 'Hide' : 'Show'} {result.exampleIds.length} example
        {result.exampleIds.length === 1 ? '' : 's'}
      </Button>
      {open && (
        <ul id={listId} aria-label="Example customer ids" className="font-mono text-xs">
          {result.exampleIds.map((id) => (
            <li key={id}>{id}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ResultRow({ result }: { result: QualityResult }) {
  const status = QUALITY_STATUS[result.status];
  return (
    <tr className="border-t align-top">
      <th scope="row" className="px-3 py-2.5 font-normal">
        <span className="font-medium">{result.label}</span>
        {result.field && (
          <span className="block font-mono text-xs text-muted-foreground">{result.field}</span>
        )}
      </th>
      <td className="px-3 py-2.5 tabular-nums">
        {result.status === 'skipped' ? (
          <span className="text-muted-foreground">Skipped: {result.message}</span>
        ) : result.metric === null ? (
          '—'
        ) : (
          formatMetric(result.metric, result.unit)
        )}
      </td>
      <td className="px-3 py-2.5 text-xs">
        {result.threshold
          ? thresholdText(result.threshold, result.direction, result.unit)
          : 'No threshold'}
      </td>
      <td className="px-3 py-2.5">
        <StatusPill tone={status.tone}>{status.label}</StatusPill>
      </td>
      <td className="px-3 py-2.5">
        <ExampleIds result={result} />
      </td>
    </tr>
  );
}

/** The newest report: overall status, where the data came from, and every rule by kind. */
export function LatestReport({ run }: { run: QualityRun }) {
  const overall = QUALITY_STATUS[run.status];
  return (
    <section aria-labelledby="latest-report" className="space-y-5 rounded-xl border px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="latest-report" className="text-base font-medium">
          Latest report
        </h2>
        <StatusPill tone={overall.tone}>Overall: {overall.label}</StatusPill>
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Checked</dt>
          <dd>{run.source.label}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Rows</dt>
          <dd className="tabular-nums">{formatCount(run.rowCount)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Finished</dt>
          <dd>
            <TimeAgo iso={run.finishedAt} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Run time</dt>
          <dd>{formatDuration(run.startedAt, run.finishedAt)}</dd>
        </div>
      </dl>
      {run.source.kind === 'sql_version' && !run.source.sqlTestsPassed && (
        <p className="text-sm text-muted-foreground">
          The SQL used did not pass all its tests
          {run.source.failedChecks.length ? ` (${run.source.failedChecks.join(', ')})` : ''}.
        </p>
      )}
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Rules by status">
        {COUNTED.map((status) => (
          <li key={status} className="rounded-xl border px-4 py-3">
            <p className="text-xs text-muted-foreground">{COUNT_LABELS[status]}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {formatCount(run.statusCounts[status])}
            </p>
          </li>
        ))}
      </ul>
      {groupByKind(run.results).map((group) => (
        <div key={group.kind} className="space-y-2">
          <h3 className="text-sm font-semibold">{group.kind}</h3>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">{group.kind} rules</caption>
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  {['Rule', 'Result', 'Threshold', 'Status', 'Example customer ids'].map((h) => (
                    <th key={h} scope="col" className="px-3 py-2.5 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {group.results.map((result) => (
                  <ResultRow key={`${result.rule}:${result.field ?? ''}`} result={result} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
}
