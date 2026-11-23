import { hashKey, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { sourceKeys } from '@/features/sources/queries';
import type { Job } from '@/lib/api-types';
import { isTerminalStatus } from '@/lib/job-events';

/** A number from a job's `result`, or null when it has none. */
export function resultNumber(job: Job, key: string): number | null {
  const value = job.result?.[key];
  return typeof value === 'number' ? value : null;
}

export function isRunning(job: Job | null): job is Job {
  return job !== null && !isTerminalStatus(job.status);
}

/**
 * Calls `onEnd` once when the job this page started (`startedId`) reaches a final status in the
 * cached job list, which the live watcher keeps current. It listens to the cache itself, not to
 * renders, so the final update is seen even when the list is re-read straight after it.
 * `onEnd` should clear `startedId`.
 */
export function useJobEnd(
  projectId: string,
  startedId: string | null,
  onEnd: (job: Job) => void,
): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (startedId === null) return;
    const key = sourceKeys.jobs(projectId);
    const hash = hashKey(key);
    let ended = false;
    const check = () => {
      const job = queryClient.getQueryData<Job[]>(key)?.find((item) => item.id === startedId);
      if (!ended && job && isTerminalStatus(job.status)) {
        ended = true;
        onEnd(job);
      }
    };
    check();
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.query.queryHash === hash) check();
    });
  }, [queryClient, projectId, startedId, onEnd]);
}
