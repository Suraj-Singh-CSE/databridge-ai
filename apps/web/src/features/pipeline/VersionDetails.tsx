import type { ReactNode } from 'react';

import { StatusPill } from '@/components/StatusPill';
import { TimeAgo } from '@/components/TimeAgo';
import { formatCount } from '@/features/matching/matching-labels';
import type { SqlVersion } from '@/lib/api-types';

import { CHECK_STATUS, checkLabel, methodLabel, SCOPE_LABELS, SQL_STATUS } from './pipeline-labels';
import { SqlCode } from './SqlCode';

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function Tests({ version }: { version: SqlVersion }) {
  if (!version.tests) {
    return (
      <p className="text-sm text-muted-foreground">
        {version.error
          ? `This version was not tested: ${version.error.message}`
          : 'This version has no test results.'}
      </p>
    );
  }
  const { summary, checks } = version.tests;
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        {summary.passedCount} of {summary.checkCount} tests passed · {formatCount(summary.rowCount)}{' '}
        rows (expected {formatCount(summary.expectedRowCount)})
      </p>
      <ul className="divide-y rounded-lg border">
        {checks.map((check) => (
          <li key={check.name} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2">
            <StatusPill tone={CHECK_STATUS[check.status].tone}>
              {CHECK_STATUS[check.status].label}
            </StatusPill>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{checkLabel(check)}</p>
              <p className="text-xs text-muted-foreground">{check.message}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Everything about one SQL version, read-only: who and how, what it does, the query, its tests. */
export function VersionDetails({
  version,
  personOf,
}: {
  version: SqlVersion;
  personOf: (userId: string | null) => string;
}) {
  const status = SQL_STATUS[version.status];
  return (
    <div className="space-y-5">
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Fact term="Status">
          <StatusPill tone={status.tone}>{status.label}</StatusPill>
        </Fact>
        <Fact term="Written by">
          {methodLabel(version.method)}
          {version.model ? ` (${version.model})` : ''}
        </Fact>
        <Fact term="Customers">{SCOPE_LABELS[version.scope]}</Fact>
        <Fact term="Created">
          <TimeAgo iso={version.createdAt} /> by {personOf(version.createdBy)}
        </Fact>
        {version.approvedAt && (
          <Fact term="Approved">
            <TimeAgo iso={version.approvedAt} /> by {personOf(version.approvedBy)}
          </Fact>
        )}
        {version.rejectedAt && (
          <Fact term="Rejected">
            <TimeAgo iso={version.rejectedAt} /> by {personOf(version.rejectedBy)}
            {version.rejectReason ? `: ${version.rejectReason}` : ''}
          </Fact>
        )}
        <Fact term="Last run">
          {version.lastRun ? (
            <>
              <TimeAgo iso={version.lastRun.finishedAt} /> · {formatCount(version.lastRun.rowCount)}{' '}
              rows · {version.lastRun.passed ? 'passed' : 'failed'}
            </>
          ) : (
            'Not run yet'
          )}
        </Fact>
      </dl>

      {version.fallbackReason && (
        <p className="text-sm text-muted-foreground">
          The reference query was used because: {version.fallbackReason}
        </p>
      )}

      <div className="space-y-2">
        <h4 className="text-sm font-medium">What it does</h4>
        <p className="text-sm">{version.explanation || 'No explanation was given.'}</p>
        {version.assumptions.length > 0 && (
          <>
            <h4 className="text-sm font-medium">Assumptions</h4>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {version.assumptions.map((assumption) => (
                <li key={assumption}>{assumption}</li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">SQL</h4>
        <SqlCode sql={version.sql} label={`SQL of version ${version.version}`} />
        {!version.validation.ok && version.validation.message && (
          <p className="text-sm text-muted-foreground">
            Safety check: {version.validation.message}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Tests on the sample</h4>
        <Tests version={version} />
      </div>
    </div>
  );
}
