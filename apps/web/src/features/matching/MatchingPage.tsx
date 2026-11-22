import { Info } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import {
  canReviewMatches,
  canRunMatching,
  projectAccessOf,
  READ_ONLY_MATCHING_NOTE,
  STEWARD_MATCHING_NOTE,
} from '@/features/projects/access';
import { ProjectPageFrame } from '@/features/projects/ProjectPageFrame';
import { projectPage } from '@/features/projects/steps';
import { LiveJobs } from '@/features/sources/LiveJobs';
import { useProjectJobs, useSources } from '@/features/sources/queries';
import type { JobType, Project } from '@/lib/api-types';
import { isTerminalStatus } from '@/lib/job-events';

import { ClustersSection } from './ClustersSection';
import { PipelineFailed, PipelinePanel } from './PipelinePanel';
import {
  useCandidateSummary,
  useClusterSummary,
  useScoreSummary,
  type MatchingJobType,
} from './queries';

const PAGE = projectPage('matching');

const MATCHING_JOBS: ReadonlySet<JobType> = new Set<MatchingJobType>([
  'standardise',
  'candidates',
  'scoring',
  'pair_review',
  'clustering',
]);

function MatchingContent({ project }: { project: Project }) {
  const { user } = useAuth();
  const access = user ? projectAccessOf(project, user) : null;
  const canRun = canRunMatching(access);
  const canDecide = canReviewMatches(access);
  const sources = useSources(project.id);
  const jobs = useProjectJobs(project.id);
  const candidates = useCandidateSummary(project.id);
  const scores = useScoreSummary(project.id);
  const clusters = useClusterSummary(project.id);
  const running = (jobs.data ?? []).filter(
    (job) => MATCHING_JOBS.has(job.type) && !isTerminalStatus(job.status),
  );

  let pipeline;
  if (sources.isPending) {
    pipeline = <Skeleton className="h-64 w-full" aria-label="Loading matching steps" />;
  } else if (sources.isError) {
    pipeline = (
      <PipelineFailed message={sources.error.message} retry={() => void sources.refetch()} />
    );
  } else {
    pipeline = (
      <PipelinePanel
        data={{
          projectId: project.id,
          sources: sources.data,
          jobs: jobs.data,
          candidates,
          scores,
          clusters,
          canRun,
        }}
      />
    );
  }

  let results = null;
  if (clusters.isSuccess) {
    results =
      clusters.data === null ? (
        <EmptyState
          title="No customers yet"
          description="Customers appear here after “Group records” (step 5) has run."
        />
      ) : (
        <ClustersSection projectId={project.id} view={clusters.data} canDecide={canDecide} />
      );
  }

  return (
    <div className="space-y-6">
      <LiveJobs jobs={running} />
      {!canRun && (
        <Alert>
          <Info aria-hidden="true" />
          <AlertDescription>
            {canDecide ? STEWARD_MATCHING_NOTE : READ_ONLY_MATCHING_NOTE}
          </AlertDescription>
        </Alert>
      )}
      {pipeline}
      {results}
    </div>
  );
}

/** Step 4: run the matching steps and look at the proposed customers. */
export function MatchingPage() {
  return (
    <ProjectPageFrame page={PAGE}>
      {(project) => <MatchingContent project={project} />}
    </ProjectPageFrame>
  );
}
