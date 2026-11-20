import { PROJECT_STEPS, type ProjectStep } from '@/lib/api-types';

/** A page inside a project: the six workflow steps plus dashboard and assistant. */
export const PROJECT_PAGES = [
  {
    slug: 'sources',
    label: 'Sources',
    milestone: 'M2',
    title: 'Add your source files',
    summary: 'Upload the files from each system you want to combine.',
  },
  {
    slug: 'profile',
    label: 'Profile',
    milestone: 'M2',
    title: "What's in your data",
    summary: 'See the type, fill rate and patterns of every column.',
  },
  {
    slug: 'mapping',
    label: 'Mapping',
    milestone: 'M3',
    title: 'Columns that match',
    summary: 'Review how columns from your sources map to the target schema.',
  },
  {
    slug: 'matching',
    label: 'Matching',
    milestone: 'M4',
    title: 'Is this the same person?',
    summary: 'Decide which records describe the same customer.',
  },
  {
    slug: 'pipeline',
    label: 'Pipeline',
    milestone: 'M5',
    title: 'Build the clean dataset',
    summary: 'Generate, test and approve the SQL that builds the golden records.',
  },
  {
    slug: 'quality',
    label: 'Data quality',
    milestone: 'M5',
    title: 'Data quality report',
    summary: 'Check the clean dataset against your quality rules.',
  },
  {
    slug: 'dashboard',
    label: 'Dashboard',
    milestone: 'M6',
    title: 'Dashboard',
    summary: 'Accuracy, cost and activity for this project.',
  },
  {
    slug: 'assistant',
    label: 'Assistant',
    milestone: 'M6',
    title: 'Assistant',
    summary: 'Ask questions about your data and the decisions made so far.',
  },
] as const;

export type ProjectPage = (typeof PROJECT_PAGES)[number];
export type ProjectPageSlug = ProjectPage['slug'];

/** Labels used by the stepper and the project cards. */
export const STEP_LABELS: Record<ProjectStep, string> = {
  sources: 'Sources',
  profile: 'Profile',
  mapping: 'Mapping',
  matching: 'Matching',
  pipeline: 'Pipeline',
  quality: 'Quality',
};

/** 1-based position of a step in the workflow. */
export function stepNumber(step: ProjectStep): number {
  return PROJECT_STEPS.indexOf(step) + 1;
}

export function isWorkflowStep(slug: ProjectPageSlug): slug is ProjectStep {
  return (PROJECT_STEPS as readonly string[]).includes(slug);
}

export type StepState = 'done' | 'current' | 'todo';

/** Where `step` stands when the project is at `current`. */
export function stepState(step: ProjectStep, current: ProjectStep): StepState {
  const index = PROJECT_STEPS.indexOf(step);
  const currentIndex = PROJECT_STEPS.indexOf(current);
  if (index < currentIndex) return 'done';
  return index === currentIndex ? 'current' : 'todo';
}
