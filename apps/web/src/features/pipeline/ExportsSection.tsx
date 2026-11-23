import { Download } from 'lucide-react';
import { useState } from 'react';

import { EmptyState } from '@/components/EmptyState';
import { LoadFailed } from '@/components/LoadFailed';
import { TimeAgo } from '@/components/TimeAgo';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCount } from '@/features/matching/matching-labels';

import { downloadErrorMessage, formatBytes, SCOPE_LABELS } from './pipeline-labels';
import { useDownloadExport, useExports } from './queries';

export const CSV_PHONE_NOTE = "Phone numbers start with ' in CSV to stop spreadsheet formulas.";

/** Exported files of golden records; any member may download them. */
export function ExportsSection({
  projectId,
  personOf,
}: {
  projectId: string;
  personOf: (userId: string | null) => string;
}) {
  const exports = useExports(projectId);
  const download = useDownloadExport(projectId);
  const [message, setMessage] = useState<string | null>(null);
  const busyId = download.isPending ? download.variables.id : null;

  let body;
  if (exports.isPending) {
    body = <Skeleton className="h-32 w-full" aria-label="Loading exports" />;
  } else if (exports.isError) {
    body = (
      <LoadFailed
        title="We could not load the exports"
        message={exports.error.message}
        retry={() => void exports.refetch()}
      />
    );
  } else if (exports.data.length === 0) {
    body = (
      <EmptyState
        title="No exports yet"
        description="Exported files of the golden records appear here once a data engineer starts an export."
      />
    );
  } else {
    const hasCsv = exports.data.some((item) => item.format === 'csv');
    body = (
      <>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Exports</caption>
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                {['Format', 'Customers', 'Rows', 'Size', 'Created', 'File'].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2.5 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {exports.data.map((item) => (
                <tr key={item.id} className="border-t">
                  <th scope="row" className="px-3 py-2.5 font-medium uppercase">
                    {item.format}
                  </th>
                  <td className="px-3 py-2.5">{SCOPE_LABELS[item.scope]}</td>
                  <td className="px-3 py-2.5 tabular-nums">{formatCount(item.rowCount)}</td>
                  <td className="px-3 py-2.5 tabular-nums">{formatBytes(item.bytes)}</td>
                  <td className="px-3 py-2.5">
                    <TimeAgo iso={item.createdAt} /> by {personOf(item.createdBy)}
                  </td>
                  <td className="px-3 py-2.5">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId !== null}
                      aria-busy={busyId === item.id}
                      aria-label={`${busyId === item.id ? 'Downloading' : 'Download'} ${item.filename}`}
                      onClick={() => {
                        setMessage(null);
                        download.mutate(item, {
                          onSuccess: (filename) => {
                            setMessage(`Downloaded ${filename}.`);
                          },
                          onError: (error) => {
                            setMessage(downloadErrorMessage(error));
                          },
                        });
                      }}
                    >
                      <Download aria-hidden="true" />
                      {busyId === item.id ? 'Downloading…' : 'Download'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {hasCsv && <p className="text-xs text-muted-foreground">{CSV_PHONE_NOTE}</p>}
      </>
    );
  }

  return (
    <section aria-labelledby="exports" className="space-y-4 rounded-xl border px-5 py-4">
      <h2 id="exports" className="text-base font-medium">
        Exports
      </h2>
      {body}
      <p role="status" className="text-sm">
        {message}
      </p>
    </section>
  );
}
