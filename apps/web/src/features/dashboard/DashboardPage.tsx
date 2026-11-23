import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { EmptyState } from '@/components/EmptyState';
import { LoadFailed } from '@/components/LoadFailed';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ProjectPageFrame } from '@/features/projects/ProjectPageFrame';
import { projectPage } from '@/features/projects/steps';
import {
  DASHBOARD_RANGES,
  type Dashboard,
  type DashboardRange,
  type Project,
} from '@/lib/api-types';

import { JobsSection, ReviewSection } from './ActivitySections';
import { AiUsageSection } from './AiUsageSection';
import { BenchmarksSection } from './BenchmarksSection';
import { RANGE_LABELS } from './dashboard-labels';
import { PipelineSection } from './PipelineSection';
import { QualitySection } from './QualitySection';
import { useDashboard } from './queries';

const PAGE = projectPage('dashboard');

/** 7 / 30 / 90 days as a segmented control built from native radios (arrow keys move). */
function RangeSelector({
  value,
  onChange,
}: {
  value: DashboardRange;
  onChange: (range: DashboardRange) => void;
}) {
  return (
    <fieldset className="inline-flex rounded-lg border bg-muted p-1">
      <legend className="sr-only">Time period</legend>
      {DASHBOARD_RANGES.map((range) => (
        <label
          key={range}
          className="cursor-pointer rounded-md px-3 py-1 text-sm text-muted-foreground has-checked:bg-background has-checked:text-foreground has-checked:shadow-sm has-focus-visible:ring-2 has-focus-visible:ring-ring"
        >
          <input
            type="radio"
            name="dashboard-range"
            value={range}
            checked={value === range}
            onChange={() => {
              onChange(range);
            }}
            className="sr-only"
          />
          {RANGE_LABELS[range]}
        </label>
      ))}
    </fieldset>
  );
}

function NextStep({ projectId, dashboard }: { projectId: string; dashboard: Dashboard }) {
  const next = dashboard.pipeline.nextStep;
  const stepLabel = projectPage(next.step).label;
  return (
    <section
      aria-labelledby="dashboard-next"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/40 px-5 py-4"
    >
      <div className="space-y-1">
        <h2 id="dashboard-next" className="text-sm font-medium text-muted-foreground">
          Next step
        </h2>
        <p className="text-base">{next.text}</p>
      </div>
      <Button asChild>
        <Link to={`/projects/${projectId}/${next.step}`}>
          Go to {stepLabel}
          <ArrowRight aria-hidden="true" />
        </Link>
      </Button>
    </section>
  );
}

function DashboardBody({ projectId, dashboard }: { projectId: string; dashboard: Dashboard }) {
  const empty = dashboard.pipeline.sources.count === 0;
  return (
    <>
      {empty ? (
        <EmptyState
          className="py-8"
          title="Nothing to show yet"
          description="The numbers below fill in as you upload files and work through the steps."
          action={
            <Button asChild>
              <Link to={`/projects/${projectId}/sources`}>Upload your first file</Link>
            </Button>
          }
        />
      ) : (
        <NextStep projectId={projectId} dashboard={dashboard} />
      )}
      <PipelineSection pipeline={dashboard.pipeline} />
      <QualitySection quality={dashboard.quality} />
      <AiUsageSection ai={dashboard.ai} />
      <div className="grid gap-6 xl:grid-cols-2">
        <ReviewSection review={dashboard.review} />
        <JobsSection jobs={dashboard.jobs} />
      </div>
      <BenchmarksSection items={dashboard.benchmarks.items} />
    </>
  );
}

function DashboardContent({ project }: { project: Project }) {
  const [range, setRange] = useState<DashboardRange>('30d');
  const dashboard = useDashboard(project.id, range);

  let body;
  if (dashboard.isPending) {
    body = (
      <div role="status" aria-label="Loading the dashboard" className="space-y-6">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  } else if (dashboard.isError) {
    body = (
      <LoadFailed
        title="We could not load the dashboard"
        message={dashboard.error.message}
        retry={() => void dashboard.refetch()}
      />
    );
  } else {
    body = <DashboardBody projectId={project.id} dashboard={dashboard.data} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangeSelector value={range} onChange={setRange} />
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {dashboard.isFetching && !dashboard.isPending ? 'Updating…' : ''}
        </p>
      </div>
      {body}
    </div>
  );
}

/** Project dashboard: progress, quality, AI usage and cost, people's decisions, job health. */
export function DashboardPage() {
  return (
    <ProjectPageFrame page={PAGE}>
      {(project) => <DashboardContent project={project} />}
    </ProjectPageFrame>
  );
}
