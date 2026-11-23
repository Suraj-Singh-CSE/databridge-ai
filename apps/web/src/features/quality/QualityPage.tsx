import { Info, LoaderCircle } from 'lucide-react';
import { useCallback, useState } from 'react';

import { EmptyState } from '@/components/EmptyState';
import { LoadFailed } from '@/components/LoadFailed';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import { JobProgress } from '@/features/pipeline/JobProgress';
import { actionErrorText, jobFailureText } from '@/features/pipeline/pipeline-labels';
import { latestJobOf, useStartPipelineJob } from '@/features/pipeline/queries';
import { isRunning, useJobEnd } from '@/features/pipeline/use-job-end';
import {
  canManageQuality,
  canRunQuality,
  projectAccessOf,
  READ_ONLY_QUALITY_NOTE,
  STEWARD_QUALITY_NOTE,
} from '@/features/projects/access';
import { personLabel } from '@/features/projects/people';
import { ProjectPageFrame } from '@/features/projects/ProjectPageFrame';
import { projectPage } from '@/features/projects/steps';
import { LiveJobs } from '@/features/sources/LiveJobs';
import { useProjectJobs } from '@/features/sources/queries';
import type { Job, Project } from '@/lib/api-types';

import { LatestReport } from './LatestReport';
import { QualityHistory } from './QualityHistory';
import { useLatestQuality } from './queries';
import { ThresholdsSection } from './ThresholdsSection';

const PAGE = projectPage('quality');

function qualityResultText(job: Job): string {
  if (job.status === 'cancelled') return 'The quality check was cancelled.';
  if (job.status === 'failed') return `The quality check failed. ${jobFailureText(job)}`;
  const counts = job.result?.statusCounts;
  if (typeof counts === 'object' && counts !== null) {
    const count = (key: string) => {
      const value: unknown = (counts as Record<string, unknown>)[key];
      return typeof value === 'number' ? value : 0;
    };
    return `The quality check finished: ${count('pass')} passed, ${count('warn')} warnings, ${count('fail')} failed. The report below is up to date.`;
  }
  return 'The quality check finished. The report below is up to date.';
}

/** "Run quality checks": starts the `quality` job; the report and history refresh when it ends. */
function RunQualityControl({
  projectId,
  job,
  canCancel,
}: {
  projectId: string;
  job: Job | null;
  canCancel: boolean;
}) {
  const start = useStartPipelineJob(projectId);
  const [startedId, setStartedId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const onEnd = useCallback((ended: Job) => {
    setStartedId(null);
    setMessage(qualityResultText(ended));
  }, []);
  useJobEnd(projectId, startedId, onEnd);

  return (
    <section aria-labelledby="run-quality" className="space-y-3 rounded-xl border px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="run-quality" className="text-base font-medium">
            Run quality checks
          </h2>
          <p className="text-sm text-muted-foreground">
            Checks the clean customer table for missing, invalid, shared and out-of-date values.
          </p>
        </div>
        <Button
          type="button"
          disabled={start.isPending}
          aria-disabled={isRunning(job) || undefined}
          onClick={() => {
            if (isRunning(job)) return;
            setMessage(null);
            start.mutate(
              { type: 'quality', payload: {} },
              {
                onSuccess: (started) => {
                  setStartedId(started.id);
                },
                onError: (error) => {
                  setMessage(actionErrorText(error));
                },
              },
            );
          }}
        >
          {start.isPending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
          Run quality checks
        </Button>
      </div>
      {isRunning(job) && (
        <JobProgress job={job} action="Run quality checks" canCancel={canCancel} />
      )}
      <p role="status" aria-live="polite" className="text-sm">
        {message}
      </p>
    </section>
  );
}

function QualityContent({ project }: { project: Project }) {
  const { user } = useAuth();
  const access = user ? projectAccessOf(project, user) : null;
  const personOf = (userId: string | null) => personLabel(userId, project, user?.id);
  const latest = useLatestQuality(project.id);
  const canRun = canRunQuality(access);
  const canEdit = canManageQuality(access);
  const jobs = useProjectJobs(project.id);
  const qualityJob = latestJobOf(jobs.data, 'quality');

  let report;
  if (latest.isPending) {
    report = <Skeleton className="h-64 w-full" aria-label="Loading the latest report" />;
  } else if (latest.isError) {
    report = (
      <LoadFailed
        title="We could not load the quality report"
        message={latest.error.message}
        retry={() => void latest.refetch()}
      />
    );
  } else if (latest.data === null) {
    report = (
      <EmptyState
        title="No quality report yet"
        description={
          canRun
            ? 'Run the quality checks to get a report on the clean dataset.'
            : 'A report appears here once a data engineer or data steward runs the quality checks on the clean dataset.'
        }
      />
    );
  } else {
    report = (
      <>
        <LatestReport run={latest.data} />
        <QualityHistory projectId={project.id} />
      </>
    );
  }

  return (
    <div className="space-y-6">
      <LiveJobs jobs={isRunning(qualityJob) ? [qualityJob] : []} />
      {!canEdit && (
        <Alert>
          <Info aria-hidden="true" />
          <AlertDescription>
            {canRun ? STEWARD_QUALITY_NOTE : READ_ONLY_QUALITY_NOTE}
          </AlertDescription>
        </Alert>
      )}
      {canRun && <RunQualityControl projectId={project.id} job={qualityJob} canCancel={canEdit} />}
      {report}
      {latest.isSuccess && (
        <ThresholdsSection
          projectId={project.id}
          latest={latest.data}
          personOf={personOf}
          canEdit={canEdit}
        />
      )}
    </div>
  );
}

/** Step 6: the quality report of the clean dataset, its history and the thresholds. */
export function QualityPage() {
  return (
    <ProjectPageFrame page={PAGE}>
      {(project) => <QualityContent project={project} />}
    </ProjectPageFrame>
  );
}
