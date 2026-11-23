import { lazy } from 'react';

// Pages loaded on demand, so the first download holds only the shell and the projects list.
// The auth pages carry the form libraries (react-hook-form, Zod); the step pages their features.
export const SignInPage = lazy(() =>
  import('@/features/auth/SignInPage').then((m) => ({ default: m.SignInPage })),
);
export const CreateAccountPage = lazy(() =>
  import('@/features/auth/CreateAccountPage').then((m) => ({ default: m.CreateAccountPage })),
);
export const SourcesPage = lazy(() =>
  import('@/features/sources/SourcesPage').then((m) => ({ default: m.SourcesPage })),
);
export const ProfilePage = lazy(() =>
  import('@/features/profile/ProfilePage').then((m) => ({ default: m.ProfilePage })),
);
export const MappingPage = lazy(() =>
  import('@/features/mapping/MappingPage').then((m) => ({ default: m.MappingPage })),
);
export const MatchingPage = lazy(() =>
  import('@/features/matching/MatchingPage').then((m) => ({ default: m.MatchingPage })),
);
export const PipelinePage = lazy(() =>
  import('@/features/pipeline/PipelinePage').then((m) => ({ default: m.PipelinePage })),
);
export const QualityPage = lazy(() =>
  import('@/features/quality/QualityPage').then((m) => ({ default: m.QualityPage })),
);
export const DashboardPage = lazy(() =>
  import('@/features/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })),
);
