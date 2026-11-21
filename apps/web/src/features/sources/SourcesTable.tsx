import { ProgressBar } from '@/components/ProgressBar';
import { StatusPill } from '@/components/StatusPill';
import { Button } from '@/components/ui/button';
import type { Job, Source } from '@/lib/api-types';
import { formatRelativeTime } from '@/lib/relative-time';

import { formatBytes, formatCount, profileErrorMessage, sourceStatusPill } from './source-rules';

interface SourcesTableProps {
  sources: Source[];
  /** Queued or running profile job per source id. */
  activeJobs: Map<string, Job>;
  canManage: boolean;
  onPreview: (source: Source) => void;
  onRemove: (source: Source) => void;
  onProfile: (source: Source) => void;
  onCancel: (job: Job) => void;
  /** Source ids whose profile request is being sent. */
  starting: ReadonlySet<string>;
  /** Job ids whose cancel request is being sent. */
  cancelling: ReadonlySet<string>;
}

const FORMAT_LABELS: Record<Source['format'], string> = { csv: 'CSV', xlsx: 'Excel' };

function StatusCell({ source, job }: { source: Source; job: Job | undefined }) {
  if (job) {
    const queued = job.status === 'queued';
    const pill = queued
      ? { label: 'Waiting to start', tone: 'neutral' as const }
      : sourceStatusPill('profiling', job.progress);
    return (
      <div role="status" className="space-y-1.5">
        <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
        <ProgressBar
          value={job.progress / 100}
          label={`Profiling ${source.originalFilename}`}
          className="max-w-40"
        />
        {job.message && <p className="text-xs text-muted-foreground">{job.message}</p>}
      </div>
    );
  }
  const pill = sourceStatusPill(source.status);
  return (
    <div role="status" className="space-y-1">
      <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
      {source.status === 'failed' && (
        <p className="max-w-64 text-xs text-destructive">{profileErrorMessage(source.error)}</p>
      )}
    </div>
  );
}

export function SourcesTable({
  sources,
  activeJobs,
  canManage,
  onPreview,
  onRemove,
  onProfile,
  onCancel,
  starting,
  cancelling,
}: SourcesTableProps) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Source files in this project</caption>
        <thead className="bg-muted/50 text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2.5 font-medium">
              File
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              Format
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              Size
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              Rows × columns
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              Uploaded
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              Status
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sources.map((source) => {
            const job = activeJobs.get(source.id);
            const name = source.originalFilename;
            const profiled = source.status === 'profiled' || source.status === 'ready';
            return (
              <tr key={source.id} className="border-t align-top">
                <td className="px-3 py-3">
                  <span className="font-mono break-all">{name}</span>
                </td>
                <td className="px-3 py-3">{FORMAT_LABELS[source.format]}</td>
                <td className="px-3 py-3 whitespace-nowrap">{formatBytes(source.sizeBytes)}</td>
                <td className="px-3 py-3 whitespace-nowrap">
                  {formatCount(source.rowCount)} × {formatCount(source.columnCount)}
                </td>
                <td className="px-3 py-3 whitespace-nowrap text-muted-foreground">
                  {formatRelativeTime(source.createdAt)}
                </td>
                <td className="px-3 py-3">
                  <StatusCell source={source} job={job} />
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap justify-end gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Preview ${name}`}
                      onClick={() => {
                        onPreview(source);
                      }}
                    >
                      Preview
                    </Button>
                    {canManage && job && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={`Cancel profiling of ${name}`}
                        disabled={cancelling.has(job.id)}
                        onClick={() => {
                          onCancel(job);
                        }}
                      >
                        Cancel
                      </Button>
                    )}
                    {canManage && !job && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={`${profiled ? 'Re-run profile of' : 'Profile'} ${name}`}
                        disabled={starting.has(source.id)}
                        onClick={() => {
                          onProfile(source);
                        }}
                      >
                        {profiled ? 'Re-run profile' : 'Profile'}
                      </Button>
                    )}
                    {canManage && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove ${name}`}
                        disabled={Boolean(job)}
                        title={job ? 'Cancel profiling before removing this file' : undefined}
                        onClick={() => {
                          onRemove(source);
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
