import { Info } from 'lucide-react';
import { useState } from 'react';

import { EmptyState } from '@/components/EmptyState';
import { LoadFailed } from '@/components/LoadFailed';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import {
  canManagePipeline,
  canStartExport,
  projectAccessOf,
  READ_ONLY_PIPELINE_NOTE,
  STEWARD_PIPELINE_NOTE,
} from '@/features/projects/access';
import { personLabel } from '@/features/projects/people';
import { ProjectPageFrame } from '@/features/projects/ProjectPageFrame';
import { projectPage } from '@/features/projects/steps';
import { LiveJobs } from '@/features/sources/LiveJobs';
import { useProjectJobs } from '@/features/sources/queries';
import type { Job, Project, SqlVersionSummary } from '@/lib/api-types';

import { ExportsSection } from './ExportsSection';
import { latestJobOf, useSqlVersion, useSqlVersions } from './queries';
import { DraftSqlControl, RunSqlControl } from './SqlActions';
import { isRunning } from './use-job-end';
import { VersionDetails } from './VersionDetails';
import { VersionsSection } from './VersionsSection';

const PIPELINE_JOBS = new Set(['sql_draft', 'sql_run', 'export']);

const PAGE = projectPage('pipeline');

type PersonOf = (userId: string | null) => string;

function CurrentSql({
  projectId,
  approved,
  personOf,
  runJob,
  canRun,
}: {
  projectId: string;
  approved: SqlVersionSummary;
  personOf: PersonOf;
  runJob: Job | null;
  canRun: boolean;
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 id="current-sql" className="text-base font-medium">
          Current SQL · version {approved.version}
        </h2>
        {canRun && <RunSqlControl projectId={projectId} version={approved} job={runJob} />}
      </div>
      {body}
    </section>
  );
}

interface SqlSectionsProps {
  projectId: string;
  personOf: PersonOf;
  selectedId: string | null;
  onSelect: (versionId: string | null) => void;
  canManage: boolean;
  runJob: Job | null;
  decisionMessage: string | null;
  onDecisionMessage: (text: string | null) => void;
}

function SqlSections({
  projectId,
  personOf,
  selectedId,
  onSelect,
  canManage,
  runJob,
  decisionMessage,
  onDecisionMessage,
}: SqlSectionsProps) {
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
        description={
          canManage
            ? 'Draft the SQL that builds the clean dataset from the customers. Its versions and tests appear here.'
            : 'The SQL that builds the clean dataset appears here once a data engineer drafts it from the approved customers.'
        }
      />
    );
  }
  const approved = versions.data.find((v) => v.status === 'approved') ?? null;
  return (
    <>
      {approved ? (
        <CurrentSql
          projectId={projectId}
          approved={approved}
          personOf={personOf}
          runJob={runJob}
          canRun={canManage}
        />
      ) : (
        <EmptyState
          title="No approved SQL yet"
          description="A version becomes the current SQL once a data engineer approves it. Open a version below to see its tests."
        />
      )}
      <VersionsSection
        projectId={projectId}
        versions={versions.data}
        personOf={personOf}
        selectedId={selectedId}
        onSelect={onSelect}
        canDecide={canManage}
        message={decisionMessage}
        onMessage={onDecisionMessage}
      />
    </>
  );
}

function PipelineContent({ project }: { project: Project }) {
  const { user } = useAuth();
  const access = user ? projectAccessOf(project, user) : null;
  const personOf: PersonOf = (userId) => personLabel(userId, project, user?.id);
  const canManage = canManagePipeline(access);
  const canExport = canStartExport(access);
  const jobs = useProjectJobs(project.id);
  const running = (jobs.data ?? []).filter((job) => PIPELINE_JOBS.has(job.type) && isRunning(job));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decisionMessage, setDecisionMessage] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <LiveJobs jobs={running} />
      {!canManage && (
        <Alert>
          <Info aria-hidden="true" />
          <AlertDescription>
            {canExport ? STEWARD_PIPELINE_NOTE : READ_ONLY_PIPELINE_NOTE}
          </AlertDescription>
        </Alert>
      )}
      {canManage && (
        <DraftSqlControl
          projectId={project.id}
          job={latestJobOf(jobs.data, 'sql_draft')}
          canCancel={canManage}
          onDrafted={setSelectedId}
        />
      )}
      <SqlSections
        projectId={project.id}
        personOf={personOf}
        selectedId={selectedId}
        onSelect={setSelectedId}
        canManage={canManage}
        runJob={latestJobOf(jobs.data, 'sql_run')}
        decisionMessage={decisionMessage}
        onDecisionMessage={setDecisionMessage}
      />
      <ExportsSection
        projectId={project.id}
        personOf={personOf}
        job={latestJobOf(jobs.data, 'export')}
        canStart={canExport}
        canDelete={canManage}
      />
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
