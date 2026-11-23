import { Info } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { LoadFailed } from '@/components/LoadFailed';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import {
  canManageQuality,
  projectAccessOf,
  READ_ONLY_QUALITY_NOTE,
} from '@/features/projects/access';
import { personLabel } from '@/features/projects/people';
import { ProjectPageFrame } from '@/features/projects/ProjectPageFrame';
import { projectPage } from '@/features/projects/steps';
import type { Project } from '@/lib/api-types';

import { LatestReport } from './LatestReport';
import { QualityHistory } from './QualityHistory';
import { useLatestQuality } from './queries';
import { ThresholdsSection } from './ThresholdsSection';

const PAGE = projectPage('quality');

function QualityContent({ project }: { project: Project }) {
  const { user } = useAuth();
  const access = user ? projectAccessOf(project, user) : null;
  const personOf = (userId: string | null) => personLabel(userId, project, user?.id);
  const latest = useLatestQuality(project.id);

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
        description="A report appears here once a data engineer runs the quality checks on the clean dataset."
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
      {!canManageQuality(access) && (
        <Alert>
          <Info aria-hidden="true" />
          <AlertDescription>{READ_ONLY_QUALITY_NOTE}</AlertDescription>
        </Alert>
      )}
      {report}
      {latest.isSuccess && (
        <ThresholdsSection projectId={project.id} latest={latest.data} personOf={personOf} />
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
