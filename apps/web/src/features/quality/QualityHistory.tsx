import { LoadFailed } from '@/components/LoadFailed';
import { StatusPill } from '@/components/StatusPill';
import { TimeAgo } from '@/components/TimeAgo';
import { Skeleton } from '@/components/ui/skeleton';
import type { QualityRunSummary } from '@/lib/api-types';

import { QUALITY_STATUS } from './quality-labels';
import { useQualityHistory } from './queries';

/** A small stacked bar of pass / warn / fail counts (the numbers are in the row as text). */
function TrendBar({ run }: { run: QualityRunSummary }) {
  const { pass, warn, fail } = run.statusCounts;
  const total = pass + warn + fail;
  if (total === 0) return null;
  const width = (n: number) => `${(100 * n) / total}%`;
  return (
    <div aria-hidden="true" className="flex h-2 w-32 overflow-hidden rounded-full bg-muted">
      <div className="bg-primary" style={{ width: width(pass) }} />
      <div className="bg-primary/40" style={{ width: width(warn) }} />
      <div className="bg-destructive" style={{ width: width(fail) }} />
    </div>
  );
}

/** Past reports, newest first, with their counts and a simple trend bar. */
export function QualityHistory({ projectId }: { projectId: string }) {
  const history = useQualityHistory(projectId);

  let body;
  if (history.isPending) {
    body = <Skeleton className="h-32 w-full" aria-label="Loading past reports" />;
  } else if (history.isError) {
    body = (
      <LoadFailed
        title="We could not load past reports"
        message={history.error.message}
        retry={() => void history.refetch()}
      />
    );
  } else if (history.data.items.length === 0) {
    body = <p className="text-sm text-muted-foreground">No past reports yet.</p>;
  } else {
    body = (
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Past quality reports</caption>
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              {['When', 'Overall', 'Passed', 'Warnings', 'Failed', 'Skipped', 'Trend'].map((h) => (
                <th key={h} scope="col" className="px-3 py-2.5 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {history.data.items.map((run) => {
              const status = QUALITY_STATUS[run.status];
              return (
                <tr key={run.id} className="border-t">
                  <th scope="row" className="px-3 py-2.5 font-normal">
                    <TimeAgo iso={run.finishedAt} />
                  </th>
                  <td className="px-3 py-2.5">
                    <StatusPill tone={status.tone}>{status.label}</StatusPill>
                  </td>
                  <td className="px-3 py-2.5 tabular-nums">{run.statusCounts.pass}</td>
                  <td className="px-3 py-2.5 tabular-nums">{run.statusCounts.warn}</td>
                  <td className="px-3 py-2.5 tabular-nums">{run.statusCounts.fail}</td>
                  <td className="px-3 py-2.5 tabular-nums">{run.statusCounts.skipped}</td>
                  <td className="px-3 py-2.5">
                    <TrendBar run={run} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <section aria-labelledby="quality-history" className="space-y-4 rounded-xl border px-5 py-4">
      <h2 id="quality-history" className="text-base font-medium">
        History
      </h2>
      {body}
    </section>
  );
}
