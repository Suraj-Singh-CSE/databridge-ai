import { useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { EmptyState } from '@/components/EmptyState';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import {
  canManageSources,
  projectAccessOf,
  READ_ONLY_SOURCES_NOTE,
} from '@/features/projects/access';
import { ProjectPageFrame } from '@/features/projects/ProjectPageFrame';
import { projectPage } from '@/features/projects/steps';
import type { Project, Source } from '@/lib/api-types';

import { DeleteSourceDialog } from './DeleteSourceDialog';
import { LiveJobs } from './LiveJobs';
import { PreviewDialog } from './PreviewDialog';
import { activeProfileJobs, sourceKeys, useProjectJobs, useSources } from './queries';
import { MAX_SOURCES } from './source-rules';
import { SourcesTable } from './SourcesTable';
import { UploadArea } from './UploadArea';
import { useProfileActions } from './use-profile-actions';

const PAGE = projectPage('sources');

function LoadingRows() {
  return (
    <div role="status" aria-label="Loading files" className="space-y-2 rounded-xl border p-3">
      <Skeleton className="h-6 w-full" />
      <Skeleton className="h-6 w-full" />
      <Skeleton className="h-6 w-3/4" />
    </div>
  );
}

function SourcesContent({ project }: { project: Project }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const sources = useSources(project.id);
  const jobs = useProjectJobs(project.id);
  const actions = useProfileActions(project.id);
  const [previewing, setPreviewing] = useState<Source | null>(null);
  const [removing, setRemoving] = useState<Source | null>(null);
  const canManage = user ? canManageSources(projectAccessOf(project, user)) : false;
  const active = activeProfileJobs(jobs.data);

  const onUploaded = (source: Source) => {
    queryClient.setQueryData<Source[]>(sourceKeys.list(project.id), (list = []) => [
      source,
      ...list.filter((item) => item.id !== source.id),
    ]);
    void queryClient.invalidateQueries({ queryKey: sourceKeys.list(project.id) });
    // Profiling is a separate job (ADR 0011); start it straight away for a new upload.
    actions.start(source);
  };

  let list;
  if (sources.isPending) {
    list = <LoadingRows />;
  } else if (sources.isError) {
    list = (
      <Alert>
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>We could not load the files. {sources.error.message}</span>
          <Button size="sm" variant="outline" onClick={() => void sources.refetch()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (sources.data.length === 0) {
    list = (
      <EmptyState
        title="No files yet"
        description={
          canManage
            ? 'Upload a CSV or Excel file from each system you want to combine, for example your CRM and billing exports.'
            : 'No one has uploaded a file to this project yet.'
        }
        className="py-10"
      />
    );
  } else {
    list = (
      <>
        <SourcesTable
          sources={sources.data}
          activeJobs={active}
          canManage={canManage}
          onPreview={setPreviewing}
          onRemove={setRemoving}
          onProfile={actions.start}
          onCancel={actions.cancel}
          starting={actions.starting}
          cancelling={actions.cancelling}
        />
        <p className="text-sm text-muted-foreground">
          {sources.data.length} of {MAX_SOURCES} files used. Profiling runs in the background; you
          can leave this page and come back.
        </p>
      </>
    );
  }

  return (
    <div className="space-y-5">
      {canManage ? (
        <UploadArea
          projectId={project.id}
          sourceCount={sources.data?.length ?? 0}
          onUploaded={onUploaded}
        />
      ) : (
        <Alert role="note">
          <Info aria-hidden="true" />
          <AlertDescription>{READ_ONLY_SOURCES_NOTE}</AlertDescription>
        </Alert>
      )}
      {list}
      <LiveJobs jobs={active.values()} />
      <PreviewDialog
        projectId={project.id}
        source={previewing}
        onClose={() => {
          setPreviewing(null);
        }}
      />
      {canManage && (
        <DeleteSourceDialog
          projectId={project.id}
          source={removing}
          onClose={() => {
            setRemoving(null);
          }}
        />
      )}
    </div>
  );
}

/** Step 1: upload files, watch them being profiled, preview or remove them. */
export function SourcesPage() {
  return (
    <ProjectPageFrame
      page={PAGE}
      actions={(project) => (
        <Button asChild>
          <Link to={`/projects/${encodeURIComponent(project.id)}/profile`}>
            Continue to profiling
          </Link>
        </Button>
      )}
    >
      {(project) => <SourcesContent project={project} />}
    </ProjectPageFrame>
  );
}
