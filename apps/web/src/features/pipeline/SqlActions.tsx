import { CircleAlert, LoaderCircle } from 'lucide-react';
import { useCallback, useId, useState, type ReactNode } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatCount } from '@/features/matching/matching-labels';
import { ConfirmAction } from '@/features/matching/ReviewDialogs';
import type { DataScope, Job, SqlVersion, SqlVersionSummary } from '@/lib/api-types';

import { JobProgress } from './JobProgress';
import {
  actionErrorText,
  checkName,
  INSTRUCTIONS_MAX_LENGTH,
  jobFailureText,
} from './pipeline-labels';
import { useApproveSql, useRejectSql, useStartPipelineJob } from './queries';
import { isRunning, resultNumber, useJobEnd } from './use-job-end';

export const INSTRUCTIONS_HELP =
  "Don't include customer details — describe the rule, e.g. 'prefer CRM for phone'.";

export const APPROVE_BLOCKED = 'All tests must pass before approval';

/** A radio group of plain choices; native inputs keep it keyboard operable. */
export function Choice<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: string;
  name: string;
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{legend}</legend>
      {options.map((option) => (
        <label key={option.value} className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            className="mt-0.5 size-4 accent-primary"
            onChange={() => {
              onChange(option.value);
            }}
          />
          <span>
            {option.label}
            {option.hint && <span className="block text-muted-foreground">{option.hint}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <Alert>
      <CircleAlert aria-hidden="true" />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

const SCOPE_CHOICES: { value: DataScope; label: string; hint: string }[] = [
  {
    value: 'approved',
    label: 'Approved customers',
    hint: 'Only customers approved in Match review.',
  },
  { value: 'all', label: 'All customers', hint: 'Approved and proposed customers.' },
];

function DraftSqlDialog({
  pending,
  running,
  onStart,
}: {
  pending: boolean;
  /** A job of this kind is running: the button stays focusable but does not open. */
  running: boolean;
  onStart: (
    payload: { scope: DataScope; instructions?: string },
    done: (error: unknown) => void,
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<DataScope>('approved');
  const [instructions, setInstructions] = useState('');
  const [error, setError] = useState<string | null>(null);
  const instructionsId = useId();
  const helpId = useId();
  const counterId = useId();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next && running) return;
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" disabled={pending} aria-disabled={running || undefined}>
          {pending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
          Draft SQL
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Draft SQL</DialogTitle>
          <DialogDescription>
            The AI writes the SQL that builds the clean customer table and tests it on a sample.
            Customer details are never sent to it. You review the result before approving it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            const trimmed = instructions.trim();
            onStart({ scope, ...(trimmed ? { instructions: trimmed } : {}) }, (failure) => {
              if (failure === null) {
                setOpen(false);
                setInstructions('');
              } else {
                setError(actionErrorText(failure));
              }
            });
          }}
        >
          <Choice
            legend="Customers"
            name="sql-scope"
            value={scope}
            options={SCOPE_CHOICES}
            onChange={setScope}
          />
          <div className="space-y-1.5">
            <Label htmlFor={instructionsId}>Instructions (optional)</Label>
            <Textarea
              id={instructionsId}
              value={instructions}
              maxLength={INSTRUCTIONS_MAX_LENGTH}
              aria-describedby={`${helpId} ${counterId}`}
              onChange={(event) => {
                setInstructions(event.target.value);
              }}
            />
            <div className="flex justify-between gap-3 text-xs text-muted-foreground">
              <p id={helpId}>{INSTRUCTIONS_HELP}</p>
              <p id={counterId} className="shrink-0 tabular-nums">
                {instructions.length}/{INSTRUCTIONS_MAX_LENGTH} characters
              </p>
            </div>
          </div>
          <FormError message={error} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
              Start draft
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Draft SQL": starts `sql_draft`, follows it, and opens the new version when it is ready. */
export function DraftSqlControl({
  projectId,
  job,
  canCancel,
  onDrafted,
}: {
  projectId: string;
  /** The newest `sql_draft` job. */
  job: Job | null;
  canCancel: boolean;
  onDrafted: (versionId: string) => void;
}) {
  const start = useStartPipelineJob(projectId);
  const [startedId, setStartedId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const onEnd = useCallback(
    (ended: Job) => {
      setStartedId(null);
      if (ended.status === 'succeeded') {
        const versionId = ended.result?.versionId;
        const version = resultNumber(ended, 'version');
        if (typeof versionId === 'string') onDrafted(versionId);
        const name = version === null ? 'The new version' : `Version ${version}`;
        setMessage(`${name} is drafted. Its details and tests are open below.`);
      } else if (ended.status === 'failed') {
        setMessage(`The SQL could not be drafted. ${jobFailureText(ended)}`);
      } else {
        setMessage('The SQL draft was cancelled.');
      }
    },
    [onDrafted],
  );
  useJobEnd(projectId, startedId, onEnd);

  return (
    <section aria-labelledby="draft-sql" className="space-y-3 rounded-xl border px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="draft-sql" className="text-base font-medium">
            Draft SQL
          </h2>
          <p className="text-sm text-muted-foreground">
            Make a new version of the SQL from the current customers. It is tested on a sample and
            waits for approval.
          </p>
        </div>
        <DraftSqlDialog
          pending={start.isPending}
          running={isRunning(job)}
          onStart={(payload, done) => {
            setMessage(null);
            start.mutate(
              { type: 'sql_draft', payload },
              {
                onSuccess: (started) => {
                  setStartedId(started.id);
                  done(null);
                },
                onError: done,
              },
            );
          }}
        />
      </div>
      {isRunning(job) && <JobProgress job={job} action="Draft SQL" canCancel={canCancel} />}
      <p role="status" aria-live="polite" className="text-sm">
        {message}
      </p>
    </section>
  );
}

/** Approve (only once every test passed) or reject a draft version. */
export function DecisionActions({
  projectId,
  version,
  approved,
  onResult,
}: {
  projectId: string;
  version: SqlVersion;
  /** The current approved version, which approving supersedes. */
  approved: SqlVersionSummary | null;
  onResult: (text: string, ok: boolean) => void;
}) {
  const approve = useApproveSql(projectId);
  const reject = useRejectSql(projectId);
  const pending = approve.isPending || reject.isPending;
  const blockedId = useId();
  const supersedes: ReactNode = approved
    ? `Version ${approved.version} is the current SQL. It becomes Superseded and version ${version.version} becomes the current SQL.`
    : `Version ${version.version} becomes the current SQL.`;

  return (
    <div className="space-y-2 rounded-lg border px-4 py-3">
      <p className="text-sm font-medium">Decision</p>
      <div className="flex flex-wrap items-center gap-2">
        <ConfirmAction
          label="Approve"
          ariaLabel={`Approve version ${version.version}`}
          title={`Approve version ${version.version}?`}
          description={
            <>{supersedes} Only the current SQL can be run and is checked for quality.</>
          }
          confirmLabel="Approve"
          variant="default"
          size="default"
          pending={approve.isPending}
          disabled={!version.testsPassed || pending}
          describedBy={version.testsPassed ? undefined : blockedId}
          onConfirm={() => {
            approve.mutate(version.id, {
              onSuccess: () => {
                onResult(`Version ${version.version} approved. It is now the current SQL.`, true);
              },
              onError: (error) => {
                onResult(actionErrorText(error), false);
              },
            });
          }}
        />
        <ConfirmAction
          label="Reject"
          ariaLabel={`Reject version ${version.version}`}
          title={`Reject version ${version.version}?`}
          description="A rejected version cannot be approved or run. You can draft a new one."
          confirmLabel="Reject"
          size="default"
          withReason
          pending={reject.isPending}
          disabled={pending}
          onConfirm={(reason) => {
            reject.mutate(
              { versionId: version.id, reason },
              {
                onSuccess: () => {
                  onResult(`Version ${version.version} rejected.`, true);
                },
                onError: (error) => {
                  onResult(actionErrorText(error), false);
                },
              },
            );
          }}
        />
      </div>
      {!version.testsPassed && (
        <p id={blockedId} className="text-sm text-muted-foreground">
          {APPROVE_BLOCKED}.
        </p>
      )}
    </div>
  );
}

function runResultText(job: Job): string {
  if (job.status === 'cancelled') return 'The SQL run was cancelled.';
  if (job.status === 'failed') return `The SQL could not be run. ${jobFailureText(job)}`;
  const rows = resultNumber(job, 'rowCount');
  const rowsText = rows === null ? '' : ` on ${formatCount(rows)} rows`;
  if (job.result?.passed === true) return `The SQL ran${rowsText} and every check passed.`;
  const failed = job.result?.failedChecks;
  const names = Array.isArray(failed)
    ? failed.filter((name): name is string => typeof name === 'string').map(checkName)
    : [];
  return `The SQL ran${rowsText} but some checks failed${names.length ? `: ${names.join(', ')}` : ''}.`;
}

/** "Run SQL" on the approved version: starts `sql_run` and reports the new last run. */
export function RunSqlControl({
  projectId,
  version,
  job,
}: {
  projectId: string;
  version: SqlVersionSummary;
  /** The newest `sql_run` job. */
  job: Job | null;
}) {
  const start = useStartPipelineJob(projectId);
  const [startedId, setStartedId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const onEnd = useCallback((ended: Job) => {
    setStartedId(null);
    setMessage(runResultText(ended));
  }, []);
  useJobEnd(projectId, startedId, onEnd);
  const running = isRunning(job);

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        disabled={start.isPending}
        aria-disabled={running || undefined}
        aria-label={`Run SQL version ${version.version}`}
        onClick={() => {
          if (running) return;
          setMessage(null);
          start.mutate(
            { type: 'sql_run', payload: { versionId: version.id } },
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
        Run SQL
      </Button>
      {running && <JobProgress job={job} action="Run SQL" canCancel />}
      <p role="status" aria-live="polite" className="text-sm">
        {message}
      </p>
    </div>
  );
}
