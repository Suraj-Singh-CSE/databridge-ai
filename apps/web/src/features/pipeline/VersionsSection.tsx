import { useRef } from 'react';

import { LoadFailed } from '@/components/LoadFailed';
import { StatusPill } from '@/components/StatusPill';
import { TimeAgo } from '@/components/TimeAgo';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { SqlVersionSummary } from '@/lib/api-types';

import { SQL_STATUS, testsText } from './pipeline-labels';
import { useSqlVersion } from './queries';
import { DecisionActions } from './SqlActions';
import { VersionDetails } from './VersionDetails';

interface VersionsSectionProps {
  projectId: string;
  versions: SqlVersionSummary[];
  personOf: (userId: string | null) => string;
  /** The open version (lifted so a new draft can open itself). */
  selectedId: string | null;
  onSelect: (versionId: string | null) => void;
  canDecide: boolean;
  /** The last decision's result, kept by the page so a refetch or remount cannot lose it. */
  message: string | null;
  onMessage: (text: string | null) => void;
}

interface SelectedVersionProps {
  projectId: string;
  versionId: string;
  personOf: (userId: string | null) => string;
  approved: SqlVersionSummary | null;
  canDecide: boolean;
  onResult: (text: string, ok: boolean) => void;
}

function SelectedVersion({
  projectId,
  versionId,
  personOf,
  approved,
  canDecide,
  onResult,
}: SelectedVersionProps) {
  const version = useSqlVersion(projectId, versionId);
  if (version.isPending) {
    return <Skeleton className="h-64 w-full" aria-label="Loading version details" />;
  }
  if (version.isError) {
    return (
      <LoadFailed
        title="We could not load this version"
        message={version.error.message}
        retry={() => void version.refetch()}
      />
    );
  }
  return (
    <div className="space-y-4">
      {canDecide && version.data.status === 'draft' && (
        <DecisionActions
          projectId={projectId}
          version={version.data}
          approved={approved}
          onResult={onResult}
        />
      )}
      <VersionDetails version={version.data} personOf={personOf} />
    </div>
  );
}

/** Every SQL version with its status and tests; one can be opened to see its details. */
export function VersionsSection({
  projectId,
  versions,
  personOf,
  selectedId,
  onSelect,
  canDecide,
  message,
  onMessage,
}: VersionsSectionProps) {
  const selected = versions.find((v) => v.id === selectedId) ?? null;
  const approved = versions.find((v) => v.status === 'approved') ?? null;
  const detailsHeading = useRef<HTMLHeadingElement>(null);

  return (
    <section aria-labelledby="sql-versions" className="space-y-4 rounded-xl border px-5 py-4">
      <h2 id="sql-versions" className="text-base font-medium">
        Versions
      </h2>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">SQL versions</caption>
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              {['Version', 'Status', 'Tests', 'Created', 'Details'].map((h) => (
                <th key={h} scope="col" className="px-3 py-2.5 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {versions.map((version) => {
              const status = SQL_STATUS[version.status];
              const open = version.id === selectedId;
              return (
                <tr key={version.id} className="border-t">
                  <th scope="row" className="px-3 py-2.5 font-medium">
                    v{version.version}
                  </th>
                  <td className="px-3 py-2.5">
                    <StatusPill tone={status.tone}>{status.label}</StatusPill>
                  </td>
                  <td className="px-3 py-2.5 tabular-nums">{testsText(version)}</td>
                  <td className="px-3 py-2.5">
                    <TimeAgo iso={version.createdAt} /> by {personOf(version.createdBy)}
                  </td>
                  <td className="px-3 py-2.5">
                    <Button
                      size="sm"
                      variant="outline"
                      aria-expanded={open}
                      aria-label={`${open ? 'Hide' : 'View'} version ${version.version}`}
                      aria-controls="sql-version-details"
                      onClick={() => {
                        onMessage(null);
                        onSelect(open ? null : version.id);
                      }}
                    >
                      {open ? 'Hide' : 'View'}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div id="sql-version-details">
        {selected && (
          <section
            aria-label={`Version ${selected.version} details`}
            className="space-y-3 rounded-lg border px-4 py-3"
          >
            <h3 ref={detailsHeading} tabIndex={-1} className="text-sm font-semibold outline-none">
              Version {selected.version}
            </h3>
            <SelectedVersion
              projectId={projectId}
              versionId={selected.id}
              personOf={personOf}
              approved={approved}
              canDecide={canDecide}
              onResult={(text, ok) => {
                onMessage(text);
                // The decision buttons go away once decided: keep focus on these details.
                if (ok) detailsHeading.current?.focus();
              }}
            />
          </section>
        )}
      </div>
      <p role="status" aria-live="polite" className="text-sm">
        {message}
      </p>
    </section>
  );
}
