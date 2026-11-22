import { CircleAlert, LoaderCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { ProgressBar } from '@/components/ProgressBar';
import { StatusPill } from '@/components/StatusPill';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useCancelJob } from '@/features/sources/queries';
import type {
  CandidateSummaryView,
  ClusterSummaryView,
  Job,
  ScoreSummaryView,
  Source,
} from '@/lib/api-types';
import { isTerminalStatus } from '@/lib/job-events';

import {
  bandCount,
  canClean,
  cleanState,
  formatCount,
  jobErrorText,
  plural,
  STEP_STATES,
  stepState,
  type JobErrorText,
  type StepState,
} from './matching-labels';
import { latestJob, useStartMatchingJob, type StartMatchingJob } from './queries';

/** A summary query as the panel needs it: loading, failed (with retry), or its data. */
export interface Loaded<T> {
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  data: T | undefined;
  refetch: () => unknown;
}

export interface PipelineData {
  projectId: string;
  sources: Source[];
  jobs: Job[] | undefined;
  candidates: Loaded<CandidateSummaryView | null>;
  scores: Loaded<ScoreSummaryView | null>;
  clusters: Loaded<ClusterSummaryView | null>;
  canRun: boolean;
}

function ErrorNotice({
  error,
  projectId,
  sourceId,
}: {
  error: JobErrorText;
  projectId: string;
  sourceId?: string | undefined;
}) {
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const mappingPath = sourceId
    ? `${base}/mapping?source=${encodeURIComponent(sourceId)}`
    : `${base}/mapping`;
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm">
      <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
      <span>{error.text}</span>
      {error.link === 'mapping' && (
        <Link to={mappingPath} className="font-medium underline underline-offset-4">
          Go to Mapping
        </Link>
      )}
      {error.link === 'sources' && (
        <Link to={`${base}/profile`} className="font-medium underline underline-offset-4">
          Go to Profile
        </Link>
      )}
    </p>
  );
}

interface JobControlProps {
  projectId: string;
  job: Job | null;
  request: StartMatchingJob;
  /** e.g. "Find possible duplicates" or "Clean crm_customers.csv"; names the buttons. */
  action: string;
  runLabel: string;
  canRun: boolean;
  /** Why the step cannot run now; the button is disabled and this is shown. */
  disabledReason?: string | null;
}

/** Run / re-run a matching job, or its live progress with cancel while it runs. */
function JobControl({
  projectId,
  job,
  request,
  action,
  runLabel,
  canRun,
  disabledReason = null,
}: JobControlProps) {
  const start = useStartMatchingJob(projectId);
  const cancel = useCancelJob();
  const [error, setError] = useState<JobErrorText | null>(null);
  const running = job !== null && !isTerminalStatus(job.status);

  if (running) {
    return (
      <div className="w-full space-y-2">
        <div role="status" className="space-y-1.5">
          <p className="text-sm">
            {job.status === 'queued' ? 'Waiting to start' : `${job.progress}% done`}
            {job.message && <span className="text-muted-foreground"> · {job.message}</span>}
          </p>
          <ProgressBar value={job.progress / 100} label={action} />
        </div>
        {canRun && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={`Cancel: ${action}`}
            disabled={cancel.isPending}
            onClick={() => {
              setError(null);
              cancel.mutate(job.id, {
                onError: (e) => {
                  setError(jobErrorText(e));
                },
              });
            }}
          >
            Cancel
          </Button>
        )}
        <div aria-live="polite">
          {error && <ErrorNotice error={error} projectId={projectId} sourceId={request.sourceId} />}
        </div>
      </div>
    );
  }

  const failed = job?.status === 'failed' ? (job.error?.message ?? job.message) : null;
  return (
    <div className="space-y-2">
      {failed && (
        <p className="flex items-center gap-2 text-sm">
          <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
          The last run failed: {failed}
        </p>
      )}
      {canRun && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={`${runLabel}: ${action}`}
          disabled={start.isPending || disabledReason !== null}
          onClick={() => {
            setError(null);
            start.mutate(request, {
              onError: (e) => {
                setError(jobErrorText(e));
              },
            });
          }}
        >
          {start.isPending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
          {runLabel}
        </Button>
      )}
      {disabledReason && <p className="text-sm text-muted-foreground">{disabledReason}</p>}
      <div aria-live="polite">
        {error && <ErrorNotice error={error} projectId={projectId} sourceId={request.sourceId} />}
      </div>
    </div>
  );
}

function StatePill({ state }: { state: StepState }) {
  const { label, tone } = STEP_STATES[state];
  return <StatusPill tone={tone}>{label}</StatusPill>;
}

/** A step's state once its summary has loaded; nothing while loading or failed. */
function settled<T>(query: Loaded<T>, state: StepState): StepState | null {
  return query.isPending || query.isError ? null : state;
}

function runLabelOf(state: StepState): string {
  return state === 'not_run' ? 'Run' : 'Re-run';
}

interface StepProps {
  number: number;
  title: string;
  explanation: string;
  state: StepState | null;
  optional?: boolean;
  summary: ReactNode;
  control?: ReactNode;
}

function Step({
  number,
  title,
  explanation,
  state,
  optional = false,
  summary,
  control,
}: StepProps) {
  return (
    <li className="grid gap-3 border-t px-5 py-4 first:border-t-0 md:grid-cols-[1fr_minmax(14rem,auto)]">
      <div className="space-y-1">
        <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span className="text-muted-foreground">{number}.</span>
          {title}
          {state && <StatePill state={state} />}
          {optional && <StatusPill tone="neutral">Optional</StatusPill>}
        </h3>
        <p className="text-sm text-muted-foreground">{explanation}</p>
        <div className="text-sm">{summary}</div>
        {state === 'outdated' && (
          <p className="text-sm">Something earlier changed since this ran. Re-run this step.</p>
        )}
      </div>
      {control && <div className="md:justify-self-end">{control}</div>}
    </li>
  );
}

/** Counts of a summary, or its loading / error state. */
function SummaryText<T>({
  query,
  what,
  render,
}: {
  query: Loaded<T | null>;
  what: string;
  render: (data: T) => ReactNode;
}) {
  if (query.isPending) return <Skeleton className="h-4 w-48" aria-label={`Loading ${what}`} />;
  if (query.isError) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        We could not load {what}. {query.error?.message}
        <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </span>
    );
  }
  if (query.data === null || query.data === undefined) {
    return <span className="text-muted-foreground">Not run yet.</span>;
  }
  return <>{render(query.data)}</>;
}

function cleanOverall(sources: Source[]): StepState {
  const states = sources.filter(canClean).map(cleanState);
  if (states.length === 0) return 'not_run';
  if (states.includes('outdated')) return 'outdated';
  return states.every((s) => s === 'done') ? 'done' : 'not_run';
}

function CleanSources({ data }: { data: PipelineData }) {
  const { projectId, sources, jobs, canRun } = data;
  if (sources.length === 0) {
    return <p className="text-muted-foreground">No files yet. Upload them on the Sources step.</p>;
  }
  return (
    <ul className="mt-2 space-y-3">
      {sources.map((source) => {
        const state = cleanState(source);
        const summary = source.standardisation;
        return (
          <li key={source.id} className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-0.5">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{source.originalFilename}</span>
                <StatePill state={state} />
              </p>
              {summary && (
                <p className="text-muted-foreground">
                  {plural(summary.rowCount, 'row', 'rows')} cleaned ·{' '}
                  {formatCount(summary.rowsWithIssues)} with issues
                </p>
              )}
              {!canClean(source) && (
                <p className="text-muted-foreground">Profile and map this file first.</p>
              )}
            </div>
            {canClean(source) && (
              <JobControl
                projectId={projectId}
                job={latestJob(jobs, 'standardise', source.id)}
                request={{ type: 'standardise', sourceId: source.id }}
                action={`Clean ${source.originalFilename}`}
                runLabel={state === 'not_run' ? 'Clean' : 'Re-clean'}
                canRun={canRun}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** "Prepare matching": the five jobs that turn cleaned rows into proposed customers. */
export function PipelinePanel({ data }: { data: PipelineData }) {
  const { projectId, jobs, candidates, scores, clusters, canRun } = data;
  const scoreView = scores.data ?? null;
  const maybe = scoreView ? bandCount(scoreView.summary, 'maybe') : 0;
  const aiReview = scoreView?.summary.aiReview ?? null;
  let reviewState: StepState = 'not_run';
  if (aiReview) reviewState = scoreView?.outdated ? 'outdated' : 'done';
  let reviewBlocked: string | null = null;
  if (!scores.isPending && !scoreView) reviewBlocked = 'Score the pairs first.';
  else if (scoreView && maybe === 0) reviewBlocked = 'No unclear pairs to review.';

  const control = (
    type: 'candidates' | 'scoring' | 'pair_review' | 'clustering',
    action: string,
    state: StepState,
    disabledReason: string | null = null,
  ) => (
    <JobControl
      projectId={projectId}
      job={latestJob(jobs, type)}
      request={{ type }}
      action={action}
      runLabel={runLabelOf(state)}
      canRun={canRun}
      disabledReason={disabledReason}
    />
  );
  const candidateState = stepState(candidates.data ?? null);
  const scoreState = stepState(scoreView);
  const clusterState = stepState(clusters.data ?? null);

  return (
    <section aria-labelledby="prepare-matching" className="rounded-xl border">
      <div className="border-b px-5 py-4">
        <h2 id="prepare-matching" className="text-base font-medium">
          Prepare matching
        </h2>
        <p className="text-sm text-muted-foreground">
          Run these steps in order. Each one uses the result of the step before it.
        </p>
      </div>
      <ol>
        <Step
          number={1}
          title="Clean data"
          explanation="Applies each file's reviewed mapping: tidies names, phone numbers, emails and dates so records can be compared."
          state={cleanOverall(data.sources)}
          summary={<CleanSources data={data} />}
        />
        <Step
          number={2}
          title="Find possible duplicates"
          explanation="Pairs up records that share something, like a phone number or email, so only likely pairs are compared."
          state={settled(candidates, candidateState)}
          summary={
            <SummaryText
              query={candidates}
              what="the possible duplicates"
              render={({ summary }) =>
                `${plural(summary.pairCount, 'possible pair', 'possible pairs')} among ${plural(summary.recordCount, 'record', 'records')}`
              }
            />
          }
          control={control('candidates', 'Find possible duplicates', candidateState)}
        />
        <Step
          number={3}
          title="Score pairs"
          explanation="Gives every pair a score for how likely the two records are the same person."
          state={settled(scores, scoreState)}
          summary={
            <SummaryText
              query={scores}
              what="the scores"
              render={({ summary }) =>
                `${plural(bandCount(summary, 'match'), 'likely match', 'likely matches')} · ${plural(bandCount(summary, 'maybe'), 'unclear pair', 'unclear pairs')} · ${plural(bandCount(summary, 'non_match'), 'likely different', 'likely different')}`
              }
            />
          }
          control={control('scoring', 'Score pairs', scoreState)}
        />
        <Step
          number={4}
          title="AI review of unclear pairs"
          explanation="The AI looks at the unclear pairs and suggests same or different. Personal data is masked first. You still decide."
          optional
          state={settled(scores, reviewState)}
          summary={
            <SummaryText
              query={scores}
              what="the AI review"
              render={() =>
                aiReview
                  ? `${plural(aiReview.reviewed, 'pair', 'pairs')} reviewed · ${formatCount(aiReview.suggestedMatch)} suggested same · ${formatCount(aiReview.suggestedNonMatch)} suggested different`
                  : 'Not run yet.'
              }
            />
          }
          control={control('pair_review', 'AI review of unclear pairs', reviewState, reviewBlocked)}
        />
        <Step
          number={5}
          title="Group records"
          explanation="Joins matching pairs into groups, one per customer, and proposes a golden record for each."
          state={settled(clusters, clusterState)}
          summary={
            <SummaryText
              query={clusters}
              what="the groups"
              render={({ summary }) =>
                `${plural(summary.clusterCount, 'customer', 'customers')} found from ${plural(summary.recordCount, 'record', 'records')}`
              }
            />
          }
          control={control('clustering', 'Group records', clusterState)}
        />
      </ol>
    </section>
  );
}

export function PipelineFailed({ message, retry }: { message: string; retry: () => void }) {
  return (
    <Alert>
      <CircleAlert aria-hidden="true" />
      <AlertTitle>We could not load the files</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-3">
        {message}
        <Button size="sm" variant="outline" onClick={retry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}
