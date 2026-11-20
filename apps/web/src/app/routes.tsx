import { Navigate, type RouteObject } from 'react-router';

import { AppShell } from '@/components/AppShell';
import { CreateAccountPage } from '@/features/auth/CreateAccountPage';
import { GuestOnly, RequireAuth } from '@/features/auth/routes';
import { SignInPage } from '@/features/auth/SignInPage';
import { ProjectsPage } from '@/features/projects/ProjectsPage';
import { ProjectStepPage } from '@/features/projects/ProjectStepPage';
import { PROJECT_PAGES } from '@/features/projects/steps';
import { NotFoundPage } from '@/pages/NotFoundPage';

export const routes: RouteObject[] = [
  { index: true, element: <Navigate to="/projects" replace /> },
  {
    element: <GuestOnly />,
    children: [
      { path: 'sign-in', element: <SignInPage /> },
      { path: 'create-account', element: <CreateAccountPage /> },
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
              ...PROJECT_PAGES.map((page) => ({
                path: page.slug,
                element: <ProjectStepPage key={page.slug} page={page} />,
              })),
            ],
          },
        ],
      },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
];
