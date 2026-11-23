import { useState } from 'react';

import { LoadFailed } from '@/components/LoadFailed';
import { StatusPill } from '@/components/StatusPill';
import { TimeAgo } from '@/components/TimeAgo';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { SqlVersionSummary } from '@/lib/api-types';

import { SQL_STATUS, testsText } from './pipeline-labels';
import { useSqlVersion } from './queries';
import { VersionDetails } from './VersionDetails';

interface VersionsSectionProps {
  projectId: string;
  versions: SqlVersionSummary[];
  personOf: (userId: string | null) => string;
}

function SelectedVersion({
  projectId,
  versionId,
  personOf,
}: {
  projectId: string;
  versionId: string;
  personOf: (userId: string | null) => string;
}) {
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
  return <VersionDetails version={version.data} personOf={personOf} />;
}

/** Every SQL version with its status and tests; one can be opened to see its details. */
export function VersionsSection({ projectId, versions, personOf }: VersionsSectionProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = versions.find((v) => v.id === selectedId) ?? null;

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
                        setSelectedId(open ? null : version.id);
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
            <h3 className="text-sm font-semibold">Version {selected.version}</h3>
            <SelectedVersion projectId={projectId} versionId={selected.id} personOf={personOf} />
          </section>
        )}
      </div>
    </section>
  );
}
