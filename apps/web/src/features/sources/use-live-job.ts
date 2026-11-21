import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import type { Job } from '@/lib/api-types';
import { watchJob } from '@/lib/job-events';

import { refreshAfterJob, sourceKeys } from './queries';

/**
 * Follows a running job over SSE (with polling fallback) and writes each update into the cached
 * job list, so every view of the job re-renders from one place. When the job ends the sources,
 * profiles and jobs are re-read. The connection closes when the component unmounts.
 */
export function useLiveJob(job: Job): void {
  const queryClient = useQueryClient();
  const { id, projectId } = job;

  useEffect(() => {
    const controller = new AbortController();
    watchJob(id, {
      signal: controller.signal,
      onUpdate: (update) => {
        queryClient.setQueryData<Job[]>(sourceKeys.jobs(projectId), (jobs) =>
          jobs?.map((item) =>
            item.id === update.jobId
              ? {
                  ...item,
                  status: update.status,
                  progress: update.progress,
                  message: update.message,
                  result: update.result,
                  error: update.error,
                }
              : item,
          ),
        );
      },
    }).then(
      () => refreshAfterJob(queryClient, projectId),
      () => {
        // Aborted on unmount, or the job is no longer visible: re-read what is there now.
        if (!controller.signal.aborted) void refreshAfterJob(queryClient, projectId);
      },
    );
    return () => {
      controller.abort();
    };
  }, [id, projectId, queryClient]);
}
