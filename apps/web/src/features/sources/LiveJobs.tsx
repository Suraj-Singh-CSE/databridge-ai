import type { Job } from '@/lib/api-types';

import { useLiveJob } from './use-live-job';

function LiveJob({ job }: { job: Job }) {
  useLiveJob(job);
  return null;
}

/** Keeps one live connection per running job while mounted. Renders nothing. */
export function LiveJobs({ jobs }: { jobs: Iterable<Job> }) {
  return (
    <>
      {Array.from(jobs, (job) => (
        <LiveJob key={job.id} job={job} />
      ))}
    </>
  );
}
