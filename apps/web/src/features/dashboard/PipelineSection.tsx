import { StatusPill } from '@/components/StatusPill';
import { TimeAgo } from '@/components/TimeAgo';
import { QUALITY_STATUS } from '@/features/quality/quality-labels';
import type { DashboardPipeline, SqlStatus } from '@/lib/api-types';

import { formatCount } from './dashboard-labels';
import { DashboardSection, Stat } from './DashboardSection';

const SQL_STATUS: Record<SqlStatus, string> = {
  draft: 'Waiting for review',
  approved: 'Approved',
  rejected: 'Rejected',
  superseded: 'Replaced',
};

function SqlValue({ sql }: { sql: DashboardPipeline['sql'] }) {
  if (!sql.latest) return 'Not drafted';
  return `v${sql.latest.version} · ${SQL_STATUS[sql.latest.status]}`;
}

/** How far the data got: one card per step, with "Out of date" where a later step must rerun. */
export function PipelineSection({ pipeline: p }: { pipeline: DashboardPipeline }) {
  const quality = p.quality.latest;
  return (
    <DashboardSection id="dashboard-pipeline" title="Pipeline">
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Files"
          value={formatCount(p.sources.count)}
          detail={`${formatCount(p.sources.byStatus.failed)} failed`}
        />
        <Stat label="Rows uploaded" value={formatCount(p.sources.rowsUploaded)} />
        <Stat
          label="Columns mapped"
          value={`${formatCount(p.mapping.decided)} decided`}
          detail={`${formatCount(p.mapping.pending)} waiting for a decision`}
          outdated={p.mapping.outdated}
        />
        <Stat
          label="Customers"
          value={formatCount(p.clusters.customers)}
          outdated={p.clusters.outdated}
        />
        <Stat
          label="Records merged"
          value={formatCount(p.clusters.recordsMerged)}
          detail="Records folded into another record's customer"
        />
        <Stat label="Needs review" value={formatCount(p.clusters.needsReview)} />
        <Stat label="Approved customers" value={formatCount(p.clusters.approved)} />
        <Stat
          label="Latest SQL"
          value={<SqlValue sql={p.sql} />}
          detail={
            p.sql.latest
              ? p.sql.latest.testsPassed
                ? 'Tests passed'
                : 'Tests not passed'
              : undefined
          }
          outdated={p.sql.outdated}
        />
        <Stat label="Exports" value={formatCount(p.exports.count)} outdated={p.exports.outdated} />
        <Stat
          label="Latest quality check"
          value={
            quality ? (
              <StatusPill tone={QUALITY_STATUS[quality.status].tone}>
                {QUALITY_STATUS[quality.status].label}
              </StatusPill>
            ) : (
              'Not run'
            )
          }
          detail={quality ? <TimeAgo iso={quality.at} /> : undefined}
          outdated={p.quality.outdated}
        />
      </dl>
    </DashboardSection>
  );
}
