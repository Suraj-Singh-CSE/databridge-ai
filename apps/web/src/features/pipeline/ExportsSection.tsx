import { Download, LoaderCircle } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

import { EmptyState } from '@/components/EmptyState';
import { LoadFailed } from '@/components/LoadFailed';
import { TimeAgo } from '@/components/TimeAgo';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCount } from '@/features/matching/matching-labels';
import { ConfirmAction } from '@/features/matching/ReviewDialogs';
import type { DataScope, ExportFormat, Job } from '@/lib/api-types';

import { JobProgress } from './JobProgress';
import {
  actionErrorText,
  downloadErrorMessage,
  formatBytes,
  jobFailureText,
  SCOPE_LABELS,
} from './pipeline-labels';
import { useDeleteExport, useDownloadExport, useExports, useStartPipelineJob } from './queries';
import { Choice, FormError } from './SqlActions';
import { isRunning, resultNumber, useJobEnd } from './use-job-end';

export const CSV_PHONE_NOTE = "Phone numbers start with ' in CSV to stop spreadsheet formulas.";

interface ExportOptions {
  format: ExportFormat;
  scope: DataScope;
  includeSources: boolean;
}

const FORMAT_CHOICES: { value: ExportFormat; label: string }[] = [
  { value: 'csv', label: 'CSV' },
  { value: 'xlsx', label: 'Excel' },
];

const SCOPE_CHOICES: { value: DataScope; label: string; hint: string }[] = [
  { value: 'approved', label: 'Approved only', hint: 'Customers approved in Match review.' },
  {
    value: 'all',
    label: 'All with review status',
    hint: 'Every customer, with a column saying whether it is approved.',
  },
];

function NewExportDialog({
  pending,
  running,
  onStart,
}: {
  pending: boolean;
  /** A job of this kind is running: the button stays focusable but does not open. */
  running: boolean;
  onStart: (options: ExportOptions, done: (error: unknown) => void) => void;
}) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [scope, setScope] = useState<DataScope>('approved');
  const [includeSources, setIncludeSources] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next && running) return;
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          aria-disabled={running || undefined}
        >
          {pending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
          New export
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New export</DialogTitle>
          <DialogDescription>
            Writes the golden records to a file that any member of the project can download.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            onStart({ format, scope, includeSources }, (failure) => {
              if (failure === null) setOpen(false);
              else setError(actionErrorText(failure));
            });
          }}
        >
          <Choice
            legend="Format"
            name="export-format"
            value={format}
            options={FORMAT_CHOICES}
            onChange={setFormat}
          />
          <Choice
            legend="Customers"
            name="export-scope"
            value={scope}
            options={SCOPE_CHOICES}
            onChange={setScope}
          />
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeSources}
              className="mt-0.5 size-4 accent-primary"
              onChange={(event) => {
                setIncludeSources(event.target.checked);
              }}
            />
            <span>
              Include source record keys
              <span className="block text-muted-foreground">
                Adds which file and record each customer came from.
              </span>
            </span>
          </label>
          <FormError message={error} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
              Start export
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function exportResultText(job: Job): string {
  if (job.status === 'cancelled') return 'The export was cancelled.';
  if (job.status === 'failed') return `The export failed. ${jobFailureText(job)}`;
  const rows = resultNumber(job, 'rowCount');
  return `Export ready${rows === null ? '' : `: ${formatCount(rows)} rows`}. Download it from the list.`;
}

interface ExportsSectionProps {
  projectId: string;
  personOf: (userId: string | null) => string;
  /** The newest `export` job. */
  job: Job | null;
  /** Start exports (data stewards and up). */
  canStart: boolean;
  /** Delete exports and cancel export jobs (data engineers and up). */
  canDelete: boolean;
}

/** Exported files of golden records; any member may download them. */
export function ExportsSection({
  projectId,
  personOf,
  job,
  canStart,
  canDelete,
}: ExportsSectionProps) {
  const exports = useExports(projectId);
  const download = useDownloadExport(projectId);
  const start = useStartPipelineJob(projectId);
  const remove = useDeleteExport(projectId);
  const [message, setMessage] = useState<string | null>(null);
  const [startedId, setStartedId] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const busyId = download.isPending ? download.variables.id : null;
  const onEnd = useCallback((ended: Job) => {
    setStartedId(null);
    setMessage(exportResultText(ended));
  }, []);
  useJobEnd(projectId, startedId, onEnd);

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
        description={
          canStart
            ? 'Start an export to get the golden records as a CSV or Excel file.'
            : 'Exported files of the golden records appear here once a data engineer or data steward starts an export.'
        }
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
                    {canDelete && (
                      <span className="ml-2 inline-block">
                        <ConfirmAction
                          label="Delete"
                          ariaLabel={`Delete ${item.filename}`}
                          title="Delete this export?"
                          description={`${item.filename} is removed for everyone in the project. You can export again at any time.`}
                          confirmLabel="Delete"
                          pending={remove.isPending && remove.variables.id === item.id}
                          disabled={remove.isPending}
                          onConfirm={() => {
                            setMessage(null);
                            remove.mutate(item, {
                              onSuccess: () => {
                                setMessage(`Deleted ${item.filename}.`);
                                // The row and its button are gone: keep focus in this section.
                                heading.current?.focus();
                              },
                              onError: (error) => {
                                setMessage(actionErrorText(error));
                              },
                            });
                          }}
                        />
                      </span>
                    )}
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 ref={heading} id="exports" tabIndex={-1} className="text-base font-medium outline-none">
          Exports
        </h2>
        {canStart && (
          <NewExportDialog
            pending={start.isPending}
            running={isRunning(job)}
            onStart={(options, done) => {
              setMessage(null);
              start.mutate(
                { type: 'export', payload: options },
                {
                  onSuccess: (started) => {
                    setStartedId(started.id);
                    done(null);
                  },
                  onError: done,
                },
              );
            }}
          />
        )}
      </div>
      {isRunning(job) && <JobProgress job={job} action="Export" canCancel={canDelete} />}
      {body}
      <p role="status" aria-live="polite" className="text-sm">
        {message}
      </p>
    </section>
  );
}
