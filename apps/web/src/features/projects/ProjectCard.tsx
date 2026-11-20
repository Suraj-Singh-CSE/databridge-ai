import { Link } from 'react-router';

import { ProgressBar } from '@/components/ProgressBar';
import { Badge } from '@/components/ui/badge';
import type { Project } from '@/lib/api-types';
import { formatRelativeTime } from '@/lib/relative-time';

import { STEP_LABELS, stepNumber } from './steps';

const STEP_COUNT = 6;

/** A project on the Projects page; the whole card opens the project's Sources step. */
export function ProjectCard({ project, now }: { project: Project; now?: Date }) {
  const step = stepNumber(project.currentStep);
  const stepLabel = STEP_LABELS[project.currentStep];

  return (
    <Link
      to={`/projects/${encodeURIComponent(project.id)}/sources`}
      className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground shadow-xs transition-colors outline-none hover:border-foreground/20 focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 text-base leading-snug font-medium break-words">{project.name}</h2>
        <Badge variant="secondary" className="mt-0.5">
          {project.status === 'archived' ? 'Archived' : 'In progress'}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">No sources yet</p>
      <div className="space-y-2">
        <p className="text-sm font-medium">
          Step {step} of {STEP_COUNT} · {stepLabel}
        </p>
        <ProgressBar value={step / STEP_COUNT} label={`${project.name} progress`} />
      </div>
      <p className="text-xs text-muted-foreground">
        Updated {formatRelativeTime(project.updatedAt, now)}
      </p>
    </Link>
  );
}
