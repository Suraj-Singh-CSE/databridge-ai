import { StatusPill } from '@/components/StatusPill';
import { QUALITY_STATUS } from '@/features/quality/quality-labels';
import { formatDateTime } from '@/lib/relative-time';
import type { DashboardQuality, QualityStatus } from '@/lib/api-types';

import { formatCount } from './dashboard-labels';
import { DashboardSection, DataTable } from './DashboardSection';

type Run = DashboardQuality['runs'][number];

const STATUS_ORDER: QualityStatus[] = ['pass', 'warn', 'fail', 'skipped'];

/** The quality history bar, upright: pass / warn / fail shares of one run (numbers in the table). */
function RunBar({ run }: { run: Run }) {
  const total = run.pass + run.warn + run.fail;
  const height = (n: number) => `${total === 0 ? 0 : (100 * n) / total}%`;
  return (
    <div className="flex h-full max-w-6 flex-1 flex-col-reverse overflow-hidden rounded-sm bg-muted">
      <div className="bg-primary" style={{ height: height(run.pass) }} />
      <div className="bg-primary/40" style={{ height: height(run.warn) }} />
      <div className="bg-destructive" style={{ height: height(run.fail) }} />
    </div>
  );
}

function trendSummary(runs: Run[]): string {
  const first = runs[0];
  const last = runs[runs.length - 1];
  if (!first || !last) return 'No quality checks in this period.';
  return `${runs.length} quality checks in this period. First: ${first.pass} passed, ${first.warn} warnings, ${first.fail} failed. Latest: ${last.pass} passed, ${last.warn} warnings, ${last.fail} failed.`;
}

/** Latest per-rule statuses and the pass / warn / fail trend over the runs in the range. */
export function QualitySection({ quality }: { quality: DashboardQuality }) {
  const counts = Object.fromEntries(
    STATUS_ORDER.map((s) => [s, quality.latestRules.filter((r) => r.status === s).length]),
  ) as Record<QualityStatus, number>;

  return (
    <DashboardSection
      id="dashboard-quality"
      title="Data quality"
      description="Rule results of the latest check and how they changed over the checks in this period."
    >
      {quality.latestRules.length === 0 ? (
        <p className="text-sm text-muted-foreground">No quality check has run yet.</p>
      ) : (
        <>
          <ul aria-label="Latest rules by status" className="flex flex-wrap gap-2">
            {STATUS_ORDER.map((s) => (
              <li key={s}>
                <StatusPill tone={QUALITY_STATUS[s].tone}>
                  {QUALITY_STATUS[s].label}: {formatCount(counts[s])}
                </StatusPill>
              </li>
            ))}
          </ul>
          <DataTable
            caption="Latest rule results"
            headers={['Rule', 'Field', 'Result']}
            rows={quality.latestRules.map((r) => ({
              key: `${r.rule}:${r.field ?? ''}`,
              cells: [
                r.label,
                r.field ?? '—',
                <StatusPill key="s" tone={QUALITY_STATUS[r.status].tone}>
                  {QUALITY_STATUS[r.status].label}
                </StatusPill>,
              ],
            }))}
          />
        </>
      )}
      {quality.runs.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Trend over checks</h3>
          <div role="img" aria-label={trendSummary(quality.runs)} className="flex h-24 gap-1">
            {quality.runs.map((run) => (
              <RunBar key={run.at} run={run} />
            ))}
          </div>
          <DataTable
            caption="Quality checks in this period"
            className="sr-only"
            headers={['When', 'Overall', 'Passed', 'Warnings', 'Failed']}
            rows={quality.runs.map((run) => ({
              key: run.at,
              cells: [
                formatDateTime(run.at),
                QUALITY_STATUS[run.status].label,
                run.pass,
                run.warn,
                run.fail,
              ],
            }))}
          />
          <p className="text-xs text-muted-foreground">
            Oldest on the left. Dark: passed, light: warnings, red: failed.
          </p>
        </div>
      )}
    </DashboardSection>
  );
}
