import { CircleAlert, Search } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { EmptyState } from '@/components/EmptyState';
import { ProgressBar } from '@/components/ProgressBar';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import { canManageSources, projectAccessOf } from '@/features/projects/access';
import { ProjectPageFrame } from '@/features/projects/ProjectPageFrame';
import { projectPage } from '@/features/projects/steps';
import { LiveJobs } from '@/features/sources/LiveJobs';
import {
  activeProfileJobs,
  useProjectJobs,
  useSourceProfile,
  useSources,
} from '@/features/sources/queries';
import { formatCount, profileErrorMessage } from '@/features/sources/source-rules';
import { useProfileActions } from '@/features/sources/use-profile-actions';
import type { ColumnProfile, Job, Project, Source } from '@/lib/api-types';
import { cn } from '@/lib/utils';

import { ColumnProfileTable, type EmptySort } from './ColumnProfileTable';
import { hasIssues } from './profile-labels';

const PAGE = projectPage('profile');

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function SourcePicker({
  sources,
  selectedId,
  onSelect,
}: {
  sources: Source[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div role="group" aria-label="Choose a file" className="flex flex-wrap gap-2">
      {sources.map((source) => {
        const selected = source.id === selectedId;
        return (
          <Button
            key={source.id}
            type="button"
            size="sm"
            variant={selected ? 'secondary' : 'ghost'}
            aria-pressed={selected}
            className={cn('font-normal', selected && 'font-medium')}
            onClick={() => {
              onSelect(source.id);
            }}
          >
            <span className="font-mono">{source.originalFilename}</span>
            {source.columnCount !== null && (
              <span className="text-muted-foreground">· {source.columnCount} columns</span>
            )}
          </Button>
        );
      })}
    </div>
  );
}

function ProfilingProgress({
  source,
  job,
  canManage,
  onCancel,
}: {
  source: Source;
  job: Job;
  canManage: boolean;
  onCancel: () => void;
}) {
  const waiting = job.status === 'queued';
  return (
    <section
      aria-label="Profiling progress"
      className="flex flex-col gap-3 rounded-xl border px-5 py-5"
    >
      <div role="status" className="space-y-2">
        <p className="text-sm font-medium">
          {waiting
            ? `Waiting to profile ${source.originalFilename}`
            : `Profiling ${source.originalFilename}: ${job.progress}%`}
        </p>
        <ProgressBar value={job.progress / 100} label={`Profiling ${source.originalFilename}`} />
        {job.message && <p className="text-sm text-muted-foreground">{job.message}</p>}
      </div>
      {canManage && (
        <div>
          <Button type="button" size="sm" variant="outline" onClick={onCancel}>
            Cancel profiling
          </Button>
        </div>
      )}
    </section>
  );
}

function ColumnsView({ source, columns }: { source: Source; columns: ColumnProfile[] }) {
  const [query, setQuery] = useState('');
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [sort, setSort] = useState<EmptySort>('none');

  const issues = columns.filter(hasIssues).length;
  const needle = query.trim().toLowerCase();
  const shown = columns
    .filter((column) => !needle || column.column.toLowerCase().includes(needle))
    .filter((column) => !onlyIssues || hasIssues(column));
  if (sort !== 'none') {
    const direction = sort === 'desc' ? -1 : 1;
    shown.sort((a, b) => direction * (a.emptyPercent - b.emptyPercent));
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <SummaryCard label="Rows" value={formatCount(source.rowCount)} />
        <SummaryCard label="Columns" value={formatCount(columns.length)} />
        <SummaryCard label="Columns with issues" value={formatCount(issues)} />
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div className="relative w-full max-w-xs">
          <Label htmlFor="column-search" className="sr-only">
            Search columns
          </Label>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id="column-search"
            type="search"
            placeholder="Search columns"
            className="pl-8"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={onlyIssues}
            onChange={(event) => {
              setOnlyIssues(event.target.checked);
            }}
          />
          Only columns with issues
        </label>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          Showing {shown.length} of {columns.length} columns
        </p>
      </div>

      {shown.length === 0 ? (
        <EmptyState
          title="No matching columns"
          description="Try a different search or show all columns."
          className="py-10"
        />
      ) : (
        <ColumnProfileTable columns={shown} sort={sort} onSortChange={setSort} />
      )}
      <p className="text-sm text-muted-foreground">
        Samples and common values are masked before they are stored or shown to the AI. Personal
        data such as names and birth dates is shown only as its shape, for example Xxxxx Xxxxxx.
      </p>
    </div>
  );
}

function ProfileContent({ project }: { project: Project }) {
  const { user } = useAuth();
  const sources = useSources(project.id);
  const jobs = useProjectJobs(project.id);
  const actions = useProfileActions(project.id);
  const [params, setParams] = useSearchParams();
  const canManage = user ? canManageSources(projectAccessOf(project, user)) : false;

  const list = sources.data ?? [];
  const requested = params.get('source');
  const selected = list.find((source) => source.id === requested) ?? list[0] ?? null;
  const profile = useSourceProfile(project.id, selected?.id ?? null);
  const active = activeProfileJobs(jobs.data);
  const job = selected ? active.get(selected.id) : undefined;

  if (sources.isPending) {
    return (
      <div role="status" aria-label="Loading profile" className="space-y-3">
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (sources.isError) {
    return (
      <Alert>
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>We could not load the files. {sources.error.message}</span>
          <Button size="sm" variant="outline" onClick={() => void sources.refetch()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (!selected) {
    return (
      <EmptyState
        title="No files to profile yet"
        description="Upload a file on the Sources step first; it is profiled automatically."
        action={
          <Button asChild variant="outline">
            <Link to={`/projects/${encodeURIComponent(project.id)}/sources`}>Go to Sources</Link>
          </Button>
        }
      />
    );
  }

  const profileNow = canManage && (
    <Button
      type="button"
      disabled={actions.starting.has(selected.id)}
      onClick={() => {
        actions.start(selected);
      }}
    >
      Profile now
    </Button>
  );
  const readOnlyNote = !canManage && 'Ask the project owner or a data engineer to profile it.';

  let body;
  if (job) {
    body = (
      <ProfilingProgress
        source={selected}
        job={job}
        canManage={canManage}
        onCancel={() => {
          actions.cancel(job);
        }}
      />
    );
  } else if (profile.isPending) {
    body = (
      <div role="status" aria-label="Loading column profile" className="space-y-2">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  } else if (profile.isError) {
    body = (
      <Alert>
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>We could not load the profile. {profile.error.message}</span>
          <Button size="sm" variant="outline" onClick={() => void profile.refetch()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (profile.data.source.status === 'failed') {
    body = (
      <Alert>
        <CircleAlert aria-hidden="true" />
        <AlertTitle>Profiling failed</AlertTitle>
        <AlertDescription className="gap-3">
          <p>{profileErrorMessage(profile.data.source.error)}</p>
          {canManage ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={actions.starting.has(selected.id)}
              onClick={() => {
                actions.start(selected);
              }}
            >
              Try again
            </Button>
          ) : (
            <p>{readOnlyNote}</p>
          )}
        </AlertDescription>
      </Alert>
    );
  } else if (profile.data.columns.length === 0) {
    const profiled = profile.data.source.status === 'profiled';
    body = (
      <EmptyState
        title={profiled ? 'This file has no columns' : 'Not profiled yet'}
        description={
          profiled
            ? 'The file was profiled but has no columns to show.'
            : `Profiling checks every column of ${selected.originalFilename} for types, empty values and patterns.${readOnlyNote ? ` ${readOnlyNote}` : ''}`
        }
        action={!profiled && profileNow}
      />
    );
  } else {
    body = (
      <ColumnsView key={selected.id} source={profile.data.source} columns={profile.data.columns} />
    );
  }

  return (
    <div className="space-y-5">
      {list.length > 1 ? (
        <SourcePicker
          sources={list}
          selectedId={selected.id}
          onSelect={(id) => {
            setParams({ source: id }, { replace: true });
          }}
        />
      ) : (
        <p className="text-sm">
          <span className="text-muted-foreground">File: </span>
          <span className="font-mono">{selected.originalFilename}</span>
        </p>
      )}
      {body}
      <LiveJobs jobs={job ? [job] : []} />
    </div>
  );
}

/** Step 2: what each column holds, with flags for what needs a decision. */
export function ProfilePage() {
  return (
    <ProjectPageFrame
      page={PAGE}
      actions={(project) => (
        <Button asChild>
          <Link to={`/projects/${encodeURIComponent(project.id)}/mapping`}>
            Continue to mapping
          </Link>
        </Button>
      )}
    >
      {(project) => <ProfileContent project={project} />}
    </ProjectPageFrame>
  );
}
