import type { DashboardAi } from '@/lib/api-types';

import { aiTaskLabel, formatCost, formatCount, formatDuration } from './dashboard-labels';
import { DashboardSection, DataTable, Stat } from './DashboardSection';

type Day = DashboardAi['daily'][number];

function dailySummary(days: Day[]): string {
  const calls = days.reduce((sum, d) => sum + d.calls, 0);
  const busiest = days.reduce<Day | null>(
    (top, d) => (top && top.calls >= d.calls ? top : d),
    null,
  );
  if (calls === 0 || !busiest) return `No AI calls in the ${days.length} days shown.`;
  return `${formatCount(calls)} AI calls over ${days.length} days; the busiest day was ${busiest.date} with ${formatCount(busiest.calls)} calls.`;
}

/** Calls per UTC day as simple bars (theme colours), with the numbers in a hidden table. */
function DailyCalls({ days }: { days: Day[] }) {
  const max = Math.max(1, ...days.map((d) => d.calls));
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">AI calls per day</h3>
      <div role="img" aria-label={dailySummary(days)} className="flex h-24 items-end gap-px">
        {days.map((d) => (
          <div
            key={d.date}
            className="flex-1 rounded-t-sm bg-primary"
            style={{ height: `${(100 * d.calls) / max}%` }}
          />
        ))}
      </div>
      <DataTable
        caption="AI calls, tokens and cost per day"
        className="sr-only"
        headers={['Day', 'Calls', 'Tokens', 'Cost']}
        rows={days.map((d) => ({
          key: d.date,
          cells: [d.date, formatCount(d.calls), formatCount(d.tokens), formatCost(d.costInr)],
        }))}
      />
    </div>
  );
}

/** The reset moment in the reader's own time, e.g. "1:30 pm". */
function resetTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** What the AI did in the range and what it cost (from the gateway's call log). */
export function AiUsageSection({ ai }: { ai: DashboardAi }) {
  const t = ai.total;
  const fallbacks =
    ai.fallbacks.mappingSourcesOnRules +
    ai.fallbacks.sqlReferenceVersions +
    ai.fallbacks.pairReviewUnavailable;
  return (
    <DashboardSection
      id="dashboard-ai"
      title="AI usage"
      description="Only column names, masked samples and pair features are sent to the AI, never raw customer values."
    >
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="AI calls"
          value={formatCount(t.calls)}
          detail={`${formatCount(t.ok)} succeeded, ${formatCount(t.failed)} failed`}
        />
        <Stat
          label="Tokens"
          value={formatCount(t.inputTokens + t.outputTokens)}
          detail={`${formatCount(t.inputTokens)} in, ${formatCount(t.outputTokens)} out`}
        />
        <Stat label="Cost" value={formatCost(t.costInr)} />
        <Stat
          label="Response time (typical / slowest 5%)"
          value={`${formatDuration(t.latencyMs.p50)} / ${formatDuration(t.latencyMs.p95)}`}
          detail={`Successful calls answered by the AI: ${formatCount(t.latencyMs.samples)}`}
        />
        <Stat label="Answered from cache" value={formatCount(t.cacheHits)} />
        <Stat
          label="Fallbacks to rules"
          value={formatCount(fallbacks)}
          detail={`Mapping: ${ai.fallbacks.mappingSourcesOnRules} files, SQL: ${ai.fallbacks.sqlReferenceVersions} versions, pair review: ${ai.fallbacks.pairReviewUnavailable} pairs`}
        />
      </dl>
      {typeof ai.budget?.remainingToday === 'number' && (
        <p className="text-sm" data-testid="ai-budget">
          AI requests left today: {formatCount(ai.budget.remainingToday)}
          <span className="text-muted-foreground">
            {' '}
            (free plan; the count starts again at {resetTime(ai.budget.resetsAt)})
          </span>
        </p>
      )}
      {ai.tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">No AI calls in this period.</p>
      ) : (
        <DataTable
          caption="AI usage by task"
          hiddenCaption={false}
          className="overflow-x-auto"
          headers={['Task', 'Calls', 'Failed', 'Tokens', 'Cost', 'Typical time', 'From cache']}
          rows={ai.tasks.map((task) => ({
            key: task.task,
            cells: [
              aiTaskLabel(task.task),
              formatCount(task.calls),
              formatCount(task.failed),
              formatCount(task.inputTokens + task.outputTokens),
              formatCost(task.costInr),
              formatDuration(task.latencyMs.p50),
              formatCount(task.cacheHits),
            ],
          }))}
        />
      )}
      {ai.daily.length > 0 && <DailyCalls days={ai.daily} />}
    </DashboardSection>
  );
}
