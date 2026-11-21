import { EmptyState } from '@/components/EmptyState';

import { ProjectPageFrame } from './ProjectPageFrame';
import type { ProjectPage } from './steps';

/** A project page whose real content arrives in a later milestone. */
export function ProjectStepPage({ page }: { page: ProjectPage }) {
  return (
    <ProjectPageFrame page={page}>
      {() => (
        <EmptyState
          title={`Coming in milestone ${page.milestone}`}
          description={`This screen is part of milestone ${page.milestone}. Your project is saved; come back when it is ready.`}
        />
      )}
    </ProjectPageFrame>
  );
}
