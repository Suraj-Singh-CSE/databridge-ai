import { useState } from 'react';

import { ProgressBar } from '@/components/ProgressBar';
import { Button } from '@/components/ui/button';
import { useCancelJob } from '@/features/sources/queries';
import type { Job } from '@/lib/api-types';

import { actionErrorText } from './pipeline-labels';

/** Live progress of a running job, with Cancel for those allowed to cancel it. */
export function JobProgress({
  job,
  action,
  canCancel,
}: {
  job: Job;
  /** e.g. "Draft SQL"; names the progress bar and the Cancel button. */
  action: string;
  canCancel: boolean;
}) {
  const cancel = useCancelJob();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="w-full space-y-2">
      <div role="status" className="space-y-1.5">
        <p className="text-sm">
          {job.status === 'queued' ? 'Waiting to start' : `${job.progress}% done`}
          {job.message && <span className="text-muted-foreground"> · {job.message}</span>}
        </p>
        <ProgressBar value={job.progress / 100} label={action} />
      </div>
      {canCancel && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={`Cancel: ${action}`}
          disabled={cancel.isPending}
          onClick={() => {
            setError(null);
            cancel.mutate(job.id, {
              onError: (e) => {
                setError(actionErrorText(e));
              },
            });
          }}
        >
          Cancel
        </Button>
      )}
      <p aria-live="polite" className="text-sm">
        {error}
      </p>
    </div>
  );
}
