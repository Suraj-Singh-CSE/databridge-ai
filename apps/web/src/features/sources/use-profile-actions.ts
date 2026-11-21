import { toast } from 'sonner';

import { ApiError } from '@/lib/api';
import type { Job, Source } from '@/lib/api-types';

import { useCancelJob, usePendingJobActions, useStartProfile } from './queries';
import { profileErrorMessage } from './source-rules';

function startErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Profiling could not start. Please try again.';
  if (error.code === 'CONFLICT') return 'This file is already being profiled.';
  if (error.status === 403) return 'You do not have permission to profile files in this project.';
  return profileErrorMessage({ code: error.code, message: error.message });
}

/** Start and cancel profile jobs with plain-language toasts; shared by Sources and Profile. */
export function useProfileActions(projectId: string) {
  const startProfile = useStartProfile(projectId);
  const cancelJob = useCancelJob();
  const pending = usePendingJobActions(projectId);

  return {
    ...pending,
    start: (source: Pick<Source, 'id' | 'originalFilename'>) => {
      // mutateAsync, not mutate: per-call callbacks of mutate only run for the latest call, and
      // several uploads can start profiling at once.
      void startProfile.mutateAsync(source.id).catch((error: unknown) => {
        toast.error(`${source.originalFilename}: ${startErrorMessage(error)}`);
      });
    },
    cancel: (job: Job) => {
      void cancelJob.mutateAsync(job.id).catch((error: unknown) => {
        toast.error(
          error instanceof ApiError ? error.message : 'Could not cancel. Please try again.',
        );
      });
    },
  };
}
