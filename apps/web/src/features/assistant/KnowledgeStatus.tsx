import { LoaderCircle } from 'lucide-react';
import { useCallback, useState } from 'react';

import { LoadFailed } from '@/components/LoadFailed';
import { StatusPill } from '@/components/StatusPill';
import { TimeAgo } from '@/components/TimeAgo';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { JobProgress } from '@/features/pipeline/JobProgress';
import { actionErrorText, jobFailureText } from '@/features/pipeline/pipeline-labels';
import { latestJobOf, useStartPipelineJob } from '@/features/pipeline/queries';
import { isRunning, useJobEnd } from '@/features/pipeline/use-job-end';
import { LiveJobs } from '@/features/sources/LiveJobs';
import { useProjectJobs } from '@/features/sources/queries';
import { CHUNK_KINDS, type Job, type KnowledgeSummary } from '@/lib/api-types';

import { KIND_LABELS, MODE_LABELS } from './assistant-labels';
import { useKnowledgeSummary } from './queries';

function buildResultText(job: Job): string {
  if (job.status === 'cancelled') return 'Building the project knowledge was cancelled.';
  if (job.status === 'failed')
    return `Building the project knowledge failed. ${jobFailureText(job)}`;
  return 'The project knowledge is up to date.';
}

/** "Build / Rebuild knowledge": starts `knowledge_index`; the summary refreshes when it ends. */
function BuildControl({ projectId, built }: { projectId: string; built: boolean }) {
  const start = useStartPipelineJob(projectId);
  const [startedId, setStartedId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const onEnd = useCallback((ended: Job) => {
    setStartedId(null);
    setMessage(buildResultText(ended));
  }, []);
  useJobEnd(projectId, startedId, onEnd);
  const jobs = useProjectJobs(projectId);
  const job = latestJobOf(jobs.data, 'knowledge_index');
  const action = built ? 'Rebuild knowledge' : 'Build knowledge';

  return (
    <div className="space-y-2">
      <LiveJobs jobs={isRunning(job) ? [job] : []} />
      <Button
        type="button"
        variant={built ? 'outline' : 'default'}
        disabled={start.isPending}
        aria-disabled={isRunning(job) || undefined}
        onClick={() => {
          if (isRunning(job)) return;
          setMessage(null);
          start.mutate(
            { type: 'knowledge_index', payload: {} },
            {
              onSuccess: (started) => {
                setStartedId(started.id);
              },
              onError: (error) => {
                setMessage(actionErrorText(error));
              },
            },
          );
        }}
      >
        {start.isPending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
        {action}
      </Button>
      {isRunning(job) && <JobProgress job={job} action={action} canCancel />}
      <p role="status" aria-live="polite" className="text-sm">
        {message}
      </p>
    </div>
  );
}

function SummaryFacts({ summary }: { summary: KnowledgeSummary }) {
  const kinds = CHUNK_KINDS.filter((kind) => summary.chunksByKind[kind] > 0);
  return (
    <div className="space-y-2 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <span>
          Built <TimeAgo iso={summary.finishedAt} /> · {summary.chunkCount.toLocaleString('en-IN')}{' '}
          pieces of knowledge
        </span>
        <StatusPill tone="neutral">{MODE_LABELS[summary.mode]}</StatusPill>
      </p>
      <ul aria-label="Knowledge by kind" className="flex flex-wrap gap-x-4 gap-y-1">
        {kinds.map((kind) => (
          <li key={kind} className="text-muted-foreground">
            {KIND_LABELS[kind]}:{' '}
            <span className="text-foreground tabular-nums">
              {summary.chunksByKind[kind].toLocaleString('en-IN')}
            </span>
          </li>
        ))}
      </ul>
      {summary.mode === 'keyword' && (
        <p className="text-muted-foreground">
          Keyword search matches the words in your question; smart search (by meaning) comes back
          when the knowledge is rebuilt with the AI available.
        </p>
      )}
    </div>
  );
}

/** What the assistant can search: when it was built, what it holds, and the build action. */
export function KnowledgeStatus({ projectId, canBuild }: { projectId: string; canBuild: boolean }) {
  const summary = useKnowledgeSummary(projectId);

  let body;
  if (summary.isPending) {
    body = <Skeleton className="h-12 w-full" aria-label="Loading the project knowledge" />;
  } else if (summary.isError) {
    body = (
      <LoadFailed
        title="We could not load the project knowledge"
        message={summary.error.message}
        retry={() => void summary.refetch()}
      />
    );
  } else if (summary.data === null) {
    body = (
      <div className="space-y-1 text-sm">
        <p>
          The assistant answers from the project knowledge: decisions, mappings, quality reports,
          SQL and the design docs. It has not been built for this project yet.
        </p>
        {!canBuild && (
          <p className="text-muted-foreground">Ask an engineer to build the project knowledge.</p>
        )}
      </div>
    );
  } else {
    body = <SummaryFacts summary={summary.data} />;
  }

  return (
    <section
      aria-labelledby="knowledge-status"
      className="flex flex-wrap items-start justify-between gap-4 rounded-xl border px-5 py-4"
    >
      <div className="min-w-0 flex-1 space-y-2">
        <h2 id="knowledge-status" className="text-base font-medium">
          Project knowledge
        </h2>
        {body}
      </div>
      {canBuild && summary.isSuccess && (
        <BuildControl projectId={projectId} built={summary.data !== null} />
      )}
    </section>
  );
}
