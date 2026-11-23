import { TimeAgo } from '@/components/TimeAgo';
import {
  REVIEW_TYPES,
  type DashboardJobs,
  type DashboardReview,
  type ReviewerRole,
} from '@/lib/api-types';

import {
  DECISION_LAG_LABELS,
  errorCodeText,
  formatCount,
  formatDuration,
  JOB_TYPE_LABELS,
  REVIEW_TYPE_LABELS,
  REVIEWER_ROLE_LABELS,
} from './dashboard-labels';
import { DashboardSection, DataTable } from './DashboardSection';

/** People's decisions in the range: by type, by role, and how long they took. */
export function ReviewSection({ review }: { review: DashboardReview }) {
  const types = REVIEW_TYPES.filter((type) => review.byType[type] > 0);
  const roles = (Object.keys(REVIEWER_ROLE_LABELS) as ReviewerRole[]).filter(
    (role) => (review.byRole[role] ?? 0) > 0,
  );
  const lags = (Object.keys(DECISION_LAG_LABELS) as (keyof typeof DECISION_LAG_LABELS)[]).flatMap(
    (key) => {
      const lag = review.medianTimeToDecisionMs[key];
      return lag ? [{ key, ...lag }] : [];
    },
  );

  return (
    <DashboardSection
      id="dashboard-review"
      title="Human review"
      description={`${formatCount(review.total)} decisions made by people in this period.`}
    >
      {review.total === 0 ? (
        <p className="text-sm text-muted-foreground">No decisions in this period.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <DataTable
            caption="Decisions by type"
            hiddenCaption={false}
            className="overflow-x-auto"
            headers={['Decision', 'Count']}
            rows={types.map((type) => ({
              key: type,
              cells: [REVIEW_TYPE_LABELS[type], formatCount(review.byType[type])],
            }))}
          />
          <DataTable
            caption="Decisions by role"
            hiddenCaption={false}
            className="overflow-x-auto"
            headers={['Role', 'Count']}
            rows={roles.map((role) => ({
              key: role,
              cells: [REVIEWER_ROLE_LABELS[role], formatCount(review.byRole[role] ?? 0)],
            }))}
          />
        </div>
      )}
      {lags.length > 0 && (
        <DataTable
          caption="Median time from suggestion to decision"
          hiddenCaption={false}
          className="overflow-x-auto"
          headers={['Decision', 'Median time', 'Decisions measured']}
          rows={lags.map((lag) => ({
            key: lag.key,
            cells: [
              DECISION_LAG_LABELS[lag.key],
              formatDuration(lag.medianMs),
              formatCount(lag.samples),
            ],
          }))}
        />
      )}
    </DashboardSection>
  );
}

/** Background jobs started in the range: outcomes and durations by type, and recent failures. */
export function JobsSection({ jobs }: { jobs: DashboardJobs }) {
  const used = jobs.byType.filter((j) => j.total > 0);
  return (
    <DashboardSection id="dashboard-jobs" title="Job health">
      {used.length === 0 ? (
        <p className="text-sm text-muted-foreground">No jobs ran in this period.</p>
      ) : (
        <DataTable
          caption="Jobs by type"
          hiddenCaption={false}
          className="overflow-x-auto"
          headers={[
            'Job',
            'Total',
            'Succeeded',
            'Failed',
            'Cancelled',
            'Median time',
            'Slowest 5%',
          ]}
          rows={used.map((j) => ({
            key: j.type,
            cells: [
              JOB_TYPE_LABELS[j.type],
              formatCount(j.total),
              formatCount(j.succeeded),
              formatCount(j.failed),
              formatCount(j.cancelled),
              formatDuration(j.durationMs.median),
              formatDuration(j.durationMs.p95),
            ],
          }))}
        />
      )}
      {jobs.recentFailures.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Latest failures</h3>
          <ul className="space-y-1 text-sm">
            {jobs.recentFailures.map((f, i) => (
              <li key={`${f.at}:${i}`} className="flex flex-wrap gap-x-2">
                <span className="font-medium">{JOB_TYPE_LABELS[f.type]}:</span>
                <span>{errorCodeText(f.code)}</span>
                <span className="text-muted-foreground">
                  (<TimeAgo iso={f.at} />)
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </DashboardSection>
  );
}
