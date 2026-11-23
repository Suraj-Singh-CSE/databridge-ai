import { LoadFailed } from '@/components/LoadFailed';
import { TimeAgo } from '@/components/TimeAgo';
import { Skeleton } from '@/components/ui/skeleton';
import type { QualityRuleOverride, QualityRun } from '@/lib/api-types';

import { formatMetric, RULE_NAMES, unitOfRule } from './quality-labels';
import { useQualityRules } from './queries';

interface Setting {
  enabled: boolean;
  warn: number | null;
  fail: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A rule's effective setting from the latest report's `config` (defaults plus overrides). */
function settingFromRun(run: QualityRun | null, rule: string): Setting | null {
  const rules = run && isRecord(run.config.rules) ? run.config.rules : null;
  const entry = rules?.[rule];
  if (!isRecord(entry) || typeof entry.warn !== 'number') return null;
  return {
    enabled: entry.enabled !== false,
    warn: entry.warn,
    fail: typeof entry.fail === 'number' ? entry.fail : null,
  };
}

function overrideText(override: QualityRuleOverride | undefined): string | null {
  if (!override) return null;
  if (override.enabled === false) return 'Turned off for this project';
  return 'Changed for this project';
}

/** Read-only view of the thresholds: what the latest report used and what the project changed. */
export function ThresholdsSection({
  projectId,
  latest,
  personOf,
}: {
  projectId: string;
  latest: QualityRun | null;
  personOf: (userId: string | null) => string;
}) {
  const rules = useQualityRules(projectId);

  let body;
  if (rules.isPending) {
    body = <Skeleton className="h-32 w-full" aria-label="Loading thresholds" />;
  } else if (rules.isError) {
    body = (
      <LoadFailed
        title="We could not load the thresholds"
        message={rules.error.message}
        retry={() => void rules.refetch()}
      />
    );
  } else {
    const view = rules.data;
    const fields = Object.entries(view.fields);
    body = (
      <>
        <p className="text-sm text-muted-foreground">
          {view.updatedAt ? (
            <>
              Last changed <TimeAgo iso={view.updatedAt} /> by {personOf(view.updatedBy)}.
            </>
          ) : (
            'This project uses the default thresholds.'
          )}{' '}
          {latest
            ? 'Values below are the ones the latest report used.'
            : 'Exact values show here after the first report.'}
        </p>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Thresholds in use</caption>
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                {['Rule', 'Good when', 'Warn at', 'Fail at', 'Setting'].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2.5 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.catalogue.map(({ rule, direction }) => {
                const unit = unitOfRule(rule);
                const setting = settingFromRun(latest, rule);
                const override = view.rules[rule];
                const warn = setting?.warn ?? override?.warn ?? null;
                const fail = setting ? setting.fail : override?.fail;
                return (
                  <tr key={rule} className="border-t">
                    <th scope="row" className="px-3 py-2.5 font-medium">
                      {RULE_NAMES[rule] ?? rule}
                    </th>
                    <td className="px-3 py-2.5">{direction === 'min' ? 'Higher' : 'Lower'}</td>
                    <td className="px-3 py-2.5 tabular-nums">
                      {warn === null ? 'Default' : formatMetric(warn, unit)}
                    </td>
                    <td className="px-3 py-2.5 tabular-nums">
                      {fail === undefined
                        ? 'Default'
                        : fail === null
                          ? 'Never fails'
                          : formatMetric(fail, unit)}
                    </td>
                    <td className="px-3 py-2.5">
                      {setting && !setting.enabled
                        ? 'Turned off'
                        : (overrideText(override) ?? 'Default')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {fields.length > 0 && (
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Field thresholds (filled in)</h3>
            <ul className="space-y-1 text-sm">
              {fields.map(([field, override]) => (
                <li key={field}>
                  <span className="font-mono">{field}</span>: warn below{' '}
                  {override.warn === undefined ? 'default' : formatMetric(override.warn, 'percent')}
                  , fail{' '}
                  {override.fail === undefined
                    ? 'below default'
                    : override.fail === null
                      ? 'never'
                      : `below ${formatMetric(override.fail, 'percent')}`}
                </li>
              ))}
            </ul>
          </div>
        )}
      </>
    );
  }

  return (
    <section aria-labelledby="thresholds" className="space-y-4 rounded-xl border px-5 py-4">
      <h2 id="thresholds" className="text-base font-medium">
        Thresholds in use
      </h2>
      {body}
    </section>
  );
}
