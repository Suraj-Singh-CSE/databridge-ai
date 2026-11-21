import { Suspense, type ComponentType } from 'react';
import { Navigate, type RouteObject } from 'react-router';

import {
  CreateAccountPage,
  MappingPage,
  ProfilePage,
  SignInPage,
  SourcesPage,
} from '@/app/lazy-pages';
import { AppShell } from '@/components/AppShell';
import { FullPageStatus } from '@/components/FullPageStatus';
import { GuestOnly, RequireAuth } from '@/features/auth/routes';
import { ProjectPageSkeleton } from '@/features/projects/ProjectPageFrame';
import { ProjectsPage } from '@/features/projects/ProjectsPage';
import { ProjectStepPage } from '@/features/projects/ProjectStepPage';
import { PROJECT_PAGES, type ProjectPage } from '@/features/projects/steps';
import { NotFoundPage } from '@/pages/NotFoundPage';

/** Built pages per step; the others are placeholders until their milestone. */
const STEP_PAGES: Partial<Record<ProjectPage['slug'], ComponentType>> = {
  sources: SourcesPage,
  profile: ProfilePage,
  mapping: MappingPage,
};

function stepElement(page: ProjectPage) {
  const Page = STEP_PAGES[page.slug];
  if (!Page) return <ProjectStepPage key={page.slug} page={page} />;
  return (
    <Suspense fallback={<ProjectPageSkeleton />}>
      <Page />
    </Suspense>
  );
}

const authFallback = <FullPageStatus label="Loading" />;

export const routes: RouteObject[] = [
  { index: true, element: <Navigate to="/projects" replace /> },
  {
    element: <GuestOnly />,
    children: [
      {
        path: 'sign-in',
        element: (
          <Suspense fallback={authFallback}>
            <SignInPage />
          </Suspense>
        ),
      },
      {
        path: 'create-account',
        element: (
          <Suspense fallback={authFallback}>
            <CreateAccountPage />
          </Suspense>
        ),
      },
    ],
  },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppShell />,
        children: [
          { path: 'projects', element: <ProjectsPage /> },
          {
            path: 'projects/:projectId',
            children: [
              { index: true, element: <Navigate to="sources" replace /> },
              ...PROJECT_PAGES.map((page) => ({ path: page.slug, element: stepElement(page) })),
            ],
          },
        ],
      },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
];
