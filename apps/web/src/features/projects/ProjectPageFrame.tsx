import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';

import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { Stepper } from '@/components/Stepper';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { ApiError } from '@/lib/api';
import type { Project } from '@/lib/api-types';

import { useProject } from './queries';
import { isWorkflowStep, type ProjectPage } from './steps';

function Breadcrumb({ projectName, pageLabel }: { projectName: string; pageLabel: string }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <li>
          <Link to="/projects" className="rounded-sm hover:text-foreground">
            Projects
          </Link>
        </li>
        <li aria-hidden="true">/</li>
        <li className="max-w-60 truncate">{projectName}</li>
        <li aria-hidden="true">/</li>
        <li aria-current="page">{pageLabel}</li>
      </ol>
    </nav>
  );
}

export function ProjectPageSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading project">
      <Skeleton className="h-4 w-64" />
      <Skeleton className="h-6 w-96" />
      <Skeleton className="h-8 w-72" />
    </div>
  );
}

interface ProjectPageFrameProps {
  page: ProjectPage;
  /** Header buttons for the loaded project. */
  actions?: (project: Project) => ReactNode;
  children: (project: Project) => ReactNode;
}

/**
 * Everything a project page shares: loads the project (loading and not-found states), then
 * renders the breadcrumb, the stepper (for the six workflow steps), the header and the content.
 */
export function ProjectPageFrame({ page, actions, children }: ProjectPageFrameProps) {
  const { projectId } = useParams();
  const project = useProject(projectId);
  useDocumentTitle(project.data ? `${page.label} · ${project.data.name}` : page.label);

  if (project.isPending) return <ProjectPageSkeleton />;

  if (project.isError) {
    const notFound = project.error instanceof ApiError && project.error.status === 404;
    return (
      <EmptyState
        title={notFound ? 'Project not found' : 'We could not load this project'}
        description={
          notFound
            ? 'It may have been deleted, or you are not a member of it.'
            : project.error.message
        }
        action={
          <Button asChild variant="outline">
            <Link to="/projects">Back to projects</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <Breadcrumb projectName={project.data.name} pageLabel={page.label} />
      {isWorkflowStep(page.slug) && <Stepper current={project.data.currentStep} />}
      <PageHeader title={page.title} subtitle={page.summary} actions={actions?.(project.data)} />
      {children(project.data)}
    </div>
  );
}
