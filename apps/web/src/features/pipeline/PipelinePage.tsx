import { Info } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { LoadFailed } from '@/components/LoadFailed';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import {
  canManagePipeline,
  projectAccessOf,
  READ_ONLY_PIPELINE_NOTE,
} from '@/features/projects/access';
import { personLabel } from '@/features/projects/people';
import { ProjectPageFrame } from '@/features/projects/ProjectPageFrame';
import { projectPage } from '@/features/projects/steps';
import type { Project, SqlVersionSummary } from '@/lib/api-types';

import { ExportsSection } from './ExportsSection';
import { useSqlVersion, useSqlVersions } from './queries';
import { VersionDetails } from './VersionDetails';
import { VersionsSection } from './VersionsSection';

const PAGE = projectPage('pipeline');

type PersonOf = (userId: string | null) => string;

function CurrentSql({
  projectId,
  approved,
  personOf,
}: {
  projectId: string;
  approved: SqlVersionSummary;
  personOf: PersonOf;
}) {
  const version = useSqlVersion(projectId, approved.id);
  let body;
  if (version.isPending) {
    body = <Skeleton className="h-64 w-full" aria-label="Loading the current SQL" />;
  } else if (version.isError) {
    body = (
      <LoadFailed
        title="We could not load the current SQL"
        message={version.error.message}
        retry={() => void version.refetch()}
      />
    );
  } else {
    body = <VersionDetails version={version.data} personOf={personOf} />;
  }
  return (
    <section aria-labelledby="current-sql" className="space-y-4 rounded-xl border px-5 py-4">
      <h2 id="current-sql" className="text-base font-medium">
        Current SQL · version {approved.version}
      </h2>
      {body}
    </section>
  );
}

function SqlSections({ projectId, personOf }: { projectId: string; personOf: PersonOf }) {
  const versions = useSqlVersions(projectId);
  if (versions.isPending) {
    return <Skeleton className="h-64 w-full" aria-label="Loading SQL versions" />;
  }
  if (versions.isError) {
    return (
      <LoadFailed
        title="We could not load the SQL versions"
        message={versions.error.message}
        retry={() => void versions.refetch()}
      />
    );
  }
  if (versions.data.length === 0) {
    return (
      <EmptyState
        title="No SQL version yet"
        description="The SQL that builds the clean dataset appears here once a data engineer drafts it from the approved customers."
      />
    );
  }
  const approved = versions.data.find((v) => v.status === 'approved') ?? null;
  return (
    <>
      {approved ? (
        <CurrentSql projectId={projectId} approved={approved} personOf={personOf} />
      ) : (
        <EmptyState
          title="No approved SQL yet"
          description="A version becomes the current SQL once a data engineer approves it. Open a version below to see its tests."
        />
      )}
      <VersionsSection projectId={projectId} versions={versions.data} personOf={personOf} />
    </>
  );
}

function PipelineContent({ project }: { project: Project }) {
  const { user } = useAuth();
  const access = user ? projectAccessOf(project, user) : null;
  const personOf: PersonOf = (userId) => personLabel(userId, project, user?.id);

  return (
    <div className="space-y-6">
      {!canManagePipeline(access) && (
        <Alert>
          <Info aria-hidden="true" />
          <AlertDescription>{READ_ONLY_PIPELINE_NOTE}</AlertDescription>
        </Alert>
      )}
      <SqlSections projectId={project.id} personOf={personOf} />
      <ExportsSection projectId={project.id} personOf={personOf} />
    </div>
  );
}

/** Step 5: the SQL that builds the clean dataset, its versions and tests, and the exports. */
export function PipelinePage() {
  return (
    <ProjectPageFrame page={PAGE}>
      {(project) => <PipelineContent project={project} />}
    </ProjectPageFrame>
  );
}
