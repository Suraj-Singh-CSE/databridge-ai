import { useState } from 'react';

import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { ApiError } from '@/lib/api';

import { NewProjectDialog } from './NewProjectDialog';
import { ProjectCard } from './ProjectCard';
import { canCreateProjects, useProjects } from './queries';

const gridClass = 'grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-5';

function LoadingCards() {
  return (
    <div className={gridClass} role="status" aria-label="Loading projects">
      {[0, 1, 2].map((key) => (
        <div key={key} className="space-y-3 rounded-xl border p-4">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-1 w-full" />
          <Skeleton className="h-3 w-1/4" />
        </div>
      ))}
    </div>
  );
}

export function ProjectsPage() {
  useDocumentTitle('Projects');
  const { user } = useAuth();
  const projects = useProjects();
  const [dialogOpen, setDialogOpen] = useState(false);
  const canCreate = user ? canCreateProjects(user.role) : false;
  const openDialog = () => {
    setDialogOpen(true);
  };

  let content;
  if (projects.isPending) {
    content = <LoadingCards />;
  } else if (projects.isError) {
    content = (
      <Alert>
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>
            We could not load your projects.{' '}
            {projects.error instanceof ApiError ? projects.error.message : ''}
          </span>
          <Button size="sm" variant="outline" onClick={() => void projects.refetch()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (projects.data.items.length === 0) {
    content = (
      <EmptyState
        title="No projects yet"
        description={
          canCreate
            ? 'Create a project, then upload 2 or more source files to combine.'
            : 'Ask an admin or data engineer to add you to a project.'
        }
        action={canCreate && <Button onClick={openDialog}>New project</Button>}
      />
    );
  } else {
    const { items, total } = projects.data;
    content = (
      <>
        <div className={gridClass}>
          {items.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
          {canCreate && (
            <section className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-4 text-center">
              <h2 className="text-sm font-medium">Start a new project</h2>
              <p className="text-sm text-muted-foreground">Upload 2 or more source files</p>
              <Button size="sm" variant="outline" className="mt-1" onClick={openDialog}>
                New project
              </Button>
            </section>
          )}
        </div>
        {total > items.length && (
          <p className="text-sm text-muted-foreground">
            Showing the {items.length} most recently updated of {total} projects.
          </p>
        )}
      </>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Projects"
        subtitle="Each project turns a set of source files into one clean dataset."
        actions={canCreate && <Button onClick={openDialog}>New project</Button>}
      />
      {content}
      {canCreate && <NewProjectDialog open={dialogOpen} onOpenChange={setDialogOpen} />}
    </div>
  );
}
